use crate::error::CoreError;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Metadata stored inside every backup archive.
#[derive(Debug, Serialize, Deserialize)]
pub struct BackupManifest {
    pub version: u32,
    pub created_at: String,
    pub server_version: String,
    pub includes_media: bool,
    pub db_filename: String,
}

/// Summary of a backup on disk (returned by list_backups).
#[derive(Debug, Serialize)]
pub struct BackupInfo {
    pub name: String,
    pub size_bytes: u64,
    pub created_at: String,
}

/// Create a full backup archive (database snapshot/dump + optional media tar).
///
/// The backup is written as a `.tar.gz` file containing:
///   - `manifest.json` (version, timestamp, etc.)
///   - database payload (`paracord.db` for SQLite, `paracord.pgdump` for PostgreSQL)
///   - `media/` directory tree (uploads + files, if `include_media` is true)
///
/// Returns the filename of the created backup.
pub async fn create_backup(
    db_url: &str,
    backup_dir: &str,
    storage_path: &str,
    media_storage_path: &str,
    include_media: bool,
) -> Result<String, CoreError> {
    create_backup_with_sqlite_key(
        db_url,
        backup_dir,
        storage_path,
        media_storage_path,
        include_media,
        None,
    )
    .await
}

/// [`create_backup`], but able to snapshot a SQLCipher-encrypted SQLite
/// database.
///
/// `sqlite_key_hex` is the same hex key the server hands to
/// `paracord_db::create_pool_with_sqlite_key`. Without it an encrypted database
/// cannot be opened at all, and the snapshot fails outright rather than
/// producing anything usable.
pub async fn create_backup_with_sqlite_key(
    db_url: &str,
    backup_dir: &str,
    storage_path: &str,
    media_storage_path: &str,
    include_media: bool,
    sqlite_key_hex: Option<String>,
) -> Result<String, CoreError> {
    let backup_dir = Path::new(backup_dir);
    tokio::fs::create_dir_all(backup_dir)
        .await
        .map_err(|e| CoreError::Internal(format!("Failed to create backup dir: {e}")))?;

    let timestamp = Utc::now().format("%Y%m%d_%H%M%S").to_string();
    let filename = format!("paracord_backup_{timestamp}.tar.gz");
    let backup_path = backup_dir.join(&filename);

    let postgres = is_postgres_url(db_url);
    let temp_dir = tempfile::tempdir()
        .map_err(|e| CoreError::Internal(format!("Failed to create temp dir: {e}")))?;
    let db_filename = if postgres {
        "paracord.pgdump"
    } else {
        "paracord.db"
    };
    let snapshot_path = temp_dir.path().join(db_filename);

    let snapshot_path_str = snapshot_path
        .to_str()
        .ok_or_else(|| CoreError::Internal("Invalid snapshot path".into()))?
        .to_string();
    if postgres {
        let db_url_owned = db_url.to_string();
        tokio::task::spawn_blocking(move || pg_dump_into(&db_url_owned, &snapshot_path_str))
            .await
            .map_err(|e| CoreError::Internal(format!("pg_dump task failed: {e}")))?
            .map_err(|e| CoreError::Internal(format!("pg_dump failed: {e}")))?;
    } else {
        sqlite_snapshot(db_url, &snapshot_path_str, sqlite_key_hex)
            .await
            .map_err(CoreError::Internal)?;
    }

    // Build the tar.gz archive
    let manifest = BackupManifest {
        version: 1,
        created_at: Utc::now().to_rfc3339(),
        server_version: env!("CARGO_PKG_VERSION").to_string(),
        includes_media: include_media,
        db_filename: db_filename.to_string(),
    };

    let backup_path_clone = backup_path.clone();
    let storage_path = storage_path.to_string();
    let media_storage_path = media_storage_path.to_string();
    tokio::task::spawn_blocking(move || {
        build_tar_gz(
            &backup_path_clone,
            &snapshot_path,
            &manifest,
            include_media,
            &storage_path,
            &media_storage_path,
        )
    })
    .await
    .map_err(|e| CoreError::Internal(format!("Archive task failed: {e}")))?
    .map_err(|e| CoreError::Internal(format!("Archive creation failed: {e}")))?;

    tracing::info!("Backup created: {}", filename);
    Ok(filename)
}

