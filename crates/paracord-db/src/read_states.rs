use crate::{DbError, DbPool};

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ReadStateRow {
    pub user_id: i64,
    pub channel_id: i64,
    pub last_message_id: i64,
    pub mention_count: i32,
}

pub async fn get_user_read_states(
    pool: &DbPool,
    user_id: i64,
) -> Result<Vec<ReadStateRow>, DbError> {
    let rows = sqlx::query_as::<_, ReadStateRow>(
        "SELECT user_id, channel_id, last_message_id, mention_count
         FROM read_states
         WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_read_state(
    pool: &DbPool,
    user_id: i64,
    channel_id: i64,
) -> Result<Option<ReadStateRow>, DbError> {
    let row = sqlx::query_as::<_, ReadStateRow>(
        "SELECT user_id, channel_id, last_message_id, mention_count
         FROM read_states WHERE user_id = $1 AND channel_id = $2",
    )
    .bind(user_id)
    .bind(channel_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn update_read_state(
    pool: &DbPool,
    user_id: i64,
    channel_id: i64,
    last_message_id: i64,
) -> Result<ReadStateRow, DbError> {
    let row = sqlx::query_as::<_, ReadStateRow>(
        "INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count)
         VALUES ($1, $2, $3, 0)
         ON CONFLICT (user_id, channel_id) DO UPDATE SET last_message_id = $3, mention_count = 0
         RETURNING user_id, channel_id, last_message_id, mention_count",
    )
    .bind(user_id)
    .bind(channel_id)
    .bind(last_message_id)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Increment the mention count for a user in a given channel.
/// Creates the read_state row if it doesn't exist yet.
pub async fn increment_mention_count(
    pool: &DbPool,
    user_id: i64,
    channel_id: i64,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count)
         VALUES ($1, $2, 0, 1)
         ON CONFLICT (user_id, channel_id) DO UPDATE SET mention_count = read_states.mention_count + 1",
    )
    .bind(user_id)
    .bind(channel_id)
    .execute(pool)
    .await?;
    Ok(())
}
