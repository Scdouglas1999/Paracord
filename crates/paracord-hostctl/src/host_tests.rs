//! Setup, supervision, update and removal against a fake service manager, a
//! fake server and (on Unix) a shell-script stand-in for the host binary.
//! Nothing here touches the machine's service manager or keychain.

use super::*;
use paracord_contracts::host::{
    BackupStatus, HostStatus, KeySource, Protection, Reachability, ReachabilityState,
    StorageStatus, TlsStatus,
};
use std::sync::Mutex;

// ── Fakes ───────────────────────────────────────────────────────────────────

/// The owner's identity key the fake server holds (`users.public_key`).
const OWNER_KEY: &str = "ad1556f6b39cd51a513052c0be97b86e668adb99fadb813e0c02ebddf7037fd4";

#[derive(Default)]
struct World {
    // service
    installed: bool,
    running: bool,
    autostart: bool,
    exit_code: Option<i32>,
    calls: Vec<String>,
    /// What `start` does: `true` comes up healthy, `false` never answers.
    start_comes_up: bool,
    /// Exit 78 instead of coming up.
    start_exits_78: bool,
    // server
    status: Option<HostStatus>,
    /// Reachability answers served in order (the last one repeats).
    reach: Vec<ReachabilityState>,
    backups: Vec<String>,
    backup_error: Option<String>,
    escrows: Vec<String>,
    claims: Vec<String>,
    keychain_deleted: Vec<(String, String)>,
}

type Shared = Arc<Mutex<World>>;

struct FakeManager(Shared);

impl ServiceManager for FakeManager {
    fn install(&self, spec: &ServiceSpec) -> Result<()> {
        let mut w = self.0.lock().unwrap();
        w.calls.push(format!("install {}", spec.args.join(" ")));
        w.installed = true;
        w.autostart = spec.autostart;
        Ok(())
    }
    fn set_autostart(&self, _: &ServiceSpec, enabled: bool) -> Result<()> {
        let mut w = self.0.lock().unwrap();
        w.calls.push(format!("autostart {enabled}"));
        w.autostart = enabled;
        Ok(())
    }
    fn start(&self, _: &ServiceSpec) -> Result<()> {
        let mut w = self.0.lock().unwrap();
        w.calls.push("start".into());
        if w.start_exits_78 {
            w.exit_code = Some(78);
            w.running = false;
        } else {
            w.running = w.start_comes_up;
        }
        Ok(())
    }
    fn stop(&self) -> Result<()> {
        let mut w = self.0.lock().unwrap();
        w.calls.push("stop".into());
        w.running = false;
        Ok(())
    }
    fn remove(&self) -> Result<()> {
        let mut w = self.0.lock().unwrap();
        w.calls.push("remove".into());
        w.installed = false;
        w.running = false;
        Ok(())
    }
    fn status(&self) -> Result<ServiceStatus> {
        let w = self.0.lock().unwrap();
        Ok(if !w.installed {
            ServiceStatus::not_installed()
        } else {
            ServiceStatus {
                state: if w.running {
                    ServiceState::Running
                } else if w.exit_code.is_some() {
                    ServiceState::Failed
                } else {
                    ServiceState::Stopped
                },
                enabled: w.autostart,
                exit_code: w.exit_code,
            }
        })
    }
}

struct FakeApi(Shared);

impl HostApi for FakeApi {
    fn healthy(&self) -> bool {
        self.0.lock().unwrap().running
    }
    fn status(&self) -> Result<HostStatus> {
        let mut w = self.0.lock().unwrap();
        let mut status = w.status.clone().context("no status")?;
        let state = if w.reach.len() > 1 {
            w.reach.remove(0)
        } else {
            w.reach.first().copied().unwrap_or(ReachabilityState::Open)
        };
        status.reachability.state = state;
        Ok(status)
    }
    fn retry_reachability(&self) -> Result<()> {
        self.0.lock().unwrap().calls.push("retry".into());
        Ok(())
    }
    fn backup_now(&self) -> Result<BackupNowResponse> {
        let mut w = self.0.lock().unwrap();
        if let Some(e) = w.backup_error.clone() {
            bail!(e);
        }
        let name = format!("paracord-backup-{}.tar.gz", w.backups.len() + 1);
        w.backups.push(name.clone());
        Ok(BackupNowResponse { name })
    }
    fn write_escrow(&self, key: &str, owner_public_key: &str) -> Result<EscrowOutcome> {
        if owner_public_key != OWNER_KEY {
            bail!("That recovery phrase isn't the server owner's current one (the owner started over with a new phrase), so it can't protect the storage key.");
        }
        let mut w = self.0.lock().unwrap();
        let outcome = if w.escrows.is_empty() {
            EscrowOutcome::Written
        } else {
            EscrowOutcome::AlreadyPresent
        };
        w.escrows.push(key.into());
        Ok(outcome)
    }
    fn claim(&self, token: &str, owner: &NewOwnerClaim) -> Result<serde_json::Value> {
        self.0.lock().unwrap().claims.push(token.into());
        Ok(serde_json::json!({ "user": { "username": owner.username } }))
    }
}

