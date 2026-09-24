//! Game servers add-on: the per-server switch, the shared probe targets and
//! the game servers each Paracord server lists.
//!
//! Booleans are bound as Rust `bool` and read back through `CAST(col AS
//! INTEGER)` plus [`bool_from_any_row`]. Timestamps are TEXT on both engines,
//! written with [`datetime_to_db_text`], which sorts in time order.

use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::{bool_from_any_row, datetime_from_db_text, datetime_to_db_text, DbError, DbPool};

// ── Per-server switch ──────────────────────────────────────────────────────

pub async fn is_enabled(pool: &DbPool, guild_id: i64) -> Result<bool, DbError> {
    let row = sqlx::query(
        "SELECT CAST(enabled AS INTEGER) AS enabled FROM guild_game_server_settings
         WHERE guild_id = $1",
    )
    .bind(guild_id)
    .fetch_optional(pool)
    .await?;
    match row {
        Some(row) => Ok(bool_from_any_row(&row, "enabled")?),
        None => Ok(false),
    }
}

pub async fn set_enabled(pool: &DbPool, guild_id: i64, enabled: bool) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO guild_game_server_settings (guild_id, enabled, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (guild_id) DO UPDATE SET enabled = $2, updated_at = $3",
    )
    .bind(guild_id)
    .bind(enabled)
    .bind(datetime_to_db_text(Utc::now()))
    .execute(pool)
    .await?;
    Ok(())
}

// ── Probe targets ──────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct TargetRow {
    pub id: i64,
    pub kind: String,
    pub target_key: String,
    pub host: String,
    pub port: i64,
    pub online: bool,
    pub players_online: Option<i64>,
    pub players_max: Option<i64>,
    /// A JSON list, or `None` when the protocol does not say who is on.
    pub player_names: Option<String>,
    pub server_name: Option<String>,
    pub map: Option<String>,
    pub version: Option<String>,
    pub motd: Option<String>,
    pub latency_ms: Option<i64>,
    pub fail_count: i64,
    pub last_checked_at: Option<DateTime<Utc>>,
    pub last_seen_online: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub next_check_at: Option<DateTime<Utc>>,
}

fn optional_time(
    row: &sqlx::any::AnyRow,
    column: &str,
) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    let raw: Option<String> = row.try_get(column)?;
    raw.as_deref()
        .filter(|value| !value.is_empty())
        .map(datetime_from_db_text)
        .transpose()
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for TargetRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: row.try_get("id")?,
            kind: row.try_get("kind")?,
            target_key: row.try_get("target_key")?,
            host: row.try_get("host")?,
            port: row.try_get("port")?,
            online: bool_from_any_row(row, "online")?,
            players_online: row.try_get("players_online")?,
            players_max: row.try_get("players_max")?,
            player_names: row.try_get("player_names")?,
            server_name: row.try_get("server_name")?,
            map: row.try_get("map")?,
            version: row.try_get("version")?,
            motd: row.try_get("motd")?,
            latency_ms: row.try_get("latency_ms")?,
            fail_count: row.try_get("fail_count")?,
            last_checked_at: optional_time(row, "last_checked_at")?,
            last_seen_online: optional_time(row, "last_seen_online")?,
            last_error: row.try_get("last_error")?,
            next_check_at: optional_time(row, "next_check_at")?,
        })
    }
}

const TARGET_COLUMNS: &str =
    "id, kind, target_key, host, port, CAST(online AS INTEGER) AS online, \
     players_online, players_max, player_names, server_name, map, version, motd, latency_ms, \
     fail_count, last_checked_at, last_seen_online, last_error, next_check_at";

/// Insert a target, or find the one already stored under the same key.
/// Returns its id.
pub async fn upsert_target(
    pool: &DbPool,
    id: i64,
    kind: &str,
    target_key: &str,
    host: &str,
    port: u16,
) -> Result<i64, DbError> {
    let row = sqlx::query(
        "INSERT INTO game_server_targets (id, kind, target_key, host, port, online, fail_count,
                                          created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7)
         ON CONFLICT (target_key) DO UPDATE SET host = $4
         RETURNING id",
    )
    .bind(id)
    .bind(kind)
    .bind(target_key)
    .bind(host)
    .bind(i64::from(port))
    .bind(false)
    .bind(datetime_to_db_text(Utc::now()))
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("id")?)
}

