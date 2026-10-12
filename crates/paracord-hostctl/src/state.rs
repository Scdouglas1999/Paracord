//! The app's record of "Paracord on this computer": `host.json` beside the
//! host root (spec §2.2), 0600.
//!
//! `{ version: 1, enabled, port, installed_version, setup: { completed_steps[] }, autostart }`
//! plus the fields this crate needs to supervise and update the server
//! (`instance_id`, `config_path`, `update`, `held_version`). Unknown fields
//! from a newer app are an error, not something to drop on the next save.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::fsutil;

/// The `host.json` schema version this build writes and reads.
pub const STATE_VERSION: u32 = 1;

/// Setup steps recorded in `setup.completed_steps`. The first seven are the
/// Rust steps of spec §2.6 (`HostSetupStep` spellings); `claim` and `escrow`
/// are row 3's two calls that go through Rust (`host_claim`,
/// `host_write_escrow`). Rows 4 and 5 run only once `escrow` is recorded, so
/// the first backup carries the key escrow (spec §4.7).
pub mod steps {
    pub const INSTALL: &str = "install";
    pub const INIT: &str = "init";
    pub const SERVICE: &str = "service";
    pub const START: &str = "start";
    pub const STORAGE: &str = "storage";
    pub const CLAIM: &str = "claim";
    pub const ESCROW: &str = "escrow";
    pub const REACH: &str = "reach";
    pub const BACKUP: &str = "backup";
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetupProgress {
    #[serde(default)]
    pub completed_steps: Vec<String>,
}

/// An update that was started (spec §2.8). Present while it runs and after it
/// failed; cleared when it succeeds or is rolled back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateRecord {
    pub from_version: String,
    pub to_version: String,
    /// The archive `POST /host/backup-now` made before the binary changed.
    pub backup_name: String,
    /// Set when the new binary did not come up: what the app shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostState {
    pub version: u32,
    /// A configured server exists under the host root.
    pub enabled: bool,
    pub port: Option<u16>,
    pub installed_version: Option<String>,
    #[serde(default)]
    pub setup: SetupProgress,
    /// "Starts when you sign in to this computer".
    pub autostart: bool,
    /// `[host] instance_id` of the configured server (keychain account name).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    /// The active config when it is not `<root>/config/paracord.toml` (after a
    /// restore, the recovered generation's).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<UpdateRecord>,
    /// A version whose update was rolled back: not attempted again
    /// automatically.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub held_version: Option<String>,
}

impl Default for HostState {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            enabled: false,
            port: None,
            installed_version: None,
            setup: SetupProgress::default(),
            autostart: true,
            instance_id: None,
            config_path: None,
            update: None,
            held_version: None,
        }
    }
}

impl HostState {
    /// Read `path`; a missing file is the default (never hosted here).
    pub fn load(path: &Path) -> Result<Self> {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(e).with_context(|| format!("couldn't read {}", path.display())),
        };
        let state: Self = serde_json::from_str(&text).with_context(|| {
            format!("{} is not a host.json this app understands", path.display())
        })?;
        if state.version != STATE_VERSION {
            bail!(
                "{} has version {}, this app understands {}",
                path.display(),
                state.version,
                STATE_VERSION
            );
        }
        Ok(state)
    }

    /// Write `path` atomically, 0600.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fsutil::create_private_dir_all(parent)
                .with_context(|| format!("couldn't create {}", parent.display()))?;
        }
        let mut bytes = serde_json::to_vec_pretty(self)?;
        bytes.push(b'\n');
        fsutil::write_private_atomic(path, &bytes)
            .with_context(|| format!("couldn't write {}", path.display()))
    }

    pub fn has_step(&self, step: &str) -> bool {
        self.setup.completed_steps.iter().any(|s| s == step)
    }

    pub fn record_step(&mut self, step: &str) {
        if !self.has_step(step) {
            self.setup.completed_steps.push(step.to_string());
        }
    }

    pub fn forget_steps(&mut self, steps: &[&str]) {
        self.setup
            .completed_steps
            .retain(|s| !steps.contains(&s.as_str()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_is_never_hosted() {
        let dir = tempfile::tempdir().unwrap();
        let state = HostState::load(&dir.path().join("host.json")).unwrap();
        assert!(!state.enabled);
        assert!(state.autostart);
        assert_eq!(state.version, 1);
    }

    #[test]
    fn round_trip_keeps_the_spec_shape() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        let mut state = HostState {
            enabled: true,
            port: Some(8443),
            installed_version: Some("3.4.0".into()),
            ..HostState::default()
        };
        state.record_step(steps::INSTALL);
        state.record_step(steps::INSTALL);
        state.record_step(steps::INIT);
        state.save(&path).unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "version": 1,
                "enabled": true,
                "port": 8443,
                "installed_version": "3.4.0",
                "setup": { "completed_steps": ["install", "init"] },
                "autostart": true
            })
        );
        assert_eq!(HostState::load(&path).unwrap(), state);
    }

    #[test]
    fn a_newer_or_foreign_file_is_refused_not_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        std::fs::write(
            &path,
            r#"{"version":2,"enabled":true,"port":1,"installed_version":null,"autostart":true}"#,
        )
        .unwrap();
        assert!(HostState::load(&path)
            .unwrap_err()
            .to_string()
            .contains("version 2"));
        std::fs::write(&path, r#"{"version":1,"enabled":true,"port":1,"installed_version":null,"autostart":true,"surprise":1}"#).unwrap();
        assert!(HostState::load(&path).is_err());
    }
}
