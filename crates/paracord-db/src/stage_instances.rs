use crate::{datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct StageInstanceRow {
    pub id: i64,
    pub channel_id: i64,
    pub guild_id: i64,
    pub topic: String,
    pub privacy_level: i32,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for StageInstanceRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            channel_id: row.try_get("channel_id")?,
            guild_id: row.try_get("guild_id")?,
            topic: row.try_get("topic")?,
            privacy_level: row.try_get("privacy_level")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

pub async fn create_stage_instance(
    pool: &DbPool,
    id: i64,
    channel_id: i64,
    guild_id: i64,
    topic: &str,
    privacy_level: i32,
) -> Result<StageInstanceRow, DbError> {
    let row = sqlx::query_as::<_, StageInstanceRow>(
        "INSERT INTO stage_instances (id, channel_id, guild_id, topic, privacy_level)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, channel_id, guild_id, topic, privacy_level,
                   CAST(created_at AS TEXT) AS created_at",
    )
    .bind(id)
    .bind(channel_id)
    .bind(guild_id)
    .bind(topic)
    .bind(privacy_level)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn get_stage_instance_by_channel(
    pool: &DbPool,
    channel_id: i64,
) -> Result<Option<StageInstanceRow>, DbError> {
    let row = sqlx::query_as::<_, StageInstanceRow>(
        "SELECT id, channel_id, guild_id, topic, privacy_level,
                CAST(created_at AS TEXT) AS created_at
         FROM stage_instances WHERE channel_id = $1",
    )
    .bind(channel_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_stage_instance(
    pool: &DbPool,
    id: i64,
) -> Result<Option<StageInstanceRow>, DbError> {
    let row = sqlx::query_as::<_, StageInstanceRow>(
        "SELECT id, channel_id, guild_id, topic, privacy_level,
                CAST(created_at AS TEXT) AS created_at
         FROM stage_instances WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn update_stage_instance(
    pool: &DbPool,
    id: i64,
    topic: Option<&str>,
    privacy_level: Option<i32>,
) -> Result<StageInstanceRow, DbError> {
    let row = sqlx::query_as::<_, StageInstanceRow>(
        "UPDATE stage_instances
         SET topic = COALESCE($2, topic),
             privacy_level = COALESCE($3, privacy_level)
         WHERE id = $1
         RETURNING id, channel_id, guild_id, topic, privacy_level,
                   CAST(created_at AS TEXT) AS created_at",
    )
    .bind(id)
    .bind(topic)
    .bind(privacy_level)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn delete_stage_instance(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM stage_instances WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
