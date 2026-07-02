use crate::{datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct StickerRow {
    pub id: i64,
    pub guild_id: i64,
    pub name: String,
    pub description: Option<String>,
    pub format_type: i16,
    pub asset_key: Option<String>,
    pub asset_content_type: Option<String>,
    pub creator_id: Option<i64>,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for StickerRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            guild_id: row.try_get("guild_id")?,
            name: row.try_get("name")?,
            description: row.try_get("description")?,
            format_type: row.try_get("format_type")?,
            asset_key: row.try_get("asset_key")?,
            asset_content_type: row.try_get("asset_content_type")?,
            creator_id: row.try_get("creator_id")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

pub async fn create_sticker(
    pool: &DbPool,
    id: i64,
    guild_id: i64,
    name: &str,
    description: Option<&str>,
    format_type: i16,
    asset_key: Option<&str>,
    asset_content_type: Option<&str>,
    creator_id: Option<i64>,
) -> Result<StickerRow, DbError> {
    let row = sqlx::query_as::<_, StickerRow>(
        "INSERT INTO stickers (
            id, guild_id, name, description, format_type, asset_key, asset_content_type, creator_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, guild_id, name, description, format_type, asset_key, asset_content_type,
                   creator_id, created_at",
    )
    .bind(id)
    .bind(guild_id)
    .bind(name)
    .bind(description)
    .bind(format_type)
    .bind(asset_key)
    .bind(asset_content_type)
    .bind(creator_id)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn list_stickers(pool: &DbPool, guild_id: i64) -> Result<Vec<StickerRow>, DbError> {
    let rows = sqlx::query_as::<_, StickerRow>(
        "SELECT id, guild_id, name, description, format_type, asset_key, asset_content_type,
                creator_id, created_at
         FROM stickers
         WHERE guild_id = $1
         ORDER BY created_at DESC",
    )
    .bind(guild_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_sticker(pool: &DbPool, sticker_id: i64) -> Result<Option<StickerRow>, DbError> {
    let row = sqlx::query_as::<_, StickerRow>(
        "SELECT id, guild_id, name, description, format_type, asset_key, asset_content_type,
                creator_id, created_at
         FROM stickers
         WHERE id = $1",
    )
    .bind(sticker_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn delete_sticker(pool: &DbPool, sticker_id: i64) -> Result<bool, DbError> {
    let result = sqlx::query("DELETE FROM stickers WHERE id = $1")
        .bind(sticker_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn attach_stickers_to_message(
    pool: &DbPool,
    message_id: i64,
    sticker_ids: &[i64],
) -> Result<(), DbError> {
    if sticker_ids.is_empty() {
        return Ok(());
    }
    for sticker_id in sticker_ids {
        sqlx::query(
            "INSERT INTO message_stickers (message_id, sticker_id)
             VALUES ($1, $2)
             ON CONFLICT(message_id, sticker_id) DO NOTHING",
        )
        .bind(message_id)
        .bind(*sticker_id)
        .execute(pool)
        .await?;
    }
    Ok(())
}

pub async fn list_message_stickers(
    pool: &DbPool,
    message_id: i64,
) -> Result<Vec<StickerRow>, DbError> {
    let rows = sqlx::query_as::<_, StickerRow>(
        "SELECT s.id, s.guild_id, s.name, s.description, s.format_type, s.asset_key, s.asset_content_type,
                s.creator_id, s.created_at
         FROM message_stickers ms
         INNER JOIN stickers s ON s.id = ms.sticker_id
         WHERE ms.message_id = $1
         ORDER BY s.created_at ASC",
    )
    .bind(message_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}
