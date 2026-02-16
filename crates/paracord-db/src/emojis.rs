use crate::{bool_from_any_row, datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct EmojiRow {
    pub id: i64,
    pub guild_id: i64,
    pub name: String,
    pub creator_id: Option<i64>,
    pub animated: bool,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for EmojiRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            guild_id: row.try_get("guild_id")?,
            name: row.try_get("name")?,
            creator_id: row.try_get("creator_id")?,
            animated: bool_from_any_row(row, "animated")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

pub async fn create_emoji(
    pool: &DbPool,
    id: i64,
    guild_id: i64,
    name: &str,
    creator_id: i64,
    animated: bool,
) -> Result<EmojiRow, DbError> {
    let row = sqlx::query_as::<_, EmojiRow>(
        "INSERT INTO emojis (id, space_id, name, creator_id, animated)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, space_id AS guild_id, name, creator_id, animated, created_at",
    )
    .bind(id)
    .bind(guild_id)
    .bind(name)
    .bind(creator_id)
    .bind(animated)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn get_emoji(pool: &DbPool, id: i64) -> Result<Option<EmojiRow>, DbError> {
    let row = sqlx::query_as::<_, EmojiRow>(
        "SELECT id, space_id AS guild_id, name, creator_id, animated, created_at
         FROM emojis WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_guild_emojis(pool: &DbPool, guild_id: i64) -> Result<Vec<EmojiRow>, DbError> {
    let rows = sqlx::query_as::<_, EmojiRow>(
        "SELECT id, space_id AS guild_id, name, creator_id, animated, created_at
         FROM emojis WHERE space_id = $1 ORDER BY name",
    )
    .bind(guild_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn update_emoji(pool: &DbPool, id: i64, name: &str) -> Result<EmojiRow, DbError> {
    let row = sqlx::query_as::<_, EmojiRow>(
        "UPDATE emojis SET name = $2
         WHERE id = $1
         RETURNING id, space_id AS guild_id, name, creator_id, animated, created_at",
    )
    .bind(id)
    .bind(name)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn delete_emoji(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM emojis WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
