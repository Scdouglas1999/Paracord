//! "Paracord on this computer": the commands the first run and Settings use
//! to host a server from the desktop app (docs/setup-spec.md §2, §9.5), on
//! top of `paracord-hostctl`.
//!
//! Every command runs its work on a blocking thread (process runs, loopback
//! HTTP, polling). Commands that change the installation (setup, start/stop,
//! autostart, remove, restore, update) are serialized by one lock, so two
//! windows or a double click can't interleave them. Reads (status, info, logs)
//! don't wait for it.
//!
//! Progress for `host_setup_start` and `host_retry_reachability` arrives as
//! `host://progress` events (`paracord_contracts::host::HostProgress`).
//! Nothing here polls in the background: status is read when the page asks.
//!
//! Arguments use Tauri's default camelCase on the JS side
//! (`invoke('host_write_escrow', { wrappingKey, ownerPublicKey })`).

use std::sync::Mutex;

use paracord_contracts::credential::NewOwnerClaim;
use paracord_contracts::host::{BackupNowResponse, HostPreflight, HostProgress, HostStatus};
use paracord_hostctl::firewall::FirewallOutcome;
use paracord_hostctl::{bundled_sidecar, Host, HostInfo, HostLaunch};
use tauri::{AppHandle, Emitter, Manager};

/// The event every setup row update is sent on.
pub const PROGRESS_EVENT: &str = "host://progress";

/// Serializes the commands that change the installation.
static CHANGES: Mutex<()> = Mutex::new(());

fn host_for(app: &AppHandle) -> Result<Host, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Couldn't find this app's data folder ({e})."))?;
    let sidecar = bundled_sidecar().map_err(|e| format!("{e:#}"))?;
    Host::system(&dir, sidecar).map_err(|e| format!("{e:#}"))
}

/// Run `work` on a blocking thread with a `Host`; `exclusive` takes the
/// change lock first.
async fn run<T, F>(app: AppHandle, exclusive: bool, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Host, &AppHandle) -> anyhow::Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = if exclusive {
            Some(
                CHANGES
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()),
            )
        } else {
            None
        };
        let host = host_for(&app)?;
        work(&host, &app).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| format!("The host task stopped unexpectedly ({e})."))?
}

fn emitter(app: &AppHandle) -> impl Fn(HostProgress) + '_ {
    move |event: HostProgress| {
        if let Err(err) = app.emit(PROGRESS_EVENT, &event) {
            tracing::warn!(target: "paracord::host", "couldn't emit {PROGRESS_EVENT}: {err}");
        }
    }
}

/// Checks this computer can host (spec §2.3).
#[tauri::command]
pub async fn host_preflight(app: AppHandle) -> Result<HostPreflight, String> {
    run(app, false, |host, _| host.preflight()).await
}

/// Runs setup rows 1 and 2, and rows 4 and 5 once row 3 (claim + escrow) is
/// recorded (spec §2.6), emitting `host://progress`. Call it again after row 3
/// and for **Try again**: finished steps are skipped. Resolves when the run
/// stops; a failed step is reported by its event, not by rejecting.
#[tauri::command]
pub async fn host_setup_start(app: AppHandle, port: u16) -> Result<(), String> {
    run(app, true, move |host, app| host.setup(port, &emitter(app))).await
}

/// Claims the hosted instance on loopback; Rust reads the claim token from the
/// claim file. Returns the server's `ClaimResponse` JSON.
#[tauri::command]
pub async fn host_claim(
    app: AppHandle,
    request: NewOwnerClaim,
) -> Result<serde_json::Value, String> {
    run(app, true, move |host, _| host.claim(&request)).await
}

/// Writes the storage-key escrow (spec §4.7). `wrapping_key` is b64url;
/// `owner_public_key` is the hex identity key it was derived from.
#[tauri::command]
pub async fn host_write_escrow(
    app: AppHandle,
    wrapping_key: String,
    owner_public_key: String,
) -> Result<(), String> {
    run(app, true, move |host, _| {
        host.write_escrow(&wrapping_key, &owner_public_key)
    })
    .await
}

#[tauri::command]
pub async fn host_status(app: AppHandle) -> Result<HostStatus, String> {
    run(app, false, |host, _| host.status()).await
}

/// Asks the router again, then re-reads row 4 (emitted on `host://progress`).
#[tauri::command]
pub async fn host_retry_reachability(app: AppHandle) -> Result<(), String> {
    run(app, false, |host, app| {
        host.retry_reachability(&emitter(app))
    })
    .await
}

#[tauri::command]
pub async fn host_backup_now(app: AppHandle) -> Result<BackupNowResponse, String> {
    run(app, false, |host, _| host.backup_now()).await
}

/// Starts the service and waits (≤ 30 s) for it to answer.
#[tauri::command]
pub async fn host_start(app: AppHandle) -> Result<(), String> {
    run(app, true, |host, _| host.start()).await
}

#[tauri::command]
pub async fn host_stop(app: AppHandle) -> Result<(), String> {
    run(app, true, |host, _| host.stop()).await
}

