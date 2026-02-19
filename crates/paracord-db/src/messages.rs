use crate::{bool_from_any_row, datetime_from_db_text, datetime_to_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use paracord_models::permissions::Permissions;
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct MessageRow {
    pub id: i64,
    pub channel_id: i64,
    pub author_id: i64,
    pub content: Option<String>,
    pub nonce: Option<String>,
    pub message_type: i16,
    pub flags: i32,
    pub edited_at: Option<DateTime<Utc>>,
    pub pinned: bool,
    pub reference_id: Option<i64>,
    pub e2ee_header: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for MessageRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let edited_at_raw: Option<String> = row.try_get("edited_at")?;
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            channel_id: row.try_get("channel_id")?,
            author_id: row.try_get("author_id")?,
            content: row.try_get("content")?,
            nonce: row.try_get("nonce")?,
            message_type: row.try_get("message_type")?,
            flags: row.try_get("flags")?,
            edited_at: edited_at_raw
                .as_deref()
                .map(datetime_from_db_text)
                .transpose()?,
            pinned: bool_from_any_row(row, "pinned")?,
            reference_id: row.try_get("reference_id")?,
            e2ee_header: row.try_get("e2ee_header")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
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
    create_message_with_meta(
        pool,
        id,
        channel_id,
        author_id,
        content,
        message_type,
        reference_id,
        0,
        None,
        None,
    )
    .await
}

pub async fn create_message_with_meta(
    pool: &DbPool,
    id: i64,
    channel_id: i64,
    author_id: i64,
    content: &str,
    message_type: i16,
    reference_id: Option<i64>,
    flags: i32,
    nonce: Option<&str>,
    e2ee_header: Option<&str>,
) -> Result<MessageRow, DbError> {
    let normalized_nonce = nonce.map(str::trim).filter(|value| !value.is_empty());
    let row = match sqlx::query_as::<_, MessageRow>(
        "INSERT INTO messages (id, channel_id, author_id, content, nonce, message_type, flags, reference_id, e2ee_header)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at",
    )
    .bind(id)
    .bind(channel_id)
    .bind(author_id)
    .bind(content)
    .bind(normalized_nonce)
    .bind(message_type)
    .bind(flags)
    .bind(reference_id)
    .bind(e2ee_header)
    .fetch_one(pool)
    .await
    {
        Ok(row) => row,
        Err(err) if normalized_nonce.is_some() && is_nonce_dedup_unique_violation(&err) => {
            let existing =
                get_message_by_channel_author_nonce(pool, channel_id, author_id, normalized_nonce.unwrap())
                    .await?;
            if let Some(existing) = existing {
                return Ok(existing);
            }
            return Err(DbError::Sqlx(err));
        }
        Err(err) => return Err(DbError::Sqlx(err)),
    };

    // Update last_message_id on the channel
    let _ = sqlx::query("UPDATE channels SET last_message_id = $1 WHERE id = $2")
        .bind(row.id)
        .bind(channel_id)
        .execute(pool)
        .await;

    Ok(row)
}

fn is_nonce_dedup_unique_violation(err: &sqlx::Error) -> bool {
    let sqlx::Error::Database(db_err) = err else {
        return false;
    };

    let code_binding = db_err.code();
    let code = code_binding.as_deref().unwrap_or_default();
    if code == "23505" || code == "2067" || code == "1555" {
        return true;
    }

    let message = db_err.message().to_ascii_lowercase();
    message.contains("idx_messages_nonce_dedup_unique")
}

async fn get_message_by_channel_author_nonce(
    pool: &DbPool,
    channel_id: i64,
    author_id: i64,
    nonce: &str,
) -> Result<Option<MessageRow>, DbError> {
    let row = sqlx::query_as::<_, MessageRow>(
        "SELECT id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at
         FROM messages
         WHERE channel_id = $1
           AND author_id = $2
           AND nonce = $3
         ORDER BY created_at ASC, id ASC
         LIMIT 1",
    )
    .bind(channel_id)
    .bind(author_id)
    .bind(nonce)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_message(pool: &DbPool, id: i64) -> Result<Option<MessageRow>, DbError> {
    let row = sqlx::query_as::<_, MessageRow>(
        "SELECT id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at
         FROM messages WHERE id = $1",
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
                "SELECT id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at
                 FROM messages WHERE channel_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3",
            )
            .bind(channel_id)
            .bind(before_id)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        (None, Some(after_id)) => {
            sqlx::query_as::<_, MessageRow>(
                "SELECT id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at
                 FROM messages WHERE channel_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3",
            )
            .bind(channel_id)
            .bind(after_id)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        (None, None) => {
            sqlx::query_as::<_, MessageRow>(
                "SELECT id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at
                 FROM messages WHERE channel_id = $1 ORDER BY id DESC LIMIT $2",
            )
            .bind(channel_id)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
    };
    Ok(rows)
}

pub async fn update_message(pool: &DbPool, id: i64, content: &str) -> Result<MessageRow, DbError> {
    let row = sqlx::query_as::<_, MessageRow>(
        "UPDATE messages SET content = $2, edited_at = datetime('now')
         WHERE id = $1
         RETURNING id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at",
    )
    .bind(id)
    .bind(content)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn update_message_authorized(
    pool: &DbPool,
    id: i64,
    channel_id: i64,
    actor_id: i64,
    content: &str,
) -> Result<Option<MessageRow>, DbError> {
    update_message_authorized_with_meta(pool, id, channel_id, actor_id, content, None, None).await
}

pub async fn update_message_authorized_with_meta(
    pool: &DbPool,
    id: i64,
    channel_id: i64,
    actor_id: i64,
    content: &str,
    nonce: Option<&str>,
    flags: Option<i32>,
) -> Result<Option<MessageRow>, DbError> {
    let manage_messages = Permissions::MANAGE_MESSAGES.bits();
    let administrator = Permissions::ADMINISTRATOR.bits();
    let row = sqlx::query_as::<_, MessageRow>(
        "WITH channel_ctx AS (
             SELECT space_id AS guild_id
             FROM channels
             WHERE id = $2
         ),
         actor_can_manage AS (
             SELECT 1
             FROM channel_ctx ctx
             INNER JOIN spaces s ON s.id = ctx.guild_id
             WHERE s.owner_id = $3

             UNION

             SELECT 1
             FROM channel_ctx ctx
             INNER JOIN members m
                ON m.user_id = $3
               AND m.guild_id = ctx.guild_id
             INNER JOIN roles r
                ON r.space_id = ctx.guild_id
             LEFT JOIN member_roles mr
                ON mr.role_id = r.id
               AND mr.user_id = $3
             WHERE (mr.user_id IS NOT NULL OR r.id = ctx.guild_id)
               AND ((r.permissions & $5) != 0 OR (r.permissions & $6) != 0)
             LIMIT 1
         )
         UPDATE messages
         SET content = $4,
             edited_at = datetime('now'),
             nonce = $7,
             flags = COALESCE($8, flags)
         WHERE id = $1
           AND channel_id = $2
           AND (author_id = $3 OR EXISTS (SELECT 1 FROM actor_can_manage))
         RETURNING id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at",
    )
    .bind(id)
    .bind(channel_id)
    .bind(actor_id)
    .bind(content)
    .bind(manage_messages)
    .bind(administrator)
    .bind(nonce)
    .bind(flags)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn delete_message(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM messages WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_message_authorized(
    pool: &DbPool,
    id: i64,
    channel_id: i64,
    actor_id: i64,
) -> Result<bool, DbError> {
    let manage_messages = Permissions::MANAGE_MESSAGES.bits();
    let administrator = Permissions::ADMINISTRATOR.bits();
    let result = sqlx::query(
        "WITH channel_ctx AS (
             SELECT space_id AS guild_id
             FROM channels
             WHERE id = $2
         ),
         actor_can_manage AS (
             SELECT 1
             FROM channel_ctx ctx
             INNER JOIN spaces s ON s.id = ctx.guild_id
             WHERE s.owner_id = $3

             UNION

             SELECT 1
             FROM channel_ctx ctx
             INNER JOIN members m
                ON m.user_id = $3
               AND m.guild_id = ctx.guild_id
             INNER JOIN roles r
                ON r.space_id = ctx.guild_id
             LEFT JOIN member_roles mr
                ON mr.role_id = r.id
               AND mr.user_id = $3
             WHERE (mr.user_id IS NOT NULL OR r.id = ctx.guild_id)
               AND ((r.permissions & $4) != 0 OR (r.permissions & $5) != 0)
             LIMIT 1
         )
         DELETE FROM messages
         WHERE id = $1
           AND channel_id = $2
           AND (author_id = $3 OR EXISTS (SELECT 1 FROM actor_can_manage))",
    )
    .bind(id)
    .bind(channel_id)
    .bind(actor_id)
    .bind(manage_messages)
    .bind(administrator)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn get_pinned_messages(
    pool: &DbPool,
    channel_id: i64,
) -> Result<Vec<MessageRow>, DbError> {
    let rows = sqlx::query_as::<_, MessageRow>(
        "SELECT id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at
         FROM messages WHERE channel_id = $1 AND pinned = TRUE ORDER BY id ASC",
    )
    .bind(channel_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn pin_message(pool: &DbPool, id: i64, channel_id: i64) -> Result<bool, DbError> {
    let result = sqlx::query("UPDATE messages SET pinned = TRUE WHERE id = $1 AND channel_id = $2")
        .bind(id)
        .bind(channel_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn unpin_message(pool: &DbPool, id: i64, channel_id: i64) -> Result<bool, DbError> {
    let result =
        sqlx::query("UPDATE messages SET pinned = FALSE WHERE id = $1 AND channel_id = $2")
            .bind(id)
            .bind(channel_id)
            .execute(pool)
            .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn bulk_delete_messages(
    pool: &DbPool,
    channel_id: i64,
    ids: &[i64],
) -> Result<u64, DbError> {
    const MAX_BULK_MESSAGE_IDS: usize = 500;
    if ids.is_empty() {
        return Ok(0);
    }
    if ids.len() > MAX_BULK_MESSAGE_IDS {
        return Err(DbError::Sqlx(sqlx::Error::Protocol(
            "too many message ids in bulk delete".to_string(),
        )));
    }
    let placeholders: Vec<String> = (1..=ids.len()).map(|i| format!("${}", i)).collect();
    let channel_bind_index = ids.len() + 1;
    let sql = format!(
        "DELETE FROM messages WHERE id IN ({}) AND channel_id = ${}",
        placeholders.join(", "),
        channel_bind_index
    );
    let mut query = sqlx::query(&sql);
    for id in ids {
        query = query.bind(id);
    }
    query = query.bind(channel_id);
    let result = query.execute(pool).await?;
    Ok(result.rows_affected())
}

pub async fn count_messages(pool: &DbPool) -> Result<i64, DbError> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM messages")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}

pub async fn search_messages(
    pool: &DbPool,
    channel_id: i64,
    query: &str,
    limit: i64,
) -> Result<Vec<MessageRow>, DbError> {
    const MESSAGE_FLAG_DM_E2EE: i32 = 1 << 0;
    let escaped = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{}%", escaped);
    let rows = sqlx::query_as::<_, MessageRow>(
        "SELECT id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at
         FROM messages
         WHERE channel_id = $1
           AND content LIKE $2 ESCAPE '\\'
           AND (flags & $4) = 0
         ORDER BY id DESC
         LIMIT $3",
    )
    .bind(channel_id)
    .bind(pattern)
    .bind(limit)
    .bind(MESSAGE_FLAG_DM_E2EE)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_message_ids_older_than(
    pool: &DbPool,
    older_than: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<i64>, DbError> {
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT id
         FROM messages
         WHERE created_at <= $1
         ORDER BY created_at ASC
         LIMIT $2",
    )
    .bind(datetime_to_db_text(older_than))
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

pub async fn list_messages_by_author(
    pool: &DbPool,
    author_id: i64,
    limit: i64,
) -> Result<Vec<MessageRow>, DbError> {
    let rows = sqlx::query_as::<_, MessageRow>(
        "SELECT id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at
         FROM messages
         WHERE author_id = $1
         ORDER BY id DESC
         LIMIT $2",
    )
    .bind(author_id)
    .bind(limit.clamp(1, 50_000))
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn delete_messages_by_ids(pool: &DbPool, ids: &[i64]) -> Result<u64, DbError> {
    if ids.is_empty() {
        return Ok(0);
    }
    const MAX_DELETE_IDS: usize = 500;
    if ids.len() > MAX_DELETE_IDS {
        return Err(DbError::Sqlx(sqlx::Error::Protocol(
            "too many message ids for delete".to_string(),
        )));
    }
    let placeholders: Vec<String> = (1..=ids.len()).map(|i| format!("${}", i)).collect();
    let sql = format!(
        "DELETE FROM messages WHERE id IN ({})",
        placeholders.join(", ")
    );
    let mut query = sqlx::query(&sql);
    for id in ids {
        query = query.bind(id);
    }
    let result = query.execute(pool).await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> DbPool {
        let pool = crate::create_pool("sqlite::memory:", 1).await.unwrap();
        crate::run_migrations(&pool).await.unwrap();
        pool
    }

    async fn setup_channel(pool: &DbPool) -> (i64, i64, i64) {
        let user_id = 1;
        let guild_id = 100;
        let channel_id = 200;
        crate::users::create_user(pool, user_id, "author", 1, "author@example.com", "hash")
            .await
            .unwrap();
        crate::guilds::create_guild(pool, guild_id, "Test Guild", user_id, None)
            .await
            .unwrap();
        crate::channels::create_channel(pool, channel_id, guild_id, "general", 0, 0, None, None)
            .await
            .unwrap();
        (user_id, guild_id, channel_id)
    }

    #[tokio::test]
    async fn test_create_message() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        let msg = create_message(&pool, 1000, channel_id, user_id, "Hello!", 0, None)
            .await
            .unwrap();
        assert_eq!(msg.id, 1000);
        assert_eq!(msg.channel_id, channel_id);
        assert_eq!(msg.author_id, user_id);
        assert_eq!(msg.content.as_deref(), Some("Hello!"));
        assert_eq!(msg.message_type, 0);
        assert!(!msg.pinned);
        assert!(msg.edited_at.is_none());
        assert!(msg.reference_id.is_none());
    }

    #[tokio::test]
    async fn test_create_message_with_reference() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        create_message(&pool, 1000, channel_id, user_id, "Original", 0, None)
            .await
            .unwrap();
        let reply = create_message(&pool, 1001, channel_id, user_id, "Reply", 0, Some(1000))
            .await
            .unwrap();
        assert_eq!(reply.reference_id, Some(1000));
    }

    #[tokio::test]
    async fn test_get_message() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        create_message(&pool, 2000, channel_id, user_id, "Find me", 0, None)
            .await
            .unwrap();
        let msg = get_message(&pool, 2000).await.unwrap().unwrap();
        assert_eq!(msg.content.as_deref(), Some("Find me"));
    }

    #[tokio::test]
    async fn test_get_message_not_found() {
        let pool = test_pool().await;
        let msg = get_message(&pool, 9999).await.unwrap();
        assert!(msg.is_none());
    }

    #[tokio::test]
    async fn test_get_channel_messages_default_order() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        for i in 0..5 {
            create_message(
                &pool,
                3000 + i,
                channel_id,
                user_id,
                &format!("msg {}", i),
                0,
                None,
            )
            .await
            .unwrap();
        }
        let messages = get_channel_messages(&pool, channel_id, None, None, 50)
            .await
            .unwrap();
        assert_eq!(messages.len(), 5);
        // Default ordering is DESC by id
        assert!(messages[0].id > messages[1].id);
    }

    #[tokio::test]
    async fn test_get_channel_messages_with_before() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        for i in 0..5 {
            create_message(
                &pool,
                4000 + i,
                channel_id,
                user_id,
                &format!("msg {}", i),
                0,
                None,
            )
            .await
            .unwrap();
        }
        let messages = get_channel_messages(&pool, channel_id, Some(4003), None, 50)
            .await
            .unwrap();
        assert_eq!(messages.len(), 3); // 4000, 4001, 4002
        assert!(messages.iter().all(|m| m.id < 4003));
    }

    #[tokio::test]
    async fn test_get_channel_messages_with_after() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        for i in 0..5 {
            create_message(
                &pool,
                5000 + i,
                channel_id,
                user_id,
                &format!("msg {}", i),
                0,
                None,
            )
            .await
            .unwrap();
        }
        let messages = get_channel_messages(&pool, channel_id, None, Some(5002), 50)
            .await
            .unwrap();
        assert_eq!(messages.len(), 2); // 5003, 5004
        assert!(messages.iter().all(|m| m.id > 5002));
    }

    #[tokio::test]
    async fn test_get_channel_messages_with_limit() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        for i in 0..10 {
            create_message(
                &pool,
                6000 + i,
                channel_id,
                user_id,
                &format!("msg {}", i),
                0,
                None,
            )
            .await
            .unwrap();
        }
        let messages = get_channel_messages(&pool, channel_id, None, None, 3)
            .await
            .unwrap();
        assert_eq!(messages.len(), 3);
    }

    #[tokio::test]
    async fn test_update_message() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        create_message(&pool, 7000, channel_id, user_id, "Before", 0, None)
            .await
            .unwrap();
        let updated = update_message(&pool, 7000, "After").await.unwrap();
        assert_eq!(updated.content.as_deref(), Some("After"));
        assert!(updated.edited_at.is_some());
    }

    #[tokio::test]
    async fn test_delete_message() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        create_message(&pool, 8000, channel_id, user_id, "Bye", 0, None)
            .await
            .unwrap();
        delete_message(&pool, 8000).await.unwrap();
        let msg = get_message(&pool, 8000).await.unwrap();
        assert!(msg.is_none());
    }

    #[tokio::test]
    async fn test_search_messages() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        create_message(&pool, 9000, channel_id, user_id, "hello world", 0, None)
            .await
            .unwrap();
        create_message(&pool, 9001, channel_id, user_id, "goodbye world", 0, None)
            .await
            .unwrap();
        create_message(&pool, 9002, channel_id, user_id, "hello again", 0, None)
            .await
            .unwrap();
        let results = search_messages(&pool, channel_id, "hello", 50)
            .await
            .unwrap();
        assert_eq!(results.len(), 2);
    }

    #[tokio::test]
    async fn test_search_messages_no_results() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        create_message(&pool, 9100, channel_id, user_id, "nothing here", 0, None)
            .await
            .unwrap();
        let results = search_messages(&pool, channel_id, "xyz", 50).await.unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn test_pin_and_unpin_message() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        create_message(&pool, 10000, channel_id, user_id, "Pin me", 0, None)
            .await
            .unwrap();

        let pinned = pin_message(&pool, 10000, channel_id).await.unwrap();
        assert!(pinned);

        let pinned_msgs = get_pinned_messages(&pool, channel_id).await.unwrap();
        assert_eq!(pinned_msgs.len(), 1);
        assert_eq!(pinned_msgs[0].id, 10000);

        let unpinned = unpin_message(&pool, 10000, channel_id).await.unwrap();
        assert!(unpinned);

        let pinned_msgs = get_pinned_messages(&pool, channel_id).await.unwrap();
        assert!(pinned_msgs.is_empty());
    }

    #[tokio::test]
    async fn test_bulk_delete_messages() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        for i in 0..5 {
            create_message(
                &pool,
                11000 + i,
                channel_id,
                user_id,
                &format!("msg {}", i),
                0,
                None,
            )
            .await
            .unwrap();
        }
        let deleted = bulk_delete_messages(&pool, channel_id, &[11000, 11001, 11002])
            .await
            .unwrap();
        assert_eq!(deleted, 3);

        let remaining = get_channel_messages(&pool, channel_id, None, None, 50)
            .await
            .unwrap();
        assert_eq!(remaining.len(), 2);
    }

    #[tokio::test]
    async fn test_bulk_delete_empty_ids() {
        let pool = test_pool().await;
        let deleted = bulk_delete_messages(&pool, 1, &[]).await.unwrap();
        assert_eq!(deleted, 0);
    }

    #[tokio::test]
    async fn test_count_messages() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        assert_eq!(count_messages(&pool).await.unwrap(), 0);
        create_message(&pool, 12000, channel_id, user_id, "a", 0, None)
            .await
            .unwrap();
        create_message(&pool, 12001, channel_id, user_id, "b", 0, None)
            .await
            .unwrap();
        assert_eq!(count_messages(&pool).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn test_create_message_with_meta() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        let msg = create_message_with_meta(
            &pool,
            13000,
            channel_id,
            user_id,
            "meta msg",
            0,
            None,
            4,
            Some("nonce-1"),
            None,
        )
        .await
        .unwrap();
        assert_eq!(msg.flags, 4);
        assert_eq!(msg.nonce.as_deref(), Some("nonce-1"));
    }

    #[tokio::test]
    async fn test_create_message_with_meta_dedupes_by_nonce() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        let first = create_message_with_meta(
            &pool,
            13010,
            channel_id,
            user_id,
            "first",
            0,
            None,
            0,
            Some("same-nonce"),
            None,
        )
        .await
        .unwrap();
        let second = create_message_with_meta(
            &pool,
            13011,
            channel_id,
            user_id,
            "second",
            0,
            None,
            0,
            Some("same-nonce"),
            None,
        )
        .await
        .unwrap();

        assert_eq!(second.id, first.id);
        assert_eq!(second.content.as_deref(), Some("first"));
    }

    #[tokio::test]
    async fn test_list_messages_by_author() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        create_message(&pool, 14000, channel_id, user_id, "mine", 0, None)
            .await
            .unwrap();
        create_message(&pool, 14001, channel_id, user_id, "also mine", 0, None)
            .await
            .unwrap();
        let msgs = list_messages_by_author(&pool, user_id, 50).await.unwrap();
        assert_eq!(msgs.len(), 2);
    }

    #[tokio::test]
    async fn test_updates_last_message_id_on_channel() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        create_message(&pool, 15000, channel_id, user_id, "latest", 0, None)
            .await
            .unwrap();
        let ch = crate::channels::get_channel(&pool, channel_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ch.last_message_id, Some(15000));
    }
}
