//! What the restore screen needs to know about a backup file before anything
//! runs (docs/setup-spec.md §4.8): when it was made, whether its stored data is
//! encrypted, and whose recovery phrase can unlock it (the escrow's instance
//! id and owner public key, §4.7).
//!
//! Only `manifest.json` is read (at most 1 MiB), never the rest of the
//! archive: the same rule as `paracord_core::backup::read_archive_manifest`,
//! which `restore-backup` uses. Nothing secret is in what this returns.

use std::io::Read;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

const MANIFEST: &str = "manifest.json";
const MANIFEST_LIMIT: u64 = 1024 * 1024;

/// A backup file the person picked (`host_pick_backup`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupFile {
    /// Absolute path, passed back to `host_restore`.
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    /// RFC 3339, from the manifest.
    pub created_at: String,
    /// The server version that made it.
    pub server_version: String,
    /// The database (and files) are encrypted with a storage key.
    pub encrypted: bool,
    /// Present when the owner escrowed the storage key under their recovery
    /// phrase before this backup was made.
    pub escrow: Option<BackupEscrow>,
}

/// The public half of the archive's `key_escrow`: enough to derive the escrow
/// key (HKDF info = instance id) and to check a phrase before anything runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupEscrow {
    pub instance_id: String,
    /// Hex of the owner's identity public key.
    pub owner_public_key: String,
}

#[derive(Deserialize)]
struct Manifest {
    created_at: String,
    server_version: String,
    #[serde(default)]
    recovery: Option<Recovery>,
}

#[derive(Deserialize)]
struct Recovery {
    #[serde(default)]
    sqlite_encrypted: bool,
    #[serde(default)]
    files_encrypted: bool,
    #[serde(default)]
    key_escrow: Option<Escrow>,
}

#[derive(Deserialize)]
struct Escrow {
    instance_id: String,
    owner_public_key: String,
}

/// Read a backup's manifest. Errors are sentences for the restore screen.
pub fn inspect(path: &Path) -> Result<BackupFile> {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());
    let metadata = std::fs::metadata(path).with_context(|| format!("Couldn't open {file_name}"))?;
    if !metadata.is_file() {
        bail!("{file_name} isn't a file.");
    }
    let file = std::fs::File::open(path).with_context(|| format!("Couldn't open {file_name}"))?;
    let not_a_backup = || format!("{file_name} isn't a Paracord backup.");
    let mut archive = tar::Archive::new(flate2::read::MultiGzDecoder::new(file));
    let entries = archive.entries().with_context(not_a_backup)?;
    let mut bytes = None;
    for entry in entries {
        let entry = entry.with_context(not_a_backup)?;
        if entry.path().with_context(not_a_backup)?.as_ref() != Path::new(MANIFEST) {
            continue;
        }
        if entry.size() > MANIFEST_LIMIT {
            bail!("{} Its manifest is too large.", not_a_backup());
        }
        let mut buf = Vec::new();
        entry
            .take(MANIFEST_LIMIT + 1)
            .read_to_end(&mut buf)
            .with_context(not_a_backup)?;
        bytes = Some(buf);
        break;
    }
    let Some(bytes) = bytes else {
        bail!("{} It has no manifest.", not_a_backup());
    };
    let manifest: Manifest = serde_json::from_slice(&bytes)
        .with_context(|| format!("{} Its manifest can't be read.", not_a_backup()))?;
    let recovery = manifest.recovery;
    Ok(BackupFile {
        path: path.display().to_string(),
        file_name,
        size_bytes: metadata.len(),
        created_at: manifest.created_at,
        server_version: manifest.server_version,
        encrypted: recovery
            .as_ref()
            .is_some_and(|r| r.sqlite_encrypted || r.files_encrypted),
        escrow: recovery.and_then(|r| r.key_escrow).map(|e| BackupEscrow {
            instance_id: e.instance_id,
            owner_public_key: e.owner_public_key.to_ascii_lowercase(),
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive(dir: &Path, name: &str, files: &[(&str, &[u8])]) -> std::path::PathBuf {
        let path = dir.join(name);
        let gz = flate2::write::GzEncoder::new(
            std::fs::File::create(&path).unwrap(),
            flate2::Compression::fast(),
        );
        let mut tar = tar::Builder::new(gz);
        for (entry, body) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o600);
            header.set_cksum();
            tar.append_data(&mut header, entry, *body).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap();
        path
    }

    const ESCROWED: &str = r#"{"version":1,"created_at":"2026-10-03T04:00:00Z","server_version":"3.4.0","includes_media":true,"db_filename":"paracord.db","recovery":{"sqlite_encrypted":true,"files_encrypted":true,"storage_type":"local","key_check":"x","key_escrow":{"version":1,"instance_id":"7c1f0b6e-4a8e-4f8e-9a51-2d6c1f0b6e4a","owner_public_key":"AD1556F6B39CD51A513052C0BE97B86E668ADB99FADB813E0C02EBDDF7037FD4","iv":"AAAA","ciphertext":"BBBB"}}}"#;

    #[test]
    fn reads_the_escrow_without_unpacking_anything_else() {
        let dir = tempfile::tempdir().unwrap();
        let path = archive(
            dir.path(),
            "paracord_backup_20261003_040000.tar.gz",
            &[
                ("paracord.db", b"not read"),
                ("manifest.json", ESCROWED.as_bytes()),
            ],
        );
        let file = inspect(&path).unwrap();
        assert_eq!(file.file_name, "paracord_backup_20261003_040000.tar.gz");
        assert_eq!(file.created_at, "2026-10-03T04:00:00Z");
        assert_eq!(file.server_version, "3.4.0");
        assert!(file.encrypted);
        assert_eq!(
            file.escrow,
            Some(BackupEscrow {
                instance_id: "7c1f0b6e-4a8e-4f8e-9a51-2d6c1f0b6e4a".into(),
                owner_public_key:
                    "ad1556f6b39cd51a513052c0be97b86e668adb99fadb813e0c02ebddf7037fd4".into(),
            })
        );
    }

    #[test]
    fn a_backup_made_before_the_escrow_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = r#"{"version":1,"created_at":"2026-10-01T04:00:00Z","server_version":"3.3.0","includes_media":true,"db_filename":"paracord.db","recovery":{"sqlite_encrypted":true,"files_encrypted":true,"storage_type":"local","key_check":"x"}}"#;
        let path = archive(
            dir.path(),
            "old.tar.gz",
            &[("manifest.json", manifest.as_bytes())],
        );
        let file = inspect(&path).unwrap();
        assert!(file.encrypted);
        assert_eq!(file.escrow, None);
    }

    #[test]
    fn anything_else_is_not_a_backup() {
        let dir = tempfile::tempdir().unwrap();
        let text = dir.path().join("notes.txt");
        std::fs::write(&text, b"hello").unwrap();
        let err = inspect(&text).unwrap_err().to_string();
        assert!(err.contains("notes.txt isn't a Paracord backup"), "{err}");

        let empty = archive(dir.path(), "empty.tar.gz", &[("paracord.db", b"x")]);
        let err = inspect(&empty).unwrap_err().to_string();
        assert!(err.contains("has no manifest"), "{err}");

        let err = inspect(&dir.path().join("missing.tar.gz"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("Couldn't open missing.tar.gz"), "{err}");
    }
}
