use crate::error::CoreError;
use crate::permissions;
use crate::{USER_FLAG_ADMIN, is_admin};
use paracord_db::DbPool;
use paracord_models::permissions::Permissions;
use serde::Serialize;

/// Kick a member from a guild. Requires KICK_MEMBERS permission.
pub async fn kick_member(
    pool: &DbPool,
    guild_id: i64,
    actor_id: i64,
    target_id: i64,
) -> Result<(), CoreError> {
    let guild = paracord_db::guilds::get_guild(pool, guild_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    if target_id == guild.owner_id {
        return Err(CoreError::BadRequest("Cannot kick the guild owner".into()));
    }

    let roles = paracord_db::roles::get_member_roles(pool, actor_id, guild_id).await?;
    let perms = permissions::compute_permissions_from_roles(&roles, guild.owner_id, actor_id);
    permissions::require_permission(perms, Permissions::KICK_MEMBERS)?;

    // Verify target is actually a member
    paracord_db::members::get_member(pool, target_id, guild_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    paracord_db::members::remove_member(pool, target_id, guild_id).await?;
    Ok(())
}

/// Ban a member from a guild. Requires BAN_MEMBERS permission.
pub async fn ban_member(
    pool: &DbPool,
    guild_id: i64,
    actor_id: i64,
    target_id: i64,
    reason: Option<&str>,
) -> Result<(), CoreError> {
    let guild = paracord_db::guilds::get_guild(pool, guild_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    if target_id == guild.owner_id {
        return Err(CoreError::BadRequest("Cannot ban the guild owner".into()));
    }

    let roles = paracord_db::roles::get_member_roles(pool, actor_id, guild_id).await?;
    let perms = permissions::compute_permissions_from_roles(&roles, guild.owner_id, actor_id);
    permissions::require_permission(perms, Permissions::BAN_MEMBERS)?;

    // Remove from members if present
    let _ = paracord_db::members::remove_member(pool, target_id, guild_id).await;

    // Create ban entry
    paracord_db::bans::create_ban(pool, target_id, guild_id, reason, actor_id).await?;

    Ok(())
}

/// Unban a member. Requires BAN_MEMBERS permission.
pub async fn unban_member(
    pool: &DbPool,
    guild_id: i64,
    actor_id: i64,
    target_id: i64,
) -> Result<(), CoreError> {
    let guild = paracord_db::guilds::get_guild(pool, guild_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    let roles = paracord_db::roles::get_member_roles(pool, actor_id, guild_id).await?;
    let perms = permissions::compute_permissions_from_roles(&roles, guild.owner_id, actor_id);
    permissions::require_permission(perms, Permissions::BAN_MEMBERS)?;

    paracord_db::bans::delete_ban(pool, target_id, guild_id).await?;

    Ok(())
}

// ── Server-wide admin functions ─────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ServerStats {
    pub total_users: i64,
    pub total_guilds: i64,
    pub total_messages: i64,
    pub total_channels: i64,
}

pub async fn get_server_stats(pool: &DbPool) -> Result<ServerStats, CoreError> {
    let users = paracord_db::users::count_users(pool).await?;
    let guilds = paracord_db::guilds::count_guilds(pool).await?;
    let messages = paracord_db::messages::count_messages(pool).await?;
    let channels = paracord_db::channels::count_channels(pool).await?;

    Ok(ServerStats {
        total_users: users,
        total_guilds: guilds,
        total_messages: messages,
        total_channels: channels,
    })
}

/// Promote a user to server admin by setting the admin flag.
pub async fn promote_to_admin(
    pool: &DbPool,
    user_id: i64,
) -> Result<paracord_db::users::UserRow, CoreError> {
    let user = paracord_db::users::get_user_by_id(pool, user_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    let new_flags = user.flags | USER_FLAG_ADMIN;
    let updated = paracord_db::users::update_user_flags(pool, user_id, new_flags).await?;
    Ok(updated)
}

/// Demote a user from server admin by clearing the admin flag.
pub async fn demote_from_admin(
    pool: &DbPool,
    user_id: i64,
) -> Result<paracord_db::users::UserRow, CoreError> {
    let user = paracord_db::users::get_user_by_id(pool, user_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    if !is_admin(user.flags) {
        return Err(CoreError::BadRequest("User is not an admin".into()));
    }

    let new_flags = user.flags & !USER_FLAG_ADMIN;
    let updated = paracord_db::users::update_user_flags(pool, user_id, new_flags).await?;
    Ok(updated)
}

/// Force-delete a guild (server admin action, no permission checks).
pub async fn admin_delete_guild(pool: &DbPool, guild_id: i64) -> Result<(), CoreError> {
    paracord_db::guilds::get_guild(pool, guild_id)
        .await?
        .ok_or(CoreError::NotFound)?;
    paracord_db::guilds::delete_guild(pool, guild_id).await?;
    Ok(())
}

/// Force-update a guild (server admin action, no permission checks).
pub async fn admin_update_guild(
    pool: &DbPool,
    guild_id: i64,
    name: Option<&str>,
    description: Option<&str>,
    icon_hash: Option<&str>,
) -> Result<paracord_db::guilds::GuildRow, CoreError> {
    paracord_db::guilds::get_guild(pool, guild_id)
        .await?
        .ok_or(CoreError::NotFound)?;
    let updated = paracord_db::guilds::update_guild(pool, guild_id, name, description, icon_hash).await?;
    Ok(updated)
}

/// Delete a user and clean up their data.
pub async fn admin_delete_user(pool: &DbPool, user_id: i64) -> Result<(), CoreError> {
    paracord_db::users::get_user_by_id(pool, user_id)
        .await?
        .ok_or(CoreError::NotFound)?;
    paracord_db::users::delete_user(pool, user_id).await?;
    Ok(())
}
