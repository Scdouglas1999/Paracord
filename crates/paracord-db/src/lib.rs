#![allow(clippy::too_many_arguments, clippy::type_complexity)]

pub mod anonymous_messages;
pub mod application_commands;
pub mod attachments;
pub mod audit_log;
pub mod automod;
pub mod bans;
pub mod bot_applications;
pub mod bot_reviews;
pub mod channel_features;
pub mod channel_follows;
pub mod channel_overwrites;
pub mod channels;
pub mod dms;
pub mod economy;
pub mod emojis;
pub mod federation;
pub mod federation_file_cache;
pub mod group_e2ee;
pub mod guild_storage_policies;
pub mod guild_templates;
pub mod guilds;
pub mod interaction_tokens;
pub mod invites;
pub mod members;
pub mod messages;
pub mod mfa;
pub mod migrate_export;
pub mod moderation_templates;
pub mod onboarding;
pub mod password_reset;
pub mod polls;
pub mod prekeys;
pub mod rate_limits;
pub mod reactions;
pub mod read_states;
pub mod relationships;
pub mod roles;
pub mod saved_messages;
pub mod scheduled_events;
pub mod scheduled_messages;
pub mod security_events;
pub mod server_settings;
pub mod sessions;
pub mod stage_instances;
pub mod stickers;
pub mod users;
pub mod voice_states;
pub mod webhooks;

use sha2::{Digest, Sha256};
use sqlx::any::AnyPoolOptions;
use std::sync::OnceLock;
use thiserror::Error;

pub type DbPool = sqlx::AnyPool;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatabaseEngine {
    Sqlite,
    Postgres,
}

impl DatabaseEngine {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sqlite => "sqlite",
            Self::Postgres => "postgres",
        }
    }
}

static ACTIVE_DB_ENGINE: OnceLock<DatabaseEngine> = OnceLock::new();

#[derive(Debug, Error)]
pub enum DbError {
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("not found")]
    NotFound,
    /// A per-resource limit was reached (e.g. the maximum number of pinned
    /// messages in a channel). The API layer maps this to HTTP 409 Conflict.
    #[error("limit reached: {0}")]
    LimitReached(String),
}

/// Optional tuning knobs applied after each PostgreSQL connection is established.
#[derive(Debug, Clone, Default)]
pub struct PgConnectOptions {
    /// `statement_timeout` in seconds (0 = disabled).
    pub statement_timeout_secs: u64,
    /// `idle_in_transaction_session_timeout` in seconds (0 = disabled).
    pub idle_in_transaction_timeout_secs: u64,
    /// Per-connection `work_mem` in MB (0 = keep server default).
    pub work_mem_mb: u32,
    /// Per-connection `maintenance_work_mem` in MB (0 = keep server default).
    pub maintenance_work_mem_mb: u32,
}

pub async fn create_pool(database_url: &str, max_connections: u32) -> Result<DbPool, sqlx::Error> {
    create_pool_full(database_url, max_connections, None, None, None).await
}

pub async fn create_pool_with_sqlite_key(
    database_url: &str,
    max_connections: u32,
    sqlite_key_hex: Option<String>,
) -> Result<DbPool, sqlx::Error> {
    create_pool_full(database_url, max_connections, None, sqlite_key_hex, None).await
}

pub async fn create_pool_with_engine_and_sqlite_key(
    database_url: &str,
    max_connections: u32,
    engine: Option<DatabaseEngine>,
    sqlite_key_hex: Option<String>,
) -> Result<DbPool, sqlx::Error> {
    create_pool_full(database_url, max_connections, engine, sqlite_key_hex, None).await
}

