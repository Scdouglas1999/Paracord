//! Stored-data encryption with an automatic key (docs/setup-spec.md §4).
//!
//! * Key sources (§4.2): `keychain`, `systemd-creds`, `file`, `env`. The source
//!   is explicit in the config; when it cannot produce a valid 32-byte key the
//!   server exits with status 78 and one line naming the source and the reason.
//!   It never starts unencrypted while `[at_rest] enabled = true`.
//! * Generation (§4.3): a plain first run stores a fresh key in the system
//!   keychain when a write/read/delete roundtrip through it works at that
//!   moment, otherwise in a 0600 file next to the config, reads it back, and
//!   only then writes `enabled = true`. That choice is written into the config
//!   once; nothing at runtime falls back from one source to another.
//! * Boot (§4.4): the master key derives the SQLCipher key, the file cryptor and
//!   the TOTP cryptor exactly as before.
//! * Status (§4.5): `sqlite_encrypted` is observed on the live pool.

use crate::config::{self, AtRestConfig, Config};
use anyhow::{Context, Result};
use paracord_contracts::host::{KeySource, Protection};
use paracord_util::at_rest::{format_master_key, generate_master_key, parse_master_key};
use std::path::{Path, PathBuf};

/// `EX_CONFIG`: the storage key is unavailable. systemd units carry
/// `RestartPreventExitStatus=78` so a missing key is not retried in a loop.
pub const EXIT_KEY_UNAVAILABLE: i32 = 78;

/// The `systemd-creds` credential name (`LoadCredentialEncrypted=<name>:<path>`).
pub const SYSTEMD_CREDENTIAL_NAME: &str = "paracord-at-rest-key";

/// Environment variables that, when set, mean the operator decided about
/// at-rest encryption themselves, so a first run generates nothing.
const OPERATOR_CHOICE_ENV: [&str; 2] = ["PARACORD_AT_REST_ENABLED", "PARACORD_AT_REST_KEY_SOURCE"];

// ── Errors ───────────────────────────────────────────────────────────────────

/// The configured source could not produce the storage key.
#[derive(Debug)]
pub struct KeyError {
    pub source: KeySource,
    pub reason: String,
}

impl KeyError {
    fn new(source: KeySource, reason: impl Into<String>) -> Self {
        Self {
            source,
            reason: reason.into(),
        }
    }
}

impl std::fmt::Display for KeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "at-rest key: {}", self.reason)
    }
}

impl std::error::Error for KeyError {}

/// Print the one line and exit 78.
pub fn exit_key_unavailable(error: &KeyError) -> ! {
    tracing::error!(key_source = error.source.as_str(), "{error}");
    eprintln!("{error}");
    std::process::exit(EXIT_KEY_UNAVAILABLE);
}

// ── Key sources ──────────────────────────────────────────────────────────────

/// Read the 32-byte master key from the configured source.
pub fn resolve_key(at_rest: &AtRestConfig) -> Result<[u8; 32], KeyError> {
    let source = at_rest.key_source;
    let raw = match source {
        KeySource::Env => {
            let name = at_rest.key_env.trim();
            if name.is_empty() {
                return Err(KeyError::new(source, "[at_rest] key_env is empty"));
            }
            match std::env::var(name) {
                Ok(value) if !value.trim().is_empty() => value,
                _ => {
                    return Err(KeyError::new(
                        source,
                        format!("the environment variable {name} is not set"),
                    ))
                }
            }
        }
        KeySource::File => {
            let path = at_rest
                .key_file
                .as_deref()
                .filter(|p| !p.trim().is_empty())
                .ok_or_else(|| KeyError::new(source, "[at_rest] key_file is not set"))?;
            read_key_file(Path::new(path)).map_err(|reason| KeyError::new(source, reason))?
        }
        KeySource::Keychain => {
            let account = at_rest
                .keychain_account
                .as_deref()
                .filter(|a| !a.trim().is_empty())
                .ok_or_else(|| KeyError::new(source, "[at_rest] keychain_account is not set"))?;
            keychain::read(&at_rest.keychain_service, account)
                .map_err(|reason| KeyError::new(source, reason))?
        }
        KeySource::SystemdCreds => {
            read_systemd_credential().map_err(|reason| KeyError::new(source, reason))?
        }
    };
    parse_master_key(&raw).map_err(|e| {
        KeyError::new(
            source,
            format!(
                "{} holds something that is not a storage key ({e})",
                describe_source(at_rest)
            ),
        )
    })
}

/// "the system keychain (Paracord / host-storage-key:…)", for messages.
pub fn describe_source(at_rest: &AtRestConfig) -> String {
    match at_rest.key_source {
        KeySource::Env => format!("the environment variable {}", at_rest.key_env.trim()),
        KeySource::File => format!(
            "the key file {}",
            at_rest.key_file.as_deref().unwrap_or("(unset)")
        ),
        KeySource::Keychain => format!(
            "the system keychain entry {} / {}",
            at_rest.keychain_service,
            at_rest.keychain_account.as_deref().unwrap_or("(unset)")
        ),
        KeySource::SystemdCreds => format!("the systemd credential {SYSTEMD_CREDENTIAL_NAME}"),
    }
}

/// What protects the key (§4.6): the recorded label, else the source's own.
pub fn protection_for(at_rest: &AtRestConfig) -> Protection {
    at_rest.protection.unwrap_or(match at_rest.key_source {
        KeySource::Keychain if running_as_windows_system() => Protection::Machine,
        KeySource::Keychain => Protection::Login,
        KeySource::SystemdCreds => Protection::Machine,
        KeySource::File | KeySource::Env => Protection::SameDisk,
    })
}

