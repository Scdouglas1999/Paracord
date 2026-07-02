use crate::{datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

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
    let row = sqlx::query_as::<_, ChannelFollowRow>(
        "INSERT INTO channel_follows (source_channel_id, target_channel_id, target_guild_id)
         VALUES ($1, $2, $3)
         RETURNING id, source_channel_id, target_channel_id, target_guild_id, created_at",
    )
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
    let rows = sqlx::query_as::<_, ChannelFollowRow>(
        "SELECT id, source_channel_id, target_channel_id, target_guild_id, created_at
         FROM channel_follows WHERE source_channel_id = $1",
    )
    .bind(source_channel_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}
