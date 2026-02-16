use crate::{bool_from_any_row, datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;
use std::collections::BTreeSet;

fn thread_is_archived(thread_metadata: Option<&str>) -> bool {
    let Some(raw) = thread_metadata else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return false;
    };
    value
        .get("archived")
        .and_then(|archived| archived.as_bool())
        .unwrap_or(false)
}

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

pub async fn get_channel(pool: &DbPool, id: i64) -> Result<Option<ChannelRow>, DbError> {
    let row = sqlx::query_as::<_, ChannelRow>(
        "SELECT id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at
         FROM channels WHERE id = $1"
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Get channels for a space (alias kept as get_guild_channels for API compat).
pub async fn get_guild_channels(pool: &DbPool, space_id: i64) -> Result<Vec<ChannelRow>, DbError> {
    get_space_channels(pool, space_id).await
}

pub async fn get_space_channels(pool: &DbPool, space_id: i64) -> Result<Vec<ChannelRow>, DbError> {
    let rows = sqlx::query_as::<_, ChannelRow>(
        "SELECT id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at
         FROM channels WHERE space_id = $1 ORDER BY position"
    )
    .bind(space_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn update_channel(
    pool: &DbPool,
    id: i64,
    name: Option<&str>,
    topic: Option<&str>,
    required_role_ids: Option<&str>,
) -> Result<ChannelRow, DbError> {
    let row = sqlx::query_as::<_, ChannelRow>(
        "UPDATE channels
         SET name = COALESCE($2, name),
             topic = COALESCE($3, topic),
             required_role_ids = COALESCE($4, required_role_ids),
             updated_at = datetime('now')
         WHERE id = $1
         RETURNING id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at"
    )
    .bind(id)
    .bind(name)
    .bind(topic)
    .bind(required_role_ids)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn delete_channel(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM channels WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn count_channels(pool: &DbPool) -> Result<i64, DbError> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM channels")
        .fetch_one(pool)
        .await?;
    Ok(row.0)
}

pub async fn reorder_channels(pool: &DbPool, updates: &[(i64, i32)]) -> Result<(), DbError> {
    for (channel_id, position) in updates {
        sqlx::query(
            "UPDATE channels SET position = $2, updated_at = datetime('now') WHERE id = $1",
        )
        .bind(channel_id)
        .bind(position)
        .execute(pool)
        .await?;
    }
    Ok(())
}

/// Bulk update channel positions and optionally parent_id within a guild.
/// Each entry is (channel_id, position, optional parent_id).
/// Returns the list of channels that were actually changed.
pub async fn update_channel_positions(
    pool: &DbPool,
    guild_id: i64,
    positions: &[(i64, i32, Option<Option<i64>>)],
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

        let new_parent = match parent_id {
            Some(pid) => *pid,
            None => existing.parent_id,
        };

        if existing.position == position && existing.parent_id == new_parent {
            continue;
        }

        let row = sqlx::query_as::<_, ChannelRow>(
            "UPDATE channels SET position = $2, parent_id = $3, updated_at = datetime('now')
             WHERE id = $1
             RETURNING id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at"
        )
        .bind(channel_id)
        .bind(position)
        .bind(new_parent)
        .fetch_one(pool)
        .await?;
        changed.push(row);
    }
    Ok(changed)
}

pub fn parse_required_role_ids(raw: &str) -> Vec<i64> {
    serde_json::from_str::<Vec<i64>>(raw).unwrap_or_default()
}

pub fn serialize_required_role_ids(role_ids: &[i64]) -> String {
    let unique_sorted: BTreeSet<i64> = role_ids.iter().copied().collect();
    let values: Vec<i64> = unique_sorted.into_iter().collect();
    serde_json::to_string(&values).unwrap_or_else(|_| "[]".to_string())
}

/// Create a thread channel under a parent text channel.
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

/// Get active (non-archived) threads under a parent channel.
pub async fn get_channel_threads(
    pool: &DbPool,
    parent_channel_id: i64,
) -> Result<Vec<ChannelRow>, DbError> {
    let rows = sqlx::query_as::<_, ChannelRow>(
        "SELECT id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at
         FROM channels
         WHERE parent_id = $1 AND channel_type = 6
         ORDER BY created_at DESC"
    )
    .bind(parent_channel_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|row| !thread_is_archived(row.thread_metadata.as_deref()))
        .collect())
}

/// Get archived threads under a parent channel.
pub async fn get_archived_threads(
    pool: &DbPool,
    parent_channel_id: i64,
) -> Result<Vec<ChannelRow>, DbError> {
    let rows = sqlx::query_as::<_, ChannelRow>(
        "SELECT id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at
         FROM channels
         WHERE parent_id = $1 AND channel_type = 6
         ORDER BY created_at DESC"
    )
    .bind(parent_channel_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|row| thread_is_archived(row.thread_metadata.as_deref()))
        .collect())
}

/// Update thread archived/locked state and optionally rename.
pub async fn update_thread(
    pool: &DbPool,
    thread_id: i64,
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
             updated_at = datetime('now')
         WHERE id = $1 AND channel_type = 6
         RETURNING id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at",
    )
    .bind(thread_id)
    .bind(name)
    .bind(metadata_raw)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Increment the message count for a thread channel.
pub async fn increment_thread_message_count(pool: &DbPool, thread_id: i64) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE channels SET message_count = COALESCE(message_count, 0) + 1 WHERE id = $1 AND channel_type = 6"
    )
    .bind(thread_id)
    .execute(pool)
    .await?;
    Ok(())
}

