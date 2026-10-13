//! Live restore: "Restore from a backup instead" (docs/setup-spec.md §4.8)
//! against the real server binary, the real system keychain and a real
//! backup made by a claimed owner, with S7's procedure end to end: install,
//! `init --profile desktop-host`, the key `init` generated taken back out of
//! the keychain, `restore-backup --escrow-key-stdin`, setup rows 1 and 2, the
//! escrow written again for the restored instance (row 3 of a restore), rows
//! 4 and 5, and a check that the first backup after the restore carries an
//! escrow the same phrase opens.
//!
//! The background service is stood in for by a manager that runs the
//! service's own command line as a child process, so nothing is registered
//! with systemd, Task Scheduler or launchd. Everything else is real.
//!
//! Runs only with all of:
//! - `PARACORD_HOSTCTL_LIVE_RESTORE_BINARY`: a `paracord-server` (or
//!   `paracord-host`) build with `escrow-key`;
//! - `PARACORD_HOSTCTL_LIVE_RESTORE_ARCHIVE`: a backup whose manifest carries
//!   `key_escrow`;
//! - `PARACORD_HOSTCTL_LIVE_RESTORE_PHRASE_FILE`: the owner's phrase (one line).
//!
//! It writes to the system keychain (one `Paracord / host-storage-key:<id>`
//! entry, removed at the end), so run it only where that keychain is a
//! throwaway one: the S15 container, or a container with its own
//! `gnome-keyring-daemon` on a private D-Bus session. Never on a workstation.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use paracord_contracts::host::HostProgress;
use paracord_hostctl::control::LoopbackHost;
use paracord_hostctl::runner::{CommandRunner, SystemRunner};
use paracord_hostctl::service::ServiceManager;
use paracord_hostctl::{
    HostLayout, HostParts, ServiceNames, ServiceSpec, ServiceState, ServiceStatus, Timing,
};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// Runs the service's command line as a child of this test.
#[derive(Default)]
struct ChildManager {
    child: Mutex<Option<Child>>,
    installed: Mutex<bool>,
}

