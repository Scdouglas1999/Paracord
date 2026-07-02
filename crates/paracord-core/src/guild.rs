use rand::Rng;

use crate::error::CoreError;
use crate::permissions;
use paracord_db::DbPool;
use paracord_models::permissions::Permissions;

/// Generate a random invite code.
pub fn generate_invite_code(length: usize) -> String {
    const CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    let mut rng = rand::thread_rng();
    (0..length)
        .map(|_| {
            let idx = rng.gen_range(0..CHARSET.len());
            CHARSET[idx] as char
        })
        .collect()
}

/// Create a full guild with owner membership, @everyone role, and default channels.
/// Returns (guild_row, general_channel_id).
pub async fn create_guild_full(
    pool: &DbPool,
    guild_id: i64,
    name: &str,
    owner_id: i64,
    icon_hash: Option<&str>,
) -> Result<paracord_db::guilds::GuildRow, CoreError> {
    let guild =
        paracord_db::guilds::create_guild(pool, guild_id, name, owner_id, icon_hash).await?;

    // Add owner as member
    paracord_db::members::add_member(pool, owner_id, guild_id).await?;

    // Create the default Member role (role id = guild id).
    let default_perms = Permissions::default().bits();
    paracord_db::roles::create_role(pool, guild_id, guild_id, "Member", default_perms).await?;

    // Assign Member role to owner
    paracord_db::roles::add_member_role(pool, owner_id, guild_id, guild_id).await?;

    // Create #general text channel
    let general_id = paracord_util::snowflake::generate(1);
    paracord_db::channels::create_channel(pool, general_id, guild_id, "general", 0, 0, None, None)
        .await?;

    // Create General voice channel
    let voice_id = paracord_util::snowflake::generate(1);
    paracord_db::channels::create_channel(pool, voice_id, guild_id, "General", 2, 1, None, None)
        .await?;

    Ok(guild)
}

/// Delete a guild, only allowed by the owner.
pub async fn delete_guild(pool: &DbPool, guild_id: i64, user_id: i64) -> Result<(), CoreError> {
    let guild = paracord_db::guilds::get_guild(pool, guild_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    if guild.owner_id != user_id {
        return Err(CoreError::Forbidden);
    }

    paracord_db::guilds::delete_guild(pool, guild_id).await?;
    Ok(())
}

/// Update guild fields, requires MANAGE_GUILD permission.
pub async fn update_guild(
    pool: &DbPool,
    guild_id: i64,
    user_id: i64,
    name: Option<&str>,
    description: Option<&str>,
    icon_hash: Option<&str>,
    hub_settings: Option<&str>,
    bot_settings: Option<&str>,
    visibility: Option<&str>,
    discovery_tags: Option<&str>,
) -> Result<paracord_db::guilds::GuildRow, CoreError> {
    let guild = paracord_db::guilds::get_guild(pool, guild_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    let roles = paracord_db::roles::get_member_roles(pool, user_id, guild_id).await?;
    let perms = permissions::compute_permissions_from_roles(&roles, guild.owner_id, user_id);
    permissions::require_permission(perms, Permissions::MANAGE_GUILD)?;

    let mut updated = paracord_db::guilds::update_guild(
        pool,
        guild_id,
        name,
        description,
        icon_hash,
        hub_settings,
        bot_settings,
    )
    .await?;
    if visibility.is_some() || discovery_tags.is_some() {
        let next_visibility = visibility.unwrap_or(&updated.visibility);
        let next_allowed_roles = discovery_tags.unwrap_or(&updated.allowed_roles);
        updated = paracord_db::guilds::update_space_visibility(
            pool,
            guild_id.into(),
            next_visibility,
            next_allowed_roles,
        )
        .await?;
    }
    Ok(updated)
}
