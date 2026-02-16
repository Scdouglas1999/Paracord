use dashmap::DashMap;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::broadcast;

#[derive(Debug, Clone)]
pub struct ServerEvent {
    pub event_type: String,
    pub payload: Arc<serde_json::Value>,
    /// Guild ID this event belongs to, if applicable.
    pub guild_id: Option<i64>,
    /// When set, only deliver this event to the specified user IDs (e.g. DM recipients).
    pub target_user_ids: Option<Vec<i64>>,
    /// Pre-serialized JSON payload for efficient WebSocket dispatch.
    pub serialized_payload: Option<Arc<String>>,
}

/// Broadcast-based event bus for real-time dispatch.
#[derive(Clone)]
pub struct EventBus {
    capacity: usize,
    sessions: Arc<DashMap<String, SessionSubscription>>,
    guild_sessions: Arc<DashMap<i64, HashSet<String>>>,
    user_sessions: Arc<DashMap<i64, HashSet<String>>>,
}

#[derive(Clone)]
struct SessionSubscription {
    user_id: i64,
    guild_ids: HashSet<i64>,
    sender: broadcast::Sender<ServerEvent>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            sessions: Arc::new(DashMap::new()),
            guild_sessions: Arc::new(DashMap::new()),
            user_sessions: Arc::new(DashMap::new()),
        }
    }

    pub fn register_session(
        &self,
        session_id: impl Into<String>,
        user_id: i64,
        guild_ids: &[i64],
    ) -> broadcast::Receiver<ServerEvent> {
        let (sender, receiver) = broadcast::channel(self.capacity.max(64));
        let sid = session_id.into();
        let subscription = SessionSubscription {
            user_id,
            guild_ids: guild_ids.iter().copied().collect(),
            sender,
        };

        // Maintain guild_sessions index
        for &gid in guild_ids {
            self.guild_sessions
                .entry(gid)
                .or_insert_with(HashSet::new)
                .insert(sid.clone());
        }

        // Maintain user_sessions index
        self.user_sessions
            .entry(user_id)
            .or_insert_with(HashSet::new)
            .insert(sid.clone());

        self.sessions.insert(sid, subscription);
        receiver
    }

    pub fn unregister_session(&self, session_id: &str) {
        // Read subscription data before removing
        if let Some((_, sub)) = self.sessions.remove(session_id) {
            // Remove from guild_sessions index
            for gid in &sub.guild_ids {
                if let Some(mut sids) = self.guild_sessions.get_mut(gid) {
                    sids.remove(session_id);
                    if sids.is_empty() {
                        drop(sids);
                        self.guild_sessions.remove(gid);
                    }
                }
            }

            // Remove from user_sessions index
            if let Some(mut sids) = self.user_sessions.get_mut(&sub.user_id) {
                sids.remove(session_id);
                if sids.is_empty() {
                    drop(sids);
                    self.user_sessions.remove(&sub.user_id);
                }
            }
        }
    }

    pub fn add_session_guild(&self, session_id: &str, guild_id: i64) {
        if let Some(mut sub) = self.sessions.get_mut(session_id) {
            sub.guild_ids.insert(guild_id);
        }

        // Maintain guild_sessions index
        self.guild_sessions
            .entry(guild_id)
            .or_insert_with(HashSet::new)
            .insert(session_id.to_string());
    }

    pub fn remove_session_guild(&self, session_id: &str, guild_id: i64) {
        if let Some(mut sub) = self.sessions.get_mut(session_id) {
            sub.guild_ids.remove(&guild_id);
        }

        // Maintain guild_sessions index
        if let Some(mut sids) = self.guild_sessions.get_mut(&guild_id) {
            sids.remove(session_id);
            if sids.is_empty() {
                drop(sids);
                self.guild_sessions.remove(&guild_id);
            }
        }
    }

    pub fn publish(&self, event: ServerEvent) {
        // Collect matching session IDs
        let session_ids: Vec<String> = if let Some(ref targets) = event.target_user_ids {
            // User-targeted events: look up each target user's sessions
            let mut ids = Vec::new();
            for &uid in targets {
                if let Some(user_sids) = self.user_sessions.get(&uid) {
                    ids.extend(user_sids.iter().cloned());
                }
            }
            ids
        } else if let Some(guild_id) = event.guild_id {
            // Guild-scoped events: look up guild's sessions
            self.guild_sessions
                .get(&guild_id)
                .map(|sids| sids.iter().cloned().collect())
                .unwrap_or_default()
        } else {
            // Global events: all sessions
            self.sessions
                .iter()
                .map(|entry| entry.key().clone())
                .collect()
        };

        // Send to matching sessions
        for sid in session_ids {
            if let Some(sub) = self.sessions.get(&sid) {
                let _ = sub.sender.send(event.clone());
            }
        }
    }

    /// Helper: publish a typed event with guild_id
    pub fn dispatch(&self, event_type: &str, payload: serde_json::Value, guild_id: Option<i64>) {
        let payload_arc = Arc::new(payload);
        let serialized = Arc::new(serde_json::to_string(&*payload_arc).unwrap_or_default());
        self.publish(ServerEvent {
            event_type: event_type.to_string(),
            payload: payload_arc,
            guild_id,
            target_user_ids: None,
            serialized_payload: Some(serialized),
        });
    }

    /// Helper: publish a targeted event delivered only to the specified users.
    pub fn dispatch_to_users(
        &self,
        event_type: &str,
        payload: serde_json::Value,
        target_user_ids: Vec<i64>,
    ) {
        let payload_arc = Arc::new(payload);
        let serialized = Arc::new(serde_json::to_string(&*payload_arc).unwrap_or_default());
        self.publish(ServerEvent {
            event_type: event_type.to_string(),
            payload: payload_arc,
            guild_id: None,
            target_user_ids: Some(target_user_ids),
            serialized_payload: Some(serialized),
        });
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new(4096)
    }
}
