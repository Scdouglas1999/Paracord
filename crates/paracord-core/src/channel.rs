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
) -> Result<paracord_db::channels::ChannelRow, CoreError> {
    let guild = paracord_db::guilds::get_guild(pool, guild_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    let roles = paracord_db::roles::get_member_roles(pool, user_id, guild_id).await?;
    let perms = permissions::compute_permissions_from_roles(&roles, guild.owner_id, user_id);
    permissions::require_permission(perms, Permissions::MANAGE_CHANNELS)?;

    // Compute next position
    let channels = paracord_db::channels::get_guild_channels(pool, guild_id).await?;
    let position = channels.len() as i32;

    let channel = paracord_db::channels::create_channel(
        pool, channel_id, guild_id, name, channel_type, position, parent_id,
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

    let guild_id = channel.guild_id().ok_or(CoreError::BadRequest(
        "Cannot delete a DM channel".into(),
    ))?;

    let guild = paracord_db::guilds::get_guild(pool, guild_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    let roles = paracord_db::roles::get_member_roles(pool, user_id, guild_id).await?;
    let perms = permissions::compute_permissions_from_roles(&roles, guild.owner_id, user_id);
    permissions::require_permission(perms, Permissions::MANAGE_CHANNELS)?;

    paracord_db::channels::delete_channel(pool, channel_id).await?;
    Ok(channel)
}

/// Update a channel, requires MANAGE_CHANNELS.
pub async fn update_channel(
    pool: &DbPool,
    channel_id: i64,
    user_id: i64,
    name: Option<&str>,
    topic: Option<&str>,
) -> Result<paracord_db::channels::ChannelRow, CoreError> {
    let channel = paracord_db::channels::get_channel(pool, channel_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    let guild_id = channel.guild_id().ok_or(CoreError::BadRequest(
        "Cannot update a DM channel".into(),
    ))?;

    let guild = paracord_db::guilds::get_guild(pool, guild_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    let roles = paracord_db::roles::get_member_roles(pool, user_id, guild_id).await?;
    let perms = permissions::compute_permissions_from_roles(&roles, guild.owner_id, user_id);
    permissions::require_permission(perms, Permissions::MANAGE_CHANNELS)?;

    let updated = paracord_db::channels::update_channel(pool, channel_id, name, topic).await?;
    Ok(updated)
}
