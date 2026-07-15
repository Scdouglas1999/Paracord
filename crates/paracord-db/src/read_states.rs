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
         ON CONFLICT (user_id, channel_id) DO UPDATE SET
             last_message_id = CASE
                 WHEN excluded.last_message_id > read_states.last_message_id
                 THEN excluded.last_message_id
                 ELSE read_states.last_message_id
             END,
             mention_count = 0
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

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> DbPool {
        let pool = crate::create_pool("sqlite::memory:", 1).await.unwrap();
        sqlx::query(
            "CREATE TABLE read_states (
                user_id BIGINT NOT NULL,
                channel_id BIGINT NOT NULL,
                last_message_id BIGINT NOT NULL DEFAULT 0,
                mention_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, channel_id)
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn delayed_read_update_cannot_move_cursor_backwards() {
        let pool = test_pool().await;
        update_read_state(&pool, 1, 2, 200).await.unwrap();
        increment_mention_count(&pool, 1, 2).await.unwrap();

        let row = update_read_state(&pool, 1, 2, 100).await.unwrap();
        assert_eq!(row.last_message_id, 200);
        assert_eq!(row.mention_count, 0);
    }

    #[tokio::test]
    async fn newer_read_update_advances_cursor() {
        let pool = test_pool().await;
        update_read_state(&pool, 1, 2, 100).await.unwrap();

        let row = update_read_state(&pool, 1, 2, 200).await.unwrap();
        assert_eq!(row.last_message_id, 200);
    }
}