pub async fn create_pool_full(
    database_url: &str,
    max_connections: u32,
    engine: Option<DatabaseEngine>,
    sqlite_key_hex: Option<String>,
    pg_options: Option<PgConnectOptions>,
) -> Result<DbPool, sqlx::Error> {
    let detected_engine = detect_database_engine(database_url)?;
    let engine = engine.unwrap_or(detected_engine);
    if engine != detected_engine {
        return Err(sqlx::Error::Configuration(
            format!(
                "database engine/url mismatch: engine='{}' url='{}'",
                engine.as_str(),
                database_url
            )
            .into(),
        ));
    }

    let _ = ACTIVE_DB_ENGINE.set(engine);

    let sqlite_key_hex = sqlite_key_hex.filter(|k| !k.trim().is_empty());
    if matches!(engine, DatabaseEngine::Sqlite) {
        if let Some(key_hex) = &sqlite_key_hex {
            let valid_len = key_hex.len() == 64;
            let valid_hex = key_hex.chars().all(|ch| ch.is_ascii_hexdigit());
            if !valid_len || !valid_hex {
                return Err(sqlx::Error::Protocol(
                    "invalid sqlite key format (expected 64 hex chars)".to_string(),
                ));
            }
        }
    }

    // Required once before using sqlx::Any.
    sqlx::any::install_default_drivers();

    let connect_url = if matches!(engine, DatabaseEngine::Sqlite) {
        normalize_sqlite_url_for_any(database_url)
    } else {
        database_url.to_string()
    };

    let after_connect_key = sqlite_key_hex.clone();
    let pg_opts = pg_options.unwrap_or_default();
    let sqlite_in_memory =
        matches!(engine, DatabaseEngine::Sqlite) && is_in_memory_sqlite_url(&connect_url);
    AnyPoolOptions::new()
        .max_connections(max_connections)
        .after_connect(move |conn, _meta| {
            let sqlite_key_hex = after_connect_key.clone();
            let sqlite_db = matches!(engine, DatabaseEngine::Sqlite);
            let pg_opts = pg_opts.clone();
            Box::pin(async move {
                if sqlite_db {
                    if let Some(key_hex) = sqlite_key_hex {
                        let pragma = format!("PRAGMA key = \"x'{}'\";", key_hex);
                        sqlx::query(&pragma).execute(&mut *conn).await?;

                        let cipher_version: Option<String> =
                            sqlx::query_scalar("PRAGMA cipher_version;")
                                .fetch_optional(&mut *conn)
                                .await?;
                        let has_cipher = cipher_version
                            .as_deref()
                            .map(str::trim)
                            .filter(|v| !v.is_empty())
                            .is_some();
                        if !has_cipher {
                            return Err(sqlx::Error::Protocol(
                                "sqlite encryption requested, but SQLCipher support is unavailable"
                                    .to_string(),
                            ));
                        }
                    }

                    // Tune SQLite for concurrent access. These apply to every
                    // connection regardless of storage backing.
                    sqlx::query("PRAGMA foreign_keys = ON;")
                        .execute(&mut *conn)
                        .await?;
                    sqlx::query("PRAGMA busy_timeout = 5000;")
                        .execute(&mut *conn)
                        .await?;
                    sqlx::query("PRAGMA synchronous = NORMAL;")
                        .execute(&mut *conn)
                        .await?;
                    sqlx::query("PRAGMA cache_size = -8000;")
                        .execute(&mut *conn)
                        .await?;

                    // File-oriented PRAGMAs are meaningless (and WAL journaling
                    // is unsupported) on in-memory databases, so skip them.
                    if !sqlite_in_memory {
                        sqlx::query("PRAGMA journal_mode = WAL;")
                            .execute(&mut *conn)
                            .await?;
                        sqlx::query("PRAGMA mmap_size = 67108864;")
                            .execute(&mut *conn)
                            .await?;
                        sqlx::query("PRAGMA journal_size_limit = 67108864;")
                            .execute(&mut *conn)
                            .await?;
                        // Slightly larger checkpoint interval to reduce checkpoint churn.
                        sqlx::query("PRAGMA wal_autocheckpoint = 2000;")
                            .execute(&mut *conn)
                            .await?;
                    }
                } else {
                    // Tune PostgreSQL connections.
                    if pg_opts.statement_timeout_secs > 0 {
                        let sql = format!(
                            "SET statement_timeout = '{}s'",
                            pg_opts.statement_timeout_secs
                        );
                        sqlx::query(&sql).execute(&mut *conn).await?;
                    }
                    if pg_opts.idle_in_transaction_timeout_secs > 0 {
                        let sql = format!(
                            "SET idle_in_transaction_session_timeout = '{}s'",
                            pg_opts.idle_in_transaction_timeout_secs
                        );
                        sqlx::query(&sql).execute(&mut *conn).await?;
                    }
                    if pg_opts.work_mem_mb > 0 {
                        let sql = format!("SET work_mem = '{}MB'", pg_opts.work_mem_mb);
                        sqlx::query(&sql).execute(&mut *conn).await?;
                    }
                    if pg_opts.maintenance_work_mem_mb > 0 {
                        let sql = format!(
                            "SET maintenance_work_mem = '{}MB'",
                            pg_opts.maintenance_work_mem_mb
                        );
                        sqlx::query(&sql).execute(&mut *conn).await?;
                    }
                    sqlx::query("SET lock_timeout = '10s'")
                        .execute(&mut *conn)
                        .await?;
                    sqlx::query("SET timezone = 'UTC'")
                        .execute(&mut *conn)
                        .await?;
                }
                Ok(())
            })
        })
        .connect(&connect_url)
        .await
}

