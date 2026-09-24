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

/// Report audiences are permission-filtered when dispatched, but that old
/// recipient list must not outlive a moderator's current authority.
pub fn requires_report_moderator(event_type: &str) -> bool {
    event_type.starts_with("GUILD_REPORT_")
}

/// User-targeted report dispatches carry their guild only in the payload.
/// Do not infer guild membership for personal notices such as a ban notice,
/// whose intended recipient may already have left the guild.
pub fn replay_guild_id(
    event_type: &str,
    payload: &serde_json::Value,
    guild_id: Option<i64>,
) -> Option<i64> {
    guild_id.or_else(|| {
        requires_report_moderator(event_type)
            .then(|| payload.get("guild_id")?.as_str()?.parse().ok())
            .flatten()
    })
}

/// Check current persisted access before replaying an event from a prior
/// connection. Cached permission allows and an old recipient list are not
/// sufficient after membership or channel visibility has been revoked.
pub async fn can_receive_replayed_event(
    pool: &paracord_db::DbPool,
    user_id: i64,
    event_type: &str,
    guild_id: Option<i64>,
    channel_id: Option<i64>,
    target_user_ids: Option<&[i64]>,
) -> bool {
    if target_user_ids.is_some_and(|targets| !targets.contains(&user_id)) {
        return false;
    }
    if requires_report_moderator(event_type) {
        let Some(guild_id) = guild_id else {
            return false;
        };
        let guild = match paracord_db::guilds::get_guild(pool, guild_id).await {
            Ok(Some(guild)) => guild,
            _ => return false,
        };
        if crate::permissions::ensure_guild_member(pool, guild_id, user_id)
            .await
            .is_err()
        {
            return false;
        }
        if !crate::permissions::compute_guild_permissions(pool, guild_id, guild.owner_id, user_id)
            .await
            .is_ok_and(crate::permissions::is_report_moderator)
        {
            return false;
        }
    }

    let channel = if let Some(channel_id) = channel_id {
        match paracord_db::channels::get_channel(pool, channel_id).await {
            Ok(Some(channel)) => Some(channel),
            _ => return false,
        }
    } else {
        None
    };
    let guild_id = guild_id.or_else(|| channel.as_ref().and_then(|c| c.guild_id()));
    if let Some(guild_id) = guild_id {
        if crate::permissions::ensure_guild_member(pool, guild_id, user_id)
            .await
            .is_err()
        {
            return false;
        }
        if let Some(channel) = &channel {
            if channel.guild_id() != Some(guild_id) {
                return false;
            }
            let guild = match paracord_db::guilds::get_guild(pool, guild_id).await {
                Ok(Some(guild)) => guild,
                _ => return false,
            };
            return crate::permissions::compute_channel_permissions(
                pool,
                guild_id,
                channel.id,
                guild.owner_id,
                user_id,
            )
            .await
            .is_ok_and(|perms| {
                perms.contains(paracord_models::permissions::Permissions::VIEW_CHANNEL)
            });
        }
    } else if let Some(channel) = channel {
        return paracord_db::dms::is_dm_recipient(pool, channel.id, user_id)
            .await
            .unwrap_or(false);
    }
    true
}

/// Per-session event queue depth used by [`EventBus::default`].
///
/// `tokio::sync::broadcast` allocates its whole ring up front, and
/// [`EventBus::register_session`] creates one channel per connection. Measured
/// on this `ServerEvent` (80 bytes) the ring costs ~105 bytes per slot, so the
/// previous 4096 reserved ~420 KiB for *every* socket — about 840 MB of empty
/// buffer at the gateway's 2000-connection cap, on a server that is meant to run
/// on modest hardware.
///
/// 1024 keeps ~104 KiB per socket (~208 MB at the cap) while still queuing ten
/// times the gateway's `MAX_REPLAY_EVENTS` (100) — a client that falls further
/// behind than that has to re-IDENTIFY on its next RESUME regardless, so the
/// extra depth bought nothing but memory. Overflow behavior is unchanged: the
/// receiver sees `RecvError::Lagged` and the gateway closes with 1013 so the
/// client reconnects and re-fetches. Raise with `PARACORD_EVENT_BUS_CAPACITY`
/// for deployments with unusually bursty guilds.
pub const DEFAULT_EVENT_BUS_CAPACITY: usize = 1024;

/// Resolve the configured per-session queue depth.
pub fn default_event_bus_capacity() -> usize {
    std::env::var("PARACORD_EVENT_BUS_CAPACITY")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_EVENT_BUS_CAPACITY)
}

