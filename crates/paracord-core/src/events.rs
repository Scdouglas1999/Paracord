use crate::observability;
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
    system_sender: broadcast::Sender<ServerEvent>,
}

#[derive(Clone)]
struct SessionSubscription {
    user_id: i64,
    guild_ids: HashSet<i64>,
    sender: broadcast::Sender<ServerEvent>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (system_sender, _) = broadcast::channel(capacity);
        Self {
            capacity,
            sessions: Arc::new(DashMap::new()),
            guild_sessions: Arc::new(DashMap::new()),
            user_sessions: Arc::new(DashMap::new()),
            system_sender,
        }
    }

    pub fn subscribe_system(&self) -> broadcast::Receiver<ServerEvent> {
        self.system_sender.subscribe()
    }

    pub fn register_session(
        &self,
        session_id: impl Into<String>,
        user_id: i64,
        guild_ids: &[i64],
    ) -> broadcast::Receiver<ServerEvent> {
        let (sender, receiver) = broadcast::channel(self.capacity.max(256));
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
                .or_default()
                .insert(sid.clone());
        }

        // Maintain user_sessions index
        self.user_sessions
            .entry(user_id)
            .or_default()
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
        // Only touch the guild_sessions index if the session is still registered.
        // Otherwise a guild added after unregister_session would leave a permanent
        // phantom session id that publish() repeatedly looks up (and never finds a
        // sender for), and which unregister_session already cleaned up its record of.
        if let Some(mut sub) = self.sessions.get_mut(session_id) {
            sub.guild_ids.insert(guild_id);

            // Maintain guild_sessions index
            self.guild_sessions
                .entry(guild_id)
                .or_default()
                .insert(session_id.to_string());
        }
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
        // Send to native bot system listener
        let _ = self.system_sender.send(event.clone());

        // Sessions whose per-session channel has no live receiver (send returns
        // Err). These are zombies left by a gateway loop that exited without (or
        // just before) calling unregister_session. Reaping them after dispatch
        // stops global fan-out from repeatedly looking them up and keeps the
        // guild/user indexes from permanently desyncing. Lagged-but-live
        // receivers are handled by the gateway itself (RecvError::Lagged forces
        // the client to reconnect and re-fetch), so they never surface here.
        let mut stale: Vec<String> = Vec::new();
        let mut delivered = 0usize;

        if let Some(ref targets) = event.target_user_ids {
            // User-targeted events: fan out to each target user's live sessions.
            for &uid in targets {
                if let Some(user_sids) = self.user_sessions.get(&uid) {
                    for sid in user_sids.iter() {
                        // A missing session entry means a concurrent
                        // unregister_session is mid-flight (it removes the
                        // session record before the index entry); it will clean
                        // the index itself, so skip rather than reap here.
                        if let Some(sub) = self.sessions.get(sid) {
                            if sub.sender.send(event.clone()).is_err() {
                                stale.push(sid.clone());
                            } else {
                                delivered += 1;
                            }
                        }
                    }
                }
            }
        } else if let Some(guild_id) = event.guild_id {
            // Guild-scoped events: fan out to the guild's live sessions.
            if let Some(sids) = self.guild_sessions.get(&guild_id) {
                for sid in sids.iter() {
                    if let Some(sub) = self.sessions.get(sid) {
                        if sub.sender.send(event.clone()).is_err() {
                            stale.push(sid.clone());
                        } else {
                            delivered += 1;
                        }
                    }
                }
            }
        } else {
            // Global events: single pass over the session map, sending directly
            // instead of collecting every key into a Vec and re-looking each up.
            for entry in self.sessions.iter() {
                if entry.value().sender.send(event.clone()).is_err() {
                    stale.push(entry.key().clone());
                } else {
                    delivered += 1;
                }
            }
        }

        if observability::wire_trace_enabled() {
            let payload_bytes = event
                .serialized_payload
                .as_ref()
                .map(|serialized| serialized.len())
                .unwrap_or_else(|| {
                    serde_json::to_string(&*event.payload)
                        .map(|s| s.len())
                        .unwrap_or(0)
                });
            let scope = if event.target_user_ids.is_some() {
                "users"
            } else if event.guild_id.is_some() {
                "guild"
            } else {
                "global"
            };
            tracing::info!(
                target: "wire",
                kind = "event_bus_dispatch",
                event_type = %event.event_type,
                scope,
                guild_id = ?event.guild_id,
                target_user_count = event.target_user_ids.as_ref().map(|users| users.len()),
                session_count = delivered + stale.len(),
                payload_bytes,
                "server_out"
            );
        }

        if !stale.is_empty() {
            for sid in &stale {
                self.reap_stale_session(sid);
            }
            tracing::debug!(
                reaped = stale.len(),
                event_type = %event.event_type,
                "reaped stale gateway sessions during dispatch"
            );
        }
    }

    /// Drop a session whose channel has no receiver, provided it is still dead.
    /// The receiver-count re-check avoids reaping a session that resumed (and so
    /// re-registered a fresh receiver) in the window since the failed send.
    fn reap_stale_session(&self, session_id: &str) {
        let dead = match self.sessions.get(session_id) {
            Some(sub) => sub.sender.receiver_count() == 0,
            None => false,
        };
        if dead {
            self.unregister_session(session_id);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_event(guild_id: Option<i64>, target_user_ids: Option<Vec<i64>>) -> ServerEvent {
        ServerEvent {
            event_type: "TEST".to_string(),
            payload: Arc::new(serde_json::json!({})),
            guild_id,
            target_user_ids,
            serialized_payload: None,
        }
    }

    #[test]
    fn add_session_guild_on_unknown_session_creates_no_index_entry() {
        let bus = EventBus::new(16);

        // Session was never registered (or already unregistered).
        bus.add_session_guild("phantom-session", 42);

        assert!(
            bus.guild_sessions.get(&42).is_none(),
            "add_session_guild must not create a guild_sessions entry for an unknown session"
        );
        assert!(bus.sessions.get("phantom-session").is_none());
    }

    #[test]
    fn add_session_guild_after_unregister_leaves_no_phantom() {
        let bus = EventBus::new(16);
        let _rx = bus.register_session("s1", 100, &[1]);

        bus.unregister_session("s1");

        // A late add_session_guild (e.g. from an in-flight subscribe) must not
        // resurrect the guild index for a session that is gone.
        bus.add_session_guild("s1", 2);

        assert!(bus.guild_sessions.get(&1).is_none());
        assert!(bus.guild_sessions.get(&2).is_none());
    }

    #[test]
    fn unregister_clears_guild_and_user_indexes() {
        let bus = EventBus::new(16);
        let _rx = bus.register_session("s1", 100, &[1, 2]);
        bus.add_session_guild("s1", 3);

        assert_eq!(bus.guild_sessions.len(), 3);
        assert_eq!(bus.user_sessions.len(), 1);

        bus.unregister_session("s1");

        assert_eq!(
            bus.guild_sessions.len(),
            0,
            "all guild_sessions entries must be removed, including guilds added after registration"
        );
        assert_eq!(bus.user_sessions.len(), 0);
        assert_eq!(bus.sessions.len(), 0);
    }

    #[test]
    fn guild_scoped_publish_reaches_only_guild_sessions() {
        let bus = EventBus::new(16);
        let mut rx_in = bus.register_session("in", 1, &[10]);
        let mut rx_out = bus.register_session("out", 2, &[20]);

        bus.publish(test_event(Some(10), None));

        assert!(
            rx_in.try_recv().is_ok(),
            "guild member should receive event"
        );
        assert!(
            rx_out.try_recv().is_err(),
            "non-member should not receive guild-scoped event"
        );
    }

    #[test]
    fn user_targeted_publish_reaches_only_targeted_users() {
        let bus = EventBus::new(16);
        let mut rx_a = bus.register_session("a", 1, &[]);
        let mut rx_b = bus.register_session("b", 2, &[]);

        bus.publish(test_event(None, Some(vec![1])));

        assert!(
            rx_a.try_recv().is_ok(),
            "targeted user should receive event"
        );
        assert!(
            rx_b.try_recv().is_err(),
            "non-targeted user should not receive event"
        );
    }

    #[test]
    fn publish_reaps_session_whose_receiver_is_gone() {
        let bus = EventBus::new(16);
        let rx = bus.register_session("dead", 7, &[9]);

        // Gateway loop exited: the receiver is dropped but unregister has not
        // (yet) run. A publish must self-heal the leaked indexes.
        drop(rx);
        assert_eq!(bus.sessions.len(), 1);

        bus.publish(test_event(Some(9), None));

        assert!(bus.sessions.get("dead").is_none());
        assert!(bus.guild_sessions.get(&9).is_none());
        assert!(bus.user_sessions.get(&7).is_none());
    }

    #[test]
    fn global_publish_reaps_dead_sessions() {
        let bus = EventBus::new(16);
        let mut rx_live = bus.register_session("live", 1, &[]);
        let rx_dead = bus.register_session("dead", 2, &[]);
        drop(rx_dead);

        bus.publish(test_event(None, None));

        assert!(rx_live.try_recv().is_ok(), "live session should receive");
        assert!(bus.sessions.get("dead").is_none());
        assert!(bus.user_sessions.get(&2).is_none());
        assert!(bus.sessions.get("live").is_some());
    }

    #[test]
    fn add_session_guild_routes_publish_to_added_guild() {
        let bus = EventBus::new(16);
        let mut rx = bus.register_session("s1", 1, &[]);

        bus.add_session_guild("s1", 55);
        bus.publish(test_event(Some(55), None));

        assert!(
            rx.try_recv().is_ok(),
            "session should receive events for a dynamically added guild"
        );
    }
}