pub async fn get_target(pool: &DbPool, id: i64) -> Result<Option<TargetRow>, DbError> {
    Ok(sqlx::query_as::<_, TargetRow>(&format!(
        "SELECT {TARGET_COLUMNS} FROM game_server_targets WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?)
}

/// Targets due a probe that a server with the add-on on still lists.
pub async fn list_due_targets(
    pool: &DbPool,
    now: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<TargetRow>, DbError> {
    Ok(sqlx::query_as::<_, TargetRow>(&format!(
        "SELECT {TARGET_COLUMNS} FROM game_server_targets t
         WHERE (t.next_check_at IS NULL OR t.next_check_at <= $1)
           AND EXISTS (
               SELECT 1 FROM guild_game_servers s
               JOIN guild_game_server_settings g ON g.guild_id = s.guild_id
               WHERE s.target_id = t.id
                 AND (CASE WHEN g.enabled THEN 1 ELSE 0 END) = 1)
         ORDER BY t.next_check_at LIMIT $2"
    ))
    .bind(datetime_to_db_text(now))
    .bind(limit.clamp(1, 1000))
    .fetch_all(pool)
    .await?)
}

/// What a probe that got an answer found.
pub struct TargetAnswer<'a> {
    pub players_online: Option<i64>,
    pub players_max: Option<i64>,
    pub player_names: Option<&'a str>,
    pub server_name: Option<&'a str>,
    pub map: Option<&'a str>,
    pub version: Option<&'a str>,
    pub motd: Option<&'a str>,
    pub latency_ms: i64,
}

pub async fn record_answer(
    pool: &DbPool,
    id: i64,
    answer: &TargetAnswer<'_>,
    checked_at: DateTime<Utc>,
    next_check_at: DateTime<Utc>,
) -> Result<(), DbError> {
    let checked = datetime_to_db_text(checked_at);
    sqlx::query(
        "UPDATE game_server_targets SET online = $2, players_online = $3, players_max = $4,
                player_names = $5, server_name = $6, map = $7, version = $8, motd = $9,
                latency_ms = $10, fail_count = 0, last_checked_at = $11,
                last_seen_online = $11, last_error = NULL, next_check_at = $12
         WHERE id = $1",
    )
    .bind(id)
    .bind(true)
    .bind(answer.players_online)
    .bind(answer.players_max)
    .bind(answer.player_names)
    .bind(answer.server_name)
    .bind(answer.map)
    .bind(answer.version)
    .bind(answer.motd)
    .bind(answer.latency_ms)
    .bind(&checked)
    .bind(datetime_to_db_text(next_check_at))
    .execute(pool)
    .await?;
    Ok(())
}

/// A probe that got no answer. A server still counted as up keeps what it
/// last said; one counted as down forgets who was on.
pub async fn record_failure(
    pool: &DbPool,
    id: i64,
    error: &str,
    fail_count: i64,
    online: bool,
    checked_at: DateTime<Utc>,
    next_check_at: DateTime<Utc>,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE game_server_targets SET online = $2, fail_count = $3, last_error = $4,
                last_checked_at = $5, next_check_at = $6,
                players_online = CASE WHEN $7 = 1 THEN players_online ELSE NULL END,
                player_names = CASE WHEN $7 = 1 THEN player_names ELSE NULL END,
                latency_ms = CASE WHEN $7 = 1 THEN latency_ms ELSE NULL END
         WHERE id = $1",
    )
    .bind(id)
    .bind(online)
    .bind(fail_count)
    .bind(error)
    .bind(datetime_to_db_text(checked_at))
    .bind(datetime_to_db_text(next_check_at))
    .bind(i64::from(online))
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_target_if_orphaned(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query(
        "DELETE FROM game_server_targets WHERE id = $1
           AND NOT EXISTS (SELECT 1 FROM guild_game_servers WHERE target_id = $1)",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

// ── Listings ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct GameServerRow {
    pub id: i64,
    pub guild_id: i64,
    pub target_id: i64,
    pub kind: String,
    pub name: String,
    pub address: String,
    pub announce_channel_id: Option<i64>,
    pub last_state: Option<String>,
    pub announce_error: Option<String>,
    pub creator_id: Option<i64>,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for GameServerRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            guild_id: row.try_get("guild_id")?,
            target_id: row.try_get("target_id")?,
            kind: row.try_get("kind")?,
            name: row.try_get("name")?,
            address: row.try_get("address")?,
            announce_channel_id: row.try_get("announce_channel_id")?,
            last_state: row.try_get("last_state")?,
            announce_error: row.try_get("announce_error")?,
            creator_id: row.try_get("creator_id")?,
            created_at: datetime_from_db_text(&created)?,
        })
    }
}

const SERVER_COLUMNS: &str = "id, guild_id, target_id, kind, name, address, announce_channel_id, \
     last_state, announce_error, creator_id, created_at";

pub struct NewGameServer<'a> {
    pub id: i64,
    pub guild_id: i64,
    pub target_id: i64,
    pub kind: &'a str,
    pub name: &'a str,
    pub address: &'a str,
    pub announce_channel_id: Option<i64>,
    pub last_state: Option<&'a str>,
    pub creator_id: i64,
}

