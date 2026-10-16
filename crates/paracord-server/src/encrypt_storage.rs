//! `paracord-server encrypt-storage`: turn an existing plaintext server into
//! an encrypted one (docs/setup-spec.md §4.8).
//!
//! backup → generate and store the key → `sqlcipher_export` into a new file →
//! `PRAGMA cipher_integrity_check` and every table's row count compared →
//! atomic swap (the plaintext database is deleted) → files encrypted in place
//! to `PRCENC02` (temp + rename) → config updated.
//!
//! Progress is kept in `.encrypt-storage.journal` beside the database. The
//! journal never holds the key, only where it was stored, so a rerun after an
//! interruption reads the same key back and continues from the step it reached.

use crate::at_rest_boot::{
    self, describe_source, key_from_env, store_key, KeyPlacement, KeyRecord,
};
use crate::cli::EncryptStorageArgs;
use crate::config::{self, Config};
use anyhow::{bail, ensure, Context, Result};
use paracord_contracts::host::{KeySource, Protection};
use paracord_util::at_rest::{derive_sqlite_key_hex, generate_master_key, FileCryptor};
use serde::{Deserialize, Serialize};
use sqlx::{Connection, Row};
use std::path::{Path, PathBuf};

const JOURNAL_NAME: &str = ".encrypt-storage.journal";

/// Debug builds only: stop after a named step, so tests can prove a rerun
/// resumes (`key`, `database`, or `files:<n>` after n files).
const STOP_AFTER_ENV: &str = "PARACORD_ENCRYPT_STORAGE_STOP_AFTER";

#[derive(Debug, Default, Serialize, Deserialize)]
struct Journal {
    version: u32,
    /// The archive taken before anything changed.
    backup: Option<String>,
    key: Option<JournalKey>,
    database_done: bool,
    files_done: bool,
}

/// Where the key went. Never the key.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct JournalKey {
    source: KeySource,
    key_file: Option<String>,
    keychain_service: Option<String>,
    keychain_account: Option<String>,
    key_env: Option<String>,
    protection: Protection,
    instance_id: String,
}

impl JournalKey {
    fn placement(&self) -> Result<KeyPlacement> {
        let need = |v: &Option<String>, what: &str| {
            v.clone()
                .with_context(|| format!("the journal does not say which {what} holds the key"))
        };
        Ok(match self.source {
            KeySource::Keychain => KeyPlacement::Keychain {
                service: need(&self.keychain_service, "keychain service")?,
                account: need(&self.keychain_account, "keychain account")?,
            },
            KeySource::File => KeyPlacement::File {
                path: PathBuf::from(need(&self.key_file, "key file")?),
            },
            KeySource::SystemdCreds => KeyPlacement::SystemdCreds {
                path: PathBuf::from(need(&self.key_file, "credential file")?),
            },
            KeySource::Env => KeyPlacement::Env {
                name: need(&self.key_env, "environment variable")?,
            },
        })
    }

    fn from_placement(
        placement: &KeyPlacement,
        protection: Protection,
        instance_id: String,
    ) -> Self {
        let mut key = JournalKey {
            source: placement.source(),
            key_file: None,
            keychain_service: None,
            keychain_account: None,
            key_env: None,
            protection,
            instance_id,
        };
        match placement {
            KeyPlacement::Keychain { service, account } => {
                key.keychain_service = Some(service.clone());
                key.keychain_account = Some(account.clone());
            }
            KeyPlacement::File { path } | KeyPlacement::SystemdCreds { path } => {
                key.key_file = Some(path.to_string_lossy().into_owned())
            }
            KeyPlacement::Env { name } => key.key_env = Some(name.clone()),
        }
        key
    }