pub async fn run_migrations(pool: &DbPool) -> Result<(), sqlx::Error> {
    run_migrations_for_engine(pool, active_database_engine()).await
}

/// Historical checksums of SQLite migrations that had to be corrected *in place*
/// because a forward-only repair could not reach the damage they do.
///
/// Each entry is `(version, sha384-of-the-shipped-file)`. Three shipped SQLite
/// migrations were destructive or fatal on any database that already held rows:
///
/// * `20260211000001` dropped and recreated `channels`, whose implicit
///   `DELETE FROM` cascaded away every message, read state, reaction,
///   attachment, permission overwrite and DM membership.
/// * `20260214000001` used a non-constant `DEFAULT` on `ADD COLUMN`, which
///   SQLite rejects once a table holds rows, so the server refused to start.
/// * `20260220000001` dropped and recreated `poll_options`, `poll_votes` and
///   `event_rsvps` empty, discarding every option, vote and RSVP.
///
/// A later migration cannot undo any of that: on a server that is still on an
/// older tag the damage happens when the *old* file runs, so only fixing the
/// file itself helps. Correcting a file changes its checksum, which sqlx
/// normally rejects with `VersionMismatch`, so the exact pre-fix checksums are
/// pinned here and rewritten to the current ones before the migrator runs.
///
/// This is deliberately narrow: a row is only touched when its stored checksum
/// is byte-identical to one of these known-bad values, so genuine drift in any
/// other migration still fails loudly.
const REPAIRED_SQLITE_MIGRATIONS: &[(i64, &str)] = &[
    (
        20260211000001,
        "9668743d4f398c4d847f21e51ecaaa7de11a2ef85cf50a596f870715473c6eed1a8b35878492839237eb721e5804229b",
    ),
    (
        20260214000001,
        "7fdde7c220d0df0fbc9f6330282d1a26b288453cac5f3cd916a692b934ab30734ec62fa7cabe316f0b4e17b4bf71a2cf",
    ),
    (
        20260220000001,
        "7a05dd77f954de18f4135b043380efeea983155e3a1a096e34e811d690424e71ed8cae4a2efa4de1570adc9247fef07d",
    ),
];

fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect()
}

/// Rewrite the recorded checksum of an already-applied migration that we had to
/// correct in place. No-op on a fresh database, and no-op unless the stored
/// checksum matches the exact historical value.
async fn repair_migration_checksums(
    pool: &DbPool,
    migrator: &sqlx::migrate::Migrator,
) -> Result<(), sqlx::Error> {
    // Nothing to repair before the migrator has ever run.
    let table_exists: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_optional(pool)
    .await?;
    if table_exists.is_none() {
        return Ok(());
    }

    for (version, legacy_hex) in REPAIRED_SQLITE_MIGRATIONS {
        let Some(legacy) = decode_hex(legacy_hex) else {
            return Err(sqlx::Error::Configuration(
                format!("migration checksum repair table has malformed hex for {version}").into(),
            ));
        };
        let Some(current) = migrator.iter().find(|m| m.version == *version) else {
            continue;
        };
        let current_checksum = current.checksum.to_vec();
        if current_checksum == legacy {
            // File is unmodified relative to the pinned value: nothing to do.
            continue;
        }

        let updated = sqlx::query(
            "UPDATE _sqlx_migrations SET checksum = $1 WHERE version = $2 AND checksum = $3",
        )
        .bind(current_checksum)
        .bind(*version)
        .bind(legacy)
        .execute(pool)
        .await?
        .rows_affected();

        if updated > 0 {
            tracing::warn!(
                version,
                "migrations: rewrote the recorded checksum of a migration that was corrected in \
                 place; the database schema is unchanged"
            );
        }
    }
    Ok(())
}

pub async fn run_migrations_for_engine(
    pool: &DbPool,
    engine: DatabaseEngine,
) -> Result<(), sqlx::Error> {
    match engine {
        DatabaseEngine::Sqlite => {
            let migrator = sqlx::migrate!("./migrations");
            repair_migration_checksums(pool, &migrator).await?;
            migrator.run(pool).await?
        }
        DatabaseEngine::Postgres => sqlx::migrate!("./migrations_pg").run(pool).await?,
    }
    backfill_webhook_token_hashes(pool).await?;
    tracing::info!("migrations: applied successfully");
    Ok(())
}

