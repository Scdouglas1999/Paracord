use crate::error::CoreError;
use crate::member_index::MemberIndex;
use crate::PermissionCacheKey;
use dashmap::DashMap;
use moka::notification::RemovalCause;
use paracord_db::DbPool;
use paracord_models::permissions::Permissions;
use std::collections::HashSet;
use std::sync::Arc;

pub const OVERWRITE_TARGET_ROLE: i16 = 0;
pub const OVERWRITE_TARGET_MEMBER: i16 = 1;

/// Channel type shared by threads and forum posts.
///
/// Rows of this type are always written with `required_role_ids = '[]'` and
/// never receive permission overwrites of their own, so their access control
/// lives entirely on the parent channel. See [`resolve_permission_gate`].
pub const CHANNEL_TYPE_THREAD: i16 = 6;

/// Remove `key` from the reverse index bucket `outer`, dropping the bucket when
/// it becomes empty so the index cannot grow without bound.
fn remove_from_reverse_index(
    index: &DashMap<i64, HashSet<PermissionCacheKey>>,
    outer: i64,
    key: &PermissionCacheKey,
) {
    let now_empty = match index.get_mut(&outer) {
        Some(mut bucket) => {
            bucket.remove(key);
            bucket.is_empty()
        }
        None => false,
    };
    if now_empty {
        // Re-check under the write lock so a concurrent insert isn't clobbered.
        index.remove_if(&outer, |_, bucket| bucket.is_empty());
    }
}

/// The computed-permission cache: a moka LRU (5-min TTL, capped size) paired
/// with two reverse indexes (`channel_id -> keys`, `user_id -> keys`) so that
/// channel- and user-scoped invalidation is O(affected entries) instead of a
/// full-cache scan. The reverse indexes are populated on insert and pruned by
/// moka's eviction listener whenever a key truly leaves the cache (explicit
/// invalidation, TTL expiry, or size eviction), keeping them consistent with
/// the underlying cache without an unbounded scan.
#[derive(Clone)]
pub struct PermissionCache {
    cache: moka::future::Cache<PermissionCacheKey, Permissions>,
    by_channel: Arc<DashMap<i64, HashSet<PermissionCacheKey>>>,
    by_user: Arc<DashMap<i64, HashSet<PermissionCacheKey>>>,
}

impl PermissionCache {
    /// Build the cache with the given max entry count and a 5-minute TTL.
    pub fn new(max_capacity: u64) -> Self {
        let by_channel: Arc<DashMap<i64, HashSet<PermissionCacheKey>>> = Arc::new(DashMap::new());
        let by_user: Arc<DashMap<i64, HashSet<PermissionCacheKey>>> = Arc::new(DashMap::new());
        let listener_channels = Arc::clone(&by_channel);
        let listener_users = Arc::clone(&by_user);
        let cache = moka::future::Cache::builder()
            .max_capacity(max_capacity)
            .time_to_live(std::time::Duration::from_secs(300))
            .eviction_listener(move |key: Arc<PermissionCacheKey>, _perms, cause| {
                // A replacement keeps the same key present with a new value, so
                // its reverse-index entries must survive; only prune when the
                // key genuinely leaves the cache.
                if cause == RemovalCause::Replaced {
                    return;
                }
                let (user_id, channel_id) = *key;
                remove_from_reverse_index(&listener_channels, channel_id, &key);
                remove_from_reverse_index(&listener_users, user_id, &key);
            })
            .build();
        Self {
            cache,
            by_channel,
            by_user,
        }
    }

    async fn get(&self, key: &PermissionCacheKey) -> Option<Permissions> {
        self.cache.get(key).await
    }

    async fn insert(&self, key: PermissionCacheKey, perms: Permissions) {
        let (user_id, channel_id) = key;
        self.by_channel.entry(channel_id).or_default().insert(key);
        self.by_user.entry(user_id).or_default().insert(key);
        // The eviction listener prunes the reverse indexes for any key it evicts
        // as a side effect of this insert (size eviction); a Replaced cause for
        // this same key is ignored so the entries added above are preserved.
        self.cache.insert(key, perms).await;
    }

    async fn invalidate_key(&self, key: &PermissionCacheKey) {
        // Reverse-index cleanup happens in the eviction listener.
        self.cache.invalidate(key).await;
    }

