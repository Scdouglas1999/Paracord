use dashmap::DashMap;
use std::collections::{HashMap, HashSet};

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
            index.guilds.entry(guild_id).or_default().insert(user_id);
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

    /// Snapshot of all members of a guild (used for targeted cache invalidation).
    pub fn members_of(&self, guild_id: i64) -> Vec<i64> {
        self.guilds
            .get(&guild_id)
            .map(|members| members.iter().copied().collect())
            .unwrap_or_default()
    }

    /// Track a new member (called on GUILD_MEMBER_ADD).
    pub fn add_member(&self, guild_id: i64, user_id: i64) {
        self.guilds.entry(guild_id).or_default().insert(user_id);
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

    /// Reload the index against an authoritative membership snapshot, healing any
    /// drift left by add/remove events that were dropped or never delivered.
    ///
    /// Applies a diff instead of clearing: existing guild sets are upserted
    /// *before* stale guilds are pruned, so a concurrent reader never observes a
    /// guild that still exists as transiently empty or missing. The hot-path
    /// `add_member`/`remove_member` mutators stay authoritative between reloads.
    pub fn reconcile(&self, rows: Vec<(i64, i64)>) {
        let mut desired: HashMap<i64, HashSet<i64>> = HashMap::new();
        for (guild_id, user_id) in rows {
            desired.entry(guild_id).or_default().insert(user_id);
        }

        let mut healed = 0usize;
        let mut present: HashSet<i64> = HashSet::with_capacity(desired.len());
        for (guild_id, members) in desired {
            present.insert(guild_id);
            match self.guilds.get_mut(&guild_id) {
                Some(existing) if *existing == members => {}
                Some(mut existing) => {
                    *existing = members;
                    healed += 1;
                }
                None => {
                    self.guilds.insert(guild_id, members);
                    healed += 1;
                }
            }
        }

        let before = self.guilds.len();
        self.guilds.retain(|guild_id, _| present.contains(guild_id));
        let removed = before.saturating_sub(self.guilds.len());

        if healed > 0 || removed > 0 {
            tracing::info!(
                healed_guilds = healed,
                removed_guilds = removed,
                guilds = self.guilds.len(),
                "member index reconciled"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconcile_heals_missed_add_and_remove_and_prunes_stale_guilds() {
        let index = MemberIndex::from_memberships(vec![(1, 10), (1, 11), (2, 20)]);

        // Simulate drift: a real join we never saw, a real leave we never saw,
        // and a guild that no longer exists in the source of truth.
        index.remove_member(1, 11); // 11 actually stayed
        index.add_member(2, 999); // 999 actually left
        index.add_member(3, 30); // guild 3 was deleted

        index.reconcile(vec![(1, 10), (1, 11), (2, 20)]);

        let mut g1 = index.members_of(1);
        g1.sort_unstable();
        assert_eq!(g1, vec![10, 11]);

        assert_eq!(index.members_of(2), vec![20]);
        assert!(index.members_of(3).is_empty());
    }

    #[test]
    fn reconcile_keeps_existing_guild_untouched_when_unchanged() {
        let index = MemberIndex::from_memberships(vec![(1, 10), (1, 11)]);
        index.reconcile(vec![(1, 11), (1, 10)]);

        let mut g1 = index.members_of(1);
        g1.sort_unstable();
        assert_eq!(g1, vec![10, 11]);
    }
}
