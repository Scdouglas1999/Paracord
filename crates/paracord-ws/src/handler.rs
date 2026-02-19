use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use paracord_core::{observability, AppState};
use paracord_models::gateway::*;
use paracord_models::permissions::Permissions;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
use std::sync::{Arc, OnceLock};
use tokio::sync::Semaphore;
use tokio::time::{Duration, Instant};

use crate::session::Session;

const HEARTBEAT_INTERVAL_MS: u64 = 41250;
const HEARTBEAT_TIMEOUT_MS: u64 = 90000;
const SESSION_TTL_SECONDS: i64 = 3600;
const HEARTBEAT_ACK_MSG: &str = r#"{"op":11}"#;
const HELLO_MSG_PREFIX: &str = r#"{"op":10,"d":{"heartbeat_interval":"#;
const HELLO_MSG_SUFFIX: &str = r#"}}"#;
const SESSION_CACHE_MAX_ENTRIES_DEFAULT: usize = 20_000;
const WS_MAX_GLOBAL_CONNECTIONS_DEFAULT: usize = 2_000;
const WS_MAX_CONNECTIONS_PER_USER_DEFAULT: usize = 5;
const WS_MAX_MESSAGES_PER_MINUTE_DEFAULT: u32 = 240;
const WS_MAX_PRESENCE_UPDATES_PER_MINUTE_DEFAULT: u32 = 60;
const WS_MAX_TYPING_EVENTS_PER_MINUTE_DEFAULT: u32 = 120;
const WS_MAX_VOICE_UPDATES_PER_MINUTE_DEFAULT: u32 = 60;

#[derive(Clone)]
#[allow(dead_code)]
struct CachedSession {
    user_id: i64,
    guild_ids: Vec<i64>,
    guild_owner_ids: HashMap<i64, i64>,
    sequence: u64,
    updated_at: i64,
}

static SESSION_CACHE: OnceLock<moka::future::Cache<String, CachedSession>> = OnceLock::new();
static ACTIVE_CONNECTIONS: AtomicUsize = AtomicUsize::new(0);
static USER_CONNECTIONS: OnceLock<dashmap::DashMap<i64, usize>> = OnceLock::new();

fn session_cache() -> &'static moka::future::Cache<String, CachedSession> {
    SESSION_CACHE.get_or_init(|| {
        moka::future::Cache::builder()
            .max_capacity(ws_limits().session_cache_max_entries as u64)
            .time_to_live(std::time::Duration::from_secs(SESSION_TTL_SECONDS as u64))
            .build()
    })
}

fn user_connections() -> &'static dashmap::DashMap<i64, usize> {
    USER_CONNECTIONS.get_or_init(dashmap::DashMap::new)
}

const MAX_ACTIVITY_ITEMS: usize = 8;
const MAX_ACTIVITY_TEXT_LEN: usize = 256;

#[derive(Clone, Copy)]
struct WsLimits {
    max_global_connections: usize,
    max_connections_per_user: usize,
    max_messages_per_minute: u32,
    max_presence_updates_per_minute: u32,
    max_typing_events_per_minute: u32,
    max_voice_updates_per_minute: u32,
    session_cache_max_entries: usize,
}

static WS_LIMITS: OnceLock<WsLimits> = OnceLock::new();

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(default)
}

fn env_u32(name: &str, default: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<u32>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(default)
}

fn ws_limits() -> WsLimits {
    *WS_LIMITS.get_or_init(|| WsLimits {
        max_global_connections: env_usize(
            "PARACORD_WS_MAX_CONNECTIONS",
            WS_MAX_GLOBAL_CONNECTIONS_DEFAULT,
        ),
        max_connections_per_user: env_usize(
            "PARACORD_WS_MAX_CONNECTIONS_PER_USER",
            WS_MAX_CONNECTIONS_PER_USER_DEFAULT,
        ),
        max_messages_per_minute: env_u32(
            "PARACORD_WS_MAX_MESSAGES_PER_MINUTE",
            WS_MAX_MESSAGES_PER_MINUTE_DEFAULT,
        ),
        max_presence_updates_per_minute: env_u32(
            "PARACORD_WS_MAX_PRESENCE_UPDATES_PER_MINUTE",
            WS_MAX_PRESENCE_UPDATES_PER_MINUTE_DEFAULT,
        ),
        max_typing_events_per_minute: env_u32(
            "PARACORD_WS_MAX_TYPING_EVENTS_PER_MINUTE",
            WS_MAX_TYPING_EVENTS_PER_MINUTE_DEFAULT,
        ),
        max_voice_updates_per_minute: env_u32(
            "PARACORD_WS_MAX_VOICE_UPDATES_PER_MINUTE",
            WS_MAX_VOICE_UPDATES_PER_MINUTE_DEFAULT,
        ),
        session_cache_max_entries: env_usize(
            "PARACORD_WS_SESSION_CACHE_MAX_ENTRIES",
            SESSION_CACHE_MAX_ENTRIES_DEFAULT,
        ),
    })
}

fn wire_log_ws_in(
    user_id: Option<i64>,
    session_id: Option<&str>,
    opcode: u8,
    payload: &str,
    frame_type: &str,
) {
    if !observability::wire_trace_enabled() {
        return;
    }
    let payload_preview = observability::wire_trace_payload_preview(payload);
    tracing::info!(
        target: "wire",
        transport = "gateway_ws",
        direction = "in",
        frame_type,
        user_id = ?user_id,
        session_id = ?session_id,
        opcode,
        bytes = payload.len(),
        payload_preview = ?payload_preview,
        "server_in"
    );
}

fn wire_log_ws_out(
    user_id: Option<i64>,
    session_id: Option<&str>,
    opcode: Option<u8>,
    payload: &str,
    frame_type: &str,
    event_type: Option<&str>,
    sequence: Option<u64>,
) {
    if !observability::wire_trace_enabled() {
        return;
    }
    let payload_preview = observability::wire_trace_payload_preview(payload);
    tracing::info!(
        target: "wire",
        transport = "gateway_ws",
        direction = "out",
        frame_type,
        user_id = ?user_id,
        session_id = ?session_id,
        opcode = ?opcode,
        event_type = ?event_type,
        sequence = ?sequence,
        bytes = payload.len(),
        payload_preview = ?payload_preview,
        "server_out"
    );
}

