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
//! (`invoke('host_write_escrow', { wrappingKey })`).

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

/// Writes the storage-key escrow (spec §4.7). `wrapping_key` is b64url.
#[tauri::command]
pub async fn host_write_escrow(app: AppHandle, wrapping_key: String) -> Result<(), String> {
    run(app, true, move |host, _| host.write_escrow(&wrapping_key)).await
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

#[cfg(test)]
mod tests {
    #[test]
    fn progress_event_name_is_the_contract() {
        assert_eq!(super::PROGRESS_EVENT, "host://progress");
    }
}
