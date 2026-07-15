use crate::{bool_from_any_row, datetime_from_db_text, datetime_to_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use paracord_models::id::{ChannelId, MessageId, UserId};
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
    /// JSON-serialized array of embeds (OpenGraph / rich link previews).
    pub embeds: Option<String>,
    /// JSON-serialized array of bot/application message components.
    pub components: Option<String>,
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
            embeds: row.try_get("embeds").ok(),
            components: row.try_get("components").ok(),
        })
    }
}

/// Raw i64 shim kept for API compat.
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

/// Core implementation using newtype IDs.
pub async fn create_message_typed(
    pool: &DbPool,
    id: MessageId,
    channel_id: ChannelId,
    author_id: UserId,
    content: &str,
    message_type: i16,
    reference_id: Option<MessageId>,
) -> Result<MessageRow, DbError> {
    create_message_with_meta_typed(
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

/// Core implementation using newtype IDs.
pub async fn create_message_with_meta_typed(
    pool: &DbPool,
    id: MessageId,
    channel_id: ChannelId,
    author_id: UserId,
    content: &str,
    message_type: i16,
    reference_id: Option<MessageId>,
    flags: i32,
    nonce: Option<&str>,
    e2ee_header: Option<&str>,
) -> Result<MessageRow, DbError> {
    create_message_with_payload_typed(
        pool,
        id,
        channel_id,
        author_id,
        content,
        message_type,
        reference_id,
        flags,
        nonce,
        e2ee_header,
        None,
        None,
    )
    .await
}

/// Core implementation using newtype IDs, including optional rich payload JSON.
pub async fn create_message_with_payload_typed(
    pool: &DbPool,
    id: MessageId,
    channel_id: ChannelId,
    author_id: UserId,
    content: &str,
    message_type: i16,
    reference_id: Option<MessageId>,
    flags: i32,
    nonce: Option<&str>,
    e2ee_header: Option<&str>,
    components_json: Option<&str>,
    embeds_json: Option<&str>,
) -> Result<MessageRow, DbError> {
    let normalized_nonce = nonce.map(str::trim).filter(|value| !value.is_empty());
    let row = match sqlx::query_as::<_, MessageRow>(
        "INSERT INTO messages (id, channel_id, author_id, content, nonce, message_type, flags, reference_id, e2ee_header, components, embeds)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components",
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
    .bind(components_json)
    .bind(embeds_json)
    .fetch_one(pool)
    .await
    {
        Ok(row) => row,
        Err(err) if normalized_nonce.is_some() && is_nonce_dedup_unique_violation(&err) => {
            let existing =
                get_message_by_channel_author_nonce_typed(pool, channel_id, author_id, normalized_nonce.unwrap())
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

/// Raw i64 shim kept for API compat.
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
    create_message_with_meta_typed(
        pool,
        MessageId::new(id),
        ChannelId::new(channel_id),
        UserId::new(author_id),
        content,
        message_type,
        reference_id.map(MessageId::new),
        flags,
        nonce,
        e2ee_header,
    )
    .await
}

/// Raw i64 shim kept for API compat.
pub async fn create_message_with_payload(
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
    components_json: Option<&str>,
    embeds_json: Option<&str>,
) -> Result<MessageRow, DbError> {
    create_message_with_payload_typed(
        pool,
        MessageId::new(id),
        ChannelId::new(channel_id),
        UserId::new(author_id),
        content,
        message_type,
        reference_id.map(MessageId::new),
        flags,
        nonce,
        e2ee_header,
        components_json,
        embeds_json,
    )
    .await
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

async fn get_message_by_channel_author_nonce_typed(
    pool: &DbPool,
    channel_id: ChannelId,
    author_id: UserId,
    nonce: &str,
) -> Result<Option<MessageRow>, DbError> {
    let row = sqlx::query_as::<_, MessageRow>(
        "SELECT id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components
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

/// Core implementation using newtype ID.
pub async fn get_message_typed(
    pool: &DbPool,
    id: MessageId,
) -> Result<Option<MessageRow>, DbError> {
    let row = sqlx::query_as::<_, MessageRow>(
        "SELECT id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components
         FROM messages WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn get_message(pool: &DbPool, id: i64) -> Result<Option<MessageRow>, DbError> {
    get_message_typed(pool, MessageId::new(id)).await
}

/// Core implementation using newtype ID.
pub async fn get_channel_messages_typed(
    pool: &DbPool,
    channel_id: ChannelId,
    before: Option<MessageId>,
    after: Option<MessageId>,
    limit: i64,
) -> Result<Vec<MessageRow>, DbError> {
    // Defense-in-depth: never let a non-positive limit reach the SQL LIMIT
    // clause (SQLite treats LIMIT <= -1 as unbounded; Postgres errors on
    // negatives). Callers should already clamp, but guard here regardless.
    let limit = limit.clamp(1, 500);
    let rows = match (before, after) {
        (Some(before_id), _) => {
            sqlx::query_as::<_, MessageRow>(
                "SELECT id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components
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
                "SELECT id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components
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
                "SELECT id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components
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

/// Raw i64 shim kept for API compat.
pub async fn get_channel_messages(
    pool: &DbPool,
    channel_id: i64,
    before: Option<i64>,
    after: Option<i64>,
    limit: i64,
) -> Result<Vec<MessageRow>, DbError> {
    get_channel_messages_typed(
        pool,
        ChannelId::new(channel_id),
        before.map(MessageId::new),
        after.map(MessageId::new),
        limit,
    )
    .await
}

/// Core implementation using newtype ID.
pub async fn update_message_typed(
    pool: &DbPool,
    id: MessageId,
    content: &str,
) -> Result<MessageRow, DbError> {
    let row = sqlx::query_as::<_, MessageRow>(
        "UPDATE messages SET content = $2, edited_at = $3
         WHERE id = $1
         RETURNING id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components",
    )
    .bind(id)
    .bind(content)
    .bind(datetime_to_db_text(Utc::now()))
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn update_message(pool: &DbPool, id: i64, content: &str) -> Result<MessageRow, DbError> {
    update_message_typed(pool, MessageId::new(id), content).await
}

/// Raw i64 shim kept for API compat.
pub async fn update_message_authorized(
    pool: &DbPool,
    id: i64,
    channel_id: i64,
    actor_id: i64,
    content: &str,
    can_manage: bool,
) -> Result<Option<MessageRow>, DbError> {
    update_message_authorized_with_meta(
        pool, id, channel_id, actor_id, content, None, None, can_manage,
    )
    .await
}

/// Core implementation using newtype IDs.
///
/// Authorization is decided by the caller: the message is updated when the actor
/// is its author, or when `can_manage` is `true`. `can_manage` must be computed
/// with `compute_channel_permissions` (which honors channel permission
/// overwrites) rather than from base role bits, so channel-scoped MANAGE_MESSAGES
/// denials are respected. This mirrors `delete_message_authorized_typed`. The
/// author check stays in SQL so the update remains a single atomic statement.
pub async fn update_message_authorized_typed(
    pool: &DbPool,
    id: MessageId,
    channel_id: ChannelId,
    actor_id: UserId,
    content: &str,
    nonce: Option<&str>,
    flags: Option<i32>,
    can_manage: bool,
) -> Result<Option<MessageRow>, DbError> {
    let row = sqlx::query_as::<_, MessageRow>(
        "UPDATE messages
         SET content = $4,
             edited_at = $5,
             nonce = $6,
             flags = COALESCE($7, flags)
         WHERE id = $1
           AND channel_id = $2
           AND (author_id = $3 OR $8)
         RETURNING id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components",
    )
    .bind(id)
    .bind(channel_id)
    .bind(actor_id)
    .bind(content)
    .bind(datetime_to_db_text(Utc::now()))
    .bind(nonce)
    .bind(flags)
    .bind(can_manage)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn update_message_authorized_with_meta(
    pool: &DbPool,
    id: i64,
    channel_id: i64,
    actor_id: i64,
    content: &str,
    nonce: Option<&str>,
    flags: Option<i32>,
    can_manage: bool,
) -> Result<Option<MessageRow>, DbError> {
    update_message_authorized_typed(
        pool,
        MessageId::new(id),
        ChannelId::new(channel_id),
        UserId::new(actor_id),
        content,
        nonce,
        flags,
        can_manage,
    )
    .await
}

/// Core implementation using newtype ID.
pub async fn delete_message_typed(pool: &DbPool, id: MessageId) -> Result<(), DbError> {
    sqlx::query("DELETE FROM messages WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Raw i64 shim kept for API compat.
pub async fn delete_message(pool: &DbPool, id: i64) -> Result<(), DbError> {
    delete_message_typed(pool, MessageId::new(id)).await
}

/// Core implementation using newtype IDs.
///
/// Authorization is decided by the caller: the message is deleted when the actor
/// is its author, or when `can_manage` is `true`. `can_manage` must be computed
/// with `compute_channel_permissions` (which honors channel permission
/// overwrites) rather than from base role bits, so channel-scoped MANAGE_MESSAGES
/// denials are respected. The author check stays in SQL so the delete remains a
/// single atomic statement.
pub async fn delete_message_authorized_typed(
    pool: &DbPool,
    id: MessageId,
    channel_id: ChannelId,
    actor_id: UserId,
    can_manage: bool,
) -> Result<bool, DbError> {
    let result = sqlx::query(
        "DELETE FROM messages
         WHERE id = $1
           AND channel_id = $2
           AND (author_id = $3 OR $4)",
    )
    .bind(id)
    .bind(channel_id)
    .bind(actor_id)
    .bind(can_manage)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Raw i64 shim kept for API compat.
pub async fn delete_message_authorized(
    pool: &DbPool,
    id: i64,
    channel_id: i64,
    actor_id: i64,
    can_manage: bool,
) -> Result<bool, DbError> {
    delete_message_authorized_typed(
        pool,
        MessageId::new(id),
        ChannelId::new(channel_id),
        UserId::new(actor_id),
        can_manage,
    )
    .await
}

/// Core implementation using newtype ID.
pub async fn get_pinned_messages_typed(
    pool: &DbPool,
    channel_id: ChannelId,
) -> Result<Vec<MessageRow>, DbError> {
    let rows = sqlx::query_as::<_, MessageRow>(
        "SELECT id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components
         FROM messages WHERE channel_id = $1 AND pinned = TRUE ORDER BY id ASC",
    )
    .bind(channel_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Raw i64 shim kept for API compat.
pub async fn get_pinned_messages(
    pool: &DbPool,
    channel_id: i64,
) -> Result<Vec<MessageRow>, DbError> {
    get_pinned_messages_typed(pool, ChannelId::new(channel_id)).await
}

/// Maximum number of messages that may be pinned in a single channel. Pinning
/// beyond this returns [`DbError::LimitReached`], which the API layer maps to
/// HTTP 409.
pub const MAX_PINS_PER_CHANNEL: i64 = 50;

/// Core implementation using newtype IDs.
///
/// Enforces [`MAX_PINS_PER_CHANNEL`]: if the channel already holds that many
/// pinned messages and the target message is not itself already pinned, the pin
/// is rejected with [`DbError::LimitReached`]. Returns `Ok(false)` when the
/// message does not exist in the channel.
pub async fn pin_message_typed(
    pool: &DbPool,
    id: MessageId,
    channel_id: ChannelId,
) -> Result<bool, DbError> {
    // Re-pinning an already-pinned message is a no-op and must not count against
    // the cap, so only enforce the limit when this message is not yet pinned.
    let already_pinned: Option<i64> = sqlx::query_scalar(
        "SELECT CASE WHEN pinned THEN 1 ELSE 0 END FROM messages WHERE id = $1 AND channel_id = $2",
    )
    .bind(id)
    .bind(channel_id)
    .fetch_optional(pool)
    .await?;
    match already_pinned {
        None => return Ok(false),
        Some(1) => return Ok(true),
        _ => {}
    }

    let pinned_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE channel_id = $1 AND pinned = TRUE")
            .bind(channel_id)
            .fetch_one(pool)
            .await?;
    if pinned_count >= MAX_PINS_PER_CHANNEL {
        return Err(DbError::LimitReached(format!(
            "channel already has the maximum of {} pinned messages",
            MAX_PINS_PER_CHANNEL
        )));
    }

    let result = sqlx::query("UPDATE messages SET pinned = TRUE WHERE id = $1 AND channel_id = $2")
        .bind(id)
        .bind(channel_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Raw i64 shim kept for API compat.
pub async fn pin_message(pool: &DbPool, id: i64, channel_id: i64) -> Result<bool, DbError> {
    pin_message_typed(pool, MessageId::new(id), ChannelId::new(channel_id)).await
}

/// Core implementation using newtype IDs.
pub async fn unpin_message_typed(
    pool: &DbPool,
    id: MessageId,
    channel_id: ChannelId,
) -> Result<bool, DbError> {
    let result =
        sqlx::query("UPDATE messages SET pinned = FALSE WHERE id = $1 AND channel_id = $2")
            .bind(id)
            .bind(channel_id)
            .execute(pool)
            .await?;
    Ok(result.rows_affected() > 0)
}

/// Raw i64 shim kept for API compat.
pub async fn unpin_message(pool: &DbPool, id: i64, channel_id: i64) -> Result<bool, DbError> {
    unpin_message_typed(pool, MessageId::new(id), ChannelId::new(channel_id)).await
}

/// Core implementation using newtype ID. ids remain i64 since they're a bulk slice.
pub async fn bulk_delete_messages_typed(
    pool: &DbPool,
    channel_id: ChannelId,
    ids: &[MessageId],
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
    let channel_bind_index = ids.len() + 1;
    let sql = format!(
        "DELETE FROM messages WHERE id IN ({}) AND channel_id = ${}",
        build_placeholders(1, ids.len()),
        channel_bind_index
    );
    let mut query = sqlx::query(&sql);
    for id in ids {
        query = query.bind(*id);
    }
    query = query.bind(channel_id);
    let result = query.execute(pool).await?;
    Ok(result.rows_affected())
}

/// Raw i64 shim kept for API compat.
pub async fn bulk_delete_messages(
    pool: &DbPool,
    channel_id: i64,
    ids: &[i64],
) -> Result<u64, DbError> {
    let typed_ids: Vec<MessageId> = ids.iter().map(|&id| MessageId::new(id)).collect();
    bulk_delete_messages_typed(pool, ChannelId::new(channel_id), &typed_ids).await
}

pub async fn count_messages(pool: &DbPool) -> Result<i64, DbError> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM messages")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}

/// Core implementation using newtype IDs.
pub async fn search_messages_typed(
    pool: &DbPool,
    channel_id: ChannelId,
    query: &str,
    limit: i64,
    author_id: Option<UserId>,
    after: Option<DateTime<Utc>>,
    before: Option<DateTime<Utc>>,
) -> Result<Vec<MessageRow>, DbError> {
    const MESSAGE_FLAG_DM_E2EE: i32 = 1 << 0;
    // Defense-in-depth: clamp the bound LIMIT to a positive value so a
    // negative caller limit can never become an unbounded SQLite read.
    let limit = limit.clamp(1, 500);
    let after_text = after.map(datetime_to_db_text);
    let before_text = before.map(datetime_to_db_text);
    match crate::active_database_engine() {
        crate::DatabaseEngine::Postgres => {
            let rows = sqlx::query_as::<_, MessageRow>(
                "SELECT id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components
                 FROM messages
                 WHERE channel_id = $1
                   AND search_vector @@ plainto_tsquery('english', $2)
                   AND ($3 IS NULL OR author_id = $3)
                   AND ($4 IS NULL OR created_at >= $4)
                   AND ($5 IS NULL OR created_at <= $5)
                   AND (flags & $7) = 0
                 ORDER BY ts_rank(search_vector, plainto_tsquery('english', $2)) DESC
                 LIMIT $6",
            )
            .bind(channel_id)
            .bind(query)
            .bind(author_id)
            .bind(after_text.as_deref())
            .bind(before_text.as_deref())
            .bind(limit)
            .bind(MESSAGE_FLAG_DM_E2EE)
            .fetch_all(pool)
            .await?;
            Ok(rows)
        }
        crate::DatabaseEngine::Sqlite => {
            // Use FTS5 for full-text search, falling back to LIKE if FTS table
            // is not yet available (e.g. migration hasn't run).
            let fts_query = sanitize_fts5_query(query);
            let fts_result = sqlx::query_as::<_, MessageRow>(
                "SELECT m.id, m.channel_id, m.author_id, m.content, m.nonce, m.message_type, m.flags, m.edited_at, CASE WHEN m.pinned THEN 1 ELSE 0 END AS pinned, m.reference_id, m.e2ee_header, m.created_at, m.embeds, m.components
                 FROM messages m
                 JOIN messages_fts ON messages_fts.rowid = m.id
                 WHERE messages_fts MATCH $1
                   AND messages_fts.channel_id = $2
                   AND ($3 IS NULL OR m.author_id = $3)
                   AND ($4 IS NULL OR m.created_at >= $4)
                   AND ($5 IS NULL OR m.created_at <= $5)
                   AND (m.flags & $7) = 0
                 ORDER BY rank
                 LIMIT $6",
            )
            .bind(&fts_query)
            .bind(channel_id)
            .bind(author_id)
            .bind(after_text.as_deref())
            .bind(before_text.as_deref())
            .bind(limit)
            .bind(MESSAGE_FLAG_DM_E2EE)
            .fetch_all(pool)
            .await;

            match fts_result {
                Ok(rows) => Ok(rows),
                Err(err) if is_unusable_fts_index(&err) => {
                    // The FTS5 index is missing or unusable (for example, a
                    // stale local database has the pre-standalone FTS shape).
                    // Degrade to a LIKE scan for search-index failures only;
                    // unrelated DB errors still propagate.
                    tracing::warn!(
                        error = %err,
                        "messages_fts unavailable; falling back to LIKE search"
                    );
                    let escaped = query
                        .replace('\\', "\\\\")
                        .replace('%', "\\%")
                        .replace('_', "\\_");
                    let pattern = format!("%{}%", escaped);
                    let rows = sqlx::query_as::<_, MessageRow>(
                        "SELECT id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components
                         FROM messages
                         WHERE channel_id = $1
                           AND content LIKE $2 ESCAPE '\\'
                           AND ($3 IS NULL OR author_id = $3)
                           AND ($4 IS NULL OR created_at >= $4)
                           AND ($5 IS NULL OR created_at <= $5)
                           AND (flags & $7) = 0
                         ORDER BY id DESC
                         LIMIT $6",
                    )
                    .bind(channel_id)
                    .bind(pattern)
                    .bind(author_id)
                    .bind(after_text.as_deref())
                    .bind(before_text.as_deref())
                    .bind(limit)
                    .bind(MESSAGE_FLAG_DM_E2EE)
                    .fetch_all(pool)
                    .await?;
                    Ok(rows)
                }
                Err(err) => Err(DbError::from(err)),
            }
        }
    }
}

/// Returns true when SQLite cannot use the message FTS index. This is kept
/// narrow to search-index failures so unrelated DB errors still surface.
fn is_unusable_fts_index(err: &sqlx::Error) -> bool {
    matches!(err, sqlx::Error::Database(db) if {
        let msg = db.message().to_ascii_lowercase();
        (msg.contains("messages_fts")
            && (msg.contains("no such table")
                || msg.contains("no such column")
                || msg.contains("no such module")
                || msg.contains("malformed")
                || msg.contains("corrupt")))
            || msg.contains("unable to use function match")
    })
}

/// Raw i64 shim kept for API compat.
pub async fn search_messages(
    pool: &DbPool,
    channel_id: i64,
    query: &str,
    limit: i64,
    author_id: Option<i64>,
    after: Option<DateTime<Utc>>,
    before: Option<DateTime<Utc>>,
) -> Result<Vec<MessageRow>, DbError> {
    search_messages_typed(
        pool,
        ChannelId::new(channel_id),
        query,
        limit,
        author_id.map(UserId::new),
        after,
        before,
    )
    .await
}

/// Maximum number of channels a single forum-wide search may fan out over.
/// Forum channels can accumulate many posts (each its own channel); this caps
/// the IN-list so the query stays bounded. Callers should pre-truncate.
const MAX_SEARCH_CHANNELS: usize = 500;

/// Full-text search across a *set* of channels in a single ranked query. Used
/// for forum-wide search, where each forum post is its own channel: instead of
/// running one search per post, the caller passes every post channel id and
/// gets back the top `limit` matches ranked by relevance. E2EE DM messages are
/// excluded. Returns an empty vec when `channel_ids` is empty.
///
/// Bind layout: channel ids occupy `$1..=$n`; the remaining parameters follow.
#[allow(clippy::too_many_arguments)]
pub async fn search_messages_in_channels_typed(
    pool: &DbPool,
    channel_ids: &[ChannelId],
    query: &str,
    limit: i64,
    author_id: Option<UserId>,
    after: Option<DateTime<Utc>>,
    before: Option<DateTime<Utc>>,
) -> Result<Vec<MessageRow>, DbError> {
    const MESSAGE_FLAG_DM_E2EE: i32 = 1 << 0;
    if channel_ids.is_empty() {
        return Ok(Vec::new());
    }
    if channel_ids.len() > MAX_SEARCH_CHANNELS {
        return Err(DbError::Sqlx(sqlx::Error::Protocol(
            "too many channel ids in forum search".to_string(),
        )));
    }
    let after_text = after.map(datetime_to_db_text);
    let before_text = before.map(datetime_to_db_text);
    let n = channel_ids.len();
    let in_list = build_placeholders(1, n);
    // Positional params trailing the channel-id IN-list. sqlx honours the
    // explicit `$N` index, so text order need not match bind order.
    let p_query = n + 1;
    let p_author = n + 2;
    let p_after = n + 3;
    let p_before = n + 4;
    let p_limit = n + 5;
    let p_flag = n + 6;

    match crate::active_database_engine() {
        crate::DatabaseEngine::Postgres => {
            let sql = format!(
                "SELECT id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components
                 FROM messages
                 WHERE channel_id IN ({in_list})
                   AND search_vector @@ plainto_tsquery('english', ${p_query})
                   AND (${p_author} IS NULL OR author_id = ${p_author})
                   AND (${p_after} IS NULL OR created_at >= ${p_after})
                   AND (${p_before} IS NULL OR created_at <= ${p_before})
                   AND (flags & ${p_flag}) = 0
                 ORDER BY ts_rank(search_vector, plainto_tsquery('english', ${p_query})) DESC, id DESC
                 LIMIT ${p_limit}"
            );
            let mut q = sqlx::query_as::<_, MessageRow>(&sql);
            for cid in channel_ids {
                q = q.bind(*cid);
            }
            let rows = q
                .bind(query)
                .bind(author_id)
                .bind(after_text.as_deref())
                .bind(before_text.as_deref())
                .bind(limit)
                .bind(MESSAGE_FLAG_DM_E2EE)
                .fetch_all(pool)
                .await?;
            Ok(rows)
        }
        crate::DatabaseEngine::Sqlite => {
            let fts_query = sanitize_fts5_query(query);
            let sql = format!(
                "SELECT m.id, m.channel_id, m.author_id, m.content, m.nonce, m.message_type, m.flags, m.edited_at, CASE WHEN m.pinned THEN 1 ELSE 0 END AS pinned, m.reference_id, m.e2ee_header, m.created_at, m.embeds, m.components
                 FROM messages m
                 JOIN messages_fts ON messages_fts.rowid = m.id
                 WHERE messages_fts MATCH ${p_query}
                   AND messages_fts.channel_id IN ({in_list})
                   AND (${p_author} IS NULL OR m.author_id = ${p_author})
                   AND (${p_after} IS NULL OR m.created_at >= ${p_after})
                   AND (${p_before} IS NULL OR m.created_at <= ${p_before})
                   AND (m.flags & ${p_flag}) = 0
                 ORDER BY rank, m.id DESC
                 LIMIT ${p_limit}"
            );
            let mut q = sqlx::query_as::<_, MessageRow>(&sql);
            for cid in channel_ids {
                q = q.bind(*cid);
            }
            let fts_result = q
                .bind(&fts_query)
                .bind(author_id)
                .bind(after_text.as_deref())
                .bind(before_text.as_deref())
                .bind(limit)
                .bind(MESSAGE_FLAG_DM_E2EE)
                .fetch_all(pool)
                .await;

            match fts_result {
                Ok(rows) => Ok(rows),
                Err(err) if is_unusable_fts_index(&err) => {
                    // Same degradation as the single-channel search: if the FTS5
                    // index is missing or unusable, fall back to a LIKE scan.
                    tracing::warn!(
                        error = %err,
                        "messages_fts unavailable; falling back to LIKE search"
                    );
                    let escaped = query
                        .replace('\\', "\\\\")
                        .replace('%', "\\%")
                        .replace('_', "\\_");
                    let pattern = format!("%{}%", escaped);
                    let sql = format!(
                        "SELECT id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components
                         FROM messages
                         WHERE channel_id IN ({in_list})
                           AND content LIKE ${p_query} ESCAPE '\\'
                           AND (${p_author} IS NULL OR author_id = ${p_author})
                           AND (${p_after} IS NULL OR created_at >= ${p_after})
                           AND (${p_before} IS NULL OR created_at <= ${p_before})
                           AND (flags & ${p_flag}) = 0
                         ORDER BY id DESC
                         LIMIT ${p_limit}"
                    );
                    let mut q = sqlx::query_as::<_, MessageRow>(&sql);
                    for cid in channel_ids {
                        q = q.bind(*cid);
                    }
                    let rows = q
                        .bind(pattern)
                        .bind(author_id)
                        .bind(after_text.as_deref())
                        .bind(before_text.as_deref())
                        .bind(limit)
                        .bind(MESSAGE_FLAG_DM_E2EE)
                        .fetch_all(pool)
                        .await?;
                    Ok(rows)
                }
                Err(err) => Err(DbError::from(err)),
            }
        }
    }
}

/// Raw i64 shim kept for API compat.
pub async fn search_messages_in_channels(
    pool: &DbPool,
    channel_ids: &[i64],
    query: &str,
    limit: i64,
    author_id: Option<i64>,
    after: Option<DateTime<Utc>>,
    before: Option<DateTime<Utc>>,
) -> Result<Vec<MessageRow>, DbError> {
    let typed: Vec<ChannelId> = channel_ids.iter().map(|&id| ChannelId::new(id)).collect();
    search_messages_in_channels_typed(
        pool,
        &typed,
        query,
        limit,
        author_id.map(UserId::new),
        after,
        before,
    )
    .await
}

/// Sanitize user input for FTS5 MATCH queries. Wraps each word in double quotes
/// to prevent FTS5 syntax errors from special characters.
fn sanitize_fts5_query(input: &str) -> String {
    input
        .split_whitespace()
        .filter(|w| !w.is_empty())
        .map(|word| {
            let escaped = word.replace('"', "\"\"");
            format!("\"{}\"", escaped)
        })
        .collect::<Vec<_>>()
        .join(" ")
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

/// Core implementation using newtype ID.
pub async fn get_channel_message_ids_older_than_typed(
    pool: &DbPool,
    channel_id: ChannelId,
    older_than: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<MessageId>, DbError> {
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT id
         FROM messages
         WHERE channel_id = $1
           AND created_at <= $2
         ORDER BY created_at ASC
         LIMIT $3",
    )
    .bind(channel_id)
    .bind(datetime_to_db_text(older_than))
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| MessageId::new(id)).collect())
}

/// Raw i64 shim kept for API compat.
pub async fn get_channel_message_ids_older_than(
    pool: &DbPool,
    channel_id: i64,
    older_than: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<i64>, DbError> {
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT id
         FROM messages
         WHERE channel_id = $1
           AND created_at <= $2
         ORDER BY created_at ASC
         LIMIT $3",
    )
    .bind(channel_id)
    .bind(datetime_to_db_text(older_than))
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Core implementation using newtype ID.
pub async fn list_messages_by_author_typed(
    pool: &DbPool,
    author_id: UserId,
    limit: i64,
) -> Result<Vec<MessageRow>, DbError> {
    let rows = sqlx::query_as::<_, MessageRow>(
        "SELECT id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components
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

/// Raw i64 shim kept for API compat.
pub async fn list_messages_by_author(
    pool: &DbPool,
    author_id: i64,
    limit: i64,
) -> Result<Vec<MessageRow>, DbError> {
    list_messages_by_author_typed(pool, UserId::new(author_id), limit).await
}

/// Export helper: list all messages visible to a user across guild channels and DMs.
/// Core implementation using newtype ID.
pub async fn list_messages_for_user_export_typed(
    pool: &DbPool,
    user_id: UserId,
    limit: i64,
) -> Result<Vec<MessageRow>, DbError> {
    let rows = sqlx::query_as::<_, MessageRow>(
        "SELECT m.id, m.channel_id, m.author_id, m.content, m.nonce, m.message_type, m.flags,
                m.edited_at, CASE WHEN m.pinned THEN 1 ELSE 0 END AS pinned, m.reference_id,
                m.e2ee_header, m.created_at, m.embeds, m.components
         FROM messages m
         WHERE m.author_id = $1
            OR EXISTS (
                SELECT 1
                FROM dm_recipients dp
                WHERE dp.channel_id = m.channel_id
                  AND dp.user_id = $1
            )
            OR EXISTS (
                SELECT 1
                FROM channels c
                INNER JOIN members mem
                   ON mem.guild_id = c.space_id
                  AND mem.user_id = $1
                WHERE c.id = m.channel_id
            )
         ORDER BY m.id DESC
         LIMIT $2",
    )
    .bind(user_id)
    .bind(limit.clamp(1, 200_000))
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Raw i64 shim kept for API compat.
pub async fn list_messages_for_user_export(
    pool: &DbPool,
    user_id: i64,
    limit: i64,
) -> Result<Vec<MessageRow>, DbError> {
    list_messages_for_user_export_typed(pool, UserId::new(user_id), limit).await
}

pub async fn count_guild_messages_by_author(
    pool: &DbPool,
    guild_id: i64,
    author_id: i64,
) -> Result<i64, DbError> {
    let row: (i64,) = sqlx::query_as(
        "SELECT COUNT(*)
         FROM messages m
         INNER JOIN channels c ON c.id = m.channel_id
         WHERE c.guild_id = $1
           AND m.author_id = $2",
    )
    .bind(guild_id)
    .bind(author_id)
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

/// Returns the created_at timestamp of the most recent message sent by `author_id` in `channel_id`,
/// or `None` if they have never sent a message there. Used to enforce slowmode.
/// Core implementation using newtype IDs.
pub async fn get_last_user_message_time_typed(
    pool: &DbPool,
    channel_id: ChannelId,
    author_id: UserId,
) -> Result<Option<DateTime<Utc>>, DbError> {
    let row: Option<String> = sqlx::query_scalar(
        "SELECT created_at FROM messages WHERE channel_id = $1 AND author_id = $2 ORDER BY id DESC LIMIT 1",
    )
    .bind(channel_id)
    .bind(author_id)
    .fetch_optional(pool)
    .await?;
    match row {
        Some(ts) => Ok(Some(datetime_from_db_text(&ts)?)),
        None => Ok(None),
    }
}

/// Raw i64 shim kept for API compat.
pub async fn get_last_user_message_time(
    pool: &DbPool,
    channel_id: i64,
    author_id: i64,
) -> Result<Option<DateTime<Utc>>, DbError> {
    get_last_user_message_time_typed(pool, ChannelId::new(channel_id), UserId::new(author_id)).await
}

/// Core implementation using newtype ID.
pub async fn count_channel_messages_since_typed(
    pool: &DbPool,
    channel_id: ChannelId,
    since: DateTime<Utc>,
) -> Result<i64, DbError> {
    let since_text = datetime_to_db_text(since);
    let row: (i64,) = sqlx::query_as(
        "SELECT COUNT(*)
         FROM messages
         WHERE channel_id = $1
           AND created_at >= $2",
    )
    .bind(channel_id)
    .bind(since_text)
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

/// Raw i64 shim kept for API compat.
pub async fn count_channel_messages_since(
    pool: &DbPool,
    channel_id: i64,
    since: DateTime<Utc>,
) -> Result<i64, DbError> {
    count_channel_messages_since_typed(pool, ChannelId::new(channel_id), since).await
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
    let sql = format!(
        "DELETE FROM messages WHERE id IN ({})",
        build_placeholders(1, ids.len())
    );
    let mut query = sqlx::query(&sql);
    for id in ids {
        query = query.bind(id);
    }
    let result = query.execute(pool).await?;
    Ok(result.rows_affected())
}

#[derive(Debug, Clone)]
pub struct EditHistoryRow {
    pub id: i64,
    pub message_id: i64,
    pub content: String,
    pub edited_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for EditHistoryRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let edited_at_raw: String = row.try_get("edited_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            message_id: row.try_get("message_id")?,
            content: row.try_get("content")?,
            edited_at: datetime_from_db_text(&edited_at_raw)?,
        })
    }
}

/// Save a snapshot of the old message content before an edit.
pub async fn save_edit_snapshot_typed(
    pool: &DbPool,
    message_id: MessageId,
    old_content: &str,
) -> Result<(), DbError> {
    sqlx::query("INSERT INTO message_edits (message_id, content) VALUES ($1, $2)")
        .bind(message_id)
        .bind(old_content)
        .execute(pool)
        .await?;
    Ok(())
}

/// Raw i64 shim kept for API compat.
pub async fn save_edit_snapshot(
    pool: &DbPool,
    message_id: i64,
    old_content: &str,
) -> Result<(), DbError> {
    save_edit_snapshot_typed(pool, MessageId::new(message_id), old_content).await
}

/// Get the edit history for a message, ordered oldest first.
pub async fn get_edit_history_typed(
    pool: &DbPool,
    message_id: MessageId,
) -> Result<Vec<EditHistoryRow>, DbError> {
    let rows = sqlx::query_as::<_, EditHistoryRow>(
        "SELECT id, message_id, content, edited_at FROM message_edits WHERE message_id = $1 ORDER BY id ASC",
    )
    .bind(message_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Raw i64 shim kept for API compat.
pub async fn get_edit_history(
    pool: &DbPool,
    message_id: i64,
) -> Result<Vec<EditHistoryRow>, DbError> {
    get_edit_history_typed(pool, MessageId::new(message_id)).await
}

/// Store serialized embeds JSON on a message. Does not update `edited_at`.
pub async fn update_message_embeds_typed(
    pool: &DbPool,
    id: MessageId,
    embeds_json: &str,
) -> Result<(), DbError> {
    sqlx::query("UPDATE messages SET embeds = $1 WHERE id = $2")
        .bind(embeds_json)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Raw i64 shim kept for API compat.
pub async fn update_message_embeds(
    pool: &DbPool,
    id: i64,
    embeds_json: &str,
) -> Result<(), DbError> {
    update_message_embeds_typed(pool, MessageId::new(id), embeds_json).await
}

/// Store serialized component JSON on a message. Does not update `edited_at`.
pub async fn update_message_components_typed(
    pool: &DbPool,
    id: MessageId,
    components_json: &str,
) -> Result<(), DbError> {
    sqlx::query("UPDATE messages SET components = $1 WHERE id = $2")
        .bind(components_json)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Raw i64 shim kept for API compat.
pub async fn update_message_components(
    pool: &DbPool,
    id: i64,
    components_json: &str,
) -> Result<(), DbError> {
    update_message_components_typed(pool, MessageId::new(id), components_json).await
}

/// Fetch a message with rich payload columns included.
pub async fn get_message_with_embeds_typed(
    pool: &DbPool,
    id: MessageId,
) -> Result<Option<MessageRow>, DbError> {
    let row = sqlx::query_as::<_, MessageRow>(
        "SELECT id, channel_id, author_id, content, nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components
         FROM messages WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn get_message_with_embeds(
    pool: &DbPool,
    id: i64,
) -> Result<Option<MessageRow>, DbError> {
    get_message_with_embeds_typed(pool, MessageId::new(id)).await
}

/// Maximum number of message ids accepted by a single batch lookup. Message
/// list endpoints cap their page size well below this (<= 100), so the limit is
/// a defensive guard against unbounded IN-lists, matching the other batch
/// helpers in this crate.
const MAX_BATCH_MESSAGE_IDS: usize = 500;

/// Build a comma-separated run of positional bind placeholders
/// (`$start, $start+1, …, $start+count-1`) for an `IN (…)` clause or similar.
/// Shared by the batch-lookup helpers in this crate (messages, reactions,
/// attachments) so every dynamically built IN-list is generated identically.
pub fn build_placeholders(start: usize, count: usize) -> String {
    (start..start + count)
        .map(|i| format!("${}", i))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Batch-load the distinct author [`UserRow`](crate::users::UserRow)s for a page
/// of messages in a single query. Missing authors are simply absent from the
/// result; callers fall back to an "Unknown" placeholder.
pub async fn get_authors_for_message_ids(
    pool: &DbPool,
    author_ids: &[i64],
) -> Result<Vec<crate::users::UserRow>, DbError> {
    if author_ids.is_empty() {
        return Ok(Vec::new());
    }
    if author_ids.len() > MAX_BATCH_MESSAGE_IDS {
        return Err(DbError::Sqlx(sqlx::Error::Protocol(
            "too many author ids in author lookup".to_string(),
        )));
    }
    let sql = format!(
        "SELECT id, username, discriminator, email, display_name, avatar_hash, banner_hash, bio, accent_color, flags, created_at, public_key, email_verified
         FROM users WHERE id IN ({})",
        build_placeholders(1, author_ids.len()),
    );
    let mut query = sqlx::query_as::<_, crate::users::UserRow>(&sql);
    for author_id in author_ids {
        query = query.bind(author_id);
    }
    let rows = query.fetch_all(pool).await?;
    Ok(rows)
}

/// A [`StickerRow`](crate::stickers::StickerRow) tagged with the message it is
/// attached to, so a batched result can be grouped back onto messages.
pub struct BatchStickerRow {
    pub message_id: i64,
    pub sticker: crate::stickers::StickerRow,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for BatchStickerRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            message_id: row.try_get("message_id")?,
            sticker: crate::stickers::StickerRow::from_row(row)?,
        })
    }
}

/// Batch-load stickers for a page of messages in a single query, preserving the
/// per-message ordering (`created_at ASC`) used by
/// [`list_message_stickers`](crate::stickers::list_message_stickers).
pub async fn get_stickers_for_message_ids(
    pool: &DbPool,
    message_ids: &[i64],
) -> Result<Vec<BatchStickerRow>, DbError> {
    if message_ids.is_empty() {
        return Ok(Vec::new());
    }
    if message_ids.len() > MAX_BATCH_MESSAGE_IDS {
        return Err(DbError::Sqlx(sqlx::Error::Protocol(
            "too many message ids in sticker lookup".to_string(),
        )));
    }
    let sql = format!(
        "SELECT ms.message_id AS message_id, s.id, s.guild_id, s.name, s.description, s.format_type,
                s.asset_key, s.asset_content_type, s.creator_id, s.created_at
         FROM message_stickers ms
         INNER JOIN stickers s ON s.id = ms.sticker_id
         WHERE ms.message_id IN ({})
         ORDER BY ms.message_id, s.created_at ASC",
        build_placeholders(1, message_ids.len()),
    );
    let mut query = sqlx::query_as::<_, BatchStickerRow>(&sql);
    for message_id in message_ids {
        query = query.bind(message_id);
    }
    let rows = query.fetch_all(pool).await?;
    Ok(rows)
}

/// Batch-load anonymous-message records for a page of messages in a single
/// query. Only messages posted anonymously appear in the result.
pub async fn get_anonymous_messages_for_message_ids(
    pool: &DbPool,
    message_ids: &[i64],
) -> Result<Vec<crate::anonymous_messages::AnonymousMessageRow>, DbError> {
    if message_ids.is_empty() {
        return Ok(Vec::new());
    }
    if message_ids.len() > MAX_BATCH_MESSAGE_IDS {
        return Err(DbError::Sqlx(sqlx::Error::Protocol(
            "too many message ids in anonymous message lookup".to_string(),
        )));
    }
    let sql = format!(
        "SELECT message_id, channel_id, user_id, alias, created_at
         FROM anonymous_messages
         WHERE message_id IN ({})",
        build_placeholders(1, message_ids.len()),
    );
    let mut query = sqlx::query_as::<_, crate::anonymous_messages::AnonymousMessageRow>(&sql);
    for message_id in message_ids {
        query = query.bind(message_id);
    }
    let rows = query.fetch_all(pool).await?;
    Ok(rows)
}

#[derive(sqlx::FromRow)]
struct OptionVoteCountRow {
    option_id: i64,
    count: i64,
}

/// Batch-load fully-assembled polls (options + vote counts + the viewer's votes)
/// for a page of messages using a bounded, constant number of queries
/// regardless of how many messages carry a poll. Returns each poll paired with
/// its owning message id. Ordering of options matches
/// [`get_message_poll`](crate::polls::get_message_poll).
pub async fn get_polls_for_message_ids(
    pool: &DbPool,
    message_ids: &[i64],
    viewer_id: i64,
) -> Result<Vec<(i64, crate::polls::PollWithOptions)>, DbError> {
    use std::collections::HashMap;

    if message_ids.is_empty() {
        return Ok(Vec::new());
    }
    if message_ids.len() > MAX_BATCH_MESSAGE_IDS {
        return Err(DbError::Sqlx(sqlx::Error::Protocol(
            "too many message ids in poll lookup".to_string(),
        )));
    }

    // 1. Polls attached to any of the messages.
    let sql = format!(
        "SELECT id, message_id, channel_id, question, allow_multiselect, expires_at, created_at
         FROM polls WHERE message_id IN ({})",
        build_placeholders(1, message_ids.len()),
    );
    let mut query = sqlx::query_as::<_, crate::polls::PollRow>(&sql);
    for message_id in message_ids {
        query = query.bind(message_id);
    }
    let polls = query.fetch_all(pool).await?;
    if polls.is_empty() {
        return Ok(Vec::new());
    }

    let poll_ids: Vec<i64> = polls.iter().map(|p| p.id).collect();
    let poll_placeholders = build_placeholders(1, poll_ids.len());

    // 2. Options for those polls.
    let options_sql = format!(
        "SELECT id, poll_id, text, emoji, position
         FROM poll_options WHERE poll_id IN ({poll_placeholders})
         ORDER BY poll_id, position",
    );
    let mut options_query = sqlx::query_as::<_, crate::polls::PollOptionRow>(&options_sql);
    for poll_id in &poll_ids {
        options_query = options_query.bind(poll_id);
    }
    let option_rows = options_query.fetch_all(pool).await?;

    // 3. Vote counts per option across all polls.
    let counts_sql = format!(
        "SELECT option_id, COUNT(*) as count
         FROM poll_votes WHERE poll_id IN ({poll_placeholders})
         GROUP BY option_id",
    );
    let mut counts_query = sqlx::query_as::<_, OptionVoteCountRow>(&counts_sql);
    for poll_id in &poll_ids {
        counts_query = counts_query.bind(poll_id);
    }
    let count_rows = counts_query.fetch_all(pool).await?;
    let mut vote_counts: HashMap<i64, i64> = HashMap::new();
    for row in count_rows {
        vote_counts.insert(row.option_id, row.count);
    }

    // 4. The viewer's own votes across all polls.
    let viewer_bind_index = poll_ids.len() + 1;
    let voted_sql = format!(
        "SELECT DISTINCT option_id
         FROM poll_votes WHERE poll_id IN ({poll_placeholders}) AND user_id = ${viewer_bind_index}",
    );
    let mut voted_query = sqlx::query_as::<_, (i64,)>(&voted_sql);
    for poll_id in &poll_ids {
        voted_query = voted_query.bind(poll_id);
    }
    voted_query = voted_query.bind(viewer_id);
    let voted_rows = voted_query.fetch_all(pool).await?;
    let voted_options: std::collections::HashSet<i64> =
        voted_rows.into_iter().map(|r| r.0).collect();

    // Group options by poll, preserving the position ordering from the query.
    let mut options_by_poll: HashMap<i64, Vec<crate::polls::PollOptionWithVotes>> = HashMap::new();
    for opt in option_rows {
        let vote_count = vote_counts.get(&opt.id).copied().unwrap_or(0) as i32;
        let voted = voted_options.contains(&opt.id);
        options_by_poll
            .entry(opt.poll_id)
            .or_default()
            .push(crate::polls::PollOptionWithVotes {
                id: opt.id,
                text: opt.text,
                emoji: opt.emoji,
                position: opt.position,
                vote_count,
                voted,
            });
    }

    let mut result = Vec::with_capacity(polls.len());
    for poll in polls {
        let options = options_by_poll.remove(&poll.id).unwrap_or_default();
        let total_votes: i32 = options.iter().map(|o| o.vote_count).sum();
        let message_id = poll.message_id;
        result.push((
            message_id,
            crate::polls::PollWithOptions {
                poll,
                options,
                total_votes,
            },
        ));
    }
    Ok(result)
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
        let msg = create_message_typed(
            &pool,
            MessageId::new(1000),
            ChannelId::new(channel_id),
            UserId::new(user_id),
            "Hello!",
            0,
            None,
        )
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
        create_message_typed(
            &pool,
            MessageId::new(1000),
            ChannelId::new(channel_id),
            UserId::new(user_id),
            "Original",
            0,
            None,
        )
        .await
        .unwrap();
        let reply = create_message_typed(
            &pool,
            MessageId::new(1001),
            ChannelId::new(channel_id),
            UserId::new(user_id),
            "Reply",
            0,
            Some(MessageId::new(1000)),
        )
        .await
        .unwrap();
        assert_eq!(reply.reference_id, Some(1000));
    }

    #[tokio::test]
    async fn test_get_message() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        create_message_typed(
            &pool,
            MessageId::new(2000),
            ChannelId::new(channel_id),
            UserId::new(user_id),
            "Find me",
            0,
            None,
        )
        .await
        .unwrap();
        let msg = get_message_typed(&pool, MessageId::new(2000))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(msg.content.as_deref(), Some("Find me"));
    }

    #[tokio::test]
    async fn test_get_message_not_found() {
        let pool = test_pool().await;
        let msg = get_message_typed(&pool, MessageId::new(9999))
            .await
            .unwrap();
        assert!(msg.is_none());
    }

    #[tokio::test]
    async fn test_get_channel_messages_default_order() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        for i in 0..5 {
            create_message_typed(
                &pool,
                MessageId::new(3000 + i),
                ChannelId::new(channel_id),
                UserId::new(user_id),
                &format!("msg {}", i),
                0,
                None,
            )
            .await
            .unwrap();
        }
        let messages =
            get_channel_messages_typed(&pool, ChannelId::new(channel_id), None, None, 50)
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
            create_message_typed(
                &pool,
                MessageId::new(4000 + i),
                ChannelId::new(channel_id),
                UserId::new(user_id),
                &format!("msg {}", i),
                0,
                None,
            )
            .await
            .unwrap();
        }
        let messages = get_channel_messages_typed(
            &pool,
            ChannelId::new(channel_id),
            Some(MessageId::new(4003)),
            None,
            50,
        )
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
            create_message_typed(
                &pool,
                MessageId::new(5000 + i),
                ChannelId::new(channel_id),
                UserId::new(user_id),
                &format!("msg {}", i),
                0,
                None,
            )
            .await
            .unwrap();
        }
        let messages = get_channel_messages_typed(
            &pool,
            ChannelId::new(channel_id),
            None,
            Some(MessageId::new(5002)),
            50,
        )
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
            create_message_typed(
                &pool,
                MessageId::new(6000 + i),
                ChannelId::new(channel_id),
                UserId::new(user_id),
                &format!("msg {}", i),
                0,
                None,
            )
            .await
            .unwrap();
        }
        let messages = get_channel_messages_typed(&pool, ChannelId::new(channel_id), None, None, 3)
            .await
            .unwrap();
        assert_eq!(messages.len(), 3);
    }

    #[tokio::test]
    async fn test_get_channel_messages_negative_limit_is_clamped() {
        // Regression for L14-01: a negative limit must not become an unbounded
        // SQLite `LIMIT -1` read. The DB layer clamps it to a positive value.
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        for i in 0..10 {
            create_message_typed(
                &pool,
                MessageId::new(6100 + i),
                ChannelId::new(channel_id),
                UserId::new(user_id),
                &format!("msg {}", i),
                0,
                None,
            )
            .await
            .unwrap();
        }
        let messages =
            get_channel_messages_typed(&pool, ChannelId::new(channel_id), None, None, -1)
                .await
                .unwrap();
        // Clamped to a single row rather than dumping the whole channel.
        assert_eq!(messages.len(), 1);
    }

    #[tokio::test]
    async fn test_update_message() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        create_message_typed(
            &pool,
            MessageId::new(7000),
            ChannelId::new(channel_id),
            UserId::new(user_id),
            "Before",
            0,
            None,
        )
        .await
        .unwrap();
        let updated = update_message_typed(&pool, MessageId::new(7000), "After")
            .await
            .unwrap();
        assert_eq!(updated.content.as_deref(), Some("After"));
        assert!(updated.edited_at.is_some());
    }

    #[tokio::test]
    async fn test_delete_message() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        create_message_typed(
            &pool,
            MessageId::new(8000),
            ChannelId::new(channel_id),
            UserId::new(user_id),
            "Bye",
            0,
            None,
        )
        .await
        .unwrap();
        delete_message_typed(&pool, MessageId::new(8000))
            .await
            .unwrap();
        let msg = get_message_typed(&pool, MessageId::new(8000))
            .await
            .unwrap();
        assert!(msg.is_none());
    }

    #[tokio::test]
    async fn test_search_messages() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        create_message_typed(
            &pool,
            MessageId::new(9000),
            ChannelId::new(channel_id),
            UserId::new(user_id),
            "hello world",
            0,
            None,
        )
        .await
        .unwrap();
        create_message_typed(
            &pool,
            MessageId::new(9001),
            ChannelId::new(channel_id),
            UserId::new(user_id),
            "goodbye world",
            0,
            None,
        )
        .await
        .unwrap();
        create_message_typed(
            &pool,
            MessageId::new(9002),
            ChannelId::new(channel_id),
            UserId::new(user_id),
            "hello again",
            0,
            None,
        )
        .await
        .unwrap();
        let results = search_messages_typed(
            &pool,
            ChannelId::new(channel_id),
            "hello",
            50,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(results.len(), 2);
    }

    #[tokio::test]
    async fn test_search_messages_falls_back_when_fts_index_is_unusable() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        create_message_typed(
            &pool,
            MessageId::new(9050),
            ChannelId::new(channel_id),
            UserId::new(user_id),
            "stale index fallback needle",
            0,
            None,
        )
        .await
        .unwrap();

        sqlx::query("DROP TABLE messages_fts")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE messages_fts(content TEXT, channel_id INTEGER)")
            .execute(&pool)
            .await
            .unwrap();

        let results = search_messages_typed(
            &pool,
            ChannelId::new(channel_id),
            "needle",
            50,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, 9050);
    }

    #[tokio::test]
    async fn test_search_messages_in_channels() {
        let pool = test_pool().await;
        let (user_id, guild_id, channel_a) = setup_channel(&pool).await;
        let channel_b = 201;
        let channel_c = 202;
        let other_user = 2;
        crate::users::create_user(&pool, other_user, "other", 1, "other@example.com", "hash")
            .await
            .unwrap();
        crate::channels::create_channel(&pool, channel_b, guild_id, "b", 0, 0, None, None)
            .await
            .unwrap();
        crate::channels::create_channel(&pool, channel_c, guild_id, "c", 0, 0, None, None)
            .await
            .unwrap();

        // A hit in channel_a and channel_b; a distractor in the un-listed
        // channel_c that must not appear.
        create_message_typed(
            &pool,
            MessageId::new(9100),
            ChannelId::new(channel_a),
            UserId::new(user_id),
            "shared keyword alpha",
            0,
            None,
        )
        .await
        .unwrap();
        create_message_typed(
            &pool,
            MessageId::new(9101),
            ChannelId::new(channel_b),
            UserId::new(other_user),
            "shared keyword beta",
            0,
            None,
        )
        .await
        .unwrap();
        create_message_typed(
            &pool,
            MessageId::new(9102),
            ChannelId::new(channel_c),
            UserId::new(user_id),
            "shared keyword gamma",
            0,
            None,
        )
        .await
        .unwrap();

        let channels = [ChannelId::new(channel_a), ChannelId::new(channel_b)];
        let results =
            search_messages_in_channels_typed(&pool, &channels, "keyword", 50, None, None, None)
                .await
                .unwrap();
        let ids: Vec<i64> = results.iter().map(|m| m.id).collect();
        assert_eq!(results.len(), 2);
        assert!(ids.contains(&9100) && ids.contains(&9101));
        assert!(!ids.contains(&9102));

        // Author filter must apply across the whole set (validates trailing
        // placeholder numbering after the IN-list).
        let filtered = search_messages_in_channels_typed(
            &pool,
            &channels,
            "keyword",
            50,
            Some(UserId::new(other_user)),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, 9101);

        // Empty channel set is a no-op.
        let none = search_messages_in_channels_typed(&pool, &[], "keyword", 50, None, None, None)
            .await
            .unwrap();
        assert!(none.is_empty());
    }

    #[tokio::test]
    async fn test_search_messages_no_results() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        create_message_typed(
            &pool,
            MessageId::new(9100),
            ChannelId::new(channel_id),
            UserId::new(user_id),
            "nothing here",
            0,
            None,
        )
        .await
        .unwrap();
        let results = search_messages_typed(
            &pool,
            ChannelId::new(channel_id),
            "xyz",
            50,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn test_pin_and_unpin_message() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        create_message_typed(
            &pool,
            MessageId::new(10000),
            ChannelId::new(channel_id),
            UserId::new(user_id),
            "Pin me",
            0,
            None,
        )
        .await
        .unwrap();

        let pinned = pin_message_typed(&pool, MessageId::new(10000), ChannelId::new(channel_id))
            .await
            .unwrap();
        assert!(pinned);

        let pinned_msgs = get_pinned_messages_typed(&pool, ChannelId::new(channel_id))
            .await
            .unwrap();
        assert_eq!(pinned_msgs.len(), 1);
        assert_eq!(pinned_msgs[0].id, 10000);

        let unpinned =
            unpin_message_typed(&pool, MessageId::new(10000), ChannelId::new(channel_id))
                .await
                .unwrap();
        assert!(unpinned);

        let pinned_msgs = get_pinned_messages_typed(&pool, ChannelId::new(channel_id))
            .await
            .unwrap();
        assert!(pinned_msgs.is_empty());
    }

    #[tokio::test]
    async fn test_pin_cap_boundary() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;

        // Fill the channel exactly to the cap.
        for i in 0..MAX_PINS_PER_CHANNEL {
            let mid = 20000 + i;
            create_message_typed(
                &pool,
                MessageId::new(mid),
                ChannelId::new(channel_id),
                UserId::new(user_id),
                "pinme",
                0,
                None,
            )
            .await
            .unwrap();
            let ok = pin_message_typed(&pool, MessageId::new(mid), ChannelId::new(channel_id))
                .await
                .unwrap();
            assert!(ok);
        }

        // One more message: pinning it must be rejected with LimitReached.
        let over_id = 20000 + MAX_PINS_PER_CHANNEL;
        create_message_typed(
            &pool,
            MessageId::new(over_id),
            ChannelId::new(channel_id),
            UserId::new(user_id),
            "over",
            0,
            None,
        )
        .await
        .unwrap();
        let err = pin_message_typed(&pool, MessageId::new(over_id), ChannelId::new(channel_id))
            .await
            .unwrap_err();
        assert!(matches!(err, DbError::LimitReached(_)));

        // Re-pinning an already-pinned message stays a no-op even at the cap.
        let repin = pin_message_typed(&pool, MessageId::new(20000), ChannelId::new(channel_id))
            .await
            .unwrap();
        assert!(repin);

        // Freeing a slot lets a new pin succeed.
        unpin_message_typed(&pool, MessageId::new(20000), ChannelId::new(channel_id))
            .await
            .unwrap();
        let ok = pin_message_typed(&pool, MessageId::new(over_id), ChannelId::new(channel_id))
            .await
            .unwrap();
        assert!(ok);
    }

    #[tokio::test]
    async fn test_bulk_delete_messages() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        for i in 0..5 {
            create_message_typed(
                &pool,
                MessageId::new(11000 + i),
                ChannelId::new(channel_id),
                UserId::new(user_id),
                &format!("msg {}", i),
                0,
                None,
            )
            .await
            .unwrap();
        }
        let deleted = bulk_delete_messages_typed(
            &pool,
            ChannelId::new(channel_id),
            &[
                MessageId::new(11000),
                MessageId::new(11001),
                MessageId::new(11002),
            ],
        )
        .await
        .unwrap();
        assert_eq!(deleted, 3);

        let remaining =
            get_channel_messages_typed(&pool, ChannelId::new(channel_id), None, None, 50)
                .await
                .unwrap();
        assert_eq!(remaining.len(), 2);
    }

    #[tokio::test]
    async fn test_bulk_delete_empty_ids() {
        let pool = test_pool().await;
        let deleted = bulk_delete_messages_typed(&pool, ChannelId::new(1), &[])
            .await
            .unwrap();
        assert_eq!(deleted, 0);
    }

    #[tokio::test]
    async fn test_count_messages() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        assert_eq!(count_messages(&pool).await.unwrap(), 0);
        create_message_typed(
            &pool,
            MessageId::new(12000),
            ChannelId::new(channel_id),
            UserId::new(user_id),
            "a",
            0,
            None,
        )
        .await
        .unwrap();
        create_message_typed(
            &pool,
            MessageId::new(12001),
            ChannelId::new(channel_id),
            UserId::new(user_id),
            "b",
            0,
            None,
        )
        .await
        .unwrap();
        assert_eq!(count_messages(&pool).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn test_create_message_with_meta() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        let msg = create_message_with_meta_typed(
            &pool,
            MessageId::new(13000),
            ChannelId::new(channel_id),
            UserId::new(user_id),
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
        let first = create_message_with_meta_typed(
            &pool,
            MessageId::new(13010),
            ChannelId::new(channel_id),
            UserId::new(user_id),
            "first",
            0,
            None,
            0,
            Some("same-nonce"),
            None,
        )
        .await
        .unwrap();
        let second = create_message_with_meta_typed(
            &pool,
            MessageId::new(13011),
            ChannelId::new(channel_id),
            UserId::new(user_id),
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
        create_message_typed(
            &pool,
            MessageId::new(14000),
            ChannelId::new(channel_id),
            UserId::new(user_id),
            "mine",
            0,
            None,
        )
        .await
        .unwrap();
        create_message_typed(
            &pool,
            MessageId::new(14001),
            ChannelId::new(channel_id),
            UserId::new(user_id),
            "also mine",
            0,
            None,
        )
        .await
        .unwrap();
        let msgs = list_messages_by_author_typed(&pool, UserId::new(user_id), 50)
            .await
            .unwrap();
        assert_eq!(msgs.len(), 2);
    }

    #[tokio::test]
    async fn test_updates_last_message_id_on_channel() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        create_message_typed(
            &pool,
            MessageId::new(15000),
            ChannelId::new(channel_id),
            UserId::new(user_id),
            "latest",
            0,
            None,
        )
        .await
        .unwrap();
        let ch = crate::channels::get_channel(&pool, channel_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ch.last_message_id, Some(15000));
    }
}