fn wire_log_ws_close(
    user_id: Option<i64>,
    session_id: Option<&str>,
    code: u16,
    reason: &str,
    frame_type: &str,
) {
    if !observability::wire_trace_enabled() {
        return;
    }
    tracing::info!(
        target: "wire",
        transport = "gateway_ws",
        direction = "out",
        frame_type,
        user_id = ?user_id,
        session_id = ?session_id,
        code,
        reason,
        "server_out"
    );
}

async fn send_ws_text_logged(
    sender: &mut (impl SinkExt<Message> + Unpin),
    payload: String,
    user_id: Option<i64>,
    session_id: Option<&str>,
    frame_type: &str,
    opcode: Option<u8>,
    event_type: Option<&str>,
    sequence: Option<u64>,
) -> Result<(), ()> {
    wire_log_ws_out(
        user_id,
        session_id,
        opcode,
        &payload,
        frame_type,
        event_type,
        sequence,
    );
    sender
        .send(Message::Text(payload.into()))
        .await
        .map_err(|_| ())
}

async fn send_ws_close_logged(
    sender: &mut (impl SinkExt<Message> + Unpin),
    code: u16,
    reason: &str,
    user_id: Option<i64>,
    session_id: Option<&str>,
    frame_type: &str,
) -> Result<(), ()> {
    wire_log_ws_close(user_id, session_id, code, reason, frame_type);
    sender
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.to_string().into(),
        })))
        .await
        .map_err(|_| ())
}

struct ConnectionGuard {
    user_id: Option<i64>,
    global_acquired: bool,
}

impl ConnectionGuard {
    fn new() -> Self {
        Self {
            user_id: None,
            global_acquired: false,
        }
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        if let Some(user_id) = self.user_id.take() {
            if let Some(mut count) = user_connections().get_mut(&user_id) {
                if *count <= 1 {
                    drop(count);
                    user_connections().remove(&user_id);
                } else {
                    *count -= 1;
                }
            }
        }
        if self.global_acquired {
            observability::ws_connection_close();
            ACTIVE_CONNECTIONS.fetch_sub(1, AtomicOrdering::SeqCst);
        }
    }
}

fn try_acquire_global_connection_slot() -> bool {
    let limits = ws_limits();
    let mut current = ACTIVE_CONNECTIONS.load(AtomicOrdering::SeqCst);
    loop {
        if current >= limits.max_global_connections {
            return false;
        }
        match ACTIVE_CONNECTIONS.compare_exchange(
            current,
            current + 1,
            AtomicOrdering::SeqCst,
            AtomicOrdering::SeqCst,
        ) {
            Ok(_) => return true,
            Err(observed) => current = observed,
        }
    }
}

fn try_acquire_user_connection_slot(user_id: i64) -> bool {
    let limits = ws_limits();
    let mut count = user_connections().entry(user_id).or_insert(0);
    if *count >= limits.max_connections_per_user {
        return false;
    }
    *count += 1;
    true
}

struct WsMessageRateLimiter {
    window_started_at: i64,
    total_messages: u32,
    presence_updates: u32,
    typing_events: u32,
    voice_updates: u32,
}

impl WsMessageRateLimiter {
    fn new() -> Self {
        Self {
            window_started_at: chrono::Utc::now().timestamp(),
            total_messages: 0,
            presence_updates: 0,
            typing_events: 0,
            voice_updates: 0,
        }
    }

    fn allow(&mut self, opcode: u8) -> bool {
        let now = chrono::Utc::now().timestamp();
        if now - self.window_started_at >= 60 {
            self.window_started_at = now;
            self.total_messages = 0;
            self.presence_updates = 0;
            self.typing_events = 0;
            self.voice_updates = 0;
        }

        self.total_messages += 1;
        let limits = ws_limits();
        if self.total_messages > limits.max_messages_per_minute {
            return false;
        }

        match opcode {
            OP_PRESENCE_UPDATE => {
                self.presence_updates += 1;
                self.presence_updates <= limits.max_presence_updates_per_minute
            }
            OP_TYPING_START => {
                self.typing_events += 1;
                self.typing_events <= limits.max_typing_events_per_minute
            }
            OP_VOICE_STATE_UPDATE => {
                self.voice_updates += 1;
                self.voice_updates <= limits.max_voice_updates_per_minute
            }
            _ => true,
        }
    }
}

fn truncate_for_presence(value: &str, max: usize) -> String {
    let mut out = String::new();
    for ch in value.chars().take(max) {
        out.push(ch);
    }
    out
}

fn normalize_status(raw: Option<&str>) -> &'static str {
    match raw.unwrap_or("online") {
        "online" => "online",
        "idle" => "idle",
        "dnd" => "dnd",
        "offline" => "offline",
        "invisible" => "offline",
        _ => "online",
    }
}