pub async fn create_game_server(
    pool: &DbPool,
    server: &NewGameServer<'_>,
) -> Result<GameServerRow, DbError> {
    let now = datetime_to_db_text(Utc::now());
    Ok(sqlx::query_as::<_, GameServerRow>(&format!(
        "INSERT INTO guild_game_servers (id, guild_id, target_id, kind, name, address,
                                         announce_channel_id, last_state, creator_id,
                                         created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
         RETURNING {SERVER_COLUMNS}"
    ))
    .bind(server.id)
    .bind(server.guild_id)
    .bind(server.target_id)
    .bind(server.kind)
    .bind(server.name)
    .bind(server.address)
    .bind(server.announce_channel_id)
    .bind(server.last_state)
    .bind(server.creator_id)
    .bind(&now)
    .fetch_one(pool)
    .await?)
}

pub async fn get_game_server(pool: &DbPool, id: i64) -> Result<Option<GameServerRow>, DbError> {
    Ok(sqlx::query_as::<_, GameServerRow>(&format!(
        "SELECT {SERVER_COLUMNS} FROM guild_game_servers WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?)
}

pub async fn list_guild_game_servers(
    pool: &DbPool,
    guild_id: i64,
) -> Result<Vec<GameServerRow>, DbError> {
    Ok(sqlx::query_as::<_, GameServerRow>(&format!(
        "SELECT {SERVER_COLUMNS} FROM guild_game_servers WHERE guild_id = $1 ORDER BY id"
    ))
    .bind(guild_id)
    .fetch_all(pool)
    .await?)
}

pub async fn count_guild_game_servers(pool: &DbPool, guild_id: i64) -> Result<i64, DbError> {
    let row = sqlx::query("SELECT COUNT(*) AS n FROM guild_game_servers WHERE guild_id = $1")
        .bind(guild_id)
        .fetch_one(pool)
        .await?;
    Ok(row.try_get("n")?)
}

/// Listings of one target on servers with the add-on on.
pub async fn list_active_for_target(
    pool: &DbPool,
    target_id: i64,
) -> Result<Vec<GameServerRow>, DbError> {
    Ok(sqlx::query_as::<_, GameServerRow>(&format!(
        "SELECT {SERVER_COLUMNS} FROM guild_game_servers s
         WHERE s.target_id = $1
           AND EXISTS (SELECT 1 FROM guild_game_server_settings g
                       WHERE g.guild_id = s.guild_id
                         AND (CASE WHEN g.enabled THEN 1 ELSE 0 END) = 1)
         ORDER BY s.id"
    ))
    .bind(target_id)
    .fetch_all(pool)
    .await?)
}

pub struct GameServerUpdate<'a> {
    pub target_id: i64,
    pub kind: &'a str,
    pub name: &'a str,
    pub address: &'a str,
    pub announce_channel_id: Option<i64>,
    pub last_state: Option<&'a str>,
}

pub async fn update_game_server(
    pool: &DbPool,
    id: i64,
    update: &GameServerUpdate<'_>,
) -> Result<GameServerRow, DbError> {
    sqlx::query_as::<_, GameServerRow>(&format!(
        "UPDATE guild_game_servers SET target_id = $2, kind = $3, name = $4, address = $5,
                announce_channel_id = $6, last_state = $7, announce_error = NULL,
                updated_at = $8
         WHERE id = $1
         RETURNING {SERVER_COLUMNS}"
    ))
    .bind(id)
    .bind(update.target_id)
    .bind(update.kind)
    .bind(update.name)
    .bind(update.address)
    .bind(update.announce_channel_id)
    .bind(update.last_state)
    .bind(datetime_to_db_text(Utc::now()))
    .fetch_optional(pool)
    .await?
    .ok_or(DbError::NotFound)
}

/// The state a listing last saw, and how its announcement went (`None`
/// clears an earlier problem).
pub async fn record_state(
    pool: &DbPool,
    id: i64,
    state: &str,
    announce_error: Option<&str>,
) -> Result<(), DbError> {
    sqlx::query("UPDATE guild_game_servers SET last_state = $2, announce_error = $3 WHERE id = $1")
        .bind(id)
        .bind(state)
        .bind(announce_error)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_game_server(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM guild_game_servers WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
