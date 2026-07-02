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

/// Apply a channel's permission overwrites on top of a member's base
/// permissions, following Discord precedence:
/// base -> @everyone overwrite -> combined role overwrites -> member overwrite.
///
/// `role_ids` is the set of role ids the member holds; `guild_id` doubles as
/// the id of the @everyone role.  This is the single source of truth used by
/// both the single-channel and batch permission paths so the two cannot
/// diverge.
fn apply_overwrites(
    base: Permissions,
    role_ids: &std::collections::HashSet<i64>,
    guild_id: i64,
    user_id: i64,
    overwrites: &[paracord_db::channel_overwrites::ChannelOverwriteRow],
) -> Permissions {
    let mut perms = base;

    // @everyone role overwrite (target_id == guild_id)
    if let Some(everyone) = overwrites
        .iter()
        .find(|o| o.target_type == OVERWRITE_TARGET_ROLE && o.target_id == guild_id)
    {
        perms &= !Permissions::from_bits_truncate(everyone.deny_perms);
        perms |= Permissions::from_bits_truncate(everyone.allow_perms);
    }

    // Combined role overwrites for the roles the member holds.
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

    // Member-specific overwrite (highest precedence).
    if let Some(member_ow) = overwrites
        .iter()
        .find(|o| o.target_type == OVERWRITE_TARGET_MEMBER && o.target_id == user_id)
    {
        perms &= !Permissions::from_bits_truncate(member_ow.deny_perms);
        perms |= Permissions::from_bits_truncate(member_ow.allow_perms);
    }

    perms
}

/// If the user is a bot account, intersect the given permissions with the
/// bot's install-time permissions for the guild.  Returns the capped
/// permissions, or the original permissions unchanged for non-bot users.
pub async fn cap_bot_install_permissions(
    pool: &DbPool,
    guild_id: i64,
    user_id: i64,
    perms: Permissions,
) -> Result<Permissions, CoreError> {
    cap_bot_install_permissions_hinted(pool, guild_id, user_id, perms, None).await
}

