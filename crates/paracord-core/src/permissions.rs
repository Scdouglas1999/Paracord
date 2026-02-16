use crate::error::CoreError;
use crate::PermissionCacheKey;
use paracord_db::DbPool;
use paracord_models::permissions::Permissions;

pub const OVERWRITE_TARGET_ROLE: i16 = 0;
pub const OVERWRITE_TARGET_MEMBER: i16 = 1;

/// Compute channel permissions with cache lookup.  Falls back to
/// `compute_channel_permissions` on cache miss and stores the result.
pub async fn compute_channel_permissions_cached(
    cache: &moka::future::Cache<PermissionCacheKey, Permissions>,
    pool: &DbPool,
    guild_id: i64,
    channel_id: i64,
    guild_owner_id: i64,
    user_id: i64,
) -> Result<Permissions, CoreError> {
    let key = (user_id, channel_id);
    if let Some(perms) = cache.get(&key).await {
        return Ok(perms);
    }
    let perms =
        compute_channel_permissions(pool, guild_id, channel_id, guild_owner_id, user_id).await?;
    cache.insert(key, perms).await;
    Ok(perms)
}

/// Invalidate cached permissions for a specific user in a specific channel.
pub async fn invalidate_user_channel(
    cache: &moka::future::Cache<PermissionCacheKey, Permissions>,
    user_id: i64,
    channel_id: i64,
) {
    cache.invalidate(&(user_id, channel_id)).await;
}

/// Invalidate all cached permissions for a specific channel (all users).
/// Uses targeted invalidation to only remove entries for this channel.
pub async fn invalidate_channel(
    cache: &moka::future::Cache<PermissionCacheKey, Permissions>,
    channel_id: i64,
) {
    let keys_to_invalidate: Vec<PermissionCacheKey> = cache
        .iter()
        .filter(|(k, _)| k.1 == channel_id)
        .map(|(k, _)| *k)
        .collect();
    for key in keys_to_invalidate {
        cache.invalidate(&key).await;
    }
}

/// Invalidate all cached permissions for a user across all channels.
/// Used when a user's roles change.
pub async fn invalidate_user(
    cache: &moka::future::Cache<PermissionCacheKey, Permissions>,
    user_id: i64,
) {
    let keys_to_invalidate: Vec<PermissionCacheKey> = cache
        .iter()
        .filter(|(k, _)| k.0 == user_id)
        .map(|(k, _)| *k)
        .collect();
    for key in keys_to_invalidate {
        cache.invalidate(&key).await;
    }
}

/// Invalidate the entire permission cache (e.g. when roles are modified).
pub async fn invalidate_all(cache: &moka::future::Cache<PermissionCacheKey, Permissions>) {
    cache.invalidate_all();
}

/// Compute effective permissions for a member in a guild
pub fn compute_base_permissions(
    member_role_permissions: &[(i64, i64)],
    guild_owner_id: i64,
    user_id: i64,
) -> Permissions {
    if user_id == guild_owner_id {
        return Permissions::all();
    }

    let mut perms = Permissions::empty();
    for (_role_id, bits) in member_role_permissions {
        perms |= Permissions::from_bits_truncate(*bits);
    }

    if perms.contains(Permissions::ADMINISTRATOR) {
        return Permissions::all();
    }

    perms
}

/// Check if permission set contains required permission, returning error if not
pub fn require_permission(perms: Permissions, required: Permissions) -> Result<(), CoreError> {
    if !perms.contains(required) {
        return Err(CoreError::MissingPermission);
    }
    Ok(())
}

pub fn is_server_admin(perms: Permissions) -> bool {
    perms.contains(Permissions::ADMINISTRATOR)
}

/// Compute permissions from a set of Role rows
pub fn compute_permissions_from_roles(
    roles: &[paracord_db::roles::RoleRow],
    guild_owner_id: i64,
    user_id: i64,
) -> Permissions {
    if user_id == guild_owner_id {
        return Permissions::all();
    }

    let mut perms = Permissions::empty();
    for role in roles {
        perms |= Permissions::from_bits_truncate(role.permissions);
    }

    if perms.contains(Permissions::ADMINISTRATOR) {
        return Permissions::all();
    }

    perms
}

pub async fn is_guild_member(
    pool: &DbPool,
    guild_id: i64,
    user_id: i64,
) -> Result<bool, CoreError> {
    let member = paracord_db::members::get_member(pool, user_id, guild_id).await?;
    Ok(member.is_some())
}

pub async fn ensure_guild_member(
    pool: &DbPool,
    guild_id: i64,
    user_id: i64,
) -> Result<(), CoreError> {
    if !is_guild_member(pool, guild_id, user_id).await? {
        return Err(CoreError::Forbidden);
    }
    Ok(())
}

