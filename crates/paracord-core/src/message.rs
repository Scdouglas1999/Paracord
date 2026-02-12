use crate::error::CoreError;
use crate::permissions;
use paracord_db::DbPool;
use paracord_models::permissions::Permissions;

/// Create a message, requires SEND_MESSAGES and VIEW_CHANNEL.
pub async fn create_message(
    pool: &DbPool,
    msg_id: i64,
    channel_id: i64,
    author_id: i64,
    content: &str,
    reference_id: Option<i64>,
) -> Result<paracord_db::messages::MessageRow, CoreError> {
    if content.len() > 4000 {
        return Err(CoreError::BadRequest(
            "Content must be 4000 characters or fewer".into(),
        ));
    }

    let channel = paracord_db::channels::get_channel(pool, channel_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    // Check permissions if guild channel
    if let Some(guild_id) = channel.guild_id() {
        permissions::ensure_guild_member(pool, guild_id, author_id).await?;
        if let Some(member) = paracord_db::members::get_member(pool, author_id, guild_id).await? {
            if let Some(until) = member.communication_disabled_until {
                if until > chrono::Utc::now() {
                    return Err(CoreError::BadRequest(
                        "You are timed out and cannot send messages".into(),
                    ));
                }
            }
        }
        let guild = paracord_db::guilds::get_guild(pool, guild_id)
            .await?
            .ok_or(CoreError::NotFound)?;

        let perms = permissions::compute_channel_permissions(
            pool,
            guild_id,
            channel_id,
            guild.owner_id,
            author_id,
        )
        .await?;
        permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;
        permissions::require_permission(perms, Permissions::SEND_MESSAGES)?;
    } else if !paracord_db::dms::is_dm_recipient(pool, channel_id, author_id).await? {
        return Err(CoreError::Forbidden);
    }

    let msg = paracord_db::messages::create_message(
        pool,
        msg_id,
        channel_id,
        author_id,
        content,
        0,
        reference_id,
    )
        .await?;

    Ok(msg)
}

/// Edit a message. Only the author can edit, unless user has MANAGE_MESSAGES.
pub async fn edit_message(
    pool: &DbPool,
    message_id: i64,
    user_id: i64,
    content: &str,
) -> Result<paracord_db::messages::MessageRow, CoreError> {
    if content.is_empty() || content.len() > 4000 {
        return Err(CoreError::BadRequest(
            "Content must be between 1 and 4000 characters".into(),
        ));
    }

    let msg = paracord_db::messages::get_message(pool, message_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    if msg.author_id != user_id {
        // Check MANAGE_MESSAGES
        let channel = paracord_db::channels::get_channel(pool, msg.channel_id)
            .await?
            .ok_or(CoreError::NotFound)?;

        if let Some(guild_id) = channel.guild_id() {
            let guild = paracord_db::guilds::get_guild(pool, guild_id)
                .await?
                .ok_or(CoreError::NotFound)?;

            let roles = paracord_db::roles::get_member_roles(pool, user_id, guild_id).await?;
            let perms =
                permissions::compute_permissions_from_roles(&roles, guild.owner_id, user_id);
            permissions::require_permission(perms, Permissions::MANAGE_MESSAGES)?;
        } else {
            return Err(CoreError::Forbidden);
        }
    }

    let updated = paracord_db::messages::update_message(pool, message_id, content).await?;
    Ok(updated)
}

/// Delete a message. Author can delete own, or MANAGE_MESSAGES can delete any.
pub async fn delete_message(
    pool: &DbPool,
    message_id: i64,
    channel_id: i64,
    user_id: i64,
) -> Result<(), CoreError> {
    let msg = paracord_db::messages::get_message(pool, message_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    if msg.channel_id != channel_id {
        return Err(CoreError::NotFound);
    }

    if msg.author_id != user_id {
        let channel = paracord_db::channels::get_channel(pool, msg.channel_id)
            .await?
            .ok_or(CoreError::NotFound)?;

        if let Some(guild_id) = channel.guild_id() {
            let guild = paracord_db::guilds::get_guild(pool, guild_id)
                .await?
                .ok_or(CoreError::NotFound)?;

            let roles = paracord_db::roles::get_member_roles(pool, user_id, guild_id).await?;
            let perms =
                permissions::compute_permissions_from_roles(&roles, guild.owner_id, user_id);
            permissions::require_permission(perms, Permissions::MANAGE_MESSAGES)?;
        } else {
            return Err(CoreError::Forbidden);
        }
    }

    paracord_db::messages::delete_message(pool, message_id).await?;
    Ok(())
}
