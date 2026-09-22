use crate::{bool_from_any_row, datetime_from_db_text, datetime_to_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use paracord_models::id::{ChannelId, MessageId, UserId};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct MessageRow {
    pub id: i64,
    /// Exact durable body/deletion feed revision; zero denotes a pre-feed row.
    pub recovery_revision: i64,
    pub channel_id: i64,
    pub author_id: i64,
    pub content: Option<String>,
    /// Payload nonce (the encryption IV for DMs).
    pub nonce: Option<String>,
    /// Original immutable client delivery/idempotency key.
    pub delivery_nonce: Option<String>,
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
    /// JSON attribution for a forwarded message. Null when this message is not a forward.
    pub forwarded_from: Option<String>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for MessageRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let edited_at_raw: Option<String> = row.try_get("edited_at")?;
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            recovery_revision: row.try_get("recovery_revision")?,
            channel_id: row.try_get("channel_id")?,
            author_id: row.try_get("author_id")?,
            content: row.try_get("content")?,
            nonce: row.try_get("nonce")?,
            delivery_nonce: row.try_get("delivery_nonce")?,
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
            forwarded_from: row.try_get("forwarded_from")?,
        })
    }
}

/// Select the first unread target from one channel; the read cursor comparison
/// and message/mention join happen in one database snapshot.
pub async fn get_attention_target(
    pool: &DbPool,
    channel_id: i64,
    user_id: i64,
    after: i64,
    mentions_only: bool,
) -> Result<Option<MessageRow>, DbError> {
    let mention_filter = if mentions_only {
        " AND EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id AND mm.channel_id = m.channel_id AND mm.user_id = $2)"
    } else {
        ""
    };
    let query = format!("SELECT m.id, m.channel_id, m.author_id, m.content, m.nonce, m.delivery_nonce,
        m.message_type, m.flags, m.edited_at, CASE WHEN m.pinned THEN 1 ELSE 0 END AS pinned,
        m.reference_id, m.e2ee_header, m.created_at, m.embeds, m.components, m.recovery_revision, m.forwarded_from
        FROM messages m WHERE m.channel_id = $1 AND m.id > $3
        AND m.id > COALESCE((SELECT last_message_id FROM read_states WHERE user_id = $2 AND channel_id = $1), 0)
        {mention_filter} ORDER BY m.id ASC LIMIT 1");
    Ok(sqlx::query_as::<_, MessageRow>(&query)
        .bind(channel_id)
        .bind(user_id)
        .bind(after)
        .fetch_optional(pool)
        .await?)
}

/// Store the forward attribution on a message that was just created.
pub async fn set_forwarded_from(
    pool: &DbPool,
    message_id: i64,
    forwarded_from: &str,
) -> Result<(), DbError> {
    sqlx::query("UPDATE messages SET forwarded_from = $2 WHERE id = $1")
        .bind(message_id)
        .bind(forwarded_from)
        .execute(pool)
        .await?;
    Ok(())
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
    create_message_with_delivery_typed(
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
        components_json,
        embeds_json,
        nonce,
        &[],
    )
    .await
}

/// Payload crypto state and delivery identity are separate. The receipt and
/// message commit together; a receipt remains when its message is deleted.
/// Serialize mutations of a channel's message set before reading or writing it.
/// This non-key update takes the same row lock on PostgreSQL and SQLite; unlike
/// locking after INSERT/DELETE, a later recomputation sees every preceding commit.
async fn lock_message_channel(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    channel_id: i64,
) -> Result<(), DbError> {
    sqlx::query("UPDATE channels SET last_message_id = last_message_id WHERE id = $1")
        .bind(channel_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn repair_message_channel(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    channel_id: i64,
) -> Result<(), DbError> {
    sqlx::query("UPDATE channels SET last_message_id = (SELECT MAX(id) FROM messages WHERE channel_id = $1) WHERE id = $1")
        .bind(channel_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn create_message_with_delivery_typed(
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
    delivery_nonce: Option<&str>,
    mentioned_users: &[i64],
) -> Result<MessageRow, DbError> {
    let delivery_nonce = delivery_nonce
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut tx = pool.begin().await?;
    lock_message_channel(&mut tx, channel_id.get()).await?;
    if let Some(key) = delivery_nonce {
        let claimed: Option<(i64,)> = sqlx::query_as(
            "INSERT INTO message_delivery_receipts (channel_id, author_id, nonce, message_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (channel_id, author_id, nonce) DO NOTHING RETURNING message_id",
        )
        .bind(channel_id)
        .bind(author_id)
        .bind(key)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
        if claimed.is_none() {
            let (previous_id, cancelled): (i64, i64) = sqlx::query_as(
                "SELECT message_id, CASE WHEN cancelled THEN 1 ELSE 0 END FROM message_delivery_receipts WHERE channel_id = $1 AND author_id = $2 AND nonce = $3",
            ).bind(channel_id).bind(author_id).bind(key).fetch_one(&mut *tx).await?;
            if cancelled != 0 {
                tx.commit().await?;
                return Err(DbError::DeliveryCancelled);
            }
            let existing = sqlx::query_as::<_, MessageRow>(
                "SELECT id, channel_id, author_id, content, nonce, delivery_nonce, message_type, flags,
                 edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components, recovery_revision, forwarded_from
                 FROM messages WHERE id = $1 AND channel_id = $2 AND author_id = $3",
            ).bind(previous_id).bind(channel_id).bind(author_id).fetch_optional(&mut *tx).await?;
            tx.commit().await?;
            return existing.ok_or(DbError::DeliveryAlreadyDeleted);
        }
    }
    let mut row = sqlx::query_as::<_, MessageRow>(
        "INSERT INTO messages (id, channel_id, author_id, content, nonce, delivery_nonce, message_type, flags, reference_id, e2ee_header, components, embeds)
         VALUES ($1, $2, $3, $4, $5, $12, $6, $7, $8, $9, $10, $11)
         RETURNING id, channel_id, author_id, content, nonce, delivery_nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components, recovery_revision, forwarded_from",
    ).bind(id).bind(channel_id).bind(author_id).bind(content).bind(nonce)
        .bind(message_type).bind(flags).bind(reference_id).bind(e2ee_header)
        .bind(components_json).bind(embeds_json).bind(delivery_nonce)
        .fetch_one(&mut *tx).await?;
    // The channel pointer and message are one commit. A delayed older write
    // cannot move the live channel tail backwards.
    sqlx::query("UPDATE channels SET last_message_id = CASE WHEN last_message_id IS NULL OR last_message_id < $1 THEN $1 ELSE last_message_id END WHERE id = $2")
        .bind(row.id).bind(channel_id).execute(&mut *tx).await?;
    crate::message_recovery::record_upsert(&mut tx, &mut row, "create").await?;
    // Sorted lock order and bounded inserts keep a guild-wide mention in the
    // same commit as its message and delivery receipt.
    let recipients: std::collections::BTreeSet<i64> = mentioned_users
        .iter()
        .copied()
        .filter(|user_id| *user_id != author_id.get())
        .collect();
    let recipients: Vec<i64> = recipients.into_iter().collect();
    for chunk in recipients.chunks(256) {
        // sqlx::Any's QueryBuilder emits '?' parameters, which PostgreSQL does
        // not accept. Numbered parameters are supported by both engines.
        let values = (0..chunk.len())
            .map(|index| format!("($1, $2, ${})", index + 3))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "INSERT INTO message_mentions (message_id, channel_id, user_id) VALUES {values}"
        );
        let mut query = sqlx::query(&sql).bind(id).bind(channel_id);
        for user_id in chunk {
            query = query.bind(*user_id);
        }
        query.execute(&mut *tx).await?;
    }
    if !recipients.is_empty() {
        sqlx::query(
            "INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count)
        SELECT user_id, channel_id, 0, 0 FROM message_mentions WHERE message_id = $1
        ORDER BY user_id ON CONFLICT (user_id, channel_id) DO NOTHING",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(row)
}

#[derive(Debug, PartialEq, Eq)]
pub enum DeliveryResolution {
    Cancelled,
    Delivered(i64),
    Deleted(i64),
}

/// Seal an uncertain delivery. The unique receipt arbitrates against concurrent
/// creation: either creation committed first, or no future create can succeed.
/// A reserved snowflake identifies the receipt without creating a message row.
pub async fn resolve_message_delivery(
    pool: &DbPool,
    channel_id: i64,
    author_id: i64,
    nonce: &str,
    reservation_id: i64,
) -> Result<DeliveryResolution, DbError> {
    let mut tx = pool.begin().await?;
    let claimed: Option<(i64,)> = sqlx::query_as(
        "INSERT INTO message_delivery_receipts (channel_id, author_id, nonce, message_id, cancelled)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (channel_id, author_id, nonce) DO NOTHING RETURNING message_id",
    ).bind(channel_id).bind(author_id).bind(nonce).bind(reservation_id)
        .fetch_optional(&mut *tx).await?;
    let result = if claimed.is_some() {
        DeliveryResolution::Cancelled
    } else {
        let (id, cancelled, exists): (i64, i64, i64) = sqlx::query_as(
            "SELECT r.message_id, CASE WHEN r.cancelled THEN 1 ELSE 0 END,
                CASE WHEN m.id IS NOT NULL THEN 1 ELSE 0 END
             FROM message_delivery_receipts r LEFT JOIN messages m
                ON m.id = r.message_id AND m.channel_id = r.channel_id AND m.author_id = r.author_id
             WHERE r.channel_id = $1 AND r.author_id = $2 AND r.nonce = $3",
        )
        .bind(channel_id)
        .bind(author_id)
        .bind(nonce)
        .fetch_one(&mut *tx)
        .await?;
        if cancelled != 0 {
            DeliveryResolution::Cancelled
        } else if exists != 0 {
            DeliveryResolution::Delivered(id)
        } else {
            DeliveryResolution::Deleted(id)
        }
    };
    tx.commit().await?;
    Ok(result)
}

pub async fn create_message_with_delivery_nonce(
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
    delivery_nonce: Option<&str>,
) -> Result<MessageRow, DbError> {
    create_message_with_delivery_typed(
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
        None,
        None,
        delivery_nonce,
        &[],
    )
    .await
}

pub async fn create_message_with_delivery_mentions(
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
    delivery_nonce: Option<&str>,
    mentioned_users: &[i64],
) -> Result<MessageRow, DbError> {
    create_message_with_delivery_typed(
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
        None,
        None,
        delivery_nonce,
        mentioned_users,
    )
    .await
}

/// Read the audience committed with a message, never reconstruct it from edited text.
pub async fn get_message_mention_recipients(
    pool: &DbPool,
    channel_id: i64,
    message_id: i64,
) -> Result<Vec<i64>, DbError> {
    Ok(sqlx::query_scalar(
        "SELECT user_id FROM message_mentions WHERE channel_id = $1 AND message_id = $2 ORDER BY user_id",
    )
    .bind(channel_id)
    .bind(message_id)
    .fetch_all(pool)
    .await?)
}

/// Persist a rich message and its authorized audience in the same transaction.
pub async fn create_message_with_payload_mentions(
    pool: &DbPool,
    id: i64,
    channel_id: i64,
    author_id: i64,
    content: &str,
    message_type: i16,
    reference_id: Option<i64>,
    flags: i32,
    components_json: Option<&str>,
    embeds_json: Option<&str>,
    mentioned_users: &[i64],
) -> Result<MessageRow, DbError> {
    create_message_with_delivery_typed(
        pool,
        MessageId::new(id),
        ChannelId::new(channel_id),
        UserId::new(author_id),
        content,
        message_type,
        reference_id.map(MessageId::new),
        flags,
        None,
        None,
        components_json,
        embeds_json,
        None,
        mentioned_users,
    )
    .await
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

/// Core implementation using newtype ID.
pub async fn get_message_typed(
    pool: &DbPool,
    id: MessageId,
) -> Result<Option<MessageRow>, DbError> {
    let row = sqlx::query_as::<_, MessageRow>(
        "SELECT id, channel_id, author_id, content, nonce, delivery_nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components, recovery_revision, forwarded_from
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
                "SELECT id, channel_id, author_id, content, nonce, delivery_nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components, recovery_revision, forwarded_from
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
                "SELECT id, channel_id, author_id, content, nonce, delivery_nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components, recovery_revision, forwarded_from
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
                "SELECT id, channel_id, author_id, content, nonce, delivery_nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components, recovery_revision, forwarded_from
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
    let channel_id = get_message_typed(pool, id)
        .await?
        .ok_or(DbError::NotFound)?
        .channel_id;
    let mut tx = pool.begin().await?;
    lock_message_channel(&mut tx, channel_id).await?;
    let mut row = sqlx::query_as::<_, MessageRow>(
        "UPDATE messages SET content = $2, edited_at = $3
         WHERE id = $1
         RETURNING id, channel_id, author_id, content, nonce, delivery_nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components, recovery_revision, forwarded_from",
    )
    .bind(id)
    .bind(content)
    .bind(datetime_to_db_text(Utc::now()))
    .fetch_one(&mut *tx)
    .await?;
    crate::message_recovery::record_upsert(&mut tx, &mut row, "update").await?;
    tx.commit().await?;
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
        pool, id, channel_id, actor_id, content, None, None, None, can_manage,
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
/// author check stays in SQL; the update and its history commit atomically.
pub async fn update_message_authorized_typed(
    pool: &DbPool,
    id: MessageId,
    channel_id: ChannelId,
    actor_id: UserId,
    content: &str,
    nonce: Option<&str>,
    e2ee_header: Option<&str>,
    flags: Option<i32>,
    can_manage: bool,
) -> Result<Option<MessageRow>, DbError> {
    Ok(update_message_authorized_with_receipt(
        pool,
        id,
        channel_id,
        actor_id,
        content,
        nonce,
        e2ee_header,
        flags,
        can_manage,
        None,
        &[],
    )
    .await?
    .map(|result| result.message))
}

#[derive(Debug)]
pub struct MessageEditResult {
    pub message: MessageRow,
    pub replayed: bool,
}

pub fn message_edit_request_hash(
    id: i64,
    content: &str,
    nonce: Option<&str>,
    header: Option<&str>,
    flags: Option<i32>,
) -> String {
    use sha2::Digest;
    let request = serde_json::json!([id, content, nonce, header, flags]).to_string();
    format!("{:x}", sha2::Sha256::digest(request.as_bytes()))
}

#[derive(Debug, sqlx::FromRow)]
pub struct MessageEditReceipt {
    pub message_id: i64,
    pub request_hash: String,
    pub cancelled: i64,
}

pub async fn find_message_edit_receipt(
    pool: &DbPool,
    channel_id: i64,
    actor_id: i64,
    edit_nonce: &str,
) -> Result<Option<MessageEditReceipt>, DbError> {
    Ok(sqlx::query_as("SELECT message_id, request_hash, CASE WHEN cancelled THEN 1 ELSE 0 END AS cancelled FROM message_edit_receipts WHERE channel_id = $1 AND actor_id = $2 AND edit_nonce = $3")
        .bind(channel_id).bind(actor_id).bind(edit_nonce).fetch_optional(pool).await?)
}

#[derive(Debug, PartialEq, Eq)]
pub enum MessageEditResolution {
    Cancelled,
    Applied,
    Deleted,
}

/// Caller verifies channel visibility. Lock the message before the receipt,
/// matching PATCH's lock order so resolving and editing cannot deadlock.
pub async fn resolve_message_edit(
    pool: &DbPool,
    channel_id: i64,
    message_id: i64,
    actor_id: i64,
    edit_nonce: &str,
) -> Result<MessageEditResolution, DbError> {
    let mut tx = pool.begin().await?;
    let target: Option<(i64,)> = sqlx::query_as(
        "UPDATE messages SET id = id WHERE id = $1 AND channel_id = $2 RETURNING id",
    )
    .bind(message_id)
    .bind(channel_id)
    .fetch_optional(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO message_edit_receipts (channel_id, actor_id, edit_nonce, message_id, request_hash, cancelled)
        VALUES ($1, $2, $3, $4, '', TRUE) ON CONFLICT (channel_id, actor_id, edit_nonce) DO NOTHING")
        .bind(channel_id).bind(actor_id).bind(edit_nonce).bind(message_id).execute(&mut *tx).await?;
    let receipt: MessageEditReceipt = sqlx::query_as(
        "SELECT message_id, request_hash, CASE WHEN cancelled THEN 1 ELSE 0 END AS cancelled
         FROM message_edit_receipts WHERE channel_id = $1 AND actor_id = $2 AND edit_nonce = $3",
    )
    .bind(channel_id)
    .bind(actor_id)
    .bind(edit_nonce)
    .fetch_one(&mut *tx)
    .await?;
    if receipt.message_id != message_id {
        return Err(DbError::Conflict(
            "This edit nonce belongs to another target message.".into(),
        ));
    }
    let result = if receipt.cancelled != 0 {
        MessageEditResolution::Cancelled
    } else if target.is_some() {
        MessageEditResolution::Applied
    } else {
        MessageEditResolution::Deleted
    };
    tx.commit().await?;
    Ok(result)
}

pub async fn update_message_authorized_with_receipt(
    pool: &DbPool,
    id: MessageId,
    channel_id: ChannelId,
    actor_id: UserId,
    content: &str,
    nonce: Option<&str>,
    e2ee_header: Option<&str>,
    flags: Option<i32>,
    can_manage: bool,
    edit_nonce: Option<&str>,
    hits: &[crate::automod::AutomodHitRow],
) -> Result<Option<MessageEditResult>, DbError> {
    let mut transaction = pool.begin().await?;
    lock_message_channel(&mut transaction, channel_id.get()).await?;
    // Acquire the SQLite write lock before reading and the PostgreSQL row lock.
    // The SQL authorization predicate also prevents rejected edits from writing
    // history. Competing edits snapshot the immediately preceding committed body.
    let previous = sqlx::query_as::<_, MessageRow>(
        "UPDATE messages SET id = id
         WHERE id = $1 AND channel_id = $2 AND (author_id = $3 OR $4)
         RETURNING id, channel_id, author_id, content, nonce, delivery_nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components, recovery_revision, forwarded_from",
    )
    .bind(id)
    .bind(channel_id)
    .bind(actor_id)
    .bind(can_manage)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(previous) = previous else {
        transaction.rollback().await?;
        return Ok(None);
    };
    let request_hash = message_edit_request_hash(id.get(), content, nonce, e2ee_header, flags);
    if let Some(edit_nonce) = edit_nonce {
        let receipt: Option<MessageEditReceipt> = sqlx::query_as(
            "SELECT message_id, request_hash, CASE WHEN cancelled THEN 1 ELSE 0 END AS cancelled FROM message_edit_receipts WHERE channel_id = $1 AND actor_id = $2 AND edit_nonce = $3")
            .bind(channel_id).bind(actor_id).bind(edit_nonce).fetch_optional(&mut *transaction).await?;
        if let Some(receipt) = receipt {
            if receipt.message_id == id.get() && receipt.cancelled != 0 {
                return Err(DbError::EditCancelled);
            }
            if receipt.message_id != id.get() || receipt.request_hash != request_hash {
                return Err(DbError::Conflict(
                    "This edit nonce was already used for a different request.".into(),
                ));
            }
            transaction.rollback().await?;
            return Ok(Some(MessageEditResult {
                message: previous,
                replayed: true,
            }));
        }
    }
    if let Some(content) = previous.content.as_deref() {
        sqlx::query("INSERT INTO message_edits (message_id, content) VALUES ($1, $2)")
            .bind(id)
            .bind(content)
            .execute(&mut *transaction)
            .await?;
    }
    let mut row = sqlx::query_as::<_, MessageRow>(
        "UPDATE messages
         SET content = $4,
             edited_at = $5,
             nonce = $6,
             flags = COALESCE($7, flags),
             e2ee_header = $9
         WHERE id = $1
           AND channel_id = $2
           AND (author_id = $3 OR $8)
         RETURNING id, channel_id, author_id, content, nonce, delivery_nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components, recovery_revision, forwarded_from",
    )
    .bind(id)
    .bind(channel_id)
    .bind(actor_id)
    .bind(content)
    .bind(datetime_to_db_text(Utc::now()))
    .bind(nonce)
    .bind(flags)
    .bind(can_manage)
    .bind(e2ee_header)
    .fetch_one(&mut *transaction)
    .await?;
    for hit in hits {
        crate::automod::record_hit_in_connection(&mut transaction, hit).await?;
    }
    if let Some(edit_nonce) = edit_nonce {
        let inserted = sqlx::query("INSERT INTO message_edit_receipts (channel_id, actor_id, edit_nonce, message_id, request_hash) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (channel_id, actor_id, edit_nonce) DO NOTHING")
            .bind(channel_id).bind(actor_id).bind(edit_nonce).bind(id).bind(request_hash)
            .execute(&mut *transaction).await?;
        if inserted.rows_affected() != 1 {
            return Err(DbError::Conflict(
                "This edit nonce was already used for a different request.".into(),
            ));
        }
    }
    crate::message_recovery::record_upsert(&mut transaction, &mut row, "update").await?;
    transaction.commit().await?;
    Ok(Some(MessageEditResult {
        message: row,
        replayed: false,
    }))
}

/// Raw i64 shim kept for API compat.
pub async fn update_message_authorized_with_meta(
    pool: &DbPool,
    id: i64,
    channel_id: i64,
    actor_id: i64,
    content: &str,
    nonce: Option<&str>,
    e2ee_header: Option<&str>,
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
        e2ee_header,
        flags,
        can_manage,
    )
    .await
}

/// Core implementation using newtype ID.
pub async fn delete_message_typed(pool: &DbPool, id: MessageId) -> Result<(), DbError> {
    delete_messages_by_ids(pool, &[id.get()]).await?;
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
/// denials are respected. The author check stays in SQL, and tail repair commits in the
/// same transaction as the authorized deletion.
pub async fn delete_message_authorized_typed(
    pool: &DbPool,
    id: MessageId,
    channel_id: ChannelId,
    actor_id: UserId,
    can_manage: bool,
) -> Result<bool, DbError> {
    Ok(matches!(
        delete_message_with_receipt(
            pool,
            id.get(),
            channel_id.get(),
            actor_id.get(),
            can_manage,
            None,
            false
        )
        .await?,
        MessageDeletionResult::Deleted { .. }
    ))
}

#[derive(Debug, PartialEq, Eq)]
pub enum MessageDeletionResult {
    Deleted { replayed: bool },
    Pending,
    Missing,
    Forbidden,
}

/// Caller verifies membership and channel visibility. Resolve and delete share
/// the channel lock with every message create/delete writer. A receipt and tail
/// repair commit with the deletion; a read-only resolution never seals a nonce.
pub async fn delete_message_with_receipt(
    pool: &DbPool,
    id: i64,
    channel_id: i64,
    actor_id: i64,
    can_manage: bool,
    delete_nonce: Option<&str>,
    resolve_only: bool,
) -> Result<MessageDeletionResult, DbError> {
    let mut tx = pool.begin().await?;
    lock_message_channel(&mut tx, channel_id).await?;
    if let Some(delete_nonce) = delete_nonce {
        let receipt: Option<(i64,)> = sqlx::query_as(
            "SELECT message_id FROM message_delete_receipts WHERE channel_id = $1 AND actor_id = $2 AND delete_nonce = $3",
        )
        .bind(channel_id).bind(actor_id).bind(delete_nonce)
        .fetch_optional(&mut *tx).await?;
        if let Some((target,)) = receipt {
            if target != id {
                return Err(DbError::Conflict(
                    "This deletion nonce belongs to another target message.".into(),
                ));
            }
            tx.rollback().await?;
            return Ok(MessageDeletionResult::Deleted { replayed: true });
        }
    }
    let author: Option<(i64,)> =
        sqlx::query_as("SELECT author_id FROM messages WHERE id = $1 AND channel_id = $2")
            .bind(id)
            .bind(channel_id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((author_id,)) = author else {
        tx.rollback().await?;
        return Ok(MessageDeletionResult::Missing);
    };
    if author_id != actor_id && !can_manage {
        tx.rollback().await?;
        return Ok(MessageDeletionResult::Forbidden);
    }
    if resolve_only {
        tx.rollback().await?;
        return Ok(MessageDeletionResult::Pending);
    }
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
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() != 1 {
        tx.rollback().await?;
        return Ok(MessageDeletionResult::Missing);
    }
    if let Some(delete_nonce) = delete_nonce {
        sqlx::query("INSERT INTO message_delete_receipts (channel_id, actor_id, delete_nonce, message_id) VALUES ($1, $2, $3, $4)")
            .bind(channel_id).bind(actor_id).bind(delete_nonce).bind(id)
            .execute(&mut *tx).await?;
    }
    crate::message_recovery::record_delete(&mut tx, channel_id, id).await?;
    repair_message_channel(&mut tx, channel_id).await?;
    tx.commit().await?;
    Ok(MessageDeletionResult::Deleted { replayed: false })
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
        "SELECT id, channel_id, author_id, content, nonce, delivery_nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components, recovery_revision, forwarded_from
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
    let mut tx = pool.begin().await?;
    lock_message_channel(&mut tx, channel_id.get()).await?;
    // Re-pinning an already-pinned message is a no-op and must not count against
    // the cap, so only enforce the limit when this message is not yet pinned.
    let already_pinned: Option<i64> = sqlx::query_scalar(
        "SELECT CASE WHEN pinned THEN 1 ELSE 0 END FROM messages WHERE id = $1 AND channel_id = $2",
    )
    .bind(id)
    .bind(channel_id)
    .fetch_optional(&mut *tx)
    .await?;
    match already_pinned {
        None => return Ok(false),
        Some(1) => return Ok(true),
        _ => {}
    }

    let pinned_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE channel_id = $1 AND pinned = TRUE")
            .bind(channel_id)
            .fetch_one(&mut *tx)
            .await?;
    if pinned_count >= MAX_PINS_PER_CHANNEL {
        return Err(DbError::LimitReached(format!(
            "channel already has the maximum of {} pinned messages",
            MAX_PINS_PER_CHANNEL
        )));
    }

    let mut row = sqlx::query_as::<_, MessageRow>("UPDATE messages SET pinned = TRUE WHERE id = $1 AND channel_id = $2 RETURNING id, channel_id, author_id, content, nonce, delivery_nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components, recovery_revision, forwarded_from")
        .bind(id).bind(channel_id).fetch_one(&mut *tx).await?;
    crate::message_recovery::record_metadata_update(&mut tx, &mut row).await?;
    tx.commit().await?;
    Ok(true)
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
    let mut tx = pool.begin().await?;
    lock_message_channel(&mut tx, channel_id.get()).await?;
    let row = sqlx::query_as::<_, MessageRow>("UPDATE messages SET pinned = FALSE WHERE id = $1 AND channel_id = $2 RETURNING id, channel_id, author_id, content, nonce, delivery_nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components, recovery_revision, forwarded_from")
        .bind(id).bind(channel_id).fetch_optional(&mut *tx).await?;
    let changed = row.is_some();
    if let Some(mut row) = row {
        crate::message_recovery::record_metadata_update(&mut tx, &mut row).await?;
    }
    tx.commit().await?;
    Ok(changed)
}

/// Raw i64 shim kept for API compat.
pub async fn unpin_message(pool: &DbPool, id: i64, channel_id: i64) -> Result<bool, DbError> {
    unpin_message_typed(pool, MessageId::new(id), ChannelId::new(channel_id)).await
}

/// Core implementation using newtype ID. ids remain i64 since they're a bulk slice.
pub async fn bulk_delete_messages_with_revisions(
    pool: &DbPool,
    channel_id: ChannelId,
    ids: &[MessageId],
) -> Result<Vec<(i64, i64)>, DbError> {
    const MAX_BULK_MESSAGE_IDS: usize = 500;
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    if ids.len() > MAX_BULK_MESSAGE_IDS {
        return Err(DbError::Sqlx(sqlx::Error::Protocol(
            "too many message ids in bulk delete".to_string(),
        )));
    }
    let mut tx = pool.begin().await?;
    lock_message_channel(&mut tx, channel_id.get()).await?;
    let channel_bind_index = ids.len() + 1;
    let sql = format!(
        "DELETE FROM messages WHERE id IN ({}) AND channel_id = ${} RETURNING id",
        build_placeholders(1, ids.len()),
        channel_bind_index
    );
    let mut query = sqlx::query(&sql);
    for id in ids {
        query = query.bind(*id);
    }
    query = query.bind(channel_id);
    let deleted = query.fetch_all(&mut *tx).await?;
    let mut revisions = Vec::with_capacity(deleted.len());
    for row in &deleted {
        let id = row.try_get("id")?;
        let revision =
            crate::message_recovery::record_delete(&mut tx, channel_id.get(), id).await?;
        revisions.push((id, revision));
    }
    if !deleted.is_empty() {
        repair_message_channel(&mut tx, channel_id.get()).await?;
    }
    tx.commit().await?;
    Ok(revisions)
}

pub async fn bulk_delete_messages_typed(
    pool: &DbPool,
    channel_id: ChannelId,
    ids: &[MessageId],
) -> Result<u64, DbError> {
    Ok(bulk_delete_messages_with_revisions(pool, channel_id, ids)
        .await?
        .len() as u64)
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
    let ids = [channel_id];
    let page = crate::message_search::search_messages_page(
        pool,
        &crate::message_search::MessageSearch {
            channel_ids: &ids,
            query: Some(query),
            author_id,
            after,
            before,
            pinned: None,
            mentions_user_id: None,
            has: &[],
            limit,
            offset: 0,
            order: crate::message_search::MessageSearchOrder::Relevance,
        },
    )
    .await?;
    Ok(page.messages)
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

/// Full-text search across a set of channels in one ranked query.
///
/// Forum search passes every post channel id and takes the top `limit`
/// matches. The SQL lives in [`crate::message_search`] so guild search can
/// apply the same filters. E2EE messages are excluded. An empty channel list
/// returns an empty vec.
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
    let page = crate::message_search::search_messages_page(
        pool,
        &crate::message_search::MessageSearch {
            channel_ids,
            query: Some(query),
            author_id,
            after,
            before,
            pinned: None,
            mentions_user_id: None,
            has: &[],
            limit,
            offset: 0,
            order: crate::message_search::MessageSearchOrder::Relevance,
        },
    )
    .await?;
    Ok(page.messages)
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
        "SELECT id, channel_id, author_id, content, nonce, delivery_nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components, recovery_revision, forwarded_from
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
        "SELECT m.id, m.channel_id, m.author_id, m.content, m.nonce, m.delivery_nonce, m.message_type, m.flags,
                m.edited_at, CASE WHEN m.pinned THEN 1 ELSE 0 END AS pinned, m.reference_id,
                m.e2ee_header, m.created_at, m.embeds, m.components, m.recovery_revision, m.forwarded_from
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
        // `channels` has no `guild_id`: 20260211000001 renamed it to `space_id`.
        // The old text failed on both engines, and the only caller swallowed the
        // error with `.unwrap_or(0)`, so this count was permanently zero.
        "SELECT COUNT(*)
         FROM messages m
         INNER JOIN channels c ON c.id = m.channel_id
         WHERE c.space_id = $1
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

/// How many messages one author has posted in a channel since `since`.
/// Backs AutoMod's message-spam trigger.
pub async fn count_user_messages_since(
    pool: &DbPool,
    channel_id: i64,
    author_id: i64,
    since: DateTime<Utc>,
) -> Result<i64, DbError> {
    let since_text = datetime_to_db_text(since);
    let row: (i64,) = sqlx::query_as(
        "SELECT COUNT(*)
         FROM messages
         WHERE channel_id = $1
           AND author_id = $2
           AND created_at >= $3",
    )
    .bind(channel_id)
    .bind(author_id)
    .bind(since_text)
    .fetch_one(pool)
    .await?;
    Ok(row.0)
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
    // Resolve immutable channel ownership before opening a write transaction.
    // In particular, a SQLite read transaction must not be upgraded after a
    // competing writer commits. Sorted locks also prevent cross-channel cycles.
    let lookup = format!(
        "SELECT DISTINCT channel_id FROM messages WHERE id IN ({}) ORDER BY channel_id",
        build_placeholders(1, ids.len())
    );
    let mut query = sqlx::query_as::<_, (i64,)>(&lookup);
    for id in ids {
        query = query.bind(id);
    }
    let channels = query.fetch_all(pool).await?;
    if channels.is_empty() {
        return Ok(0);
    }
    let mut tx = pool.begin().await?;
    for (channel_id,) in &channels {
        lock_message_channel(&mut tx, *channel_id).await?;
    }
    let sql = format!(
        "DELETE FROM messages WHERE id IN ({}) AND channel_id IN ({}) RETURNING id, channel_id",
        build_placeholders(1, ids.len()),
        build_placeholders(ids.len() + 1, channels.len())
    );
    let mut query = sqlx::query(&sql);
    for id in ids {
        query = query.bind(id);
    }
    for (channel_id,) in &channels {
        query = query.bind(channel_id);
    }
    let deleted = query.fetch_all(&mut *tx).await?;
    for row in &deleted {
        crate::message_recovery::record_delete(
            &mut tx,
            row.try_get("channel_id")?,
            row.try_get("id")?,
        )
        .await?;
    }
    if !deleted.is_empty() {
        for (channel_id,) in channels {
            repair_message_channel(&mut tx, channel_id).await?;
        }
    }
    tx.commit().await?;
    Ok(deleted.len() as u64)
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

/// Get the edit history for a message, ordered oldest first.
pub async fn get_edit_history_typed(
    pool: &DbPool,
    message_id: MessageId,
) -> Result<Vec<EditHistoryRow>, DbError> {
    let rows = sqlx::query_as::<_, EditHistoryRow>(
        "SELECT id, message_id, content, CAST(edited_at AS TEXT) AS edited_at FROM message_edits WHERE message_id = $1 ORDER BY id ASC",
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

async fn update_message_property(
    pool: &DbPool,
    id: MessageId,
    property: &str,
    value: &str,
) -> Result<(), DbError> {
    if !matches!(property, "embeds" | "components") {
        return Err(DbError::Conflict("Invalid message property".into()));
    }
    let Some(existing) = get_message_typed(pool, id).await? else {
        return Ok(());
    };
    let mut tx = pool.begin().await?;
    lock_message_channel(&mut tx, existing.channel_id).await?;
    let sql = format!("UPDATE messages SET {property} = $2 WHERE id = $1 RETURNING id, channel_id, author_id, content, nonce, delivery_nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components, recovery_revision, forwarded_from");
    if let Some(mut row) = sqlx::query_as::<_, MessageRow>(&sql)
        .bind(id)
        .bind(value)
        .fetch_optional(&mut *tx)
        .await?
    {
        crate::message_recovery::record_metadata_update(&mut tx, &mut row).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Store serialized embeds JSON on a message. Does not update `edited_at`.
pub async fn update_message_embeds_typed(
    pool: &DbPool,
    id: MessageId,
    embeds_json: &str,
) -> Result<(), DbError> {
    update_message_property(pool, id, "embeds", embeds_json).await
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
    update_message_property(pool, id, "components", components_json).await
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
        "SELECT id, channel_id, author_id, content, nonce, delivery_nonce, message_type, flags, edited_at, CASE WHEN pinned THEN 1 ELSE 0 END AS pinned, reference_id, e2ee_header, created_at, embeds, components, recovery_revision, forwarded_from
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
        "SELECT ms.message_id AS message_id, s.id, s.guild_id, s.name, s.description, s.tags, s.format_type,
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

/// True when a recent message in the channel is end-to-end encrypted.
///
/// Guild text channels store the words themselves. A direct message or a group
/// conversation stores ciphertext, and the newest row is enough to tell them apart.
pub async fn channel_has_ciphertext(pool: &DbPool, channel_id: i64) -> Result<bool, DbError> {
    let row = sqlx::query(
        "SELECT flags, e2ee_header FROM messages WHERE channel_id = $1 ORDER BY id DESC LIMIT 1",
    )
    .bind(channel_id)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let flags: i32 = row.try_get("flags")?;
    let header: Option<String> = row.try_get("e2ee_header")?;
    Ok(flags & 1 != 0 || header.is_some())
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
        sqlx::query("INSERT INTO channels (id, space_id, name, channel_type, position) VALUES ($1, $2, 'general', 0, 0)")
            .bind(channel_id).bind(guild_id).execute(pool).await.unwrap();
        (user_id, guild_id, channel_id)
    }

    #[tokio::test]
    async fn mention_migration_preserves_legacy_counts_without_inventing_message_targets() {
        let pool = crate::create_pool("sqlite::memory:", 1).await.unwrap();
        let mut previous = sqlx::migrate!("./migrations");
        previous.migrations = std::borrow::Cow::Owned(
            previous
                .iter()
                .filter(|migration| migration.version < 20260909000008)
                .cloned()
                .collect(),
        );
        previous.run(&pool).await.unwrap();
        let (author, _, channel) = setup_channel(&pool).await;
        let recipient = 2;
        crate::users::create_user(
            &pool,
            recipient,
            "recipient",
            2,
            "recipient@example.com",
            "hash",
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO messages (id, channel_id, author_id, content) VALUES (1000, $1, $2, 'old context')")
            .bind(channel).bind(author).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count) VALUES ($1, $2, 0, 2)")
            .bind(recipient).bind(channel).execute(&pool).await.unwrap();
        crate::run_migrations(&pool).await.unwrap();
        assert_eq!(
            crate::read_states::get_read_state(&pool, recipient, channel)
                .await
                .unwrap()
                .unwrap()
                .mention_count,
            2
        );
        assert!(get_attention_target(&pool, channel, recipient, 0, true)
            .await
            .unwrap()
            .is_none());
        create_message_with_delivery_mentions(
            &pool,
            1001,
            channel,
            author,
            "new mention",
            0,
            None,
            0,
            None,
            None,
            Some("new-mention"),
            &[recipient],
        )
        .await
        .unwrap();
        assert_eq!(
            crate::read_states::get_read_state(&pool, recipient, channel)
                .await
                .unwrap()
                .unwrap()
                .mention_count,
            3
        );
        let read = crate::read_states::update_read_state(&pool, recipient, channel, 1000)
            .await
            .unwrap();
        assert_eq!(read.mention_count, 1);
        assert_eq!(
            get_attention_target(&pool, channel, recipient, 0, true)
                .await
                .unwrap()
                .unwrap()
                .id,
            1001
        );
    }

    #[tokio::test]
    async fn tail_migration_repairs_historical_deletions_without_rewinding_reads() {
        let pool = crate::create_pool("sqlite::memory:", 1).await.unwrap();
        let mut previous = sqlx::migrate!("./migrations");
        previous.migrations = std::borrow::Cow::Owned(
            previous
                .iter()
                .filter(|migration| migration.version < 20260909000009)
                .cloned()
                .collect(),
        );
        previous.run(&pool).await.unwrap();
        let (author, guild, channel) = setup_channel(&pool).await;
        let empty = channel + 1;
        sqlx::query("INSERT INTO channels (id, space_id, name, channel_type, position) VALUES ($1, $2, 'empty', 0, 1)")
            .bind(empty).bind(guild).execute(&pool).await.unwrap();
        for (id, target) in [(1000, channel), (1001, channel), (1002, empty)] {
            sqlx::query("INSERT INTO messages (id, channel_id, author_id, content) VALUES ($1, $2, $3, 'legacy')")
                .bind(id).bind(target).bind(author).execute(&pool).await.unwrap();
            sqlx::query("UPDATE channels SET last_message_id = $1 WHERE id = $2")
                .bind(id)
                .bind(target)
                .execute(&pool)
                .await
                .unwrap();
        }
        crate::read_states::update_read_state(&pool, author, channel, 1001)
            .await
            .unwrap();
        // Reproduce released deletion behavior, bypassing the repaired helpers.
        sqlx::query("DELETE FROM messages WHERE id IN (1001, 1002)")
            .execute(&pool)
            .await
            .unwrap();
        let (legacy_tail,): (i64,) =
            sqlx::query_as("SELECT last_message_id FROM channels WHERE id = $1")
                .bind(channel)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(legacy_tail, 1001);
        crate::run_migrations(&pool).await.unwrap();
        assert_eq!(
            crate::channels::get_channel(&pool, channel)
                .await
                .unwrap()
                .unwrap()
                .last_message_id,
            Some(1000)
        );
        assert_eq!(
            crate::channels::get_channel(&pool, empty)
                .await
                .unwrap()
                .unwrap()
                .last_message_id,
            None
        );
        assert_eq!(
            crate::read_states::get_read_state(&pool, author, channel)
                .await
                .unwrap()
                .unwrap()
                .last_message_id,
            1001
        );
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
    async fn test_search_page_filters_without_text_are_newest_first() {
        let pool = test_pool().await;
        let (user_id, _, channel_id) = setup_channel(&pool).await;
        let channel = ChannelId::new(channel_id);
        create_message_typed(
            &pool,
            MessageId::new(9200),
            channel,
            UserId::new(user_id),
            "older note",
            0,
            None,
        )
        .await
        .unwrap();
        create_message_typed(
            &pool,
            MessageId::new(9201),
            channel,
            UserId::new(user_id),
            "newer note https://example.com/x",
            0,
            None,
        )
        .await
        .unwrap();
        sqlx::query("UPDATE messages SET created_at = '2020-01-01 00:00:00' WHERE id = 9200")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE messages SET created_at = '2020-06-01 00:00:00' WHERE id = 9201")
            .execute(&pool)
            .await
            .unwrap();
        pin_message_typed(&pool, MessageId::new(9200), channel)
            .await
            .unwrap();

        let page = crate::message_search::search_messages_page(
            &pool,
            &crate::message_search::MessageSearch {
                channel_ids: &[channel],
                query: None,
                author_id: None,
                after: None,
                before: None,
                pinned: Some(true),
                mentions_user_id: None,
                has: &[],
                limit: 25,
                offset: 0,
                order: crate::message_search::MessageSearchOrder::Newest,
            },
        )
        .await
        .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.messages[0].id, 9200);

        let links = crate::message_search::search_messages_page(
            &pool,
            &crate::message_search::MessageSearch {
                channel_ids: &[channel],
                query: None,
                author_id: None,
                after: None,
                before: None,
                pinned: None,
                mentions_user_id: None,
                has: &[crate::message_search::MessageHas::Link],
                limit: 25,
                offset: 0,
                order: crate::message_search::MessageSearchOrder::Newest,
            },
        )
        .await
        .unwrap();
        assert_eq!(links.total, 1);
        assert_eq!(links.messages[0].id, 9201);

        let both = crate::message_search::search_messages_page(
            &pool,
            &crate::message_search::MessageSearch {
                channel_ids: &[channel],
                query: Some("note"),
                author_id: None,
                after: None,
                before: None,
                pinned: None,
                mentions_user_id: None,
                has: &[],
                limit: 10,
                offset: 0,
                order: crate::message_search::MessageSearchOrder::Newest,
            },
        )
        .await
        .unwrap();
        let ids: Vec<i64> = both.messages.iter().map(|message| message.id).collect();
        assert_eq!(ids, vec![9201, 9200]);
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
    async fn edit_cancellation_migration_preserves_existing_success_receipts() {
        let pool = crate::create_pool("sqlite::memory:", 1).await.unwrap();
        let mut previous = sqlx::migrate!("./migrations");
        previous.migrations = std::borrow::Cow::Owned(
            previous
                .iter()
                .filter(|migration| migration.version < 20260909000007)
                .cloned()
                .collect(),
        );
        previous.run(&pool).await.unwrap();
        let (actor, _, channel) = setup_channel(&pool).await;
        sqlx::query("INSERT INTO messages (id, channel_id, author_id, content) VALUES (15590, $1, $2, 'Newer content')")
            .bind(channel).bind(actor).execute(&pool).await.unwrap();
        let hash = message_edit_request_hash(15590, "Previous edit", None, None, None);
        sqlx::query("INSERT INTO message_edit_receipts (channel_id, actor_id, edit_nonce, message_id, request_hash) VALUES ($1, $2, 'old-edit', 15590, $3)")
                .bind(channel).bind(actor).bind(hash).execute(&pool).await.unwrap();
        crate::run_migrations(&pool).await.unwrap();
        assert_eq!(
            resolve_message_edit(&pool, channel, 15590, actor, "old-edit")
                .await
                .unwrap(),
            MessageEditResolution::Applied
        );
        let replay = update_message_authorized_with_receipt(
            &pool,
            MessageId::new(15590),
            ChannelId::new(channel),
            UserId::new(actor),
            "Previous edit",
            None,
            None,
            None,
            false,
            Some("old-edit"),
            &[],
        )
        .await
        .unwrap()
        .unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.message.content.as_deref(), Some("Newer content"));
        assert_eq!(
            resolve_message_edit(&pool, channel, 15590, actor, "new-cancelled-edit")
                .await
                .unwrap(),
            MessageEditResolution::Cancelled
        );
        let rejected = update_message_authorized_with_receipt(
            &pool,
            MessageId::new(15590),
            ChannelId::new(channel),
            UserId::new(actor),
            "Must not apply",
            None,
            None,
            None,
            false,
            Some("new-cancelled-edit"),
            &[],
        )
        .await
        .unwrap_err();
        assert!(matches!(rejected, DbError::EditCancelled));
        assert!(get_edit_history(&pool, 15590).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn delivery_migration_preserves_existing_ciphertext_and_nonce() {
        let pool = crate::create_pool("sqlite::memory:", 1).await.unwrap();
        let mut previous = sqlx::migrate!("./migrations");
        previous.migrations = std::borrow::Cow::Owned(
            previous
                .iter()
                .filter(|migration| migration.version < 20260909000001)
                .cloned()
                .collect(),
        );
        previous.run(&pool).await.unwrap();
        let (user, _, channel) = setup_channel(&pool).await;
        sqlx::query("INSERT INTO messages (id, channel_id, author_id, content, nonce, flags, e2ee_header) VALUES (15501, $1, $2, 'old-ciphertext', 'old-iv', 1, 'old-header')")
            .bind(channel).bind(user).execute(&pool).await.unwrap();
        crate::run_migrations(&pool).await.unwrap();
        let migrated = get_message(&pool, 15501).await.unwrap().unwrap();
        assert_eq!(migrated.content.as_deref(), Some("old-ciphertext"));
        assert_eq!(migrated.nonce.as_deref(), Some("old-iv"));
        assert_eq!(migrated.e2ee_header.as_deref(), Some("old-header"));
        assert_eq!(migrated.delivery_nonce.as_deref(), Some("old-iv"));
        let (receipt,): (i64,) = sqlx::query_as("SELECT message_id FROM message_delivery_receipts WHERE channel_id=$1 AND author_id=$2 AND nonce='old-iv'")
            .bind(channel).bind(user).fetch_one(&pool).await.unwrap();
        assert_eq!(receipt, migrated.id);
        assert_eq!(
            resolve_message_delivery(&pool, channel, user, "old-iv", 15502)
                .await
                .unwrap(),
            DeliveryResolution::Delivered(migrated.id)
        );
        let edited = update_message_authorized_with_receipt(
            &pool,
            MessageId::new(migrated.id),
            ChannelId::new(channel),
            UserId::new(user),
            "migrated-edit",
            Some("new-iv"),
            Some("new-header"),
            Some(1),
            false,
            Some("upgrade-edit"),
            &[],
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!edited.replayed);
        let replay = update_message_authorized_with_receipt(
            &pool,
            MessageId::new(migrated.id),
            ChannelId::new(channel),
            UserId::new(user),
            "migrated-edit",
            Some("new-iv"),
            Some("new-header"),
            Some(1),
            false,
            Some("upgrade-edit"),
            &[],
        )
        .await
        .unwrap()
        .unwrap();
        assert!(replay.replayed);
        assert_eq!(get_edit_history(&pool, migrated.id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn delivery_receipt_survives_edit_and_deletion() {
        let pool = test_pool().await;
        let (user, _, channel) = setup_channel(&pool).await;
        let first = create_message_with_delivery_nonce(
            &pool,
            15001,
            channel,
            user,
            "ciphertext-one",
            0,
            None,
            1,
            Some("iv-one"),
            Some("header-one"),
            Some("request-one"),
        )
        .await
        .unwrap();
        assert_eq!(first.delivery_nonce.as_deref(), Some("request-one"));
        let edited = update_message_authorized_with_meta(
            &pool,
            first.id,
            channel,
            user,
            "ciphertext-two",
            Some("iv-two"),
            Some("header-two"),
            Some(1),
            false,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(edited.nonce.as_deref(), Some("iv-two"));
        assert_eq!(edited.e2ee_header.as_deref(), Some("header-two"));
        assert_eq!(edited.delivery_nonce.as_deref(), Some("request-one"));
        let replay = create_message_with_delivery_nonce(
            &pool,
            15002,
            channel,
            user,
            "ciphertext-one",
            0,
            None,
            1,
            Some("iv-one"),
            Some("header-one"),
            Some("request-one"),
        )
        .await
        .unwrap();
        assert_eq!(replay.id, first.id);
        assert_eq!(replay.content.as_deref(), Some("ciphertext-two"));
        delete_message(&pool, first.id).await.unwrap();
        assert!(matches!(
            create_message_with_delivery_nonce(
                &pool,
                15003,
                channel,
                user,
                "ciphertext-one",
                0,
                None,
                1,
                Some("iv-one"),
                Some("header-one"),
                Some("request-one")
            )
            .await,
            Err(DbError::DeliveryAlreadyDeleted)
        ));
        assert_eq!(count_messages(&pool).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn delivery_receipt_rolls_back_if_message_insert_fails() {
        let pool = test_pool().await;
        let (user, _, channel) = setup_channel(&pool).await;
        create_message_with_delivery_nonce(
            &pool,
            15101,
            channel,
            user,
            "first",
            0,
            None,
            0,
            None,
            None,
            Some("first"),
        )
        .await
        .unwrap();
        assert!(create_message_with_delivery_nonce(
            &pool,
            15101,
            channel,
            user,
            "duplicate primary key",
            0,
            None,
            0,
            None,
            None,
            Some("retryable")
        )
        .await
        .is_err());
        let retry = create_message_with_delivery_nonce(
            &pool,
            15102,
            channel,
            user,
            "retry",
            0,
            None,
            0,
            None,
            None,
            Some("retryable"),
        )
        .await
        .unwrap();
        assert_eq!(retry.id, 15102);
    }

    #[tokio::test]
    async fn concurrent_replays_share_one_receipt_and_do_not_rewind_the_channel() {
        let pool = test_pool().await;
        let (user, _, channel) = setup_channel(&pool).await;
        let (a, b) = tokio::join!(
            create_message_with_delivery_nonce(
                &pool,
                15201,
                channel,
                user,
                "one",
                0,
                None,
                0,
                None,
                None,
                Some("same")
            ),
            create_message_with_delivery_nonce(
                &pool,
                15202,
                channel,
                user,
                "one",
                0,
                None,
                0,
                None,
                None,
                Some("same")
            ),
        );
        assert_eq!(a.unwrap().id, b.unwrap().id);
        assert_eq!(count_messages(&pool).await.unwrap(), 1);
        create_message_with_delivery_nonce(
            &pool,
            15100,
            channel,
            user,
            "older",
            0,
            None,
            0,
            None,
            None,
            Some("older"),
        )
        .await
        .unwrap();
        let (last,): (i64,) = sqlx::query_as("SELECT last_message_id FROM channels WHERE id = $1")
            .bind(channel)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(last >= 15201);
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