/// Like [`cap_bot_install_permissions`], but accepts an optional `is_bot`
/// hint so hot paths that already know the account type (or know the caller is
/// an ordinary human) can skip the `get_user_by_id` round-trip entirely.
///
/// - `Some(false)`: known non-bot, return `perms` unchanged with no DB access.
/// - `Some(true)`: known bot, skip the user lookup and go straight to the
///   install-permission cap.
/// - `None`: unknown, fall back to loading the user to determine bot status.
async fn cap_bot_install_permissions_hinted(
    pool: &DbPool,
    guild_id: i64,
    user_id: i64,
    perms: Permissions,
    is_bot: Option<bool>,
) -> Result<Permissions, CoreError> {
    let is_bot = match is_bot {
        Some(false) => return Ok(perms),
        Some(true) => true,
        None => {
            let Some(user) = paracord_db::users::get_user_by_id(pool, user_id).await? else {
                return Ok(perms);
            };
            crate::is_bot(user.flags)
        }
    };
    if !is_bot {
        return Ok(perms);
    }
    // Look up the bot's install-time permissions for this guild
    let install_perms =
        paracord_db::bot_applications::get_bot_install_permissions_by_user(pool, user_id, guild_id)
            .await?;
    match install_perms {
        Some(bits) => Ok(perms & Permissions::from_bits_truncate(bits)),
        // Bot is not installed in this guild -- deny all
        None => Ok(Permissions::empty()),
    }
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
        // Still cap bots even if they somehow have ADMINISTRATOR from roles
        return cap_bot_install_permissions(pool, guild_id, user_id, Permissions::all()).await;
    }

    let channel = paracord_db::channels::get_channel(pool, channel_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    let role_ids: std::collections::HashSet<i64> = roles.iter().map(|r| r.id).collect();
    let required_role_ids =
        paracord_db::channels::parse_required_role_ids(&channel.required_role_ids);
    if !required_role_ids.is_empty() && !required_role_ids.iter().any(|id| role_ids.contains(id)) {
        perms.remove(Permissions::VIEW_CHANNEL);
        return cap_bot_install_permissions(pool, guild_id, user_id, perms).await;
    }

    let overwrites =
        paracord_db::channel_overwrites::get_channel_overwrites(pool, channel_id).await?;
    let perms = apply_overwrites(perms, &role_ids, guild_id, user_id, &overwrites);

    cap_bot_install_permissions(pool, guild_id, user_id, perms).await
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

    // Determine bot status once for the whole batch so the per-channel bot cap
    // does not issue a `get_user_by_id` round-trip for each channel. Bots are
    // rare on this path, so the single lookup is cheap and, more importantly,
    // keeps the batch result identical to the single-channel path.
    let is_bot = match paracord_db::users::get_user_by_id(pool, user_id).await? {
        Some(user) => crate::is_bot(user.flags),
        None => false,
    };

    // Compute permissions per channel
    let mut result = HashMap::with_capacity(channels.len());
    for channel in channels {
        // Check required_role_ids
        let required_role_ids =
            paracord_db::channels::parse_required_role_ids(&channel.required_role_ids);
        let perms = if !required_role_ids.is_empty()
            && !required_role_ids.iter().any(|id| role_ids.contains(id))
        {
            let mut perms = base_perms;
            perms.remove(Permissions::VIEW_CHANNEL);
            perms
        } else {
            let empty = Vec::new();
            let overwrites = overwrites_by_channel.get(&channel.id).unwrap_or(&empty);
            apply_overwrites(base_perms, &role_ids, guild_id, user_id, overwrites)
        };

        // Apply the bot install-permission cap consistently with the
        // single-channel path (this was previously omitted in the batch path).
        let perms =
            cap_bot_install_permissions_hinted(pool, guild_id, user_id, perms, Some(is_bot))
                .await?;

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

    // ── apply_overwrites: table-driven precedence tests ──────────────────────

    use paracord_db::channel_overwrites::ChannelOverwriteRow;
    use std::collections::HashSet;

    const GUILD_ID: i64 = 100; // doubles as the @everyone role id
    const USER_ID: i64 = 7;

    fn ow(
        target_id: i64,
        target_type: i16,
        allow: Permissions,
        deny: Permissions,
    ) -> ChannelOverwriteRow {
        ChannelOverwriteRow {
            channel_id: 1,
            target_id,
            target_type,
            allow_perms: allow.bits(),
            deny_perms: deny.bits(),
        }
    }

    fn role_set(ids: &[i64]) -> HashSet<i64> {
        ids.iter().copied().collect()
    }

    #[test]
    fn apply_overwrites_precedence_table() {
        let view = Permissions::VIEW_CHANNEL;
        let send = Permissions::SEND_MESSAGES;
        let react = Permissions::ADD_REACTIONS;

        struct Case {
            name: &'static str,
            base: Permissions,
            roles: Vec<i64>,
            overwrites: Vec<ChannelOverwriteRow>,
            expected: Permissions,
        }

        let role_a = 200_i64;

        let cases = vec![
            Case {
                name: "no overwrites returns base unchanged",
                base: view | send,
                roles: vec![role_a],
                overwrites: vec![],
                expected: view | send,
            },
            Case {
                name: "@everyone deny is applied",
                base: view | send,
                roles: vec![role_a],
                overwrites: vec![ow(
                    GUILD_ID,
                    OVERWRITE_TARGET_ROLE,
                    Permissions::empty(),
                    send,
                )],
                expected: view,
            },
            Case {
                name: "@everyone allow grants a bit not in base",
                base: view,
                roles: vec![role_a],
                overwrites: vec![ow(
                    GUILD_ID,
                    OVERWRITE_TARGET_ROLE,
                    react,
                    Permissions::empty(),
                )],
                expected: view | react,
            },
            Case {
                name: "role allow overrides @everyone deny",
                base: view,
                roles: vec![role_a],
                overwrites: vec![
                    ow(GUILD_ID, OVERWRITE_TARGET_ROLE, Permissions::empty(), send),
                    ow(role_a, OVERWRITE_TARGET_ROLE, send, Permissions::empty()),
                ],
                expected: view | send,
            },
            Case {
                name: "member overwrite overrides role overwrite",
                base: view,
                roles: vec![role_a],
                overwrites: vec![
                    ow(role_a, OVERWRITE_TARGET_ROLE, send, Permissions::empty()),
                    ow(USER_ID, OVERWRITE_TARGET_MEMBER, Permissions::empty(), send),
                ],
                expected: view,
            },
            Case {
                name: "member allow is the final word",
                base: Permissions::empty(),
                roles: vec![role_a],
                overwrites: vec![
                    ow(GUILD_ID, OVERWRITE_TARGET_ROLE, Permissions::empty(), view),
                    ow(role_a, OVERWRITE_TARGET_ROLE, Permissions::empty(), send),
                    ow(
                        USER_ID,
                        OVERWRITE_TARGET_MEMBER,
                        view | send,
                        Permissions::empty(),
                    ),
                ],
                expected: view | send,
            },
            Case {
                name: "overwrite for a role the member lacks is ignored",
                base: view,
                roles: vec![role_a],
                overwrites: vec![ow(999, OVERWRITE_TARGET_ROLE, send, Permissions::empty())],
                expected: view,
            },
        ];

        for case in cases {
            let got = apply_overwrites(
                case.base,
                &role_set(&case.roles),
                GUILD_ID,
                USER_ID,
                &case.overwrites,
            );
            assert_eq!(got, case.expected, "case failed: {}", case.name);
        }
    }

    // ── DB-backed precedence + single/batch parity ───────────────────────────

    use paracord_db::DbPool;

    async fn mem_pool() -> DbPool {
        let pool = paracord_db::create_pool("sqlite::memory:", 1)
            .await
            .expect("create in-memory pool");
        paracord_db::run_migrations(&pool)
            .await
            .expect("run migrations");
        pool
    }

    /// Build a guild owned by `owner_id`, a channel, a member `user_id` with a
    /// single role granting `role_perms`, and the supplied channel overwrites.
    /// Returns (guild_id, channel_id, role_id).
    async fn seed_guild(
        pool: &DbPool,
        owner_id: i64,
        user_id: i64,
        user_flags: i32,
        role_perms: i64,
        required_role_ids: Option<&str>,
        overwrites: &[(i64, i16, Permissions, Permissions)],
    ) -> (i64, i64, i64) {
        let guild_id = 100;
        let channel_id = 500;
        let role_id = 300;

        paracord_db::users::create_user(pool, owner_id, "owner", 1, "owner@x", "h")
            .await
            .unwrap();
        paracord_db::users::create_user(pool, user_id, "member", 2, "member@x", "h")
            .await
            .unwrap();
        if user_flags != 0 {
            paracord_db::users::update_user_flags(pool, user_id, user_flags)
                .await
                .unwrap();
        }
        paracord_db::guilds::create_guild(pool, guild_id, "g", owner_id, None)
            .await
            .unwrap();
        paracord_db::members::add_member(pool, user_id, guild_id)
            .await
            .unwrap();
        paracord_db::roles::create_role(pool, role_id, guild_id, "r", role_perms)
            .await
            .unwrap();
        paracord_db::roles::add_member_role(pool, user_id, guild_id, role_id)
            .await
            .unwrap();
        paracord_db::channels::create_channel(
            pool,
            channel_id,
            guild_id,
            "c",
            0,
            0,
            None,
            required_role_ids,
        )
        .await
        .unwrap();
        for (target_id, target_type, allow, deny) in overwrites {
            paracord_db::channel_overwrites::upsert_channel_overwrite(
                pool,
                channel_id,
                *target_id,
                *target_type,
                allow.bits(),
                deny.bits(),
            )
            .await
            .unwrap();
        }
        (guild_id, channel_id, role_id)
    }

    async fn batch_perms(
        pool: &DbPool,
        guild_id: i64,
        channel_id: i64,
        owner_id: i64,
        user_id: i64,
    ) -> Permissions {
        let channel = paracord_db::channels::get_channel(pool, channel_id)
            .await
            .unwrap()
            .unwrap();
        let map = compute_all_channel_permissions(pool, guild_id, &[channel], owner_id, user_id)
            .await
            .unwrap();
        *map.get(&channel_id).unwrap()
    }

    #[tokio::test]
    async fn single_and_batch_parity_with_overwrites() {
        let pool = mem_pool().await;
        let owner_id = 1;
        let user_id = 7;
        let role_perms = (Permissions::VIEW_CHANNEL | Permissions::SEND_MESSAGES).bits();
        let (guild_id, channel_id, role_id) = seed_guild(
            &pool,
            owner_id,
            user_id,
            0,
            role_perms,
            None,
            &[
                // @everyone denies SEND (@everyone role id == guild id == 100)
                (
                    100,
                    OVERWRITE_TARGET_ROLE,
                    Permissions::empty(),
                    Permissions::SEND_MESSAGES,
                ),
            ],
        )
        .await;
        // Re-grant SEND via the member's role overwrite (role wins over @everyone).
        paracord_db::channel_overwrites::upsert_channel_overwrite(
            &pool,
            channel_id,
            role_id,
            OVERWRITE_TARGET_ROLE,
            Permissions::SEND_MESSAGES.bits(),
            Permissions::empty().bits(),
        )
        .await
        .unwrap();

        let single = compute_channel_permissions(&pool, guild_id, channel_id, owner_id, user_id)
            .await
            .unwrap();
        let batch = batch_perms(&pool, guild_id, channel_id, owner_id, user_id).await;

        assert_eq!(single, batch, "single and batch results must match");
        assert!(single.contains(Permissions::VIEW_CHANNEL));
        assert!(single.contains(Permissions::SEND_MESSAGES));
    }

    #[tokio::test]
    async fn required_role_removes_view_channel_in_both_paths() {
        let pool = mem_pool().await;
        let owner_id = 1;
        let user_id = 7;
        let role_perms = (Permissions::VIEW_CHANNEL | Permissions::SEND_MESSAGES).bits();
        // Require a role the member does NOT hold (id 999).
        let (guild_id, channel_id, _role_id) =
            seed_guild(&pool, owner_id, user_id, 0, role_perms, Some("[999]"), &[]).await;

        let single = compute_channel_permissions(&pool, guild_id, channel_id, owner_id, user_id)
            .await
            .unwrap();
        let batch = batch_perms(&pool, guild_id, channel_id, owner_id, user_id).await;

        assert_eq!(single, batch);
        assert!(!single.contains(Permissions::VIEW_CHANNEL));
    }

    #[tokio::test]
    async fn bot_install_cap_applies_in_both_paths() {
        let pool = mem_pool().await;
        let owner_id = 1;
        let bot_user_id = 7;
        let bot_app_id = 900;
        // Role grants VIEW + SEND + MANAGE_MESSAGES.
        let role_perms =
            (Permissions::VIEW_CHANNEL | Permissions::SEND_MESSAGES | Permissions::MANAGE_MESSAGES)
                .bits();
        let (guild_id, channel_id, _role_id) = seed_guild(
            &pool,
            owner_id,
            bot_user_id,
            crate::USER_FLAG_BOT,
            role_perms,
            None,
            &[],
        )
        .await;

        // Register the bot application and install it with a permission cap of
        // VIEW_CHANNEL only. The effective permission must be capped to VIEW.
        paracord_db::bot_applications::create_bot_application(
            &pool,
            bot_app_id,
            "bot",
            None,
            owner_id,
            bot_user_id,
            "tokenhash",
            None,
            Permissions::VIEW_CHANNEL.bits(),
        )
        .await
        .unwrap();
        paracord_db::bot_applications::add_bot_to_guild(
            &pool,
            bot_app_id,
            guild_id,
            owner_id,
            Permissions::VIEW_CHANNEL.bits(),
        )
        .await
        .unwrap();

        let single =
            compute_channel_permissions(&pool, guild_id, channel_id, owner_id, bot_user_id)
                .await
                .unwrap();
        let batch = batch_perms(&pool, guild_id, channel_id, owner_id, bot_user_id).await;

        assert_eq!(single, batch, "bot cap must be identical in both paths");
        assert_eq!(
            single,
            Permissions::VIEW_CHANNEL,
            "bot must be capped to its install permissions"
        );
    }

    #[tokio::test]
    async fn uninstalled_bot_denied_in_both_paths() {
        let pool = mem_pool().await;
        let owner_id = 1;
        let bot_user_id = 7;
        let role_perms = (Permissions::VIEW_CHANNEL | Permissions::SEND_MESSAGES).bits();
        // Bot user with roles but NO bot_application/install row => denied all.
        let (guild_id, channel_id, _role_id) = seed_guild(
            &pool,
            owner_id,
            bot_user_id,
            crate::USER_FLAG_BOT,
            role_perms,
            None,
            &[],
        )
        .await;

        let single =
            compute_channel_permissions(&pool, guild_id, channel_id, owner_id, bot_user_id)
                .await
                .unwrap();
        let batch = batch_perms(&pool, guild_id, channel_id, owner_id, bot_user_id).await;

        assert_eq!(single, batch);
        assert_eq!(single, Permissions::empty());
    }
}