/// List all backup archives in the backup directory, newest first.
pub async fn list_backups(backup_dir: &str) -> Result<Vec<BackupInfo>, CoreError> {
    let backup_dir = Path::new(backup_dir);
    if !backup_dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    let mut dir = tokio::fs::read_dir(backup_dir)
        .await
        .map_err(|e| CoreError::Internal(format!("Failed to read backup dir: {e}")))?;

    while let Some(entry) = dir
        .next_entry()
        .await
        .map_err(|e| CoreError::Internal(format!("Failed to read dir entry: {e}")))?
    {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".tar.gz") {
            continue;
        }
        let meta = entry
            .metadata()
            .await
            .map_err(|e| CoreError::Internal(format!("Failed to read metadata: {e}")))?;

        // Parse created_at from the filename: paracord_backup_YYYYMMDD_HHMMSS.tar.gz
        let created_at = parse_backup_timestamp(&name).unwrap_or_default();

        entries.push(BackupInfo {
            name,
            size_bytes: meta.len(),
            created_at,
        });
    }

    // Sort by name descending (newest first since names contain timestamps)
    entries.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(entries)
}

/// Restore from a backup archive. Replaces the live database and optionally
/// extracts media files.
///
/// IMPORTANT: The caller should ensure the server is in a safe state (e.g.,
/// draining connections) before calling this. The database pool should be
/// dropped / recreated after this completes.
pub async fn restore_backup(
    backup_name: &str,
    backup_dir: &str,
    db_url: &str,
    storage_path: &str,
    media_storage_path: &str,
) -> Result<(), CoreError> {
    restore_backup_with_sqlite_key(
        backup_name,
        backup_dir,
        db_url,
        storage_path,
        media_storage_path,
        None,
    )
    .await
}

