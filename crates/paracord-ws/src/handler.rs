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
/// Concurrent *authenticated* gateway connections permitted from one client IP.
///
/// The per-user cap only bounds a single account, so ~400 accounts sharing one
/// source could still fill the entire global pool; the gateway route is also
/// merged after `build_router()`'s layer stack, so no HTTP-level rate limit ever
/// sees it. 128 is 25 accounts at the per-user cap of 5 — far above any real
/// household or small office behind one NAT — and is raised with
/// `PARACORD_WS_MAX_CONNECTIONS_PER_IP` when a deployment legitimately needs more.
const WS_MAX_CONNECTIONS_PER_IP_DEFAULT: usize = 128;
/// Gateway upgrades accepted per minute from one client IP. Bounds the
/// connect/disconnect churn the missing HTTP middleware would otherwise have
/// limited: every cycle costs an upgrade, a HELLO and a fresh session. A client
/// connects once and RESUMEs, so even a NAT-wide reconnect storm stays far below
/// this.
const WS_MAX_HANDSHAKES_PER_MINUTE_PER_IP_DEFAULT: u32 = 120;
const WS_MAX_MESSAGES_PER_MINUTE_DEFAULT: u32 = 240;
/// Heartbeats (op 1) deliberately sit outside the general message budget — a
/// client that spends its 240/min elsewhere must still be able to keep the
/// socket alive — but they were previously not metered at all, so an authed
/// socket could spin op 1 as fast as it could write and get a parse plus an ACK
/// echo for each. The advertised interval is `HEARTBEAT_INTERVAL_MS` (~1.5/min),
/// so 120/min leaves roughly 80x headroom for jitter and immediate re-heartbeats.
const WS_MAX_HEARTBEATS_PER_MINUTE_DEFAULT: u32 = 120;
/// Per-connection budget for inbound non-Text frames (Ping/Pong/Binary). Nothing
/// in the gateway parses these, so they never reach the per-user opcode limiters,
/// yet each one still costs a frame decode and (for Ping) an automatic Pong.
/// The server pings every 20s (3/min) and clients answer in kind, so 240/min is
/// ~40x a legitimate client's control-frame rate.
const WS_MAX_CONTROL_FRAMES_PER_MINUTE_DEFAULT: u32 = 240;
/// Media sender-key announces per minute per user. A key rotation happens on
/// room membership changes, not continuously, so one every second is generous.
const WS_MAX_MEDIA_KEY_ANNOUNCES_PER_MINUTE_DEFAULT: u32 = 60;
/// `OP_REQUEST_GUILD_MEMBERS` responses per minute per user. Each one can read
/// and serialize up to 1000 member rows, which is far too expensive to leave on
/// the shared 240/min budget. A client requests a chunk when a member list is
/// opened, so 30/min (one every two seconds) covers normal browsing.
const WS_MAX_GUILD_MEMBER_REQUESTS_PER_MINUTE_DEFAULT: u32 = 30;
/// Frames a socket may send before it has authenticated. The identify handshake
/// needs exactly one; anything beyond this is a client that is spinning the
/// pre-auth loop (which parses JSON twice per frame) for the full 30s timeout.
const WS_MAX_PREAUTH_FRAMES_DEFAULT: u32 = 16;
/// How often a live gateway connection re-checks that the login session it
/// authenticated with is still active (not logged out, revoked or expired) and
/// that its access token has not expired.
///
/// A socket authenticates exactly once, in `wait_for_identify_or_resume`; before
/// this existed nothing revalidated it, so `POST /auth/logout`, a password
/// change and "revoke my other sessions" all left the socket delivering events
/// (including DMs) and accepting writes, long past the access token's own `exp`.
/// Matches the SSE transport's `STREAM_REVALIDATE_INTERVAL` so both realtime
/// transports drop a revoked session inside the same window.
const WS_SESSION_REVALIDATE_MS_DEFAULT: u64 = 60_000;
/// Consecutive revalidation *errors* (database unreachable, not a revoked
/// session) tolerated before the socket is closed anyway. A transient blip must
/// not disconnect every client, but a check that never succeeds must not keep
/// unauthenticated sockets alive indefinitely either.
const WS_MAX_REVALIDATION_FAILURES: u32 = 5;
/// Close code sent when revalidation fails. Matches the "authentication failed"
/// slot of the 4000-range gateway codes; the client reconnects and re-IDENTIFYs,
/// which re-runs the full token check.
const WS_CLOSE_AUTH_REVOKED: u16 = 4004;
const WS_MAX_PRESENCE_UPDATES_PER_MINUTE_DEFAULT: u32 = 60;
const WS_MAX_TYPING_EVENTS_PER_MINUTE_DEFAULT: u32 = 120;
const WS_MAX_VOICE_UPDATES_PER_MINUTE_DEFAULT: u32 = 60;
/// Hard ceiling on the per-recipient key list in one `OP_MEDIA_KEY_ANNOUNCE`.
///
/// The array was walked uncapped, emitting a log line *and* an event-bus publish
/// per element, so a single 32 KiB frame produced thousands of both. A legitimate
/// announce carries at most one key per other participant in the room, which the
/// relay already bounds by `native_media_max_participants`; this floor keeps the
/// check meaningful even when that setting is small or unset.
const WS_MEDIA_KEY_RECIPIENTS_FLOOR: usize = 64;
/// Window the per-connection non-Text frame budget is measured over.
const CONTROL_FRAME_WINDOW: Duration = Duration::from_secs(60);

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
/// Concurrent *authenticated* connections per client IP.
static IP_CONNECTIONS: OnceLock<dashmap::DashMap<String, usize>> = OnceLock::new();
/// Gateway upgrade attempts per client IP, used to bound connect/disconnect churn.
static IP_HANDSHAKE_LIMITER: OnceLock<DefaultKeyedRateLimiter<String>> = OnceLock::new();

struct BufferedEvent {
    sequence: u64,
    event_type: String,
    payload: Arc<Value>,
    timestamp: Instant,
}

