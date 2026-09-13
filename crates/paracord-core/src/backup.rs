use crate::error::CoreError;
use base64::Engine;
use chrono::Utc;
use paracord_util::at_rest::FileCryptor;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Metadata stored inside every backup archive.
#[derive(Debug, Serialize, Deserialize)]
pub struct BackupManifest {
    pub version: u32,
    pub created_at: String,
    pub server_version: String,
    pub includes_media: bool,
    pub db_filename: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<RecoveryMetadata>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RecoveryMetadata {
    pub sqlite_encrypted: bool,
    pub files_encrypted: bool,
    pub storage_type: String,
    /// Authenticated canary verifies the separately retained at-rest key.
    pub key_check: Option<String>,
}

const RECOVERY_CANARY: &[u8] = b"Paracord backup recovery key v1";
const RECOVERY_AAD: &[u8] = b"paracord:backup:key-check";

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
        recovery: None,
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

/// Snapshot the already-open runtime pool, including SQLCipher's active key.
/// S3 objects require a separate export; never label local directories as an S3 backup.
pub async fn create_backup_from_pool(
    pool: &paracord_db::DbPool,
    db_url: &str,
    backup_dir: &str,
    storage_path: &str,
    media_storage_path: &str,
    include_media: bool,
    local_storage: bool,
    file_cryptor: Option<&FileCryptor>,
    secret_cryptor: Option<&FileCryptor>,
) -> Result<String, CoreError> {
    if include_media && !local_storage {
        return Err(CoreError::BadRequest("S3 media is not included by this archive format. Export object storage separately; use database-only backup only with that recovery plan.".into()));
    }
    tokio::fs::create_dir_all(backup_dir)
        .await
        .map_err(|e| CoreError::Internal(e.to_string()))?;
    let temp = tempfile::tempdir().map_err(|e| CoreError::Internal(e.to_string()))?;
    let postgres = is_postgres_url(db_url);
    let db_filename = if postgres {
        "paracord.pgdump"
    } else {
        "paracord.db"
    };
    let snapshot = temp.path().join(db_filename);
    if postgres {
        let url = db_url.to_owned();
        let path = snapshot.to_string_lossy().into_owned();
        tokio::task::spawn_blocking(move || pg_dump_into(&url, &path))
            .await
            .map_err(|e| CoreError::Internal(e.to_string()))?
            .map_err(CoreError::Internal)?;
    } else {
        sqlx::query("VACUUM INTO $1")
            .bind(snapshot.to_string_lossy().as_ref())
            .execute(pool)
            .await
            .map_err(|e| CoreError::Internal(format!("Snapshot failed: {e}")))?;
    }
    let sqlite_encrypted = !postgres
        && !sqlite_plaintext_header(&snapshot).map_err(|e| CoreError::Internal(e.to_string()))?;
    let key_check = secret_cryptor
        .map(|cryptor| {
            cryptor
                .encrypt_with_aad(RECOVERY_CANARY, RECOVERY_AAD)
                .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
                .map_err(|e| CoreError::Internal(e.to_string()))
        })
        .transpose()?;
    let filename = format!(
        "paracord_backup_{}_{:016x}.tar.gz",
        Utc::now().format("%Y%m%d_%H%M%S"),
        rand::random::<u64>()
    );
    let manifest = BackupManifest {
        version: 2,
        created_at: Utc::now().to_rfc3339(),
        server_version: env!("CARGO_PKG_VERSION").into(),
        includes_media: include_media,
        db_filename: db_filename.into(),
        recovery: Some(RecoveryMetadata {
            sqlite_encrypted,
            files_encrypted: file_cryptor.is_some(),
            storage_type: if local_storage { "local" } else { "s3" }.into(),
            key_check,
        }),
    };
    let destination = Path::new(backup_dir).join(&filename);
    let uploads = storage_path.to_owned();
    let files = media_storage_path.to_owned();
    tokio::task::spawn_blocking(move || {
        build_tar_gz(
            &destination,
            &snapshot,
            &manifest,
            include_media,
            &uploads,
            &files,
        )
    })
    .await
    .map_err(|e| CoreError::Internal(e.to_string()))?
    .map_err(CoreError::Internal)?;
    Ok(filename)
}

/// Live database replacement is deliberately unavailable. Use the offline
/// `restore-backup` command to prepare a verified, isolated recovery generation.
pub async fn restore_backup(
    _backup_name: &str,
    _backup_dir: &str,
    _db_url: &str,
    _storage_path: &str,
    _media_storage_path: &str,
) -> Result<(), CoreError> {
    Err(CoreError::BadRequest("Live restore is unavailable. Use paracord-server restore-backup to prepare an isolated recovery generation.".into()))
}

pub async fn restore_backup_with_sqlite_key(
    backup_name: &str,
    backup_dir: &str,
    db_url: &str,
    storage_path: &str,
    media_storage_path: &str,
    _sqlite_key_hex: Option<String>,
) -> Result<(), CoreError> {
    restore_backup(
        backup_name,
        backup_dir,
        db_url,
        storage_path,
        media_storage_path,
    )
    .await
}

/// Recovery inputs are retained outside the archive. Keys are never written to
/// the report; the generated activation config refers to the existing key env.
pub struct RestoreOptions<'a> {
    pub archive: &'a Path,
    pub output_dir: &'a Path,
    pub engine: paracord_db::DatabaseEngine,
    pub postgres_target_url: Option<&'a str>,
    pub external_media: Option<&'a Path>,
    pub sqlite_key_hex: Option<String>,
    pub file_cryptor: Option<FileCryptor>,
    pub secret_cryptor: Option<FileCryptor>,
    pub max_unpacked_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RestoreReport {
    pub database_engine: String,
    pub database_history_epoch: String,
    pub repaired_channel_tails: u64,
    pub verified_attachments: u64,
    pub verified_encrypted_secrets: u64,
    pub media_files: u64,
    pub table_rows: std::collections::BTreeMap<String, i64>,
    pub source_archive_sha256: String,
    pub sqlite_encrypted: bool,
}

/// Prepare a new database/media generation. This never opens or replaces the
/// configured live database. The caller publishes an activation config only after
/// this succeeds and after separately validating TLS/config recovery material.
pub async fn prepare_restore(options: RestoreOptions<'_>) -> anyhow::Result<RestoreReport> {
    use anyhow::Context;
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(options.output_dir)
        .context("output directory must be new, with an existing parent")?;
    let result = prepare_restore_inner(&options).await;
    if result.is_err() {
        let _ = write_private_file(&options.output_dir.join("RESTORE_FAILED.txt"),
            b"Verification failed. No activation config was published. The source archive and configured server data were not replaced. Discard this isolated recovery directory and, for PostgreSQL, its dedicated target database before retrying.\n");
    }
    if let Ok(report) = &result {
        let body = serde_json::to_vec_pretty(report)?;
        write_private_file(&options.output_dir.join("verification.json"), &body)?;
    }
    result
}

async fn prepare_restore_inner(options: &RestoreOptions<'_>) -> anyhow::Result<RestoreReport> {
    use anyhow::{bail, Context};
    let root = options.output_dir.canonicalize()?;
    let archive = options.archive.canonicalize()?;
    let archive_digest = file_sha256(&archive)?;
    let extracted = root.join("archive");
    std::fs::create_dir(&extracted)?;
    extract_verified_archive(&archive, &extracted, options.max_unpacked_bytes)?;
    let manifest: BackupManifest =
        serde_json::from_slice(&std::fs::read(extracted.join("manifest.json"))?)?;
    if !matches!(manifest.version, 1 | 2) {
        bail!("unsupported archive manifest version {}", manifest.version);
    }
    if manifest.version == 2 && manifest.recovery.is_none() {
        bail!("version 2 archive is missing recovery metadata");
    }
    let postgres = options.engine == paracord_db::DatabaseEngine::Postgres;
    let expected_payload = if postgres {
        "paracord.pgdump"
    } else {
        "paracord.db"
    };
    if manifest.db_filename != expected_payload {
        bail!("archive database payload does not match the configured engine");
    }
    let source_db = extracted.join(expected_payload);
    if !source_db.is_file() {
        bail!("archive database payload is missing");
    }
    if let Some(recovery) = &manifest.recovery {
        if recovery.files_encrypted && options.file_cryptor.is_none() {
            bail!("archive requires its file encryption key and configuration");
        }
        if recovery.storage_type != "local" && options.external_media.is_none() {
            bail!("object-storage backup requires an explicit exported --media-dir");
        }
        if let Some(check) = &recovery.key_check {
            let cryptor = options
                .secret_cryptor
                .as_ref()
                .context("archive requires its original at-rest master key")?;
            let payload = base64::engine::general_purpose::STANDARD
                .decode(check)
                .context("invalid recovery key check")?;
            let plaintext = cryptor
                .decrypt_with_aad(&payload, RECOVERY_AAD)
                .context("recovery key does not authenticate this archive")?;
            if plaintext != RECOVERY_CANARY {
                bail!("invalid recovery key check plaintext");
            }
        }
    }
    let media_source = if let Some(path) = options.external_media {
        path.canonicalize()
            .context("external media export does not exist")?
    } else {
        if !manifest.includes_media {
            bail!("database-only archive requires --media-dir containing matching uploads/ and files/ directories");
        }
        extracted.join("media")
    };
    for name in ["uploads", "files"] {
        if !media_source.join(name).is_dir() {
            bail!("media export is missing its {name}/ directory");
        }
    }
    let media = root.join("media");
    let media_files = copy_regular_tree(&media_source, &media, options.max_unpacked_bytes)?;
    let db_url;
    let sqlite_encrypted;
    if postgres {
        db_url = options
            .postgres_target_url
            .context("PostgreSQL restore requires an isolated target URL environment variable")?
            .to_owned();
        let target =
            paracord_db::create_pool_full(&db_url, 1, Some(options.engine), None, None).await?;
        let preflight: anyhow::Result<()> = async {
            let objects: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f')")
                .fetch_one(&target).await?;
            if objects != 0 { bail!("PostgreSQL recovery target is not empty; existing data will not be replaced"); }
            let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()")
                .fetch_one(&target).await?;
            if sessions != 0 { bail!("PostgreSQL recovery target has other connections; isolate it before restoring"); }
            Ok(())
        }.await;
        target.close().await;
        preflight?;
        let target_url = db_url.clone();
        let dump = source_db.to_string_lossy().into_owned();
        tokio::task::spawn_blocking(move || pg_restore_into_empty(&target_url, &dump))
            .await?
            .map_err(anyhow::Error::msg)?;
        sqlite_encrypted = false;
    } else {
        if options.postgres_target_url.is_some() {
            bail!("PostgreSQL target was supplied for a SQLite archive");
        }
        sqlite_encrypted = !sqlite_plaintext_header(&source_db)?;
        if let Some(metadata) = &manifest.recovery {
            if metadata.sqlite_encrypted != sqlite_encrypted {
                bail!("SQLite payload does not match archive encryption metadata");
            }
        }
        if sqlite_encrypted != options.sqlite_key_hex.is_some() {
            bail!("SQLite archive encryption does not match [at_rest].encrypt_sqlite; supply the original archive configuration and key");
        }
        let staged = root.join("paracord.db");
        std::fs::copy(&source_db, &staged)?;
        db_url = recovery_sqlite_url(&staged)?;
    }
    let pool = paracord_db::create_pool_full(
        &db_url,
        1,
        Some(options.engine),
        options.sqlite_key_hex.clone(),
        None,
    )
    .await
    .context("cannot open staged database with the supplied configuration/key")?;
    let verification = async {
        if !postgres {
            verify_sqlite_integrity(&pool).await?;
        }
        // Check application tables before migrations so a random database cannot
        // be mistaken for an empty restored server, and destructive upgrades fail.
        let mut before = std::collections::BTreeMap::new();
        for table in ["users", "messages", "attachments", "read_states"] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(&pool)
                .await
                .context("archive is not a supported Paracord database")?;
            before.insert(table, count);
        }
        paracord_db::run_migrations_for_engine(&pool, options.engine)
            .await
            .context("staged database upgrade failed")?;
        if postgres {
            let unvalidated: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public' AND c.contype IN ('f', 'c') AND NOT c.convalidated")
                .fetch_one(&pool).await?;
            if unvalidated != 0 { bail!("restored PostgreSQL schema contains unvalidated integrity constraints"); }
        }
        for (table, count) in before {
            let after: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(&pool)
                .await?;
            if after != count {
                bail!("upgrade changed the number of {table} rows; recovery was not activated");
            }
        }
        let verified_attachments = verify_attachment_recovery(
            &pool,
            &media.join("uploads"),
            options.file_cryptor.as_ref(),
        )
        .await?;
        let verified_encrypted_secrets =
            verify_secret_recovery(&pool, options.secret_cryptor.as_ref()).await?;
        let mut tx = pool.begin().await?;
        let repaired_channel_tails =
            paracord_db::channels::repair_message_tails_for_import(&mut tx).await?;
        let database_history_epoch =
            paracord_db::server_settings::rotate_database_history_epoch(&mut tx).await?;
        tx.commit().await?;
        if !postgres {
            verify_sqlite_integrity(&pool).await?;
        }
        let mut table_rows = std::collections::BTreeMap::new();
        for table in paracord_db::migrate_export::MIGRATION_TABLE_ORDER {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(&pool)
                .await?;
            table_rows.insert((*table).to_owned(), count);
        }
        if !postgres {
            sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
                .execute(&pool)
                .await?;
        }
        Ok(RestoreReport {
            database_engine: options.engine.as_str().into(),
            database_history_epoch,
            repaired_channel_tails,
            verified_attachments,
            verified_encrypted_secrets,
            media_files,
            table_rows,
            source_archive_sha256: archive_digest,
            sqlite_encrypted,
        })
    }
    .await;
    pool.close().await;
    verification
}