    /// An `[at_rest]` that reads the key back through the normal resolver.
    fn at_rest(&self, base: &config::AtRestConfig) -> config::AtRestConfig {
        let mut at_rest = base.clone();
        at_rest.enabled = true;
        at_rest.key_source = self.source;
        if let Some(file) = &self.key_file {
            at_rest.key_file = Some(file.clone());
        }
        if let Some(service) = &self.keychain_service {
            at_rest.keychain_service = service.clone();
        }
        if let Some(account) = &self.keychain_account {
            at_rest.keychain_account = Some(account.clone());
        }
        if let Some(env) = &self.key_env {
            at_rest.key_env = env.clone();
        }
        at_rest
    }
}

impl Journal {
    fn load(path: &Path) -> Result<Option<Self>> {
        match std::fs::read(path) {
            Ok(bytes) => {
                let journal: Journal = serde_json::from_slice(&bytes)
                    .with_context(|| format!("{} is not a valid journal", path.display()))?;
                ensure!(
                    journal.version == 1,
                    "unsupported journal version {}",
                    journal.version
                );
                Ok(Some(journal))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e).with_context(|| format!("cannot read {}", path.display())),
        }
    }

    fn save(&self, path: &Path) -> Result<()> {
        let tmp = sibling(path, ".saving");
        let _ = std::fs::remove_file(&tmp);
        at_rest_boot::write_new_private_file(&tmp, &serde_json::to_vec_pretty(self)?)
            .with_context(|| format!("cannot write {}", tmp.display()))?;
        std::fs::rename(&tmp, path).with_context(|| format!("cannot write {}", path.display()))
    }
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn stop_point(step: &str) -> Result<()> {
    if cfg!(debug_assertions) && std::env::var(STOP_AFTER_ENV).as_deref() == Ok(step) {
        bail!("stopped after {step} ({STOP_AFTER_ENV})");
    }
    Ok(())
}

pub async fn run(args: &EncryptStorageArgs, config_path: &str) -> Result<()> {
    let config_file = Path::new(config_path);
    ensure!(
        config_file.is_file(),
        "no config at {config_path}; encrypt-storage converts an existing server (pass -c <config>)"
    );
    let mut config = Config::load(config_path)?;
    let sqlite = matches!(config.database.engine, config::DatabaseEngine::Sqlite);
    ensure!(
        config.storage.storage_type.is_empty() || config.storage.storage_type == "local",
        "encrypt-storage encrypts files on this computer's disk; this server keeps them in {} storage",
        config.storage.storage_type
    );
    refuse_if_running(&config)?;

    let data_dir = if sqlite {
        sqlite_file(&config.database.url)
            .await?
            .parent()
            .map(Path::to_path_buf)
            .context("the database file has no directory")?
    } else {
        std::path::absolute(&config.storage.path)?
            .parent()
            .map(Path::to_path_buf)
            .context("the storage path has no parent directory")?
    };
    let journal_path = data_dir.join(JOURNAL_NAME);
    let mut journal = match Journal::load(&journal_path)? {
        Some(journal) => {
            println!(
                "Resuming an interrupted encrypt-storage run ({}).",
                journal_path.display()
            );
            journal
        }
        None => {
            if config.at_rest.enabled {
                bail!(
                    "stored-data encryption is already on for this server (key: {}); there is nothing to convert",
                    describe_source(&config.at_rest)
                );
            }
            Journal {
                version: 1,
                ..Journal::default()
            }
        }
    };
    let config_dir = std::path::absolute(
        config_file
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?;

    // The directories a server makes on its first start (uploads, media,
    // backups): a server that was installed but never started has none of
    // them, and the backup reads them.
    crate::ensure_data_dirs(&config);

    // 1. Backup, before anything changes.
    if journal.backup.is_none() {
        let name = paracord_core::backup::create_backup_with_sqlite_key(
            &config.database.url,
            &config.backup.backup_dir,
            &config.storage.path,
            &config.media.storage_path,
            true,
            None,
        )
        .await
        .map_err(|e| anyhow::anyhow!("the backup before encrypting failed: {e}"))?;
        println!(
            "Backup taken: {}",
            Path::new(&config.backup.backup_dir).join(&name).display()
        );
        journal.backup = Some(name);
        journal.save(&journal_path)?;
    }

    // 2. The key: generated and stored once; read back on every rerun.
    let key = match journal.key.clone() {
        Some(recorded) => at_rest_boot::resolve_key(&recorded.at_rest(&config.at_rest))
            .map_err(|e| anyhow::anyhow!("{e} (the key this run stored earlier)"))?,
        None => {
            let source: KeySource = args.key_source.into();
            let instance_id = config
                .host
                .instance_id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let placement = match source {
                KeySource::Keychain => KeyPlacement::Keychain {
                    service: config.at_rest.keychain_service.clone(),
                    account: format!("host-storage-key:{instance_id}"),
                },
                KeySource::File => KeyPlacement::File {
                    path: match &args.key_file {
                        Some(path) => std::path::absolute(path)?,
                        None => config_dir.join("at-rest.key"),
                    },
                },
                KeySource::SystemdCreds => KeyPlacement::SystemdCreds {
                    path: std::path::absolute(args.key_file.as_ref().context(
                        "--key-source systemd-creds needs --key-file <where to write the encrypted credential>",
                    )?)?,
                },
                KeySource::Env => KeyPlacement::Env {
                    name: config.at_rest.key_env.trim().to_string(),
                },
            };
            if source != KeySource::File
                && source != KeySource::SystemdCreds
                && args.key_file.is_some()
            {
                bail!("--key-file belongs to --key-source file or systemd-creds");
            }
            let key = match &placement {
                KeyPlacement::Env { name } => key_from_env(name)?,
                _ => generate_master_key(),
            };
            let protection = store_key(&placement, &key)?;
            journal.key = Some(JournalKey::from_placement(
                &placement,
                protection,
                instance_id,
            ));
            journal.save(&journal_path)?;
            key
        }
    };
    let recorded = journal.key.clone().context("journal key")?;
    let at_rest = recorded.at_rest(&config.at_rest);
    println!(
        "Storage key: {} ({}).",
        describe_source(&at_rest),
        recorded.protection.as_str()
    );
    stop_point("key")?;

    // 3. The database.
    let sqlite_key_hex = derive_sqlite_key_hex(&key);
    let mut table_report = None;
    if sqlite && !journal.database_done {
        let db_path = sqlite_file(&config.database.url).await?;
        table_report = Some(encrypt_sqlite_file(&db_path, &sqlite_key_hex).await?);
        journal.database_done = true;
        journal.save(&journal_path)?;
    }
    stop_point("database")?;

    // 4. Files.
    let cryptor = FileCryptor::from_master_key(&key, false);
    let mut file_report = FileReport::default();
    if !journal.files_done {
        let pool = paracord_db::create_pool_with_sqlite_key(
            &config.database.url,
            1,
            sqlite.then(|| sqlite_key_hex.clone()),
        )
        .await
        .context("cannot open the database to list attachments")?;
        let result = encrypt_files(&pool, Path::new(&config.storage.path), &cryptor).await;
        pool.close().await;
        file_report = result?;
        journal.files_done = true;
        journal.save(&journal_path)?;
    }

    // 5. The config, last: until here the server still starts as before
    // (and refuses an encrypted database it has no key for).
    let record = KeyRecord {
        placement: recorded.placement()?,
        protection: recorded.protection,
        encrypt_sqlite: sqlite,
        encrypt_files: true,
        instance_id: recorded.instance_id.clone(),
        escrow_file: config
            .host
            .escrow_file
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| config_dir.join("storage-key.escrow")),
    };
    at_rest_boot::record_in_config(config_file, &mut config, &record)?;
    std::fs::remove_file(&journal_path)
        .with_context(|| format!("cannot remove {}", journal_path.display()))?;

    println!();
    println!("Stored data is now encrypted.");
    if let Some((tables, rows)) = table_report {
        println!("  Database: {tables} tables and {rows} rows copied and checked; the unencrypted file was deleted.");
        println!(
            "  (An SSD can keep old blocks of a deleted file for a while; see docs/encryption.md.)"
        );
    }
    println!(
        "  Files: {} encrypted now, {} were already encrypted, {} listed in the database but not on disk.",
        file_report.encrypted, file_report.already, file_report.missing
    );
    println!(
        "  Key: {} ({}).",
        describe_source(&config.at_rest),
        recorded.protection.as_str()
    );
    if let Some(backup) = &journal.backup {
        println!(
            "  The backup taken before this change is not encrypted: {}. Delete it once a new backup exists.",
            Path::new(&config.backup.backup_dir).join(backup).display()
        );
    }
    println!();
    println!("Next: start the server, sign in as the owner and escrow the key under your recovery phrase");
    println!(
        "(POST /api/v1/admin/storage-key/escrow), so a backup can be restored on another computer."
    );
    Ok(())
}

/// Refuse while anything answers on the server's ports on this computer.
fn refuse_if_running(config: &Config) -> Result<()> {
    let bind_port = config
        .server
        .bind_address
        .rsplit(':')
        .next()
        .and_then(|p| p.parse::<u16>().ok());
    let mut ports = vec![];
    ports.extend(bind_port);
    if config.tls.enabled {
        ports.push(config.tls.port);
    }
    for port in ports {
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        if std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(500))
            .is_ok()
        {
            bail!(
                "something is answering on port {port} (is Paracord running?). Stop the server, then run encrypt-storage again"
            );
        }
    }
    Ok(())
}

