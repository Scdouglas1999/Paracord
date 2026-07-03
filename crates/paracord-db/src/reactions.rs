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

/// Aggregated reaction counts for a batch of messages. Carries `message_id` so
/// callers can group the flat result back onto individual messages.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct BatchReactionCountRow {
    pub message_id: i64,
    pub emoji_name: String,
    pub emoji_id: Option<i64>,
    pub count: i64,
}

/// A `(message_id, emoji_name)` pair identifying a reaction the viewer added.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ViewerReactionRow {
    pub message_id: i64,
    pub emoji_name: String,
}

const MAX_MESSAGE_IDS: usize = 500;

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

/// Aggregated reaction counts for many messages in a single query.
///
/// Rows are ordered by `message_id`, then by the earliest reaction of each
/// emoji (`MIN(created_at)`), preserving the per-message ordering produced by
/// [`get_message_reactions`] so callers can build byte-stable JSON.
pub async fn get_reactions_for_message_ids(
    pool: &DbPool,
    message_ids: &[i64],
) -> Result<Vec<BatchReactionCountRow>, DbError> {
    if message_ids.is_empty() {
        return Ok(Vec::new());
    }
    if message_ids.len() > MAX_MESSAGE_IDS {
        return Err(DbError::Sqlx(sqlx::Error::Protocol(
            "too many message ids in reaction lookup".to_string(),
        )));
    }

    let placeholders = crate::messages::build_placeholders(1, message_ids.len());
    let sql = format!(
        "SELECT message_id, emoji_name, emoji_id, COUNT(*) as count
         FROM reactions
         WHERE message_id IN ({})
         GROUP BY message_id, emoji_name, emoji_id
         ORDER BY message_id, MIN(created_at)",
        placeholders,
    );
    let mut query = sqlx::query_as::<_, BatchReactionCountRow>(&sql);
    for message_id in message_ids {
        query = query.bind(message_id);
    }
    let rows = query.fetch_all(pool).await?;
    Ok(rows)
}

/// Returns, for the given viewer, every `(message_id, emoji_name)` the viewer
/// has reacted with across the supplied messages in a single query. Callers use
/// this to compute each reaction's `me` flag without per-reaction user fetches.
pub async fn get_viewer_reactions_for_message_ids(
    pool: &DbPool,
    message_ids: &[i64],
    viewer_id: i64,
) -> Result<Vec<ViewerReactionRow>, DbError> {
    if message_ids.is_empty() {
        return Ok(Vec::new());
    }
    if message_ids.len() > MAX_MESSAGE_IDS {
        return Err(DbError::Sqlx(sqlx::Error::Protocol(
            "too many message ids in viewer reaction lookup".to_string(),
        )));
    }

    let placeholders = crate::messages::build_placeholders(1, message_ids.len());
    let viewer_bind_index = message_ids.len() + 1;
    let sql = format!(
        "SELECT message_id, emoji_name
         FROM reactions
         WHERE message_id IN ({}) AND user_id = ${}",
        placeholders, viewer_bind_index,
    );
    let mut query = sqlx::query_as::<_, ViewerReactionRow>(&sql);
    for message_id in message_ids {
        query = query.bind(message_id);
    }
    query = query.bind(viewer_id);
    let rows = query.fetch_all(pool).await?;
    Ok(rows)
}