async fn verify_sqlite_integrity(pool: &paracord_db::DbPool) -> anyhow::Result<()> {
    let rows: Vec<(String,)> = sqlx::query_as("PRAGMA integrity_check")
        .fetch_all(pool)
        .await?;
    anyhow::ensure!(
        rows == vec![("ok".into(),)],
        "SQLite integrity check failed"
    );
    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(pool)
        .await?;
    anyhow::ensure!(violations.is_empty(), "SQLite foreign key check failed");
    Ok(())
}

async fn verify_attachment_recovery(
    pool: &paracord_db::DbPool,
    uploads: &Path,
    cryptor: Option<&FileCryptor>,
) -> anyhow::Result<u64> {
    use anyhow::{bail, Context};
    let rows: Vec<(i64, String, i64, Option<String>)> = sqlx::query_as(
        "SELECT id, filename, CAST(size AS BIGINT), content_hash FROM attachments ORDER BY id",
    )
    .fetch_all(pool)
    .await?;
    for (id, filename, size, hash) in &rows {
        let extension = Path::new(filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin");
        let relative = format!("attachments/{id}.{extension}");
        safe_relative_path(Path::new(&relative))?;
        let path = uploads.join(relative);
        let metadata = std::fs::metadata(&path)
            .with_context(|| format!("attachment {id} is missing from media export"))?;
        if !metadata.is_file() || metadata.len() > 1024 * 1024 * 1024 {
            bail!("attachment {id} is not a supported regular file (maximum verification size is 1 GiB)");
        }
        let payload = std::fs::read(&path)?;
        // Runtime reads migrate legacy plaintext even when plaintext fallback
        // is disabled. Do that only in copied staging media, after validating
        // the plaintext size/hash, so activation never depends on an unchecked
        // legacy file or modifies the retained source media.
        let legacy_cryptor = cryptor.filter(|cryptor| {
            !cryptor.allow_plaintext_reads() && !FileCryptor::payload_is_encrypted(&payload)
        });
        let plaintext = if legacy_cryptor.is_some() {
            payload
        } else if let Some(cryptor) = cryptor {
            cryptor
                .decrypt_with_aad(&payload, format!("attachment:{id}").as_bytes())
                .with_context(|| format!("attachment {id} failed authenticated decryption"))?
        } else if FileCryptor::payload_is_encrypted(&payload) {
            bail!("encrypted attachments require the original at-rest key and file encryption configuration");
        } else {
            payload
        };
        if *size < 0 || plaintext.len() as i64 != *size {
            bail!("attachment {id} size does not match its database record");
        }
        if let Some(expected) = hash.as_deref().filter(|value| !value.is_empty()) {
            if format!("{:x}", Sha256::digest(&plaintext)) != expected {
                bail!("attachment {id} content hash does not match its database record");
            }
        }
        if let Some(cryptor) = legacy_cryptor {
            let encrypted =
                cryptor.encrypt_with_aad(&plaintext, format!("attachment:{id}").as_bytes())?;
            std::fs::write(&path, encrypted)
                .with_context(|| format!("cannot encrypt staged attachment {id}"))?;
        }
    }
    Ok(rows.len() as u64)
}

async fn verify_secret_recovery(
    pool: &paracord_db::DbPool,
    cryptor: Option<&FileCryptor>,
) -> anyhow::Result<u64> {
    use anyhow::Context;
    let totp: Vec<(String,)> = sqlx::query_as("SELECT totp_secret FROM mfa_configs")
        .fetch_all(pool)
        .await?;
    let github: Vec<(String,)> =
        sqlx::query_as("SELECT github_secret FROM webhooks WHERE github_secret IS NOT NULL")
            .fetch_all(pool)
            .await?;
    let mut verified = 0;
    let decoded = totp
        .into_iter()
        .filter_map(|(value,)| base64::engine::general_purpose::STANDARD.decode(value).ok())
        .chain(
            github
                .into_iter()
                .filter_map(|(value,)| decode_hex_bytes(&value)),
        );
    for payload in decoded {
        if !FileCryptor::payload_is_encrypted(&payload) {
            continue;
        }
        let plaintext = cryptor
            .context("encrypted MFA/webhook secrets require the original at-rest master key")?
            .decrypt(&payload)
            .context("restored secret failed authenticated decryption")?;
        std::str::from_utf8(&plaintext).context("restored secret is not valid UTF-8")?;
        verified += 1;
    }
    Ok(verified)
}

fn decode_hex_bytes(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0 || !value.is_ascii() {
        return None;
    }
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).ok())
        .collect()
}

