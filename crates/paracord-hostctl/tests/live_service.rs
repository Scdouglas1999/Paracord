//! Live service-manager test: installs a **uniquely named** service
//! (`paracord-host-test-<rand>`), drives it through the whole lifecycle and
//! removes it.
//!
//! It runs only when `PARACORD_HOSTCTL_LIVE=1`, and only inside the S15
//! fresh-machine container or the CI `hostctl-smoke-*` jobs (plan S8). Never
//! run it on a workstation: it registers a real systemd user unit, Scheduled
//! Task or LaunchAgent for the current user (removed again at the end, also on
//! failure).
//!
//! Linux needs a systemd user manager (`systemctl --user` works, i.e.
//! `XDG_RUNTIME_DIR` and the user bus are set). macOS needs a GUI session
//! domain (`gui/$UID`). Windows needs an interactive user for the logon
//! trigger's principal.
//!
//! With `PARACORD_HOSTCTL_LIVE_HOST_BINARY=<path to paracord-host>` it also
//! runs setup rows 1 and 2 against the real binary in a scratch app
//! directory (needs an unlocked keychain), then removes everything.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use paracord_hostctl::runner::{CommandRunner, SystemRunner};
use paracord_hostctl::service::{self, ServiceManager};
use paracord_hostctl::{ServiceNames, ServiceSpec, ServiceState};

fn live() -> bool {
    if std::env::var("PARACORD_HOSTCTL_LIVE").as_deref() == Ok("1") {
        return true;
    }
    eprintln!("PARACORD_HOSTCTL_LIVE is not 1: the live service test does nothing here");
    false
}

fn suffix() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..10].to_string()
}

/// A long-running harmless program in place of the server.
fn sleeper(names: ServiceNames, dir: &std::path::Path) -> ServiceSpec {
    #[cfg(windows)]
    let (program, args) = {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        (
            PathBuf::from(root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"),
            vec![
                "-NoProfile".into(),
                "-Command".into(),
                "Start-Sleep -Seconds 600".into(),
            ],
        )
    };
    #[cfg(not(windows))]
    let (program, args) = (
        PathBuf::from("/bin/sh"),
        vec!["-c".to_string(), "sleep 600".to_string()],
    );
    ServiceSpec {
        names,
        program,
        args,
        working_dir: dir.to_path_buf(),
        launchd_log: dir.join("logs/launchd.log"),
        autostart: true,
    }
}

/// Removes the service however the test ends.
struct Cleanup<'a>(&'a dyn ServiceManager);

impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        if let Err(e) = self.0.remove() {
            eprintln!("cleanup: removing the test service failed: {e:#}");
        }
    }
}

fn wait_for(manager: &dyn ServiceManager, want: ServiceState) {
    let started = Instant::now();
    loop {
        let status = manager.status().expect("status");
        if status.state == want {
            return;
        }
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "the service didn't reach {want:?} (last: {status:?})"
        );
        std::thread::sleep(Duration::from_millis(250));
    }
}

#[test]
fn service_lifecycle_on_this_os() {
    if !live() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let names = ServiceNames::test(&suffix());
    let runner: Arc<dyn CommandRunner> = Arc::new(SystemRunner);
    let manager = service::platform_manager(names.clone(), runner, dir.path()).unwrap();
    let _cleanup = Cleanup(manager.as_ref());
    let spec = sleeper(names, dir.path());

    assert_eq!(manager.status().unwrap().state, ServiceState::NotInstalled);
    manager.install(&spec).unwrap();
    let status = manager.status().unwrap();
    assert!(status.installed());
    assert!(status.enabled, "installed with autostart on: {status:?}");
    assert_ne!(
        status.state,
        ServiceState::Running,
        "install must not start it"
    );

    manager.start(&spec).unwrap();
    wait_for(manager.as_ref(), ServiceState::Running);

    manager.set_autostart(&spec, false).unwrap();
    assert!(!manager.status().unwrap().enabled);

    manager.stop().unwrap();
    wait_for(manager.as_ref(), ServiceState::Stopped);

    // Start works with autostart off too (Settings' Start button).
    let mut off = spec.clone();
    off.autostart = false;
    manager.start(&off).unwrap();
    wait_for(manager.as_ref(), ServiceState::Running);
    assert!(!manager.status().unwrap().enabled);

    manager.set_autostart(&spec, true).unwrap();
    assert!(manager.status().unwrap().enabled);

    manager.remove().unwrap();
    assert_eq!(manager.status().unwrap().state, ServiceState::NotInstalled);
    // Removing twice is fine.
    manager.remove().unwrap();
}

#[test]
fn host_setup_rows_1_and_2_with_the_real_binary() {
    if !live() {
        return;
    }
    let Some(binary) = std::env::var_os("PARACORD_HOSTCTL_LIVE_HOST_BINARY") else {
        eprintln!(
            "PARACORD_HOSTCTL_LIVE_HOST_BINARY is not set: skipping the real-binary setup run"
        );
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let app_dir = dir.path().join("com.paracord.desktop");
    let host = paracord_hostctl::Host::system_named(
        &app_dir,
        PathBuf::from(binary),
        ServiceNames::test(&suffix()),
    )
    .unwrap()
    .without_firewall();

    struct RemoveHost<'a>(&'a paracord_hostctl::Host);
    impl Drop for RemoveHost<'_> {
        fn drop(&mut self) {
            if let Err(e) = self.0.remove(true) {
                eprintln!("cleanup: removing the test host failed: {e:#}");
            }
            eprintln!("cleanup: the test host is removed");
        }
    }
    let _cleanup = RemoveHost(&host);

    // Each step says when it starts and ends: on a machine where something
    // waits for a person (a keychain prompt), this is how CI shows where.
    let t0 = std::time::Instant::now();
    eprintln!("[{:>6.1}s] preflight", t0.elapsed().as_secs_f32());
    let preflight = host.preflight().unwrap();
    eprintln!(
        "[{:>6.1}s] preflight done: ok={}",
        t0.elapsed().as_secs_f32(),
        preflight.ok
    );
    assert!(preflight.ok, "preflight refused: {preflight:?}");
    let port = preflight.port.unwrap();
    let events = std::sync::Mutex::new(Vec::new());
    host.setup(port, &|e| {
        eprintln!(
            "[{:>6.1}s] setup row {} {}",
            t0.elapsed().as_secs_f32(),
            e.row,
            serde_json::to_string(&e.state).unwrap_or_default()
        );
        events.lock().unwrap().push(e)
    })
    .unwrap();
    eprintln!("[{:>6.1}s] setup returned", t0.elapsed().as_secs_f32());
    let events = events.into_inner().unwrap();
    let last = events.last().unwrap();
    assert_eq!(
        (last.row, serde_json::to_value(last.state).unwrap()),
        (2, serde_json::json!("ok")),
        "setup stopped early: {events:?}\n{}",
        host.logs_tail(200).unwrap_or_default()
    );
    let status = host.status().unwrap();
    eprintln!("[{:>6.1}s] status read", t0.elapsed().as_secs_f32());
    assert!(status.storage.sqlite_encrypted && status.setup_required);
    host.stop().unwrap();
    eprintln!("[{:>6.1}s] stopped", t0.elapsed().as_secs_f32());
    host.start().unwrap();
    eprintln!(
        "[{:>6.1}s] started again; removing the test host",
        t0.elapsed().as_secs_f32()
    );
}
