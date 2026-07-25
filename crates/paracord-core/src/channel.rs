use crate::error::CoreError;
use crate::permissions;
use paracord_db::DbPool;
use paracord_models::permissions::Permissions;

/// Create a channel in a guild, requires MANAGE_CHANNELS.
pub async fn create_channel(
    pool: &DbPool,
    guild_id: i64,
    user_id: i64,
    channel_id: i64,
    name: &str,
    channel_type: i16,
    parent_id: Option<i64>,
    required_role_ids: Option<&str>,
) -> Result<paracord_db::channels::ChannelRow, CoreError> {
    let guild = paracord_db::guilds::get_guild(pool, guild_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    // Guild-scoped gate: the channel does not exist yet, so there are no
    // overwrites to fold in. Use the guild primitive so a bot's install-time
    // permission cap is still applied.
    let perms =
        permissions::compute_guild_permissions(pool, guild_id, guild.owner_id, user_id).await?;
    permissions::require_permission(perms, Permissions::MANAGE_CHANNELS)?;

    // Compute next position
    let channels = paracord_db::channels::get_guild_channels(pool, guild_id).await?;
    let position = channels.len() as i32;

    let channel = paracord_db::channels::create_channel(
        pool,
        channel_id,
        guild_id,
        name,
        channel_type,
        position,
        parent_id,
        required_role_ids,
    )
    .await?;

    Ok(channel)
}

/// Delete a channel, requires MANAGE_CHANNELS.
pub async fn delete_channel(
    pool: &DbPool,
    channel_id: i64,
    user_id: i64,
) -> Result<paracord_db::channels::ChannelRow, CoreError> {
    let channel = paracord_db::channels::get_channel(pool, channel_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    let guild_id = channel
        .guild_id()
        .ok_or(CoreError::BadRequest("Cannot delete a DM channel".into()))?;

    let guild = paracord_db::guilds::get_guild(pool, guild_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    // Channel-scoped gate: fold in this channel's overwrites so a per-channel
    // deny of MANAGE_CHANNELS actually blocks the delete, and so a bot stays
    // capped to its install permissions.
    let perms = permissions::compute_channel_permissions(
        pool,
        guild_id,
        channel_id,
        guild.owner_id,
        user_id,
    )
    .await?;
    permissions::require_permission(perms, Permissions::MANAGE_CHANNELS)?;

    paracord_db::channels::delete_channel(pool, channel_id).await?;
    Ok(channel)
}

/// Update a channel, requires MANAGE_CHANNELS.
#[allow(clippy::too_many_arguments)]
pub async fn update_channel(
    pool: &DbPool,
    channel_id: i64,
    user_id: i64,
    name: Option<&str>,
    topic: Option<&str>,
    required_role_ids: Option<&str>,
    rate_limit_per_user: Option<i32>,
    bitrate: Option<i32>,
    user_limit: Option<i32>,
    nsfw: Option<bool>,
) -> Result<paracord_db::channels::ChannelRow, CoreError> {
    let channel = paracord_db::channels::get_channel(pool, channel_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    let guild_id = channel
        .guild_id()
        .ok_or(CoreError::BadRequest("Cannot update a DM channel".into()))?;

    let guild = paracord_db::guilds::get_guild(pool, guild_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    // Channel-scoped gate: fold in this channel's overwrites so a per-channel
    // deny of MANAGE_CHANNELS actually blocks the update, and so a bot stays
    // capped to its install permissions.
    let perms = permissions::compute_channel_permissions(
        pool,
        guild_id,
        channel_id,
        guild.owner_id,
        user_id,
    )
    .await?;
    permissions::require_permission(perms, Permissions::MANAGE_CHANNELS)?;

    let updated = paracord_db::channels::update_channel(
        pool,
        channel_id,
        name,
        topic,
        required_role_ids,
        rate_limit_per_user,
        bitrate,
        user_limit,
        nsfw,
    )
    .await?;
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GUILD_ID: i64 = 100;
    const OWNER_ID: i64 = 1;
    const USER_ID: i64 = 7;
    const ROLE_ID: i64 = 300;
    const CHANNEL_ID: i64 = 500;

    /// Guild where `USER_ID` holds a role granting guild-wide MANAGE_CHANNELS,
    /// and one channel that denies MANAGE_CHANNELS to that same role.
    async fn seed_denied_channel() -> DbPool {
        let pool = paracord_db::create_pool("sqlite::memory:", 1)
            .await
            .expect("create in-memory pool");
        paracord_db::run_migrations(&pool)
            .await
            .expect("run migrations");

        paracord_db::users::create_user(&pool, OWNER_ID, "owner", 1, "owner@x", "h")
            .await
            .unwrap();
        paracord_db::users::create_user(&pool, USER_ID, "member", 2, "member@x", "h")
            .await
            .unwrap();
        paracord_db::guilds::create_guild(&pool, GUILD_ID, "g", OWNER_ID, None)
            .await
            .unwrap();
        paracord_db::members::add_member(&pool, USER_ID, GUILD_ID)
            .await
            .unwrap();
        paracord_db::roles::create_role(
            &pool,
            ROLE_ID,
            GUILD_ID,
            "mods",
            (Permissions::VIEW_CHANNEL | Permissions::MANAGE_CHANNELS).bits(),
        )
        .await
        .unwrap();
        paracord_db::roles::add_member_role(&pool, USER_ID, GUILD_ID, ROLE_ID)
            .await
            .unwrap();
        paracord_db::channels::create_channel(
            &pool, CHANNEL_ID, GUILD_ID, "secret", 0, 0, None, None,
        )
        .await
        .unwrap();
        paracord_db::channel_overwrites::upsert_channel_overwrite(
            &pool,
            CHANNEL_ID,
            ROLE_ID,
            permissions::OVERWRITE_TARGET_ROLE,
            Permissions::empty().bits(),
            Permissions::MANAGE_CHANNELS.bits(),
        )
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn update_channel_honors_channel_level_deny() {
        let pool = seed_denied_channel().await;
        let result = update_channel(
            &pool,
            CHANNEL_ID,
            USER_ID,
            Some("renamed"),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(
            matches!(result, Err(CoreError::MissingPermission)),
            "guild-wide MANAGE_CHANNELS must not override a per-channel deny"
        );
        let channel = paracord_db::channels::get_channel(&pool, CHANNEL_ID)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(channel.name.as_deref(), Some("secret"));
    }

    #[tokio::test]
    async fn delete_channel_honors_channel_level_deny() {
        let pool = seed_denied_channel().await;
        let result = delete_channel(&pool, CHANNEL_ID, USER_ID).await;
        assert!(matches!(result, Err(CoreError::MissingPermission)));
        assert!(paracord_db::channels::get_channel(&pool, CHANNEL_ID)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn update_channel_allowed_without_a_deny() {
        let pool = seed_denied_channel().await;
        paracord_db::channel_overwrites::delete_channel_overwrite(&pool, CHANNEL_ID, ROLE_ID)
            .await
            .unwrap();
        let updated = update_channel(
            &pool,
            CHANNEL_ID,
            USER_ID,
            Some("renamed"),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(updated.name.as_deref(), Some("renamed"));
    }
}
