//! The background service (spec §2.4): a systemd user unit on Linux, a
//! per-user Scheduled Task on Windows, a LaunchAgent on macOS.
//!
//! Each manager renders its definition with a pure function (golden-tested on
//! every OS) and drives the platform tool through a [`CommandRunner`]. Names
//! never collide with the installers' (`paracord.service`, task
//! `Paracord Server`).

pub mod launchd;
pub mod schtasks;
pub mod systemd;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::layout::HostLayout;
use crate::runner::CommandRunner;

/// The names one installation uses on each platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceNames {
    /// systemd unit name without `.service`.
    pub systemd_unit: String,
    /// Scheduled Task folder, `\Paracord\`.
    pub task_folder: String,
    /// Scheduled Task name inside the folder.
    pub task_name: String,
    /// launchd label (and plist file stem).
    pub launchd_label: String,
    /// Human description (unit `Description=`, task description).
    pub description: String,
}

impl ServiceNames {
    /// The names the desktop app installs.
    pub fn production() -> Self {
        Self {
            systemd_unit: "paracord-host".into(),
            task_folder: "\\Paracord\\".into(),
            task_name: "Paracord on this computer".into(),
            launchd_label: "com.paracord.desktop.host".into(),
            description: "Paracord on this computer".into(),
        }
    }

    /// Uniquely named for the live integration test
    /// (`paracord-host-test-<suffix>`), so it can never touch a real install.
    pub fn test(suffix: &str) -> Self {
        Self {
            systemd_unit: format!("paracord-host-test-{suffix}"),
            task_folder: "\\Paracord\\".into(),
            task_name: format!("paracord-host-test-{suffix}"),
            launchd_label: format!("com.paracord.desktop.host-test-{suffix}"),
            description: format!("Paracord hostctl live test {suffix}"),
        }
    }

    pub fn systemd_unit_file(&self) -> String {
        format!("{}.service", self.systemd_unit)
    }

    /// `\Paracord\Paracord on this computer`.
    pub fn task_path(&self) -> String {
        format!("{}{}", self.task_folder, self.task_name)
    }
}

/// What the service runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceSpec {
    pub names: ServiceNames,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub working_dir: PathBuf,
    /// Where launchd writes stdout/stderr (macOS only).
    pub launchd_log: PathBuf,
    /// "Starts when you sign in to this computer".
    pub autostart: bool,
}

impl ServiceSpec {
    /// `<host>/bin/paracord-host -c <config> --log-file <host>/logs/server.log`.
    pub fn for_host(
        names: ServiceNames,
        layout: &HostLayout,
        config: &Path,
        autostart: bool,
    ) -> Self {
        Self {
            names,
            program: layout.binary(),
            args: vec![
                "-c".into(),
                config.to_string_lossy().into_owned(),
                "--log-file".into(),
                layout.server_log().to_string_lossy().into_owned(),
            ],
            working_dir: layout.root().to_path_buf(),
            launchd_log: layout.launchd_log(),
            autostart,
        }
    }
}

/// Running state as the service manager reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceState {
    /// The definition is not installed.
    NotInstalled,
    Stopped,
    Starting,
    Running,
    /// Exited with an error and is not being restarted (yet).
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceStatus {
    pub state: ServiceState,
    /// Autostart at sign-in.
    pub enabled: bool,
    /// The last exit status when the manager reports one (78 = storage key
    /// unavailable, spec §2.8).
    pub exit_code: Option<i32>,
}

impl ServiceStatus {
    pub fn not_installed() -> Self {
        Self {
            state: ServiceState::NotInstalled,
            enabled: false,
            exit_code: None,
        }
    }

    pub fn installed(&self) -> bool {
        self.state != ServiceState::NotInstalled
    }
}

/// Exit status of a server that couldn't obtain its storage key (spec §4.2).
pub const EXIT_STORAGE_KEY_UNAVAILABLE: i32 = 78;

pub trait ServiceManager: Send + Sync {
    /// Write the definition and register it, with autostart as in `spec`. Does
    /// not start it. Installing over an existing definition replaces it.
    fn install(&self, spec: &ServiceSpec) -> Result<()>;
    /// Turn starting at sign-in on or off.
    fn set_autostart(&self, spec: &ServiceSpec, enabled: bool) -> Result<()>;
    fn start(&self, spec: &ServiceSpec) -> Result<()>;
    fn stop(&self) -> Result<()>;
    /// Stop it and delete the definition. Removing what is not there is fine.
    fn remove(&self) -> Result<()>;
    fn status(&self) -> Result<ServiceStatus>;
}

/// This platform's manager for `names`, using the real per-user locations.
pub fn platform_manager(
    names: ServiceNames,
    runner: Arc<dyn CommandRunner>,
    scratch_dir: &Path,
) -> Result<Box<dyn ServiceManager>> {
    #[cfg(target_os = "linux")]
    {
        let _ = scratch_dir;
        Ok(Box::new(systemd::SystemdUserManager::new(
            names,
            runner,
            systemd::user_unit_dir()?,
        )))
    }
    #[cfg(target_os = "macos")]
    {
        let _ = scratch_dir;
        Ok(Box::new(launchd::LaunchAgentManager::new(
            names,
            runner,
            launchd::launch_agents_dir()?,
            launchd::current_uid(),
        )))
    }
    #[cfg(windows)]
    {
        Ok(Box::new(schtasks::ScheduledTaskManager::new(
            names,
            runner,
            scratch_dir.to_path_buf(),
            schtasks::current_user_id()?,
        )))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = (names, runner, scratch_dir);
        anyhow::bail!("hosting from the desktop app is not available on this operating system")
    }
}

/// Escape for XML text and attribute values.
pub(crate) fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}
