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

/// Distinct emoji a single message may carry.
///
/// Reactions are read on the hottest path in the product: every `GET /messages`
/// page aggregates them for up to 100 messages at once. Nothing bounded the
/// number of *distinct* emoji on a message -- the route only limited each
/// emoji's length -- so one authenticated member could permanently attach an
/// unbounded set to a message and make every subsequent read of that channel
/// page proportionally more expensive. 20 matches what clients render before
/// collapsing and is the same ceiling Discord applies.
pub const MAX_REACTIONS_PER_MESSAGE: i64 = 20;

pub async fn add_reaction(
    pool: &DbPool,
    message_id: i64,
    user_id: i64,
    emoji_name: &str,
    emoji_id: Option<i64>,
) -> Result<(), DbError> {
    // Adding to an emoji the message already carries never widens the
    // aggregate, so only a *new* emoji is gated. Two concurrent inserts can
    // race past the count and land at cap+1; the read side is bounded
    // independently, so the overshoot stays cosmetic.
    let distinct: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT emoji_name) FROM reactions WHERE message_id = $1",
    )
    .bind(message_id)
    .fetch_one(pool)
    .await?;
    if distinct >= MAX_REACTIONS_PER_MESSAGE {
        let already_present: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM reactions WHERE message_id = $1 AND emoji_name = $2",
        )
        .bind(message_id)
        .bind(emoji_name)
        .fetch_one(pool)
        .await?;
        if already_present == 0 {
            return Err(DbError::LimitReached(format!(
                "this message already has the maximum of {MAX_REACTIONS_PER_MESSAGE} different reactions"
            )));
        }
    }

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
    // `LIMIT` mirrors the insert-side cap so a message that predates it (or one
    // that raced past it) cannot make this read unbounded.
    let rows = sqlx::query_as::<_, ReactionCountRow>(
        "SELECT emoji_name, emoji_id, COUNT(*) as count
         FROM reactions WHERE message_id = $1
         GROUP BY emoji_name, emoji_id
         ORDER BY MIN(created_at)
         LIMIT $2",
    )
    .bind(message_id)
    .bind(MAX_REACTIONS_PER_MESSAGE)
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
    // One page of messages can contribute at most `MAX_REACTIONS_PER_MESSAGE`
    // aggregate rows each. The insert side already enforces that per message,
    // so this ceiling is unreachable in practice; it exists so rows written
    // before the cap (or by a racing insert) cannot make the hottest read path
    // in the product unbounded.
    let limit = MAX_REACTIONS_PER_MESSAGE.saturating_mul(message_ids.len() as i64);
    let sql = format!(
        "SELECT message_id, emoji_name, emoji_id, COUNT(*) as count
         FROM reactions
         WHERE message_id IN ({})
         GROUP BY message_id, emoji_name, emoji_id
         ORDER BY message_id, MIN(created_at)
         LIMIT ${}",
        placeholders,
        message_ids.len() + 1,
    );
    let mut query = sqlx::query_as::<_, BatchReactionCountRow>(&sql);
    for message_id in message_ids {
        query = query.bind(message_id);
    }
    query = query.bind(limit);
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
    // Same ceiling as `get_reactions_for_message_ids`: one viewer can hold at
    // most one row per distinct emoji per message.
    let limit = MAX_REACTIONS_PER_MESSAGE.saturating_mul(message_ids.len() as i64);
    let sql = format!(
        "SELECT message_id, emoji_name
         FROM reactions
         WHERE message_id IN ({}) AND user_id = ${}
         ORDER BY message_id
         LIMIT ${}",
        placeholders,
        viewer_bind_index,
        viewer_bind_index + 1,
    );
    let mut query = sqlx::query_as::<_, ViewerReactionRow>(&sql);
    for message_id in message_ids {
        query = query.bind(message_id);
    }
    query = query.bind(viewer_id);
    query = query.bind(limit);
    let rows = query.fetch_all(pool).await?;
    Ok(rows)
}