/// Per-session replay buffer.
///
/// The buffer has to outlive its connection — RESUME replays the tail of events
/// that were dispatched but may not have reached the client before the socket
/// died — so it cannot simply be dropped on disconnect. Instead every buffer
/// records *when* its connection ended, which is what makes the map boundable:
/// live buffers are capped by `max_global_connections` (one per connection) and
/// disconnected buffers are capped explicitly by
/// `max_disconnected_event_buffers` and expire after
/// `DISCONNECTED_BUFFER_RETENTION`.
#[derive(Default)]
struct SessionEventBuffer {
    events: VecDeque<BufferedEvent>,
    /// `Some(when)` once the owning connection has ended, `None` while a
    /// connection is attached.
    disconnected_at: Option<Instant>,
}

static EVENT_BUFFERS: OnceLock<dashmap::DashMap<String, SessionEventBuffer>> = OnceLock::new();

fn event_buffers() -> &'static dashmap::DashMap<String, SessionEventBuffer> {
    EVENT_BUFFERS.get_or_init(|| {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(EVENT_BUFFER_SWEEP_INTERVAL);
            interval.tick().await; // skip immediate first tick
            loop {
                interval.tick().await;
                if let Some(buffers) = EVENT_BUFFERS.get() {
                    let keys: Vec<String> = buffers.iter().map(|r| r.key().clone()).collect();
                    for key in keys {
                        buffers.remove_if(&key, |_, buffer| {
                            // A buffer whose connection ended is only useful for
                            // the short window in which that client may RESUME.
                            if let Some(at) = buffer.disconnected_at {
                                if at.elapsed() > DISCONNECTED_BUFFER_RETENTION {
                                    return true;
                                }
                            }
                            buffer
                                .events
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

/// Mark a session's replay buffer as belonging to a connection that has ended,
/// dropping it outright when there is nothing left to replay, and enforce the
/// cap on retained disconnected buffers.
///
/// Without this, a single authenticated user could loop
/// connect -> self-addressed event -> disconnect and accumulate a buffer per
/// iteration; the old sweep only evicted a buffer once its *newest* event was an
/// hour old, and the map had no size cap at all.
fn release_event_buffer(session_id: &str) {
    let buffers = event_buffers();
    let mut nothing_to_replay = false;
    if let Some(mut buffer) = buffers.get_mut(session_id) {
        buffer.disconnected_at = Some(Instant::now());
        nothing_to_replay = buffer.events.is_empty();
    }
    if nothing_to_replay {
        buffers.remove_if(session_id, |_, buffer| {
            buffer.disconnected_at.is_some() && buffer.events.is_empty()
        });
        return;
    }

    // Bound the retained-disconnected set. Live buffers are already bounded by
    // the global connection cap, so only this population can grow.
    let max_disconnected = ws_limits().max_disconnected_event_buffers;
    let mut disconnected: Vec<(String, Instant)> = buffers
        .iter()
        .filter_map(|entry| {
            entry
                .value()
                .disconnected_at
                .map(|at| (entry.key().clone(), at))
        })
        .collect();
    if disconnected.len() <= max_disconnected {
        return;
    }
    // Oldest disconnect first, evict down to the cap.
    disconnected.sort_by_key(|(_, at)| *at);
    let overflow = disconnected.len() - max_disconnected;
    for (key, _) in disconnected.into_iter().take(overflow) {
        buffers.remove_if(&key, |_, buffer| buffer.disconnected_at.is_some());
    }
}

/// Clear the disconnect marker when a session is re-attached by RESUME, so the
/// buffer is treated as live again.
fn reattach_event_buffer(session_id: &str) {
    if let Some(mut buffer) = event_buffers().get_mut(session_id) {
        buffer.disconnected_at = None;
    }
}

/// How long a disconnected session's replay buffer is retained. A legitimate
/// client resumes within seconds; past this window the RESUME path already
/// degrades gracefully to a fresh IDENTIFY (`can_replay = false`).
const DISCONNECTED_BUFFER_RETENTION: Duration = Duration::from_secs(120);
const EVENT_BUFFER_SWEEP_INTERVAL: Duration = Duration::from_secs(60);
const WS_MAX_DISCONNECTED_EVENT_BUFFERS_DEFAULT: usize = 4_096;

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
    max_connections_per_ip: usize,
    max_handshakes_per_minute_per_ip: u32,
    max_messages_per_minute: u32,
    max_heartbeats_per_minute: u32,
    max_control_frames_per_minute: u32,
    max_presence_updates_per_minute: u32,
    max_typing_events_per_minute: u32,
    max_voice_updates_per_minute: u32,
    max_media_key_announces_per_minute: u32,
    max_guild_member_requests_per_minute: u32,
    session_cache_max_entries: usize,
    max_disconnected_event_buffers: usize,
    max_preauth_frames: u32,
    session_revalidate_ms: u64,
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

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
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
        max_connections_per_ip: env_usize(
            "PARACORD_WS_MAX_CONNECTIONS_PER_IP",
            WS_MAX_CONNECTIONS_PER_IP_DEFAULT,
        ),
        max_handshakes_per_minute_per_ip: env_u32(
            "PARACORD_WS_MAX_HANDSHAKES_PER_MINUTE_PER_IP",
            WS_MAX_HANDSHAKES_PER_MINUTE_PER_IP_DEFAULT,
        ),
        max_messages_per_minute: env_u32(
            "PARACORD_WS_MAX_MESSAGES_PER_MINUTE",
            WS_MAX_MESSAGES_PER_MINUTE_DEFAULT,
        ),
        max_heartbeats_per_minute: env_u32(
            "PARACORD_WS_MAX_HEARTBEATS_PER_MINUTE",
            WS_MAX_HEARTBEATS_PER_MINUTE_DEFAULT,
        ),
        max_control_frames_per_minute: env_u32(
            "PARACORD_WS_MAX_CONTROL_FRAMES_PER_MINUTE",
            WS_MAX_CONTROL_FRAMES_PER_MINUTE_DEFAULT,
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
        max_media_key_announces_per_minute: env_u32(
            "PARACORD_WS_MAX_MEDIA_KEY_ANNOUNCES_PER_MINUTE",
            WS_MAX_MEDIA_KEY_ANNOUNCES_PER_MINUTE_DEFAULT,
        ),
        max_guild_member_requests_per_minute: env_u32(
            "PARACORD_WS_MAX_GUILD_MEMBER_REQUESTS_PER_MINUTE",
            WS_MAX_GUILD_MEMBER_REQUESTS_PER_MINUTE_DEFAULT,
        ),
        session_cache_max_entries: env_usize(
            "PARACORD_WS_SESSION_CACHE_MAX_ENTRIES",
            SESSION_CACHE_MAX_ENTRIES_DEFAULT,
        ),
        max_disconnected_event_buffers: env_usize(
            "PARACORD_WS_MAX_DISCONNECTED_EVENT_BUFFERS",
            WS_MAX_DISCONNECTED_EVENT_BUFFERS_DEFAULT,
        ),
        max_preauth_frames: env_u32(
            "PARACORD_WS_MAX_PREAUTH_FRAMES",
            WS_MAX_PREAUTH_FRAMES_DEFAULT,
        ),
        session_revalidate_ms: env_u64(
            "PARACORD_WS_SESSION_REVALIDATE_MS",
            WS_SESSION_REVALIDATE_MS_DEFAULT,
        ),
    })
}

/// Sensitive keys that must never reach the wire trace, even truncated.
const REDACTED_GATEWAY_KEYS: [&str; 4] = ["token", "access_token", "refresh_token", "password"];

/// Produce a log-safe rendering of a client frame.
///
/// `observability::wire_trace_payload_preview` truncates and escapes but does
/// no key redaction, so logging an IDENTIFY frame verbatim wrote the raw access
/// token (`{"op":2,"d":{"token":"eyJ..."}}`) into the log. Replace the value of
/// every sensitive key before the frame is handed to the tracer. Frames that do
/// not parse as JSON are replaced wholesale rather than guessed at.
fn redact_gateway_credentials(parsed: Option<&Value>, raw: &str) -> String {
    fn redact(value: &mut Value) {
        match value {
            Value::Object(map) => {
                for (key, child) in map.iter_mut() {
                    if REDACTED_GATEWAY_KEYS
                        .iter()
                        .any(|needle| key.eq_ignore_ascii_case(needle))
                    {
                        *child = Value::String("[redacted]".to_string());
                    } else {
                        redact(child);
                    }
                }
            }
            Value::Array(items) => {
                for child in items.iter_mut() {
                    redact(child);
                }
            }
            _ => {}
        }
    }

    let Some(parsed) = parsed else {
        return "[unparsable frame redacted]".to_string();
    };
    let mut copy = parsed.clone();
    redact(&mut copy);
    // Only pay for the clone/serialize when a credential was actually present.
    if copy == *parsed {
        return raw.to_string();
    }
    copy.to_string()
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
                // Do NOT fall back to an uncompressed text frame. In
                // `Mode::Streaming` the deflate window persists across frames, so
                // skipping one desynchronises the client's single long-lived
                // inflate context and every subsequent binary frame decodes to
                // garbage — a silent, unrecoverable corruption. Close the socket
                // and make the client reconnect (which resets both contexts).
                tracing::error!("zlib-stream compression failed, closing connection: {e}");
                let _ = send_ws_close_logged(
                    sender,
                    1011,
                    "compression failure; reconnect required",
                    user_id,
                    session_id,
                    "compression_failure_close",
                )
                .await;
                Err(())
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
    /// Client IP holding an authenticated per-IP connection slot, if one was taken.
    connection_ip: Option<String>,
}

impl ConnectionGuard {
    fn new() -> Self {
        Self {
            user_id: None,
            global_acquired: false,
            preauth_acquired: false,
            preauth_ip: None,
            connection_ip: None,
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
        if let Some(ip) = self.connection_ip.take() {
            release_ip_connection(&ip);
        }
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

fn ip_connections() -> &'static dashmap::DashMap<String, usize> {
    IP_CONNECTIONS.get_or_init(dashmap::DashMap::new)
}

/// Whether per-IP gateway limits apply to this resolved client address.
///
/// Loopback is exempt on purpose. When a reverse proxy terminates on the same
/// host and `PARACORD_TRUST_PROXY`/`PARACORD_TRUSTED_PROXY_IPS` are not
/// configured, `client_ip` resolves *every* client to 127.0.0.1, so a per-IP cap
/// would silently become a cap on the whole server. Loopback is also never the
/// remote source these bounds exist to contain.
fn per_ip_limits_apply(ip: &str) -> bool {
    match ip.parse::<std::net::IpAddr>() {
        Ok(addr) => !addr.is_loopback(),
        // `normalize_for_rate_limit` emits `<prefix>/64` for IPv6 sources, which
        // does not parse as a bare address; those are always remote.
        Err(_) => true,
    }
}

/// Reserve an authenticated connection slot for a client IP.
///
/// Runs at IDENTIFY/RESUME time, after the pre-auth handshake slot has done its
/// job. `None` (no resolvable peer, e.g. tests driving the router directly) and
/// loopback are not metered; see `per_ip_limits_apply`.
fn try_acquire_ip_connection_slot(peer_ip: Option<&str>) -> bool {
    let Some(ip) = peer_ip.filter(|ip| per_ip_limits_apply(ip)) else {
        return true;
    };
    let limits = ws_limits();
    let mut entry = ip_connections().entry(ip.to_string()).or_insert(0);
    if *entry >= limits.max_connections_per_ip {
        return false;
    }
    *entry += 1;
    true
}

fn release_ip_connection(ip: &str) {
    if let Some(mut count) = ip_connections().get_mut(ip) {
        if *count <= 1 {
            drop(count);
            ip_connections().remove(ip);
        } else {
            *count -= 1;
        }
    }
}

fn ip_handshake_limiter() -> &'static DefaultKeyedRateLimiter<String> {
    IP_HANDSHAKE_LIMITER.get_or_init(|| {
        let quota = Quota::per_minute(
            NonZeroU32::new(ws_limits().max_handshakes_per_minute_per_ip)
                .expect("handshake quota is validated non-zero by env_u32"),
        );
        let limiter = RateLimiter::keyed(quota);

        // The keyed limiter allocates a bucket per source address; without this
        // the map would retain one entry per IP that has ever connected.
        tokio::spawn(async {
            let mut interval = tokio::time::interval(Duration::from_secs(300));
            interval.tick().await; // skip immediate first tick
            loop {
                interval.tick().await;
                let limiter = ip_handshake_limiter();
                limiter.retain_recent();
                limiter.shrink_to_fit();
            }
        });

        limiter
    })
}

/// Whether a gateway upgrade from this address is within the per-IP handshake
/// rate. `/gateway` is merged after `build_router()` has already baked in its
/// layer stack, so nothing at the HTTP level meters it; enforcing here also
/// survives any future re-ordering of that merge.
pub(crate) fn allow_gateway_handshake(peer_ip: Option<&str>) -> bool {
    let Some(ip) = peer_ip.filter(|ip| per_ip_limits_apply(ip)) else {
        return true;
    };
    ip_handshake_limiter().check_key(&ip.to_string()).is_ok()
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
    /// Heartbeats: 120/min per user. Deliberately a *separate* bucket from
    /// `messages` — a client that exhausts its general budget must still be able
    /// to keep its socket alive — but no longer an unmetered one.
    heartbeat: DefaultKeyedRateLimiter<i64>,
    /// Presence updates: 60/min per user
    presence: DefaultKeyedRateLimiter<i64>,
    /// Typing events: 120/min per user
    typing: DefaultKeyedRateLimiter<i64>,
    /// Voice state updates: 60/min per user
    voice: DefaultKeyedRateLimiter<i64>,
    /// Media sender-key announces: 60/min per user. Each one fans a per-recipient
    /// key out over the event bus, so it needs a tighter bound than `messages`.
    media_key: DefaultKeyedRateLimiter<i64>,
    /// Guild member chunk requests: 30/min per user. Each one can read and
    /// serialize up to 1000 member rows.
    guild_members: DefaultKeyedRateLimiter<i64>,
}

static USER_RATE_LIMITS: OnceLock<UserRateLimits> = OnceLock::new();

fn user_rate_limits() -> &'static UserRateLimits {
    USER_RATE_LIMITS.get_or_init(|| {
        let limits = ws_limits();
        let rate_limits = UserRateLimits {
            messages: RateLimiter::keyed(Quota::per_minute(
                NonZeroU32::new(limits.max_messages_per_minute).unwrap(),
            )),
            heartbeat: RateLimiter::keyed(Quota::per_minute(
                NonZeroU32::new(limits.max_heartbeats_per_minute).unwrap(),
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
            media_key: RateLimiter::keyed(Quota::per_minute(
                NonZeroU32::new(limits.max_media_key_announces_per_minute).unwrap(),
            )),
            guild_members: RateLimiter::keyed(Quota::per_minute(
                NonZeroU32::new(limits.max_guild_member_requests_per_minute).unwrap(),
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
                rl.heartbeat.retain_recent();
                rl.presence.retain_recent();
                rl.typing.retain_recent();
                rl.voice.retain_recent();
                rl.media_key.retain_recent();
                rl.guild_members.retain_recent();
                rl.messages.shrink_to_fit();
                rl.heartbeat.shrink_to_fit();
                rl.presence.shrink_to_fit();
                rl.typing.shrink_to_fit();
                rl.voice.shrink_to_fit();
                rl.media_key.shrink_to_fit();
                rl.guild_members.shrink_to_fit();
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
            OP_MEDIA_KEY_ANNOUNCE => self.media_key.check_key(&user_id).err(),
            OP_REQUEST_GUILD_MEMBERS => self.guild_members.check_key(&user_id).err(),
            _ => None,
        };

        if let Some(not_until) = not_until {
            let wait = not_until.wait_time_from(now);
            Err(wait.as_millis().max(1) as u64)
        } else {
            Ok(())
        }
    }

    /// Check the dedicated heartbeat budget. Kept off `check` because heartbeats
    /// must not draw on (or be starved by) the general message budget.
    fn check_heartbeat(&self, user_id: i64) -> Result<(), u64> {
        match self.heartbeat.check_key(&user_id) {
            Ok(()) => Ok(()),
            Err(not_until) => {
                let wait = not_until.wait_time_from(DefaultClock::default().now());
                Err(wait.as_millis().max(1) as u64)
            }
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

/// Apply the offline transition for a user and return the presence payload to
/// fan out.
///
/// The entry is *removed* from `user_presences` rather than overwritten with an
/// offline payload. Nothing ever evicted from that map, so it retained one JSON
/// value per user that had ever connected and grew without bound for the life of
/// the process. Removing is also behaviourally identical to what was stored:
/// READY only reads presences for users listed in `online_users`, and the
/// reconnect merge in `handle_connection` reconstructs exactly
/// `default_presence_payload(user, "online")` when the entry is absent — the
/// stored offline payload had already cleared `custom_status` and `activities`.
/// The map now tracks online users only, mirroring `online_users`.
fn mark_user_offline(state: &AppState, user_id: i64) -> Value {
    state.online_users.remove(&user_id);
    state.user_presences.remove(&user_id);
    default_presence_payload(user_id, "offline")
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
    // Kept for the authenticated per-IP cap taken after IDENTIFY; the pre-auth
    // reservation in the guard is released as soon as the socket authenticates.
    let authenticated_ip = peer_ip.clone();
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

    // Client authenticated: bound how much of the global pool one source address
    // may hold. The per-user cap alone lets a few hundred accounts behind one IP
    // consume every slot, and `/gateway` is merged outside the HTTP layer stack
    // so no middleware limits it either.
    if !try_acquire_ip_connection_slot(authenticated_ip.as_deref()) {
        tracing::warn!(
            peer_ip = ?authenticated_ip,
            limit = ws_limits().max_connections_per_ip,
            "gateway: refusing connection, per-IP connection cap reached. If this \
             server sits behind a reverse proxy, set PARACORD_TRUST_PROXY and \
             PARACORD_TRUSTED_PROXY_IPS so clients are bucketed by their real \
             address, or raise PARACORD_WS_MAX_CONNECTIONS_PER_IP"
        );
        let _ = send_ws_close_logged(
            &mut sender,
            1013,
            "Too many concurrent connections from this address",
            Some(session.user_id),
            Some(session.session_id.as_str()),
            "ip_capacity_close",
        )
        .await;
        return;
    }
    connection_guard.connection_ip = authenticated_ip;

    // Promote from the pre-auth handshake budget to a real authenticated global
    // slot, then drop the pre-auth reservation.
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
                    .events
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

        // Presence for READY is read straight out of the shared maps, one member
        // at a time. Snapshotting `online_users` and `user_presences` into owned
        // collections copied every presence payload on the server once, and then
        // copied *both* snapshots again for each of the user's guilds — so a
        // single connect allocated `guilds * total_users` JSON values before it
        // had looked at a single member.

        // Fetch guild data for READY with bounded concurrency.
        //
        // READY used to cost `3N + 2 + 2*voice` queries: a `get_guild` per guild
        // (already fetched and discarded at IDENTIFY), a member-id query per
        // guild (already held in `state.member_index`), and a voice-state query
        // per guild. With `Semaphore::new(10)` and a `tokio::join!` pair that
        // meant 20 concurrent queries per connect. Two of the three are now
        // gone, leaving one query per guild.
        let sem = Arc::new(Semaphore::new(10));
        let ready_user_id = session.user_id;
        let ready_guilds = std::mem::take(&mut session.ready_guilds);
        let guild_futures: Vec<_> = ready_guilds
            .iter()
            .map(|g| {
                let state = state.clone();
                let sem = sem.clone();
                let g = g.clone();
                async move {
                    let _permit = sem.acquire_owned().await.ok()?;
                    let gid = g.id;

                    let voice_states =
                        paracord_db::voice_states::get_guild_voice_states(&state.db, gid)
                            .await
                            .unwrap_or_default();
                    // Same in-memory source the presence fan-out already uses.
                    let member_ids = state.member_index.members_of(gid);

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

                    // Build presences from member IDs (lightweight query). Direct
                    // lookups only touch the members of this guild who are
                    // actually online; no guard is held across an await.
                    let presences_json: Vec<Value> = member_ids
                        .iter()
                        .filter(|uid| state.online_users.contains(uid))
                        .map(|uid| {
                            state
                                .user_presences
                                .get(uid)
                                .map(|entry| entry.value().clone())
                                .unwrap_or_else(|| {
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

                let offline_presence = mark_user_offline(&state_clone, session_user_id);

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

fn ready_guilds_from_rows(
    rows: &[paracord_db::guilds::SpaceRow],
) -> Vec<crate::session::ReadyGuild> {
    rows.iter()
        .map(|g| crate::session::ReadyGuild {
            id: g.id,
            name: g.name.clone(),
            owner_id: g.owner_id,
            icon_hash: g.icon_hash.clone(),
        })
        .collect()
}

#[doc(hidden)] // internal seam exposed for the crate's integration tests
pub async fn wait_for_identify_or_resume(
    receiver: &mut (impl StreamExt<Item = Result<Message, axum::Error>> + Unpin),
    state: &AppState,
) -> Option<(Session, bool, u64)> {
    // Frames on the pre-auth path are metered. Previously a frame without
    // `d.token` was simply ignored and the loop continued for the full 30s
    // identify timeout, parsing JSON twice per frame — free work for any
    // unauthenticated socket.
    let max_preauth_frames = ws_limits().max_preauth_frames;
    let mut preauth_frames: u32 = 0;
    while let Some(Ok(msg)) = receiver.next().await {
        // Count *every* frame, not just Text. The budget previously only saw
        // Text, so binary/ping frames were free and an unauthenticated socket
        // could still spin the pre-auth path for the whole 30s identify timeout.
        preauth_frames = preauth_frames.saturating_add(1);
        if preauth_frames > max_preauth_frames {
            tracing::debug!(
                frames = preauth_frames,
                "closing socket: too many frames before IDENTIFY/RESUME"
            );
            return None;
        }
        if let Message::Text(text) = msg {
            // Parse once, and never log the raw frame: IDENTIFY carries the
            // access token in `d.token` and the wire-trace preview truncates but
            // does not redact.
            let parsed = serde_json::from_str::<Value>(&text).ok();
            let op = parsed
                .as_ref()
                .and_then(|payload| payload.get("op").and_then(|v| v.as_u64()))
                .unwrap_or(255) as u8;
            wire_log_ws_in(
                None,
                None,
                op,
                &redact_gateway_credentials(parsed.as_ref(), &text),
                "identify_or_resume",
            );
            if let Some(payload) = parsed {
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
                        // Carried onto the session so the live loop can enforce
                        // the token's own lifetime; a socket must never outlive
                        // the credential that opened it.
                        let token_expires_at =
                            chrono::DateTime::<chrono::Utc>::from_timestamp(claims.exp as i64, 0);
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
                            session.token_expires_at = token_expires_at;
                            // Keep the rows we already paid for; READY reads
                            // them instead of re-fetching each guild.
                            session.ready_guilds = ready_guilds_from_rows(&guilds);
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
                                            if let Some(front) = buffer.events.front() {
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
                                        reattach_event_buffer(&requested_session_id);
                                        resumed.session_id = requested_session_id;
                                        resumed.auth_session_id = session_id.to_string();
                                        resumed.token_expires_at = token_expires_at;
                                        resumed.sequence = cached.sequence.max(requested_seq);
                                        return Some((resumed, true, requested_seq));
                                    } else {
                                        let oldest_buffered = event_buffers()
                                            .get(&requested_session_id)
                                            .and_then(|b| b.events.front().map(|e| e.sequence));
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
                            session.token_expires_at = token_expires_at;
                            session.ready_guilds = ready_guilds_from_rows(&guilds);
                            return Some((session, false, 0));
                        }
                    }
                }
            }
        }
    }
    None
}

/// Outcome of a periodic credential re-check on a live gateway connection.
enum CredentialCheck {
    /// The login session is still live and the access token has not expired.
    Active,
    /// The connection must be closed; the payload is the log/close reason.
    Terminate(&'static str),
    /// The check itself could not be completed (database error).
    Failed,
}

/// Re-verify the credential a live connection authenticated with.
///
/// Mirrors the SSE transport's `stream_should_terminate`: the login session must
/// still exist, belong to this user, and be neither revoked nor expired. The
/// access token's own `exp` is enforced as well, so a socket can never outlive
/// the token that opened it. The session's `current_jti` is deliberately *not*
/// compared — a token refresh rotates it, and a client refreshing its access
/// token must not have its gateway connection torn down for it.
async fn revalidate_session_credential(state: &AppState, session: &Session) -> CredentialCheck {
    let now = chrono::Utc::now();
    if let Some(expires_at) = session.token_expires_at {
        if now >= expires_at {
            return CredentialCheck::Terminate("access token expired");
        }
    }
    // Sessions built in-crate without a credential (tests) have nothing to
    // re-check against; every production session carries an `auth_session_id`
    // because IDENTIFY/RESUME refuses a token without `sid`/`jti`.
    if session.auth_session_id.is_empty() {
        return CredentialCheck::Active;
    }
    match paracord_db::sessions::get_session_by_id(&state.db, &session.auth_session_id).await {
        Ok(Some(row)) => {
            if row.user_id != session.user_id {
                CredentialCheck::Terminate("login session belongs to another user")
            } else if row.revoked_at.is_some() {
                CredentialCheck::Terminate("login session revoked")
            } else if row.expires_at <= now {
                CredentialCheck::Terminate("login session expired")
            } else {
                CredentialCheck::Active
            }
        }
        Ok(None) => CredentialCheck::Terminate("login session no longer exists"),
        Err(err) => {
            tracing::warn!(
                auth_session_id = %session.auth_session_id,
                "gateway: login session revalidation failed: {err}"
            );
            CredentialCheck::Failed
        }
    }
}

#[doc(hidden)] // internal seam exposed for the crate's integration tests
pub async fn run_session(
    mut sender: impl SinkExt<Message> + Unpin,
    mut receiver: impl StreamExt<Item = Result<Message, axum::Error>> + Unpin,
    mut session: Session,
    state: AppState,
    compressor: &WsCompressor,
) -> Session {
    let Some(mut event_rx) = state.event_bus.register_session(
        session.session_id.clone(),
        session.user_id,
        &session.guild_ids,
    ) else {
        // The id is already registered to a different user. Refuse rather than
        // take it over, and leave the incumbent registration untouched (so no
        // unregister/cache write on the way out).
        tracing::warn!(
            user_id = session.user_id,
            session_id = %session.session_id,
            "gateway: refusing session id already registered to another user"
        );
        let _ = send_ws_close_logged(
            &mut sender,
            WS_CLOSE_AUTH_REVOKED,
            "Session id is not available",
            Some(session.user_id),
            Some(session.session_id.as_str()),
            "session_id_conflict_close",
        )
        .await;
        return session;
    };
    let heartbeat_timeout = Duration::from_millis(HEARTBEAT_TIMEOUT_MS);
    let rate_limits = user_rate_limits();
    let mut ws_ping_interval = tokio::time::interval(Duration::from_secs(20));
    ws_ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let heartbeat_sleep = tokio::time::sleep(heartbeat_timeout);
    tokio::pin!(heartbeat_sleep);

    // Periodically re-check the credential this socket authenticated with. The
    // heartbeat timeout is the only other thing that can end an idle connection,
    // and the client resets that with every op 1, so without this a revoked
    // session kept its gateway forever.
    let revalidate_period = Duration::from_millis(ws_limits().session_revalidate_ms);
    let mut revalidate_interval =
        tokio::time::interval_at(Instant::now() + revalidate_period, revalidate_period);
    revalidate_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut revalidation_failures: u32 = 0;
    // Set when the loop ends because the credential is no longer valid, so the
    // teardown below can make sure the client cannot RESUME back into it.
    let mut credential_terminated = false;

    // Fixed-window budget for inbound non-Text frames. Per connection rather than
    // per user: these are transport-level frames, and a legitimate client emits
    // only the Pongs answering our 20s Ping plus any pings of its own.
    let control_frame_limit = ws_limits().max_control_frames_per_minute;
    let mut control_frames: u32 = 0;
    let mut control_window_start = Instant::now();

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
                            &redact_gateway_credentials(parsed_payload.as_ref().ok(), &text),
                            "client_message",
                        );
                        // Heartbeats keep their own budget so a client that has
                        // spent its general allowance can still hold the socket
                        // open, but they are no longer unmetered: op 1 costs a
                        // JSON parse and an ACK echo, and nothing bounded how
                        // fast a socket could ask for that.
                        if opcode == OP_HEARTBEAT {
                            if rate_limits.check_heartbeat(session.user_id).is_err() {
                                tracing::debug!(
                                    user_id = session.user_id,
                                    "heartbeat rate limited (silent drop)"
                                );
                                continue;
                            }
                        } else if let Err(retry_after_ms) = rate_limits.check(session.user_id, opcode) {
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
                    Some(Ok(_control_or_binary)) => {
                        // Ping/Pong/Binary. The gateway does not parse or answer
                        // these itself, so the per-user opcode limiters never see
                        // them — but each still costs a frame decode, and the
                        // websocket layer answers every Ping with a Pong. Meter
                        // them per connection so a socket cannot buy unbounded
                        // work by simply not sending Text.
                        if control_window_start.elapsed() >= CONTROL_FRAME_WINDOW {
                            control_window_start = Instant::now();
                            control_frames = 0;
                        }
                        control_frames = control_frames.saturating_add(1);
                        if control_frames > control_frame_limit {
                            let _ = send_ws_close_logged(
                                &mut sender,
                                1008,
                                "Too many control frames",
                                Some(session.user_id),
                                Some(session.session_id.as_str()),
                                "control_frame_flood_close",
                            )
                            .await;
                            break (
                                format!(
                                    "control frame flood: {control_frames} non-text frames within \
                                     {}s (limit {control_frame_limit})",
                                    CONTROL_FRAME_WINDOW.as_secs()
                                ),
                                false,
                            );
                        }
                    }
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
                        buffer_entry.disconnected_at = None;
                        while buffer_entry.events.front().map(|e| e.timestamp.elapsed() > MAX_REPLAY_AGE).unwrap_or(false) {
                            buffer_entry.events.pop_front();
                        }
                        if buffer_entry.events.len() >= MAX_REPLAY_EVENTS {
                            buffer_entry.events.pop_front();
                        }
                        buffer_entry.events.push_back(BufferedEvent {
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
            _ = revalidate_interval.tick() => {
                match revalidate_session_credential(&state, &session).await {
                    CredentialCheck::Active => {
                        revalidation_failures = 0;
                    }
                    CredentialCheck::Terminate(reason) => {
                        credential_terminated = true;
                        let _ = send_ws_close_logged(
                            &mut sender,
                            WS_CLOSE_AUTH_REVOKED,
                            "Session is no longer authenticated",
                            Some(session.user_id),
                            Some(session.session_id.as_str()),
                            "credential_revoked_close",
                        )
                        .await;
                        break (format!("credential no longer valid: {reason}"), false);
                    }
                    CredentialCheck::Failed => {
                        revalidation_failures = revalidation_failures.saturating_add(1);
                        if revalidation_failures >= WS_MAX_REVALIDATION_FAILURES {
                            credential_terminated = true;
                            let _ = send_ws_close_logged(
                                &mut sender,
                                WS_CLOSE_AUTH_REVOKED,
                                "Session could not be revalidated",
                                Some(session.user_id),
                                Some(session.session_id.as_str()),
                                "credential_recheck_failed_close",
                            )
                            .await;
                            break (
                                format!(
                                    "credential revalidation failed {revalidation_failures} times in a row"
                                ),
                                false,
                            );
                        }
                    }
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
    if credential_terminated {
        // A socket closed because its credential is gone must not be able to
        // RESUME straight back into the same state. Dropping the cached session
        // and its replay buffer forces the client through a fresh IDENTIFY,
        // which re-runs the full token/session check before anything is
        // delivered.
        session_cache().invalidate(&session.session_id).await;
        event_buffers().remove(&session.session_id);
        return session;
    }
    session_cache()
        .insert(
            session.session_id.clone(),
            CachedSession {
                user_id: session.user_id,
                sequence: session.sequence,
            },
        )
        .await;
    // Hand the replay buffer over to the bounded disconnected population (or
    // drop it outright when there is nothing to replay) so buffers cannot
    // accumulate across a connect/disconnect loop.
    release_event_buffer(&session.session_id);
    session
}

/// Tell the client an `OP_MEDIA_CONNECT` could not be completed.
///
/// Every failure on that path used to be swallowed (`let _ = ...`,
/// `.unwrap_or_default()`), leaving the client with either no response at all or
/// a session description carrying an empty token. Surfacing a typed failure lets
/// it retry or fall back deliberately.
async fn send_media_connect_failure(
    sender: &mut (impl SinkExt<Message> + Unpin),
    compressor: &WsCompressor,
    session: &Session,
    guild_id: i64,
    channel_id: i64,
    reason: &str,
) -> Result<(), ()> {
    send_ws_text_logged(
        sender,
        json!({
            "op": OP_DISPATCH,
            "t": "MEDIA_CONNECT_FAILED",
            "d": {
                "guild_id": guild_id.to_string(),
                "channel_id": channel_id.to_string(),
                "reason": reason,
            },
        })
        .to_string(),
        compressor,
        Some(session.user_id),
        Some(session.session_id.as_str()),
        "media_connect_failed",
        Some(OP_DISPATCH),
        Some("MEDIA_CONNECT_FAILED"),
        None,
    )
    .await
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

                        // Propagate: on failure the user would be broadcast as
                        // present in voice while `resolve_active_media_room`
                        // finds no voice state and rejects their QUIC
                        // connection — joined, visible to everyone, no audio,
                        // no error anywhere.
                        if let Err(err) = paracord_db::voice_states::upsert_voice_state(
                            &state.db,
                            session.user_id,
                            Some(guild_id),
                            channel_id,
                            &session.session_id,
                        )
                        .await
                        {
                            tracing::error!(
                                user_id = session.user_id,
                                channel_id,
                                "voice join aborted: failed to persist voice state: {err}"
                            );
                            let _ = send_ws_text_logged(
                                sender,
                                json!({
                                    "op": OP_DISPATCH,
                                    "t": "VOICE_STATE_UPDATE_FAILED",
                                    "d": {
                                        "channel_id": channel_id.to_string(),
                                        "guild_id": guild_id.to_string(),
                                        "reason": "voice_state_persist_failed",
                                    },
                                })
                                .to_string(),
                                compressor,
                                Some(session.user_id),
                                Some(session.session_id.as_str()),
                                "voice_state_update_failed",
                                Some(OP_DISPATCH),
                                Some("VOICE_STATE_UPDATE_FAILED"),
                                None,
                            )
                            .await;
                            return;
                        }
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
                        if let Err(err) = native.rooms.join_room(guild_id, channel_id, participant)
                        {
                            tracing::error!(
                                user_id = session.user_id,
                                channel_id,
                                "OP_MEDIA_CONNECT aborted: failed to join relay room: {err:?}"
                            );
                            let _ = send_media_connect_failure(
                                sender,
                                compressor,
                                session,
                                guild_id,
                                channel_id,
                                "relay_join_failed",
                            )
                            .await;
                            return;
                        }

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
                        // Failing here MUST abort: otherwise the client receives
                        // a valid-looking session description whose token the
                        // transport will reject for want of a voice state.
                        if let Err(err) = paracord_db::voice_states::upsert_voice_state(
                            &state.db,
                            session.user_id,
                            Some(guild_id),
                            channel_id,
                            &session.session_id,
                        )
                        .await
                        {
                            tracing::error!(
                                user_id = session.user_id,
                                channel_id,
                                "OP_MEDIA_CONNECT aborted: failed to persist voice state: {err}"
                            );
                            let _ = native
                                .rooms
                                .leave_room(guild_id, channel_id, session.user_id);
                            let _ = send_media_connect_failure(
                                sender,
                                compressor,
                                session,
                                guild_id,
                                channel_id,
                                "voice_state_persist_failed",
                            )
                            .await;
                            return;
                        }

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
                        // `.unwrap_or_default()` here handed the client
                        // `"token": ""` and a downstream auth failure it could
                        // not attribute. Fail the opcode instead.
                        let token = match jsonwebtoken::encode(
                            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
                            &media_claims,
                            &jsonwebtoken::EncodingKey::from_secret(
                                state.config.jwt_secret.as_bytes(),
                            ),
                        ) {
                            Ok(token) => token,
                            Err(err) => {
                                tracing::error!(
                                    user_id = session.user_id,
                                    channel_id,
                                    "OP_MEDIA_CONNECT aborted: failed to mint media token: {err}"
                                );
                                let _ =
                                    native
                                        .rooms
                                        .leave_room(guild_id, channel_id, session.user_id);
                                let _ = send_media_connect_failure(
                                    sender,
                                    compressor,
                                    session,
                                    guild_id,
                                    channel_id,
                                    "media_token_mint_failed",
                                )
                                .await;
                                return;
                            }
                        };
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
                    // Reject an oversized key list before doing any work. One
                    // announce carries at most one key per *other* participant,
                    // and the relay caps a room at `native_media_max_participants`;
                    // walking the array uncapped meant a single 32 KiB frame cost
                    // thousands of log lines and event-bus publishes.
                    let max_recipients = WS_MEDIA_KEY_RECIPIENTS_FLOOR
                        .max(state.config.native_media_max_participants as usize);
                    if announce.encrypted_keys.len() > max_recipients {
                        tracing::warn!(
                            user_id = session.user_id,
                            recipients = announce.encrypted_keys.len(),
                            max_recipients,
                            "OP_MEDIA_KEY_ANNOUNCE rejected: recipient list exceeds the room cap"
                        );
                        return;
                    }

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
                    let mut skipped_recipients = 0usize;
                    for encrypted_key in &announce.encrypted_keys {
                        if !room_user_ids.contains(&encrypted_key.recipient_user_id) {
                            // Counted and reported once below. Logging per element
                            // let a single frame write one line per array entry.
                            skipped_recipients += 1;
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
                    if skipped_recipients > 0 {
                        tracing::warn!(
                            user_id = session.user_id,
                            skipped = skipped_recipients,
                            "OP_MEDIA_KEY_ANNOUNCE: skipped recipients not in the sender's voice room"
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

                // Do NOT consume a sequence number here. This dispatch is
                // never pushed into the replay buffer, so bumping `sequence`
                // punched a permanent hole in the session's replay stream: a
                // later RESUME would see `front().sequence > requested_seq + 1`
                // and be forced into a full re-identify. GUILD_MEMBERS_CHUNK is
                // a response to an explicit client request, so the client can
                // simply re-issue it after a resume.
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
        .events
        .push_back(BufferedEvent {
            sequence,
            event_type: event_type.to_string(),
            payload: Arc::new(payload),
            timestamp: Instant::now(),
        });
}

/// Mark a session's buffer as disconnected exactly as the real disconnect path
/// does, so tests can assert the release/eviction behaviour.
#[doc(hidden)]
pub fn test_release_event_buffer(session_id: &str) {
    release_event_buffer(session_id);
}

/// Number of events currently retained for a session, or `None` when no buffer
/// exists at all.
#[doc(hidden)]
pub fn test_buffered_event_count(session_id: &str) -> Option<usize> {
    event_buffers().get(session_id).map(|b| b.events.len())
}

/// Whether a session's buffer is currently marked as disconnected.
#[doc(hidden)]
pub fn test_event_buffer_is_disconnected(session_id: &str) -> Option<bool> {
    event_buffers()
        .get(session_id)
        .map(|b| b.disconnected_at.is_some())
}

/// Empty a session's buffer without removing the entry (test seam).
#[doc(hidden)]
pub fn test_drain_event_buffer(session_id: &str) {
    if let Some(mut buffer) = event_buffers().get_mut(session_id) {
        buffer.events.clear();
    }
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

/// Exercise the authenticated per-IP connection cap from integration tests.
/// Tests must pass a unique `peer_ip` so their bucket is isolated, and release
/// every granted slot. Not part of the supported public API.
#[doc(hidden)]
pub fn test_acquire_ip_connection_slot(peer_ip: Option<&str>) -> bool {
    try_acquire_ip_connection_slot(peer_ip)
}

#[doc(hidden)]
pub fn test_release_ip_connection_slot(peer_ip: &str) {
    release_ip_connection(peer_ip);
}

/// The configured per-IP authenticated connection cap.
#[doc(hidden)]
pub fn test_max_connections_per_ip() -> usize {
    ws_limits().max_connections_per_ip
}

/// The configured per-IP gateway handshake rate (upgrades per minute).
#[doc(hidden)]
pub fn test_max_handshakes_per_minute_per_ip() -> u32 {
    ws_limits().max_handshakes_per_minute_per_ip
}

/// Per-connection non-Text frame budget, so tests assert against the effective
/// limit rather than a hard-coded constant.
#[doc(hidden)]
pub fn test_max_control_frames_per_minute() -> u32 {
    ws_limits().max_control_frames_per_minute
}

/// Per-user heartbeat budget.
#[doc(hidden)]
pub fn test_max_heartbeats_per_minute() -> u32 {
    ws_limits().max_heartbeats_per_minute
}

/// Per-user `OP_REQUEST_GUILD_MEMBERS` budget.
#[doc(hidden)]
pub fn test_max_guild_member_requests_per_minute() -> u32 {
    ws_limits().max_guild_member_requests_per_minute
}

/// Per-user `OP_MEDIA_KEY_ANNOUNCE` budget.
#[doc(hidden)]
pub fn test_max_media_key_announces_per_minute() -> u32 {
    ws_limits().max_media_key_announces_per_minute
}

/// The pre-auth frame budget (all frame types, not just Text).
#[doc(hidden)]
pub fn test_max_preauth_frames() -> u32 {
    ws_limits().max_preauth_frames
}

/// Drive the per-IP gateway handshake rate limiter directly. Tests must pass a
/// unique `peer_ip` so their bucket is isolated.
#[doc(hidden)]
pub fn test_allow_gateway_handshake(peer_ip: Option<&str>) -> bool {
    allow_gateway_handshake(peer_ip)
}

/// Run the disconnect-time offline transition (the seam used by the deferred
/// `PresenceManager` callback) so tests can assert `user_presences` eviction.
#[doc(hidden)]
pub fn test_mark_user_offline(state: &AppState, user_id: i64) -> Value {
    mark_user_offline(state, user_id)
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