/// The file behind a SQLite URL, as SQLite resolves it.
async fn sqlite_file(url: &str) -> Result<PathBuf> {
    use std::str::FromStr;
    let options = sqlx::sqlite::SqliteConnectOptions::from_str(url)
        .with_context(|| format!("cannot read the database URL {url}"))?
        .create_if_missing(false);
    let mut conn = sqlx::SqliteConnection::connect_with(&options)
        .await
        .context("cannot open the database (does it exist?)")?;
    let rows = sqlx::query("PRAGMA database_list")
        .fetch_all(&mut conn)
        .await?;
    let _ = conn.close().await;
    for row in rows {
        let name: String = row.try_get(1)?;
        let file: String = row.try_get(2)?;
        if name == "main" && !file.is_empty() {
            return Ok(PathBuf::from(file));
        }
    }
    bail!("the database is not a file")
}

async fn connect_file(path: &Path, key_hex: Option<&str>) -> Result<sqlx::SqliteConnection> {
    ensure!(path.is_file(), "{} does not exist", path.display());
    // SQLite opens attached databases with the main connection's flags, so
    // the connection that ATTACHes the new encrypted file must be allowed to
    // create files. The main file itself exists (checked above).
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true);
    let mut conn = sqlx::SqliteConnection::connect_with(&options)
        .await
        .with_context(|| format!("cannot open {}", path.display()))?;
    if let Some(key) = key_hex {
        sqlx::query(&format!("PRAGMA key = \"x'{key}'\""))
            .execute(&mut conn)
            .await?;
    }
    Ok(conn)
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn remove_with_journals(path: &Path) {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(sibling(path, suffix));
    }
}