fn encrypted_status() -> HostStatus {
    HostStatus {
        version: "3.4.0".into(),
        started_at: "2026-10-12T20:30:00Z".into(),
        setup_required: true,
        storage: StorageStatus {
            enabled: true,
            sqlite_encrypted: true,
            files_encrypted: true,
            key_source: Some(KeySource::Keychain),
            protection: Some(Protection::Login),
            escrowed: false,
        },
        reachability: Reachability {
            state: ReachabilityState::Asking,
            method: Some("upnp".into()),
            external_ip: Some("203.0.113.1".into()),
            gateway_ip: Some("192.168.50.1".into()),
            lan_ip: Some("192.168.50.28".into()),
            port: 8443,
            lease_expires_at: None,
            next_retry_at: None,
            last_error: None,
            confirmed_at: None,
        },
        backups: BackupStatus {
            enabled: true,
            interval_seconds: 86_400,
            keep: 14,
            last_backup_at: None,
            last_error: None,
        },
        tls: TlsStatus {
            fingerprint_sha256: "ab".repeat(32),
            self_signed: true,
        },
        instance_id: Some("7c1f0b6e-4a8e-4f8e-9a51-2d6c1f0b6e4a".into()),
    }
}

struct Rig {
    _dir: tempfile::TempDir,
    app_dir: PathBuf,
    world: Shared,
    host: Host,
}

impl Rig {
    fn events(&self, port: u16) -> Vec<String> {
        let events = Mutex::new(Vec::new());
        self.host
            .setup(port, &|e: HostProgress| {
                events.lock().unwrap().push(show(&e))
            })
            .unwrap();
        events.into_inner().unwrap()
    }

    fn state(&self) -> HostState {
        self.host.load_state().unwrap()
    }
}

fn show(e: &HostProgress) -> String {
    let state = serde_json::to_value(e.state).unwrap();
    let step = serde_json::to_value(e.step).unwrap();
    let mut s = format!(
        "{} {} {}",
        e.row,
        step.as_str().unwrap(),
        state.as_str().unwrap()
    );
    if let Some(code) = &e.code {
        s.push_str(&format!(" [{code}]"));
    }
    if let Some(detail) = &e.detail {
        s.push_str(&format!(" {detail}"));
    }
    s
}

