//! Where things live (spec §2.2). The same names as the server's
//! `host_mode::HostLayout`; this side adds the binary and the app's state file.

use std::path::{Path, PathBuf};

/// The executable suffix of this platform (`.exe` on Windows).
pub const EXE_SUFFIX: &str = std::env::consts::EXE_SUFFIX;

/// The sidecar's file name inside the app bundle and under `<root>/bin`.
pub fn host_binary_name() -> String {
    format!("paracord-host{EXE_SUFFIX}")
}

/// Fixed paths under the host root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostLayout {
    root: PathBuf,
}

impl HostLayout {
    /// `root` is `app_local_data_dir()/host`; see [`HostLayout::for_app_dir`].
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// The host root for the app's local data directory.
    pub fn for_app_dir(app_local_data_dir: &Path) -> Self {
        Self::new(app_local_data_dir.join("host"))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn bin_dir(&self) -> PathBuf {
        self.root.join("bin")
    }
    /// The stable path firewall rules and keychain ACLs key on.
    pub fn binary(&self) -> PathBuf {
        self.bin_dir().join(host_binary_name())
    }
    /// The binary before the last update.
    pub fn previous_binary(&self) -> PathBuf {
        self.bin_dir()
            .join(format!("paracord-host.previous{EXE_SUFFIX}"))
    }
    pub fn config_dir(&self) -> PathBuf {
        self.root.join("config")
    }
    /// The config `init` writes. A restore can move the active config to a
    /// recovered generation (`HostState::config_path`).
    pub fn default_config(&self) -> PathBuf {
        self.config_dir().join("paracord.toml")
    }
    pub fn data_dir(&self) -> PathBuf {
        self.root.join("data")
    }
    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }
    /// What `--log-file` is given (S6 rotates it daily, seven kept).
    pub fn server_log(&self) -> PathBuf {
        self.logs_dir().join("server.log")
    }
    /// launchd's stdout/stderr capture on macOS.
    pub fn launchd_log(&self) -> PathBuf {
        self.logs_dir().join("launchd.log")
    }
    /// Recovered generations written by `restore-backup`.
    pub fn restores_dir(&self) -> PathBuf {
        self.root.join("restores")
    }
}

/// `app_local_data_dir()/host.json`.
pub fn state_file(app_local_data_dir: &Path) -> PathBuf {
    app_local_data_dir.join("host.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_match_the_spec_layout() {
        let layout = HostLayout::new("/home/sam/.local/share/com.paracord.desktop/host");
        assert_eq!(
            layout.default_config(),
            PathBuf::from("/home/sam/.local/share/com.paracord.desktop/host/config/paracord.toml")
        );
        assert_eq!(
            layout.server_log(),
            PathBuf::from("/home/sam/.local/share/com.paracord.desktop/host/logs/server.log")
        );
        let bin = layout.binary();
        assert!(bin.ends_with(format!("bin/paracord-host{EXE_SUFFIX}")));
        assert!(layout
            .previous_binary()
            .ends_with(format!("bin/paracord-host.previous{EXE_SUFFIX}")));
        assert_eq!(
            HostLayout::for_app_dir(Path::new("/a")).root(),
            Path::new("/a/host")
        );
    }
}