/// Copy `db_path` into a SQLCipher database, verify it, and swap it in.
/// Returns (tables, rows). Safe to call again after any interruption.
async fn encrypt_sqlite_file(db_path: &Path, key_hex: &str) -> Result<(usize, i64)> {
    let staged = sibling(db_path, ".encrypting");
    let aside = sibling(db_path, ".plaintext");

    // An interrupted swap: put the original back first.
    if !db_path.exists() && aside.exists() {
        std::fs::rename(&aside, db_path).context("cannot restore the database set aside")?;
    }
    if db_path.exists()
        && !paracord_db::sqlite_file_has_plaintext_header(db_path)?
        && matches!(
            paracord_db::check_sqlite_key(&url_for(db_path), Some(key_hex)).await,
            Ok(paracord_db::SqliteKeyCheck::Opens)
        )
    {
        // Already swapped in; only the clean-up was left.
        remove_with_journals(&aside);
        remove_with_journals(&staged);
        let mut conn = connect_file(db_path, Some(key_hex)).await?;
        let counts = table_counts(&mut conn, "main").await?;
        let _ = conn.close().await;
        return Ok((counts.len(), counts.iter().map(|(_, n)| n).sum()));
    }
    ensure!(
        paracord_db::sqlite_file_has_plaintext_header(db_path)?,
        "{} is neither a plaintext database nor one this key opens",
        db_path.display()
    );
    remove_with_journals(&staged);

    // Export. The WAL is folded in first so the copy sees every row.
    let mut plain = connect_file(db_path, None).await?;
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&mut plain)
        .await?;
    sqlx::query("PRAGMA journal_mode = DELETE")
        .execute(&mut plain)
        .await?;
    let user_version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut plain)
        .await?;
    sqlx::query(&format!(
        "ATTACH DATABASE {} AS enc KEY \"x'{key_hex}'\"",
        sql_string(&staged.to_string_lossy())
    ))
    .execute(&mut plain)
    .await?;
    sqlx::query("SELECT sqlcipher_export('enc')")
        .execute(&mut plain)
        .await
        .context("sqlcipher_export failed")?;
    sqlx::query(&format!("PRAGMA enc.user_version = {user_version}"))
        .execute(&mut plain)
        .await?;
    sqlx::query("DETACH DATABASE enc")
        .execute(&mut plain)
        .await?;
    let source_counts = table_counts(&mut plain, "main").await?;
    plain.close().await?;

    // Verify through a fresh connection that only has the key.
    let mut enc = connect_file(&staged, Some(key_hex)).await?;
    let problems: Vec<String> = sqlx::query_scalar("PRAGMA cipher_integrity_check")
        .fetch_all(&mut enc)
        .await
        .context("cipher_integrity_check failed")?;
    ensure!(
        problems.is_empty(),
        "the encrypted copy failed its integrity check: {}",
        problems.join("; ")
    );
    let quick: String = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_one(&mut enc)
        .await?;
    ensure!(
        quick == "ok",
        "the encrypted copy failed quick_check: {quick}"
    );
    let copied_counts = table_counts(&mut enc, "main").await?;
    enc.close().await?;
    ensure!(
        source_counts == copied_counts,
        "the encrypted copy does not hold the same rows (source {source_counts:?}, copy {copied_counts:?}); nothing was replaced"
    );
    ensure!(
        !paracord_db::sqlite_file_has_plaintext_header(&staged)?,
        "the copy is not encrypted"
    );

    // Swap: original aside, copy in, original deleted.
    std::fs::rename(db_path, &aside).context("cannot move the plaintext database aside")?;
    std::fs::rename(&staged, db_path).context("cannot move the encrypted database into place")?;
    sync_dir(db_path.parent());
    remove_with_journals(&aside);
    for suffix in ["-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(sibling(db_path, suffix));
    }
    Ok((
        copied_counts.len(),
        copied_counts.iter().map(|(_, n)| n).sum(),
    ))
}