// ============ Forum channel helpers ============

/// Create a forum post (a thread under a forum channel).
pub async fn create_forum_post(
    pool: &DbPool,
    id: i64,
    space_id: i64,
    forum_channel_id: i64,
    name: &str,
    owner_id: i64,
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

/// Get forum posts (threads) under a forum channel, sorted by latest activity or creation.
/// sort_order: 0 = latest activity (last_message_id desc), 1 = creation date desc
pub async fn get_forum_posts(
    pool: &DbPool,
    forum_channel_id: i64,
    sort_order: i32,
    include_archived: bool,
) -> Result<Vec<ChannelRow>, DbError> {
    let order = if sort_order == 1 {
        "created_at DESC"
    } else {
        "COALESCE(last_message_id, id) DESC"
    };

    let sql = format!(
        "SELECT id, space_id, name, topic, channel_type, position, parent_id, CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids, thread_metadata, owner_id, message_count, applied_tags, default_sort_order, created_at
         FROM channels
         WHERE parent_id = $1 AND channel_type = 6
         ORDER BY {}",
        order
    );

    let rows = sqlx::query_as::<_, ChannelRow>(&sql)
        .bind(forum_channel_id)
        .fetch_all(pool)
        .await?;
    if include_archived {
        Ok(rows)
    } else {
        Ok(rows
            .into_iter()
            .filter(|row| !thread_is_archived(row.thread_metadata.as_deref()))
            .collect())
    }
}

/// Get forum tags for a forum channel.
pub async fn get_forum_tags(pool: &DbPool, channel_id: i64) -> Result<Vec<ForumTagRow>, DbError> {
    let rows = sqlx::query_as::<_, ForumTagRow>(
        "SELECT id, channel_id, name, emoji, CASE WHEN moderated THEN 1 ELSE 0 END AS moderated, position, created_at
         FROM forum_tags WHERE channel_id = $1 ORDER BY position",
    )
    .bind(channel_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Create a forum tag.
pub async fn create_forum_tag(
    pool: &DbPool,
    id: i64,
    channel_id: i64,
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

/// Delete a forum tag.
pub async fn delete_forum_tag(
    pool: &DbPool,
    tag_id: i64,
    channel_id: i64,
) -> Result<bool, DbError> {
    let result = sqlx::query("DELETE FROM forum_tags WHERE id = $1 AND channel_id = $2")
        .bind(tag_id)
        .bind(channel_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Update applied_tags on a thread/post channel.
pub async fn update_post_tags(
    pool: &DbPool,
    thread_id: i64,
    applied_tags: &str,
) -> Result<(), DbError> {
    sqlx::query("UPDATE channels SET applied_tags = $2, updated_at = datetime('now') WHERE id = $1 AND channel_type = 6")
        .bind(thread_id)
        .bind(applied_tags)
        .execute(pool)
        .await?;
    Ok(())
}

/// Update default_sort_order on a forum channel.
pub async fn update_forum_sort_order(
    pool: &DbPool,
    channel_id: i64,
    sort_order: i32,
) -> Result<(), DbError> {
    sqlx::query("UPDATE channels SET default_sort_order = $2, updated_at = datetime('now') WHERE id = $1 AND channel_type = 7")
        .bind(channel_id)
        .bind(sort_order)
        .execute(pool)
        .await?;
    Ok(())
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
        let channel = create_channel(&pool, 10, guild_id, "general", 0, 0, None, None)
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
        create_channel(&pool, 20, guild_id, "voice", 2, 1, None, None)
            .await
            .unwrap();
        let channel = get_channel(&pool, 20).await.unwrap().unwrap();
        assert_eq!(channel.name.as_deref(), Some("voice"));
        assert_eq!(channel.channel_type, 2);
    }

    #[tokio::test]
    async fn test_get_channel_not_found() {
        let pool = test_pool().await;
        let channel = get_channel(&pool, 9999).await.unwrap();
        assert!(channel.is_none());
    }

    #[tokio::test]
    async fn test_list_guild_channels_ordered_by_position() {
        let pool = test_pool().await;
        let guild_id = setup_guild(&pool).await;
        create_channel(&pool, 30, guild_id, "general", 0, 0, None, None)
            .await
            .unwrap();
        create_channel(&pool, 31, guild_id, "random", 0, 1, None, None)
            .await
            .unwrap();
        let channels = get_guild_channels(&pool, guild_id).await.unwrap();
        assert_eq!(channels.len(), 2);
        assert_eq!(channels[0].position, 0);
        assert_eq!(channels[1].position, 1);
    }

    #[tokio::test]
    async fn test_update_channel() {
        let pool = test_pool().await;
        let guild_id = setup_guild(&pool).await;
        create_channel(&pool, 40, guild_id, "old-name", 0, 0, None, None)
            .await
            .unwrap();
        let updated = update_channel(&pool, 40, Some("new-name"), Some("A topic"), None)
            .await
            .unwrap();
        assert_eq!(updated.name.as_deref(), Some("new-name"));
        assert_eq!(updated.topic.as_deref(), Some("A topic"));
    }

    #[tokio::test]
    async fn test_update_channel_partial() {
        let pool = test_pool().await;
        let guild_id = setup_guild(&pool).await;
        create_channel(&pool, 41, guild_id, "keep-name", 0, 0, None, None)
            .await
            .unwrap();
        let updated = update_channel(&pool, 41, None, Some("topic only"), None)
            .await
            .unwrap();
        assert_eq!(updated.name.as_deref(), Some("keep-name"));
        assert_eq!(updated.topic.as_deref(), Some("topic only"));
    }

    #[tokio::test]
    async fn test_delete_channel() {
        let pool = test_pool().await;
        let guild_id = setup_guild(&pool).await;
        create_channel(&pool, 50, guild_id, "to-delete", 0, 0, None, None)
            .await
            .unwrap();
        delete_channel(&pool, 50).await.unwrap();
        let channel = get_channel(&pool, 50).await.unwrap();
        assert!(channel.is_none());
    }

    #[tokio::test]
    async fn test_count_channels() {
        let pool = test_pool().await;
        let guild_id = setup_guild(&pool).await;
        assert_eq!(count_channels(&pool).await.unwrap(), 0);
        create_channel(&pool, 60, guild_id, "ch1", 0, 0, None, None)
            .await
            .unwrap();
        create_channel(&pool, 61, guild_id, "ch2", 0, 1, None, None)
            .await
            .unwrap();
        assert_eq!(count_channels(&pool).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn test_reorder_channels() {
        let pool = test_pool().await;
        let guild_id = setup_guild(&pool).await;
        create_channel(&pool, 70, guild_id, "first", 0, 0, None, None)
            .await
            .unwrap();
        create_channel(&pool, 71, guild_id, "second", 0, 1, None, None)
            .await
            .unwrap();
        reorder_channels(&pool, &[(70, 1), (71, 0)]).await.unwrap();
        let channels = get_guild_channels(&pool, guild_id).await.unwrap();
        assert_eq!(channels[0].id, 71);
        assert_eq!(channels[0].position, 0);
        assert_eq!(channels[1].id, 70);
        assert_eq!(channels[1].position, 1);
    }

    #[tokio::test]
    async fn test_channel_with_parent() {
        let pool = test_pool().await;
        let guild_id = setup_guild(&pool).await;
        create_channel(&pool, 80, guild_id, "category", 4, 0, None, None)
            .await
            .unwrap();
        let child = create_channel(&pool, 81, guild_id, "child", 0, 0, Some(80), None)
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
        create_channel(&pool, 90, guild_id, "parent", 0, 0, None, None)
            .await
            .unwrap();
        let thread = create_thread(&pool, 91, guild_id, 90, "my-thread", 1, 1440, None)
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
        create_channel(&pool, 92, guild_id, "parent", 0, 0, None, None)
            .await
            .unwrap();
        create_thread(&pool, 93, guild_id, 92, "thread-a", 1, 1440, None)
            .await
            .unwrap();
        create_thread(&pool, 94, guild_id, 92, "thread-b", 1, 1440, None)
            .await
            .unwrap();
        let threads = get_channel_threads(&pool, 92).await.unwrap();
        assert_eq!(threads.len(), 2);
    }

    #[tokio::test]
    async fn test_guild_id_backward_compat() {
        let pool = test_pool().await;
        let guild_id = setup_guild(&pool).await;
        let channel = create_channel(&pool, 95, guild_id, "compat", 0, 0, None, None)
            .await
            .unwrap();
        assert_eq!(channel.guild_id(), Some(guild_id));
    }
}