/// Windows `LocalSystem` keeps its credentials in the machine's profile.
fn running_as_windows_system() -> bool {
    cfg!(windows)
        && std::env::var("USERPROFILE")
            .map(|p| p.to_ascii_lowercase().contains("systemprofile"))
            .unwrap_or(false)
}

/// Read a key file, refusing one other users could read (Unix: any group or
/// other permission bit, or another owner).
pub fn read_key_file(path: &Path) -> Result<String, String> {
    let metadata = std::fs::metadata(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("the key file {} does not exist", path.display())
        } else {
            format!("cannot read the key file {}: {e}", path.display())
        }
    })?;
    if !metadata.is_file() {
        return Err(format!(
            "the key file {} is not a regular file",
            path.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let mode = metadata.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(format!(
                "the key file {} can be read by other users (mode {mode:03o}); run chmod 600 {}",
                path.display(),
                path.display()
            ));
        }
        // SAFETY: geteuid has no preconditions and cannot fail.
        let euid = unsafe { libc::geteuid() };
        if metadata.uid() != euid {
            return Err(format!(
                "the key file {} belongs to another user (uid {}, this server runs as {euid})",
                path.display(),
                metadata.uid()
            ));
        }
    }
    std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read the key file {}: {e}", path.display()))
}

/// `$CREDENTIALS_DIRECTORY/paracord-at-rest-key`, which systemd decrypts for
/// the unit (`LoadCredentialEncrypted=paracord-at-rest-key:<path>`).
fn read_systemd_credential() -> Result<String, String> {
    let dir = std::env::var_os("CREDENTIALS_DIRECTORY").ok_or_else(|| {
        format!(
            "CREDENTIALS_DIRECTORY is not set; the service must load the key with LoadCredentialEncrypted={SYSTEMD_CREDENTIAL_NAME}:<path>"
        )
    })?;
    let path = Path::new(&dir).join(SYSTEMD_CREDENTIAL_NAME);
    std::fs::read_to_string(&path).map_err(|e| {
        format!(
            "systemd did not provide the credential {SYSTEMD_CREDENTIAL_NAME} ({}: {e})",
            path.display()
        )
    })
}