fn extract_activities(raw: Option<&Value>) -> Vec<Value> {
    let mut activities = Vec::new();
    let Some(Value::Array(list)) = raw else {
        return activities;
    };

    for entry in list.iter().take(MAX_ACTIVITY_ITEMS) {
        let Some(obj) = entry.as_object() else {
            continue;
        };
        let name = obj
            .get("name")
            .and_then(|v| v.as_str())
            .map(|s| truncate_for_presence(s, MAX_ACTIVITY_TEXT_LEN))
            .unwrap_or_else(|| "Unknown".to_string());
        let activity_type = obj
            .get("type")
            .or_else(|| obj.get("activity_type"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let details = obj
            .get("details")
            .and_then(|v| v.as_str())
            .map(|s| truncate_for_presence(s, MAX_ACTIVITY_TEXT_LEN));
        let state = obj
            .get("state")
            .and_then(|v| v.as_str())
            .map(|s| truncate_for_presence(s, MAX_ACTIVITY_TEXT_LEN));
        let started_at = obj
            .get("started_at")
            .and_then(|v| v.as_str())
            .map(|s| truncate_for_presence(s, MAX_ACTIVITY_TEXT_LEN));
        let application_id = obj
            .get("application_id")
            .and_then(|v| v.as_str())
            .map(|s| truncate_for_presence(s, MAX_ACTIVITY_TEXT_LEN));

        activities.push(json!({
            "name": name,
            "type": activity_type,
            "details": details,
            "state": state,
            "started_at": started_at,
            "application_id": application_id,
        }));
    }

    activities
}

fn build_presence_payload(
    user_id: i64,
    status: Option<&str>,
    activities: Option<&Value>,
    custom_status: Option<&str>,
) -> Value {
    json!({
        "user_id": user_id.to_string(),
        "status": normalize_status(status),
        "custom_status": custom_status.map(|v| truncate_for_presence(v, MAX_ACTIVITY_TEXT_LEN)),
        "activities": extract_activities(activities),
    })
}

fn default_presence_payload(user_id: i64, status: &str) -> Value {
    json!({
        "user_id": user_id.to_string(),
        "status": normalize_status(Some(status)),
        "custom_status": Value::Null,
        "activities": [],
    })
}

async fn collect_presence_recipient_ids(
    state: &AppState,
    user_id: i64,
    guild_ids: &[i64],
) -> Vec<i64> {
    let mut recipients: HashSet<i64> = HashSet::new();
    recipients.insert(user_id);

    for &guild_id in guild_ids {
        if let Ok(member_ids) =
            paracord_db::members::get_guild_member_user_ids(&state.db, guild_id).await
        {
            recipients.extend(member_ids);
        }
    }

    if let Ok(friend_ids) =
        paracord_db::relationships::get_friend_user_ids(&state.db, user_id).await
    {
        recipients.extend(friend_ids);
    }

    recipients.into_iter().collect()
}

fn extract_channel_id_from_event(event_type: &str, payload: &Value) -> Option<i64> {
    if let Some(raw) = payload.get("channel_id").and_then(|v| v.as_str()) {
        if let Ok(channel_id) = raw.parse::<i64>() {
            return Some(channel_id);
        }
    }

    if matches!(
        event_type,
        "CHANNEL_CREATE"
            | "CHANNEL_UPDATE"
            | "CHANNEL_DELETE"
            | "THREAD_CREATE"
            | "THREAD_UPDATE"
            | "THREAD_DELETE"
    ) {
        return payload
            .get("id")
            .and_then(|v| v.as_str())
            .and_then(|raw| raw.parse::<i64>().ok());
    }

    None
}

async fn can_receive_guild_event(_state: &AppState, session: &mut Session, guild_id: i64) -> bool {
    session.guild_ids.contains(&guild_id)
}

async fn can_receive_channel_event(
    state: &AppState,
    session: &Session,
    guild_id: i64,
    channel_id: i64,
) -> bool {
    let owner_id = match session.guild_owner_ids.get(&guild_id) {
        Some(&id) => id,
        None => return false,
    };

    let Ok(perms) = paracord_core::permissions::compute_channel_permissions_cached(
        &state.permission_cache,
        &state.db,
        guild_id,
        channel_id,
        owner_id,
        session.user_id,
    )
    .await
    else {
        return false;
    };

    perms.contains(Permissions::VIEW_CHANNEL)
}

pub async fn handle_connection(socket: WebSocket, state: AppState) {
    let mut connection_guard = ConnectionGuard::new();
    if !try_acquire_global_connection_slot() {
        let (mut sender, _) = socket.split();
        let _ = send_ws_close_logged(
            &mut sender,
            1013,
            "Gateway is at connection capacity",
            None,
            None,
            "capacity_close",
        )
        .await;
        return;
    }
    connection_guard.global_acquired = true;
    observability::ws_connection_open();

    let (mut sender, mut receiver) = socket.split();

    // Send HELLO
    let hello_msg = format!(
        "{}{}{}",
        HELLO_MSG_PREFIX, HEARTBEAT_INTERVAL_MS, HELLO_MSG_SUFFIX
    );
    if send_ws_text_logged(
        &mut sender,
        hello_msg,
        None,
        None,
        "hello",
        Some(OP_HELLO),
        None,
        None,
    )
    .await
    .is_err()
    {
        return;
    }

    // Wait for IDENTIFY (timeout 30s)
    let identify_timeout = Duration::from_secs(30);
    let (session, resumed) = match tokio::time::timeout(
        identify_timeout,
        wait_for_identify_or_resume(&mut receiver, &state),
    )
    .await
    {
        Ok(Some(result)) => result,
        _ => {
            let _ = send_ws_text_logged(
                &mut sender,
                json!({"op": OP_INVALID_SESSION, "d": false}).to_string(),
                None,
                None,
                "invalid_session",
                Some(OP_INVALID_SESSION),
                None,
                None,
            )
            .await;
            return;
        }
    };

    if !try_acquire_user_connection_slot(session.user_id) {
        let _ = send_ws_close_logged(
            &mut sender,
            1008,
            "Too many concurrent sessions for this user",
            Some(session.user_id),
            Some(session.session_id.as_str()),
            "user_capacity_close",
        )
        .await;
        return;
    }
    connection_guard.user_id = Some(session.user_id);

    if resumed {
        let resumed_payload = json!({
            "op": OP_DISPATCH,
            "t": EVENT_RESUMED,
            "s": session.sequence,
            "d": { "session_id": &session.session_id }
        });
        if send_ws_text_logged(
            &mut sender,
            resumed_payload.to_string(),
            Some(session.user_id),
            Some(session.session_id.as_str()),
            "resumed",
            Some(OP_DISPATCH),
            Some(EVENT_RESUMED),
            Some(session.sequence),
        )
        .await
        .is_err()
        {
            return;
        }
    } else {
        // Fresh IDENTIFY (not a resume) — the client just loaded, so any
        // voice state in the DB from a prior session is stale.  Clean it
        // up *before* building the READY payload so other clients don't
        // see ghost entries.
        if let Ok(stale) =
            paracord_db::voice_states::get_all_user_voice_states(&state.db, session.user_id).await
        {
            for vs in &stale {
                // Only clean up if they're not actually in the LiveKit room
                // (safety check in case of race with a concurrent join).
                if !state
                    .voice
                    .is_participant_in_livekit_room(vs.channel_id, vs.guild_id(), session.user_id)
                    .await
                {
                    let _ = paracord_db::voice_states::remove_voice_state(
                        &state.db,
                        session.user_id,
                        vs.guild_id(),
                    )
                    .await;
                    let _ = state.voice.leave_room(vs.channel_id, session.user_id).await;
                }
            }
        }

        // Send READY with full user data
        let user = paracord_db::users::get_user_by_id(&state.db, session.user_id)
            .await
            .ok()
            .flatten();

        let user_json = if let Some(u) = &user {
            json!({
                "id": u.id.to_string(),
                "username": u.username,
                "discriminator": u.discriminator,
                "avatar_hash": u.avatar_hash,
                "display_name": u.display_name,
            })
        } else {
            json!({"id": session.user_id.to_string()})
        };

        // Snapshot of currently online users for building presence lists
        let online_snapshot = state.online_users.read().await.clone();
        let presence_snapshot = state.user_presences.read().await.clone();

        // Fetch guild data for READY with bounded concurrency.
        let sem = Arc::new(Semaphore::new(10));
        let guild_futures: Vec<_> = session
            .guild_ids
            .iter()
            .map(|&gid| {
                let state = state.clone();
                let sem = sem.clone();
                let online_snapshot = online_snapshot.clone();
                let presence_snapshot = presence_snapshot.clone();
                async move {
                    let _permit = sem.acquire_owned().await.ok()?;
                    let guild = paracord_db::guilds::get_guild(&state.db, gid)
                        .await
                        .ok()
                        .flatten();
                    let Some(g) = guild else {
                        return None;
                    };

                    // Two independent queries in parallel
                    let (voice_states, member_ids) = tokio::join!(
                        paracord_db::voice_states::get_guild_voice_states(&state.db, gid),
                        paracord_db::members::get_guild_member_user_ids(&state.db, gid),
                    );

                    let voice_states = voice_states.unwrap_or_default();
                    let member_ids = member_ids.unwrap_or_default();

                    // Build voice_states JSON
                    let voice_states_json: Vec<Value> = voice_states
                        .iter()
                        .map(|vs| {
                            json!({
                                "user_id": vs.user_id.to_string(),
                                "channel_id": vs.channel_id.to_string(),
                                "guild_id": vs.guild_id().map(|id| id.to_string()),
                                "session_id": &vs.session_id,
                                "self_mute": vs.self_mute,
                                "self_deaf": vs.self_deaf,
                                "self_stream": vs.self_stream,
                                "self_video": vs.self_video,
                                "suppress": vs.suppress,
                                "mute": false,
                                "deaf": false,
                                "username": &vs.username,
                                "avatar_hash": &vs.avatar_hash,
                            })
                        })
                        .collect();

                    // Build presences from member IDs (lightweight query)
                    let presences_json: Vec<Value> = member_ids
                        .iter()
                        .filter(|uid| online_snapshot.contains(uid))
                        .map(|uid| {
                            presence_snapshot.get(uid).cloned().unwrap_or_else(|| {
                                json!({
                                    "user_id": uid.to_string(),
                                    "status": "online",
                                    "custom_status": Value::Null,
                                    "activities": [],
                                })
                            })
                        })
                        .collect();

                    Some(json!({
                        "id": g.id.to_string(),
                        "name": g.name,
                        "owner_id": g.owner_id.to_string(),
                        "icon_hash": g.icon_hash,
                        "member_count": member_ids.len(),
                        "channels": [],
                        "voice_states": voice_states_json,
                        "presences": presences_json,
                        "lazy": true,
                    }))
                }
            })
            .collect();

        let guild_results = futures_util::future::join_all(guild_futures).await;
        let guilds_json: Vec<Value> = guild_results.into_iter().flatten().collect();

        let ready = json!({
            "op": OP_DISPATCH,
            "t": EVENT_READY,
            "s": session.sequence.max(1),
            "d": {
                "user": user_json,
                "guilds": guilds_json,
                "session_id": &session.session_id,
            }
        });
        if send_ws_text_logged(
            &mut sender,
            ready.to_string(),
            Some(session.user_id),
            Some(session.session_id.as_str()),
            "ready",
            Some(OP_DISPATCH),
            Some(EVENT_READY),
            Some(session.sequence.max(1)),
        )
        .await
        .is_err()
        {
            return;
        }
    }

    // Save user_id before session is moved into run_session
    let session_user_id = session.user_id;

    // Track this user as online
    state.online_users.write().await.insert(session_user_id);
    let online_presence = {
        let existing = state
            .user_presences
            .read()
            .await
            .get(&session_user_id)
            .cloned();
        if let Some(mut value) = existing {
            if let Some(obj) = value.as_object_mut() {
                obj.insert("user_id".to_string(), json!(session_user_id.to_string()));
                obj.insert("status".to_string(), json!("online"));
                if !obj.contains_key("activities") {
                    obj.insert("activities".to_string(), json!([]));
                }
            }
            value
        } else {
            default_presence_payload(session_user_id, "online")
        }
    };
    state
        .user_presences
        .write()
        .await
        .insert(session_user_id, online_presence.clone());

    // Publish presence only to users who share a guild or friendship edge.
    let presence_recipient_ids =
        collect_presence_recipient_ids(&state, session_user_id, &session.guild_ids).await;
    state.event_bus.dispatch_to_users(
        EVENT_PRESENCE_UPDATE,
        online_presence,
        presence_recipient_ids,
    );

    let session = run_session(sender, receiver, session, state.clone()).await;

    // Voice cleanup: when the gateway WebSocket drops, don't remove voice
    // state immediately — the user may still be connected to LiveKit (their
    // media/WebRTC connection is independent of the gateway WS).  Wait a
    // grace period, then check LiveKit as ground truth before clearing.
    if let Ok(states) =
        paracord_db::voice_states::get_all_user_voice_states(&state.db, session_user_id).await
    {
        if !states.is_empty() {
            let state_clone = state.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(8)).await;

                let dc_user = paracord_db::users::get_user_by_id(&state_clone.db, session_user_id)
                    .await
                    .ok()
                    .flatten();

                // Re-fetch current voice states — they may have been cleared
                // by another code path (e.g. explicit leave) during the wait.
                let current_states = paracord_db::voice_states::get_all_user_voice_states(
                    &state_clone.db,
                    session_user_id,
                )
                .await
                .unwrap_or_default();

                for voice_state in current_states {
                    // Check LiveKit ground truth: is the user actually still
                    // connected to the media room?  If yes, keep the state.
                    if state_clone
                        .voice
                        .is_participant_in_livekit_room(
                            voice_state.channel_id,
                            voice_state.guild_id(),
                            session_user_id,
                        )
                        .await
                    {
                        tracing::debug!(
                            "Gateway disconnect grace period: user {} still in LiveKit room for channel {}, keeping voice state",
                            session_user_id, voice_state.channel_id
                        );
                        continue;
                    }

                    tracing::info!(
                        "Gateway disconnect grace period: user {} not in LiveKit room for channel {}, cleaning up",
                        session_user_id, voice_state.channel_id
                    );

                    let _ = paracord_db::voice_states::remove_voice_state(
                        &state_clone.db,
                        session_user_id,
                        voice_state.guild_id(),
                    )
                    .await;
                    if let Some(participants) = state_clone
                        .voice
                        .leave_room(voice_state.channel_id, session_user_id)
                        .await
                    {
                        if participants.is_empty() {
                            let _ = state_clone.voice.cleanup_room(voice_state.channel_id).await;
                        }
                    }
                    state_clone.event_bus.dispatch(
                        EVENT_VOICE_STATE_UPDATE,
                        json!({
                            "user_id": session_user_id.to_string(),
                            "channel_id": Value::Null,
                            "guild_id": voice_state.guild_id().map(|id| id.to_string()),
                            "self_mute": false,
                            "self_deaf": false,
                            "self_stream": false,
                            "self_video": false,
                            "suppress": false,
                            "mute": false,
                            "deaf": false,
                            "username": dc_user.as_ref().map(|u| u.username.as_str()),
                            "avatar_hash": dc_user.as_ref().and_then(|u| u.avatar_hash.as_deref()),
                        }),
                        voice_state.guild_id(),
                    );
                }
            });
        }
    }

    // Only mark offline when this was the user's last active gateway connection.
    // `USER_CONNECTIONS` still includes this connection until `connection_guard` drops,
    // so `<= 1` means no other live session remains.
    let should_mark_offline = {
        user_connections()
            .get(&session_user_id)
            .map(|c| *c)
            .unwrap_or(0)
            <= 1
    };

    if should_mark_offline {
        state.online_users.write().await.remove(&session_user_id);
        let offline_presence = default_presence_payload(session_user_id, "offline");
        state
            .user_presences
            .write()
            .await
            .insert(session_user_id, offline_presence.clone());

        // Publish offline presence to scoped recipients only.
        let offline_presence_recipient_ids =
            collect_presence_recipient_ids(&state, session_user_id, &session.guild_ids).await;
        state.event_bus.dispatch_to_users(
            EVENT_PRESENCE_UPDATE,
            offline_presence,
            offline_presence_recipient_ids,
        );
    }
}