fn url_for(path: &Path) -> String {
    paracord_core::backup::recovery_sqlite_url(path)
        .unwrap_or_else(|_| format!("sqlite://{}", path.display()))
}

#[cfg(unix)]
fn sync_dir(dir: Option<&Path>) {
    if let Some(dir) = dir {
        if let Ok(handle) = std::fs::File::open(dir) {
            let _ = handle.sync_all();
        }
    }
}

#[cfg(not(unix))]
fn sync_dir(_: Option<&Path>) {}

/// Every user table's row count, sorted by name.
async fn table_counts(
    conn: &mut sqlx::SqliteConnection,
    schema: &str,
) -> Result<Vec<(String, i64)>> {
    let names: Vec<String> = sqlx::query_scalar(&format!(
        "SELECT name FROM {schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ))
    .fetch_all(&mut *conn)
    .await?;
    let mut counts = Vec::with_capacity(names.len());
    for name in names {
        let count: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM {schema}.\"{}\"",
            name.replace('"', "\"\"")
        ))
        .fetch_one(&mut *conn)
        .await?;
        counts.push((name, count));
    }
    Ok(counts)
}

#[derive(Debug, Default)]
struct FileReport {
    encrypted: u64,
    already: u64,
    missing: u64,
}

/// Encrypt every attachment and federation-cache file in place, with the AAD
/// the server reads it with. Already-encrypted files are left as they are, so
/// a rerun continues where the last one stopped.
async fn encrypt_files(
    pool: &paracord_db::DbPool,
    uploads: &Path,
    cryptor: &FileCryptor,
) -> Result<FileReport> {
    let mut items: Vec<(PathBuf, String)> = Vec::new();
    let attachments =
        sqlx::query("SELECT CAST(id AS BIGINT) AS id, filename FROM attachments ORDER BY id")
            .fetch_all(pool)
            .await
            .context("cannot list attachments")?;
    for row in attachments {
        let id: i64 = row.try_get("id")?;
        let filename: String = row.try_get("filename")?;
        let extension = Path::new(&filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin");
        items.push((
            uploads.join(format!("attachments/{id}.{extension}")),
            format!("attachment:{id}"),
        ));
    }
    let cached = sqlx::query(
        "SELECT origin_server, origin_attachment_id, storage_key FROM federation_file_cache ORDER BY id",
    )
    .fetch_all(pool)
    .await
    .context("cannot list cached federated files")?;
    for row in cached {
        let origin: String = row.try_get("origin_server")?;
        let attachment: String = row.try_get("origin_attachment_id")?;
        let key: String = row.try_get("storage_key")?;
        let relative = Path::new(&key);
        ensure!(
            relative
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_))),
            "a cached file has an unsafe storage key: {key}"
        );
        items.push((
            uploads.join(relative),
            format!("federation-cache:{origin}:{attachment}"),
        ));
    }

    let stop_after: Option<u64> = if cfg!(debug_assertions) {
        std::env::var(STOP_AFTER_ENV)
            .ok()
            .and_then(|v| v.strip_prefix("files:").and_then(|n| n.parse().ok()))
    } else {
        None
    };
    let mut report = FileReport::default();
    for (path, aad) in items {
        let payload = match std::fs::read(&path) {
            Ok(payload) => payload,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                report.missing += 1;
                continue;
            }
            Err(e) => return Err(e).with_context(|| format!("cannot read {}", path.display())),
        };
        if FileCryptor::payload_is_encrypted(&payload) {
            report.already += 1;
            continue;
        }
        let sealed = cryptor
            .encrypt_with_aad(&payload, aad.as_bytes())
            .map_err(|e| anyhow::anyhow!("cannot encrypt {}: {e}", path.display()))?;
        ensure!(
            cryptor
                .decrypt_with_aad(&sealed, aad.as_bytes())
                .ok()
                .as_deref()
                == Some(&payload[..]),
            "{} did not decrypt back to its contents",
            path.display()
        );
        let tmp = sibling(&path, ".encrypting");
        {
            use std::io::Write;
            let mut file = std::fs::File::create(&tmp)
                .with_context(|| format!("cannot write {}", tmp.display()))?;
            file.write_all(&sealed)?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, &path)
            .with_context(|| format!("cannot replace {}", path.display()))?;
        report.encrypted += 1;
        if stop_after == Some(report.encrypted) {
            bail!(
                "stopped after {} files ({STOP_AFTER_ENV})",
                report.encrypted
            );
        }
    }
    Ok(report)
}