/// A stand-in for `paracord-host`: `--version`, `init` (writes the profile's
/// config and prints S6's four lines), `restore-backup` (writes a generation
/// config). Every invocation is appended to `<app>/sidecar.log`.
#[cfg(unix)]
fn fake_sidecar(dir: &Path, version: &str, init_fails: bool) -> PathBuf {
    let path = dir.join(format!("bundle-{version}/paracord-host"));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let log = dir.join("sidecar.log");
    let init = if init_fails {
        "echo 'Error: at-rest key: the system keychain is locked or not running (Secret Service: no bus)' >&2; exit 1".to_string()
    } else {
        r#"root=""; port=""
while [ $# -gt 0 ]; do case "$1" in --root) root="$2"; shift;; --port) port="$2"; shift;; esac; shift; done
mkdir -p "$root/config" "$root/data/certs" "$root/data/backups"
cat > "$root/config/paracord.toml" <<CFG
[tls]
cert_path = "$root/data/certs/cert.pem"
[host]
enabled = true
instance_id = "11111111-2222-4333-8444-555555555555"
control_token_file = "$root/config/host-control.token"
[backup]
backup_dir = "$root/data/backups"
[at_rest]
key_source = "keychain"
keychain_service = "Paracord"
keychain_account = "host-storage-key:11111111-2222-4333-8444-555555555555"
CFG
echo claim-token-123 > "$root/config/first-owner-claim.txt"
echo "Initialized Paracord on this computer"
echo "  root:        $root"
echo "  config:      $root/config/paracord.toml"
echo "  port:        $port"
echo "  instance_id: 11111111-2222-4333-8444-555555555555"
exit 0"#
            .to_string()
    };
    let script = format!(
        r#"#!/bin/sh
echo "$*" >> "{log}"
if [ "$1" = "--version" ]; then echo "paracord-server {version}"; exit 0; fi
for a in "$@"; do
  if [ "$a" = "init" ]; then
{init}
  fi
  if [ "$a" = "restore-backup" ]; then
    cfg=""; out=""; arc=""
    while [ $# -gt 0 ]; do case "$1" in -c) cfg="$2"; shift;; --output-dir) out="$2"; shift;; --archive) arc="$2"; shift;; esac; shift; done
    case "$arc" in *broken*) echo "Error: archive digest mismatch" >&2; exit 1;; esac
    mkdir -p "$out"; cp "$cfg" "$out/paracord.toml"; exit 0
  fi
done
exit 2
"#,
        log = log.display()
    );
    std::fs::write(&path, script).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[cfg(unix)]
fn rig_with(version: &str, init_fails: bool, world: World) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let app_dir = dir.path().join("com.paracord.desktop");
    let sidecar = fake_sidecar(dir.path(), version, init_fails);
    let world = Arc::new(Mutex::new(world));
    let api_world = world.clone();
    let key_world = world.clone();
    let layout = HostLayout::for_app_dir(&app_dir);
    let host = Host::new(HostParts {
        state_path: layout::state_file(&app_dir),
        layout,
        sidecar,
        names: ServiceNames::test("unit"),
        runner: Arc::new(SystemRunner),
        manager: Box::new(FakeManager(world.clone())),
        api: Box::new(move |port, config, claim| {
            assert_eq!(port, 8443);
            assert!(config
                .control_token_file
                .ends_with("config/host-control.token"));
            assert!(claim.ends_with("first-owner-claim.txt"));
            Box::new(FakeApi(api_world.clone()))
        }),
        keychain_delete: Box::new(move |s, a| {
            key_world
                .lock()
                .unwrap()
                .keychain_deleted
                .push((s.into(), a.into()));
            Ok(())
        }),
        manage_firewall: false,
        timing: Timing {
            health_poll: Duration::from_millis(5),
            start_timeout: Duration::from_millis(200),
            update_timeout: Duration::from_millis(200),
            reach_poll: Duration::from_millis(5),
            reach_timeout: Duration::from_millis(200),
        },
    });
    Rig {
        _dir: dir,
        app_dir,
        world,
        host,
    }
}

#[cfg(unix)]
fn healthy_world() -> World {
    World {
        start_comes_up: true,
        status: Some(encrypted_status()),
        reach: vec![
            ReachabilityState::Asking,
            ReachabilityState::Asking,
            ReachabilityState::Open,
        ],
        ..World::default()
    }
}

#[cfg(unix)]
fn owner() -> NewOwnerClaim {
    serde_json::from_value(serde_json::json!({
        "username": "sam",
        "instance_name": "Friday Night Crew",
        "initial_space_name": "Friday Night Crew",
        "initial_space_hue": 150,
        "initial_space_template": "friends",
        "credential": { "salt": "s", "kdf": { "alg": "scrypt", "log_n": 17, "r": 8, "p": 1 }, "auth_key": "k" },
        "identity": { "public_key": "00", "wrapped_key": "w", "wrap_alg": "a", "proof": { "nonce": "n", "timestamp": 1, "signature": "00" } }
    }))
    .unwrap()
}

// ── Setup ───────────────────────────────────────────────────────────────────

#[cfg(unix)]
#[test]
fn setup_runs_rows_1_and_2_then_waits_for_row_3_then_finishes() {
    let rig = rig_with("3.4.0", false, healthy_world());
    assert_eq!(
        rig.events(8443),
        [
            "1 install run",
            "1 install ok",
            "1 init run",
            "1 init ok",
            "1 service run",
            "1 service ok",
            "1 start run",
            "1 start ok",
            "2 storage run",
            "2 storage ok",
        ]
    );
    let state = rig.state();
    assert!(state.enabled);
    assert_eq!(state.port, Some(8443));
    assert_eq!(state.installed_version.as_deref(), Some("3.4.0"));
    assert_eq!(
        state.instance_id.as_deref(),
        Some("11111111-2222-4333-8444-555555555555")
    );
    let layout = rig.host.layout();
    assert!(layout.binary().is_file());
    // The unit runs the stable binary with the active config and the log file.
    let install = rig.world.lock().unwrap().calls[0].clone();
    assert_eq!(
        install,
        format!(
            "install -c {} --log-file {}",
            layout.default_config().display(),
            layout.server_log().display()
        )
    );

    // Row 3 (the page's), through Rust for the claim and the escrow.
    let response = rig.host.claim(&owner()).unwrap();
    assert_eq!(response["user"]["username"], "sam");
    assert_eq!(rig.world.lock().unwrap().claims, ["claim-token-123"]);
    assert!(rig
        .host
        .claim(&owner())
        .unwrap_err()
        .to_string()
        .contains("already has an owner"));
    // A phrase that is not the owner's current one (the owner started over)
    // fails row 3, records nothing, and rows 4-5 stay waiting.
    let error = rig
        .host
        .write_escrow("d3JhcA", &"0".repeat(64))
        .unwrap_err();
    assert!(error.to_string().contains("current one"), "{error}");
    assert!(!rig.state().has_step("escrow"));
    rig.host.write_escrow("d3JhcA", OWNER_KEY).unwrap();
    rig.host.write_escrow("d3JhcA", OWNER_KEY).unwrap(); // a 409 on resume counts as written

    assert_eq!(
        rig.events(8443),
        [
            "1 install ok",
            "1 init ok",
            "1 service ok",
            "1 start run",
            "1 start ok",
            "2 storage ok",
            "4 reach run",
            "4 reach ok [open] Your router opened the way. Friends can reach you at 203.0.113.1.",
            "5 backup run",
            "5 backup ok",
        ]
    );
    assert_eq!(rig.world.lock().unwrap().backups.len(), 1);
    let steps = rig.state().setup.completed_steps;
    assert_eq!(
        steps,
        ["install", "init", "service", "start", "storage", "claim", "escrow", "reach", "backup"]
    );
}

#[cfg(unix)]
#[test]
fn init_failure_shows_the_reason_line_and_try_again_resumes() {
    let rig = rig_with("3.4.0", true, healthy_world());
    let events = rig.events(8443);
    assert_eq!(
        events.last().unwrap(),
        "1 init fail [init_failed] Error: at-rest key: the system keychain is locked or not running (Secret Service: no bus)"
    );
    assert!(!rig.state().enabled);
    // Try again skips the install that already happened.
    assert_eq!(rig.events(8443)[0], "1 install ok");
}

#[cfg(unix)]
#[test]
fn a_server_that_cannot_open_its_key_says_so() {
    let rig = rig_with(
        "3.4.0",
        false,
        World {
            start_exits_78: true,
            ..healthy_world()
        },
    );
    std::fs::create_dir_all(rig.host.layout().logs_dir()).unwrap();
    let events = rig.events(8443);
    std::fs::write(
        rig.host.layout().server_log(),
        "ERROR at-rest key: the system keychain is locked or not running (Secret Service: locked)\n",
    )
    .unwrap();
    let events_again = rig.events(8443);
    assert!(events.last().unwrap().starts_with(
        "1 start fail [storage_key] Paracord on this computer can't open its storage key: "
    ));
    assert_eq!(
        events_again.last().unwrap(),
        "1 start fail [storage_key] Paracord on this computer can't open its storage key: the system keychain is locked or not running (Secret Service: locked)"
    );
    let info = rig.host.info().unwrap();
    assert_eq!(
        info.storage_key_problem.as_deref(),
        Some("the system keychain is locked or not running (Secret Service: locked)")
    );
}

#[cfg(unix)]
#[test]
fn a_server_that_never_answers_times_out() {
    let rig = rig_with(
        "3.4.0",
        false,
        World {
            start_comes_up: false,
            ..healthy_world()
        },
    );
    assert_eq!(
        rig.events(8443).last().unwrap(),
        "1 start fail [start_timeout] Paracord on this computer didn't start."
    );
}

#[cfg(unix)]
#[test]
fn storage_must_be_encrypted_with_the_keychain() {
    let mut status = encrypted_status();
    status.storage.key_source = Some(KeySource::File);
    let rig = rig_with(
        "3.4.0",
        false,
        World {
            status: Some(status),
            ..healthy_world()
        },
    );
    assert_eq!(
        rig.events(8443).last().unwrap(),
        "2 storage fail [storage_unencrypted] Paracord on this computer is running without encryption."
    );
}

#[cfg(unix)]
#[test]
fn reach_warns_with_the_spec_copy_and_backup_failure_is_reported() {
    let rig = rig_with(
        "3.4.0",
        false,
        World {
            reach: vec![ReachabilityState::Refused],
            backup_error: Some("no space left on device".into()),
            ..healthy_world()
        },
    );
    rig.events(8443);
    rig.host.claim(&owner()).unwrap();
    rig.host.write_escrow("k", OWNER_KEY).unwrap();
    let events = rig.events(8443);
    assert!(events.contains(&"4 reach warn [refused] Your router didn't allow it, so for now only people on your home network can join.".to_string()));
    assert_eq!(
        events.last().unwrap(),
        "5 backup fail [backup_failed] The first backup didn't finish (no space left on device)."
    );
    // Try again from Settings asks the router and re-reads row 4.
    let seen = Mutex::new(Vec::new());
    rig.world.lock().unwrap().reach = vec![ReachabilityState::SharedAddress];
    rig.host
        .retry_reachability(&|e| seen.lock().unwrap().push(show(&e)))
        .unwrap();
    let seen = seen.into_inner().unwrap();
    assert_eq!(seen[0], "4 reach run");
    assert!(seen[1].starts_with("4 reach warn [shared_address] Your internet connection shares"));
}

#[test]
fn reach_copy_is_the_spec_table() {
    let mut reach = encrypted_status().reachability;
    reach.state = ReachabilityState::Direct;
    assert_eq!(
        reach_copy(&reach),
        (
            HostProgressState::Ok,
            "This computer has its own public address (203.0.113.1). Friends can reach it if your firewall allows port 8443.".into()
        )
    );
    reach.state = ReachabilityState::NoAnswer;
    assert_eq!(
        reach_copy(&reach).1,
        "Your router didn't answer, so for now only people on your home network can join."
    );
    reach.state = ReachabilityState::FirewallBlocked;
    assert_eq!(
        reach_copy(&reach),
        (
            HostProgressState::Warn,
            "Windows Firewall is blocking friends.".into()
        )
    );
}

// ── Settings ────────────────────────────────────────────────────────────────

#[cfg(unix)]
#[test]
fn remove_keeps_data_by_default_and_deletes_it_with_the_key_when_asked() {
    let rig = rig_with("3.4.0", false, healthy_world());
    rig.events(8443);
    rig.host.set_autostart(false).unwrap();
    assert!(!rig.state().autostart);
    assert!(!rig.world.lock().unwrap().autostart);

    rig.host.remove(false).unwrap();
    assert!(rig.host.layout().default_config().is_file());
    let state = rig.state();
    assert!(!state.enabled);
    assert_eq!(state.setup.completed_steps, ["install", "init"]);
    assert!(rig.world.lock().unwrap().keychain_deleted.is_empty());

    rig.host.remove(true).unwrap();
    assert!(!rig.host.layout().root().exists());
    assert!(!layout::state_file(&rig.app_dir).exists());
    assert_eq!(
        rig.world.lock().unwrap().keychain_deleted,
        [(
            "Paracord".to_string(),
            "host-storage-key:11111111-2222-4333-8444-555555555555".to_string()
        )]
    );
}

#[cfg(unix)]
#[test]
fn logs_tail_reads_the_server_log() {
    let rig = rig_with("3.4.0", false, healthy_world());
    assert!(rig
        .host
        .logs_tail(200)
        .unwrap_err()
        .to_string()
        .contains("hasn't written a log yet"));
    rig.events(8443);
    std::fs::write(rig.host.layout().server_log(), "a\nb\nc\n").unwrap();
    assert_eq!(rig.host.logs_tail(2).unwrap(), "b\nc\n");
}

// ── Launch and update ───────────────────────────────────────────────────────

#[cfg(unix)]
fn hosted_rig(installed: &str, bundled: &str) -> Rig {
    // Set up with the old binary, then point the app at a newer bundle.
    let old = rig_with(installed, false, healthy_world());
    old.events(8443);
    let Rig {
        _dir,
        app_dir,
        world,
        host,
    } = old;
    let HostParts {
        layout,
        state_path,
        names,
        runner,
        manager,
        api,
        keychain_delete,
        manage_firewall,
        timing,
        ..
    } = host.parts;
    let sidecar = fake_sidecar(_dir.path(), bundled, false);
    Rig {
        _dir,
        app_dir,
        world,
        host: Host::new(HostParts {
            layout,
            state_path,
            sidecar,
            names,
            runner,
            manager,
            api,
            keychain_delete,
            manage_firewall,
            timing,
        }),
    }
}

#[cfg(unix)]
#[test]
fn launch_starts_a_stopped_server_when_autostart_is_on() {
    let rig = hosted_rig("3.4.0", "3.4.0");
    rig.world.lock().unwrap().running = false;
    let launch = rig.host.on_launch().unwrap();
    assert_eq!(launch.update, UpdateOutcome::None);
    assert_eq!(launch.start_error, None);
    assert_eq!(
        launch.info.home_url.as_deref(),
        Some("https://127.0.0.1:8443")
    );
    assert!(rig.world.lock().unwrap().running);
}

#[cfg(unix)]
#[test]
fn update_backs_up_keeps_previous_and_swaps_the_binary() {
    let rig = hosted_rig("3.4.0", "3.5.0");
    let launch = rig.host.on_launch().unwrap();
    assert_eq!(
        launch.update,
        UpdateOutcome::Updated {
            from: "3.4.0".into(),
            to: "3.5.0".into()
        }
    );
    let layout = rig.host.layout();
    let previous = std::fs::read_to_string(layout.previous_binary()).unwrap();
    let current = std::fs::read_to_string(layout.binary()).unwrap();
    assert!(previous.contains("paracord-server 3.4.0"));
    assert!(current.contains("paracord-server 3.5.0"));
    let w = rig.world.lock().unwrap();
    assert_eq!(w.backups, ["paracord-backup-1.tar.gz"]);
    let tail: Vec<_> = w.calls.iter().rev().take(2).rev().cloned().collect();
    assert_eq!(tail, ["stop", "start"]);
    drop(w);
    assert_eq!(rig.state().installed_version.as_deref(), Some("3.5.0"));
    assert_eq!(rig.state().update, None);
}

#[cfg(unix)]
#[test]
fn a_failed_update_is_reported_never_reverted_and_rollback_restores() {
    let rig = hosted_rig("3.4.0", "3.5.0");
    // The new binary won't come up.
    rig.world.lock().unwrap().start_comes_up = false;
    let launch = rig.host.on_launch().unwrap();
    let UpdateOutcome::Failed { from, to, detail } = launch.update else {
        panic!("expected a failed update, got {:?}", launch.update)
    };
    assert_eq!((from.as_str(), to.as_str()), ("3.4.0", "3.5.0"));
    assert!(detail.starts_with("Paracord on this computer didn't start after the update."));
    // Nothing reverted: the new binary stays until the person chooses.
    let layout = rig.host.layout();
    assert!(std::fs::read_to_string(layout.binary())
        .unwrap()
        .contains("3.5.0"));
    assert!(launch.info.update_failure.is_some());
    // The next launch shows the same failure and doesn't try again.
    assert!(matches!(
        rig.host.on_launch().unwrap().update,
        UpdateOutcome::Failed { .. }
    ));

    rig.world.lock().unwrap().start_comes_up = true;
    rig.host.rollback_update().unwrap();
    assert!(std::fs::read_to_string(layout.binary())
        .unwrap()
        .contains("3.4.0"));
    assert!(!layout.previous_binary().exists());
    let state = rig.state();
    assert_eq!(state.installed_version.as_deref(), Some("3.4.0"));
    assert_eq!(state.held_version.as_deref(), Some("3.5.0"));
    assert_eq!(state.update, None);
    let generation = state.config_path.clone().unwrap();
    assert!(generation.starts_with(layout.restores_dir()));
    assert!(generation.is_file());
    let sidecar_log = std::fs::read_to_string(rig._dir.path().join("sidecar.log")).unwrap();
    let restore = sidecar_log
        .lines()
        .find(|l| l.contains("restore-backup"))
        .unwrap();
    assert!(restore.contains("--archive"));
    assert!(restore.contains("data/backups/paracord-backup-1.tar.gz"));
    assert!(!restore.contains("--escrow-key-stdin"));
    // The service now runs the recovered generation's config.
    let install = rig
        .world
        .lock()
        .unwrap()
        .calls
        .iter()
        .rev()
        .find(|c| c.starts_with("install"))
        .unwrap()
        .clone();
    assert!(install.contains(&generation.display().to_string()));
    // A held version is not attempted again.
    assert_eq!(rig.host.update_if_newer().unwrap(), UpdateOutcome::None);
}

#[cfg(unix)]
#[test]
fn an_update_without_a_backup_changes_nothing() {
    let rig = hosted_rig("3.4.0", "3.5.0");
    rig.world.lock().unwrap().backup_error = Some("disk full".into());
    let outcome = rig.host.update_if_newer().unwrap();
    assert_eq!(
        outcome,
        UpdateOutcome::NotStarted {
            detail: "The backup before the update didn't finish (disk full). Nothing was changed."
                .into()
        }
    );
    assert!(!rig.host.layout().previous_binary().exists());
    assert_eq!(rig.state().installed_version.as_deref(), Some("3.4.0"));
}

#[cfg(unix)]
#[test]
fn restore_on_a_fresh_computer_installs_inits_and_activates_the_generation() {
    let rig = rig_with("3.4.0", false, healthy_world());
    rig.host
        .restore(Path::new("/backups/old.tar.gz"), "ZXNjcm93")
        .unwrap();
    let state = rig.state();
    assert!(state.enabled);
    assert!(state.config_path.as_ref().unwrap().is_file());
    for step in ["install", "init", "claim"] {
        assert!(state.has_step(step), "{step}");
    }
    // A new instance: the page escrows the key again under the owner's phrase
    // before rows 4 and 5 (the first backup then carries it).
    assert!(!state.has_step("escrow"));
    // The service isn't installed yet: setup (rows 1, 2, 4, 5) does that.
    assert!(!rig.world.lock().unwrap().installed);
    // The key init generated was taken back before the restore stored the
    // archive's (restore-backup refuses to replace a different key).
    assert_eq!(
        rig.world.lock().unwrap().keychain_deleted,
        [(
            "Paracord".to_string(),
            "host-storage-key:11111111-2222-4333-8444-555555555555".to_string()
        )]
    );
    let sidecar_log = std::fs::read_to_string(rig._dir.path().join("sidecar.log")).unwrap();
    assert!(sidecar_log.contains("restore-backup --archive /backups/old.tar.gz"));
    assert!(sidecar_log.contains("--escrow-key-stdin"));
    assert!(!sidecar_log.contains("ZXNjcm93"));
}

#[cfg(unix)]
#[test]
fn a_failed_fresh_restore_leaves_nothing_half_made() {
    let rig = rig_with("3.4.0", false, healthy_world());
    let layout = rig.host.layout().clone();
    // A database already under the root: refused before the key is touched.
    std::fs::create_dir_all(layout.data_dir()).unwrap();
    std::fs::write(layout.data_dir().join("paracord.db"), b"x").unwrap();
    let err = rig
        .host
        .restore(Path::new("/backups/old.tar.gz"), "ZXNjcm93")
        .unwrap_err();
    assert!(
        err.to_string().contains("already has a server database"),
        "{err}"
    );
    assert!(rig.world.lock().unwrap().keychain_deleted.is_empty());
    // Refused up front: the existing database is untouched.
    assert!(layout.data_dir().join("paracord.db").is_file());
    let state = rig.state();
    assert!(!state.enabled);
    assert!(state.setup.completed_steps.is_empty());
}

#[cfg(unix)]
#[test]
fn a_fresh_restore_that_stops_takes_back_the_key_it_may_have_stored() {
    let rig = rig_with("3.4.0", false, healthy_world());
    let layout = rig.host.layout().clone();
    let err = rig
        .host
        .restore(Path::new("/backups/broken.tar.gz"), "ZXNjcm93")
        .unwrap_err();
    assert!(err.to_string().contains("archive digest mismatch"), "{err}");
    // Once before the restore (the key init made), once after it stopped (the
    // archive's key restore-backup may have stored): nothing is left behind.
    let account = (
        "Paracord".to_string(),
        "host-storage-key:11111111-2222-4333-8444-555555555555".to_string(),
    );
    assert_eq!(
        rig.world.lock().unwrap().keychain_deleted,
        [account.clone(), account]
    );
    assert!(!layout.root().exists());
    let state = rig.state();
    assert!(!state.enabled);
    assert!(state.setup.completed_steps.is_empty());
}