fn sqlite_plaintext_header(path: &Path) -> anyhow::Result<bool> {
    use std::io::Read;
    let mut header = [0; 16];
    std::fs::File::open(path)?.read_exact(&mut header)?;
    Ok(&header == b"SQLite format 3\0")
}

fn file_sha256(path: &Path) -> anyhow::Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Build a URL for an existing staged SQLite file without interpreting path
/// bytes as query options or percent escapes. Missing files must fail to open,
/// including during activation; recovery must never generate an empty database.
pub fn recovery_sqlite_url(path: &Path) -> anyhow::Result<String> {
    use anyhow::Context;
    anyhow::ensure!(
        path.is_absolute(),
        "recovery database path must be absolute"
    );
    let text = path
        .to_str()
        .context("recovery database path is not valid UTF-8")?;
    #[cfg(windows)]
    let text = {
        // canonicalize() yields verbatim Windows paths. Normalize their device
        // prefix before URL encoding; UNC paths retain their leading slashes.
        let text = text.strip_prefix(r"\\?\").unwrap_or(text);
        if let Some(unc) = text.strip_prefix(r"UNC\") {
            format!("//{}", unc.replace('\\', "/"))
        } else {
            text.replace('\\', "/")
        }
    };
    let mut encoded = String::new();
    for byte in text.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'/' | b':' | b'-' | b'.' | b'_' | b'~')
        {
            encoded.push(*byte as char);
        } else {
            use std::fmt::Write;
            write!(encoded, "%{byte:02X}")?;
        }
    }
    Ok(format!("sqlite://{encoded}?mode=rw"))
}

