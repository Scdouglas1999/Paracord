//! The at-rest storage key while the server runs: what protects stored data,
//! and the escrow that lets the owner's recovery phrase restore the key
//! (setup spec §4.5, §4.7).
//!
//! The server binary fills this once at start ([`init`]) after it has resolved
//! the key and opened the database. Route handlers (`/host/status`,
//! `/admin/host-status`, the two escrow routes) and backups read it from here.

use paracord_contracts::host::{KeySource, Protection, StorageKeyEscrow, StorageStatus};
use paracord_util::at_rest::{open_escrow, seal_escrow, EscrowError};
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

/// Everything the running server knows about its storage key.
#[derive(Clone, Default)]
pub struct StorageKeyRuntime {
    /// `[at_rest] enabled` with a key the server could read.
    pub enabled: bool,
    /// Observed on the live pool with `PRAGMA cipher_version` (and a keyed
    /// database), never read from config.
    pub sqlite_encrypted: bool,
    pub files_encrypted: bool,
    pub key_source: Option<KeySource>,
    pub protection: Option<Protection>,
    /// `[host] instance_id`: names the instance in the escrow AAD.
    pub instance_id: Option<String>,
    /// Where the escrow is written (`[host] escrow_file`).
    pub escrow_file: Option<PathBuf>,
    /// The storage master key, for wrapping it into the escrow. Never logged
    /// (`Debug` redacts it) and never sent anywhere.
    pub master_key: Option<[u8; 32]>,
}

impl std::fmt::Debug for StorageKeyRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StorageKeyRuntime")
            .field("enabled", &self.enabled)
            .field("sqlite_encrypted", &self.sqlite_encrypted)
            .field("files_encrypted", &self.files_encrypted)
            .field("key_source", &self.key_source)
            .field("protection", &self.protection)
            .field("instance_id", &self.instance_id)
            .field("escrow_file", &self.escrow_file)
            .field("master_key", &self.master_key.map(|_| "<redacted>"))
            .finish()
    }
}

/// Why an escrow could not be written. Each maps to one HTTP answer.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum EscrowWriteError {
    /// 409: the escrow is write-once per instance.
    #[error("this server's storage key is already escrowed")]
    AlreadyEscrowed,
    /// 409: nothing to escrow.
    #[error("stored data is not encrypted on this server, so there is no storage key to escrow")]
    NotEncrypted,
    /// 409: no `[host] instance_id` / `escrow_file` in the config.
    #[error("this server has no instance id or escrow file configured ([host] instance_id, escrow_file)")]
    NotConfigured,
    /// 400: `wrapping_key` is not b64url of 32 bytes, or the owner key is not hex of 32 bytes.
    #[error("{0}")]
    BadRequest(String),
    /// 500.
    #[error("could not write the escrow file: {0}")]
    Io(String),
}

impl StorageKeyRuntime {
    /// A runtime holding the master key, for [`init`] and tests.
    pub fn with_master_key(mut self, master_key: [u8; 32]) -> Self {
        self.master_key = Some(master_key);
        self
    }

    /// `StorageStatus` (spec §4.5); `escrowed` reads the escrow file now.
    pub fn status(&self) -> StorageStatus {
        StorageStatus {
            enabled: self.enabled,
            sqlite_encrypted: self.sqlite_encrypted,
            files_encrypted: self.files_encrypted,
            key_source: self.enabled.then_some(self.key_source).flatten(),
            protection: self.enabled.then_some(self.protection).flatten(),
            escrowed: self.current_escrow().is_some(),
        }
    }

    /// The escrow on disk, when there is a valid one for this instance.
    pub fn current_escrow(&self) -> Option<StorageKeyEscrow> {
        let path = self.escrow_file.as_deref()?;
        let escrow = read_escrow_file(path).ok()?;
        (Some(escrow.instance_id.as_str()) == self.instance_id.as_deref()).then_some(escrow)
    }

    /// Wrap the storage key under the owner's `escrow_key` and write the escrow
    /// file once (spec §4.7). The wrapping key is used and dropped, never stored.
    pub fn write_escrow(
        &self,
        wrapping_key_b64url: &str,
        owner_public_key_hex: &str,
    ) -> Result<StorageKeyEscrow, EscrowWriteError> {
        let wrapping_key = decode_b64url(wrapping_key_b64url)
            .filter(|key| key.len() == 32)
            .ok_or_else(|| {
                EscrowWriteError::BadRequest("wrapping_key must be b64url of 32 bytes".into())
            })?;
        if !self.enabled || self.master_key.is_none() {
            return Err(EscrowWriteError::NotEncrypted);
        }
        let path = self
            .escrow_file
            .clone()
            .ok_or(EscrowWriteError::NotConfigured)?;
        self.write_escrow_at(&path, &wrapping_key, owner_public_key_hex)
    }

