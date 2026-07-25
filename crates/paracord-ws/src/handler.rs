use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use governor::clock::{Clock, DefaultClock};
use governor::{DefaultKeyedRateLimiter, Quota, RateLimiter};
use paracord_core::{observability, AppState};
use paracord_models::gateway::*;
use paracord_models::permissions::Permissions;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::num::NonZeroU32;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
use std::sync::{Arc, OnceLock};
use tokio::sync::Semaphore;
use tokio::time::{Duration, Instant};

use crate::compression::WsCompressor;
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
// Separate, much smaller budget for sockets that have not yet authenticated
// (sent IDENTIFY/RESUME). Kept well below the authenticated global cap so a flood
// of unauthenticated/stalling sockets can never starve authenticated users out of
// the global connection pool.
const WS_MAX_PREAUTH_CONNECTIONS_DEFAULT: usize = 512;
// Concurrent in-flight handshakes permitted from a single client IP. A normal
// handshake releases its slot within milliseconds (right after IDENTIFY), so this
// is generous for legitimate NAT'd clients while still bounding a single source.
const WS_MAX_PREAUTH_PER_IP_DEFAULT: usize = 32;
const WS_MAX_MESSAGES_PER_MINUTE_DEFAULT: u32 = 240;
const WS_MAX_PRESENCE_UPDATES_PER_MINUTE_DEFAULT: u32 = 60;
const WS_MAX_TYPING_EVENTS_PER_MINUTE_DEFAULT: u32 = 120;
const WS_MAX_VOICE_UPDATES_PER_MINUTE_DEFAULT: u32 = 60;

#[derive(Clone)]
struct CachedSession {
    user_id: i64,
    sequence: u64,
}

static SESSION_CACHE: OnceLock<moka::future::Cache<String, CachedSession>> = OnceLock::new();
static ACTIVE_CONNECTIONS: AtomicUsize = AtomicUsize::new(0);
static USER_CONNECTIONS: OnceLock<dashmap::DashMap<i64, usize>> = OnceLock::new();
/// Sockets that have upgraded but not yet authenticated (sent IDENTIFY/RESUME).
static PREAUTH_CONNECTIONS: AtomicUsize = AtomicUsize::new(0);
/// Concurrent in-flight (unauthenticated) handshakes per client IP.
static PREAUTH_IP_CONNECTIONS: OnceLock<dashmap::DashMap<String, usize>> = OnceLock::new();

struct BufferedEvent {
    sequence: u64,
    event_type: String,
    payload: Arc<Value>,
    timestamp: Instant,
}

static EVENT_BUFFERS: OnceLock<dashmap::DashMap<String, VecDeque<BufferedEvent>>> = OnceLock::new();

fn event_buffers() -> &'static dashmap::DashMap<String, VecDeque<BufferedEvent>> {
    EVENT_BUFFERS.get_or_init(|| {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(300));
            interval.tick().await; // skip immediate first tick
            loop {
                interval.tick().await;
                if let Some(buffers) = EVENT_BUFFERS.get() {
                    let keys: Vec<String> = buffers.iter().map(|r| r.key().clone()).collect();
                    for key in keys {
                        buffers.remove_if(&key, |_, buffer| {
                            buffer
                                .back()
                                .map_or(true, |e| e.timestamp.elapsed() > MAX_REPLAY_AGE)
                        });
                    }
                }
            }
        });
        dashmap::DashMap::new()
    })
}

const MAX_REPLAY_EVENTS: usize = 100;
// Keep buffered events replayable for as long as the resumed session stays in
// `SESSION_CACHE` (`SESSION_TTL_SECONDS`). If this were shorter, a client that
// resumes after the buffer window but within the session TTL would still find
// its `CachedSession` yet have no events to replay, forcing an unnecessary
// fall-back to a fresh IDENTIFY.
const MAX_REPLAY_AGE: Duration = Duration::from_secs(SESSION_TTL_SECONDS as u64);

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
    max_preauth_connections: usize,
    max_preauth_per_ip: usize,
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
        max_preauth_connections: env_usize(
            "PARACORD_WS_MAX_PREAUTH_CONNECTIONS",
            WS_MAX_PREAUTH_CONNECTIONS_DEFAULT,
        ),
        max_preauth_per_ip: env_usize(
            "PARACORD_WS_MAX_PREAUTH_PER_IP",
            WS_MAX_PREAUTH_PER_IP_DEFAULT,
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
    compressor: &WsCompressor,
    user_id: Option<i64>,
    session_id: Option<&str>,
    frame_type: &str,
    opcode: Option<u8>,
    event_type: Option<&str>,
    sequence: Option<u64>,
) -> Result<(), ()> {
    wire_log_ws_out(
        user_id, session_id, opcode, &payload, frame_type, event_type, sequence,
    );

    if let Some(result) = compressor.compress(&payload) {
        match result {
            Ok(compressed) => sender
                .send(Message::Binary(compressed.into()))
                .await
                .map_err(|_| ()),
            Err(e) => {
                tracing::warn!("zlib-stream compression failed, sending uncompressed: {e}");
                sender
                    .send(Message::Text(payload.into()))
                    .await
                    .map_err(|_| ())
            }
        }
    } else {
        sender
            .send(Message::Text(payload.into()))
            .await
            .map_err(|_| ())
    }
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
    preauth_acquired: bool,
    preauth_ip: Option<String>,
}

impl ConnectionGuard {
    fn new() -> Self {
        Self {
            user_id: None,
            global_acquired: false,
            preauth_acquired: false,
            preauth_ip: None,
        }
    }