/// [`restore_backup`], but able to take the pre-restore safety snapshot of a
/// SQLCipher-encrypted SQLite database.
pub async fn restore_backup_with_sqlite_key(
    backup_name: &str,
    backup_dir: &str,
    db_url: &str,
    storage_path: &str,
    media_storage_path: &str,
    sqlite_key_hex: Option<String>,
) -> Result<(), CoreError> {
    let backup_path = Path::new(backup_dir).join(backup_name);
    if !backup_path.exists() {
        return Err(CoreError::NotFound);
    }

    // Extract to a temporary directory first to validate
    let temp_dir = tempfile::tempdir()
        .map_err(|e| CoreError::Internal(format!("Failed to create temp dir: {e}")))?;
    let temp_path = temp_dir.path().to_path_buf();

    let backup_path_clone = backup_path.clone();
    let temp_path_clone = temp_path.clone();
    tokio::task::spawn_blocking(move || extract_tar_gz(&backup_path_clone, &temp_path_clone))
        .await
        .map_err(|e| CoreError::Internal(format!("Extract task failed: {e}")))?
        .map_err(|e| CoreError::Internal(format!("Extraction failed: {e}")))?;

    // Validate manifest
    let manifest_path = temp_path.join("manifest.json");
    let manifest_data = tokio::fs::read_to_string(&manifest_path)
        .await
        .map_err(|e| CoreError::Internal(format!("Failed to read manifest: {e}")))?;
    let manifest: BackupManifest = serde_json::from_str(&manifest_data)
        .map_err(|e| CoreError::Internal(format!("Invalid manifest: {e}")))?;

    if manifest.version != 1 {
        return Err(CoreError::BadRequest(format!(
            "Unsupported backup version: {}",
            manifest.version
        )));
    }

    // Replace/restore the database payload
    let extracted_db = temp_path.join(&manifest.db_filename);
    if !extracted_db.exists() {
        return Err(CoreError::Internal(
            "Backup archive missing database file".into(),
        ));
    }

    if is_postgres_url(db_url) {
        let db_url_owned = db_url.to_string();
        let extracted_db_clone = extracted_db.clone();
        tokio::task::spawn_blocking(move || {
            let dump_path = extracted_db_clone
                .to_str()
                .ok_or_else(|| "Invalid extracted dump path".to_string())?;
            pg_restore_from_dump(&db_url_owned, dump_path)
        })
        .await
        .map_err(|e| CoreError::Internal(format!("pg_restore task failed: {e}")))?
        .map_err(CoreError::Internal)?;
    } else {
        let db_path = parse_sqlite_path(db_url)?;

        // The safety copy must be a snapshot, not a file copy. The live
        // database runs in WAL mode, so `std::fs::copy` of the main file alone
        // captures a torn state: everything still sitting in `-wal` is missing,
        // and the result is typically unopenable. `VACUUM INTO` writes a
        // self-consistent database, and goes through the keyed pool so it also
        // works when the database is SQLCipher-encrypted.
        let pre_restore = format!("{db_path}.pre-restore");
        if Path::new(&db_path).exists() {
            // VACUUM INTO refuses to overwrite an existing file.
            match std::fs::remove_file(&pre_restore) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    return Err(CoreError::Internal(format!(
                        "Failed to clear previous pre-restore snapshot: {e}"
                    )))
                }
            }
            sqlite_snapshot(db_url, &pre_restore, sqlite_key_hex.clone())
                .await
                .map_err(|e| CoreError::Internal(format!("Pre-restore snapshot failed: {e}")))?;
        }

        let db_path_clone = db_path.clone();
        let extracted_db_clone = extracted_db.clone();
        tokio::task::spawn_blocking(move || {
            // Stage next to the target so a failed copy cannot leave a
            // half-written file where the database is supposed to be, then move
            // it into place in one step.
            let staging = format!("{db_path_clone}.restore-incoming");
            std::fs::copy(&extracted_db_clone, &staging)
                .map_err(|e| format!("Failed to stage restored database: {e}"))?;
            if let Err(e) = std::fs::rename(&staging, &db_path_clone) {
                let _ = std::fs::remove_file(&staging);
                return Err(format!("Failed to replace database: {e}"));
            }

            // The sidecars belong to the database we just replaced. Left in
            // place, SQLite would replay the old `-wal` against the restored
            // file on the next open and corrupt or silently un-restore it.
            remove_sqlite_sidecars(&db_path_clone)?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| CoreError::Internal(format!("DB replace task failed: {e}")))?
        .map_err(CoreError::Internal)?;
    }

    // Restore media files if included
    if manifest.includes_media {
        let media_src = temp_path.join("media");
        if media_src.exists() {
            let uploads_src = media_src.join("uploads");
            let files_src = media_src.join("files");
            let storage_dest = storage_path.to_string();
            let media_dest = media_storage_path.to_string();

            tokio::task::spawn_blocking(move || {
                if uploads_src.is_dir() {
                    copy_dir_recursive(&uploads_src, Path::new(&storage_dest))
                        .map_err(|e| format!("Failed to restore uploads: {e}"))?;
                }
                if files_src.is_dir() {
                    copy_dir_recursive(&files_src, Path::new(&media_dest))
                        .map_err(|e| format!("Failed to restore media files: {e}"))?;
                }
                Ok::<(), String>(())
            })
            .await
            .map_err(|e| CoreError::Internal(format!("Media restore task failed: {e}")))?
            .map_err(CoreError::Internal)?;
        }
    }

    tracing::info!("Backup restored: {}", backup_name);
    Ok(())
}

/// Return the full file path for a given backup name.
pub fn backup_file_path(backup_dir: &str, name: &str) -> PathBuf {
    Path::new(backup_dir).join(name)
}

// ── Internal helpers ──────────────────────────────────────────────────────

fn parse_sqlite_path(url: &str) -> Result<String, CoreError> {
    let path = url
        .strip_prefix("sqlite://")
        .or_else(|| url.strip_prefix("sqlite:"))
        .unwrap_or(url);
    // Remove query parameters
    let path = path.split('?').next().unwrap_or(path);
    if path.is_empty() {
        return Err(CoreError::Internal(
            "Cannot determine database file path".into(),
        ));
    }
    Ok(path.to_string())
}

