use std::collections::HashMap;

pub struct Session {
    pub user_id: i64,
    pub guild_ids: Vec<i64>,
    pub guild_owner_ids: HashMap<i64, i64>,
    pub session_id: String,
    pub sequence: u64,
    /// Cached friend user ids for presence fan-out, loaded lazily on the first
    /// presence transition and invalidated when a relationship-change event is
    /// delivered to this session. Avoids a DB query on every presence update.
    pub friend_ids: Option<Vec<i64>>,
}

impl Session {
    pub fn new(user_id: i64, guild_ids: Vec<i64>, guild_owner_ids: HashMap<i64, i64>) -> Self {
        Self {
            user_id,
            guild_ids,
            guild_owner_ids,
            session_id: uuid::Uuid::new_v4().to_string(),
            sequence: 0,
            friend_ids: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test for the READY/first-event sequence collision: READY must
    /// consume its own sequence number so the first dispatched event gets a
    /// distinct, strictly increasing sequence. If READY reused the same number
    /// as the first event, the first event would be silently skipped on resume
    /// (the server only replays events with sequence > the client's stored seq).
    #[test]
    fn ready_and_first_event_have_distinct_increasing_sequences() {
        let mut session = Session::new(1, Vec::new(), HashMap::new());
        assert_eq!(session.sequence, 0, "sessions start at sequence 0");

        // READY consumes a sequence.
        let ready_seq = session.next_sequence();
        // The first real dispatched event consumes the next.
        let first_event_seq = session.next_sequence();

        assert_eq!(ready_seq, 1, "READY should be sequence 1");
        assert_eq!(first_event_seq, 2, "first event should be sequence 2");
        assert_ne!(
            ready_seq, first_event_seq,
            "READY and the first event must not collide"
        );
        assert!(
            first_event_seq > ready_seq,
            "sequences must be strictly increasing"
        );
        assert_eq!(
            session.sequence, first_event_seq,
            "session.sequence must equal the last value handed out"
        );
    }
}
