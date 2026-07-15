use crate::{datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct SavedMessageRow {
    pub message_id: i64,
    pub saved_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for SavedMessageRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let saved_at_raw: String = row.try_get("saved_at")?;
        Ok(Self {
            message_id: row.try_get("message_id")?,
            saved_at: datetime_from_db_text(&saved_at_raw)?,
        })
    }
}

pub async fn save_message(
    pool: &DbPool,
    user_id: i64,
    message_id: i64,
) -> Result<SavedMessageRow, DbError> {
    let row = sqlx::query_as::<_, SavedMessageRow>(
        "INSERT INTO saved_messages (user_id, message_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, message_id) DO UPDATE SET saved_at = saved_messages.saved_at
         RETURNING message_id, CAST(saved_at AS TEXT) AS saved_at",
    )
    .bind(user_id)
    .bind(message_id)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn remove_saved_message(
    pool: &DbPool,
    user_id: i64,
    message_id: i64,
) -> Result<bool, DbError> {
    let result = sqlx::query("DELETE FROM saved_messages WHERE user_id = $1 AND message_id = $2")
        .bind(user_id)
        .bind(message_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn list_saved_messages(
    pool: &DbPool,
    user_id: i64,
    limit: i64,
) -> Result<Vec<SavedMessageRow>, DbError> {
    let rows = sqlx::query_as::<_, SavedMessageRow>(
        "SELECT message_id, CAST(saved_at AS TEXT) AS saved_at
         FROM saved_messages
         WHERE user_id = $1
         ORDER BY saved_at DESC, message_id DESC
         LIMIT $2",
    )
    .bind(user_id)
    .bind(limit.clamp(1, 100))
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn count_saved_messages(pool: &DbPool, user_id: i64) -> Result<i64, DbError> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM saved_messages WHERE user_id = $1")
        .bind(user_id)
        .fetch_one(pool)
        .await?;
    Ok(count)
}