/// Take a self-consistent snapshot of a SQLite database into `dest_path`.
///
/// Goes through the normal pool builder, so the snapshot honours `PRAGMA key`
/// and therefore works for SQLCipher-encrypted databases -- opening the file
/// with a plain unkeyed SQLite handle just reports "file is not a database".
/// `VACUUM INTO` also produces a coherent file while the database is being
/// written to, which a filesystem copy of a WAL database does not: the copy
/// misses whatever is still sitting in `-wal`.
pub async fn vacuum_sqlite_into(
    database_url: &str,
    sqlite_key_hex: Option<String>,
    dest_path: &str,
) -> Result<(), sqlx::Error> {
    if detect_database_engine(database_url)? != DatabaseEngine::Sqlite {
        return Err(sqlx::Error::Configuration(
            "VACUUM INTO is only available for SQLite databases".into(),
        ));
    }
    // `VACUUM INTO` takes a string literal, not a bind parameter.
    if dest_path.contains('\'') {
        return Err(sqlx::Error::Configuration(
            format!("refusing to VACUUM INTO a path containing a quote: {dest_path}").into(),
        ));
    }

    let pool = create_pool_full(
        database_url,
        1,
        Some(DatabaseEngine::Sqlite),
        sqlite_key_hex,
        None,
    )
    .await?;
    let result = sqlx::query(&format!("VACUUM INTO '{dest_path}'"))
        .execute(&pool)
        .await;
    pool.close().await;
    result?;
    Ok(())
}

pub fn detect_database_engine(database_url: &str) -> Result<DatabaseEngine, sqlx::Error> {
    let normalized = database_url.trim().to_ascii_lowercase();
    if normalized.starts_with("sqlite:") {
        Ok(DatabaseEngine::Sqlite)
    } else if normalized.starts_with("postgres://") || normalized.starts_with("postgresql://") {
        Ok(DatabaseEngine::Postgres)
    } else {
        Err(sqlx::Error::Configuration(
            format!("unsupported database URL scheme in '{}'", database_url).into(),
        ))
    }
}

pub fn active_database_engine() -> DatabaseEngine {
    *ACTIVE_DB_ENGINE.get().unwrap_or(&DatabaseEngine::Sqlite)
}

/// Returns true when a SQLite connection URL refers to an in-memory database,
/// for which file-oriented PRAGMAs (WAL, mmap, checkpoint) are meaningless.
fn is_in_memory_sqlite_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains(":memory:") || lower.contains("mode=memory")
}

fn normalize_sqlite_url_for_any(url: &str) -> String {
    // sqlx::Any uses URL parsing that expects absolute Windows paths in the
    // sqlite:///C:/... form (three slashes), while existing config/tests often
    // use sqlite://C:/... (two slashes).
    if !url.starts_with("sqlite://") {
        return url.to_string();
    }
    let rest = &url["sqlite://".len()..];
    if rest.starts_with('/') {
        return url.to_string();
    }
    let bytes = rest.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        format!("sqlite:///{rest}")
    } else {
        url.to_string()
    }
}

pub(crate) fn datetime_to_db_text(value: chrono::DateTime<chrono::Utc>) -> String {
    value.format("%Y-%m-%d %H:%M:%S").to_string()
}

pub(crate) fn datetime_from_db_text(
    value: &str,
) -> Result<chrono::DateTime<chrono::Utc>, sqlx::Error> {
    use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};

    if let Ok(dt) = DateTime::parse_from_rfc3339(value) {
        return Ok(dt.with_timezone(&Utc));
    }
    if let Ok(naive) = NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S") {
        return Ok(Utc.from_utc_datetime(&naive));
    }
    if let Ok(naive) = NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f") {
        return Ok(Utc.from_utc_datetime(&naive));
    }

    Err(sqlx::Error::Protocol(format!(
        "invalid datetime text '{}'",
        value
    )))
}

pub(crate) fn json_from_db_text(value: &str) -> Result<serde_json::Value, sqlx::Error> {
    serde_json::from_str(value)
        .map_err(|e| sqlx::Error::Protocol(format!("invalid json text: {e}")))
}

pub(crate) fn bool_from_any_row(
    row: &sqlx::any::AnyRow,
    column: &str,
) -> Result<bool, sqlx::Error> {
    use sqlx::Row;
    let first_err = match row.try_get::<bool, _>(column) {
        Ok(value) => return Ok(value),
        Err(err) => err,
    };

    if let Ok(raw) = row.try_get::<i64, _>(column) {
        return Ok(raw != 0);
    }
    if let Ok(raw) = row.try_get::<i32, _>(column) {
        return Ok(raw != 0);
    }
    if let Ok(raw) = row.try_get::<i16, _>(column) {
        return Ok(raw != 0);
    }
    if let Ok(raw) = row.try_get::<String, _>(column) {
        let normalized = raw.trim().to_ascii_lowercase();
        if matches!(normalized.as_str(), "1" | "true" | "t" | "yes" | "y" | "on") {
            return Ok(true);
        }
        if matches!(
            normalized.as_str(),
            "0" | "false" | "f" | "no" | "n" | "off"
        ) {
            return Ok(false);
        }
    }

    Err(first_err)
}

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

