//! "Paracord on this computer" (docs/setup-spec.md §2.5, §2.7): the
//! desktop-host profile written by `init --profile desktop-host`, and the
//! control token written at every start of a server whose `[host]` section is
//! enabled.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use paracord_contracts::host::KeySource;
use rand::RngCore;

use crate::cli::{InitArgs, InitProfile};
use crate::config::{self, Config};

/// The environment override for `[at_rest] key_source`, honored by `init` the
/// same way the server honors it at load.
const KEY_SOURCE_ENV: &str = "PARACORD_AT_REST_KEY_SOURCE";

/// Fixed names under the host root (spec §2.2).
pub struct HostLayout {
    pub root: PathBuf,
}

impl HostLayout {
    pub fn new(root: &Path) -> Self {
        Self { root: root.into() }
    }
    pub fn config_dir(&self) -> PathBuf {
        self.root.join("config")
    }
    pub fn config_file(&self) -> PathBuf {
        self.config_dir().join("paracord.toml")
    }
    pub fn control_token(&self) -> PathBuf {
        self.config_dir().join("host-control.token")
    }
    pub fn data_dir(&self) -> PathBuf {
        self.root.join("data")
    }
    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }
    pub fn escrow(&self) -> PathBuf {
        self.root.join("storage-key.escrow")
    }
}

/// A path as the config file spells it: absolute, with forward slashes (every
/// OS accepts them, and a backslash would be an escape inside the template's
/// quoted strings).
fn config_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// The configuration §2.7 specifies, with absolute paths under `root`.
pub fn desktop_host_config(
    root: &Path,
    port: u16,
    server_name: &str,
    instance_id: &str,
    key_source: KeySource,
) -> Config {
    let layout = HostLayout::new(root);
    let data = layout.data_dir();
    let mut config = Config::default();

    config.server.bind_address = format!("0.0.0.0:{port}");
    config.server.redirect_listener = false;
    config.server.server_name = server_name.to_string();

    config.tls.enabled = true;
    config.tls.auto_generate = true;
    config.tls.port = port;
    config.tls.cert_path = config_path(&data.join("certs").join("cert.pem"));
    config.tls.key_path = config_path(&data.join("certs").join("key.pem"));
    config.tls.acme.webroot_path = config_path(&data.join("acme-webroot"));

    config.voice.port = port;

    config.database.url = format!(
        "sqlite://{}?mode=rwc",
        config_path(&data.join("paracord.db"))
    );
    config.storage.path = config_path(&data.join("uploads"));
    config.media.storage_path = config_path(&data.join("files"));

    config.auth.registration_mode = paracord_core::registration::RegistrationMode::InviteOnly;
    config.auth.require_email = false;
    config.setup.require_claim = true;

    config.at_rest.enabled = true;
    config.at_rest.encrypt_sqlite = true;
    config.at_rest.encrypt_files = true;
    config.at_rest.key_source = key_source;
    config.at_rest.keychain_service = "Paracord".into();
    config.at_rest.keychain_account =
        (key_source == KeySource::Keychain).then(|| format!("host-storage-key:{instance_id}"));

    config.network.auto_port_forward = true;
    config.network.reachability_retry_seconds = 60;

    config.backup.auto_backup_enabled = true;
    config.backup.auto_backup_interval_seconds = 86_400;
    config.backup.max_backups = 14;
    config.backup.include_media = true;
    config.backup.backup_dir = config_path(&data.join("backups"));

    config.host.enabled = true;
    config.host.instance_id = Some(instance_id.to_string());
    config.host.control_token_file = Some(config_path(&layout.control_token()));
    config.host.escrow_file = Some(config_path(&layout.escrow()));

    config.link_previews.enabled = true;
    config.federation.enabled = false;
    config.federation.signing_key_path =
        Some(config_path(&data.join("federation_signing_key.hex")));
    config
}

fn new_instance_id() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// The name the first server starts with: this computer's name.
fn machine_name() -> String {
    let from_env = ["COMPUTERNAME", "HOSTNAME"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .map(|v| v.trim().to_string())
        .find(|v| !v.is_empty());
    let name = from_env
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|v| !v.is_empty())
        });
    name.unwrap_or_else(|| "Paracord".to_string())
}