pub fn write_private_file(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    // NamedTempFile is private (0600 on Unix). Publish only complete, synced
    // bytes, without replacing an existing destination. In particular, a failed
    // config write must never leave a partial file that looks ready to activate.
    let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap_or(Path::new(".")))?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist_noclobber(path)?;
    Ok(())
}

fn safe_relative_path(path: &Path) -> anyhow::Result<()> {
    anyhow::ensure!(
        !path.as_os_str().is_empty()
            && path
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_))),
        "archive/media path is not a safe relative path"
    );
    Ok(())
}

fn extract_verified_archive(
    archive_path: &Path,
    destination: &Path,
    limit: u64,
) -> anyhow::Result<()> {
    use anyhow::{bail, Context};
    use std::io::Read;
    if limit < 1024 {
        bail!("archive exceeds the configured unpacked byte limit");
    }
    // Bound actual decompression, including headers and trailing members, so
    // metadata or padding cannot bypass the sum of declared entry sizes.
    let decoder = flate2::read::MultiGzDecoder::new(std::fs::File::open(archive_path)?);
    let mut archive = tar::Archive::new(decoder.take(limit.saturating_add(1)));
    let mut seen = std::collections::BTreeSet::new();
    let mut total = 0u64;
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        safe_relative_path(&path)?;
        let allowed = matches!(
            path.to_str(),
            Some("manifest.json" | "paracord.db" | "paracord.pgdump")
        ) || path.starts_with("media");
        if !allowed {
            bail!("unexpected archive entry: {}", path.display());
        }
        if !seen.insert(path.clone()) {
            bail!("duplicate archive entry: {}", path.display());
        }
        if path == Path::new("manifest.json") && entry.size() > 1024 * 1024 {
            bail!("archive manifest exceeds the 1 MiB limit");
        }
        total = total
            .checked_add(entry.size())
            .context("archive size overflow")?;
        if total > limit {
            bail!("archive exceeds the configured unpacked byte limit");
        }
        if !(entry.header().entry_type().is_file() || entry.header().entry_type().is_dir()) {
            bail!("archive links and special files are unsupported");
        }
        if !entry.unpack_in(destination)? {
            bail!("archive entry escaped recovery directory");
        }
    }
    // tar EOF precedes the gzip trailer. Read through it to reject truncated or
    // corrupted compression streams before accepting the extracted database.
    let mut stream = archive.into_inner();
    std::io::copy(&mut stream, &mut std::io::sink())
        .context("archive compression stream is incomplete or corrupt")?;
    if stream.limit() == 0 {
        bail!("archive exceeds the configured unpacked byte limit");
    }
    Ok(())
}

