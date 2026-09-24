use crate::{datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct SoundboardSoundRow {
    pub id: i64,
    pub guild_id: i64,
    pub name: String,
    /// Unicode emoji or a `<:name:id>` custom-emoji token; empty/NULL means the
    /// client draws the generic speaker mark.
    pub emoji: Option<String>,
    /// 0..=100 percent, combined client-side with the listener's own
    /// soundboard volume.
    pub volume: i32,
    pub duration_ms: i64,
    pub content_type: String,
    pub size: i64,
    pub asset_key: String,
    pub creator_id: Option<i64>,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for SoundboardSoundRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            guild_id: row.try_get("guild_id")?,
            name: row.try_get("name")?,
            emoji: row.try_get("emoji")?,
            volume: row.try_get("volume")?,
            duration_ms: row.try_get("duration_ms")?,
            content_type: row.try_get("content_type")?,
            size: row.try_get("size")?,
            asset_key: row.try_get("asset_key")?,
            creator_id: row.try_get("creator_id")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

const SOUND_COLUMNS: &str = "id, guild_id, name, emoji, volume, duration_ms,
       content_type, size, asset_key, creator_id, created_at";

pub async fn create_sound(
    pool: &DbPool,
    id: i64,
    guild_id: i64,
    name: &str,
    emoji: Option<&str>,
    volume: i32,
    duration_ms: i64,
    content_type: &str,
    size: i64,
    asset_key: &str,
    creator_id: Option<i64>,
) -> Result<SoundboardSoundRow, DbError> {
    let row = sqlx::query_as::<_, SoundboardSoundRow>(
        "INSERT INTO soundboard_sounds (
            id, guild_id, name, emoji, volume, duration_ms, content_type, size, asset_key, creator_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, guild_id, name, emoji, volume, duration_ms, content_type, size,
                   asset_key, creator_id, created_at",
    )
    .bind(id)
    .bind(guild_id)
    .bind(name)
    .bind(emoji)
    .bind(volume)
    .bind(duration_ms)
    .bind(content_type)
    .bind(size)
    .bind(asset_key)
    .bind(creator_id)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn list_sounds(pool: &DbPool, guild_id: i64) -> Result<Vec<SoundboardSoundRow>, DbError> {
    let rows = sqlx::query_as::<_, SoundboardSoundRow>(&format!(
        "SELECT {SOUND_COLUMNS}
         FROM soundboard_sounds
         WHERE guild_id = $1
         ORDER BY name COLLATE NOCASE ASC"
    ))
    .bind(guild_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn count_sounds(pool: &DbPool, guild_id: i64) -> Result<i64, DbError> {
    let row = sqlx::query("SELECT COUNT(*) AS count FROM soundboard_sounds WHERE guild_id = $1")
        .bind(guild_id)
        .fetch_one(pool)
        .await?;
    Ok(row.try_get("count")?)
}

pub async fn get_sound(
    pool: &DbPool,
    sound_id: i64,
) -> Result<Option<SoundboardSoundRow>, DbError> {
    let row = sqlx::query_as::<_, SoundboardSoundRow>(&format!(
        "SELECT {SOUND_COLUMNS}
         FROM soundboard_sounds
         WHERE id = $1"
    ))
    .bind(sound_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn update_sound(
    pool: &DbPool,
    sound_id: i64,
    name: &str,
    emoji: Option<&str>,
    volume: i32,
) -> Result<SoundboardSoundRow, DbError> {
    let row = sqlx::query_as::<_, SoundboardSoundRow>(&format!(
        "UPDATE soundboard_sounds
         SET name = $2, emoji = $3, volume = $4
         WHERE id = $1
         RETURNING {SOUND_COLUMNS}"
    ))
    .bind(sound_id)
    .bind(name)
    .bind(emoji)
    .bind(volume)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn delete_sound(pool: &DbPool, sound_id: i64) -> Result<bool, DbError> {
    let result = sqlx::query("DELETE FROM soundboard_sounds WHERE id = $1")
        .bind(sound_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}