pub async fn compute_channel_permissions(
    pool: &DbPool,
    guild_id: i64,
    channel_id: i64,
    guild_owner_id: i64,
    user_id: i64,
) -> Result<Permissions, CoreError> {
    let roles = paracord_db::roles::get_member_roles(pool, user_id, guild_id).await?;
    let mut perms = compute_permissions_from_roles(&roles, guild_owner_id, user_id);
    if perms.contains(Permissions::ADMINISTRATOR) || user_id == guild_owner_id {
        return Ok(Permissions::all());
    }

    let channel = paracord_db::channels::get_channel(pool, channel_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    let role_ids: std::collections::HashSet<i64> = roles.iter().map(|r| r.id).collect();
    let required_role_ids =
        paracord_db::channels::parse_required_role_ids(&channel.required_role_ids);
    if !required_role_ids.is_empty() && !required_role_ids.iter().any(|id| role_ids.contains(id)) {
        perms.remove(Permissions::VIEW_CHANNEL);
        return Ok(perms);
    }

    let overwrites =
        paracord_db::channel_overwrites::get_channel_overwrites(pool, channel_id).await?;
    if overwrites.is_empty() {
        return Ok(perms);
    }

    if let Some(everyone) = overwrites
        .iter()
        .find(|o| o.target_type == OVERWRITE_TARGET_ROLE && o.target_id == guild_id)
    {
        let deny = Permissions::from_bits_truncate(everyone.deny_perms);
        let allow = Permissions::from_bits_truncate(everyone.allow_perms);
        perms &= !deny;
        perms |= allow;
    }

    let mut role_deny = Permissions::empty();
    let mut role_allow = Permissions::empty();
    for overwrite in overwrites
        .iter()
        .filter(|o| o.target_type == OVERWRITE_TARGET_ROLE && role_ids.contains(&o.target_id))
    {
        role_deny |= Permissions::from_bits_truncate(overwrite.deny_perms);
        role_allow |= Permissions::from_bits_truncate(overwrite.allow_perms);
    }
    perms &= !role_deny;
    perms |= role_allow;

    if let Some(member_ow) = overwrites
        .iter()
        .find(|o| o.target_type == OVERWRITE_TARGET_MEMBER && o.target_id == user_id)
    {
        let deny = Permissions::from_bits_truncate(member_ow.deny_perms);
        let allow = Permissions::from_bits_truncate(member_ow.allow_perms);
        perms &= !deny;
        perms |= allow;
    }

    Ok(perms)
}

/// Compute channel permissions for multiple channels in a single batch.
/// Loads roles once and all overwrites once, then computes in-memory.
pub async fn compute_all_channel_permissions(
    pool: &DbPool,
    guild_id: i64,
    channels: &[paracord_db::channels::ChannelRow],
    guild_owner_id: i64,
    user_id: i64,
) -> Result<std::collections::HashMap<i64, Permissions>, CoreError> {
    use std::collections::HashMap;

    // Owner fast path
    if user_id == guild_owner_id {
        return Ok(channels
            .iter()
            .map(|c| (c.id, Permissions::all()))
            .collect());
    }

    // Load roles once
    let roles = paracord_db::roles::get_member_roles(pool, user_id, guild_id).await?;
    let base_perms = compute_permissions_from_roles(&roles, guild_owner_id, user_id);
    if base_perms.contains(Permissions::ADMINISTRATOR) {
        return Ok(channels
            .iter()
            .map(|c| (c.id, Permissions::all()))
            .collect());
    }

    let role_ids: std::collections::HashSet<i64> = roles.iter().map(|r| r.id).collect();

    // Load all overwrites for all channels in one query
    let channel_ids: Vec<i64> = channels.iter().map(|c| c.id).collect();
    let all_overwrites =
        paracord_db::channel_overwrites::get_overwrites_for_channels(pool, &channel_ids).await?;

    // Group overwrites by channel_id
    let mut overwrites_by_channel: HashMap<
        i64,
        Vec<paracord_db::channel_overwrites::ChannelOverwriteRow>,
    > = HashMap::new();
    for ow in all_overwrites {
        overwrites_by_channel
            .entry(ow.channel_id)
            .or_default()
            .push(ow);
    }

    // Compute permissions per channel
    let mut result = HashMap::with_capacity(channels.len());
    for channel in channels {
        let mut perms = base_perms;

        // Check required_role_ids
        let required_role_ids =
            paracord_db::channels::parse_required_role_ids(&channel.required_role_ids);
        if !required_role_ids.is_empty()
            && !required_role_ids.iter().any(|id| role_ids.contains(id))
        {
            perms.remove(Permissions::VIEW_CHANNEL);
            result.insert(channel.id, perms);
            continue;
        }

        // Apply overwrites
        let overwrites = overwrites_by_channel.get(&channel.id);
        if let Some(overwrites) = overwrites {
            // @everyone role overwrite
            if let Some(everyone) = overwrites
                .iter()
                .find(|o| o.target_type == OVERWRITE_TARGET_ROLE && o.target_id == guild_id)
            {
                let deny = Permissions::from_bits_truncate(everyone.deny_perms);
                let allow = Permissions::from_bits_truncate(everyone.allow_perms);
                perms &= !deny;
                perms |= allow;
            }

            // Role overwrites
            let mut role_deny = Permissions::empty();
            let mut role_allow = Permissions::empty();
            for overwrite in overwrites.iter().filter(|o| {
                o.target_type == OVERWRITE_TARGET_ROLE && role_ids.contains(&o.target_id)
            }) {
                role_deny |= Permissions::from_bits_truncate(overwrite.deny_perms);
                role_allow |= Permissions::from_bits_truncate(overwrite.allow_perms);
            }
            perms &= !role_deny;
            perms |= role_allow;

            // Member overwrite
            if let Some(member_ow) = overwrites
                .iter()
                .find(|o| o.target_type == OVERWRITE_TARGET_MEMBER && o.target_id == user_id)
            {
                let deny = Permissions::from_bits_truncate(member_ow.deny_perms);
                let allow = Permissions::from_bits_truncate(member_ow.allow_perms);
                perms &= !deny;
                perms |= allow;
            }
        }

        result.insert(channel.id, perms);
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use paracord_db::roles::RoleRow;

    fn make_role(id: i64, space_id: i64, permissions: i64) -> RoleRow {
        RoleRow {
            id,
            space_id,
            name: format!("role-{}", id),
            color: 0,
            hoist: false,
            position: 0,
            permissions,
            managed: false,
            mentionable: false,
            server_wide: false,
            created_at: Utc::now(),
        }
    }

    #[test]
    fn owner_gets_all_permissions() {
        let role_perms = vec![(1_i64, 0_i64)]; // no perms
        let perms = compute_base_permissions(&role_perms, 42, 42);
        assert_eq!(perms, Permissions::all());
    }

    #[test]
    fn admin_bit_grants_all_permissions() {
        let role_perms = vec![(1, Permissions::ADMINISTRATOR.bits())];
        let perms = compute_base_permissions(&role_perms, 99, 1);
        assert_eq!(perms, Permissions::all());
    }

    #[test]
    fn regular_member_gets_combined_role_permissions() {
        let send = Permissions::SEND_MESSAGES.bits();
        let view = Permissions::VIEW_CHANNEL.bits();
        let role_perms = vec![(1, send), (2, view)];
        let perms = compute_base_permissions(&role_perms, 99, 1);
        assert!(perms.contains(Permissions::SEND_MESSAGES));
        assert!(perms.contains(Permissions::VIEW_CHANNEL));
        assert!(!perms.contains(Permissions::ADMINISTRATOR));
    }

    #[test]
    fn no_roles_means_no_permissions() {
        let role_perms: Vec<(i64, i64)> = vec![];
        let perms = compute_base_permissions(&role_perms, 99, 1);
        assert_eq!(perms, Permissions::empty());
    }

    #[test]
    fn require_permission_succeeds_when_present() {
        let perms = Permissions::SEND_MESSAGES | Permissions::VIEW_CHANNEL;
        assert!(require_permission(perms, Permissions::SEND_MESSAGES).is_ok());
    }

    #[test]
    fn require_permission_fails_when_missing() {
        let perms = Permissions::VIEW_CHANNEL;
        let result = require_permission(perms, Permissions::ADMINISTRATOR);
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), CoreError::MissingPermission));
    }

    #[test]
    fn is_server_admin_true_for_admin() {
        assert!(is_server_admin(
            Permissions::ADMINISTRATOR | Permissions::SEND_MESSAGES
        ));
    }

    #[test]
    fn is_server_admin_false_for_non_admin() {
        assert!(!is_server_admin(
            Permissions::SEND_MESSAGES | Permissions::VIEW_CHANNEL
        ));
    }

    #[test]
    fn compute_permissions_from_roles_owner_bypass() {
        let roles = vec![make_role(1, 100, 0)];
        let perms = compute_permissions_from_roles(&roles, 42, 42);
        assert_eq!(perms, Permissions::all());
    }

    #[test]
    fn compute_permissions_from_roles_admin_bypass() {
        let roles = vec![make_role(1, 100, Permissions::ADMINISTRATOR.bits())];
        let perms = compute_permissions_from_roles(&roles, 99, 1);
        assert_eq!(perms, Permissions::all());
    }

    #[test]
    fn compute_permissions_from_roles_combines_multiple() {
        let roles = vec![
            make_role(1, 100, Permissions::VIEW_CHANNEL.bits()),
            make_role(2, 100, Permissions::SEND_MESSAGES.bits()),
        ];
        let perms = compute_permissions_from_roles(&roles, 99, 1);
        assert!(perms.contains(Permissions::VIEW_CHANNEL));
        assert!(perms.contains(Permissions::SEND_MESSAGES));
        assert!(!perms.contains(Permissions::KICK_MEMBERS));
    }

    #[test]
    fn compute_permissions_from_roles_empty_roles() {
        let roles: Vec<RoleRow> = vec![];
        let perms = compute_permissions_from_roles(&roles, 99, 1);
        assert_eq!(perms, Permissions::empty());
    }
}
