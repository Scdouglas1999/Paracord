//! Mention audiences for producers whose publication authority comes from an
//! interaction token, webhook, system action, or an existing message. Publication
//! authorization remains at the producer; this module never grants it to a bot or
//! a remote pseudo-user merely because an author ID exists.

use crate::{error::CoreError, permissions};
use paracord_db::DbPool;
use paracord_models::permissions::Permissions;

/// Resolve mention syntax only for an actual member under their current channel
/// and install permissions. Call after the producer's own send authorization.
/// DM interaction payloads have no guild mention audience.
pub async fn member_mentions(
    pool: &DbPool,
    channel_id: i64,
    author_id: i64,
    content: &str,
) -> Result<Vec<i64>, CoreError> {
    let channel = paracord_db::channels::get_channel(pool, channel_id)
        .await?
        .ok_or(CoreError::NotFound)?;
    let Some(guild_id) = channel.guild_id() else {
        return Ok(Vec::new());
    };
    permissions::ensure_guild_member(pool, guild_id, author_id).await?;
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
    permissions::require_permission(
        perms,
        Permissions::VIEW_CHANNEL | Permissions::SEND_MESSAGES,
    )?;
    crate::message::resolve_message_mentions(
        pool,
        guild_id,
        channel_id,
        guild.owner_id,
        author_id,
        content,
        perms.contains(Permissions::MENTION_EVERYONE),
    )
    .await
}

/// Filter an explicit, already authorized audience to members who can see the
/// destination. System callers pass intentional recipients; crossposts/reviews
/// pass the original committed audience. Never pass IDs parsed from copied text.
pub async fn explicit_mentions(
    pool: &DbPool,
    guild_id: i64,
    channel_id: i64,
    author_id: i64,
    candidates: &[i64],
) -> Result<Vec<i64>, CoreError> {
    let channel = paracord_db::channels::get_channel(pool, channel_id)
        .await?
        .ok_or(CoreError::NotFound)?;
    if channel.guild_id() != Some(guild_id) {
        return Err(CoreError::Forbidden);
    }
    let guild = paracord_db::guilds::get_guild(pool, guild_id)
        .await?
        .ok_or(CoreError::NotFound)?;
    let mut recipients = Vec::new();
    for user_id in candidates
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>()
    {
        if user_id == author_id
            || paracord_db::members::get_member(pool, user_id, guild_id)
                .await?
                .is_none()
        {
            continue;
        }
        let perms = permissions::compute_channel_permissions(
            pool,
            guild_id,
            channel_id,
            guild.owner_id,
            user_id,
        )
        .await?;
        if perms.contains(Permissions::VIEW_CHANNEL) {
            recipients.push(user_id);
        }
    }
    Ok(recipients)
}
