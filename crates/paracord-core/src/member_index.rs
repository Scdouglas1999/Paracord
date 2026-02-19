use dashmap::DashMap;
use std::collections::HashSet;

/// In-memory index: Guild -> Set<UserId>.
/// Loaded from DB at server start and kept in sync via event-driven updates.
/// Eliminates per-guild DB queries during presence dispatch.
pub struct MemberIndex {
    guilds: DashMap<i64, HashSet<i64>>,
}

impl MemberIndex {
    /// Create an empty index (useful for tests).
    pub fn empty() -> Self {
        MemberIndex {
            guilds: DashMap::new(),
        }
    }

    /// Build the index from a pre-fetched list of (guild_id, user_id) pairs.
    pub fn from_memberships(rows: Vec<(i64, i64)>) -> Self {
        let index = Self::empty();
        for (guild_id, user_id) in rows {
            index
                .guilds
                .entry(guild_id)
                .or_insert_with(HashSet::new)
                .insert(user_id);
        }
        tracing::info!(guilds = index.guilds.len(), "member index loaded");
        index
    }

    /// All users who share a guild with the given user, excluding the user itself.
    pub fn get_presence_recipients(&self, user_id: i64, guild_ids: &[i64]) -> HashSet<i64> {
        let mut recipients = HashSet::new();
        for gid in guild_ids {
            if let Some(members) = self.guilds.get(gid) {
                recipients.extend(members.iter());
            }
        }
        recipients.remove(&user_id);
        recipients
    }

    /// Track a new member (called on GUILD_MEMBER_ADD).
    pub fn add_member(&self, guild_id: i64, user_id: i64) {
        self.guilds
            .entry(guild_id)
            .or_insert_with(HashSet::new)
            .insert(user_id);
    }

    /// Remove a member (called on GUILD_MEMBER_REMOVE).
    pub fn remove_member(&self, guild_id: i64, user_id: i64) {
        if let Some(mut members) = self.guilds.get_mut(&guild_id) {
            members.remove(&user_id);
        }
    }

    /// Drop an entire guild (called on GUILD_DELETE).
    pub fn remove_guild(&self, guild_id: i64) {
        self.guilds.remove(&guild_id);
    }
}