/// The OS credential store via `keyring`, with the platform stores named in
/// Cargo.toml. Never the mock store: every write is proven by a read through a
/// fresh entry.
pub mod keychain {
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    fn entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(service, account).map_err(|e| describe(&e))
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    fn store_name() -> &'static str {
        if cfg!(target_os = "linux") {
            "Secret Service"
        } else if cfg!(target_os = "macos") {
            "Keychain"
        } else {
            "Credential Manager"
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    fn describe(error: &keyring::Error) -> String {
        match error {
            keyring::Error::NoStorageAccess(e) | keyring::Error::PlatformFailure(e) => format!(
                "the system keychain is locked or not running ({}: {e})",
                store_name()
            ),
            keyring::Error::NoEntry => "the system keychain has no such entry".into(),
            other => format!("the system keychain refused ({}: {other})", store_name()),
        }
    }

    /// Read an entry's value.
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    pub fn read(service: &str, account: &str) -> Result<String, String> {
        entry(service, account)?.get_password().map_err(|e| match e {
            keyring::Error::NoEntry => format!(
                "the system keychain has no entry {service} / {account} (was it deleted, or is this a different user?)"
            ),
            other => describe(&other),
        })
    }

    /// Write an entry, then read it back through a fresh entry and compare.
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    pub fn write_verified(service: &str, account: &str, value: &str) -> Result<(), String> {
        entry(service, account)?
            .set_password(value)
            .map_err(|e| describe(&e))?;
        match read(service, account) {
            Ok(back) if back == value => Ok(()),
            Ok(_) => Err("the system keychain returned a different value than was stored".into()),
            Err(e) => Err(format!("the system keychain did not keep the entry ({e})")),
        }
    }

    /// Delete an entry. A missing entry is not an error.
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    pub fn delete(service: &str, account: &str) -> Result<(), String> {
        match entry(service, account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(describe(&e)),
        }
    }

    /// Write, read back and delete a uniquely named probe entry (spec §2.3).
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    pub fn probe(service: &str) -> Result<(), String> {
        let account = format!("probe:{}", uuid::Uuid::new_v4());
        let value = format!("probe-{}", uuid::Uuid::new_v4());
        let written = write_verified(service, &account, &value);
        let deleted = delete(service, &account);
        written?;
        deleted.map_err(|e| format!("the system keychain kept a probe entry ({e})"))
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    pub fn read(_: &str, _: &str) -> Result<String, String> {
        Err("this platform has no supported system keychain".into())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    pub fn write_verified(_: &str, _: &str, _: &str) -> Result<(), String> {
        Err("this platform has no supported system keychain".into())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    pub fn delete(_: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    pub fn probe(_: &str) -> Result<(), String> {
        Err("this platform has no supported system keychain".into())
    }
}

// ── Storing a new key ────────────────────────────────────────────────────────

/// Where a newly generated key goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyPlacement {
    Keychain {
        service: String,
        account: String,
    },
    File {
        path: PathBuf,
    },
    /// `systemd-creds encrypt` into `path`, sealed with the TPM when there is one.
    SystemdCreds {
        path: PathBuf,
    },
    /// The key already in this environment variable (the operator made it).
    Env {
        name: String,
    },
}

impl KeyPlacement {
    pub fn source(&self) -> KeySource {
        match self {
            KeyPlacement::Keychain { .. } => KeySource::Keychain,
            KeyPlacement::File { .. } => KeySource::File,
            KeyPlacement::SystemdCreds { .. } => KeySource::SystemdCreds,
            KeyPlacement::Env { .. } => KeySource::Env,
        }
    }
}

/// Put `key` into its place, read it back and compare. Returns what protects
/// it. Never overwrites an existing key file or credential.
pub fn store_key(placement: &KeyPlacement, key: &[u8; 32]) -> Result<Protection> {
    let spelled = format_master_key(key);
    match placement {
        KeyPlacement::Keychain { service, account } => {
            if keychain::read(service, account).is_ok() {
                anyhow::bail!(
                    "the system keychain already has an entry {service} / {account}; refusing to replace a storage key"
                );
            }
            keychain::write_verified(service, account, &spelled)
                .map_err(|e| anyhow::anyhow!("could not store the storage key: {e}"))?;
            let back = keychain::read(service, account).map_err(|e| anyhow::anyhow!(e))?;
            ensure_same(&back, key, "the system keychain")?;
            Ok(if running_as_windows_system() {
                Protection::Machine
            } else {
                Protection::Login
            })
        }
        KeyPlacement::File { path } => {
            write_new_private_file(path, format!("{spelled}\n").as_bytes())
                .with_context(|| format!("could not write the key file {}", path.display()))?;
            let back = read_key_file(path).map_err(|e| anyhow::anyhow!(e))?;
            ensure_same(&back, key, "the key file")?;
            Ok(Protection::SameDisk)
        }
        KeyPlacement::SystemdCreds { path } => store_systemd_credential(path, &spelled, key),
        KeyPlacement::Env { name } => {
            let value = std::env::var(name)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .with_context(|| format!("the environment variable {name} is not set"))?;
            ensure_same(&value, key, "the environment variable")?;
            Ok(Protection::SameDisk)
        }
    }
}

/// For `env`: the key is the operator's, read from the variable.
pub fn key_from_env(name: &str) -> Result<[u8; 32]> {
    let value = std::env::var(name)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .with_context(|| {
            format!("set {name} to a new key first (for example `openssl rand -hex 32`)")
        })?;
    parse_master_key(&value).map_err(|e| anyhow::anyhow!("{name} is not a storage key: {e}"))
}

fn ensure_same(read_back: &str, key: &[u8; 32], place: &str) -> Result<()> {
    match parse_master_key(read_back) {
        Ok(back) if &back == key => Ok(()),
        _ => anyhow::bail!("{place} did not return the storage key that was stored"),
    }
}

fn store_systemd_credential(path: &Path, spelled: &str, key: &[u8; 32]) -> Result<Protection> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    if path.exists() {
        anyhow::bail!(
            "{} already exists; refusing to replace a storage key",
            path.display()
        );
    }
    let has_tpm2 = Command::new("systemd-creds")
        .arg("has-tpm2")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let with_key = if has_tpm2 { "host+tpm2" } else { "host" };
    let mut child = Command::new("systemd-creds")
        .args([
            "encrypt",
            &format!("--name={SYSTEMD_CREDENTIAL_NAME}"),
            &format!("--with-key={with_key}"),
            "-",
        ])
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("could not run systemd-creds (systemd 250 or newer is needed)")?;
    child
        .stdin
        .take()
        .context("systemd-creds stdin")?
        .write_all(spelled.as_bytes())?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        anyhow::bail!(
            "systemd-creds encrypt failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let back = Command::new("systemd-creds")
        .args(["decrypt", &format!("--name={SYSTEMD_CREDENTIAL_NAME}")])
        .arg(path)
        .arg("-")
        .output()
        .context("could not run systemd-creds decrypt")?;
    if !back.status.success() {
        anyhow::bail!(
            "systemd-creds could not read back the credential: {}",
            String::from_utf8_lossy(&back.stderr).trim()
        );
    }
    ensure_same(&String::from_utf8_lossy(&back.stdout), key, "systemd-creds")?;
    Ok(if has_tpm2 {
        Protection::Tpm
    } else {
        Protection::Machine
    })
}

/// Create `path` (never replacing anything) readable only by this user.
pub fn write_new_private_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    #[cfg(windows)]
    restrict_to_current_user(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Remove inherited access and grant only the current user (the same
/// `icacls` steps the config file gets).
#[cfg(windows)]
fn restrict_to_current_user(path: &Path) -> std::io::Result<()> {
    use std::process::Command;
    let whoami = Command::new("whoami").output()?;
    let principal = String::from_utf8_lossy(&whoami.stdout).trim().to_string();
    if !whoami.status.success() || principal.is_empty() {
        return Err(std::io::Error::other(
            "whoami did not name the current user",
        ));
    }
    let path = path.as_os_str();
    let reset = Command::new("icacls")
        .arg(path)
        .arg("/inheritance:r")
        .status()?;
    let grant = Command::new("icacls")
        .arg(path)
        .args(["/grant:r", &format!("{principal}:F")])
        .status()?;
    if reset.success() && grant.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(
            "icacls could not restrict the key file",
        ))
    }
}

/// The placement a config's `[at_rest]` names (`systemd-creds` keeps its
/// encrypted credential at `key_file`).
pub fn placement_from_config(at_rest: &AtRestConfig) -> Result<KeyPlacement> {
    let named = |value: Option<&str>, what: &str| {
        value
            .filter(|v| !v.trim().is_empty())
            .map(str::to_string)
            .with_context(|| format!("[at_rest] {what} is not set"))
    };
    Ok(match at_rest.key_source {
        KeySource::Keychain => KeyPlacement::Keychain {
            service: at_rest.keychain_service.clone(),
            account: named(at_rest.keychain_account.as_deref(), "keychain_account")?,
        },
        KeySource::File => KeyPlacement::File {
            path: PathBuf::from(named(at_rest.key_file.as_deref(), "key_file")?),
        },
        KeySource::SystemdCreds => KeyPlacement::SystemdCreds {
            path: PathBuf::from(named(at_rest.key_file.as_deref(), "key_file")?),
        },
        KeySource::Env => KeyPlacement::Env {
            name: at_rest.key_env.trim().to_string(),
        },
    })
}

/// Generate a key (or, for `env`, take the operator's), store it where the
/// config's `[at_rest]` says, read it back, and return it with what protects
/// it (spec §2.7, §4.3). For `init --profile desktop-host`.
pub fn provision_configured_source(at_rest: &AtRestConfig) -> Result<([u8; 32], Protection)> {
    let placement = placement_from_config(at_rest)?;
    let key = match &placement {
        KeyPlacement::Env { name } => key_from_env(name)?,
        _ => generate_master_key(),
    };
    let protection = store_key(&placement, &key)?;
    Ok((key, protection))
}

// ── Recording the key in the config file ─────────────────────────────────────

/// What a stored key changes in `[at_rest]` and `[host]`.
#[derive(Debug, Clone)]
pub struct KeyRecord {
    pub placement: KeyPlacement,
    pub protection: Protection,
    pub encrypt_sqlite: bool,
    pub encrypt_files: bool,
    pub instance_id: String,
    pub escrow_file: PathBuf,
}

/// Apply a [`KeyRecord`] to a loaded config.
pub fn apply_record(config: &mut Config, record: &KeyRecord) {
    let at_rest = &mut config.at_rest;
    at_rest.enabled = true;
    at_rest.encrypt_sqlite = record.encrypt_sqlite;
    at_rest.encrypt_files = record.encrypt_files;
    at_rest.key_source = record.placement.source();
    at_rest.protection = Some(record.protection);
    match &record.placement {
        KeyPlacement::Keychain { service, account } => {
            at_rest.keychain_service = service.clone();
            at_rest.keychain_account = Some(account.clone());
        }
        KeyPlacement::File { path } => at_rest.key_file = Some(path_text(path)),
        KeyPlacement::SystemdCreds { .. } => {}
        KeyPlacement::Env { name } => at_rest.key_env = name.clone(),
    }
    config.host.instance_id = Some(record.instance_id.clone());
    config.host.escrow_file = Some(path_text(&record.escrow_file));
}

/// Apply a [`KeyRecord`] to the config file's text: only these keys change;
/// every comment and every other line stays.
pub fn apply_record_to_text(text: &str, record: &KeyRecord) -> String {
    let string = |v: &str| toml::Value::String(v.to_string()).to_string();
    let mut out = text.to_string();
    let mut set = |section: &str, key: &str, raw: String| {
        out = set_raw_key(&out, section, key, &raw);
    };
    set("at_rest", "enabled", "true".into());
    set(
        "at_rest",
        "encrypt_sqlite",
        record.encrypt_sqlite.to_string(),
    );
    set("at_rest", "encrypt_files", record.encrypt_files.to_string());
    set(
        "at_rest",
        "key_source",
        string(record.placement.source().as_str()),
    );
    set("at_rest", "protection", string(record.protection.as_str()));
    match &record.placement {
        KeyPlacement::Keychain { service, account } => {
            set("at_rest", "keychain_service", string(service));
            set("at_rest", "keychain_account", string(account));
        }
        KeyPlacement::File { path } => set("at_rest", "key_file", string(&path_text(path))),
        KeyPlacement::SystemdCreds { .. } => {}
        KeyPlacement::Env { name } => set("at_rest", "key_env", string(name)),
    }
    set("host", "instance_id", string(&record.instance_id));
    set(
        "host",
        "escrow_file",
        string(&path_text(&record.escrow_file)),
    );
    out
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Set `key = <raw TOML value>` inside `[section]`, as text. An assignment is
/// replaced in place; otherwise the template's commented example (`# key = …`)
/// becomes the assignment; otherwise it goes right under the header (and a
/// missing section is appended).
pub fn set_raw_key(text: &str, section: &str, key: &str, raw: &str) -> String {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let assignment = format!("{key} = {raw}");
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let mut current: Option<String> = None;
    let mut header: Option<usize> = None;
    let mut active: Option<usize> = None;
    let mut example: Option<usize> = None;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if let Some(name) = section_name(trimmed) {
            current = Some(name.to_string());
            if name == section && header.is_none() {
                header = Some(index);
            }
            continue;
        }
        if current.as_deref() != Some(section) {
            continue;
        }
        let (commented, body) = match trimmed.strip_prefix('#') {
            Some(rest) => (true, rest.trim_start()),
            None => (false, trimmed),
        };
        let Some((lhs, _)) = body.split_once('=') else {
            continue;
        };
        if lhs.trim() != key {
            continue;
        }
        if commented {
            example.get_or_insert(index);
        } else if active.is_none() {
            active = Some(index);
        }
    }
    match (active, example, header) {
        (Some(index), _, _) | (None, Some(index), _) => {
            let indent: String = lines[index]
                .chars()
                .take_while(|c| c.is_whitespace())
                .collect();
            lines[index] = format!("{indent}{assignment}");
        }
        (None, None, Some(index)) => lines.insert(index + 1, assignment),
        (None, None, None) => {
            if lines.last().is_some_and(|l| !l.trim().is_empty()) {
                lines.push(String::new());
            }
            lines.push(format!("[{section}]"));
            lines.push(assignment);
        }
    }
    let mut out = lines.join(newline);
    out.push_str(newline);
    out
}

fn section_name(trimmed: &str) -> Option<&str> {
    let without_comment = trimmed.split('#').next().unwrap_or("").trim();
    let inner = without_comment.strip_prefix('[')?.strip_suffix(']')?;
    if inner.starts_with('[') {
        return None;
    }
    Some(inner.trim())
}

/// Rewrite the config file with `contents`, keeping who may read it (it holds
/// the JWT secret).
pub fn replace_config_file(path: &Path, contents: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let permissions = std::fs::metadata(path)?.permissions();
        let mut tmp_name = path.as_os_str().to_owned();
        tmp_name.push(".saving");
        let tmp = PathBuf::from(tmp_name);
        let _ = std::fs::remove_file(&tmp);
        let result = (|| {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)?;
            file.write_all(contents.as_bytes())?;
            file.sync_all()?;
            std::fs::set_permissions(&tmp, permissions)?;
            std::fs::rename(&tmp, path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        result
    }
    #[cfg(not(unix))]
    {
        // In place: a renamed replacement would take the directory's
        // inherited ACL and lose the owner-only one on this file.
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(path)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()
    }
}

/// Apply a record to the config file on disk and to the loaded config.
pub fn record_in_config(config_path: &Path, config: &mut Config, record: &KeyRecord) -> Result<()> {
    let text = std::fs::read_to_string(config_path)
        .with_context(|| format!("cannot read {}", config_path.display()))?;
    let updated = apply_record_to_text(&text, record);
    // The edited text must still be a config that says what was stored.
    let reparsed: Config = toml::from_str(&updated).context("the updated config does not parse")?;
    anyhow::ensure!(
        reparsed.at_rest.enabled && reparsed.at_rest.key_source == record.placement.source(),
        "the updated config does not record the storage key"
    );
    replace_config_file(config_path, &updated)
        .with_context(|| format!("cannot write {}", config_path.display()))?;
    apply_record(config, record);
    Ok(())
}

// ── First run ────────────────────────────────────────────────────────────────

/// The directory beside the config file, absolute.
fn config_dir(config_path: &Path) -> Result<PathBuf> {
    let parent = config_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::path::absolute(parent).context("cannot resolve the config directory")
}

/// The SQLite file a `sqlite:` URL names, for the first-run check only.
fn sqlite_url_file(url: &str) -> Option<PathBuf> {
    let rest = url
        .strip_prefix("sqlite://")
        .or_else(|| url.strip_prefix("sqlite:"))?;
    let path = rest.split('?').next()?;
    if path.is_empty() || path.contains(":memory:") {
        return None;
    }
    Some(PathBuf::from(path))
}

/// Plain first run (spec §4.2, §4.3): when this call generated the config,
/// generate the storage key, store it, read it back, and only then turn
/// `[at_rest]` on in the file. Skipped (and said so) when the operator set
/// at-rest encryption through the environment, for PostgreSQL, and when a
/// database already exists (a new key would lock it out; `encrypt-storage`
/// converts existing data).
///
/// On failure the generated config file is removed, so the next start
/// generates again instead of silently running without encryption.
pub fn provision_new_config(config: &mut Config, config_path: &str) -> Result<()> {
    if !config.first_run || config.at_rest.enabled {
        return Ok(());
    }
    if let Some(name) = OPERATOR_CHOICE_ENV
        .iter()
        .find(|name| std::env::var_os(name).is_some())
    {
        tracing::info!(
            "Stored-data encryption: {name} is set, so this first run leaves [at_rest] to the environment"
        );
        return Ok(());
    }
    if !matches!(config.database.engine, config::DatabaseEngine::Sqlite) {
        tracing::warn!(
            "Stored-data encryption is not turned on automatically for PostgreSQL. Files and secrets can be encrypted with `paracord-server encrypt-storage`."
        );
        return Ok(());
    }
    if let Some(db) = sqlite_url_file(&config.database.url) {
        if std::fs::metadata(&db).is_ok_and(|m| m.len() > 0) {
            tracing::warn!(
                "Stored-data encryption is off: {} already exists. Run `paracord-server encrypt-storage` to encrypt it.",
                db.display()
            );
            return Ok(());
        }
    }

    let path = Path::new(config_path);
    let result = generate_for_new_config(config, path);
    if let Err(error) = &result {
        let _ = std::fs::remove_file(path);
        tracing::error!(
            "Could not set up stored-data encryption, so the new config was removed: {error:#}"
        );
    }
    result
}

fn generate_for_new_config(config: &mut Config, config_path: &Path) -> Result<()> {
    let dir = config_dir(config_path)?;
    let instance_id = config
        .host
        .instance_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let service = config.at_rest.keychain_service.clone();
    let placement = match keychain::probe(&service) {
        Ok(()) => KeyPlacement::Keychain {
            service,
            account: format!("host-storage-key:{instance_id}"),
        },
        Err(reason) => {
            tracing::info!(
                "The system keychain is not usable here ({reason}); the storage key goes in a file next to the config"
            );
            KeyPlacement::File {
                path: dir.join("at-rest.key"),
            }
        }
    };
    let key = generate_master_key();
    let protection = store_key(&placement, &key)?;
    let record = KeyRecord {
        placement,
        protection,
        encrypt_sqlite: true,
        encrypt_files: true,
        instance_id,
        escrow_file: dir.join("storage-key.escrow"),
    };
    if let Err(error) = record_in_config(config_path, config, &record) {
        forget_key(&record.placement);
        return Err(error);
    }
    tracing::info!(
        "Stored data is encrypted. The key is in {} ({}).",
        describe_source(&config.at_rest),
        protection.as_str()
    );
    Ok(())
}

/// Remove a key this run stored but could not record.
fn forget_key(placement: &KeyPlacement) {
    match placement {
        KeyPlacement::Keychain { service, account } => {
            let _ = keychain::delete(service, account);
        }
        KeyPlacement::File { path } | KeyPlacement::SystemdCreds { path } => {
            let _ = std::fs::remove_file(path);
        }
        KeyPlacement::Env { .. } => {}
    }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

/// What the running server derives from the master key.
#[derive(Clone, Default)]
pub struct AtRestRuntimeProfile {
    pub sqlite_key_hex: Option<String>,
    pub file_cryptor: Option<paracord_util::at_rest::FileCryptor>,
    pub totp_cryptor: Option<paracord_util::at_rest::FileCryptor>,
    pub master_key: Option<[u8; 32]>,
}

/// Resolve the key and derive the SQLCipher key and the cryptors. A key
/// source failure is a [`KeyError`] inside the `anyhow::Error`.
pub fn build_at_rest_profile(config: &Config) -> Result<AtRestRuntimeProfile> {
    if !config.at_rest.enabled {
        return Ok(AtRestRuntimeProfile::default());
    }
    let sqlite_db = matches!(config.database.engine, config::DatabaseEngine::Sqlite);
    let encrypt_sqlite = config.at_rest.encrypt_sqlite && sqlite_db;
    if config.at_rest.encrypt_sqlite && !sqlite_db {
        tracing::warn!(
            "at_rest.encrypt_sqlite is enabled but database.engine=postgres - ignoring SQLite DB encryption setting"
        );
    }

    let master_key = resolve_key(&config.at_rest)?;

    let sqlite_key_hex =
        encrypt_sqlite.then(|| paracord_util::at_rest::derive_sqlite_key_hex(&master_key));
    let file_cryptor = config.at_rest.encrypt_files.then(|| {
        paracord_util::at_rest::FileCryptor::from_master_key(
            &master_key,
            config.at_rest.allow_plaintext_file_reads,
        )
    });
    // Always create the TOTP cryptor when the master key is available, with
    // plaintext reads for secrets stored before encryption (MFA works on every
    // at-rest server, spec §4.4).
    let totp_cryptor = Some(
        paracord_util::at_rest::FileCryptor::from_master_key_with_context(
            &master_key,
            b"totp",
            true,
        ),
    );

    tracing::info!(
        "At-rest encryption enabled (sqlite={}, files={}, totp=true, allow_plaintext_file_reads={}, key={})",
        encrypt_sqlite,
        config.at_rest.encrypt_files,
        config.at_rest.allow_plaintext_file_reads,
        config.at_rest.key_source.as_str()
    );

    Ok(AtRestRuntimeProfile {
        sqlite_key_hex,
        file_cryptor,
        totp_cryptor,
        master_key: Some(master_key),
    })
}

/// Start-up: build the profile, exiting 78 when the key is unavailable, then
/// make sure the key opens the SQLite database before any pool tries (a pool
/// would only report a timeout).
pub async fn boot(config: &Config) -> Result<AtRestRuntimeProfile> {
    let profile = match build_at_rest_profile(config) {
        Ok(profile) => profile,
        Err(error) => match error.downcast::<KeyError>() {
            Ok(key_error) => exit_key_unavailable(&key_error),
            Err(other) => return Err(other),
        },
    };
    if !matches!(config.database.engine, config::DatabaseEngine::Sqlite) {
        return Ok(profile);
    }
    let check =
        paracord_db::check_sqlite_key(&config.database.url, profile.sqlite_key_hex.as_deref())
            .await;
    match check {
        Ok(paracord_db::SqliteKeyCheck::Opens) => Ok(profile),
        Ok(paracord_db::SqliteKeyCheck::Rejected) if profile.sqlite_key_hex.is_some() => {
            let plaintext = matches!(
                paracord_db::check_sqlite_key(&config.database.url, None).await,
                Ok(paracord_db::SqliteKeyCheck::Opens)
            );
            let reason = if plaintext {
                format!(
                    "the database is not encrypted yet, so the key from {} cannot open it. Run `paracord-server encrypt-storage` to encrypt it",
                    describe_source(&config.at_rest)
                )
            } else {
                format!(
                    "the key from {} does not open the database (it was encrypted with a different key)",
                    describe_source(&config.at_rest)
                )
            };
            exit_key_unavailable(&KeyError::new(config.at_rest.key_source, reason))
        }
        Ok(paracord_db::SqliteKeyCheck::Rejected) => anyhow::bail!(
            "The database is encrypted, but [at_rest] gives this server no key for it (enabled = {}, encrypt_sqlite = {}). Set the key source it was encrypted with, or finish `paracord-server encrypt-storage`.",
            config.at_rest.enabled,
            config.at_rest.encrypt_sqlite
        ),
        // SQLITE_CANTOPEN: there is no database yet (its directory is created
        // next); the pool creates it with the key.
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("14") => Ok(profile),
        Err(error) => Err(anyhow::anyhow!(
            "could not open the database to check its storage key: {error}"
        )),
    }
}

/// After the pool is open: observe the live database and publish the storage
/// status for `/host/status`, `/admin/host-status` and backups.
pub async fn publish_status(
    db: &paracord_db::DbPool,
    config: &Config,
    profile: &AtRestRuntimeProfile,
) -> Result<()> {
    let sqlite = matches!(config.database.engine, config::DatabaseEngine::Sqlite);
    let sqlite_encrypted = sqlite
        && paracord_db::sqlite_storage_encrypted(db)
            .await
            .context("could not read the database's encryption state")?;
    if profile.sqlite_key_hex.is_some() && !sqlite_encrypted {
        anyhow::bail!(
            "[at_rest] encrypt_sqlite is on, but the open database is not encrypted (SQLCipher did not take the key)"
        );
    }
    let enabled = profile.master_key.is_some();
    let runtime = paracord_core::storage_key::StorageKeyRuntime {
        enabled,
        sqlite_encrypted,
        files_encrypted: profile.file_cryptor.is_some(),
        key_source: enabled.then_some(config.at_rest.key_source),
        protection: enabled.then(|| protection_for(&config.at_rest)),
        instance_id: config.host.instance_id.clone(),
        // The same place the escrow routes write to (`host_status::escrow_path`):
        // `[host] escrow_file`, or beside the data directory.
        escrow_file: Some(match &config.host.escrow_file {
            Some(path) => PathBuf::from(path),
            None => Path::new(&config.storage.path)
                .parent()
                .unwrap_or(Path::new("."))
                .join("storage-key.escrow"),
        }),
        master_key: profile.master_key,
    };
    let status = runtime.status();
    paracord_core::storage_key::init(runtime);
    if status.enabled {
        tracing::info!(
            "Stored data: encrypted (database: {}, files: {}, key: {}, protection: {}, escrowed: {})",
            if sqlite { if sqlite_encrypted { "yes" } else { "no" } } else { "PostgreSQL" },
            if status.files_encrypted { "yes" } else { "no" },
            config.at_rest.key_source.as_str(),
            protection_for(&config.at_rest).as_str(),
            if status.escrowed { "yes" } else { "no" },
        );
    } else {
        tracing::warn!(
            "Stored messages and files are not encrypted on this server's disk. Run `paracord-server encrypt-storage` to encrypt them."
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_raw_key_replaces_examples_and_assignments_in_their_own_section() {
        let text = "[at_rest]\nenabled = false\n# key_file = \"/path/to/at-rest.key\"\nkey_source = \"env\"\n\n[host]\nenabled = false\n# instance_id = \"x\"\n";
        let out = set_raw_key(text, "at_rest", "enabled", "true");
        let out = set_raw_key(&out, "at_rest", "key_file", "\"/k\"");
        let out = set_raw_key(&out, "at_rest", "key_source", "\"file\"");
        let out = set_raw_key(&out, "at_rest", "protection", "\"same_disk\"");
        let out = set_raw_key(&out, "host", "instance_id", "\"abc\"");
        let out = set_raw_key(&out, "link_previews", "enabled", "true");
        assert_eq!(
            out,
            "[at_rest]\nprotection = \"same_disk\"\nenabled = true\nkey_file = \"/k\"\nkey_source = \"file\"\n\n[host]\nenabled = false\ninstance_id = \"abc\"\n\n[link_previews]\nenabled = true\n"
        );
        let crlf = set_raw_key("[a]\r\nx = 1\r\n", "a", "x", "2");
        assert_eq!(crlf, "[a]\r\nx = 2\r\n");
    }

    #[test]
    fn a_record_rewrites_the_generated_template_into_a_parsing_config() {
        let mut config = Config::default();
        let template = crate::config::generate_config_template(&config);
        let record = KeyRecord {
            placement: KeyPlacement::File {
                path: PathBuf::from(r"C:\Users\sam\Paracord\config\at-rest.key"),
            },
            protection: Protection::SameDisk,
            encrypt_sqlite: true,
            encrypt_files: true,
            instance_id: "7c1f0b6e-4a8e-4f8e-9a51-2d6c1f0b6e4a".into(),
            escrow_file: PathBuf::from("/srv/paracord/config/storage-key.escrow"),
        };
        let text = apply_record_to_text(&template, &record);
        let parsed: Config = toml::from_str(&text).expect("parses");
        assert!(parsed.at_rest.enabled);
        assert!(parsed.at_rest.encrypt_sqlite && parsed.at_rest.encrypt_files);
        assert_eq!(parsed.at_rest.key_source, KeySource::File);
        assert_eq!(
            parsed.at_rest.key_file.as_deref(),
            Some(r"C:\Users\sam\Paracord\config\at-rest.key")
        );
        assert_eq!(parsed.at_rest.protection, Some(Protection::SameDisk));
        assert_eq!(
            parsed.host.instance_id.as_deref(),
            Some("7c1f0b6e-4a8e-4f8e-9a51-2d6c1f0b6e4a")
        );
        assert!(!parsed.host.enabled, "a plain server is not a desktop host");
        // Everything else is untouched.
        assert_eq!(
            parsed.auth.jwt_secret,
            toml::from_str::<Config>(&template).unwrap().auth.jwt_secret
        );

        apply_record(&mut config, &record);
        assert!(config.at_rest.enabled);
        assert_eq!(config.at_rest.key_source, KeySource::File);
    }

    #[test]
    fn protection_labels_follow_the_source_unless_recorded() {
        let mut at_rest = AtRestConfig {
            key_source: KeySource::File,
            ..AtRestConfig::default()
        };
        assert_eq!(protection_for(&at_rest), Protection::SameDisk);
        at_rest.key_source = KeySource::Env;
        assert_eq!(protection_for(&at_rest), Protection::SameDisk);
        at_rest.key_source = KeySource::SystemdCreds;
        assert_eq!(protection_for(&at_rest), Protection::Machine);
        at_rest.protection = Some(Protection::Tpm);
        assert_eq!(protection_for(&at_rest), Protection::Tpm);
        at_rest.protection = None;
        at_rest.key_source = KeySource::Keychain;
        assert_eq!(protection_for(&at_rest), Protection::Login);
    }

    #[cfg(unix)]
    #[test]
    fn key_files_must_be_private_and_hold_a_key() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("at-rest.key");
        let key = generate_master_key();
        let protection = store_key(&KeyPlacement::File { path: path.clone() }, &key).unwrap();
        assert_eq!(protection, Protection::SameDisk);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let mut at_rest = AtRestConfig {
            key_source: KeySource::File,
            key_file: Some(path.to_string_lossy().into_owned()),
            ..AtRestConfig::default()
        };
        assert_eq!(resolve_key(&at_rest).unwrap(), key);

        // Never replaced.
        assert!(store_key(&KeyPlacement::File { path: path.clone() }, &key).is_err());

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let error = resolve_key(&at_rest).unwrap_err();
        assert_eq!(error.source, KeySource::File);
        assert!(error.reason.contains("chmod 600"), "{}", error.reason);

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::write(&path, "hex:1234").unwrap();
        assert!(resolve_key(&at_rest)
            .unwrap_err()
            .reason
            .contains("not a storage key"));

        at_rest.key_file = Some(
            dir.path()
                .join("missing.key")
                .to_string_lossy()
                .into_owned(),
        );
        assert!(resolve_key(&at_rest)
            .unwrap_err()
            .reason
            .contains("does not exist"));
        at_rest.key_file = None;
        assert!(resolve_key(&at_rest)
            .unwrap_err()
            .reason
            .contains("key_file is not set"));
    }

    /// The real OS credential store, under uniquely named entries that are
    /// deleted again. Runs only with `PARACORD_TEST_REAL_KEYCHAIN=1`: CI's
    /// macOS and Windows jobs, and a throwaway Secret Service on Linux.
    #[test]
    fn keychain_source_roundtrips_through_the_real_store() {
        if std::env::var_os("PARACORD_TEST_REAL_KEYCHAIN").is_none() {
            eprintln!("skipped: set PARACORD_TEST_REAL_KEYCHAIN=1 to use the real keychain");
            return;
        }
        let service = "Paracord-test";
        keychain::probe(service).expect("probe roundtrip");
        let account = format!("test-storage-key:{}", uuid::Uuid::new_v4());
        let placement = KeyPlacement::Keychain {
            service: service.into(),
            account: account.clone(),
        };
        let key = generate_master_key();
        let protection = store_key(&placement, &key).expect("store");
        assert!(matches!(
            protection,
            Protection::Login | Protection::Machine
        ));
        let at_rest = AtRestConfig {
            key_source: KeySource::Keychain,
            keychain_service: service.into(),
            keychain_account: Some(account.clone()),
            ..AtRestConfig::default()
        };
        let resolved = resolve_key(&at_rest);
        let refused = store_key(&placement, &generate_master_key());
        keychain::delete(service, &account).expect("delete");
        assert_eq!(resolved.expect("resolve"), key);
        assert!(refused.is_err(), "an existing entry is never replaced");
        let gone = resolve_key(&at_rest).unwrap_err();
        assert!(gone.reason.contains("has no entry"), "{}", gone.reason);
    }

    #[test]
    fn unconfigured_sources_name_what_is_missing() {
        let at_rest = AtRestConfig {
            key_source: KeySource::Keychain,
            ..AtRestConfig::default()
        };
        assert_eq!(
            resolve_key(&at_rest).unwrap_err().to_string(),
            "at-rest key: [at_rest] keychain_account is not set"
        );
        let at_rest = AtRestConfig {
            key_source: KeySource::Env,
            key_env: "PARACORD_TEST_AT_REST_KEY_THAT_IS_NEVER_SET".into(),
            ..AtRestConfig::default()
        };
        assert_eq!(
            resolve_key(&at_rest).unwrap_err().to_string(),
            "at-rest key: the environment variable PARACORD_TEST_AT_REST_KEY_THAT_IS_NEVER_SET is not set"
        );
    }

    #[test]
    fn sqlite_url_file_reads_the_generated_urls() {
        assert_eq!(
            sqlite_url_file("sqlite://./data/paracord.db?mode=rwc"),
            Some(PathBuf::from("./data/paracord.db"))
        );
        assert_eq!(
            sqlite_url_file("sqlite:///srv/p/paracord.db"),
            Some(PathBuf::from("/srv/p/paracord.db"))
        );
        assert_eq!(sqlite_url_file("sqlite::memory:"), None);
        assert_eq!(sqlite_url_file("postgres://x/y"), None);
    }
}