fn copy_regular_tree(source: &Path, destination: &Path, limit: u64) -> anyhow::Result<u64> {
    use anyhow::Context;
    // Resolve aliases on both existing sides before creating the destination.
    // Copying a media export into one of its descendants would consume its own
    // staging files and can recurse indefinitely even when file bytes are capped.
    let resolved_source = source.canonicalize()?;
    let resolved_destination = destination
        .parent()
        .context("media destination has no parent")?
        .canonicalize()?
        .join(
            destination
                .file_name()
                .context("media destination has no name")?,
        );
    anyhow::ensure!(
        !resolved_destination.starts_with(&resolved_source),
        "recovery media destination must be outside the source media export"
    );
    fn copy(
        source: &Path,
        destination: &Path,
        remaining: &mut u64,
        count: &mut u64,
    ) -> anyhow::Result<()> {
        let metadata = std::fs::symlink_metadata(source)?;
        anyhow::ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "media directories cannot be symlinks"
        );
        std::fs::create_dir(destination)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            let target = destination.join(entry.file_name());
            let metadata = entry.file_type()?;
            if metadata.is_dir() {
                copy(&entry.path(), &target, remaining, count)?;
            } else if metadata.is_file() {
                let len = entry.metadata()?.len();
                *remaining = remaining.checked_sub(len).ok_or_else(|| {
                    anyhow::anyhow!("media export exceeds the configured byte limit")
                })?;
                std::fs::copy(entry.path(), target)?;
                *count += 1;
            } else {
                anyhow::bail!("media export contains a symlink or special file");
            }
        }
        Ok(())
    }
    let mut remaining = limit;
    let mut count = 0;
    copy(source, destination, &mut remaining, &mut count)?;
    Ok(count)
}

fn pg_restore_into_empty(db_url: &str, dump_path: &str) -> Result<(), String> {
    let (mut command, sanitized_url) = pg_command("pg_restore", db_url);
    let result = command
        .args([
            "--no-owner",
            "--no-privileges",
            "--single-transaction",
            "--exit-on-error",
            "--dbname",
            &sanitized_url,
            dump_path,
        ])
        .output()
        .map_err(|e| format!("Failed to run pg_restore: {e}"))?;
    if !result.status.success() {
        return Err(format!(
            "pg_restore failed: {}",
            String::from_utf8_lossy(&result.stderr)
        ));
    }
    Ok(())
}

/// Return the full file path for a given backup name.
pub fn backup_file_path(backup_dir: &str, name: &str) -> PathBuf {
    Path::new(backup_dir).join(name)
}

// ── Internal helpers ──────────────────────────────────────────────────────