/// "Starts when you sign in to this computer".
#[tauri::command]
pub async fn host_set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    run(app, true, move |host, _| host.set_autostart(enabled)).await
}

/// Removes the service; deletes the server's data (and its storage key) only
/// when asked.
#[tauri::command]
pub async fn host_remove(app: AppHandle, delete_data: bool) -> Result<(), String> {
    run(app, true, move |host, _| host.remove(delete_data)).await
}

/// The last `lines` lines of the server log (at most 1000).
#[tauri::command]
pub async fn host_logs_tail(app: AppHandle, lines: u32) -> Result<String, String> {
    run(app, false, move |host, _| host.logs_tail(lines)).await
}

/// Restores a backup archive with the escrowed key (spec §4.8).
#[tauri::command]
pub async fn host_restore(
    app: AppHandle,
    archive_path: String,
    wrapping_key: String,
) -> Result<(), String> {
    run(app, true, move |host, _| {
        host.restore(std::path::Path::new(&archive_path), &wrapping_key)
    })
    .await
}

/// "Restore from a backup instead" (spec §1.4, §4.8): the system file picker,
/// then what the restore screen needs about the file (its date, whether it is
/// encrypted, the escrow's instance id and owner key). `None` when the person
/// closed the picker. Nothing is restored here.
#[tauri::command]
pub async fn host_pick_backup(
    app: AppHandle,
) -> Result<Option<paracord_hostctl::backup_file::BackupFile>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picker = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .set_title("Choose a Paracord backup")
            .add_filter("Paracord backup", &["gz"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| format!("The file picker stopped unexpectedly ({e})."))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| format!("Paracord can't open that file from here ({e})."))?;
    run(app, false, move |host, _| {
        host.inspect_backup(&path).map(Some)
    })
    .await
}

/// `host.json` plus the live service state, for Settings › Paracord on this
/// computer (spec §2.9).
#[tauri::command]
pub async fn host_info(app: AppHandle) -> Result<HostInfo, String> {
    run(app, false, |host, _| host.info()).await
}

/// At app start (spec §2.8): update the binary when the bundled one is newer,
/// then start the service if autostart is on and it isn't running.
#[tauri::command]
pub async fn host_on_launch(app: AppHandle) -> Result<HostLaunch, String> {
    run(app, true, |host, _| host.on_launch()).await
}

/// **Restore the backup from before the update** (spec §2.8).
#[tauri::command]
pub async fn host_rollback_update(app: AppHandle) -> Result<(), String> {
    run(app, true, |host, _| host.rollback_update()).await
}

/// Windows: the **Allow** chip for `firewall_blocked` (one UAC prompt).
/// Resolves `"allowed"` or `"declined"`.
#[tauri::command]
pub async fn host_allow_firewall(app: AppHandle) -> Result<String, String> {
    run(app, true, |host, _| {
        host.allow_firewall().map(|outcome| match outcome {
            FirewallOutcome::Allowed => "allowed".to_string(),
            FirewallOutcome::Declined => "declined".to_string(),
        })
    })
    .await
}

/// The server this app hosts, as setup, a restore or launch supervision left
/// it on disk: its loopback origin and the SHA-256 fingerprint of the
/// certificate it serves.
///
/// The app installed that server and reads its certificate from disk, as the
/// control client does (`paracord_hostctl::control::LoopbackHost`), so it never
/// asks the person whether to trust it (bug F1, setup-s15-checkpoint.md §4.1):
/// `update_trusted_server_hosts` trusts this exact origin when, and only when,
/// the server on it presents exactly this certificate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OwnServer {
    /// `https://127.0.0.1:<port>`, in the form `trusted_origin_from_url` gives.
    pub(crate) origin: String,
    /// The certificate's fingerprint, or why it could not be read (the server
    /// has not made it yet, a broken config). Nothing on the origin is trusted
    /// without it.
    pub(crate) fingerprint: Result<[u8; 32], String>,
}

/// The hosted server under `app_local_data_dir`, read fresh from `host.json`,
/// its config and its certificate file (setup writes them in `init`, a restore
/// points `host.json` at the recovered config, and a restored server makes a
/// new certificate at its first start). `None` when this computer does not
/// host; an error only when `host.json` itself cannot be read.
pub(crate) fn own_server_in(
    app_local_data_dir: &std::path::Path,
) -> Result<Option<OwnServer>, String> {
    use paracord_hostctl::layout::{state_file, HostLayout};
    use paracord_hostctl::HostState;

    let state = HostState::load(&state_file(app_local_data_dir)).map_err(|e| format!("{e:#}"))?;
    let Some(port) = state.port.filter(|_| state.enabled) else {
        return Ok(None);
    };
    let config_path = state
        .config_path
        .clone()
        .unwrap_or_else(|| HostLayout::for_app_dir(app_local_data_dir).default_config());
    Ok(Some(OwnServer {
        origin: format!("https://127.0.0.1:{port}"),
        fingerprint: certificate_fingerprint(&config_path),
    }))
}

