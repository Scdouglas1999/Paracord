use crate::{datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct ReactionRow {
    pub message_id: i64,
    pub user_id: i64,
    pub emoji_id: Option<i64>,
    pub emoji_name: String,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for ReactionRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            message_id: row.try_get("message_id")?,
            user_id: row.try_get("user_id")?,
            emoji_id: row.try_get("emoji_id")?,
            emoji_name: row.try_get("emoji_name")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ReactionCountRow {
    pub emoji_name: String,
    pub emoji_id: Option<i64>,
    pub count: i64,
}

pub async fn add_reaction(
    pool: &DbPool,
    message_id: i64,
    user_id: i64,
    emoji_name: &str,
    emoji_id: Option<i64>,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO reactions (message_id, user_id, emoji_name, emoji_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (message_id, user_id, emoji_name) DO NOTHING",
    )
    .bind(message_id)
    .bind(user_id)
    .bind(emoji_name)
    .bind(emoji_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn remove_reaction(
    pool: &DbPool,
    message_id: i64,
    user_id: i64,
    emoji_name: &str,
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji_name = $3")
        .bind(message_id)
        .bind(user_id)
        .bind(emoji_name)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_message_reactions(
    pool: &DbPool,
    message_id: i64,
) -> Result<Vec<ReactionCountRow>, DbError> {
    let rows = sqlx::query_as::<_, ReactionCountRow>(
        "SELECT emoji_name, emoji_id, COUNT(*) as count
         FROM reactions WHERE message_id = $1
         GROUP BY emoji_name, emoji_id
         ORDER BY MIN(created_at)",
    )
    .bind(message_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_reaction_users(
    pool: &DbPool,
    message_id: i64,
    emoji_name: &str,
    limit: i64,
) -> Result<Vec<i64>, DbError> {
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT user_id FROM reactions
         WHERE message_id = $1 AND emoji_name = $2
         ORDER BY created_at
         LIMIT $3",
    )
    .bind(message_id)
    .bind(emoji_name)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}