impl ServiceManager for ChildManager {
    fn install(&self, _spec: &ServiceSpec) -> Result<()> {
        *self.installed.lock().unwrap() = true;
        Ok(())
    }
    fn set_autostart(&self, _spec: &ServiceSpec, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn start(&self, spec: &ServiceSpec) -> Result<()> {
        let mut slot = self.child.lock().unwrap();
        if let Some(child) = slot.as_mut() {
            if child.try_wait()?.is_none() {
                return Ok(());
            }
        }
        let child = Command::new(&spec.program)
            .args(&spec.args)
            .current_dir(&spec.working_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("couldn't run {}", spec.program.display()))?;
        *slot = Some(child);
        Ok(())
    }
    fn stop(&self) -> Result<()> {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }
    fn remove(&self) -> Result<()> {
        self.stop()?;
        *self.installed.lock().unwrap() = false;
        Ok(())
    }
    fn status(&self) -> Result<ServiceStatus> {
        if !*self.installed.lock().unwrap() {
            return Ok(ServiceStatus {
                state: ServiceState::NotInstalled,
                enabled: false,
                exit_code: None,
            });
        }
        let mut slot = self.child.lock().unwrap();
        let (state, exit_code) = match slot.as_mut().map(|c| c.try_wait()) {
            Some(Ok(None)) => (ServiceState::Running, None),
            Some(Ok(Some(status))) => (ServiceState::Failed, status.code()),
            _ => (ServiceState::Stopped, None),
        };
        Ok(ServiceStatus {
            state,
            enabled: true,
            exit_code,
        })
    }
}

/// `paracord-server escrow-key` with the phrase on stdin.
fn escrow_key(binary: &Path, phrase: &str, args: &[&str]) -> Result<String> {
    use std::io::Write;
    let mut child = Command::new(binary)
        .arg("escrow-key")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(format!("{}\n", phrase.trim()).as_bytes())?;
    let out = child.wait_with_output()?;
    if !out.status.success() {
        bail!("escrow-key: {}", String::from_utf8_lossy(&out.stderr));
    }
    Ok(String::from_utf8(out.stdout)?.trim().to_string())
}

#[test]
fn restore_from_a_backup_on_a_fresh_computer() -> Result<()> {
    let (Some(binary), Some(archive), Some(phrase_file)) = (
        env("PARACORD_HOSTCTL_LIVE_RESTORE_BINARY"),
        env("PARACORD_HOSTCTL_LIVE_RESTORE_ARCHIVE"),
        env("PARACORD_HOSTCTL_LIVE_RESTORE_PHRASE_FILE"),
    ) else {
        eprintln!("PARACORD_HOSTCTL_LIVE_RESTORE_* unset: the live restore test does nothing here");
        return Ok(());
    };
    let binary = PathBuf::from(binary);
    let archive = PathBuf::from(archive);
    let phrase = std::fs::read_to_string(phrase_file)?;

    let app_dir = tempfile::tempdir()?;
    let layout = HostLayout::for_app_dir(app_dir.path());
    let manager = Arc::new(ChildManager::default());
    struct Shared(Arc<ChildManager>);
    impl ServiceManager for Shared {
        fn install(&self, s: &ServiceSpec) -> Result<()> {
            self.0.install(s)
        }
        fn set_autostart(&self, s: &ServiceSpec, e: bool) -> Result<()> {
            self.0.set_autostart(s, e)
        }
        fn start(&self, s: &ServiceSpec) -> Result<()> {
            self.0.start(s)
        }
        fn stop(&self) -> Result<()> {
            self.0.stop()
        }
        fn remove(&self) -> Result<()> {
            self.0.remove()
        }
        fn status(&self) -> Result<ServiceStatus> {
            self.0.status()
        }
    }
    let runner: Arc<dyn CommandRunner> = Arc::new(SystemRunner);
    let host = paracord_hostctl::Host::new(HostParts {
        state_path: paracord_hostctl::layout::state_file(app_dir.path()),
        layout: layout.clone(),
        sidecar: binary.clone(),
        names: ServiceNames::production(),
        runner,
        manager: Box::new(Shared(manager.clone())),
        api: Box::new(|port, config, claim_file| {
            Box::new(LoopbackHost::new(
                port,
                &config.cert_path,
                &config.control_token_file,
                claim_file,
            ))
        }),
        keychain_delete: Box::new(paracord_hostctl::keychain::delete),
        port_free: Box::new(paracord_hostctl::preflight::port_bindable),
        manage_firewall: false,
        timing: Timing::default(),
    });

    // What the restore screen reads, then the phrase checked the way the page does.
    let file = host.inspect_backup(&archive)?;
    let escrow = file
        .escrow
        .clone()
        .context("the archive has no key escrow")?;
    eprintln!(
        "backup {} from {} (Paracord {}), escrow for instance {}",
        file.file_name, file.created_at, file.server_version, escrow.instance_id
    );
    let archive_key = escrow_key(
        &binary,
        &phrase,
        &["--archive", &archive.display().to_string()],
    )?;

    let result = (|| -> Result<()> {
        host.restore(&archive, &archive_key)?;
        let info = host.info()?;
        assert!(info.completed_steps.contains(&"claim".to_string()));
        assert!(!info.completed_steps.contains(&"escrow".to_string()));
        let port = info.port.context("no port after the restore")?;
        let instance = info.instance_id.clone().context("no instance id")?;
        assert_ne!(
            instance, escrow.instance_id,
            "the restored server is a new instance"
        );
        eprintln!("restored; new instance {instance} on port {port}");

        let events = Mutex::new(Vec::<HostProgress>::new());
        let emit = |e: HostProgress| {
            eprintln!("row {} {:?} {:?} {:?}", e.row, e.step, e.state, e.detail);
            events.lock().unwrap().push(e);
        };
        host.setup(port, &emit)?;
        let status = host.status()?;
        assert!(status.storage.sqlite_encrypted && status.storage.files_encrypted);
        assert!(!status.storage.escrowed);
        // The owner came with the backup: the restored server is not waiting for a claim.
        assert!(!status.setup_required);
        assert_eq!(status.instance_id.as_deref(), Some(instance.as_str()));

        // Row 3 of a restore: the same phrase, the new instance.
        let new_key = escrow_key(
            &binary,
            &phrase,
            &[
                "--archive",
                &archive.display().to_string(),
                "--instance-id",
                &instance,
            ],
        )?;
        host.write_escrow(&new_key, &escrow.owner_public_key)?;
        host.setup(port, &emit)?;
        assert!(host.status()?.storage.escrowed);
        let rows = events.lock().unwrap();
        for row in [1, 2, 5] {
            assert!(
                rows.iter().any(|e| e.row == row
                    && matches!(e.state, paracord_contracts::host::HostProgressState::Ok)),
                "row {row} never finished"
            );
        }
        drop(rows);

        // The first backup after the restore carries an escrow the same phrase opens.
        // A restored server keeps its backups in its generation (`restores/<stamp>/backups`).
        let mut found = Vec::new();
        for generation in std::fs::read_dir(layout.restores_dir())? {
            let dir = generation?.path().join("backups");
            if let Ok(entries) = std::fs::read_dir(&dir) {
                found.extend(
                    entries
                        .filter_map(|e| e.ok().map(|e| e.path()))
                        .filter(|p| p.to_string_lossy().ends_with(".tar.gz")),
                );
            }
        }
        let newest = found.into_iter().max().context("row 5 left no backup")?;
        let after = host.inspect_backup(&newest)?;
        let after_escrow = after
            .escrow
            .context("the backup after the restore has no escrow")?;
        assert_eq!(after_escrow.instance_id, instance);
        assert_eq!(after_escrow.owner_public_key, escrow.owner_public_key);
        escrow_key(
            &binary,
            &phrase,
            &["--archive", &newest.display().to_string()],
        )?;
        eprintln!(
            "backup after the restore: {} (escrow for {instance})",
            after.file_name
        );
        Ok(())
    })();

    // Leave nothing behind: the server, the keychain entry, the files.
    let _ = manager.stop();
    let _ = host.remove(true);
    drop(app_dir);
    result
}