fn create_private_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).with_context(|| format!("cannot create {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("cannot restrict {}", path.display()))?;
    }
    Ok(())
}

/// Generate the 32-byte storage key, store it in the configured source and
/// read it back (spec §2.7, §4.3; `at_rest_boot`). For `env` the key is the
/// operator's, so this proves it is present and valid.
fn provision_storage_key(config: &Config) -> Result<()> {
    crate::at_rest_boot::provision_configured_source(&config.at_rest).map(|_| ())
}

/// `paracord-host init --profile desktop-host --root R --port P`.
pub fn run_init(args: &InitArgs) -> Result<()> {
    let Some(InitProfile::DesktopHost) = args.profile else {
        bail!("--root and --port belong to --profile desktop-host");
    };
    let root = args
        .root
        .as_deref()
        .context("--profile desktop-host needs --root <dir>")?;
    let port = args
        .port
        .context("--profile desktop-host needs --port <port>")?;
    if port == 0 {
        bail!("--port must be between 1 and 65535");
    }
    let root = if root.is_absolute() {
        root.to_path_buf()
    } else {
        std::env::current_dir()?.join(root)
    };
    let layout = HostLayout::new(&root);
    if layout.config_file().exists() {
        bail!(
            "already initialized: {} exists. Remove \"Paracord on this computer\" \
             from the app to start over.",
            layout.config_file().display()
        );
    }

    let key_source = match std::env::var(KEY_SOURCE_ENV) {
        Ok(raw) => KeySource::parse(&raw).with_context(|| {
            format!("{KEY_SOURCE_ENV} must be keychain, systemd-creds, file or env, not \"{raw}\"")
        })?,
        Err(_) => KeySource::Keychain,
    };
    let instance_id = new_instance_id();
    let config = desktop_host_config(&root, port, &machine_name(), &instance_id, key_source);

    // The key first: a config that says `enabled = true` must never exist
    // without a key behind it.
    provision_storage_key(&config)?;

    let data = layout.data_dir();
    for dir in [
        root.clone(),
        layout.config_dir(),
        data.clone(),
        data.join("certs"),
        data.join("backups"),
        layout.logs_dir(),
    ] {
        create_private_dir(&dir)?;
    }
    config::write_new_config(&config_path(&layout.config_file()), &config)?;

    println!("Initialized Paracord on this computer");
    println!("  root:        {}", root.display());
    println!("  config:      {}", layout.config_file().display());
    println!("  port:        {port}");
    println!("  instance_id: {instance_id}");
    Ok(())
}

/// A fresh control token: 32 random bytes, base64url without padding.
pub fn new_control_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Write `token` to `path` (0600 on Unix), replacing any earlier one atomically
/// so the app never reads half of it.
pub fn write_token_file(path: &Path, token: &str) -> Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let tmp = path.with_extension("token.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&tmp)
        .with_context(|| format!("cannot write {}", tmp.display()))?;
    file.write_all(token.as_bytes())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path).with_context(|| format!("cannot replace {}", path.display()))?;
    Ok(())
}