fn is_postgres_url(url: &str) -> bool {
    let normalized = url.trim().to_ascii_lowercase();
    normalized.starts_with("postgres://") || normalized.starts_with("postgresql://")
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

fn build_tar_gz(
    archive_path: &Path,
    db_snapshot: &Path,
    manifest: &BackupManifest,
    include_media: bool,
    storage_path: &str,
    media_storage_path: &str,
) -> Result<(), String> {
    if include_media {
        for path in [storage_path, media_storage_path] {
            if !Path::new(path).is_dir() {
                return Err(format!("Media directory is missing: {path}"));
            }
            ensure_regular_tree(Path::new(path)).map_err(|e| e.to_string())?;
        }
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(archive_path.parent().unwrap_or(Path::new(".")))
            .map_err(|e| format!("Failed to stage archive: {e}"))?;
    let encoder =
        flate2::write::GzEncoder::new(temporary.as_file_mut(), flate2::Compression::default());
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

    let encoder = tar
        .into_inner()
        .map_err(|e| format!("Failed to finalize tar: {e}"))?;
    encoder
        .finish()
        .map_err(|e| format!("Failed to finalize gzip: {e}"))?
        .sync_all()
        .map_err(|e| format!("Failed to sync archive: {e}"))?;
    temporary
        .persist_noclobber(archive_path)
        .map_err(|e| format!("Failed to publish archive: {e}"))?;
    Ok(())
}

fn ensure_regular_tree(path: &Path) -> anyhow::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path)? {
            ensure_regular_tree(&entry?.path())?;
        }
    } else {
        anyhow::ensure!(
            metadata.is_file(),
            "backup media contains a link or special file"
        );
    }
    Ok(())
}