    /// [`Self::write_escrow`] with the raw key, to an explicit path.
    pub fn write_escrow_at(
        &self,
        path: &Path,
        wrapping_key: &[u8],
        owner_public_key_hex: &str,
    ) -> Result<StorageKeyEscrow, EscrowWriteError> {
        let master_key = match (self.enabled, self.master_key) {
            (true, Some(key)) => key,
            _ => return Err(EscrowWriteError::NotEncrypted),
        };
        let instance_id = self
            .instance_id
            .as_deref()
            .ok_or(EscrowWriteError::NotConfigured)?;
        if wrapping_key.len() != 32 {
            return Err(EscrowWriteError::BadRequest(
                "wrapping_key must be 32 bytes".into(),
            ));
        }
        let owner_public_key = owner_public_key_hex.trim().to_ascii_lowercase();
        if paracord_util::hex::hex_decode(&owner_public_key).is_none_or(|key| key.len() != 32) {
            return Err(EscrowWriteError::BadRequest(
                "the owner's public key must be hex of 32 bytes".into(),
            ));
        }
        if path.exists() {
            return Err(EscrowWriteError::AlreadyEscrowed);
        }
        let (iv, ciphertext) = seal_escrow(&master_key, wrapping_key, instance_id)
            .map_err(|e| EscrowWriteError::BadRequest(e.to_string()))?;
        let escrow = StorageKeyEscrow {
            version: 1,
            instance_id: instance_id.to_string(),
            owner_public_key,
            iv: encode_b64url(&iv),
            ciphertext: encode_b64url(&ciphertext),
        };
        let json =
            serde_json::to_vec_pretty(&escrow).map_err(|e| EscrowWriteError::Io(e.to_string()))?;
        write_once(path, &json)?;
        Ok(escrow)
    }
}

/// Read and check an escrow file (`storage-key.escrow`).
pub fn read_escrow_file(path: &Path) -> anyhow::Result<StorageKeyEscrow> {
    let bytes = std::fs::read(path)?;
    let escrow: StorageKeyEscrow = serde_json::from_slice(&bytes)?;
    if escrow.version != 1 {
        anyhow::bail!("unsupported storage key escrow version {}", escrow.version);
    }
    Ok(escrow)
}

/// Unwrap the storage master key from an escrow with the owner's `escrow_key`.
pub fn unwrap_escrow(
    escrow: &StorageKeyEscrow,
    wrapping_key: &[u8],
) -> Result<[u8; 32], EscrowError> {
    if escrow.version != 1 {
        return Err(EscrowError::Malformed);
    }
    let iv = decode_b64url(&escrow.iv).ok_or(EscrowError::Malformed)?;
    let ciphertext = decode_b64url(&escrow.ciphertext).ok_or(EscrowError::Malformed)?;
    open_escrow(&iv, &ciphertext, wrapping_key, &escrow.instance_id)
}

/// RFC 4648 §5 without padding, the encoding every setup contract uses.
pub fn decode_b64url(raw: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw.trim())
        .ok()
}

fn encode_b64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Write `bytes` to `path` only if nothing is there, atomically: the content
/// goes to a private temp file first and is then hard-linked into place, which
/// fails when the destination exists (two racing calls cannot both win).
fn write_once(path: &Path, bytes: &[u8]) -> Result<(), EscrowWriteError> {
    let io = |e: std::io::Error| EscrowWriteError::Io(e.to_string());
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent).map_err(io)?;
    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(format!(".{:016x}.tmp", rand::random::<u64>()));
    let tmp = PathBuf::from(tmp_name);
    let result = (|| {
        write_private_new(&tmp, bytes).map_err(io)?;
        match std::fs::hard_link(&tmp, path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                Err(EscrowWriteError::AlreadyEscrowed)
            }
            Err(e) => Err(io(e)),
        }
    })();
    let _ = std::fs::remove_file(&tmp);
    result
}

fn write_private_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn cell() -> &'static RwLock<StorageKeyRuntime> {
    static CELL: OnceLock<RwLock<StorageKeyRuntime>> = OnceLock::new();
    CELL.get_or_init(|| RwLock::new(StorageKeyRuntime::default()))
}

/// Record the running server's storage key state. Called once at start.
pub fn init(runtime: StorageKeyRuntime) {
    *cell().write().unwrap_or_else(|e| e.into_inner()) = runtime;
    notify_changed();
}

/// Hand the current status to the instance status hub, which sends
/// `INSTANCE_STATUS_UPDATE` to admins when it changed (spec §5.5). Called at
/// start and after an escrow is written.
pub fn notify_changed() {
    crate::reachability::hub().set_storage(status());
}