fn is_hex_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

/// Settings marker recording that the one-time webhook-token backfill has run.
/// Once present, boot no longer rescans the whole `webhooks` table.
const WEBHOOK_TOKEN_BACKFILL_MARKER: &str = "webhook_token_backfill_v1";

async fn webhook_token_backfill_completed(pool: &DbPool) -> Result<bool, sqlx::Error> {
    let existing: Option<(String,)> =
        sqlx::query_as("SELECT value FROM server_settings WHERE key = $1")
            .bind(WEBHOOK_TOKEN_BACKFILL_MARKER)
            .fetch_optional(pool)
            .await?;
    Ok(existing.is_some())
}

async fn mark_webhook_token_backfill_completed(pool: &DbPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO server_settings (key, value) VALUES ($1, 'true')
         ON CONFLICT (key) DO UPDATE SET value = 'true'",
    )
    .bind(WEBHOOK_TOKEN_BACKFILL_MARKER)
    .execute(pool)
    .await?;
    Ok(())
}

async fn backfill_webhook_token_hashes(pool: &DbPool) -> Result<(), sqlx::Error> {
    // One-time migration: once the marker is set, skip the full-table scan on
    // every subsequent boot. The scan itself stays idempotent (it re-hashes only
    // plaintext tokens, preserving the is_hex_sha256 skip) so re-running before
    // the marker exists is always safe.
    if webhook_token_backfill_completed(pool).await? {
        return Ok(());
    }

    let rows: Vec<(i64, String)> = sqlx::query_as("SELECT id, token FROM webhooks")
        .fetch_all(pool)
        .await?;

    for (id, token) in rows {
        let trimmed = token.trim();
        if trimmed.is_empty() || is_hex_sha256(trimmed) {
            continue;
        }
        let hashed = sha256_hex(trimmed);
        sqlx::query("UPDATE webhooks SET token = $2 WHERE id = $1")
            .bind(id)
            .bind(hashed)
            .execute(pool)
            .await?;
    }

    mark_webhook_token_backfill_completed(pool).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        backfill_webhook_token_hashes, create_pool, create_pool_with_engine_and_sqlite_key,
        create_pool_with_sqlite_key, decode_hex, run_migrations, run_migrations_for_engine,
        DatabaseEngine, REPAIRED_SQLITE_MIGRATIONS,
    };
    use sqlx::Row;

    #[tokio::test]
    async fn corrected_migrations_repair_their_recorded_checksum() {
        let pool = create_pool("sqlite::memory:", 1).await.expect("pool");
        run_migrations(&pool).await.expect("migrations");

        // Rewind the bookkeeping to what a database migrated by the shipped,
        // pre-correction files looks like.
        for (version, legacy_hex) in REPAIRED_SQLITE_MIGRATIONS {
            let legacy = decode_hex(legacy_hex).expect("pinned checksum must be valid hex");
            let updated =
                sqlx::query("UPDATE _sqlx_migrations SET checksum = $1 WHERE version = $2")
                    .bind(legacy)
                    .bind(*version)
                    .execute(&pool)
                    .await
                    .expect("seed legacy checksum")
                    .rows_affected();
            assert_eq!(updated, 1, "migration {version} should already be applied");
        }

        // Without the repair pass this is `MigrateError::VersionMismatch` and
        // the server refuses to start.
        run_migrations(&pool)
            .await
            .expect("a corrected migration must not fail an already-migrated database");

        for (version, legacy_hex) in REPAIRED_SQLITE_MIGRATIONS {
            let stored: Vec<u8> =
                sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = $1")
                    .bind(*version)
                    .fetch_one(&pool)
                    .await
                    .expect("checksum");
            assert_ne!(
                stored,
                decode_hex(legacy_hex).expect("hex"),
                "checksum for {version} was not rewritten"
            );
        }
    }

    #[tokio::test]
    async fn checksum_repair_does_not_mask_unrelated_drift() {
        let pool = create_pool("sqlite::memory:", 1).await.expect("pool");
        run_migrations(&pool).await.expect("migrations");

        // A migration that is *not* on the repair list, and a checksum that is
        // not one of the pinned historical values, must still fail loudly.
        sqlx::query("UPDATE _sqlx_migrations SET checksum = $1 WHERE version = $2")
            .bind(vec![0u8; 48])
            .bind(20260209000001_i64)
            .execute(&pool)
            .await
            .expect("corrupt a checksum");

        run_migrations(&pool)
            .await
            .expect_err("tampered migration bookkeeping must abort startup");
    }

    #[tokio::test]
    async fn create_pool_supports_default_sqlite_mode() {
        let pool = create_pool("sqlite::memory:", 1).await.expect("pool");
        let value: i64 = sqlx::query_scalar("SELECT 1")
            .fetch_one(&pool)
            .await
            .expect("query");
        assert_eq!(value, 1);
    }

    #[tokio::test]
    async fn rejects_invalid_sqlite_key_format() {
        let err = create_pool_with_sqlite_key("sqlite::memory:", 1, Some("abc".to_string()))
            .await
            .expect_err("invalid key must fail");
        assert!(matches!(err, sqlx::Error::Protocol(_)));
    }

    #[tokio::test]
    async fn webhook_token_backfill_hashes_plaintext_tokens() {
        let pool = create_pool("sqlite::memory:", 1).await.expect("pool");
        run_migrations(&pool).await.expect("migrations");

        sqlx::query(
            "INSERT INTO users (id, username, discriminator, email, password_hash)
             VALUES (1, 'u', 1, 'u@example.com', 'hash')",
        )
        .execute(&pool)
        .await
        .expect("insert user");
        sqlx::query(
            "INSERT INTO spaces (id, name, owner_id)
             VALUES (2, 'space', 1)",
        )
        .execute(&pool)
        .await
        .expect("insert space");
        sqlx::query(
            "INSERT INTO channels (id, space_id, name, channel_type, position)
             VALUES (3, 2, 'general', 0, 0)",
        )
        .execute(&pool)
        .await
        .expect("insert channel");
        sqlx::query(
            "INSERT INTO webhooks (id, space_id, channel_id, creator_id, name, token)
             VALUES (4, 2, 3, 1, 'hook', 'plaintext-token')",
        )
        .execute(&pool)
        .await
        .expect("insert webhook");

        // run_migrations already sets the completion marker (backfill runs at the
        // end of migrations against an empty table). Clear it to exercise the
        // scan-and-hash path as it would run on a pre-marker database.
        sqlx::query("DELETE FROM server_settings WHERE key = $1")
            .bind(super::WEBHOOK_TOKEN_BACKFILL_MARKER)
            .execute(&pool)
            .await
            .expect("clear marker");

        backfill_webhook_token_hashes(&pool)
            .await
            .expect("backfill webhook hashes");

        let stored: String = sqlx::query_scalar("SELECT token FROM webhooks WHERE id = 4")
            .fetch_one(&pool)
            .await
            .expect("load webhook");
        assert_eq!(stored.len(), 64);
        assert_ne!(stored, "plaintext-token");
    }

    #[tokio::test]
    async fn webhook_token_backfill_is_gated_after_completion() {
        let pool = create_pool("sqlite::memory:", 1).await.expect("pool");
        run_migrations(&pool).await.expect("migrations");

        // Fresh migrations set the marker against an empty webhooks table.
        assert!(
            super::webhook_token_backfill_completed(&pool)
                .await
                .expect("marker check"),
            "migrations should mark the backfill complete"
        );

        sqlx::query(
            "INSERT INTO users (id, username, discriminator, email, password_hash)
             VALUES (1, 'u', 1, 'u@example.com', 'hash')",
        )
        .execute(&pool)
        .await
        .expect("insert user");
        sqlx::query("INSERT INTO spaces (id, name, owner_id) VALUES (2, 'space', 1)")
            .execute(&pool)
            .await
            .expect("insert space");
        sqlx::query(
            "INSERT INTO channels (id, space_id, name, channel_type, position)
             VALUES (3, 2, 'general', 0, 0)",
        )
        .execute(&pool)
        .await
        .expect("insert channel");
        sqlx::query(
            "INSERT INTO webhooks (id, space_id, channel_id, creator_id, name, token)
             VALUES (5, 2, 3, 1, 'hook', 'still-plaintext')",
        )
        .execute(&pool)
        .await
        .expect("insert webhook");

        // Marker present -> the scan is skipped and the plaintext token is left
        // untouched, proving the whole-table rescan no longer runs every boot.
        backfill_webhook_token_hashes(&pool)
            .await
            .expect("gated backfill");

        let stored: String = sqlx::query_scalar("SELECT token FROM webhooks WHERE id = 5")
            .fetch_one(&pool)
            .await
            .expect("load webhook");
        assert_eq!(stored, "still-plaintext");
    }

    #[tokio::test]
    async fn postgres_pool_and_migrations_smoke_when_configured() {
        let Some(url) = std::env::var("PARACORD_TEST_POSTGRES_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
        else {
            return;
        };

        let pool =
            create_pool_with_engine_and_sqlite_key(&url, 5, Some(DatabaseEngine::Postgres), None)
                .await
                .expect("postgres pool");
        run_migrations_for_engine(&pool, DatabaseEngine::Postgres)
            .await
            .expect("postgres migrations");

        let test_seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock drift")
            .as_millis() as i64;
        let user_id = 9_000_000_000_000_i64 + test_seed;
        let guild_id = user_id + 1;
        let channel_id = user_id + 2;
        let message_id = user_id + 3;
        let username = format!("pg_smoke_{test_seed}");

        let user = crate::users::create_user(
            &pool,
            user_id,
            &username,
            1,
            &format!("pg-smoke-{test_seed}@example.com"),
            "hash",
        )
        .await
        .expect("create user");
        assert_eq!(user.id, user_id);

        let guild = crate::guilds::create_guild(&pool, guild_id, "pg-smoke", user_id, None)
            .await
            .expect("create guild");
        assert_eq!(guild.id, guild_id);

        let channel = crate::channels::create_channel(
            &pool, channel_id, guild_id, "general", 0, 0, None, None,
        )
        .await
        .expect("create channel");
        assert_eq!(channel.id, channel_id);

        let thread_id = user_id + 4;
        let thread = crate::channels::create_thread(
            &pool,
            thread_id,
            guild_id,
            channel_id,
            "pg-smoke-thread",
            user_id,
            1440,
            None,
        )
        .await
        .expect("create thread");
        assert_eq!(thread.id, thread_id);
        assert_eq!(thread.owner_id, Some(user_id));

        let message = crate::messages::create_message(
            &pool,
            message_id,
            channel_id,
            user_id,
            "postgres smoke",
            0,
            None,
        )
        .await
        .expect("create message");
        assert_eq!(message.id, message_id);
        assert!(!message.pinned);

        let fetched = crate::messages::get_message(&pool, message_id)
            .await
            .expect("get message")
            .expect("message exists");
        assert_eq!(fetched.content.as_deref(), Some("postgres smoke"));
    }

    async fn assert_postgres_plan_uses_index(
        pool: &sqlx::AnyPool,
        label: &str,
        sql: &str,
        index_name: &str,
    ) {
        let mut conn = pool.acquire().await.expect("postgres connection");
        sqlx::query("SET enable_seqscan = off")
            .execute(&mut *conn)
            .await
            .expect("disable seqscan for deterministic index validation");

        let rows = sqlx::query(&format!("EXPLAIN {sql}"))
            .fetch_all(&mut *conn)
            .await
            .unwrap_or_else(|err| panic!("{label}: explain failed: {err}"));
        let plan = rows
            .iter()
            .map(|row| row.try_get::<String, _>(0).expect("query plan row"))
            .collect::<Vec<_>>()
            .join(" | ");
        assert!(
            plan.to_lowercase().contains(&index_name.to_lowercase()),
            "{label}: expected {index_name} in PostgreSQL query plan, got: {plan}"
        );
    }

    #[tokio::test]
    async fn postgres_query_plan_smoke_when_configured() {
        let Some(url) = std::env::var("PARACORD_TEST_POSTGRES_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
        else {
            return;
        };

        let pool =
            create_pool_with_engine_and_sqlite_key(&url, 5, Some(DatabaseEngine::Postgres), None)
                .await
                .expect("postgres pool");
        run_migrations_for_engine(&pool, DatabaseEngine::Postgres)
            .await
            .expect("postgres migrations");

        let mut tx = pool.begin().await.expect("seed query-plan rows");
        sqlx::query(
            "INSERT INTO users (id, username, discriminator, email, password_hash)
             SELECT gs, 'plan_user_' || gs::text, gs % 9999, 'plan-' || gs::text || '@example.com', 'hash'
             FROM generate_series(10000, 11049) AS gs
             ON CONFLICT (id) DO NOTHING",
        )
        .execute(&mut *tx)
        .await
        .expect("seed plan users");
        sqlx::query(
            "INSERT INTO spaces (id, name, owner_id)
             VALUES (1001, 'plan-space', 10000)
             ON CONFLICT (id) DO NOTHING",
        )
        .execute(&mut *tx)
        .await
        .expect("seed plan space");
        sqlx::query(
            "INSERT INTO members (user_id, guild_id, nick)
             SELECT gs, 1001, CASE WHEN gs BETWEEN 10010 AND 10019 THEN 'nick-' || gs::text ELSE 'other-' || gs::text END
             FROM generate_series(10000, 11049) AS gs
             ON CONFLICT (user_id, guild_id) DO NOTHING",
        )
        .execute(&mut *tx)
        .await
        .expect("seed plan members");
        sqlx::query("ANALYZE members")
            .execute(&mut *tx)
            .await
            .expect("analyze plan members");
        tx.commit().await.expect("commit query-plan seed rows");

        let checks = [
            (
                "message pagination latest",
                "SELECT id FROM messages WHERE channel_id = 2001 ORDER BY id DESC LIMIT 100",
                "idx_messages_channel_created",
            ),
            (
                "message pagination before cursor",
                "SELECT id FROM messages WHERE channel_id = 2001 AND id < 3001 ORDER BY id DESC LIMIT 100",
                "idx_messages_channel_created",
            ),
            (
                "attachment hydration",
                "SELECT id FROM attachments WHERE message_id = 3001",
                "idx_attachments_message_id",
            ),
            (
                "scheduled message worker",
                "SELECT id FROM scheduled_messages WHERE status = 0 AND send_at <= TIMESTAMPTZ '2026-05-16T00:00:00Z' ORDER BY send_at ASC LIMIT 100",
                "idx_scheduled_messages_due",
            ),
            (
                "scheduled event worker by status",
                "SELECT id FROM scheduled_events WHERE status IN (1, 2) ORDER BY scheduled_start ASC LIMIT 100",
                "idx_scheduled_events_status_start",
            ),
            (
                "case-insensitive email login",
                "SELECT id FROM users WHERE lower(email) = lower('USER@EXAMPLE.COM') LIMIT 1",
                "idx_users_email_lower",
            ),
            (
                "case-insensitive username prefix",
                "SELECT id FROM users WHERE lower(username) LIKE 'releaseuser%' LIMIT 20",
                "idx_users_username_lower_prefix",
            ),
            (
                "bot reviews",
                "SELECT bot_app_id FROM bot_reviews WHERE bot_app_id = 4001 ORDER BY updated_at DESC, id DESC LIMIT 20",
                "idx_bot_reviews_bot_updated",
            ),
            (
                "bot metric events",
                "SELECT bot_app_id FROM bot_metric_events WHERE bot_app_id = 4001 ORDER BY created_at DESC LIMIT 30",
                "idx_bot_metric_events_bot_created",
            ),
            (
                "group e2ee sender keys",
                "SELECT id FROM group_e2ee_sender_keys WHERE channel_id = 2001 AND recipient_id = 42 AND acknowledged = FALSE ORDER BY epoch ASC",
                "idx_group_e2ee_sender_keys_recipient",
            ),
            (
                "message slowmode lookup",
                "SELECT created_at FROM messages WHERE channel_id = 2001 AND author_id = 42 ORDER BY id DESC LIMIT 1",
                "idx_messages_channel_author_id",
            ),
            (
                "message full-text search GIN index",
                "SELECT id FROM messages WHERE search_vector @@ plainto_tsquery('english', 'hello') LIMIT 20",
                "idx_messages_search",
            ),
            (
                "member nick prefix search",
                "SELECT user_id FROM members WHERE guild_id = 1001 AND lower(COALESCE(nick, '')) LIKE 'nick%' LIMIT 20",
                "idx_members_guild_lower_nick_prefix",
            ),
            (
                "pending attachment cleanup",
                "SELECT id FROM attachments WHERE message_id IS NULL AND upload_expires_at IS NOT NULL AND upload_expires_at <= '2026-05-16T00:00:00Z' ORDER BY upload_expires_at ASC LIMIT 100",
                "idx_attachments_pending_cleanup",
            ),
            (
                "bot guild installs by guild",
                "SELECT bot_app_id FROM bot_guild_installs WHERE guild_id = 1001 ORDER BY created_at LIMIT 100",
                "idx_bot_guild_installs_guild",
            ),
            (
                "forum active thread listing",
                "SELECT id FROM channels WHERE parent_id = 2001 AND channel_type = 6 ORDER BY created_at DESC LIMIT 100",
                "idx_channels_parent_thread_created",
            ),
        ];

        for (label, sql, index_name) in checks {
            assert_postgres_plan_uses_index(&pool, label, sql, index_name).await;
        }
    }
}
