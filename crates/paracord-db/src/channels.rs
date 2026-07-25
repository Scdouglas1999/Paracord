use crate::{
    active_database_engine, bool_from_any_row, datetime_from_db_text, datetime_to_db_text,
    DatabaseEngine, DbError, DbPool,
};
use chrono::{DateTime, Utc};
use paracord_models::id::{ChannelId, GuildId, MessageId, UserId};
use sqlx::Row;
use std::collections::BTreeSet;

#[derive(Debug, Clone)]
pub struct ChannelRow {
    pub id: i64,
    pub space_id: Option<i64>,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub channel_type: i16,
    pub position: i32,
    pub parent_id: Option<i64>,
    pub nsfw: bool,
    pub rate_limit_per_user: i32,
    pub bitrate: Option<i32>,
    pub user_limit: Option<i32>,
    pub last_message_id: Option<i64>,
    pub required_role_ids: String,
    pub thread_metadata: Option<String>,
    pub owner_id: Option<i64>,
    pub message_count: Option<i32>,
    pub applied_tags: Option<String>,
    pub default_sort_order: Option<i32>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct ForumTagRow {
    pub id: i64,
    pub channel_id: i64,
    pub name: String,
    pub emoji: Option<String>,
    pub moderated: bool,
    pub position: i32,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for ChannelRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            space_id: row.try_get("space_id")?,
            name: row.try_get("name")?,
            topic: row.try_get("topic")?,
            channel_type: row.try_get("channel_type")?,
            position: row.try_get("position")?,
            parent_id: row.try_get("parent_id")?,
            nsfw: bool_from_any_row(row, "nsfw")?,
            rate_limit_per_user: row.try_get("rate_limit_per_user")?,
            bitrate: row.try_get("bitrate")?,
            user_limit: row.try_get("user_limit")?,
            last_message_id: row.try_get("last_message_id")?,
            required_role_ids: row.try_get("required_role_ids")?,
            thread_metadata: row.try_get("thread_metadata")?,
            owner_id: row.try_get("owner_id")?,
            message_count: row.try_get("message_count")?,
            applied_tags: row.try_get("applied_tags")?,
            default_sort_order: row.try_get("default_sort_order")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for ForumTagRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            channel_id: row.try_get("channel_id")?,
            name: row.try_get("name")?,
            emoji: row.try_get("emoji")?,
            moderated: bool_from_any_row(row, "moderated")?,
            position: row.try_get("position")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

impl ChannelRow {
    /// Backward compat: return space_id as guild_id
    pub fn guild_id(&self) -> Option<i64> {
        self.space_id
    }
}

/// Core implementation using newtype IDs.
pub async fn create_channel_typed(
    pool: &DbPool,
    id: ChannelId,
    space_id: GuildId,
    name: &str,
    channel_type: i16,
    position: i32,
    parent_id: Option<ChannelId>,
    required_role_ids: Option<&str>,
) -> Result<ChannelRow, DbError> {
    let row = sqlx::query_as::<_, ChannelRow>(
        "INSERT INTO channels (id, space_id, name, channel_type, position, parent_id, required_role_ids)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, '[]'))
         RETURNING id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at"
    )
    .bind(id)
    .bind(space_id)
    .bind(name)
    .bind(channel_type)
    .bind(position)
    .bind(parent_id)
    .bind(required_role_ids)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn create_channel(
    pool: &DbPool,
    id: i64,
    space_id: i64,
    name: &str,
    channel_type: i16,
    position: i32,
    parent_id: Option<i64>,
    required_role_ids: Option<&str>,
) -> Result<ChannelRow, DbError> {
    create_channel_typed(
        pool,
        ChannelId::new(id),
        GuildId::new(space_id),
        name,
        channel_type,
        position,
        parent_id.map(ChannelId::new),
        required_role_ids,
    )
    .await
}

/// Core implementation using newtype ID.
pub async fn get_channel_typed(
    pool: &DbPool,
    id: ChannelId,
) -> Result<Option<ChannelRow>, DbError> {
    let row = sqlx::query_as::<_, ChannelRow>(
        "SELECT id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at
         FROM channels WHERE id = $1"
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn get_channel(pool: &DbPool, id: i64) -> Result<Option<ChannelRow>, DbError> {
    get_channel_typed(pool, ChannelId::new(id)).await
}

/// Get channels for a space (alias kept as get_guild_channels for API compat).
pub async fn get_guild_channels(pool: &DbPool, space_id: i64) -> Result<Vec<ChannelRow>, DbError> {
    get_space_channels(pool, space_id).await
}

/// Raw i64 shim kept for API compat. Core implementation via get_space_channels_typed.
pub async fn get_space_channels(pool: &DbPool, space_id: i64) -> Result<Vec<ChannelRow>, DbError> {
    get_space_channels_typed(pool, GuildId::new(space_id)).await
}

/// Core implementation using newtype ID.
pub async fn get_space_channels_typed(
    pool: &DbPool,
    space_id: GuildId,
) -> Result<Vec<ChannelRow>, DbError> {
    let rows = sqlx::query_as::<_, ChannelRow>(
        "SELECT id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at
         FROM channels WHERE space_id = $1 ORDER BY position"
    )
    .bind(space_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Core implementation using newtype ID.
pub async fn update_channel_typed(
    pool: &DbPool,
    id: ChannelId,
    name: Option<&str>,
    topic: Option<&str>,
    required_role_ids: Option<&str>,
    rate_limit_per_user: Option<i32>,
    bitrate: Option<i32>,
    user_limit: Option<i32>,
    nsfw: Option<bool>,
) -> Result<ChannelRow, DbError> {
    // nsfw needs special handling: COALESCE won't work cleanly with booleans
    // across all SQLx backends, so we build a conditional expression.
    let nsfw_expr = match (active_database_engine(), nsfw) {
        (DatabaseEngine::Postgres, Some(true)) => "TRUE",
        (DatabaseEngine::Postgres, Some(false)) => "FALSE",
        (_, Some(true)) => "1",
        (_, Some(false)) => "0",
        (_, None) => "nsfw",
    };
    let query = format!(
        "UPDATE channels
         SET name = COALESCE($2, name),
             topic = COALESCE($3, topic),
             required_role_ids = COALESCE($4, required_role_ids),
             rate_limit_per_user = COALESCE($5, rate_limit_per_user),
             bitrate = COALESCE($6, bitrate),
             user_limit = COALESCE($7, user_limit),
             nsfw = {nsfw_expr},
             updated_at = $8
         WHERE id = $1
         RETURNING id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at"
    );
    let row = sqlx::query_as::<_, ChannelRow>(&query)
        .bind(id)
        .bind(name)
        .bind(topic)
        .bind(required_role_ids)
        .bind(rate_limit_per_user)
        .bind(bitrate)
        .bind(user_limit)
        .bind(datetime_to_db_text(Utc::now()))
        .fetch_one(pool)
        .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn update_channel(
    pool: &DbPool,
    id: i64,
    name: Option<&str>,
    topic: Option<&str>,
    required_role_ids: Option<&str>,
    rate_limit_per_user: Option<i32>,
    bitrate: Option<i32>,
    user_limit: Option<i32>,
    nsfw: Option<bool>,
) -> Result<ChannelRow, DbError> {
    update_channel_typed(
        pool,
        ChannelId::new(id),
        name,
        topic,
        required_role_ids,
        rate_limit_per_user,
        bitrate,
        user_limit,
        nsfw,
    )
    .await
}

/// Ids of every channel parented to `parent_id` (threads and forum posts).
///
/// Used to extend permission-cache invalidation to children, which inherit
/// their permissions from this channel.
pub async fn get_child_channel_ids(pool: &DbPool, parent_id: i64) -> Result<Vec<i64>, DbError> {
    let rows: Vec<(i64,)> = sqlx::query_as("SELECT id FROM channels WHERE parent_id = $1")
        .bind(parent_id)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

/// Delete a channel and everything parented to it. Core implementation using
/// newtype ID.
///
/// `channels.parent_id` references `channels(id)` with **no** `ON DELETE`
/// action on either engine, so deleting a channel that has threads or forum
/// posts under it violates the constraint and the request fails — the API
/// returned a bare 500 and both rows survived. Children are removed first, in a
/// transaction, so the delete is all-or-nothing. Their messages, overwrites and
/// read states cascade off the child rows as usual.
pub async fn delete_channel_typed(pool: &DbPool, id: ChannelId) -> Result<(), DbError> {
    let mut tx = pool.begin().await?;
    // One level is sufficient: threads and forum posts cannot themselves be
    // parents (thread creation rejects a thread parent).
    sqlx::query("DELETE FROM channels WHERE parent_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM channels WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Raw i64 shim kept for API compat.
pub async fn delete_channel(pool: &DbPool, id: i64) -> Result<(), DbError> {
    delete_channel_typed(pool, ChannelId::new(id)).await
}

pub async fn count_channels(pool: &DbPool) -> Result<i64, DbError> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM channels")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}

pub async fn reorder_channels(pool: &DbPool, updates: &[(i64, i32)]) -> Result<(), DbError> {
    if updates.is_empty() {
        return Ok(());
    }

    let updated_at_param = updates.len() * 3 + 1;
    let mut sql = String::from("UPDATE channels SET position = CASE id ");
    for (idx, _) in updates.iter().enumerate() {
        let id_param = idx * 2 + 1;
        let pos_param = idx * 2 + 2;
        sql.push_str(&format!("WHEN ${id_param} THEN ${pos_param} "));
    }
    sql.push_str(&format!(
        "ELSE position END, updated_at = ${updated_at_param} WHERE id IN ("
    ));
    for idx in 0..updates.len() {
        if idx > 0 {
            sql.push_str(", ");
        }
        let id_param = updates.len() * 2 + idx + 1;
        sql.push_str(&format!("${id_param}"));
    }
    sql.push(')');

    let mut query = sqlx::query(&sql);
    for (channel_id, position) in updates {
        query = query.bind(*channel_id).bind(*position);
    }
    for (channel_id, _) in updates {
        query = query.bind(*channel_id);
    }
    query = query.bind(datetime_to_db_text(Utc::now()));
    query.execute(pool).await?;

    Ok(())
}

/// Bulk update channel positions and optionally parent_id within a guild.
/// Each entry is (channel_id, position, optional parent_id).
/// Returns the list of channels that were actually changed.
pub async fn update_channel_positions_typed(
    pool: &DbPool,
    guild_id: GuildId,
    positions: &[(ChannelId, i32, Option<Option<ChannelId>>)],
) -> Result<Vec<ChannelRow>, DbError> {
    let mut changed = Vec::new();
    for &(channel_id, position, ref parent_id) in positions {
        let existing = sqlx::query_as::<_, ChannelRow>(
            "SELECT id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at
             FROM channels WHERE id = $1 AND space_id = $2"
        )
        .bind(channel_id)
        .bind(guild_id)
        .fetch_optional(pool)
        .await?;

        let Some(existing) = existing else { continue };

        let new_parent: Option<i64> = match parent_id {
            Some(pid) => pid.map(|c| c.get()),
            None => existing.parent_id,
        };

        if existing.position == position && existing.parent_id == new_parent {
            continue;
        }

        let row = sqlx::query_as::<_, ChannelRow>(
            "UPDATE channels SET position = $2, parent_id = $3, updated_at = $4
             WHERE id = $1
             RETURNING id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at"
        )
        .bind(channel_id)
        .bind(position)
        .bind(new_parent)
        .bind(datetime_to_db_text(Utc::now()))
        .fetch_one(pool)
        .await?;
        changed.push(row);
    }
    Ok(changed)
}

/// Raw i64 shim kept for API compat.
pub async fn update_channel_positions(
    pool: &DbPool,
    guild_id: i64,
    positions: &[(i64, i32, Option<Option<i64>>)],
) -> Result<Vec<ChannelRow>, DbError> {
    let typed_positions: Vec<(ChannelId, i32, Option<Option<ChannelId>>)> = positions
        .iter()
        .map(|&(cid, pos, ref pid)| {
            (
                ChannelId::new(cid),
                pos,
                pid.map(|inner| inner.map(ChannelId::new)),
            )
        })
        .collect();
    update_channel_positions_typed(pool, GuildId::new(guild_id), &typed_positions).await
}

pub fn parse_required_role_ids(raw: &str) -> Vec<i64> {
    serde_json::from_str::<Vec<i64>>(raw).unwrap_or_default()
}

pub fn serialize_required_role_ids(role_ids: &[i64]) -> String {
    let unique_sorted: BTreeSet<i64> = role_ids.iter().copied().collect();
    let values: Vec<i64> = unique_sorted.into_iter().collect();
    serde_json::to_string(&values).unwrap_or_else(|_| "[]".to_string())
}

/// Create a thread channel under a parent text channel. Core implementation.
pub async fn create_thread_typed(
    pool: &DbPool,
    id: ChannelId,
    space_id: GuildId,
    parent_channel_id: ChannelId,
    name: &str,
    owner_id: UserId,
    auto_archive_duration: i64,
    starter_message_id: Option<MessageId>,
) -> Result<ChannelRow, DbError> {
    let thread_metadata = serde_json::json!({
        "archived": false,
        "auto_archive_duration": auto_archive_duration,
        "archive_timestamp": null,
        "locked": false,
        "starter_message_id": starter_message_id.map(|message_id| message_id.to_string()),
    })
    .to_string();

    let row = sqlx::query_as::<_, ChannelRow>(
        "INSERT INTO channels (id, space_id, name, channel_type, position, parent_id, required_role_ids, thread_metadata, owner_id, message_count)
         VALUES ($1, $2, $3, 6, 0, $4, '[]', $5, $6, 0)
         RETURNING id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at"
    )
    .bind(id)
    .bind(space_id)
    .bind(name)
    .bind(parent_channel_id)
    .bind(&thread_metadata)
    .bind(owner_id)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn create_thread(
    pool: &DbPool,
    id: i64,
    space_id: i64,
    parent_channel_id: i64,
    name: &str,
    owner_id: i64,
    auto_archive_duration: i64,
    starter_message_id: Option<i64>,
) -> Result<ChannelRow, DbError> {
    create_thread_typed(
        pool,
        ChannelId::new(id),
        GuildId::new(space_id),
        ChannelId::new(parent_channel_id),
        name,
        UserId::new(owner_id),
        auto_archive_duration,
        starter_message_id.map(MessageId::new),
    )
    .await
}

/// Get active (non-archived) threads under a parent channel. Core implementation.
pub async fn get_channel_threads_typed(
    pool: &DbPool,
    parent_channel_id: ChannelId,
) -> Result<Vec<ChannelRow>, DbError> {
    let rows = match crate::active_database_engine() {
        crate::DatabaseEngine::Postgres => {
            sqlx::query_as::<_, ChannelRow>(
                "SELECT id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at
                 FROM channels
                 WHERE parent_id = $1
                   AND channel_type = 6
                   AND COALESCE((thread_metadata::jsonb ->> 'archived')::boolean, FALSE) = FALSE
                 ORDER BY created_at DESC",
            )
            .bind(parent_channel_id)
            .fetch_all(pool)
            .await?
        }
        crate::DatabaseEngine::Sqlite => {
            sqlx::query_as::<_, ChannelRow>(
                "SELECT id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at
                 FROM channels
                 WHERE parent_id = $1
                   AND channel_type = 6
                   AND COALESCE(json_extract(thread_metadata, '$.archived'), 0) = 0
                 ORDER BY created_at DESC",
            )
            .bind(parent_channel_id)
            .fetch_all(pool)
            .await?
        }
    };

    Ok(rows)
}

/// Raw i64 shim kept for API compat.
pub async fn get_channel_threads(
    pool: &DbPool,
    parent_channel_id: i64,
) -> Result<Vec<ChannelRow>, DbError> {
    get_channel_threads_typed(pool, ChannelId::new(parent_channel_id)).await
}

/// Get archived threads under a parent channel, newest first.
///
/// Paginated by an `id` cursor: pass `before = Some(id)` to fetch threads whose
/// id is strictly less than the cursor (i.e. older). `limit` bounds the page.
/// Ordering is by `id DESC`, which is stable and monotonic with the snowflake
/// timestamp, so the cursor is unambiguous across pages.
pub async fn get_archived_threads_typed(
    pool: &DbPool,
    parent_channel_id: ChannelId,
    before: Option<ChannelId>,
    limit: i64,
) -> Result<Vec<ChannelRow>, DbError> {
    let archived_predicate = match crate::active_database_engine() {
        crate::DatabaseEngine::Postgres => {
            "COALESCE((thread_metadata::jsonb ->> 'archived')::boolean, FALSE) = TRUE"
        }
        crate::DatabaseEngine::Sqlite => {
            "COALESCE(json_extract(thread_metadata, '$.archived'), 0) = 1"
        }
    };

    const COLUMNS: &str = "id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at";

    let rows = if let Some(before_id) = before {
        let sql = format!(
            "SELECT {COLUMNS}
             FROM channels
             WHERE parent_id = $1
               AND channel_type = 6
               AND {archived_predicate}
               AND id < $2
             ORDER BY id DESC
             LIMIT $3"
        );
        sqlx::query_as::<_, ChannelRow>(&sql)
            .bind(parent_channel_id)
            .bind(before_id)
            .bind(limit)
            .fetch_all(pool)
            .await?
    } else {
        let sql = format!(
            "SELECT {COLUMNS}
             FROM channels
             WHERE parent_id = $1
               AND channel_type = 6
               AND {archived_predicate}
             ORDER BY id DESC
             LIMIT $2"
        );
        sqlx::query_as::<_, ChannelRow>(&sql)
            .bind(parent_channel_id)
            .bind(limit)
            .fetch_all(pool)
            .await?
    };

    Ok(rows)
}

/// Raw i64 shim kept for API compat.
pub async fn get_archived_threads(
    pool: &DbPool,
    parent_channel_id: i64,
    before: Option<i64>,
    limit: i64,
) -> Result<Vec<ChannelRow>, DbError> {
    get_archived_threads_typed(
        pool,
        ChannelId::new(parent_channel_id),
        before.map(ChannelId::new),
        limit,
    )
    .await
}

/// Update thread archived/locked state and optionally rename. Core implementation.
pub async fn update_thread_typed(
    pool: &DbPool,
    thread_id: ChannelId,
    name: Option<&str>,
    archived: Option<bool>,
    locked: Option<bool>,
) -> Result<ChannelRow, DbError> {
    let existing = sqlx::query_as::<_, ChannelRow>(
        "SELECT id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at
         FROM channels
         WHERE id = $1 AND channel_type = 6",
    )
    .bind(thread_id)
    .fetch_optional(pool)
    .await?;
    let Some(existing) = existing else {
        return Err(DbError::NotFound);
    };

    let mut metadata = existing
        .thread_metadata
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    if let Some(archived_val) = archived {
        metadata["archived"] = serde_json::Value::Bool(archived_val);
        if archived_val {
            metadata["archive_timestamp"] = serde_json::Value::String(
                chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            );
        }
    }
    if let Some(locked_val) = locked {
        metadata["locked"] = serde_json::Value::Bool(locked_val);
    }

    let metadata_raw = serde_json::to_string(&metadata).unwrap_or_else(|_| "{}".to_string());

    let row = sqlx::query_as::<_, ChannelRow>(
        "UPDATE channels
         SET name = COALESCE($2, name),
             thread_metadata = $3,
             updated_at = $4
         WHERE id = $1 AND channel_type = 6
         RETURNING id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at",
    )
    .bind(thread_id)
    .bind(name)
    .bind(metadata_raw)
    .bind(datetime_to_db_text(Utc::now()))
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn update_thread(
    pool: &DbPool,
    thread_id: i64,
    name: Option<&str>,
    archived: Option<bool>,
    locked: Option<bool>,
) -> Result<ChannelRow, DbError> {
    update_thread_typed(pool, ChannelId::new(thread_id), name, archived, locked).await
}

/// Increment the message count for a thread channel.
pub async fn increment_thread_message_count_typed(
    pool: &DbPool,
    thread_id: ChannelId,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE channels SET message_count = COALESCE(message_count, 0) + 1 WHERE id = $1 AND channel_type = 6"
    )
    .bind(thread_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Raw i64 shim kept for API compat.
pub async fn increment_thread_message_count(pool: &DbPool, thread_id: i64) -> Result<(), DbError> {
    increment_thread_message_count_typed(pool, ChannelId::new(thread_id)).await
}

/// Returns the most recent thread creation timestamp for `owner_id` under `parent_channel_id`.
pub async fn get_last_thread_creation_time_typed(
    pool: &DbPool,
    parent_channel_id: ChannelId,
    owner_id: UserId,
) -> Result<Option<chrono::DateTime<chrono::Utc>>, DbError> {
    let row: Option<String> = sqlx::query_scalar(
        "SELECT created_at
         FROM channels
         WHERE parent_id = $1
           AND channel_type = 6
           AND owner_id = $2
         ORDER BY id DESC
         LIMIT 1",
    )
    .bind(parent_channel_id)
    .bind(owner_id)
    .fetch_optional(pool)
    .await?;
    match row {
        Some(raw) => Ok(Some(crate::datetime_from_db_text(&raw)?)),
        None => Ok(None),
    }
}

/// Raw i64 shim kept for API compat.
pub async fn get_last_thread_creation_time(
    pool: &DbPool,
    parent_channel_id: i64,
    owner_id: i64,
) -> Result<Option<chrono::DateTime<chrono::Utc>>, DbError> {
    get_last_thread_creation_time_typed(
        pool,
        ChannelId::new(parent_channel_id),
        UserId::new(owner_id),
    )
    .await
}

// ============ Forum channel helpers ============

/// Create a forum post (a thread under a forum channel). Core implementation.
pub async fn create_forum_post_typed(
    pool: &DbPool,
    id: ChannelId,
    space_id: GuildId,
    forum_channel_id: ChannelId,
    name: &str,
    owner_id: UserId,
    applied_tags: Option<&str>,
) -> Result<ChannelRow, DbError> {
    let thread_metadata = serde_json::json!({
        "archived": false,
        "auto_archive_duration": 10080,
        "archive_timestamp": null,
        "locked": false,
        "starter_message_id": null,
    })
    .to_string();

    let tags = applied_tags.unwrap_or("[]");

    let row = sqlx::query_as::<_, ChannelRow>(
        "INSERT INTO channels (id, space_id, name, channel_type, position, parent_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags)
         VALUES ($1, $2, $3, 6, 0, $4, '[]', $5, $6, 0, $7)
         RETURNING id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at"
    )
    .bind(id)
    .bind(space_id)
    .bind(name)
    .bind(forum_channel_id)
    .bind(&thread_metadata)
    .bind(owner_id)
    .bind(tags)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn create_forum_post(
    pool: &DbPool,
    id: i64,
    space_id: i64,
    forum_channel_id: i64,
    name: &str,
    owner_id: i64,
    applied_tags: Option<&str>,
) -> Result<ChannelRow, DbError> {
    create_forum_post_typed(
        pool,
        ChannelId::new(id),
        GuildId::new(space_id),
        ChannelId::new(forum_channel_id),
        name,
        UserId::new(owner_id),
        applied_tags,
    )
    .await
}

/// Get forum posts (threads) under a forum channel, sorted by latest activity or creation.
/// sort_order: 0 = latest activity (last_message_id desc), 1 = creation date desc
pub async fn get_forum_posts_typed(
    pool: &DbPool,
    forum_channel_id: ChannelId,
    sort_order: i32,
    include_archived: bool,
) -> Result<Vec<ChannelRow>, DbError> {
    let order = if sort_order == 1 {
        "created_at DESC"
    } else {
        "COALESCE(last_message_id, id) DESC"
    };

    let archive_filter = if include_archived {
        String::new()
    } else {
        match crate::active_database_engine() {
            crate::DatabaseEngine::Postgres => {
                " AND COALESCE((thread_metadata::jsonb ->> 'archived')::boolean, FALSE) = FALSE"
                    .to_string()
            }
            crate::DatabaseEngine::Sqlite => {
                " AND COALESCE(json_extract(thread_metadata, '$.archived'), 0) = 0".to_string()
            }
        }
    };

    let sql = format!(
        "SELECT id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at
         FROM channels
         WHERE parent_id = $1 AND channel_type = 6{}
         ORDER BY {}",
        archive_filter, order
    );

    let rows = sqlx::query_as::<_, ChannelRow>(&sql)
        .bind(forum_channel_id)
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

/// Raw i64 shim kept for API compat.
pub async fn get_forum_posts(
    pool: &DbPool,
    forum_channel_id: i64,
    sort_order: i32,
    include_archived: bool,
) -> Result<Vec<ChannelRow>, DbError> {
    get_forum_posts_typed(
        pool,
        ChannelId::new(forum_channel_id),
        sort_order,
        include_archived,
    )
    .await
}

/// Get forum tags for a forum channel.
pub async fn get_forum_tags_typed(
    pool: &DbPool,
    channel_id: ChannelId,
) -> Result<Vec<ForumTagRow>, DbError> {
    let rows = sqlx::query_as::<_, ForumTagRow>(
        "SELECT id, channel_id, name, emoji, CASE WHEN moderated THEN 1 ELSE 0 END AS moderated, position, created_at
         FROM forum_tags WHERE channel_id = $1 ORDER BY position",
    )
    .bind(channel_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Raw i64 shim kept for API compat.
pub async fn get_forum_tags(pool: &DbPool, channel_id: i64) -> Result<Vec<ForumTagRow>, DbError> {
    get_forum_tags_typed(pool, ChannelId::new(channel_id)).await
}

/// Create a forum tag.
pub async fn create_forum_tag_typed(
    pool: &DbPool,
    id: i64,
    channel_id: ChannelId,
    name: &str,
    emoji: Option<&str>,
    moderated: bool,
) -> Result<ForumTagRow, DbError> {
    let position: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM forum_tags WHERE channel_id = $1")
        .bind(channel_id)
        .fetch_one(pool)
        .await?;

    let row = sqlx::query_as::<_, ForumTagRow>(
        "INSERT INTO forum_tags (id, channel_id, name, emoji, moderated, position)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, channel_id, name, emoji, CASE WHEN moderated THEN 1 ELSE 0 END AS moderated, position, created_at",
    )
    .bind(id)
    .bind(channel_id)
    .bind(name)
    .bind(emoji)
    .bind(moderated)
    .bind(position.0 as i32)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Raw i64 shim kept for API compat.
pub async fn create_forum_tag(
    pool: &DbPool,
    id: i64,
    channel_id: i64,
    name: &str,
    emoji: Option<&str>,
    moderated: bool,
) -> Result<ForumTagRow, DbError> {
    create_forum_tag_typed(pool, id, ChannelId::new(channel_id), name, emoji, moderated).await
}

/// Delete a forum tag.
pub async fn delete_forum_tag_typed(
    pool: &DbPool,
    tag_id: i64,
    channel_id: ChannelId,
) -> Result<bool, DbError> {
    let result = sqlx::query("DELETE FROM forum_tags WHERE id = $1 AND channel_id = $2")
        .bind(tag_id)
        .bind(channel_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Raw i64 shim kept for API compat.
pub async fn delete_forum_tag(
    pool: &DbPool,
    tag_id: i64,
    channel_id: i64,
) -> Result<bool, DbError> {
    delete_forum_tag_typed(pool, tag_id, ChannelId::new(channel_id)).await
}

/// Update applied_tags on a thread/post channel.
pub async fn update_post_tags_typed(
    pool: &DbPool,
    thread_id: ChannelId,
    applied_tags: &str,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE channels SET applied_tags = $2, updated_at = $3 WHERE id = $1 AND channel_type = 6",
    )
    .bind(thread_id)
    .bind(applied_tags)
    .bind(datetime_to_db_text(Utc::now()))
    .execute(pool)
    .await?;
    Ok(())
}

/// Raw i64 shim kept for API compat.
pub async fn update_post_tags(
    pool: &DbPool,
    thread_id: i64,
    applied_tags: &str,
) -> Result<(), DbError> {
    update_post_tags_typed(pool, ChannelId::new(thread_id), applied_tags).await
}

/// Update default_sort_order on a forum channel.
pub async fn update_forum_sort_order_typed(
    pool: &DbPool,
    channel_id: ChannelId,
    sort_order: i32,
) -> Result<(), DbError> {
    sqlx::query("UPDATE channels SET default_sort_order = $2, updated_at = $3 WHERE id = $1 AND channel_type = 7")
        .bind(channel_id)
        .bind(sort_order)
        .bind(datetime_to_db_text(Utc::now()))
        .execute(pool)
        .await?;
    Ok(())
}

/// Raw i64 shim kept for API compat.
pub async fn update_forum_sort_order(
    pool: &DbPool,
    channel_id: i64,
    sort_order: i32,
) -> Result<(), DbError> {
    update_forum_sort_order_typed(pool, ChannelId::new(channel_id), sort_order).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> DbPool {
        let pool = crate::create_pool("sqlite::memory:", 1).await.unwrap();
        crate::run_migrations(&pool).await.unwrap();
        pool
    }

    async fn setup_guild(pool: &DbPool) -> i64 {
        crate::users::create_user(pool, 1, "owner", 1, "o@example.com", "hash")
            .await
            .unwrap();
        crate::guilds::create_guild(pool, 100, "Test Guild", 1, None)
            .await
            .unwrap();
        100
    }

    #[tokio::test]
    async fn test_create_channel() {
        let pool = test_pool().await;
        let guild_id = setup_guild(&pool).await;
        let channel = create_channel_typed(
            &pool,
            ChannelId::new(10),
            GuildId::new(guild_id),
            "general",
            0,
            0,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(channel.id, 10);
        assert_eq!(channel.name.as_deref(), Some("general"));
        assert_eq!(channel.channel_type, 0);
        assert_eq!(channel.position, 0);
        assert_eq!(channel.space_id, Some(guild_id));
    }

    #[tokio::test]
    async fn test_get_channel() {
        let pool = test_pool().await;
        let guild_id = setup_guild(&pool).await;
        create_channel_typed(
            &pool,
            ChannelId::new(20),
            GuildId::new(guild_id),
            "voice",
            2,
            1,
            None,
            None,
        )
        .await
        .unwrap();
        let channel = get_channel_typed(&pool, ChannelId::new(20))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(channel.name.as_deref(), Some("voice"));
        assert_eq!(channel.channel_type, 2);
    }

    #[tokio::test]
    async fn test_get_channel_not_found() {
        let pool = test_pool().await;
        let channel = get_channel_typed(&pool, ChannelId::new(9999))
            .await
            .unwrap();
        assert!(channel.is_none());
    }

    #[tokio::test]
    async fn test_list_guild_channels_ordered_by_position() {
        let pool = test_pool().await;
        let guild_id = setup_guild(&pool).await;
        create_channel_typed(
            &pool,
            ChannelId::new(30),
            GuildId::new(guild_id),
            "general",
            0,
            0,
            None,
            None,
        )
        .await
        .unwrap();
        create_channel_typed(
            &pool,
            ChannelId::new(31),
            GuildId::new(guild_id),
            "random",
            0,
            1,
            None,
            None,
        )
        .await
        .unwrap();
        let channels = get_space_channels_typed(&pool, GuildId::new(guild_id))
            .await
            .unwrap();
        assert_eq!(channels.len(), 2);
        assert_eq!(channels[0].position, 0);
        assert_eq!(channels[1].position, 1);
    }

    #[tokio::test]
    async fn test_update_channel() {
        let pool = test_pool().await;
        let guild_id = setup_guild(&pool).await;
        create_channel_typed(
            &pool,
            ChannelId::new(40),
            GuildId::new(guild_id),
            "old-name",
            0,
            0,
            None,
            None,
        )
        .await
        .unwrap();
        let updated = update_channel_typed(
            &pool,
            ChannelId::new(40),
            Some("new-name"),
            Some("A topic"),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(updated.name.as_deref(), Some("new-name"));
        assert_eq!(updated.topic.as_deref(), Some("A topic"));
    }

    #[tokio::test]
    async fn test_update_channel_partial() {
        let pool = test_pool().await;
        let guild_id = setup_guild(&pool).await;
        create_channel_typed(
            &pool,
            ChannelId::new(41),
            GuildId::new(guild_id),
            "keep-name",
            0,
            0,
            None,
            None,
        )
        .await
        .unwrap();
        let updated = update_channel_typed(
            &pool,
            ChannelId::new(41),
            None,
            Some("topic only"),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(updated.name.as_deref(), Some("keep-name"));
        assert_eq!(updated.topic.as_deref(), Some("topic only"));
    }

    #[tokio::test]
    async fn test_delete_channel() {
        let pool = test_pool().await;
        let guild_id = setup_guild(&pool).await;
        create_channel_typed(
            &pool,
            ChannelId::new(50),
            GuildId::new(guild_id),
            "to-delete",
            0,
            0,
            None,
            None,
        )
        .await
        .unwrap();
        delete_channel_typed(&pool, ChannelId::new(50))
            .await
            .unwrap();
        let channel = get_channel_typed(&pool, ChannelId::new(50)).await.unwrap();
        assert!(channel.is_none());
    }

    #[tokio::test]
    async fn test_count_channels() {
        let pool = test_pool().await;
        let guild_id = setup_guild(&pool).await;
        assert_eq!(count_channels(&pool).await.unwrap(), 0);
        create_channel_typed(
            &pool,
            ChannelId::new(60),
            GuildId::new(guild_id),
            "ch1",
            0,
            0,
            None,
            None,
        )
        .await
        .unwrap();
        create_channel_typed(
            &pool,
            ChannelId::new(61),
            GuildId::new(guild_id),
            "ch2",
            0,
            1,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(count_channels(&pool).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn test_reorder_channels() {
        let pool = test_pool().await;
        let guild_id = setup_guild(&pool).await;
        create_channel_typed(
            &pool,
            ChannelId::new(70),
            GuildId::new(guild_id),
            "first",
            0,
            0,
            None,
            None,
        )
        .await
        .unwrap();
        create_channel_typed(
            &pool,
            ChannelId::new(71),
            GuildId::new(guild_id),
            "second",
            0,
            1,
            None,
            None,
        )
        .await
        .unwrap();
        reorder_channels(&pool, &[(70, 1), (71, 0)]).await.unwrap();
        let channels = get_space_channels_typed(&pool, GuildId::new(guild_id))
            .await
            .unwrap();
        assert_eq!(channels[0].id, 71);
        assert_eq!(channels[0].position, 0);
        assert_eq!(channels[1].id, 70);
        assert_eq!(channels[1].position, 1);
    }

    #[tokio::test]
    async fn test_channel_with_parent() {
        let pool = test_pool().await;
        let guild_id = setup_guild(&pool).await;
        create_channel_typed(
            &pool,
            ChannelId::new(80),
            GuildId::new(guild_id),
            "category",
            4,
            0,
            None,
            None,
        )
        .await
        .unwrap();
        let child = create_channel_typed(
            &pool,
            ChannelId::new(81),
            GuildId::new(guild_id),
            "child",
            0,
            0,
            Some(ChannelId::new(80)),
            None,
        )
        .await
        .unwrap();
        assert_eq!(child.parent_id, Some(80));
    }

    #[tokio::test]
    async fn test_parse_required_role_ids() {
        assert_eq!(parse_required_role_ids("[1,2,3]"), vec![1, 2, 3]);
        assert_eq!(parse_required_role_ids("[]"), Vec::<i64>::new());
        assert_eq!(parse_required_role_ids("bad"), Vec::<i64>::new());
    }

    #[tokio::test]
    async fn test_serialize_required_role_ids_deduplicates_and_sorts() {
        assert_eq!(serialize_required_role_ids(&[3, 1, 2, 1]), "[1,2,3]");
        assert_eq!(serialize_required_role_ids(&[]), "[]");
    }

    #[tokio::test]
    async fn test_create_thread() {
        let pool = test_pool().await;
        let guild_id = setup_guild(&pool).await;
        create_channel_typed(
            &pool,
            ChannelId::new(90),
            GuildId::new(guild_id),
            "parent",
            0,
            0,
            None,
            None,
        )
        .await
        .unwrap();
        let thread = create_thread_typed(
            &pool,
            ChannelId::new(91),
            GuildId::new(guild_id),
            ChannelId::new(90),
            "my-thread",
            UserId::new(1),
            1440,
            None,
        )
        .await
        .unwrap();
        assert_eq!(thread.channel_type, 6);
        assert_eq!(thread.parent_id, Some(90));
        assert_eq!(thread.owner_id, Some(1));
        assert!(thread.thread_metadata.is_some());
    }

    #[tokio::test]
    async fn test_get_channel_threads() {
        let pool = test_pool().await;
        let guild_id = setup_guild(&pool).await;
        create_channel_typed(
            &pool,
            ChannelId::new(92),
            GuildId::new(guild_id),
            "parent",
            0,
            0,
            None,
            None,
        )
        .await
        .unwrap();
        create_thread_typed(
            &pool,
            ChannelId::new(93),
            GuildId::new(guild_id),
            ChannelId::new(92),
            "thread-a",
            UserId::new(1),
            1440,
            None,
        )
        .await
        .unwrap();
        create_thread_typed(
            &pool,
            ChannelId::new(94),
            GuildId::new(guild_id),
            ChannelId::new(92),
            "thread-b",
            UserId::new(1),
            1440,
            None,
        )
        .await
        .unwrap();
        let threads = get_channel_threads_typed(&pool, ChannelId::new(92))
            .await
            .unwrap();
        assert_eq!(threads.len(), 2);
    }

    #[tokio::test]
    async fn test_guild_id_backward_compat() {
        let pool = test_pool().await;
        let guild_id = setup_guild(&pool).await;
        let channel = create_channel_typed(
            &pool,
            ChannelId::new(95),
            GuildId::new(guild_id),
            "compat",
            0,
            0,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(channel.guild_id(), Some(guild_id));
    }
}