/// The running server's storage key state.
pub fn current() -> StorageKeyRuntime {
    cell().read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// `StorageStatus` of the running server.
pub fn status() -> StorageStatus {
    current().status()
}

/// The running server's escrow, for backup manifests.
pub fn current_escrow() -> Option<StorageKeyEscrow> {
    current().current_escrow()
}

/// Escrow the running server's storage key (`POST /host/storage-key/escrow`,
/// `POST /admin/storage-key/escrow`). `owner_public_key_hex` is the claiming
/// owner's identity public key; the caller checks who is asking.
pub fn write_escrow(
    wrapping_key_b64url: &str,
    owner_public_key_hex: &str,
) -> Result<StorageKeyEscrow, EscrowWriteError> {
    let escrow = current().write_escrow(wrapping_key_b64url, owner_public_key_hex)?;
    notify_changed();
    Ok(escrow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use paracord_util::at_rest::{derive_escrow_key, generate_master_key};

    const INSTANCE: &str = "7c1f0b6e-4a8e-4f8e-9a51-2d6c1f0b6e4a";
    const OWNER: &str = "ad1556f6b39cd51a513052c0be97b86e668adb99fadb813e0c02ebddf7037fd4";

    fn runtime(dir: &Path, master: [u8; 32]) -> StorageKeyRuntime {
        StorageKeyRuntime {
            enabled: true,
            sqlite_encrypted: true,
            files_encrypted: true,
            key_source: Some(KeySource::Keychain),
            protection: Some(Protection::Login),
            instance_id: Some(INSTANCE.into()),
            escrow_file: Some(dir.join("storage-key.escrow")),
            ..Default::default()
        }
        .with_master_key(master)
    }

    #[test]
    fn escrow_is_written_once_and_unwraps_with_the_owner_key() {
        let dir = tempfile::tempdir().unwrap();
        let master = generate_master_key();
        let rt = runtime(dir.path(), master);
        assert!(!rt.status().escrowed);

        let escrow_key = derive_escrow_key(&[0x42; 32], INSTANCE);
        let escrow = rt.write_escrow(&encode_b64url(&escrow_key), OWNER).unwrap();
        assert_eq!(escrow.instance_id, INSTANCE);
        assert!(rt.status().escrowed);
        assert_eq!(rt.current_escrow().as_ref(), Some(&escrow));

        let on_disk = read_escrow_file(rt.escrow_file.as_deref().unwrap()).unwrap();
        assert_eq!(unwrap_escrow(&on_disk, &escrow_key).unwrap(), master);
        assert_eq!(
            unwrap_escrow(&on_disk, &derive_escrow_key(&[0x43; 32], INSTANCE)),
            Err(EscrowError::WrongKey)
        );
        assert_eq!(
            rt.write_escrow(&encode_b64url(&escrow_key), OWNER),
            Err(EscrowWriteError::AlreadyEscrowed)
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(rt.escrow_file.as_deref().unwrap())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // No temp files left beside it.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn escrow_refuses_bad_input_and_unencrypted_servers() {
        let dir = tempfile::tempdir().unwrap();
        let rt = runtime(dir.path(), generate_master_key());
        assert!(matches!(
            rt.write_escrow("not base64!", OWNER),
            Err(EscrowWriteError::BadRequest(_))
        ));
        assert!(matches!(
            rt.write_escrow(&encode_b64url(&[1; 16]), OWNER),
            Err(EscrowWriteError::BadRequest(_))
        ));
        assert!(matches!(
            rt.write_escrow(&encode_b64url(&[1; 32]), "abcd"),
            Err(EscrowWriteError::BadRequest(_))
        ));
        let off = StorageKeyRuntime::default();
        assert_eq!(
            off.write_escrow(&encode_b64url(&[1; 32]), OWNER),
            Err(EscrowWriteError::NotEncrypted)
        );
        assert_eq!(
            off.status(),
            StorageStatus {
                enabled: false,
                sqlite_encrypted: false,
                files_encrypted: false,
                key_source: None,
                protection: None,
                escrowed: false,
            }
        );
        let mut unnamed = runtime(dir.path(), generate_master_key());
        unnamed.instance_id = None;
        assert_eq!(
            unnamed.write_escrow(&encode_b64url(&[1; 32]), OWNER),
            Err(EscrowWriteError::NotConfigured)
        );
    }

    #[test]
    fn an_escrow_for_another_instance_does_not_count() {
        let dir = tempfile::tempdir().unwrap();
        let rt = runtime(dir.path(), generate_master_key());
        rt.write_escrow(&encode_b64url(&[9; 32]), OWNER).unwrap();
        let mut other = rt.clone();
        other.instance_id = Some("another".into());
        assert!(!other.status().escrowed);
    }
}