async fn wait_for_identify_or_resume(
    receiver: &mut (impl StreamExt<Item = Result<Message, axum::Error>> + Unpin),
    state: &AppState,
) -> Option<(Session, bool)> {
    while let Some(Ok(msg)) = receiver.next().await {
        if let Message::Text(text) = msg {
            if let Ok(payload) = serde_json::from_str::<Value>(&text) {
                let op = payload.get("op").and_then(|v| v.as_u64()).unwrap_or(255) as u8;
                wire_log_ws_in(None, None, op, &text, "identify_or_resume");
            } else {
                wire_log_ws_in(None, None, 255, &text, "identify_or_resume");
            }
            if let Ok(payload) = serde_json::from_str::<Value>(&text) {
                if let Some(d) = payload.get("d") {
                    if let Some(token) = d.get("token").and_then(|v| v.as_str()) {
                        let claims =
                            paracord_core::auth::validate_token(token, &state.config.jwt_secret)
                                .ok()?;
                        let (session_id, jti) = match (claims.sid.as_deref(), claims.jti.as_deref())
                        {
                            (Some(session_id), Some(jti)) => (session_id, jti),
                            _ => return None,
                        };
                        let active = paracord_db::sessions::is_access_token_active(
                            &state.db,
                            claims.sub,
                            session_id,
                            jti,
                            chrono::Utc::now(),
                        )
                        .await
                        .ok()?;
                        if !active {
                            return None;
                        }
                        let op = payload.get("op").and_then(|v| v.as_u64())?;
                        if op == OP_IDENTIFY as u64 {
                            let guilds =
                                paracord_db::guilds::get_user_guilds(&state.db, claims.sub)
                                    .await
                                    .unwrap_or_default();
                            let guild_ids = guilds.iter().map(|g| g.id).collect();
                            let guild_owner_ids = guilds.iter().map(|g| (g.id, g.owner_id)).collect();
                            return Some((Session::new(claims.sub, guild_ids, guild_owner_ids), false));
                        }
                        if op == OP_RESUME as u64 {
                            let requested_session_id =
                                d.get("session_id").and_then(|v| v.as_str())?.to_string();
                            let requested_seq = d.get("seq").and_then(|v| v.as_u64()).unwrap_or(0);
                            if let Some(cached) = session_cache().get(&requested_session_id).await {
                                if cached.user_id == claims.sub {
                                    let mut resumed =
                                        Session::new(cached.user_id, cached.guild_ids.clone(), cached.guild_owner_ids.clone());
                                    resumed.session_id = requested_session_id;
                                    resumed.sequence = cached.sequence.max(requested_seq);
                                    return Some((resumed, true));
                                }
                            }
                            // If resume can't be honored (cache miss/mismatch), fall back to a
                            // fresh session immediately so clients recover without an extra
                            // invalid-session reconnect cycle.
                            let guilds =
                                paracord_db::guilds::get_user_guilds(&state.db, claims.sub)
                                    .await
                                    .unwrap_or_default();
                            let guild_ids = guilds.iter().map(|g| g.id).collect();
                            let guild_owner_ids = guilds.iter().map(|g| (g.id, g.owner_id)).collect();
                            return Some((Session::new(claims.sub, guild_ids, guild_owner_ids), false));
                        }
                    }
                }
            }
        }
    }
    None
}

