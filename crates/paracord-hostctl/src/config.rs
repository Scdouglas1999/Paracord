//! The few values of the hosted server's config file the app needs. The file
//! is the server's (written by `init --profile desktop-host`); this only reads.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostConfig {
    /// `[tls] cert_path`: the certificate the loopback client pins.
    pub cert_path: PathBuf,
    /// `[host] control_token_file`.
    pub control_token_file: PathBuf,
    /// `[host] instance_id`.
    pub instance_id: Option<String>,
    /// `[backup] backup_dir`.
    pub backup_dir: PathBuf,
    /// `[at_rest] keychain_service` / `keychain_account` when the key source
    /// is the keychain.
    pub keychain: Option<(String, String)>,
}

fn string_at<'a>(value: &'a toml::Value, section: &str, key: &str) -> Option<&'a str> {
    value.get(section)?.get(key)?.as_str()
}

impl HostConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("couldn't read {}", path.display()))?;
        Self::parse(&text)
            .with_context(|| format!("{} is not a usable host config", path.display()))
    }

    pub fn parse(text: &str) -> Result<Self> {
        let value: toml::Value = toml::from_str(text)?;
        let required = |section: &str, key: &str| {
            string_at(&value, section, key)
                .map(PathBuf::from)
                .with_context(|| format!("[{section}] {key} is missing"))
        };
        let keychain = match string_at(&value, "at_rest", "key_source") {
            Some("keychain") => Some((
                string_at(&value, "at_rest", "keychain_service")
                    .unwrap_or(crate::keychain::KEYCHAIN_SERVICE)
                    .to_string(),
                string_at(&value, "at_rest", "keychain_account")
                    .context("[at_rest] keychain_account is missing")?
                    .to_string(),
            )),
            _ => None,
        };
        Ok(Self {
            cert_path: required("tls", "cert_path")?,
            control_token_file: required("host", "control_token_file")?,
            instance_id: string_at(&value, "host", "instance_id").map(str::to_string),
            backup_dir: required("backup", "backup_dir")?,
            keychain,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_profile_values() {
        let config = HostConfig::parse(
            r#"
[tls]
cert_path = "/h/data/certs/cert.pem"
[host]
enabled = true
instance_id = "6f1c"
control_token_file = "/h/config/host-control.token"
[backup]
backup_dir = "/h/data/backups"
[at_rest]
key_source = "keychain"
keychain_service = "Paracord"
keychain_account = "host-storage-key:6f1c"
"#,
        )
        .unwrap();
        assert_eq!(config.cert_path, PathBuf::from("/h/data/certs/cert.pem"));
        assert_eq!(config.instance_id.as_deref(), Some("6f1c"));
        assert_eq!(
            config.keychain,
            Some(("Paracord".into(), "host-storage-key:6f1c".into()))
        );
    }

    #[test]
    fn a_config_without_host_mode_is_refused() {
        let err = HostConfig::parse("[tls]\ncert_path = \"x\"\n[backup]\nbackup_dir = \"y\"\n")
            .unwrap_err();
        assert!(err.to_string().contains("control_token_file"), "{err}");
    }
}