/// Called once per start, before any listener opens, when `[host] enabled`.
/// Refuses to start a host-mode server that could not be controlled.
pub fn prepare_start(config: &Config) -> Result<()> {
    if !config.host.enabled {
        return Ok(());
    }
    if config.host.instance_id.as_deref().unwrap_or("").is_empty() {
        bail!("[host] enabled = true needs instance_id");
    }
    let path = config
        .host
        .control_token_file
        .as_deref()
        .filter(|p| !p.is_empty())
        .context("[host] enabled = true needs control_token_file")?;
    let token = new_control_token();
    write_token_file(Path::new(path), &token)?;
    crate::logging::register_secret(&token);
    tracing::info!("Host control channel ready (token file rewritten for this start)");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(root: &Path) -> Config {
        desktop_host_config(
            root,
            8443,
            "my-pc",
            "11111111-2222-4333-8444-555555555555",
            KeySource::Keychain,
        )
    }

    #[test]
    fn profile_matches_the_spec_table() {
        let root = Path::new("/home/u/host");
        let c = sample(root);
        assert_eq!(c.server.bind_address, "0.0.0.0:8443");
        assert!(!c.server.redirect_listener);
        assert!(c.tls.enabled && c.tls.auto_generate);
        assert_eq!(c.tls.port, 8443);
        assert_eq!(c.voice.port, 8443);
        assert_eq!(
            c.database.url,
            "sqlite:///home/u/host/data/paracord.db?mode=rwc"
        );
        assert_eq!(c.auth.registration_mode.as_str(), "invite_only");
        assert!(c.setup.require_claim);
        assert!(c.at_rest.enabled && c.at_rest.encrypt_sqlite && c.at_rest.encrypt_files);
        assert_eq!(c.at_rest.key_source, KeySource::Keychain);
        assert_eq!(
            c.at_rest.keychain_account.as_deref(),
            Some("host-storage-key:11111111-2222-4333-8444-555555555555")
        );
        assert!(c.network.auto_port_forward);
        assert_eq!(c.network.reachability_retry_seconds, 60);
        assert!(c.backup.auto_backup_enabled);
        assert_eq!(c.backup.auto_backup_interval_seconds, 86_400);
        assert_eq!(c.backup.max_backups, 14);
        assert_eq!(c.backup.backup_dir, "/home/u/host/data/backups");
        assert!(c.host.enabled);
        assert_eq!(
            c.host.control_token_file.as_deref(),
            Some("/home/u/host/config/host-control.token")
        );
        assert_eq!(
            c.host.escrow_file.as_deref(),
            Some("/home/u/host/storage-key.escrow")
        );
        assert!(!c.federation.enabled);
    }

    #[test]
    fn every_path_is_absolute_and_slashes_are_forward() {
        let c = desktop_host_config(
            Path::new(r"C:\Users\me\AppData\Local\com.paracord.desktop\host"),
            8443,
            "pc",
            "id",
            KeySource::Keychain,
        );
        for value in [
            &c.tls.cert_path,
            &c.tls.key_path,
            &c.storage.path,
            &c.media.storage_path,
            &c.backup.backup_dir,
            c.host.control_token_file.as_ref().unwrap(),
            c.host.escrow_file.as_ref().unwrap(),
        ] {
            assert!(!value.contains('\\'), "{value}");
            assert!(value.starts_with("C:/Users/me/"), "{value}");
        }
    }

    #[test]
    fn the_written_file_parses_back_to_the_same_profile() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("host");
        let path = root.join("config").join("paracord.toml");
        let config = sample(&root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        config::write_new_config(&path.to_string_lossy(), &config).unwrap();
        let parsed: toml::Value = toml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["server"]["redirect_listener"].as_bool(), Some(false));
        assert_eq!(parsed["host"]["enabled"].as_bool(), Some(true));
        assert_eq!(parsed["at_rest"]["key_source"].as_str(), Some("keychain"));
        assert_eq!(parsed["at_rest"]["enabled"].as_bool(), Some(true));
        // Written once, never overwritten.
        assert!(config::write_new_config(&path.to_string_lossy(), &config).is_err());
    }

    #[test]
    fn instance_ids_are_version_4_uuids() {
        let id = new_instance_id();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
    }

    #[test]
    fn a_start_replaces_the_token_and_keeps_it_private() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config").join("host-control.token");
        let mut config = sample(dir.path());
        config.host.control_token_file = Some(path.to_string_lossy().to_string());
        prepare_start(&config).unwrap();
        let first = std::fs::read_to_string(&path).unwrap();
        prepare_start(&config).unwrap();
        let second = std::fs::read_to_string(&path).unwrap();
        assert_ne!(first, second);
        // 32 bytes -> 43 base64url characters.
        assert_eq!(second.len(), 43);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn host_mode_without_a_token_file_does_not_start() {
        let mut config = sample(Path::new("/tmp/x"));
        config.host.control_token_file = None;
        assert!(prepare_start(&config).is_err());
        config.host.enabled = false;
        assert!(prepare_start(&config).is_ok());
    }
}
