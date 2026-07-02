use std::collections::HashMap;

pub struct Session {
    pub user_id: i64,
    pub guild_ids: Vec<i64>,
    pub guild_owner_ids: HashMap<i64, i64>,
    pub session_id: String,
    pub sequence: u64,
}

impl Session {
    pub fn new(user_id: i64, guild_ids: Vec<i64>, guild_owner_ids: HashMap<i64, i64>) -> Self {
        Self {
            user_id,
            guild_ids,
            guild_owner_ids,
            session_id: uuid::Uuid::new_v4().to_string(),
            sequence: 0,
        }
    }

    pub fn next_sequence(&mut self) -> u64 {
        self.sequence += 1;
        self.sequence
    }

    pub fn should_receive_event(
        &self,
        guild_id: Option<i64>,
        target_user_ids: Option<&[i64]>,
    ) -> bool {
        // If the event targets specific users, only deliver to them.
        if let Some(targets) = target_user_ids {
            return targets.contains(&self.user_id);
        }
        match guild_id {
            None => true,
            Some(gid) => self.guild_ids.contains(&gid),
        }
    }

    /// Dynamically add a guild to this session (e.g. after accepting an invite).
    pub fn add_guild(&mut self, guild_id: i64, owner_id: i64) {
        if !self.guild_ids.contains(&guild_id) {
            self.guild_ids.push(guild_id);
        }
        self.guild_owner_ids.insert(guild_id, owner_id);
    }

    /// Dynamically remove a guild from this session (e.g. kicked/banned/left).
    pub fn remove_guild(&mut self, guild_id: i64) {
        self.guild_ids.retain(|id| *id != guild_id);
        self.guild_owner_ids.remove(&guild_id);
    }
}
