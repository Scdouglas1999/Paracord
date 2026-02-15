use crate::{DbError, DbPool};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MessageRow {
    pub id: i64,
    pub channel_id: i64,
    pub author_id: i64,
    pub content: Option<String>,
    pub message_type: i16,
    pub flags: i32,
    pub edited_at: Option<DateTime<Utc>>,
    pub pinned: bool,
    pub reference_id: Option<i64>,
    pub created_at: DateTime<Utc>,
}

pub async fn create_message(
    pool: &DbPool,
    id: i64,
    channel_id: i64,
    author_id: i64,
    content: &str,
    message_type: i16,
    reference_id: Option<i64>,
) -> Result<MessageRow, DbError> {
    let row = sqlx::query_as::<_, MessageRow>(
        "INSERT INTO messages (id, channel_id, author_id, content, message_type, reference_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         RETURNING id, channel_id, author_id, content, message_type, flags, edited_at, pinned, reference_id, created_at"
    )
    .bind(id)
    .bind(channel_id)
    .bind(author_id)
    .bind(content)
    .bind(message_type)
    .bind(reference_id)
    .fetch_one(pool)
    .await?;

    // Update last_message_id on the channel
    let _ = sqlx::query("UPDATE channels SET last_message_id = ?1 WHERE id = ?2")
        .bind(id)
        .bind(channel_id)
        .execute(pool)
        .await;

    Ok(row)
}

pub async fn get_message(pool: &DbPool, id: i64) -> Result<Option<MessageRow>, DbError> {
    let row = sqlx::query_as::<_, MessageRow>(
        "SELECT id, channel_id, author_id, content, message_type, flags, edited_at, pinned, reference_id, created_at
         FROM messages WHERE id = ?1"
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_channel_messages(
    pool: &DbPool,
    channel_id: i64,
    before: Option<i64>,
    after: Option<i64>,
    limit: i64,
) -> Result<Vec<MessageRow>, DbError> {
    let rows = match (before, after) {
        (Some(before_id), _) => {
            sqlx::query_as::<_, MessageRow>(
                "SELECT id, channel_id, author_id, content, message_type, flags, edited_at, pinned, reference_id, created_at
                 FROM messages WHERE channel_id = ?1 AND id < ?2 ORDER BY id DESC LIMIT ?3"
            )
            .bind(channel_id)
            .bind(before_id)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        (None, Some(after_id)) => {
            sqlx::query_as::<_, MessageRow>(
                "SELECT id, channel_id, author_id, content, message_type, flags, edited_at, pinned, reference_id, created_at
                 FROM messages WHERE channel_id = ?1 AND id > ?2 ORDER BY id ASC LIMIT ?3"
            )
            .bind(channel_id)
            .bind(after_id)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        (None, None) => {
            sqlx::query_as::<_, MessageRow>(
                "SELECT id, channel_id, author_id, content, message_type, flags, edited_at, pinned, reference_id, created_at
                 FROM messages WHERE channel_id = ?1 ORDER BY id DESC LIMIT ?2"
            )
            .bind(channel_id)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
    };
    Ok(rows)
}

pub async fn update_message(
    pool: &DbPool,
    id: i64,
    content: &str,
) -> Result<MessageRow, DbError> {
    let row = sqlx::query_as::<_, MessageRow>(
        "UPDATE messages SET content = ?2, edited_at = datetime('now')
         WHERE id = ?1
         RETURNING id, channel_id, author_id, content, message_type, flags, edited_at, pinned, reference_id, created_at"
    )
    .bind(id)
    .bind(content)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn delete_message(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM messages WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_pinned_messages(
    pool: &DbPool,
    channel_id: i64,
) -> Result<Vec<MessageRow>, DbError> {
    let rows = sqlx::query_as::<_, MessageRow>(
        "SELECT id, channel_id, author_id, content, message_type, flags, edited_at, pinned, reference_id, created_at
         FROM messages WHERE channel_id = ?1 AND pinned = TRUE ORDER BY id ASC"
    )
    .bind(channel_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn pin_message(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("UPDATE messages SET pinned = TRUE WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn unpin_message(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("UPDATE messages SET pinned = FALSE WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn bulk_delete_messages(pool: &DbPool, channel_id: i64, ids: &[i64]) -> Result<u64, DbError> {
    if ids.is_empty() {
        return Ok(0);
    }
    // Offset placeholders: ?1 is channel_id, message IDs start at ?2
    let placeholders: Vec<String> = (2..=ids.len() + 1).map(|i| format!("?{}", i)).collect();
    let sql = format!(
        "DELETE FROM messages WHERE channel_id = ?1 AND id IN ({})",
        placeholders.join(", ")
    );
    let mut query = sqlx::query(&sql).bind(channel_id);
    for id in ids {
        query = query.bind(id);
    }
    let result = query.execute(pool).await?;
    Ok(result.rows_affected())
}

pub async fn count_messages(pool: &DbPool) -> Result<i64, DbError> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM messages")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}

fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

pub async fn search_messages(
    pool: &DbPool,
    channel_id: i64,
    query: &str,
    limit: i64,
) -> Result<Vec<MessageRow>, DbError> {
    let pattern = format!("%{}%", escape_like(query));
    let rows = sqlx::query_as::<_, MessageRow>(
        "SELECT id, channel_id, author_id, content, message_type, flags, edited_at, pinned, reference_id, created_at
         FROM messages
         WHERE channel_id = ?1 AND content LIKE ?2 ESCAPE '\\'
         ORDER BY id DESC
         LIMIT ?3"
    )
    .bind(channel_id)
    .bind(pattern)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}