async fn run_session(
    mut sender: impl SinkExt<Message> + Unpin,
    mut receiver: impl StreamExt<Item = Result<Message, axum::Error>> + Unpin,
    mut session: Session,
    state: AppState,
) -> Session {
    let mut event_rx = state.event_bus.register_session(
        session.session_id.clone(),
        session.user_id,
        &session.guild_ids,
    );
    let heartbeat_timeout = Duration::from_millis(HEARTBEAT_TIMEOUT_MS);
    let mut rate_limiter = WsMessageRateLimiter::new();
    let mut ws_ping_interval = tokio::time::interval(Duration::from_secs(20));
    ws_ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let heartbeat_sleep = tokio::time::sleep(heartbeat_timeout);
    tokio::pin!(heartbeat_sleep);

    let (disconnect_reason, heartbeat_timed_out) = loop {
        tokio::select! {
            msg = receiver.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let parsed_payload = serde_json::from_str::<Value>(&text);
                        let opcode = parsed_payload
                            .as_ref()
                            .ok()
                            .and_then(|payload| payload.get("op").and_then(|v| v.as_u64()))
                            .unwrap_or(255) as u8;
                        wire_log_ws_in(
                            Some(session.user_id),
                            Some(session.session_id.as_str()),
                            opcode,
                            &text,
                            "client_message",
                        );
                        if !rate_limiter.allow(opcode) {
                            let _ = send_ws_close_logged(
                                &mut sender,
                                1008,
                                "Gateway rate limit exceeded",
                                Some(session.user_id),
                                Some(session.session_id.as_str()),
                                "rate_limit_close",
                            )
                            .await;
                            break ("client exceeded websocket rate limits".to_string(), false);
                        }
                        if let Ok(payload) = parsed_payload {
                            handle_client_message(&payload, &mut sender, &mut session, &state).await;
                            if opcode == OP_HEARTBEAT {
                                heartbeat_sleep.as_mut().reset(Instant::now() + heartbeat_timeout);
                            }
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        break (
                            if let Some(frame) = frame {
                                format!(
                                    "client close frame (code={}, reason={})",
                                    u16::from(frame.code),
                                    frame.reason
                                )
                            } else {
                                "client close frame (no code/reason)".to_string()
                            },
                            false,
                        );
                    }
                    Some(Err(err)) => {
                        break (format!("websocket receive error: {err}"), false);
                    }
                    None => {
                        break ("websocket stream ended".to_string(), false);
                    }
                    _ => {}
                }
            }
            event = event_rx.recv() => {
                match event {
                    Ok(event) => {
                        if !session.should_receive_event(event.guild_id, event.target_user_ids.as_deref()) {
                            continue;
                        }

                        if let Some(guild_id) = event.guild_id {
                            if !can_receive_guild_event(&state, &mut session, guild_id).await {
                                continue;
                            }
                            if let Some(channel_id) =
                                extract_channel_id_from_event(&event.event_type, &event.payload)
                            {
                                if !can_receive_channel_event(&state, &session, guild_id, channel_id).await {
                                    continue;
                                }
                            }
                        }

                        // Dynamically update guild scope for this active session.
                        if event.event_type == "GUILD_MEMBER_ADD" {
                            if let Some(uid) = event.payload.get("user_id").and_then(|v| v.as_str()) {
                                if uid == session.user_id.to_string() {
                                    if let Some(gid) = event.payload.get("guild_id")
                                        .and_then(|v| v.as_str())
                                        .and_then(|s| s.parse::<i64>().ok())
                                    {
                                        let owner_id = paracord_db::guilds::get_guild(&state.db, gid)
                                            .await
                                            .ok()
                                            .flatten()
                                            .map(|g| g.owner_id)
                                            .unwrap_or(0);
                                        session.add_guild(gid, owner_id);
                                        state.event_bus.add_session_guild(&session.session_id, gid);
                                    }
                                }
                            }
                        } else if event.event_type == "GUILD_MEMBER_REMOVE" || event.event_type == "GUILD_BAN_ADD" {
                            if let Some(uid) = event.payload.get("user_id").and_then(|v| v.as_str()) {
                                if uid == session.user_id.to_string() {
                                    if let Some(gid) = event.payload.get("guild_id")
                                        .and_then(|v| v.as_str())
                                        .and_then(|s| s.parse::<i64>().ok())
                                    {
                                        session.remove_guild(gid);
                                        state
                                            .event_bus
                                            .remove_session_guild(&session.session_id, gid);
                                    }
                                }
                            }
                        } else if event.event_type == "GUILD_DELETE" {
                            if let Some(gid) = event.payload.get("id")
                                .or_else(|| event.payload.get("guild_id"))
                                .and_then(|v| v.as_str())
                                .and_then(|s| s.parse::<i64>().ok())
                            {
                                session.remove_guild(gid);
                                state
                                    .event_bus
                                    .remove_session_guild(&session.session_id, gid);
                            }
                        } else if event.event_type == "GUILD_UPDATE" {
                            if let Some(gid) = event.guild_id {
                                if let Some(new_owner) = event.payload.get("owner_id")
                                    .and_then(|v| v.as_str())
                                    .and_then(|s| s.parse::<i64>().ok())
                                {
                                    session.guild_owner_ids.insert(gid, new_owner);
                                }
                            }
                        }

                        let seq = session.next_sequence();
                        let dispatch_str = if let Some(ref pre) = event.serialized_payload {
                            format!(r#"{{"op":0,"t":"{}","s":{},"d":{}}}"#, event.event_type, seq, pre)
                        } else {
                            let dispatch = json!({
                                "op": OP_DISPATCH,
                                "t": event.event_type,
                                "s": seq,
                                "d": *event.payload,
                            });
                            dispatch.to_string()
                        };
                        if send_ws_text_logged(
                            &mut sender,
                            dispatch_str,
                            Some(session.user_id),
                            Some(session.session_id.as_str()),
                            "dispatch",
                            Some(OP_DISPATCH),
                            Some(event.event_type.as_str()),
                            Some(seq),
                        )
                        .await
                        .is_err()
                        {
                            break ("websocket send error".to_string(), false);
                        }
                        observability::ws_event_dispatched(&event.event_type);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(
                            "Gateway event stream lagged for user {} (missed {} events); forcing reconnect",
                            session.user_id,
                            skipped
                        );
                        let _ = send_ws_close_logged(
                            &mut sender,
                            1013,
                            "Gateway fell behind; reconnect required",
                            Some(session.user_id),
                            Some(session.session_id.as_str()),
                            "lagged_close",
                        )
                        .await;
                        break (format!("event stream lagged by {skipped} events"), false);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        break ("event stream closed".to_string(), false);
                    }
                }
            }
            () = &mut heartbeat_sleep => {
                break (
                    format!("heartbeat timeout after {}ms", HEARTBEAT_TIMEOUT_MS),
                    true,
                );
            }
            _ = ws_ping_interval.tick() => {
                if sender.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break ("websocket ping send error".to_string(), false);
                }
            }
        }
    };
    if heartbeat_timed_out {
        tracing::warn!(
            "Client {} disconnected: {}",
            session.user_id,
            disconnect_reason
        );
    } else {
        tracing::info!(
            "Client {} disconnected: {}",
            session.user_id,
            disconnect_reason
        );
    }
    state.event_bus.unregister_session(&session.session_id);
    session_cache()
        .insert(
            session.session_id.clone(),
            CachedSession {
                user_id: session.user_id,
                guild_ids: session.guild_ids.clone(),
                guild_owner_ids: session.guild_owner_ids.clone(),
                sequence: session.sequence,
                updated_at: chrono::Utc::now().timestamp(),
            },
        )
        .await;
    session
}