/// Broadcast-based event bus for real-time dispatch.
#[derive(Clone)]
pub struct EventBus {
    capacity: usize,
    registration_lock: Arc<std::sync::Mutex<()>>,
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
            registration_lock: Arc::new(std::sync::Mutex::new(())),
            sessions: Arc::new(DashMap::new()),
            guild_sessions: Arc::new(DashMap::new()),
            user_sessions: Arc::new(DashMap::new()),
            system_sender,
        }
    }

    /// Publish a message mutation with committed, ordered channel activity.
    /// The message has already committed. A failed snapshot is logged and never
    /// replaced with a guessed tail; reconnect snapshots restore channel state.
    pub async fn dispatch_message(
        &self,
        pool: &paracord_db::DbPool,
        event_type: &str,
        payload: serde_json::Value,
        guild_id: Option<i64>,
    ) {
        match Self::message_payload(pool, event_type, payload).await {
            Ok(payload) => {
                let mentions = self
                    .message_mention_recipients(pool, event_type, &payload)
                    .await;
                self.dispatch(event_type, payload.clone(), guild_id);
                if !mentions.is_empty() {
                    self.dispatch_to_users(
                        "MESSAGE_MENTION",
                        serde_json::json!({
                            "channel_id": payload["channel_id"],
                            "message_id": payload["id"],
                            "channel_activity": payload["channel_activity"],
                        }),
                        mentions,
                    );
                }
            }
            Err(error) => {
                tracing::error!(event_type, %error, "failed to publish committed message activity")
            }
        }
    }

    pub async fn dispatch_message_to_users(
        &self,
        pool: &paracord_db::DbPool,
        event_type: &str,
        payload: serde_json::Value,
        user_ids: Vec<i64>,
    ) {
        match Self::message_payload(pool, event_type, payload).await {
            Ok(payload) => {
                let mut mentions = self
                    .message_mention_recipients(pool, event_type, &payload)
                    .await;
                mentions.retain(|id| user_ids.contains(id));
                self.dispatch_to_users(event_type, payload.clone(), user_ids);
                if !mentions.is_empty() {
                    self.dispatch_to_users(
                        "MESSAGE_MENTION",
                        serde_json::json!({
                            "channel_id": payload["channel_id"],
                            "message_id": payload["id"],
                            "channel_activity": payload["channel_activity"],
                        }),
                        mentions,
                    );
                }
            }
            Err(error) => {
                tracing::error!(event_type, %error, "failed to publish committed private message activity")
            }
        }
    }

    // The create producer decides whether the insert is new. Every new message
    // dispatch then uses its committed audience, including rich/system/federated
    // producers; edits never reconstruct or republish mentions.
    async fn message_mention_recipients(
        &self,
        pool: &paracord_db::DbPool,
        event_type: &str,
        payload: &serde_json::Value,
    ) -> Vec<i64> {
        if event_type != "MESSAGE_CREATE" {
            return Vec::new();
        }
        let parse_id = |key| {
            payload
                .get(key)
                .and_then(|id| id.as_str())
                .and_then(|id| id.parse::<i64>().ok())
        };
        let (Some(channel_id), Some(message_id)) = (parse_id("channel_id"), parse_id("id")) else {
            return Vec::new();
        };
        match paracord_db::messages::get_message_mention_recipients(pool, channel_id, message_id)
            .await
        {
            Ok(recipients) => recipients,
            Err(error) => {
                tracing::error!(channel_id, message_id, %error, "failed to publish committed mention audience");
                Vec::new()
            }
        }
    }

    async fn message_payload(
        pool: &paracord_db::DbPool,
        event_type: &str,
        mut payload: serde_json::Value,
    ) -> Result<serde_json::Value, crate::error::CoreError> {
        let channel_id = payload
            .get("channel_id")
            .and_then(|id| id.as_str())
            .and_then(|id| id.parse::<i64>().ok())
            .filter(|id| *id > 0)
            .ok_or_else(|| {
                crate::error::CoreError::Internal("Message event has an invalid channel ID".into())
            })?;
        if payload.get("message_revision").is_none()
            && matches!(event_type, "MESSAGE_CREATE" | "MESSAGE_DELETE")
        {
            let message_id = payload
                .get("id")
                .and_then(|id| id.as_str())
                .and_then(|id| id.parse::<i64>().ok());
            let revision = if let Some(message_id) = message_id {
                paracord_db::message_recovery::mutation_revision(
                    pool,
                    channel_id,
                    message_id,
                    if event_type == "MESSAGE_CREATE" {
                        "create"
                    } else {
                        "delete"
                    },
                )
                .await?
            } else {
                None
            };
            if let Some(revision) = revision {
                payload["message_revision"] = serde_json::json!(revision.to_string());
            } else {
                payload["recovery_required"] = serde_json::json!(true);
            }
        } else if (event_type == "MESSAGE_UPDATE" && payload.get("message_revision").is_none())
            || (event_type == "MESSAGE_DELETE_BULK" && payload.get("message_revisions").is_none())
        {
            // A delayed publisher can outlive the bounded archive. Never label
            // that mutation with the current channel head or guess its order.
            payload["recovery_required"] = serde_json::json!(true);
        }
        crate::message::prepare_message_event(pool, channel_id, payload).await
    }

    /// Per-session event queue depth this bus hands to `register_session`.
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn subscribe_system(&self) -> broadcast::Receiver<ServerEvent> {
        self.system_sender.subscribe()
    }

    /// Register (or re-register) a session and return its event receiver.
    ///
    /// Returns `None` when `session_id` is already registered to a *different*
    /// user. This id space is shared by the WebSocket gateway and the SSE
    /// transport, and session ids are disclosed to co-members (READY publishes
    /// every visible voice state's `session_id`), so a blind insert let anyone
    /// who learned another user's id re-point that id at their own receiver:
    /// `user_sessions` still listed the id under the original owner, so the
    /// victim's user-targeted events — DM `MESSAGE_CREATE` included — were then
    /// delivered to the claimant. Callers must treat `None` as "refuse the
    /// connection", never as "retry with the same id".
    ///
    /// The same user re-attaching (gateway RESUME, SSE reconnect) is allowed and
    /// replaces the previous registration; the old one is unregistered first so
    /// the guild/user indexes cannot retain entries from its guild set.
    pub fn register_session(
        &self,
        session_id: impl Into<String>,
        user_id: i64,
        guild_ids: &[i64],
    ) -> Option<broadcast::Receiver<ServerEvent>> {
        let _registration = self
            .registration_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let sid = session_id.into();
        // Bound to a local first: a `match` scrutinee's temporaries live for the
        // whole match, and holding a DashMap read guard across the
        // `unregister_session` (a write on the same shard) below would deadlock.
        let existing_owner = self.sessions.get(&sid).map(|sub| sub.user_id);
        match existing_owner {
            Some(owner) if owner != user_id => {
                tracing::warn!(
                    session_id = %sid,
                    owner_user_id = owner,
                    claimed_by_user_id = user_id,
                    "refused to re-register a session id owned by another user"
                );
                return None;
            }
            Some(_) => self.unregister_session_locked(&sid),
            None => {}
        }

        let (sender, receiver) = broadcast::channel(self.capacity.max(256));
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
        Some(receiver)
    }

    pub fn unregister_session(&self, session_id: &str) {
        let _registration = self
            .registration_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.unregister_session_locked(session_id);
    }

    /// An old transport may finish after the same session has reattached.
    /// Release only the registration that handed out this receiver.
    pub fn unregister_session_receiver(
        &self,
        session_id: &str,
        receiver: &broadcast::Receiver<ServerEvent>,
    ) -> bool {
        let _registration = self
            .registration_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let current = self
            .sessions
            .get(session_id)
            .is_some_and(|sub| sub.sender.subscribe().same_channel(receiver));
        if current {
            self.unregister_session_locked(session_id);
        }
        current
    }

    fn unregister_session_locked(&self, session_id: &str) {
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

    /// Bring every live session of `user_id` into `guild_id`'s fan-out scope.
    ///
    /// A session's guild set is a snapshot taken at IDENTIFY, and the only
    /// things that grew it were events the session had to already be in the
    /// guild to receive. So a guild created — or joined — *after* a client
    /// connected was in no session's set, and every guild-scoped event for it
    /// (`GUILD_CREATE` first of all, then channels, roles and member events)
    /// was published to an empty audience. The creator watched their own new
    /// server fail to appear until they relaunched.
    ///
    /// `MemberIndex` calls this whenever a membership is recorded, before the
    /// route dispatches the event that announces it, so the audience exists by
    /// the time it is published. Idempotent, and a no-op for a user with no
    /// live session.
    pub fn add_user_guild(&self, user_id: i64, guild_id: i64) {
        let session_ids: Vec<String> = match self.user_sessions.get(&user_id) {
            Some(sessions) => sessions.iter().cloned().collect(),
            None => return,
        };
        for session_id in session_ids {
            self.add_session_guild(&session_id, guild_id);
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
        Self::new(default_event_bus_capacity())
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
    fn old_transport_cleanup_cannot_unregister_reattached_session() {
        let bus = EventBus::new(16);
        let old = bus.register_session("reattached", 7, &[9]).unwrap();
        let mut replacement = bus.register_session("reattached", 7, &[9]).unwrap();
        assert!(!bus.unregister_session_receiver("reattached", &old));
        bus.publish(test_event(Some(9), None));
        assert!(replacement.try_recv().is_ok());
        assert!(bus.unregister_session_receiver("reattached", &replacement));
        assert!(bus.sessions.is_empty());
        assert!(bus.guild_sessions.is_empty());
        assert!(bus.user_sessions.is_empty());
    }

    // The restart notice the shutdown path publishes has no guild and no
    // targets. Every connected session must see it — including a session that
    // has joined no space at all, which is exactly the new account that would
    // otherwise watch its connection die with no explanation.
    #[test]
    fn a_global_dispatch_reaches_every_session_including_one_in_no_guild() {
        let bus = EventBus::new(16);
        let mut solitary = bus.register_session("no-guilds", 1, &[]).expect("register");
        let mut member = bus
            .register_session("in-a-guild", 2, &[9])
            .expect("register");

        bus.dispatch("SERVER_RESTART", serde_json::json!({}), None);

        for (label, receiver) in [
            ("session in no guild", &mut solitary),
            ("session in a guild", &mut member),
        ] {
            let event = receiver
                .try_recv()
                .unwrap_or_else(|error| panic!("{label} missed the notice: {error}"));
            assert_eq!(event.event_type, "SERVER_RESTART");
            assert!(event.guild_id.is_none());
            assert!(event.target_user_ids.is_none());
        }
    }

    // A guild created (or joined) after a client connected is in no session's
    // connect-time guild set, so a guild-scoped dispatch for it reached nobody:
    // the creator's own new server did not appear until they relaunched. The
    // membership index widens the fan-out through `add_user_guild` before the
    // route dispatches, so the audience exists by the time the event is
    // published.
    #[test]
    fn a_guild_gained_while_connected_joins_the_fan_out() {
        let bus = EventBus::new(16);
        let mut creator = bus.register_session("creator", 7, &[]).expect("register");
        let mut stranger = bus.register_session("stranger", 8, &[]).expect("register");

        let new_guild = 4242;
        bus.publish(test_event(Some(new_guild), None));
        assert!(
            creator.try_recv().is_err(),
            "a guild nobody is a member of has no audience"
        );

        bus.add_user_guild(7, new_guild);
        bus.publish(test_event(Some(new_guild), None));

        assert_eq!(
            creator.try_recv().expect("creator was told").guild_id,
            Some(new_guild)
        );
        assert!(
            stranger.try_recv().is_err(),
            "widening one user's scope must not widen anybody else's"
        );
    }

    // Every session of that user, not just the one that made the request: the
    // person creating a server on their desktop is often signed in on a phone
    // too.
    #[test]
    fn widening_a_users_scope_reaches_all_of_their_sessions() {
        let bus = EventBus::new(16);
        let mut desktop = bus.register_session("desktop", 7, &[]).expect("register");
        let mut phone = bus.register_session("phone", 7, &[]).expect("register");

        bus.add_user_guild(7, 4242);
        bus.publish(test_event(Some(4242), None));

        assert!(desktop.try_recv().is_ok());
        assert!(phone.try_recv().is_ok());
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
        let _rx = bus.register_session("s1", 100, &[1]).expect("register");

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
        let _rx = bus.register_session("s1", 100, &[1, 2]).expect("register");
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
        let mut rx_in = bus.register_session("in", 1, &[10]).expect("register");
        let mut rx_out = bus.register_session("out", 2, &[20]).expect("register");

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
        let mut rx_a = bus.register_session("a", 1, &[]).expect("register");
        let mut rx_b = bus.register_session("b", 2, &[]).expect("register");

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
        let rx = bus.register_session("dead", 7, &[9]).expect("register");

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
        let mut rx_live = bus.register_session("live", 1, &[]).expect("register");
        let rx_dead = bus.register_session("dead", 2, &[]).expect("register");
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
        let mut rx = bus.register_session("s1", 1, &[]).expect("register");

        bus.add_session_guild("s1", 55);
        bus.publish(test_event(Some(55), None));

        assert!(
            rx.try_recv().is_ok(),
            "session should receive events for a dynamically added guild"
        );
    }
}
