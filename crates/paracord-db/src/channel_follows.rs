use crate::{active_database_engine, datetime_from_db_text, DatabaseEngine, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

/// SQL expression that renders the native `created_at` column as plain text in
/// the `datetime_from_db_text` format. The `channel_follows` migrations declare
/// `created_at` as a native `TIMESTAMP`/`TIMESTAMPTZ`, which the sqlx `Any`
/// driver refuses to decode into `String`; selecting a text cast instead keeps
/// both the SQLite and Postgres read paths working without editing the shipped
/// (checksum-validated) migrations.
fn created_at_text_expr() -> &'static str {
    match active_database_engine() {
        DatabaseEngine::Sqlite => "CAST(created_at AS TEXT)",
        DatabaseEngine::Postgres => {
            "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')"
        }
    }
}

#[derive(Debug, Clone)]
pub struct ChannelFollowRow {
    pub id: i64,
    pub source_channel_id: i64,
    pub target_channel_id: i64,
    pub target_guild_id: i64,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for ChannelFollowRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            source_channel_id: row.try_get("source_channel_id")?,
            target_channel_id: row.try_get("target_channel_id")?,
            target_guild_id: row.try_get("target_guild_id")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

pub async fn create_follow(
    pool: &DbPool,
    source_channel_id: i64,
    target_channel_id: i64,
    target_guild_id: i64,
) -> Result<ChannelFollowRow, DbError> {
    // Let the column DEFAULT populate `created_at`: this is the one native
    // TIMESTAMP/TIMESTAMPTZ column in the crate, so writing it via
    // DEFAULT CURRENT_TIMESTAMP (SQLite) / DEFAULT NOW() (Postgres) is correct on
    // both engines — unlike binding a text parameter, which Postgres will not
    // implicitly coerce into a timestamptz column. The native value is then read
    // back through a text cast (`created_at_text_expr`) because the sqlx `Any`
    // driver cannot decode a native timestamp into `String` directly.
    let sql = format!(
        "INSERT INTO channel_follows (source_channel_id, target_channel_id, target_guild_id)
         VALUES ($1, $2, $3)
         RETURNING id, source_channel_id, target_channel_id, target_guild_id, {} AS created_at",
        created_at_text_expr()
    );
    let row = sqlx::query_as::<_, ChannelFollowRow>(&sql)
        .bind(source_channel_id)
        .bind(target_channel_id)
        .bind(target_guild_id)
        .fetch_one(pool)
        .await?;
    Ok(row)
}

pub async fn delete_follow(
    pool: &DbPool,
    source_channel_id: i64,
    target_channel_id: i64,
) -> Result<(), DbError> {
    sqlx::query(
        "DELETE FROM channel_follows WHERE source_channel_id = $1 AND target_channel_id = $2",
    )
    .bind(source_channel_id)
    .bind(target_channel_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_follows_for_channel(
    pool: &DbPool,
    source_channel_id: i64,
) -> Result<Vec<ChannelFollowRow>, DbError> {
    let sql = format!(
        "SELECT id, source_channel_id, target_channel_id, target_guild_id, {} AS created_at
         FROM channel_follows WHERE source_channel_id = $1",
        created_at_text_expr()
    );
    let rows = sqlx::query_as::<_, ChannelFollowRow>(&sql)
        .bind(source_channel_id)
        .fetch_all(pool)
        .await?;
    Ok(rows)
}
