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
        let db_path = parse_sqlite_path(db_url)?;
        let db_path_clone = db_path.clone();
        tokio::task::spawn_blocking(move || vacuum_into(&db_path_clone, &snapshot_path_str))
            .await
            .map_err(|e| CoreError::Internal(format!("VACUUM INTO task failed: {e}")))?
            .map_err(|e| CoreError::Internal(format!("VACUUM INTO failed: {e}")))?;
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
        .map_err(|e| CoreError::Internal(e))?;
    } else {
        let db_path = parse_sqlite_path(db_url)?;
        let db_path_clone = db_path.clone();
        let extracted_db_clone = extracted_db.clone();
        tokio::task::spawn_blocking(move || {
            // Backup the current DB file before replacing
            let current_backup = format!("{}.pre-restore", db_path_clone);
            if Path::new(&db_path_clone).exists() {
                std::fs::copy(&db_path_clone, &current_backup)
                    .map_err(|e| format!("Failed to backup current DB: {e}"))?;
            }
            std::fs::copy(&extracted_db_clone, &db_path_clone)
                .map_err(|e| format!("Failed to replace database: {e}"))?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| CoreError::Internal(format!("DB replace task failed: {e}")))?
        .map_err(|e| CoreError::Internal(e))?;
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
            .map_err(|e| CoreError::Internal(e))?;
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

fn vacuum_into(db_path: &str, dest_path: &str) -> Result<(), String> {
    let conn =
        rusqlite::Connection::open(db_path).map_err(|e| format!("Failed to open database: {e}"))?;
    conn.execute_batch(&format!("VACUUM INTO '{dest_path}';"))
        .map_err(|e| format!("VACUUM INTO failed: {e}"))?;
    Ok(())
}

fn pg_dump_into(db_url: &str, dest_path: &str) -> Result<(), String> {
    let status = std::process::Command::new("pg_dump")
        .args(["--format=custom", "--file", dest_path, "--dbname", db_url])
        .status()
        .map_err(|e| format!("Failed to run pg_dump: {e}"))?;
    if !status.success() {
        return Err(format!("pg_dump exited with status {status}"));
    }
    Ok(())
}

fn pg_restore_from_dump(db_url: &str, dump_path: &str) -> Result<(), String> {
    let status = std::process::Command::new("pg_restore")
        .args([
            "--clean",
            "--if-exists",
            "--no-owner",
            "--no-privileges",
            "--single-transaction",
            "--dbname",
            db_url,
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
