pub mod attachments;
pub mod audit_log;
pub mod bans;
pub mod bot_applications;
pub mod channel_overwrites;
pub mod channels;
pub mod dms;
pub mod emojis;
pub mod federation;
pub mod guilds;
pub mod invites;
pub mod members;
pub mod messages;
pub mod polls;
pub mod prekeys;
pub mod rate_limits;
pub mod reactions;
pub mod read_states;
pub mod relationships;
pub mod roles;
pub mod scheduled_events;
pub mod security_events;
pub mod server_settings;
pub mod sessions;
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
}

/// Optional tuning knobs applied after each PostgreSQL connection is established.
#[derive(Debug, Clone, Default)]
pub struct PgConnectOptions {
    /// `statement_timeout` in seconds (0 = disabled).
    pub statement_timeout_secs: u64,
    /// `idle_in_transaction_session_timeout` in seconds (0 = disabled).
    pub idle_in_transaction_timeout_secs: u64,
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

                    // Tune SQLite for concurrent access.
                    sqlx::query("PRAGMA journal_mode = WAL;")
                        .execute(&mut *conn)
                        .await?;
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
                    sqlx::query("PRAGMA mmap_size = 67108864;")
                        .execute(&mut *conn)
                        .await?;
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

pub async fn run_migrations_for_engine(
    pool: &DbPool,
    engine: DatabaseEngine,
) -> Result<(), sqlx::Error> {
    match engine {
        DatabaseEngine::Sqlite => sqlx::migrate!("./migrations").run(pool).await?,
        DatabaseEngine::Postgres => sqlx::migrate!("./migrations_pg").run(pool).await?,
    }
    backfill_webhook_token_hashes(pool).await?;
    tracing::info!("migrations: applied successfully");
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

    Err(sqlx::Error::Protocol(
        format!("invalid datetime text '{}'", value).into(),
    ))
}

pub(crate) fn json_from_db_text(value: &str) -> Result<serde_json::Value, sqlx::Error> {
    serde_json::from_str(value)
        .map_err(|e| sqlx::Error::Protocol(format!("invalid json text: {e}").into()))
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

async fn backfill_webhook_token_hashes(pool: &DbPool) -> Result<(), sqlx::Error> {
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

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        backfill_webhook_token_hashes, create_pool, create_pool_with_engine_and_sqlite_key,
        create_pool_with_sqlite_key, run_migrations, run_migrations_for_engine, DatabaseEngine,
    };

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

        let user = crate::users::create_user(
            &pool,
            user_id,
            "pg_smoke_user",
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
}
