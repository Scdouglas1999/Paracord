use crate::{channels::ChannelRow, DbError, DbPool};

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DmChannelWithRecipientRow {
    pub id: i64,
    pub channel_type: i16,
    pub last_message_id: Option<i64>,
    pub recipient_id: i64,
    pub recipient_username: String,
    pub recipient_discriminator: i16,
    pub recipient_avatar_hash: Option<String>,
    pub recipient_public_key: Option<String>,
}

pub async fn find_dm_channel_between(
    pool: &DbPool,
    user_a: i64,
    user_b: i64,
) -> Result<Option<ChannelRow>, DbError> {
    let row = sqlx::query_as::<_, ChannelRow>(
        "SELECT c.id, c.space_id, c.name, c.topic, c.channel_type, c.position, c.parent_id,
                CASE WHEN c.nsfw THEN 1 ELSE 0 END AS nsfw,
                c.rate_limit_per_user, c.bitrate, c.user_limit, c.last_message_id,
                c.required_role_ids, c.thread_metadata, c.owner_id, c.message_count,
                c.applied_tags, c.default_sort_order, c.created_at
         FROM channels c
         INNER JOIN dm_recipients a ON a.channel_id = c.id AND a.user_id = $1
         INNER JOIN dm_recipients b ON b.channel_id = c.id AND b.user_id = $2
         WHERE c.channel_type = 1
         LIMIT 1",
    )
    .bind(user_a)
    .bind(user_b)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn create_dm_channel(
    pool: &DbPool,
    channel_id: i64,
    user_a: i64,
    user_b: i64,
) -> Result<ChannelRow, DbError> {
    let mut tx = pool.begin().await?;

    sqlx::query(
        "INSERT INTO channels (id, space_id, name, channel_type, position)
         VALUES ($1, NULL, NULL, 1, 0)",
    )
    .bind(channel_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO dm_recipients (channel_id, user_id)
         VALUES ($1, $2), ($1, $3)",
    )
    .bind(channel_id)
    .bind(user_a)
    .bind(user_b)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    let row = sqlx::query_as::<_, ChannelRow>(
        "SELECT id, space_id, name, topic, channel_type, position, parent_id,
                CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw,
                rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids,
                thread_metadata, owner_id, message_count, applied_tags, default_sort_order,
                created_at
         FROM channels
         WHERE id = $1",
    )
    .bind(channel_id)
    .fetch_one(pool)
    .await?;

    Ok(row)
}

pub async fn list_user_dm_channels(
    pool: &DbPool,
    user_id: i64,
) -> Result<Vec<DmChannelWithRecipientRow>, DbError> {
    let rows = sqlx::query_as::<_, DmChannelWithRecipientRow>(
        "SELECT c.id, c.channel_type, c.last_message_id,
                u.id AS recipient_id,
                u.username AS recipient_username,
                u.discriminator AS recipient_discriminator,
                u.avatar_hash AS recipient_avatar_hash,
                u.public_key AS recipient_public_key
         FROM channels c
         INNER JOIN dm_recipients me ON me.channel_id = c.id
         INNER JOIN dm_recipients other ON other.channel_id = c.id AND other.user_id != me.user_id
         INNER JOIN users u ON u.id = other.user_id
         WHERE c.channel_type = 1 AND me.user_id = $1
         ORDER BY CASE WHEN c.last_message_id IS NULL THEN 1 ELSE 0 END, c.last_message_id DESC, c.id DESC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

pub async fn get_dm_recipient_ids(pool: &DbPool, channel_id: i64) -> Result<Vec<i64>, DbError> {
    let rows: Vec<(i64,)> =
        sqlx::query_as("SELECT user_id FROM dm_recipients WHERE channel_id = $1")
            .bind(channel_id)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

pub async fn is_dm_recipient(
    pool: &DbPool,
    channel_id: i64,
    user_id: i64,
) -> Result<bool, DbError> {
    let exists: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM dm_recipients WHERE channel_id = $1 AND user_id = $2 LIMIT 1",
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(exists.is_some())
}

/// Create a group DM channel (channel_type = 3) with the given owner and initial recipients.
pub async fn create_group_dm_channel(
    pool: &DbPool,
    channel_id: i64,
    name: Option<&str>,
    owner_id: i64,
    recipient_ids: &[i64],
) -> Result<ChannelRow, DbError> {
    let mut tx = pool.begin().await?;

    sqlx::query(
        "INSERT INTO channels (id, space_id, name, channel_type, position, owner_id)
         VALUES ($1, NULL, $2, 3, 0, $3)",
    )
    .bind(channel_id)
    .bind(name)
    .bind(owner_id)
    .execute(&mut *tx)
    .await?;

    // Insert owner as a recipient
    sqlx::query(
        "INSERT INTO dm_recipients (channel_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (channel_id, user_id) DO NOTHING",
    )
    .bind(channel_id)
    .bind(owner_id)
    .execute(&mut *tx)
    .await?;

    for &uid in recipient_ids {
        sqlx::query(
            "INSERT INTO dm_recipients (channel_id, user_id)
             VALUES ($1, $2)
             ON CONFLICT (channel_id, user_id) DO NOTHING",
        )
        .bind(channel_id)
        .bind(uid)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    let row = sqlx::query_as::<_, ChannelRow>(
        "SELECT id, space_id, name, topic, channel_type, position, parent_id,
                CASE WHEN nsfw THEN 1 ELSE 0 END AS nsfw,
                rate_limit_per_user, bitrate, user_limit, last_message_id, required_role_ids,
                thread_metadata, owner_id, message_count, applied_tags, default_sort_order,
                created_at
         FROM channels WHERE id = $1",
    )
    .bind(channel_id)
    .fetch_one(pool)
    .await?;

    Ok(row)
}

/// Add a recipient to a group DM channel. Returns false if already a member.
pub async fn add_group_dm_recipient(
    pool: &DbPool,
    channel_id: i64,
    user_id: i64,
) -> Result<bool, DbError> {
    let result = sqlx::query(
        "INSERT INTO dm_recipients (channel_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (channel_id, user_id) DO NOTHING",
    )
    .bind(channel_id)
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Remove a recipient from a group DM channel.
pub async fn remove_group_dm_recipient(
    pool: &DbPool,
    channel_id: i64,
    user_id: i64,
) -> Result<bool, DbError> {
    let result = sqlx::query("DELETE FROM dm_recipients WHERE channel_id = $1 AND user_id = $2")
        .bind(channel_id)
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct GroupDmRecipient {
    pub user_id: i64,
    pub username: String,
    pub discriminator: i16,
    pub avatar_hash: Option<String>,
    pub public_key: Option<String>,
}

/// List all recipients of a DM or group DM channel with their user info.
pub async fn list_group_dm_recipients(
    pool: &DbPool,
    channel_id: i64,
) -> Result<Vec<GroupDmRecipient>, DbError> {
    let rows = sqlx::query_as::<_, GroupDmRecipient>(
        "SELECT u.id AS user_id, u.username, u.discriminator, u.avatar_hash, u.public_key
         FROM dm_recipients r INNER JOIN users u ON u.id = r.user_id
         WHERE r.channel_id = $1
         ORDER BY u.username ASC",
    )
    .bind(channel_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// List all group DM channels the user is a member of (channel_type = 3).
pub async fn list_user_group_dm_channels(
    pool: &DbPool,
    user_id: i64,
) -> Result<Vec<ChannelRow>, DbError> {
    let rows = sqlx::query_as::<_, ChannelRow>(
        "SELECT c.id, c.space_id, c.name, c.topic, c.channel_type, c.position, c.parent_id,
                CASE WHEN c.nsfw THEN 1 ELSE 0 END AS nsfw,
                c.rate_limit_per_user, c.bitrate, c.user_limit, c.last_message_id,
                c.required_role_ids, c.thread_metadata, c.owner_id, c.message_count,
                c.applied_tags, c.default_sort_order, c.created_at
         FROM channels c
         INNER JOIN dm_recipients r ON r.channel_id = c.id AND r.user_id = $1
         WHERE c.channel_type = 3
         ORDER BY CASE WHEN c.last_message_id IS NULL THEN 1 ELSE 0 END, c.last_message_id DESC, c.id DESC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}