/// SHA-256 of the first certificate in the file `[tls] cert_path` of the
/// config at `config_path` names.
fn certificate_fingerprint(config_path: &std::path::Path) -> Result<[u8; 32], String> {
    use paracord_hostctl::config::HostConfig;
    use paracord_hostctl::control::first_certificate_der;
    use sha2::{Digest, Sha256};

    let config = HostConfig::load(config_path).map_err(|e| format!("{e:#}"))?;
    let pem = std::fs::read_to_string(&config.cert_path).map_err(|e| {
        format!(
            "the certificate of Paracord on this computer isn't readable ({}: {e})",
            config.cert_path.display()
        )
    })?;
    let der = first_certificate_der(&pem).map_err(|e| {
        format!(
            "the certificate of Paracord on this computer isn't usable ({}: {e:#})",
            config.cert_path.display()
        )
    })?;
    Ok(Sha256::digest(&der).into())
}

/// [`own_server_in`] for this app's data folder, read on a blocking thread.
/// An error names the reason; `Ok(None)` means this computer does not host.
pub(crate) async fn own_server(app: &AppHandle) -> Result<Option<OwnServer>, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Couldn't find this app's data folder ({e})."))?;
    tauri::async_runtime::spawn_blocking(move || own_server_in(&dir))
        .await
        .map_err(|e| format!("Reading the hosted server's certificate stopped ({e})."))?
}

/// The origin of the server this computer hosts (`https://127.0.0.1:<port>`),
/// or `None` when it hosts none. Read from `host.json` alone, without the host
/// lock `host_info` takes: the app asks this at boot, while `host_on_launch`
/// may be updating the server, to adopt its own server as home when it has no
/// other (a profile that lost its saved server). The shell already trusts this
/// origin with the certificate on disk, without a prompt (see [`OwnServer`]).
#[tauri::command]
pub async fn host_home_server(app: AppHandle) -> Result<Option<String>, String> {
    Ok(own_server(&app).await?.map(|own| own.origin))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn progress_event_name_is_the_contract() {
        assert_eq!(super::PROGRESS_EVENT, "host://progress");
    }

    /// A fresh app data folder under the system temp dir.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "paracord-own-server-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// What setup leaves behind: `host.json`, the server's config and its
    /// certificate. Returns the certificate's DER.
    fn hosted(
        dir: &std::path::Path,
        enabled: bool,
        config_path: Option<&std::path::Path>,
    ) -> Vec<u8> {
        let certs = dir.join("host/data/certs");
        std::fs::create_dir_all(&certs).unwrap();
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        std::fs::write(certs.join("cert.pem"), cert.cert.pem()).unwrap();
        let config = config_path
            .map(std::path::Path::to_path_buf)
            .unwrap_or_else(|| dir.join("host/config/paracord.toml"));
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(
            &config,
            format!(
                "[tls]\ncert_path = {:?}\n[host]\ncontrol_token_file = \"t\"\n[backup]\nbackup_dir = \"b\"\n",
                certs.join("cert.pem")
            ),
        )
        .unwrap();
        let state = paracord_hostctl::HostState {
            enabled,
            port: Some(8447),
            config_path: config_path.map(std::path::Path::to_path_buf),
            ..Default::default()
        };
        state
            .save(&paracord_hostctl::layout::state_file(dir))
            .unwrap();
        cert.cert.der().to_vec()
    }

    #[test]
    fn the_hosted_server_is_its_loopback_origin_and_the_certificate_on_disk() {
        let dir = scratch("setup");
        let der = hosted(&dir, true, None);
        let own = own_server_in(&dir).unwrap().unwrap();
        assert_eq!(own.origin, "https://127.0.0.1:8447");
        assert_eq!(
            crate::trusted_origin_from_url("https://127.0.0.1:8447/").as_deref(),
            Some(own.origin.as_str())
        );
        let expected: [u8; 32] = Sha256::digest(&der).into();
        assert_eq!(own.fingerprint, Ok(expected));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_restore_reads_the_certificate_of_the_recovered_config() {
        let dir = scratch("restore");
        let recovered = dir.join("host/restores/20261012T000000Z/paracord.toml");
        let der = hosted(&dir, true, Some(&recovered));
        let own = own_server_in(&dir).unwrap().unwrap();
        let expected: [u8; 32] = Sha256::digest(&der).into();
        assert_eq!(own.fingerprint, Ok(expected));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_computer_that_does_not_host_has_no_own_server() {
        let never = scratch("never");
        assert_eq!(own_server_in(&never).unwrap(), None);
        std::fs::remove_dir_all(never).unwrap();

        let removed = scratch("removed");
        hosted(&removed, false, None);
        assert_eq!(own_server_in(&removed).unwrap(), None);
        std::fs::remove_dir_all(removed).unwrap();
    }

    #[test]
    fn a_hosted_server_without_its_certificate_names_the_reason() {
        let dir = scratch("nocert");
        hosted(&dir, true, None);
        std::fs::remove_file(dir.join("host/data/certs/cert.pem")).unwrap();
        let own = own_server_in(&dir).unwrap().unwrap();
        assert_eq!(own.origin, "https://127.0.0.1:8447");
        let err = own.fingerprint.unwrap_err();
        assert!(err.contains("isn't readable"), "{err}");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