    /// Release any held pre-authentication handshake slot (global + per-IP). Called
    /// on promotion to a real global slot and, defensively, again from `Drop`.
    fn release_preauth(&mut self) {
        if let Some(ip) = self.preauth_ip.take() {
            release_preauth_ip(&ip);
        }
        if self.preauth_acquired {
            self.preauth_acquired = false;
            PREAUTH_CONNECTIONS.fetch_sub(1, AtomicOrdering::SeqCst);
        }
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.release_preauth();
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

fn preauth_ip_connections() -> &'static dashmap::DashMap<String, usize> {
    PREAUTH_IP_CONNECTIONS.get_or_init(dashmap::DashMap::new)
}

/// Reserve a pre-authentication handshake slot for a freshly upgraded socket.
///
/// This is deliberately decoupled from `try_acquire_global_connection_slot`: an
/// unauthenticated socket only ever holds a pre-auth slot (bounded globally and
/// per-IP) and is promoted to a real global slot after IDENTIFY/RESUME succeeds.
/// That means a flood of sockets that never authenticate — or that stall for the
/// full identify timeout — cannot consume the authenticated global connection
/// pool. Returns `false` (and takes nothing) when either budget is exhausted.
fn try_acquire_preauth_slot(peer_ip: Option<&str>) -> bool {
    let limits = ws_limits();
    // Per-IP concurrent-handshake cap first, so a rejected acquisition never
    // touches the global counter.
    if let Some(ip) = peer_ip {
        let mut entry = preauth_ip_connections().entry(ip.to_string()).or_insert(0);
        if *entry >= limits.max_preauth_per_ip {
            return false;
        }
        *entry += 1;
    }
    let mut current = PREAUTH_CONNECTIONS.load(AtomicOrdering::SeqCst);
    loop {
        if current >= limits.max_preauth_connections {
            // Roll back the per-IP reservation we just took above.
            if let Some(ip) = peer_ip {
                release_preauth_ip(ip);
            }
            return false;
        }
        match PREAUTH_CONNECTIONS.compare_exchange(
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

fn release_preauth_ip(ip: &str) {
    if let Some(mut count) = preauth_ip_connections().get_mut(ip) {
        if *count <= 1 {
            drop(count);
            preauth_ip_connections().remove(ip);
        } else {
            *count -= 1;
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

/// User-level rate limiters shared across all connections for the same user.
/// This prevents users from bypassing rate limits by opening multiple tabs/connections.
struct UserRateLimits {
    /// General messages (any opcode except heartbeat): 240/min per user
    messages: DefaultKeyedRateLimiter<i64>,
    /// Presence updates: 60/min per user
    presence: DefaultKeyedRateLimiter<i64>,
    /// Typing events: 120/min per user
    typing: DefaultKeyedRateLimiter<i64>,
    /// Voice state updates: 60/min per user
    voice: DefaultKeyedRateLimiter<i64>,
}

static USER_RATE_LIMITS: OnceLock<UserRateLimits> = OnceLock::new();

fn user_rate_limits() -> &'static UserRateLimits {
    USER_RATE_LIMITS.get_or_init(|| {
        let limits = ws_limits();
        let rate_limits = UserRateLimits {
            messages: RateLimiter::keyed(Quota::per_minute(
                NonZeroU32::new(limits.max_messages_per_minute).unwrap(),
            )),
            presence: RateLimiter::keyed(Quota::per_minute(
                NonZeroU32::new(limits.max_presence_updates_per_minute).unwrap(),
            )),
            typing: RateLimiter::keyed(Quota::per_minute(
                NonZeroU32::new(limits.max_typing_events_per_minute).unwrap(),
            )),
            voice: RateLimiter::keyed(Quota::per_minute(
                NonZeroU32::new(limits.max_voice_updates_per_minute).unwrap(),
            )),
        };

        // Periodic cleanup of stale rate limiter entries to prevent unbounded memory growth.
        tokio::spawn(async {
            let mut interval = tokio::time::interval(Duration::from_secs(300));
            interval.tick().await; // skip immediate first tick
            loop {
                interval.tick().await;
                let rl = user_rate_limits();
                rl.messages.retain_recent();
                rl.presence.retain_recent();
                rl.typing.retain_recent();
                rl.voice.retain_recent();
                rl.messages.shrink_to_fit();
                rl.presence.shrink_to_fit();
                rl.typing.shrink_to_fit();
                rl.voice.shrink_to_fit();
                tracing::trace!("rate limiter cleanup: pruned stale entries");
            }
        });

        rate_limits
    })
}

impl UserRateLimits {
    /// Check if a message from the given user with the given opcode is allowed.
    /// Returns `Ok(())` if allowed, or `Err(retry_after_ms)` if rate limited.
    fn check(&self, user_id: i64, opcode: u8) -> Result<(), u64> {
        let clock = DefaultClock::default();
        let now = clock.now();

        // Check total message limit first
        if let Err(not_until) = self.messages.check_key(&user_id) {
            let wait = not_until.wait_time_from(now);
            return Err(wait.as_millis().max(1) as u64);
        }

        // Check per-opcode limits
        let not_until = match opcode {
            OP_PRESENCE_UPDATE => self.presence.check_key(&user_id).err(),
            OP_TYPING_START => self.typing.check_key(&user_id).err(),
            OP_VOICE_STATE_UPDATE => self.voice.check_key(&user_id).err(),
            _ => None,
        };

        if let Some(not_until) = not_until {
            let wait = not_until.wait_time_from(now);
            Err(wait.as_millis().max(1) as u64)
        } else {
            Ok(())
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

/// Load a user's friend ids from the DB (used to seed the per-session cache).
async fn load_friend_ids(state: &AppState, user_id: i64) -> Vec<i64> {
    paracord_db::relationships::get_friend_user_ids(&state.db, user_id)
        .await
        .unwrap_or_default()
}

/// Build the presence fan-out recipient set from the in-memory member index
/// plus an already-resolved friend list. No DB queries.
fn presence_recipient_ids(
    state: &AppState,
    user_id: i64,
    guild_ids: &[i64],
    friend_ids: &[i64],
) -> Vec<i64> {
    // In-memory lookup: zero DB queries for guild members.
    let mut recipients = state
        .member_index
        .get_presence_recipients(user_id, guild_ids);
    recipients.insert(user_id);
    recipients.extend(friend_ids.iter().copied());
    recipients.into_iter().collect()
}

/// Presence recipients for a live session, caching the friend list on the
/// session so repeated presence transitions don't re-query the DB. The cache is
/// invalidated when a relationship-change event is delivered to the session.
async fn session_presence_recipient_ids(state: &AppState, session: &mut Session) -> Vec<i64> {
    if session.friend_ids.is_none() {
        session.friend_ids = Some(load_friend_ids(state, session.user_id).await);
    }
    let friend_ids = session.friend_ids.as_deref().unwrap_or(&[]);
    presence_recipient_ids(state, session.user_id, &session.guild_ids, friend_ids)
}

fn extract_channel_id_from_event(event_type: &str, payload: &Value) -> Option<i64> {
    if let Some(raw) = payload.get("channel_id").and_then(|v| v.as_str()) {
        if let Ok(channel_id) = raw.parse::<i64>() {
            return Some(channel_id);
        }
    }

    // Voice-leave events carry a null `channel_id` (the user is no longer in any
    // channel) but retain `prior_channel_id`, the channel they departed, so the
    // per-channel VIEW_CHANNEL filter can still gate delivery. Without this,
    // leaves would fan out guild-wide, leaking presence in hidden voice channels
    // even though the matching join was correctly filtered.
    if let Some(raw) = payload.get("prior_channel_id").and_then(|v| v.as_str()) {
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

/// Derive the host advertised in native-media endpoints from the configured
/// public URL (scheme/port/path stripped), falling back to loopback when the
/// server has no public URL configured.
fn media_endpoint_host(public_url: Option<&str>) -> String {
    public_url
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(|url| {
            let no_scheme = url
                .trim_start_matches("https://")
                .trim_start_matches("http://");
            let host = no_scheme.split('/').next().unwrap_or(no_scheme);
            host.split(':').next().unwrap_or(host).to_string()
        })
        .filter(|host| !host.is_empty())
        .unwrap_or_else(|| "127.0.0.1".to_string())
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

pub async fn handle_connection(
    socket: WebSocket,
    state: AppState,
    compress: bool,
    stream_context: bool,
    peer_ip: Option<String>,
) {
    let compressor = if stream_context {
        WsCompressor::streaming()
    } else {
        WsCompressor::new(compress)
    };
    let mut connection_guard = ConnectionGuard::new();
    // Unauthenticated sockets only consume the small pre-auth budget (bounded
    // globally and per-IP). The authenticated global slot is taken later, once
    // IDENTIFY/RESUME succeeds, so anonymous floods can't exhaust it.
    if !try_acquire_preauth_slot(peer_ip.as_deref()) {
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
    connection_guard.preauth_acquired = true;
    connection_guard.preauth_ip = peer_ip;

    if compress {
        tracing::debug!(stream_context, "Client requested zlib-stream compression");
    }

    let (mut sender, mut receiver) = socket.split();

    // Send HELLO
    let hello_msg = format!(
        "{}{}{}",
        HELLO_MSG_PREFIX, HEARTBEAT_INTERVAL_MS, HELLO_MSG_SUFFIX
    );
    if send_ws_text_logged(
        &mut sender,
        hello_msg,
        &compressor,
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
    let (mut session, resumed, requested_seq) = match tokio::time::timeout(
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
                &compressor,
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

    // Client authenticated: promote from the pre-auth handshake budget to a real
    // authenticated global slot, then drop the pre-auth reservation.
    if !try_acquire_global_connection_slot() {
        let _ = send_ws_close_logged(
            &mut sender,
            1013,
            "Gateway is at connection capacity",
            Some(session.user_id),
            Some(session.session_id.as_str()),
            "capacity_close",
        )
        .await;
        return;
    }
    connection_guard.global_acquired = true;
    observability::ws_connection_open();
    connection_guard.release_preauth();

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
        // Send RESUMED first so the client knows the session was accepted
        let resumed_payload = json!({
            "op": OP_DISPATCH,
            "t": EVENT_RESUMED,
            "s": session.sequence,
            "d": { "session_id": &session.session_id }
        });
        if send_ws_text_logged(
            &mut sender,
            resumed_payload.to_string(),
            &compressor,
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

        // Replay missed events (collect into Vec first to avoid holding DashMap lock across .await)
        let events_to_replay: Vec<(u64, String, Arc<Value>)> = event_buffers()
            .get(&session.session_id)
            .map(|buffer| {
                buffer
                    .iter()
                    .filter(|e| e.sequence > requested_seq)
                    .map(|e| (e.sequence, e.event_type.clone(), e.payload.clone()))
                    .collect()
            })
            .unwrap_or_default();

        let mut replay_count: u64 = 0;
        for (seq, event_type, payload) in &events_to_replay {
            let gateway_msg = json!({
                "op": OP_DISPATCH,
                "t": event_type,
                "s": seq,
                "d": **payload
            });
            if send_ws_text_logged(
                &mut sender,
                gateway_msg.to_string(),
                &compressor,
                Some(session.user_id),
                Some(session.session_id.as_str()),
                "replay",
                Some(OP_DISPATCH),
                Some(event_type.as_str()),
                Some(*seq),
            )
            .await
            .is_ok()
            {
                replay_count += 1;
            } else {
                return;
            }
        }
        tracing::info!(
            session_id = %session.session_id,
            replayed_events = replay_count,
            "session resumed with event replay"
        );
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
                match state
                    .voice
                    .is_participant_in_livekit_room(vs.channel_id, vs.guild_id(), session.user_id)
                    .await
                {
                    Some(false) => {
                        let _ = paracord_db::voice_states::remove_voice_state(
                            &state.db,
                            session.user_id,
                            vs.guild_id(),
                        )
                        .await;
                        let _ = state.voice.leave_room(vs.channel_id, session.user_id).await;
                    }
                    Some(true) => {}
                    None => {
                        tracing::warn!(
                            "Skipping stale voice cleanup for user {} channel {} because LiveKit presence is unknown",
                            session.user_id,
                            vs.channel_id
                        );
                    }
                }
            }
        }

        // Send READY with full user data
        let user = paracord_db::users::get_user_by_id(&state.db, session.user_id)
            .await
            .ok()
            .flatten();

        // This is the connecting user's own account, so account-scoped fields
        // belong here. `flags` in particular gates admin UI: without it a cold
        // start that applies READY before the REST profile leaves an admin
        // looking like a normal user.
        let user_json = if let Some(u) = &user {
            json!({
                "id": u.id.to_string(),
                "username": u.username,
                "discriminator": u.discriminator,
                "avatar_hash": u.avatar_hash,
                "display_name": u.display_name,
                "flags": u.flags,
            })
        } else {
            json!({"id": session.user_id.to_string()})
        };

        // Snapshot of currently online users for building presence lists
        let online_snapshot: std::collections::HashSet<i64> = state
            .online_users
            .iter()
            .map(|entry| *entry.key())
            .collect();
        let presence_snapshot: std::collections::HashMap<i64, Value> = state
            .user_presences
            .iter()
            .map(|entry| (*entry.key(), entry.value().clone()))
            .collect();

        // Fetch guild data for READY with bounded concurrency.
        let sem = Arc::new(Semaphore::new(10));
        let ready_user_id = session.user_id;
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

                    // Only expose the voice roster of channels this user can view.
                    // The live voice-join path filters via can_receive_channel_event;
                    // apply the same VIEW_CHANNEL gate to the READY snapshot so a
                    // hidden voice channel's participant list is not leaked. Compute
                    // permissions once per distinct channel to bound extra queries.
                    let mut channel_visibility: std::collections::HashMap<i64, bool> =
                        std::collections::HashMap::new();
                    for vs in &voice_states {
                        if let std::collections::hash_map::Entry::Vacant(e) =
                            channel_visibility.entry(vs.channel_id)
                        {
                            let visible =
                                paracord_core::permissions::compute_channel_permissions_cached(
                                    &state.permission_cache,
                                    &state.db,
                                    gid,
                                    vs.channel_id,
                                    g.owner_id,
                                    ready_user_id,
                                )
                                .await
                                .map(|perms| perms.contains(Permissions::VIEW_CHANNEL))
                                .unwrap_or(false);
                            e.insert(visible);
                        }
                    }

                    // Build voice_states JSON
                    let voice_states_json: Vec<Value> = voice_states
                        .iter()
                        .filter(|vs| {
                            channel_visibility
                                .get(&vs.channel_id)
                                .copied()
                                .unwrap_or(false)
                        })
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

        // Consume a sequence number for READY so it doesn't collide with the
        // first dispatched event.  READY becomes s=1, the first real event s=2,
        // keeping every dispatched sequence unique and monotonic (otherwise the
        // first event would reuse s=1 and be silently dropped on resume).
        let ready_seq = session.next_sequence();
        let ready = json!({
            "op": OP_DISPATCH,
            "t": EVENT_READY,
            "s": ready_seq,
            "d": {
                "user": user_json,
                "guilds": guilds_json,
                "session_id": &session.session_id,
            }
        });
        if send_ws_text_logged(
            &mut sender,
            ready.to_string(),
            &compressor,
            Some(session.user_id),
            Some(session.session_id.as_str()),
            "ready",
            Some(OP_DISPATCH),
            Some(EVENT_READY),
            Some(ready_seq),
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
    state.presence_manager.cancel_offline(session_user_id);
    state.online_users.insert(session_user_id);
    let online_presence = {
        let existing = state
            .user_presences
            .get(&session_user_id)
            .map(|value| value.clone());
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
        .insert(session_user_id, online_presence.clone());

    // Publish presence only to users who share a guild or friendship edge.
    let online_recipient_ids = session_presence_recipient_ids(&state, &mut session).await;
    state
        .event_bus
        .dispatch_to_users(EVENT_PRESENCE_UPDATE, online_presence, online_recipient_ids);

    let session = run_session(sender, receiver, session, state.clone(), &compressor).await;

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
                    match state_clone
                        .voice
                        .is_participant_in_livekit_room(
                            voice_state.channel_id,
                            voice_state.guild_id(),
                            session_user_id,
                        )
                        .await
                    {
                        Some(true) => {
                            tracing::debug!(
                                "Gateway disconnect grace period: user {} still in LiveKit room for channel {}, keeping voice state",
                                session_user_id, voice_state.channel_id
                            );
                            continue;
                        }
                        None => {
                            tracing::warn!(
                                "Gateway disconnect grace period: LiveKit presence unknown for user {} channel {}, skipping cleanup",
                                session_user_id, voice_state.channel_id
                            );
                            continue;
                        }
                        Some(false) => {}
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
                            "prior_channel_id": voice_state.channel_id.to_string(),
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
        // Defer the offline transition through PresenceManager to avoid race
        // conditions where a reconnecting client briefly appears offline.
        let state_clone = state.clone();
        let guild_ids = session.guild_ids.clone();
        // Reuse the friend list already resolved during the session; fall back to
        // a DB load only if presence never transitioned while connected.
        let cached_friend_ids = session.friend_ids.clone();
        state
            .presence_manager
            .schedule_offline(session_user_id, async move {
                // Re-check connection count after the grace period — the user may
                // have reconnected during the delay.
                let still_offline = user_connections()
                    .get(&session_user_id)
                    .map(|c| *c)
                    .unwrap_or(0)
                    == 0;
                if !still_offline {
                    return;
                }

                state_clone.online_users.remove(&session_user_id);
                let offline_presence = default_presence_payload(session_user_id, "offline");
                state_clone
                    .user_presences
                    .insert(session_user_id, offline_presence.clone());

                let friend_ids = match cached_friend_ids {
                    Some(friend_ids) => friend_ids,
                    None => load_friend_ids(&state_clone, session_user_id).await,
                };
                let offline_presence_recipient_ids =
                    presence_recipient_ids(&state_clone, session_user_id, &guild_ids, &friend_ids);
                state_clone.event_bus.dispatch_to_users(
                    EVENT_PRESENCE_UPDATE,
                    offline_presence,
                    offline_presence_recipient_ids,
                );
            });
    }
}

#[doc(hidden)] // internal seam exposed for the crate's integration tests
pub async fn wait_for_identify_or_resume(
    receiver: &mut (impl StreamExt<Item = Result<Message, axum::Error>> + Unpin),
    state: &AppState,
) -> Option<(Session, bool, u64)> {
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
                                paracord_db::guilds::get_user_guilds(&state.db, claims.sub.into())
                                    .await
                                    .unwrap_or_default();
                            let guild_ids = guilds.iter().map(|g| g.id).collect();
                            let guild_owner_ids =
                                guilds.iter().map(|g| (g.id, g.owner_id)).collect();
                            let mut session = Session::new(claims.sub, guild_ids, guild_owner_ids);
                            session.auth_session_id = session_id.to_string();
                            return Some((session, false, 0));
                        }
                        if op == OP_RESUME as u64 {
                            let requested_session_id =
                                d.get("session_id").and_then(|v| v.as_str())?.to_string();
                            let requested_seq = d.get("seq").and_then(|v| v.as_u64()).unwrap_or(0);
                            if let Some(cached) = session_cache().get(&requested_session_id).await {
                                if cached.user_id == claims.sub {
                                    let mut can_replay = true;
                                    if cached.sequence > requested_seq {
                                        if let Some(buffer) =
                                            event_buffers().get(&requested_session_id)
                                        {
                                            if let Some(front) = buffer.front() {
                                                if front.sequence > requested_seq.saturating_add(1)
                                                {
                                                    can_replay = false;
                                                }
                                            } else {
                                                can_replay = false;
                                            }
                                        } else {
                                            can_replay = false;
                                        }
                                    }

                                    if can_replay {
                                        // Re-derive guild membership from current DB state rather
                                        // than trusting the cached snapshot: a user kicked/banned
                                        // while disconnected never processed remove_guild(), so the
                                        // cache would otherwise re-grant them the guild event
                                        // stream for the remainder of the session TTL. Only
                                        // session_id/sequence are kept from the cache (for replay
                                        // continuity).
                                        let guilds = paracord_db::guilds::get_user_guilds(
                                            &state.db,
                                            claims.sub.into(),
                                        )
                                        .await
                                        .unwrap_or_default();
                                        let guild_ids = guilds.iter().map(|g| g.id).collect();
                                        let guild_owner_ids =
                                            guilds.iter().map(|g| (g.id, g.owner_id)).collect();
                                        let mut resumed = Session::new(
                                            cached.user_id,
                                            guild_ids,
                                            guild_owner_ids,
                                        );
                                        resumed.session_id = requested_session_id;
                                        resumed.auth_session_id = session_id.to_string();
                                        resumed.sequence = cached.sequence.max(requested_seq);
                                        return Some((resumed, true, requested_seq));
                                    } else {
                                        let oldest_buffered = event_buffers()
                                            .get(&requested_session_id)
                                            .and_then(|b| b.front().map(|e| e.sequence));
                                        tracing::info!(
                                            session_id = %requested_session_id,
                                            client_seq = requested_seq,
                                            oldest_buffered = oldest_buffered,
                                            "replay gap too large, forcing re-identify"
                                        );
                                    }
                                }
                            }
                            // If resume can't be honored (cache miss/mismatch), fall back to a
                            // fresh session immediately so clients recover without an extra
                            // invalid-session reconnect cycle.
                            let guilds =
                                paracord_db::guilds::get_user_guilds(&state.db, claims.sub.into())
                                    .await
                                    .unwrap_or_default();
                            let guild_ids = guilds.iter().map(|g| g.id).collect();
                            let guild_owner_ids =
                                guilds.iter().map(|g| (g.id, g.owner_id)).collect();
                            let mut session = Session::new(claims.sub, guild_ids, guild_owner_ids);
                            session.auth_session_id = session_id.to_string();
                            return Some((session, false, 0));
                        }
                    }
                }
            }
        }
    }
    None
}

#[doc(hidden)] // internal seam exposed for the crate's integration tests
pub async fn run_session(
    mut sender: impl SinkExt<Message> + Unpin,
    mut receiver: impl StreamExt<Item = Result<Message, axum::Error>> + Unpin,
    mut session: Session,
    state: AppState,
    compressor: &WsCompressor,
) -> Session {
    let mut event_rx = state.event_bus.register_session(
        session.session_id.clone(),
        session.user_id,
        &session.guild_ids,
    );
    let heartbeat_timeout = Duration::from_millis(HEARTBEAT_TIMEOUT_MS);
    let rate_limits = user_rate_limits();
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
                        // Heartbeats are never rate limited
                        if opcode != OP_HEARTBEAT {
                            if let Err(retry_after_ms) = rate_limits.check(session.user_id, opcode) {
                                match opcode {
                                    OP_PRESENCE_UPDATE | OP_TYPING_START | OP_VOICE_STATE_UPDATE => {
                                        // Silent drop for high-frequency events
                                        tracing::debug!(
                                            user_id = session.user_id,
                                            opcode,
                                            "rate limited (silent drop)"
                                        );
                                        continue;
                                    }
                                    _ => {
                                        let error_payload = json!({
                                            "op": OP_DISPATCH,
                                            "t": "RATE_LIMIT",
                                            "d": {
                                                "retry_after": retry_after_ms,
                                                "type": "messages"
                                            }
                                        });
                                        let _ = send_ws_text_logged(
                                            &mut sender,
                                            error_payload.to_string(),
                                            compressor,
                                            Some(session.user_id),
                                            Some(session.session_id.as_str()),
                                            "rate_limit",
                                            Some(OP_DISPATCH),
                                            Some("RATE_LIMIT"),
                                            None,
                                        )
                                        .await;
                                        continue;
                                    }
                                }
                            }
                        }
                        if let Ok(payload) = parsed_payload {
                            handle_client_message(&payload, &mut sender, &mut session, &state, compressor).await;
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

                        // `should_receive_event` above already verified guild
                        // membership, so only the finer per-channel authorization
                        // check remains for channel-scoped events.
                        if let Some(guild_id) = event.guild_id {
                            if let Some(channel_id) =
                                extract_channel_id_from_event(&event.event_type, &event.payload)
                            {
                                if !can_receive_channel_event(&state, &session, guild_id, channel_id).await {
                                    continue;
                                }
                            }
                        }

                        // Relationship changes alter the friend set used for
                        // presence fan-out; drop the cache so it reloads lazily.
                        if event.event_type == EVENT_RELATIONSHIP_ADD
                            || event.event_type == EVENT_RELATIONSHIP_REMOVE
                        {
                            session.friend_ids = None;
                        }

                        // Dynamically update guild scope for this active session.
                        if event.event_type == "GUILD_MEMBER_ADD" {
                            if let Some(uid) = event.payload.get("user_id").and_then(|v| v.as_str()) {
                                if uid == session.user_id.to_string() {
                                    if let Some(gid) = event.payload.get("guild_id")
                                        .and_then(|v| v.as_str())
                                        .and_then(|s| s.parse::<i64>().ok())
                                    {
                                        if let Some(guild) = paracord_db::guilds::get_guild(&state.db, gid)
                                            .await
                                            .ok()
                                            .flatten()
                                        {
                                            session.add_guild(gid, guild.owner_id);
                                            state.event_bus.add_session_guild(&session.session_id, gid);
                                        }
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

                        // Buffer the event for potential replay
                        let mut buffer_entry = event_buffers().entry(session.session_id.clone()).or_default();
                        while buffer_entry.front().map(|e| e.timestamp.elapsed() > MAX_REPLAY_AGE).unwrap_or(false) {
                            buffer_entry.pop_front();
                        }
                        if buffer_entry.len() >= MAX_REPLAY_EVENTS {
                            buffer_entry.pop_front();
                        }
                        buffer_entry.push_back(BufferedEvent {
                            sequence: seq,
                            event_type: event.event_type.clone(),
                            payload: event.payload.clone(),
                            timestamp: Instant::now(),
                        });
                        drop(buffer_entry);

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
                            compressor,
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
                sequence: session.sequence,
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
    compressor: &WsCompressor,
) {
    let op = payload.get("op").and_then(|v| v.as_u64()).unwrap_or(255) as u8;

    match op {
        OP_HEARTBEAT => {
            let _ = send_ws_text_logged(
                sender,
                HEARTBEAT_ACK_MSG.to_string(),
                compressor,
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
                    .get(&session.user_id)
                    .map(|value| value.clone());
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
                    .insert(session.user_id, presence_payload.clone());

                let recipient_ids = session_presence_recipient_ids(state, session).await;
                state.event_bus.dispatch_to_users(
                    EVENT_PRESENCE_UPDATE,
                    presence_payload,
                    recipient_ids,
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
                            let perms = paracord_core::permissions::compute_channel_permissions(
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
                let self_video = d
                    .get("self_video")
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
                                "prior_channel_id": existing_state.channel_id.to_string(),
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
                        state
                            .voice
                            .update_self_video(channel_id, session.user_id, self_video)
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
                                "self_video": self_video,
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
        // ── Native media opcodes ──────────────────────────────────────────
        OP_MEDIA_CONNECT => {
            // Client requests a native media session. Respond with
            // OP_MEDIA_SESSION_DESC containing relay endpoint and peers.
            if let Some(ref native) = state.native_media {
                if let Some(d) = payload.get("d") {
                    let guild_id = d
                        .get("guild_id")
                        .and_then(|v| v.as_str())
                        .and_then(|s| s.parse::<i64>().ok());
                    let channel_id = d
                        .get("channel_id")
                        .and_then(|v| v.as_str())
                        .and_then(|s| s.parse::<i64>().ok());
                    if let (Some(guild_id), Some(channel_id)) = (guild_id, channel_id) {
                        // ── Permission checks (mirrors REST join_voice) ──
                        // 1. Verify guild membership
                        if paracord_core::permissions::ensure_guild_member(
                            &state.db,
                            guild_id,
                            session.user_id,
                        )
                        .await
                        .is_err()
                        {
                            tracing::warn!(
                                "OP_MEDIA_CONNECT denied: user {} not member of guild {}",
                                session.user_id,
                                guild_id
                            );
                            return;
                        }

                        // 2. Fetch channel and verify it is a voice/stage channel
                        let channel =
                            match paracord_db::channels::get_channel(&state.db, channel_id).await {
                                Ok(Some(ch)) => ch,
                                _ => {
                                    tracing::warn!(
                                        "OP_MEDIA_CONNECT denied: channel {} not found",
                                        channel_id
                                    );
                                    return;
                                }
                            };
                        if channel.channel_type != 2 && channel.channel_type != 13 {
                            tracing::warn!(
                                "OP_MEDIA_CONNECT denied: channel {} is not a voice channel (type {})",
                                channel_id,
                                channel.channel_type
                            );
                            return;
                        }

                        // 3. Compute channel permissions and require VIEW_CHANNEL + CONNECT.
                        // Prefer the owner cached on the session; fall back to a DB
                        // lookup when this session never learned it.
                        let resolved_owner_id =
                            match session.guild_owner_ids.get(&guild_id).copied() {
                                Some(owner_id) => owner_id,
                                None => paracord_db::guilds::get_guild(&state.db, guild_id)
                                    .await
                                    .ok()
                                    .flatten()
                                    .map(|g| g.owner_id)
                                    .unwrap_or(0),
                            };
                        let perms =
                            match paracord_core::permissions::compute_channel_permissions_cached(
                                &state.permission_cache,
                                &state.db,
                                guild_id,
                                channel_id,
                                resolved_owner_id,
                                session.user_id,
                            )
                            .await
                            {
                                Ok(p) => p,
                                Err(_) => {
                                    tracing::warn!(
                                    "OP_MEDIA_CONNECT denied: failed to compute permissions for user {} in channel {}",
                                    session.user_id,
                                    channel_id
                                );
                                    return;
                                }
                            };
                        if !perms.contains(Permissions::VIEW_CHANNEL)
                            || !perms.contains(Permissions::CONNECT)
                        {
                            tracing::warn!(
                                "OP_MEDIA_CONNECT denied: user {} lacks VIEW_CHANNEL or CONNECT for channel {}",
                                session.user_id,
                                channel_id
                            );
                            return;
                        }

                        let participant = paracord_relay::participant::MediaParticipant::new(
                            session.user_id,
                            session.session_id.clone(),
                        );
                        let room_id = native.rooms.get_or_create_room(guild_id, channel_id);
                        let _ = native.rooms.join_room(guild_id, channel_id, participant);

                        // Build peer list from current room participants
                        let peers: Vec<Value> = native
                            .rooms
                            .get_room(&room_id)
                            .map(|room| {
                                room.participants
                                    .values()
                                    .filter(|p| p.user_id != session.user_id)
                                    .map(|p| {
                                        json!({
                                            "user_id": p.user_id.to_string(),
                                            "public_addr": p.public_addr.map(|a| a.to_string()),
                                            "supports_p2p": p.public_addr.is_some(),
                                        })
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();

                        // Persist a voice state keyed to this gateway session so
                        // the issued media token resolves to an active room on
                        // the transport side (see `resolve_active_media_room`).
                        let _ = paracord_db::voice_states::upsert_voice_state(
                            &state.db,
                            session.user_id,
                            Some(guild_id),
                            channel_id,
                            &session.session_id,
                        )
                        .await;

                        // Issue a real media token (same claims/signing as the
                        // REST join path) and advertise the configured endpoints.
                        let port = state.config.native_media_port;
                        let host = media_endpoint_host(state.config.public_url.as_deref());
                        let media_room = format!("{}:{}", guild_id, channel_id);
                        let issued_at = chrono::Utc::now().timestamp();
                        let media_claims = json!({
                            "sub": session.user_id,
                            "sid": &session.session_id,
                            "session_id": &session.session_id,
                            // The native-media transport requires the login
                            // session id (auth_sid/auth_session_id) to verify
                            // the session is still active; the REST join path
                            // embeds the same claims. Without these, the
                            // tightened accept handlers reject the token.
                            "auth_sid": &session.auth_session_id,
                            "auth_session_id": &session.auth_session_id,
                            "room": &media_room,
                            "iat": issued_at,
                            "exp": issued_at + 86400,
                        });
                        let token = jsonwebtoken::encode(
                            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
                            &media_claims,
                            &jsonwebtoken::EncodingKey::from_secret(
                                state.config.jwt_secret.as_bytes(),
                            ),
                        )
                        .unwrap_or_default();
                        let desc = json!({
                            "relay_endpoint": format!("quic://{}:{}", host, port),
                            "wt_endpoint": format!("https://{}:{}/media", host, port),
                            "token": token,
                            "cert_hash": native.cert_hash,
                            "room_id": room_id,
                            "codecs": ["opus", "vp9"],
                            "peers": peers,
                        });
                        let response = json!({
                            "op": OP_MEDIA_SESSION_DESC,
                            "d": desc,
                        });
                        let _ = sender
                            .send(Message::Text(response.to_string().into()))
                            .await;
                    }
                }
            } else {
                tracing::debug!(
                    "OP_MEDIA_CONNECT from user {} but native media not enabled",
                    session.user_id
                );
            }
        }
        OP_MEDIA_KEY_ANNOUNCE => {
            // Client announces a new sender key. Relay to all other
            // participants in the same room via the event bus.
            if let Some(d) = payload.get("d") {
                if let Ok(announce) = serde_json::from_value::<MediaKeyAnnounce>(d.clone()) {
                    // Verify sender is in an active voice channel
                    let voice_state = paracord_db::voice_states::get_user_voice_state(
                        &state.db,
                        session.user_id,
                        None,
                    )
                    .await
                    .ok()
                    .flatten();
                    let Some(vs) = voice_state else {
                        tracing::warn!(
                            "OP_MEDIA_KEY_ANNOUNCE denied: user {} not in any voice channel",
                            session.user_id
                        );
                        return;
                    };

                    // Determine which users are in the same voice room
                    let room_user_ids: std::collections::HashSet<i64> =
                        if let Some(ref native) = state.native_media {
                            native
                                .rooms
                                .get_room_by_channel(vs.guild_id().unwrap_or(0), vs.channel_id)
                                .map(|room| room.user_ids().into_iter().collect())
                                .unwrap_or_default()
                        } else {
                            // Fallback: use DB voice states for same channel
                            paracord_db::voice_states::get_guild_voice_states(
                                &state.db,
                                vs.guild_id().unwrap_or(0),
                            )
                            .await
                            .unwrap_or_default()
                            .into_iter()
                            .filter(|s| s.channel_id == vs.channel_id)
                            .map(|s| s.user_id)
                            .collect()
                        };

                    // Deliver each per-recipient key, but only to users in the same room
                    for encrypted_key in &announce.encrypted_keys {
                        if !room_user_ids.contains(&encrypted_key.recipient_user_id) {
                            tracing::warn!(
                                "OP_MEDIA_KEY_ANNOUNCE: skipping recipient {} not in same voice room as sender {}",
                                encrypted_key.recipient_user_id,
                                session.user_id
                            );
                            continue;
                        }
                        let deliver = json!({
                            "op": OP_MEDIA_KEY_DELIVER,
                            "d": {
                                "sender_user_id": session.user_id.to_string(),
                                "epoch": announce.epoch,
                                "ciphertext": encrypted_key.ciphertext,
                            },
                        });
                        // Deliver each per-recipient encrypted key only to its
                        // intended recipient.  A guild-scoped dispatch would leak
                        // every participant's per-recipient ciphertext to every
                        // session in the guild.
                        state.event_bus.dispatch_to_users(
                            EVENT_MEDIA_KEY_DELIVER,
                            deliver,
                            vec![encrypted_key.recipient_user_id],
                        );
                    }
                }
            }
        }
        OP_MEDIA_SUBSCRIBE => {
            // Client subscribes to a peer's media tracks.
            // The relay manages subscription state internally.
            if state.native_media.is_some() {
                if let Some(d) = payload.get("d") {
                    if let Ok(sub) = serde_json::from_value::<MediaSubscribe>(d.clone()) {
                        tracing::debug!(
                            "User {} subscribes to user {} track {}",
                            session.user_id,
                            sub.user_id,
                            sub.track_type
                        );
                        // Subscription tracking is handled by the QUIC relay;
                        // this WS opcode is primarily for signaling intent.
                    }
                }
            }
        }
        OP_REQUEST_GUILD_MEMBERS => {
            if let Some(d) = payload.get("d") {
                let guild_id_str = d.get("guild_id").and_then(|v| v.as_str());
                let Some(guild_id_str) = guild_id_str else {
                    return;
                };
                let Some(guild_id) = guild_id_str.parse::<i64>().ok() else {
                    return;
                };

                // Ensure the requesting user is a member of the guild
                if !session.guild_ids.contains(&guild_id) {
                    return;
                }

                let query = d
                    .get("query")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let limit = d
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|n| n.min(1000) as i64)
                    .unwrap_or(1000);

                let members = if query.is_empty() {
                    paracord_db::members::get_guild_members(&state.db, guild_id, limit, None)
                        .await
                        .unwrap_or_default()
                } else {
                    paracord_db::members::search_guild_members(&state.db, guild_id, &query, limit)
                        .await
                        .unwrap_or_default()
                };

                let members_json: Vec<Value> = members
                    .iter()
                    .map(|m| {
                        json!({
                            "user_id": m.user_id.to_string(),
                            "guild_id": guild_id.to_string(),
                            "nick": m.nick,
                            "joined_at": m.joined_at.to_rfc3339(),
                            "deaf": m.deaf,
                            "mute": m.mute,
                            "communication_disabled_until": m.communication_disabled_until.map(|v| v.to_rfc3339()),
                            "user": {
                                "id": m.user_id.to_string(),
                                "username": m.username,
                                "discriminator": m.discriminator,
                                "avatar_hash": m.user_avatar_hash,
                                "flags": m.user_flags,
                                "bot": paracord_core::is_bot(m.user_flags),
                                "system": false,
                            }
                        })
                    })
                    .collect();

                session.sequence += 1;
                let chunk_payload = json!({
                    "op": OP_DISPATCH,
                    "t": EVENT_GUILD_MEMBERS_CHUNK,
                    "s": session.sequence,
                    "d": {
                        "guild_id": guild_id.to_string(),
                        "members": members_json,
                        "chunk_index": 0,
                        "chunk_count": 1,
                    }
                });
                let _ = send_ws_text_logged(
                    sender,
                    chunk_payload.to_string(),
                    compressor,
                    Some(session.user_id),
                    Some(session.session_id.as_str()),
                    "guild_members_chunk",
                    Some(OP_DISPATCH),
                    Some(EVENT_GUILD_MEMBERS_CHUNK),
                    Some(session.sequence),
                )
                .await;
            }
        }
        _ => {
            tracing::debug!("Unknown opcode {} from client {}", op, session.user_id);
        }
    }
}

// ── Test seams ─────────────────────────────────────────────────────────────
// The process-global session cache and event buffers are private, so the
// integration tests use these thin helpers to seed a resumable session. They do
// not change runtime behavior; production code never calls them.

#[doc(hidden)]
pub async fn test_insert_cached_session(
    session_id: String,
    user_id: i64,
    _guild_ids: Vec<i64>,
    _guild_owner_ids: HashMap<i64, i64>,
    sequence: u64,
) {
    session_cache()
        .insert(session_id, CachedSession { user_id, sequence })
        .await;
}

#[doc(hidden)]
pub fn test_push_buffered_event(session_id: &str, sequence: u64, event_type: &str, payload: Value) {
    event_buffers()
        .entry(session_id.to_string())
        .or_default()
        .push_back(BufferedEvent {
            sequence,
            event_type: event_type.to_string(),
            payload: Arc::new(payload),
            timestamp: Instant::now(),
        });
}

/// Exercise the per-user connection-slot guard from integration tests. Uses the
/// same global counter as production; tests must pass a unique `user_id` so their
/// bucket is isolated. Not part of the supported public API.
#[doc(hidden)]
pub fn test_acquire_user_connection_slot(user_id: i64) -> bool {
    try_acquire_user_connection_slot(user_id)
}

/// The configured per-user connection cap (so tests assert against the effective
/// limit rather than a hard-coded constant).
#[doc(hidden)]
pub fn test_max_connections_per_user() -> usize {
    ws_limits().max_connections_per_user
}

/// Exercise the pre-auth handshake budget (global + per-IP) from integration
/// tests. Tests must pass a unique `peer_ip` string so their per-IP bucket is
/// isolated, and release every granted slot. Not part of the supported public API.
#[doc(hidden)]
pub fn test_acquire_preauth_slot(peer_ip: &str) -> bool {
    try_acquire_preauth_slot(Some(peer_ip))
}

#[doc(hidden)]
pub fn test_release_preauth_slot(peer_ip: &str) {
    release_preauth_ip(peer_ip);
    PREAUTH_CONNECTIONS.fetch_sub(1, AtomicOrdering::SeqCst);
}

/// The configured per-IP pre-auth handshake cap.
#[doc(hidden)]
pub fn test_max_preauth_per_ip() -> usize {
    ws_limits().max_preauth_per_ip
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_join_channel_id_is_extracted_for_filtering() {
        let payload = json!({
            "user_id": "1",
            "channel_id": "42",
            "guild_id": "7",
        });
        assert_eq!(
            extract_channel_id_from_event(EVENT_VOICE_STATE_UPDATE, &payload),
            Some(42)
        );
    }

    #[test]
    fn voice_leave_resolves_prior_channel_id_for_view_filter() {
        // A leave carries a null `channel_id` but retains `prior_channel_id`.
        // The per-channel VIEW_CHANNEL filter must still resolve a channel so
        // leaves from hidden voice channels are not fanned out guild-wide.
        let payload = json!({
            "user_id": "1",
            "channel_id": Value::Null,
            "prior_channel_id": "42",
            "guild_id": "7",
        });
        assert_eq!(
            extract_channel_id_from_event(EVENT_VOICE_STATE_UPDATE, &payload),
            Some(42)
        );
    }

    #[test]
    fn non_voice_event_without_channel_ids_is_unfiltered() {
        let payload = json!({ "user_id": "1", "guild_id": "7" });
        assert_eq!(
            extract_channel_id_from_event("PRESENCE_UPDATE", &payload),
            None
        );
    }
}