fn is_postgres_url(url: &str) -> bool {
    let normalized = url.trim().to_ascii_lowercase();
    normalized.starts_with("postgres://") || normalized.starts_with("postgresql://")
}

/// Delete the `-wal` / `-shm` sidecars belonging to `db_path`.
fn remove_sqlite_sidecars(db_path: &str) -> Result<(), String> {
    for suffix in ["-wal", "-shm"] {
        let sidecar = format!("{db_path}{suffix}");
        match std::fs::remove_file(&sidecar) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Failed to remove stale {sidecar}: {e}")),
        }
    }
    Ok(())
}

/// Snapshot a SQLite database to `dest_path` with `VACUUM INTO`.
async fn sqlite_snapshot(
    db_url: &str,
    dest_path: &str,
    sqlite_key_hex: Option<String>,
) -> Result<(), String> {
    paracord_db::vacuum_sqlite_into(db_url, sqlite_key_hex, dest_path)
        .await
        .map_err(|e| format!("VACUUM INTO failed: {e}"))
}

/// Split a PostgreSQL URL into a password-free URL and the decoded password.
///
/// The password must never reach the child process's argv: everything in
/// `/proc/<pid>/cmdline` is world-readable, so `pg_dump --dbname
/// postgres://user:secret@host/db` leaks the database password to every local
/// account for as long as the dump runs. libpq reads `PGPASSWORD` from the
/// environment instead, which is not exposed the same way.
fn split_pg_password(db_url: &str) -> (String, Option<String>) {
    let Some(scheme_end) = db_url.find("://") else {
        return (db_url.to_string(), None);
    };
    let authority_start = scheme_end + 3;
    let rest = &db_url[authority_start..];
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    // The last `@` inside the authority separates userinfo from host, so a
    // password that itself contains `@` is still split correctly.
    let Some(at) = authority.rfind('@') else {
        return (db_url.to_string(), None);
    };
    let userinfo = &authority[..at];
    let Some(colon) = userinfo.find(':') else {
        return (db_url.to_string(), None);
    };
    let password = percent_decode(&userinfo[colon + 1..]);
    let sanitized = format!(
        "{}://{}@{}{}",
        &db_url[..scheme_end],
        &userinfo[..colon],
        &authority[at + 1..],
        &rest[authority_end..]
    );
    (sanitized, Some(password))
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn pg_command(program: &str, db_url: &str) -> (std::process::Command, String) {
    let (sanitized_url, password) = split_pg_password(db_url);
    let mut cmd = std::process::Command::new(program);
    if let Some(password) = password {
        cmd.env("PGPASSWORD", password);
    }
    (cmd, sanitized_url)
}

fn pg_dump_into(db_url: &str, dest_path: &str) -> Result<(), String> {
    let (mut cmd, sanitized_url) = pg_command("pg_dump", db_url);
    let status = cmd
        .args([
            "--format=custom",
            "--file",
            dest_path,
            "--dbname",
            &sanitized_url,
        ])
        .status()
        .map_err(|e| format!("Failed to run pg_dump: {e}"))?;
    if !status.success() {
        return Err(format!("pg_dump exited with status {status}"));
    }
    Ok(())
}

fn pg_restore_from_dump(db_url: &str, dump_path: &str) -> Result<(), String> {
    let (mut cmd, sanitized_url) = pg_command("pg_restore", db_url);
    let status = cmd
        .args([
            "--clean",
            "--if-exists",
            "--no-owner",
            "--no-privileges",
            "--single-transaction",
            "--dbname",
            &sanitized_url,
            dump_path,
        ])
        .status()
        .map_err(|e| format!("Failed to run pg_restore: {e}"))?;
    if !status.success() {
        return Err(format!("pg_restore exited with status {status}"));
    }
    Ok(())
}

fn build_tar_gz(
    archive_path: &Path,
    db_snapshot: &Path,
    manifest: &BackupManifest,
    include_media: bool,
    storage_path: &str,
    media_storage_path: &str,
) -> Result<(), String> {
    let file = std::fs::File::create(archive_path)
        .map_err(|e| format!("Failed to create archive: {e}"))?;
    let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut tar = tar::Builder::new(encoder);

    // Add manifest.json
    let manifest_json = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("Failed to serialize manifest: {e}"))?;
    let manifest_bytes = manifest_json.as_bytes();
    let mut header = tar::Header::new_gnu();
    header.set_size(manifest_bytes.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, "manifest.json", manifest_bytes)
        .map_err(|e| format!("Failed to add manifest: {e}"))?;

    // Add database snapshot/dump
    tar.append_path_with_name(db_snapshot, &manifest.db_filename)
        .map_err(|e| format!("Failed to add database: {e}"))?;

    // Add media directories if requested
    if include_media {
        let uploads_dir = Path::new(storage_path);
        if uploads_dir.is_dir() {
            tar.append_dir_all("media/uploads", uploads_dir)
                .map_err(|e| format!("Failed to add uploads: {e}"))?;
        }
        let files_dir = Path::new(media_storage_path);
        if files_dir.is_dir() {
            tar.append_dir_all("media/files", files_dir)
                .map_err(|e| format!("Failed to add media files: {e}"))?;
        }
    }

    tar.finish()
        .map_err(|e| format!("Failed to finalize archive: {e}"))?;
    Ok(())
}