    /// Invalidate every cached entry for `channel_id` (all users).
    pub async fn invalidate_channel(&self, channel_id: i64) {
        let keys: Vec<PermissionCacheKey> = self
            .by_channel
            .get(&channel_id)
            .map(|bucket| bucket.iter().copied().collect())
            .unwrap_or_default();
        for key in keys {
            self.cache.invalidate(&key).await;
        }
    }

    /// Invalidate every cached entry for `user_id` (all channels).
    pub async fn invalidate_user(&self, user_id: i64) {
        let keys: Vec<PermissionCacheKey> = self
            .by_user
            .get(&user_id)
            .map(|bucket| bucket.iter().copied().collect())
            .unwrap_or_default();
        for key in keys {
            self.cache.invalidate(&key).await;
        }
    }
}

/// Compute channel permissions with cache lookup.  Falls back to
/// `compute_channel_permissions` on cache miss and stores the result.
pub async fn compute_channel_permissions_cached(
    cache: &PermissionCache,
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

/// Seed the permission cache from a batch `compute_all_channel_permissions` result.
/// Uses the same `(user_id, channel_id)` keys and invalidation paths as
/// `compute_channel_permissions_cached`.
pub async fn seed_channel_permissions(
    cache: &PermissionCache,
    user_id: i64,
    channel_permissions: &std::collections::HashMap<i64, Permissions>,
) {
    for (&channel_id, &perms) in channel_permissions {
        cache.insert((user_id, channel_id), perms).await;
    }
}

/// Invalidate cached permissions for a specific user in a specific channel.
pub async fn invalidate_user_channel(cache: &PermissionCache, user_id: i64, channel_id: i64) {
    cache.invalidate_key(&(user_id, channel_id)).await;
}

/// Invalidate all cached permissions for a specific channel (all users).
/// Uses the channel reverse index so only affected entries are touched.
pub async fn invalidate_channel(cache: &PermissionCache, channel_id: i64) {
    cache.invalidate_channel(channel_id).await;
}

/// Invalidate all cached permissions for a user across all channels.
/// Used when a user's roles change.
pub async fn invalidate_user(cache: &PermissionCache, user_id: i64) {
    cache.invalidate_user(user_id).await;
}

/// Invalidate cached permissions for every member of a guild. Used when a
/// role's permissions change or a role is deleted, which can alter effective
/// permissions for any member across any channel. Iterates the guild's members
/// (via the in-memory index) and invalidates each user's entries through the
/// user reverse index, so no full-cache scan is required.
pub async fn invalidate_guild_members(
    cache: &PermissionCache,
    member_index: &MemberIndex,
    guild_id: i64,
) {
    for user_id in member_index.members_of(guild_id) {
        cache.invalidate_user(user_id).await;
    }
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

/// Compute permissions from a set of Role rows.
///
/// **Hazard:** this is a pure fold over role bits. It applies neither channel
/// permission overwrites nor the bot install-permission cap, because it never
/// touches the database. Using it as an authorization gate is only correct when
/// the caller genuinely has nothing but a role list to work from:
///
/// - channel-scoped actions must use [`compute_channel_permissions`] (or the
///   cached/batch variants), otherwise a per-channel deny is unenforceable;
/// - guild-scoped actions must use [`compute_guild_permissions`], otherwise a
///   bot installed with restricted permissions exercises its full role bits.
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
///
/// The `is_bot` hint lets callers that already know the account type reuse a
/// single lookup across many cap calls (e.g. the batch path) or skip the
/// `get_user_by_id` round-trip entirely:
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

/// Resolve the channel row whose containment settings (`required_role_ids` plus
/// permission overwrites) govern access to `channel`.
///
/// For ordinary channels that is the channel itself. Threads and forum posts
/// (both [`CHANNEL_TYPE_THREAD`]) are created with an empty `required_role_ids`
/// and never carry overwrites, so evaluating them directly would let a member
/// who is denied `VIEW_CHANNEL` on `#private` fall straight through to their
/// base role bits inside `#private`'s threads — and thread ids are enumerable.
///
/// Returns `None` when a thread has no parent or its parent no longer exists;
/// callers must fail closed on that rather than fall back to base permissions.
async fn resolve_permission_gate(
    pool: &DbPool,
    channel: paracord_db::channels::ChannelRow,
) -> Result<Option<paracord_db::channels::ChannelRow>, CoreError> {
    if channel.channel_type != CHANNEL_TYPE_THREAD {
        return Ok(Some(channel));
    }
    let Some(parent_id) = channel.parent_id else {
        return Ok(None);
    };
    Ok(paracord_db::channels::get_channel(pool, parent_id).await?)
}

/// Compute a member's guild-level (channel-independent) permissions.
///
/// This is the correct primitive for guild-scoped gates such as `MANAGE_GUILD`,
/// `KICK_MEMBERS` or `MANAGE_EMOJIS`: it folds the member's role bits *and*
/// applies the bot install-permission cap. [`compute_permissions_from_roles`]
/// cannot apply that cap, so a bot installed with `permissions=0` would
/// otherwise exercise whatever its guild roles happen to grant.
///
/// Actions scoped to a specific channel must still use
/// [`compute_channel_permissions`] so that channel overwrites are honored.
pub async fn compute_guild_permissions(
    pool: &DbPool,
    guild_id: i64,
    guild_owner_id: i64,
    user_id: i64,
) -> Result<Permissions, CoreError> {
    let roles = paracord_db::roles::get_member_roles(pool, user_id, guild_id).await?;
    let perms = compute_permissions_from_roles(&roles, guild_owner_id, user_id);
    cap_bot_install_permissions_hinted(pool, guild_id, user_id, perms, None).await
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

    // Determine bot status once and thread it through every cap point via the
    // hinted variant, mirroring the batch path. This keeps the single-channel
    // path to a single `get_user_by_id`, and the common human case (`is_bot`
    // false) turns each cap into a no-op with no further DB access.
    let is_bot = match paracord_db::users::get_user_by_id(pool, user_id).await? {
        Some(user) => crate::is_bot(user.flags),
        None => false,
    };
    let hint = Some(is_bot);

    if perms.contains(Permissions::ADMINISTRATOR) || user_id == guild_owner_id {
        // Still cap bots even if they somehow have ADMINISTRATOR from roles
        return cap_bot_install_permissions_hinted(
            pool,
            guild_id,
            user_id,
            Permissions::all(),
            hint,
        )
        .await;
    }

    let channel = paracord_db::channels::get_channel(pool, channel_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    let role_ids: std::collections::HashSet<i64> = roles.iter().map(|r| r.id).collect();

    let Some(gate) = resolve_permission_gate(pool, channel).await? else {
        // Orphaned thread: without a parent there is no containment to evaluate,
        // so deny visibility instead of falling through to base role bits.
        perms.remove(Permissions::VIEW_CHANNEL);
        return cap_bot_install_permissions_hinted(pool, guild_id, user_id, perms, hint).await;
    };

    let required_role_ids = paracord_db::channels::parse_required_role_ids(&gate.required_role_ids);
    if !required_role_ids.is_empty() && !required_role_ids.iter().any(|id| role_ids.contains(id)) {
        perms.remove(Permissions::VIEW_CHANNEL);
        return cap_bot_install_permissions_hinted(pool, guild_id, user_id, perms, hint).await;
    }

    let overwrites = paracord_db::channel_overwrites::get_channel_overwrites(pool, gate.id).await?;
    let perms = apply_overwrites(perms, &role_ids, guild_id, user_id, &overwrites);

    cap_bot_install_permissions_hinted(pool, guild_id, user_id, perms, hint).await
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

    // Resolve every channel to the row that actually gates it, so threads are
    // evaluated against their parent exactly as in the single-channel path.
    let by_id: HashMap<i64, &paracord_db::channels::ChannelRow> =
        channels.iter().map(|c| (c.id, c)).collect();
    // A thread's parent is normally part of the same batch (callers pass every
    // guild channel), but load any that are not so a narrower batch cannot
    // silently lose the parent's gate.
    let mut absent_parents: Vec<i64> = channels
        .iter()
        .filter(|c| c.channel_type == CHANNEL_TYPE_THREAD)
        .filter_map(|c| c.parent_id)
        .filter(|parent_id| !by_id.contains_key(parent_id))
        .collect();
    absent_parents.sort_unstable();
    absent_parents.dedup();
    let mut fetched_parents: HashMap<i64, paracord_db::channels::ChannelRow> = HashMap::new();
    for parent_id in absent_parents {
        if let Some(parent) = paracord_db::channels::get_channel(pool, parent_id).await? {
            fetched_parents.insert(parent_id, parent);
        }
    }
    // Channels absent from this map are orphaned threads and are denied below.
    let mut gates: HashMap<i64, &paracord_db::channels::ChannelRow> =
        HashMap::with_capacity(channels.len());
    for channel in channels {
        let gate = if channel.channel_type == CHANNEL_TYPE_THREAD {
            channel.parent_id.and_then(|parent_id| {
                by_id
                    .get(&parent_id)
                    .copied()
                    .or_else(|| fetched_parents.get(&parent_id))
            })
        } else {
            Some(channel)
        };
        if let Some(gate) = gate {
            gates.insert(channel.id, gate);
        }
    }

    // Load all overwrites for every gating channel in one query
    let mut channel_ids: Vec<i64> = gates.values().map(|gate| gate.id).collect();
    channel_ids.sort_unstable();
    channel_ids.dedup();
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
        // Check required_role_ids on the gating channel (the parent, for threads)
        let perms = match gates.get(&channel.id) {
            Some(gate) => {
                let required_role_ids =
                    paracord_db::channels::parse_required_role_ids(&gate.required_role_ids);
                if !required_role_ids.is_empty()
                    && !required_role_ids.iter().any(|id| role_ids.contains(id))
                {
                    let mut perms = base_perms;
                    perms.remove(Permissions::VIEW_CHANNEL);
                    perms
                } else {
                    let empty = Vec::new();
                    let overwrites = overwrites_by_channel.get(&gate.id).unwrap_or(&empty);
                    apply_overwrites(base_perms, &role_ids, guild_id, user_id, overwrites)
                }
            }
            None => {
                // Orphaned thread: fail closed rather than expose base role bits.
                let mut perms = base_perms;
                perms.remove(Permissions::VIEW_CHANNEL);
                perms
            }
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

    // ── Threads inherit their parent channel's containment ───────────────────

    /// Create a thread under `parent_id` and return the permissions the member
    /// gets for it via both the single-channel and batch paths (asserted equal).
    async fn thread_perms(
        pool: &DbPool,
        guild_id: i64,
        parent_id: i64,
        thread_id: i64,
        owner_id: i64,
        user_id: i64,
    ) -> Permissions {
        let thread = paracord_db::channels::get_channel(pool, thread_id)
            .await
            .unwrap()
            .unwrap();
        let parent = paracord_db::channels::get_channel(pool, parent_id)
            .await
            .unwrap()
            .unwrap();
        let single = compute_channel_permissions(pool, guild_id, thread_id, owner_id, user_id)
            .await
            .unwrap();
        // Batch with the parent present (the real gateway/REST shape) and without
        // it, since both must resolve the parent's gate.
        let with_parent = compute_all_channel_permissions(
            pool,
            guild_id,
            &[parent, thread.clone()],
            owner_id,
            user_id,
        )
        .await
        .unwrap();
        let alone = compute_all_channel_permissions(pool, guild_id, &[thread], owner_id, user_id)
            .await
            .unwrap();
        assert_eq!(
            single,
            *with_parent.get(&thread_id).unwrap(),
            "single and batch (parent in batch) must agree for threads"
        );
        assert_eq!(
            single,
            *alone.get(&thread_id).unwrap(),
            "single and batch (parent outside batch) must agree for threads"
        );
        single
    }

    #[tokio::test]
    async fn thread_inherits_parent_view_channel_deny() {
        let pool = mem_pool().await;
        let owner_id = 1;
        let user_id = 7;
        let role_perms = (Permissions::VIEW_CHANNEL | Permissions::SEND_MESSAGES).bits();
        let (guild_id, parent_id, _role_id) = seed_guild(
            &pool,
            owner_id,
            user_id,
            0,
            role_perms,
            None,
            // @everyone (role id == guild id) is denied VIEW on the parent channel.
            &[(
                100,
                OVERWRITE_TARGET_ROLE,
                Permissions::empty(),
                Permissions::VIEW_CHANNEL,
            )],
        )
        .await;

        let thread_id = 900;
        paracord_db::channels::create_thread(
            &pool, thread_id, guild_id, parent_id, "t", owner_id, 1440, None,
        )
        .await
        .unwrap();

        // Sanity: the parent itself is hidden.
        let parent_perms =
            compute_channel_permissions(&pool, guild_id, parent_id, owner_id, user_id)
                .await
                .unwrap();
        assert!(!parent_perms.contains(Permissions::VIEW_CHANNEL));

        let perms = thread_perms(&pool, guild_id, parent_id, thread_id, owner_id, user_id).await;
        assert!(
            !perms.contains(Permissions::VIEW_CHANNEL),
            "a thread must not expose a channel its parent hides"
        );
    }

    #[tokio::test]
    async fn thread_inherits_parent_required_roles() {
        let pool = mem_pool().await;
        let owner_id = 1;
        let user_id = 7;
        let role_perms = (Permissions::VIEW_CHANNEL | Permissions::SEND_MESSAGES).bits();
        // Parent requires role 999, which the member does not hold.
        let (guild_id, parent_id, _role_id) =
            seed_guild(&pool, owner_id, user_id, 0, role_perms, Some("[999]"), &[]).await;

        let thread_id = 901;
        paracord_db::channels::create_thread(
            &pool, thread_id, guild_id, parent_id, "t", owner_id, 1440, None,
        )
        .await
        .unwrap();

        let perms = thread_perms(&pool, guild_id, parent_id, thread_id, owner_id, user_id).await;
        assert!(
            !perms.contains(Permissions::VIEW_CHANNEL),
            "a thread must inherit its parent's required-role gate"
        );
    }

    #[tokio::test]
    async fn thread_inherits_parent_allow_overwrite() {
        let pool = mem_pool().await;
        let owner_id = 1;
        let user_id = 7;
        // No base permissions at all; the parent's member overwrite grants them.
        let (guild_id, parent_id, _role_id) = seed_guild(
            &pool,
            owner_id,
            user_id,
            0,
            Permissions::empty().bits(),
            None,
            &[(
                7,
                OVERWRITE_TARGET_MEMBER,
                Permissions::VIEW_CHANNEL | Permissions::SEND_MESSAGES,
                Permissions::empty(),
            )],
        )
        .await;

        let thread_id = 902;
        paracord_db::channels::create_thread(
            &pool, thread_id, guild_id, parent_id, "t", owner_id, 1440, None,
        )
        .await
        .unwrap();

        let perms = thread_perms(&pool, guild_id, parent_id, thread_id, owner_id, user_id).await;
        assert!(perms.contains(Permissions::VIEW_CHANNEL));
        assert!(perms.contains(Permissions::SEND_MESSAGES));
    }

    #[tokio::test]
    async fn parentless_thread_fails_closed() {
        let pool = mem_pool().await;
        let owner_id = 1;
        let user_id = 7;
        let role_perms = (Permissions::VIEW_CHANNEL | Permissions::SEND_MESSAGES).bits();
        let (guild_id, _parent_id, _role_id) =
            seed_guild(&pool, owner_id, user_id, 0, role_perms, None, &[]).await;

        // A thread row with no parent has no containment to evaluate. It cannot be
        // produced by the normal thread routes, but federation/import paths write
        // channel rows directly, so the computation must not fall through to the
        // member's base role bits.
        let thread_id = 903;
        paracord_db::channels::create_channel(
            &pool,
            thread_id,
            guild_id,
            "orphan",
            CHANNEL_TYPE_THREAD,
            0,
            None,
            None,
        )
        .await
        .unwrap();

        let thread = paracord_db::channels::get_channel(&pool, thread_id)
            .await
            .unwrap()
            .unwrap();
        let single = compute_channel_permissions(&pool, guild_id, thread_id, owner_id, user_id)
            .await
            .unwrap();
        let batch = compute_all_channel_permissions(&pool, guild_id, &[thread], owner_id, user_id)
            .await
            .unwrap();
        assert_eq!(single, *batch.get(&thread_id).unwrap());
        assert!(
            !single.contains(Permissions::VIEW_CHANNEL),
            "a thread with no parent must fail closed"
        );
    }

    // ── Guild-scoped permissions apply the bot install cap ───────────────────

    #[tokio::test]
    async fn compute_guild_permissions_caps_bots() {
        let pool = mem_pool().await;
        let owner_id = 1;
        let bot_user_id = 7;
        let bot_app_id = 900;
        let role_perms = (Permissions::MANAGE_GUILD | Permissions::KICK_MEMBERS).bits();
        let (guild_id, _channel_id, _role_id) = seed_guild(
            &pool,
            owner_id,
            bot_user_id,
            crate::USER_FLAG_BOT,
            role_perms,
            None,
            &[],
        )
        .await;
        paracord_db::bot_applications::create_bot_application(
            &pool,
            bot_app_id,
            "bot",
            None,
            owner_id,
            bot_user_id,
            "tokenhash",
            None,
            Permissions::KICK_MEMBERS.bits(),
        )
        .await
        .unwrap();
        paracord_db::bot_applications::add_bot_to_guild(
            &pool,
            bot_app_id,
            guild_id,
            owner_id,
            Permissions::KICK_MEMBERS.bits(),
        )
        .await
        .unwrap();

        let roles = paracord_db::roles::get_member_roles(&pool, bot_user_id, guild_id)
            .await
            .unwrap();
        let uncapped = compute_permissions_from_roles(&roles, owner_id, bot_user_id);
        assert!(
            uncapped.contains(Permissions::MANAGE_GUILD),
            "the raw role fold is what a guild-level gate used to see"
        );

        let capped = compute_guild_permissions(&pool, guild_id, owner_id, bot_user_id)
            .await
            .unwrap();
        assert_eq!(capped, Permissions::KICK_MEMBERS);
    }

    // ── PermissionCache targeted invalidation ────────────────────────────────

    #[tokio::test]
    async fn invalidate_channel_only_affects_that_channel() {
        let cache = PermissionCache::new(100);
        let p = Permissions::VIEW_CHANNEL;
        cache.insert((1, 10), p).await; // user 1, channel 10
        cache.insert((2, 10), p).await; // user 2, channel 10
        cache.insert((1, 11), p).await; // user 1, channel 11

        cache.invalidate_channel(10).await;

        assert_eq!(cache.get(&(1, 10)).await, None);
        assert_eq!(cache.get(&(2, 10)).await, None);
        assert_eq!(cache.get(&(1, 11)).await, Some(p));
    }

    #[tokio::test]
    async fn invalidate_user_only_affects_that_user() {
        let cache = PermissionCache::new(100);
        let p = Permissions::VIEW_CHANNEL;
        cache.insert((1, 10), p).await;
        cache.insert((1, 11), p).await;
        cache.insert((2, 10), p).await;

        cache.invalidate_user(1).await;

        assert_eq!(cache.get(&(1, 10)).await, None);
        assert_eq!(cache.get(&(1, 11)).await, None);
        assert_eq!(cache.get(&(2, 10)).await, Some(p));
    }

    #[tokio::test]
    async fn invalidate_prunes_reverse_indexes() {
        let cache = PermissionCache::new(100);
        let p = Permissions::VIEW_CHANNEL;
        cache.insert((1, 10), p).await;
        cache.insert((2, 10), p).await;

        cache.invalidate_channel(10).await;
        // Force moka to drain its eviction listener so the reverse indexes are
        // pruned deterministically.
        cache.cache.run_pending_tasks().await;

        assert!(cache.by_channel.get(&10).is_none());
        assert!(cache.by_user.get(&1).is_none());
        assert!(cache.by_user.get(&2).is_none());
    }

    #[tokio::test]
    async fn invalidate_guild_members_clears_all_member_entries() {
        let cache = PermissionCache::new(100);
        let p = Permissions::VIEW_CHANNEL;
        cache.insert((1, 10), p).await; // member 1
        cache.insert((2, 11), p).await; // member 2
        cache.insert((3, 10), p).await; // non-member 3

        let index = MemberIndex::empty();
        index.add_member(500, 1);
        index.add_member(500, 2);

        invalidate_guild_members(&cache, &index, 500).await;

        assert_eq!(cache.get(&(1, 10)).await, None);
        assert_eq!(cache.get(&(2, 11)).await, None);
        // A user who is not a member of the guild is untouched.
        assert_eq!(cache.get(&(3, 10)).await, Some(p));
    }
}