fn parse_backup_timestamp(name: &str) -> Option<String> {
    // Expected format: paracord_backup_YYYYMMDD_HHMMSS.tar.gz
    let stem = name.strip_suffix(".tar.gz")?;
    let ts = stem.strip_prefix("paracord_backup_")?;
    let parts: Vec<&str> = ts.split('_').collect();
    if parts.len() < 2 {
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

    type TestResult = anyhow::Result<()>;

    async fn fixture(
        temp: &Path,
        encrypted_files: bool,
    ) -> anyhow::Result<(
        paracord_db::DbPool,
        String,
        PathBuf,
        PathBuf,
        Option<FileCryptor>,
        Option<FileCryptor>,
    )> {
        let uploads = temp.join("uploads");
        let media = temp.join("files");
        std::fs::create_dir_all(uploads.join("attachments"))?;
        std::fs::create_dir_all(&media)?;
        let url = format!("sqlite://{}?mode=rwc", temp.join("live.db").display());
        let pool = paracord_db::create_pool_full(
            &url,
            1,
            Some(paracord_db::DatabaseEngine::Sqlite),
            None,
            None,
        )
        .await?;
        paracord_db::run_migrations_for_engine(&pool, paracord_db::DatabaseEngine::Sqlite).await?;
        sqlx::query("INSERT INTO users(id, username, discriminator, email, password_hash) VALUES(1, 'owner', 1, 'owner@example.test', 'hash')").execute(&pool).await?;
        sqlx::query("INSERT INTO channels(id, channel_type, last_message_id, message_revision) VALUES(10, 1, 99, 8), (11, 1, 98, 9)").execute(&pool).await?;
        sqlx::query("INSERT INTO messages(id, channel_id, author_id, content) VALUES(20, 10, 1, 'archived')").execute(&pool).await?;
        sqlx::query("INSERT INTO read_states(user_id, channel_id, last_message_id, mention_count) VALUES(1, 10, 19, 3)").execute(&pool).await?;
        let file_cryptor = encrypted_files.then(|| FileCryptor::from_master_key(&[7; 32], false));
        let secret_cryptor = encrypted_files
            .then(|| FileCryptor::from_master_key_with_context(&[7; 32], b"totp", true));
        let plaintext = b"recovered attachment";
        let payload = if let Some(c) = &file_cryptor {
            c.encrypt_with_aad(plaintext, b"attachment:30")?
        } else {
            plaintext.to_vec()
        };
        std::fs::write(uploads.join("attachments/30.bin"), payload)?;
        sqlx::query("INSERT INTO attachments(id, message_id, filename, size, url, content_hash) VALUES(30, 20, 'file.bin', $1, '/api/v1/attachments/30', $2)")
            .bind(plaintext.len() as i64).bind(format!("{:x}", Sha256::digest(plaintext))).execute(&pool).await?;
        if let Some(c) = &secret_cryptor {
            let secret =
                base64::engine::general_purpose::STANDARD.encode(c.encrypt(b"JBSWY3DPEHPK3PXP")?);
            sqlx::query(
                "INSERT INTO mfa_configs(user_id, totp_secret, enabled) VALUES(1, $1, TRUE)",
            )
            .bind(secret)
            .execute(&pool)
            .await?;
        }
        Ok((pool, url, uploads, media, file_cryptor, secret_cryptor))
    }

    fn restore_options<'a>(
        archive: &'a Path,
        output: &'a Path,
        file: Option<FileCryptor>,
        secret: Option<FileCryptor>,
    ) -> RestoreOptions<'a> {
        RestoreOptions {
            archive,
            output_dir: output,
            engine: paracord_db::DatabaseEngine::Sqlite,
            postgres_target_url: None,
            external_media: None,
            sqlite_key_hex: None,
            file_cryptor: file,
            secret_cryptor: secret,
            max_unpacked_bytes: 64 * 1024 * 1024,
        }
    }

    #[tokio::test]
    async fn sqlite_recovery_verifies_encrypted_media_and_preserves_live_source() -> TestResult {
        let temp = tempfile::tempdir()?;
        let (pool, url, uploads, media, file, secret) = fixture(temp.path(), true).await?;
        let old_epoch =
            paracord_db::server_settings::get_or_create_database_history_epoch(&pool).await?;
        let backups = temp.path().join("backups");
        let name = create_backup_from_pool(
            &pool,
            &url,
            backups.to_str().unwrap(),
            uploads.to_str().unwrap(),
            media.to_str().unwrap(),
            true,
            true,
            file.as_ref(),
            secret.as_ref(),
        )
        .await?;
        sqlx::query("UPDATE messages SET content = 'live after archive' WHERE id = 20")
            .execute(&pool)
            .await?;
        // A literal URI escape in a directory name must not retarget SQLx to
        // another directory while verifying or activating the recovered file.
        let output = temp.path().join("recovery%2Foutside");
        let report =
            prepare_restore(restore_options(&backups.join(name), &output, file, secret)).await?;
        assert_eq!(report.repaired_channel_tails, 2);
        assert_eq!(report.verified_attachments, 1);
        assert_eq!(report.verified_encrypted_secrets, 1);
        assert_ne!(report.database_history_epoch, old_epoch);
        let live: String = sqlx::query_scalar("SELECT content FROM messages WHERE id = 20")
            .fetch_one(&pool)
            .await?;
        assert_eq!(live, "live after archive");
        assert_eq!(
            paracord_db::server_settings::get_database_history_epoch(&pool).await?,
            Some(old_epoch)
        );
        let staged = paracord_db::create_pool_full(
            &recovery_sqlite_url(&output.join("paracord.db"))?,
            1,
            Some(paracord_db::DatabaseEngine::Sqlite),
            None,
            None,
        )
        .await?;
        let channels: Vec<(i64, Option<i64>, i64)> = sqlx::query_as(
            "SELECT id, last_message_id, message_revision FROM channels ORDER BY id",
        )
        .fetch_all(&staged)
        .await?;
        assert_eq!(channels, vec![(10, Some(20), 8), (11, None, 9)]);
        let read: (i64, i64) = sqlx::query_as(
            "SELECT last_message_id, CAST(mention_count AS BIGINT) FROM read_states",
        )
        .fetch_one(&staged)
        .await?;
        assert_eq!(read, (19, 3));
        assert!(output.join("verification.json").is_file());
        assert!(!output.join("RESTORE_FAILED.txt").exists());
        staged.close().await;
        pool.close().await;
        Ok(())
    }

    #[tokio::test]
    async fn recovery_rejects_wrong_keys_missing_media_and_existing_destination() -> TestResult {
        let temp = tempfile::tempdir()?;
        let (pool, url, uploads, media, file, secret) = fixture(temp.path(), true).await?;
        let backups = temp.path().join("backups");
        let name = create_backup_from_pool(
            &pool,
            &url,
            backups.to_str().unwrap(),
            uploads.to_str().unwrap(),
            media.to_str().unwrap(),
            true,
            true,
            file.as_ref(),
            secret.as_ref(),
        )
        .await?;
        let archive = backups.join(name);
        let output = temp.path().join("wrong-key");
        let wrong = FileCryptor::from_master_key_with_context(&[8; 32], b"totp", true);
        assert!(prepare_restore(restore_options(
            &archive,
            &output,
            file.clone(),
            Some(wrong)
        ))
        .await
        .is_err());
        assert!(output.join("RESTORE_FAILED.txt").is_file());
        assert!(!output.join("verification.json").exists());
        assert!(prepare_restore(restore_options(
            &archive,
            &output,
            file.clone(),
            secret.clone()
        ))
        .await
        .is_err());
        std::fs::remove_file(uploads.join("attachments/30.bin"))?;
        let name = create_backup_from_pool(
            &pool,
            &url,
            backups.to_str().unwrap(),
            uploads.to_str().unwrap(),
            media.to_str().unwrap(),
            true,
            true,
            file.as_ref(),
            secret.as_ref(),
        )
        .await?;
        let missing = temp.path().join("missing-file");
        assert!(
            prepare_restore(restore_options(&backups.join(name), &missing, file, secret))
                .await
                .is_err()
        );
        assert!(!missing.join("verification.json").exists());
        pool.close().await;
        Ok(())
    }

    #[tokio::test]
    async fn recovery_migrates_verified_plaintext_only_in_staged_media() -> TestResult {
        let temp = tempfile::tempdir()?;
        let (pool, url, uploads, media, _, _) = fixture(temp.path(), false).await?;
        let original = std::fs::read(uploads.join("attachments/30.bin"))?;
        let backups = temp.path().join("backups");
        let name = create_backup_from_pool(
            &pool,
            &url,
            backups.to_str().unwrap(),
            uploads.to_str().unwrap(),
            media.to_str().unwrap(),
            true,
            true,
            None,
            None,
        )
        .await?;
        let archive = backups.join(name);
        let before = file_sha256(&archive)?;
        let strict = FileCryptor::from_master_key(&[7; 32], false);
        let output = temp.path().join("recovery");
        let report = prepare_restore(restore_options(
            &archive,
            &output,
            Some(strict.clone()),
            None,
        ))
        .await?;
        assert_eq!(report.verified_attachments, 1);
        let staged = std::fs::read(output.join("media/uploads/attachments/30.bin"))?;
        assert!(FileCryptor::payload_is_encrypted(&staged));
        assert_eq!(
            strict.decrypt_with_aad(&staged, b"attachment:30")?,
            original
        );
        assert_eq!(std::fs::read(uploads.join("attachments/30.bin"))?, original);
        assert_eq!(file_sha256(&archive)?, before);

        // Corrupt bytes must fail the stored plaintext hash before conversion.
        let invalid = temp.path().join("invalid-uploads");
        copy_regular_tree(&uploads, &invalid, 4096)?;
        let invalid_path = invalid.join("attachments/30.bin");
        let corrupt = vec![b'x'; original.len()];
        std::fs::write(&invalid_path, &corrupt)?;
        assert!(verify_attachment_recovery(&pool, &invalid, Some(&strict))
            .await
            .is_err());
        assert_eq!(std::fs::read(&invalid_path)?, corrupt);
        pool.close().await;
        Ok(())
    }

    #[tokio::test]
    async fn live_restore_entry_points_refuse_database_replacement() -> TestResult {
        let temp = tempfile::tempdir()?;
        let database = temp.path().join("live.db");
        std::fs::write(&database, b"unchanged")?;
        assert!(restore_backup(
            "anything.tar.gz",
            temp.path().to_str().unwrap(),
            database.to_str().unwrap(),
            "uploads",
            "files"
        )
        .await
        .is_err());
        assert_eq!(std::fs::read(database)?, b"unchanged");
        Ok(())
    }

    #[test]
    fn archive_validation_rejects_links_and_unbounded_extraction() -> TestResult {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("link.tar.gz");
        let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
            std::fs::File::create(&path)?,
            flate2::Compression::default(),
        ));
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        header.set_link_name("/tmp/outside")?;
        header.set_cksum();
        tar.append_data(&mut header, "media/uploads/link", &[][..])?;
        tar.into_inner()?.finish()?;
        let output = temp.path().join("out");
        std::fs::create_dir(&output)?;
        assert!(extract_verified_archive(&path, &output, 1024).is_err());
        assert!(safe_relative_path(Path::new("../outside")).is_err());
        assert!(safe_relative_path(Path::new("/outside")).is_err());
        Ok(())
    }

    #[test]
    fn media_copy_rejects_descendant_destinations_and_canonical_aliases() -> TestResult {
        let temp = tempfile::tempdir()?;
        let source = temp.path().join("source");
        std::fs::create_dir(&source)?;
        std::fs::write(source.join("payload"), b"retained")?;
        let child = source.join("recovery");
        assert!(copy_regular_tree(&source, &child, 4096).is_err());
        assert!(!child.exists());
        #[cfg(unix)]
        {
            let alias = temp.path().join("source-alias");
            std::os::unix::fs::symlink(&source, &alias)?;
            assert!(copy_regular_tree(&alias, &child, 4096).is_err());
            assert!(copy_regular_tree(&source, &alias.join("recovery"), 4096).is_err());
            assert!(!child.exists());
        }
        let valid = temp.path().join("separate");
        assert_eq!(copy_regular_tree(&source, &valid, 4096)?, 1);
        assert_eq!(std::fs::read(valid.join("payload"))?, b"retained");
        assert_eq!(std::fs::read(source.join("payload"))?, b"retained");
        Ok(())
    }

    #[test]
    fn archive_validation_checks_compression_trailer_and_stream_limit() -> TestResult {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("archive.tar.gz");
        let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
            std::fs::File::create(&path)?,
            flate2::Compression::default(),
        ));
        let mut header = tar::Header::new_gnu();
        header.set_size(2);
        header.set_mode(0o600);
        header.set_cksum();
        tar.append_data(&mut header, "manifest.json", &b"{}"[..])?;
        tar.into_inner()?.finish()?;
        let output = temp.path().join("output");
        std::fs::create_dir(&output)?;
        extract_verified_archive(&path, &output, 4096)?;
        let limited = temp.path().join("limited");
        std::fs::create_dir(&limited)?;
        assert!(extract_verified_archive(&path, &limited, 64).is_err());
        let mut corrupt = std::fs::read(&path)?;
        let trailer = corrupt.len() - 8;
        corrupt[trailer] ^= 1;
        std::fs::write(&path, corrupt)?;
        let rejected = temp.path().join("rejected");
        std::fs::create_dir(&rejected)?;
        assert!(extract_verified_archive(&path, &rejected, 4096).is_err());
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