fn extract_tar_gz(archive_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let file =
        std::fs::File::open(archive_path).map_err(|e| format!("Failed to open archive: {e}"))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(dest_dir)
        .map_err(|e| format!("Failed to extract archive: {e}"))?;
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if !dst.exists() {
        std::fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
    }
    for entry in std::fs::read_dir(src).map_err(|e| format!("readdir {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| format!("readdir entry: {e}"))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path).map_err(|e| {
                format!("copy {} -> {}: {e}", src_path.display(), dst_path.display())
            })?;
        }
    }
    Ok(())
}

fn parse_backup_timestamp(name: &str) -> Option<String> {
    // Expected format: paracord_backup_YYYYMMDD_HHMMSS.tar.gz
    let stem = name.strip_suffix(".tar.gz")?;
    let ts = stem.strip_prefix("paracord_backup_")?;
    let parts: Vec<&str> = ts.splitn(2, '_').collect();
    if parts.len() != 2 {
        return None;
    }
    let date = parts[0];
    let time = parts[1];
    if date.len() != 8 || time.len() != 6 {
        return None;
    }
    Some(format!(
        "{}-{}-{}T{}:{}:{}Z",
        &date[0..4],
        &date[4..6],
        &date[6..8],
        &time[0..2],
        &time[2..4],
        &time[4..6],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[tokio::test]
    async fn sqlite_backup_restore_round_trip_includes_media() -> TestResult {
        let temp = tempfile::tempdir()?;
        let db_path = temp.path().join("paracord.db");
        let backups = temp.path().join("backups");
        let uploads = temp.path().join("uploads");
        let media = temp.path().join("files");

        std::fs::create_dir_all(uploads.join("avatars"))?;
        std::fs::create_dir_all(media.join("clips"))?;
        std::fs::write(uploads.join("avatars").join("avatar.txt"), b"avatar-before")?;
        std::fs::write(media.join("clips").join("clip.txt"), b"clip-before")?;

        {
            let conn = rusqlite::Connection::open(&db_path)?;
            conn.execute_batch(
                "CREATE TABLE marker (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO marker (id, value) VALUES (1, 'before');",
            )?;
        }

        let db_url = format!("sqlite://{}", db_path.display());
        let backup_name = create_backup(
            &db_url,
            backups.to_str().unwrap(),
            uploads.to_str().unwrap(),
            media.to_str().unwrap(),
            true,
        )
        .await?;

        let listed = list_backups(backups.to_str().unwrap()).await?;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, backup_name);
        assert!(listed[0].size_bytes > 0);

        {
            let conn = rusqlite::Connection::open(&db_path)?;
            conn.execute("UPDATE marker SET value = 'after' WHERE id = 1", [])?;
        }
        std::fs::remove_dir_all(&uploads)?;
        std::fs::remove_dir_all(&media)?;

        restore_backup(
            &backup_name,
            backups.to_str().unwrap(),
            &db_url,
            uploads.to_str().unwrap(),
            media.to_str().unwrap(),
        )
        .await?;

        {
            let conn = rusqlite::Connection::open(&db_path)?;
            let value: String =
                conn.query_row("SELECT value FROM marker WHERE id = 1", [], |row| {
                    row.get(0)
                })?;
            assert_eq!(value, "before");
        }

        let restored_upload = std::fs::read(uploads.join("avatars").join("avatar.txt"))?;
        let restored_media = std::fs::read(media.join("clips").join("clip.txt"))?;
        assert_eq!(restored_upload, b"avatar-before");
        assert_eq!(restored_media, b"clip-before");
        assert!(Path::new(&format!("{}.pre-restore", db_path.display())).exists());

        Ok(())
    }

    #[tokio::test]
    async fn restore_snapshots_wal_state_and_clears_stale_sidecars() -> TestResult {
        let temp = tempfile::tempdir()?;
        let db_path = temp.path().join("paracord.db");
        let backups = temp.path().join("backups");
        let uploads = temp.path().join("uploads");
        let media = temp.path().join("files");
        std::fs::create_dir_all(&uploads)?;
        std::fs::create_dir_all(&media)?;

        {
            let conn = rusqlite::Connection::open(&db_path)?;
            conn.execute_batch(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE marker (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO marker (id, value) VALUES (1, 'archived');",
            )?;
        }

        let db_url = format!("sqlite://{}", db_path.display());
        let backup_name = create_backup(
            &db_url,
            backups.to_str().unwrap(),
            uploads.to_str().unwrap(),
            media.to_str().unwrap(),
            false,
        )
        .await?;

        {
            let conn = rusqlite::Connection::open(&db_path)?;
            conn.execute("UPDATE marker SET value = 'live' WHERE id = 1", [])?;
        }

        // A `-wal` left over from the database being replaced would be replayed
        // against the restored file on the next open.
        let wal = format!("{}-wal", db_path.display());
        let shm = format!("{}-shm", db_path.display());
        std::fs::write(&wal, b"stale-wal")?;
        std::fs::write(&shm, b"stale-shm")?;

        restore_backup(
            &backup_name,
            backups.to_str().unwrap(),
            &db_url,
            uploads.to_str().unwrap(),
            media.to_str().unwrap(),
        )
        .await?;

        assert!(!Path::new(&wal).exists(), "stale -wal survived the restore");
        assert!(!Path::new(&shm).exists(), "stale -shm survived the restore");

        // The safety copy must be a real, openable database holding the state
        // that was live at restore time. A plain file copy of a WAL database
        // produces a torn file instead.
        let pre_restore = format!("{}.pre-restore", db_path.display());
        let snapshot = rusqlite::Connection::open(&pre_restore)?;
        let preserved: String =
            snapshot.query_row("SELECT value FROM marker WHERE id = 1", [], |row| {
                row.get(0)
            })?;
        assert_eq!(preserved, "live");

        let restored = rusqlite::Connection::open(&db_path)?;
        let value: String =
            restored.query_row("SELECT value FROM marker WHERE id = 1", [], |row| {
                row.get(0)
            })?;
        assert_eq!(value, "archived");

        Ok(())
    }

    #[test]
    fn split_pg_password_moves_the_secret_out_of_argv() {
        let (url, password) = split_pg_password("postgres://user:s3cret@db.internal:5432/paracord");
        assert_eq!(url, "postgres://user@db.internal:5432/paracord");
        assert_eq!(password.as_deref(), Some("s3cret"));
    }

    #[test]
    fn split_pg_password_handles_at_signs_and_percent_encoding() {
        let (url, password) =
            split_pg_password("postgresql://admin:p%40ss%3Aw%2Frd@host/db?sslmode=require");
        assert_eq!(url, "postgresql://admin@host/db?sslmode=require");
        assert_eq!(password.as_deref(), Some("p@ss:w/rd"));
    }

    #[test]
    fn split_pg_password_leaves_password_free_urls_alone() {
        for url in [
            "postgres://user@host/db",
            "postgres://host/db",
            "sqlite:///var/lib/paracord.db",
        ] {
            let (out, password) = split_pg_password(url);
            assert_eq!(out, url);
            assert!(password.is_none());
        }
    }
}