async fn handle_client_message(
    payload: &Value,
    sender: &mut (impl SinkExt<Message> + Unpin),
    session: &mut Session,
    state: &AppState,
) {
    let op = payload.get("op").and_then(|v| v.as_u64()).unwrap_or(255) as u8;

    match op {
        OP_HEARTBEAT => {
            let _ = send_ws_text_logged(
                sender,
                HEARTBEAT_ACK_MSG.to_string(),
                Some(session.user_id),
                Some(session.session_id.as_str()),
                "heartbeat_ack",
                Some(OP_HEARTBEAT_ACK),
                None,
                None,
            )
            .await;
        }
        OP_PRESENCE_UPDATE => {
            if let Some(d) = payload.get("d") {
                let existing_presence = state
                    .user_presences
                    .read()
                    .await
                    .get(&session.user_id)
                    .cloned();
                let status = d.get("status").and_then(|v| v.as_str());
                let custom_status = d.get("custom_status").and_then(|v| v.as_str()).or_else(|| {
                    existing_presence
                        .as_ref()
                        .and_then(|v| v.get("custom_status"))
                        .and_then(|v| v.as_str())
                });
                let activities = d
                    .get("activities")
                    .or_else(|| existing_presence.as_ref().and_then(|v| v.get("activities")));
                let effective_status = status.or_else(|| {
                    existing_presence
                        .as_ref()
                        .and_then(|v| v.get("status"))
                        .and_then(|v| v.as_str())
                });
                let presence_payload = build_presence_payload(
                    session.user_id,
                    effective_status,
                    activities,
                    custom_status,
                );
                state
                    .user_presences
                    .write()
                    .await
                    .insert(session.user_id, presence_payload.clone());

                let presence_recipient_ids =
                    collect_presence_recipient_ids(state, session.user_id, &session.guild_ids)
                        .await;
                state.event_bus.dispatch_to_users(
                    EVENT_PRESENCE_UPDATE,
                    presence_payload,
                    presence_recipient_ids,
                );
            }
        }
        OP_TYPING_START => {
            if let Some(d) = payload.get("d") {
                if let Some(channel_id_str) = d.get("channel_id").and_then(|v| v.as_str()) {
                    let Some(cid) = channel_id_str.parse::<i64>().ok() else {
                        return;
                    };
                    let Some(channel) = paracord_db::channels::get_channel(&state.db, cid)
                        .await
                        .ok()
                        .flatten()
                    else {
                        return;
                    };
                    let guild_id = channel.guild_id();

                    let allowed = if let Some(gid) = guild_id {
                        let member_ok = paracord_core::permissions::ensure_guild_member(
                            &state.db,
                            gid,
                            session.user_id,
                        )
                        .await
                        .is_ok();
                        if !member_ok {
                            false
                        } else if let Some(&owner_id) = session.guild_owner_ids.get(&gid) {
                            let perms =
                                paracord_core::permissions::compute_channel_permissions(
                                    &state.db,
                                    gid,
                                    cid,
                                    owner_id,
                                    session.user_id,
                                )
                                .await
                                .ok();
                            if let Some(perms) = perms {
                                perms.contains(Permissions::VIEW_CHANNEL)
                                    && perms.contains(Permissions::SEND_MESSAGES)
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    } else {
                        paracord_db::dms::is_dm_recipient(&state.db, cid, session.user_id)
                            .await
                            .unwrap_or(false)
                    };
                    if !allowed {
                        return;
                    }

                    let typing_payload = json!({
                        "channel_id": channel_id_str,
                        "user_id": session.user_id.to_string(),
                        "timestamp": chrono::Utc::now().timestamp(),
                    });

                    if guild_id.is_none() {
                        let recipient_ids = paracord_db::dms::get_dm_recipient_ids(&state.db, cid)
                            .await
                            .unwrap_or_default();
                        state.event_bus.dispatch_to_users(
                            EVENT_TYPING_START,
                            typing_payload,
                            recipient_ids,
                        );
                    } else {
                        state
                            .event_bus
                            .dispatch(EVENT_TYPING_START, typing_payload, guild_id);
                    }
                }
            }
        }
        OP_VOICE_STATE_UPDATE => {
            if let Some(d) = payload.get("d") {
                let self_mute = d
                    .get("self_mute")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let self_deaf = d
                    .get("self_deaf")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                let requested_guild_id = d
                    .get("guild_id")
                    .and_then(|v| v.as_str())
                    .and_then(|raw| raw.parse::<i64>().ok());

                let vs_user = paracord_db::users::get_user_by_id(&state.db, session.user_id)
                    .await
                    .ok()
                    .flatten();

                if d.get("channel_id").is_some() && d.get("channel_id").unwrap().is_null() {
                    // Explicit leave
                    let existing = paracord_db::voice_states::get_user_voice_state(
                        &state.db,
                        session.user_id,
                        requested_guild_id,
                    )
                    .await
                    .ok()
                    .flatten();
                    if let Some(existing_state) = existing {
                        let _ = paracord_db::voice_states::remove_voice_state(
                            &state.db,
                            session.user_id,
                            existing_state.guild_id(),
                        )
                        .await;
                        if let Some(participants) = state
                            .voice
                            .leave_room(existing_state.channel_id, session.user_id)
                            .await
                        {
                            if participants.is_empty() {
                                let _ = state.voice.cleanup_room(existing_state.channel_id).await;
                            }
                        }
                        state.event_bus.dispatch(
                            EVENT_VOICE_STATE_UPDATE,
                            json!({
                                "user_id": session.user_id.to_string(),
                                "channel_id": Value::Null,
                                "guild_id": existing_state.guild_id().map(|id| id.to_string()),
                                "self_mute": self_mute,
                                "self_deaf": self_deaf,
                                "self_stream": false,
                                "self_video": false,
                                "suppress": false,
                                "mute": false,
                                "deaf": false,
                                "username": vs_user.as_ref().map(|u| u.username.as_str()),
                                "avatar_hash": vs_user.as_ref().and_then(|u| u.avatar_hash.as_deref()),
                            }),
                            existing_state.guild_id(),
                        );
                    }
                } else if let Some(channel_id_str) = d.get("channel_id").and_then(|v| v.as_str()) {
                    if let Ok(channel_id) = channel_id_str.parse::<i64>() {
                        let channel = paracord_db::channels::get_channel(&state.db, channel_id)
                            .await
                            .ok()
                            .flatten();
                        let Some(channel) = channel else {
                            return;
                        };
                        if channel.channel_type != 2 {
                            return;
                        }
                        let guild_id = channel.guild_id();
                        let Some(guild_id) = guild_id else {
                            return;
                        };
                        if requested_guild_id.is_some() && requested_guild_id != Some(guild_id) {
                            return;
                        }

                        if paracord_core::permissions::ensure_guild_member(
                            &state.db,
                            guild_id,
                            session.user_id,
                        )
                        .await
                        .is_err()
                        {
                            return;
                        }
                        let Some(&owner_id) = session.guild_owner_ids.get(&guild_id) else {
                            return;
                        };
                        let Ok(perms) = paracord_core::permissions::compute_channel_permissions(
                            &state.db,
                            guild_id,
                            channel_id,
                            owner_id,
                            session.user_id,
                        )
                        .await
                        else {
                            return;
                        };
                        if !perms.contains(Permissions::VIEW_CHANNEL)
                            || !perms.contains(Permissions::CONNECT)
                        {
                            return;
                        }

                        let _ = paracord_db::voice_states::upsert_voice_state(
                            &state.db,
                            session.user_id,
                            Some(guild_id),
                            channel_id,
                            &session.session_id,
                        )
                        .await;
                        state
                            .voice
                            .update_self_mute(channel_id, session.user_id, self_mute)
                            .await;
                        state
                            .voice
                            .update_self_deaf(channel_id, session.user_id, self_deaf)
                            .await;

                        // Read actual self_stream from VoiceManager instead of hardcoding false
                        let current_self_stream = state
                            .voice
                            .get_participant_stream_state(channel_id, session.user_id)
                            .await;

                        state.event_bus.dispatch(
                            EVENT_VOICE_STATE_UPDATE,
                            json!({
                                "user_id": session.user_id.to_string(),
                                "channel_id": channel_id_str,
                                "guild_id": Some(guild_id.to_string()),
                                "self_mute": self_mute,
                                "self_deaf": self_deaf,
                                "self_stream": current_self_stream,
                                "self_video": false,
                                "suppress": false,
                                "mute": false,
                                "deaf": false,
                                "username": vs_user.as_ref().map(|u| u.username.as_str()),
                                "avatar_hash": vs_user.as_ref().and_then(|u| u.avatar_hash.as_deref()),
                            }),
                            Some(guild_id),
                        );
                    }
                }
            }
        }
        _ => {
            tracing::debug!("Unknown opcode {} from client {}", op, session.user_id);
        }
    }
}
