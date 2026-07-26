use axum::{
    extract::{Query, State},
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use chrono::Utc;
use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use futures_util::stream;
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::error::ApiError;
use crate::middleware::AuthUser;

#[derive(Deserialize)]
pub struct RealtimeEventsQuery {
    pub session_id: Option<String>,
    pub cursor: Option<u64>,
    /// Single-use stream ticket (minted by `POST /api/v1/stream/ticket`). This is
    /// the only accepted credential for the SSE stream — the raw access token is
    /// never carried in the query string.
    pub ticket: Option<String>,
}

/// Time a minted SSE stream ticket stays redeemable before it is treated as
/// expired. Short by design: the client fetches a fresh ticket immediately
/// before opening (or reopening) the stream.
const STREAM_TICKET_TTL: Duration = Duration::from_secs(45);
const MAX_PENDING_STREAM_TICKETS: usize = 100_000;

/// Single-use SSE stream tickets: `ticket -> (user_id, auth_session_id,
/// minted_at)`. A ticket is removed on redemption (so it cannot be replayed) and
/// expired tickets are swept opportunistically on each mint.
///
/// The login-session id is carried so an established stream can periodically
/// re-check that the session has not been logged out or revoked; the stream
/// itself authenticates only once, at attach time.
type StreamTicket = (i64, Option<String>, Instant);

fn stream_tickets() -> &'static DashMap<String, StreamTicket> {
    static STREAM_TICKETS: OnceLock<DashMap<String, StreamTicket>> = OnceLock::new();
    STREAM_TICKETS.get_or_init(DashMap::new)
}

/// Consume a stream ticket, returning the bound user id and login-session id if
/// it exists and has not expired. The ticket is always removed (single use); an
/// expired ticket yields `None` even though it is evicted.
fn consume_stream_ticket(ticket: &str) -> Option<(i64, Option<String>)> {
    let (_, (user_id, auth_session_id, minted_at)) = stream_tickets().remove(ticket)?;
    (minted_at.elapsed() < STREAM_TICKET_TTL).then_some((user_id, auth_session_id))
}

#[derive(Deserialize)]
pub struct RealtimeCommandRequest {
    pub command_id: String,
    #[serde(rename = "type")]
    pub command_type: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Deserialize)]
struct VoiceStateCommandPayload {
    guild_id: Option<String>,
    channel_id: Option<String>,
    self_mute: Option<bool>,
    self_deaf: Option<bool>,
    self_video: Option<bool>,
}

#[derive(Deserialize)]
struct TypingStartCommandPayload {
    channel_id: String,
}

fn parse_i64_id(raw: Option<&str>) -> Option<i64> {
    raw.and_then(|v| v.parse::<i64>().ok())
}

// ── Presence normalization (mirrors `paracord_ws::handler`) ────────────────
//
// The HTTP command bus writes into the SAME process-global `state.user_presences`
// map the WS gateway does, and that value is fanned out to every guild co-member
// and friend and re-served in every READY. The WS path normalizes `status`, caps
// activities at 8 entries and truncates every string to 256 chars; this path
// previously stored `status`, `custom_status` and `activities` verbatim, so one
// caller could park a multi-megabyte blob in server memory and force it onto
// every peer. Keep these limits in lock-step with the gateway's.

/// Maximum activity entries retained from a presence update.
const MAX_ACTIVITY_ITEMS: usize = 8;
/// Maximum characters retained for any single presence text field.
const MAX_ACTIVITY_TEXT_LEN: usize = 256;
/// Hard cap on the serialized size of an inbound presence payload. Anything
/// larger is refused outright rather than truncated, so an oversized blob is a
/// visible client error instead of silent data loss.
const MAX_PRESENCE_PAYLOAD_BYTES: usize = 16 * 1024;

fn truncate_for_presence(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
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
        let text_field = |key: &str| {
            obj.get(key)
                .and_then(|v| v.as_str())
                .map(|s| truncate_for_presence(s, MAX_ACTIVITY_TEXT_LEN))
        };

        activities.push(json!({
            "name": name,
            "type": activity_type,
            "details": text_field("details"),
            "state": text_field("state"),
            "started_at": text_field("started_at"),
            "application_id": text_field("application_id"),
        }));
    }

    activities
}

/// Build the stored/broadcast presence value from a caller-supplied payload,
/// applying the same normalization the gateway applies.
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

/// Everyone entitled to see `user_id`'s presence: themselves, anyone sharing a
/// space with them, and their friends. Mirrors the gateway's recipient scoping —
/// presence is never broadcast server-wide.
async fn presence_recipient_ids(state: &AppState, user_id: i64) -> Vec<i64> {
    let mut recipients: std::collections::HashSet<i64> = std::collections::HashSet::new();
    recipients.insert(user_id);
    if let Ok(guilds) = paracord_db::guilds::get_user_guilds(&state.db, user_id.into()).await {
        for guild in guilds {
            if let Ok(member_ids) =
                paracord_db::members::get_guild_member_user_ids(&state.db, guild.id).await
            {
                recipients.extend(member_ids);
            }
        }
    }
    if let Ok(friend_ids) =
        paracord_db::relationships::get_friend_user_ids(&state.db, user_id).await
    {
        recipients.extend(friend_ids);
    }
    recipients.into_iter().collect()
}

/// Mark `user_id` online and tell the people who can see them.
///
/// The realtime stream is the client's actual connection to the server, so
/// attaching one is what "this person is here" means — exactly as connecting the
/// WebSocket gateway does. Without this a signed-in user stays absent from
/// `online_users`, and everyone else sees them as offline for their whole
/// session.
async fn mark_stream_user_online(state: &AppState, user_id: i64) {
    state.presence_manager.cancel_offline(user_id);
    // `insert` reports whether this was a real transition. A second tab, or a
    // client reconnecting after a dropped stream, is already online: re-announcing
    // would fan a redundant event out to every space they belong to, and a
    // flapping connection would do it repeatedly.
    let newly_online = state.online_users.insert(user_id);
    if !newly_online {
        return;
    }

    // Preserve a status the user chose for themselves (dnd, custom status,
    // activities); only fill in a default when we have nothing on file.
    let presence = match state.user_presences.get(&user_id).map(|v| v.clone()) {
        Some(mut existing) => {
            if let Some(obj) = existing.as_object_mut() {
                obj.insert("user_id".to_string(), json!(user_id.to_string()));
                let offline_or_missing = obj
                    .get("status")
                    .and_then(|v| v.as_str())
                    .is_none_or(|s| s == "offline");
                if offline_or_missing {
                    obj.insert("status".to_string(), json!("online"));
                }
                obj.entry("activities").or_insert_with(|| json!([]));
            }
            existing
        }
        None => build_presence_payload(user_id, Some("online"), None, None),
    };
    state.user_presences.insert(user_id, presence.clone());

    dispatch_presence_to_others(state, user_id, presence).await;
}

/// Mark `user_id` offline and tell the same audience.
async fn mark_stream_user_offline(state: &AppState, user_id: i64) {
    if state.online_users.remove(&user_id).is_none() {
        return;
    }
    state.user_presences.remove(&user_id);
    let presence = build_presence_payload(user_id, Some("offline"), None, None);
    dispatch_presence_to_others(state, user_id, presence).await;
}

/// Fan a connect/disconnect presence transition out to everyone *except* the
/// user it describes.
///
/// The subject learns nothing from being told it just connected, and the event
/// would otherwise be appended to its own replay buffer — consuming a slot in
/// the resume window and pushing the events it actually reconnected for further
/// back. An explicit status change (`presence_update`) still echoes to the
/// sender, so their other devices stay in step.
async fn dispatch_presence_to_others(state: &AppState, user_id: i64, presence: Value) {
    let mut recipients = presence_recipient_ids(state, user_id).await;
    recipients.retain(|id| *id != user_id);
    if recipients.is_empty() {
        return;
    }
    state
        .event_bus
        .dispatch_to_users("PRESENCE_UPDATE", presence, recipients);
}

// ── SSE resume: honest per-session event replay ────────────────────────────
//
// The event bus hands each SSE connection a `broadcast::Receiver`, but that
// receiver only exists while a connection is attached: any event emitted during
// a reconnect gap would be lost, even though the client thinks it resumed. To
// make resume real we keep a persistent per-session ring buffer here in the API
// crate. A background task owns the event-bus receiver for the session's whole
// lifetime (surviving disconnects), assigns each delivered event a monotonic
// sequence, applies channel-permission filtering + guild-scope updates, and
// appends the rendered frame to the buffer. Each SSE connection then replays
// buffered frames with `seq > cursor` before tailing new ones, so the sequence
// numbering stays consistent across replayed and live events and the client
// cursor is monotonic. Buffers (and their background task + event-bus
// registration) are torn down by a bounded age sweep, mirroring the WS handler.

/// Max buffered events retained per session for replay.
const MAX_REPLAY_EVENTS: usize = 512;
/// Max age a session channel is kept alive with no fresh events *and* no
/// attached connection before the background sweep tears it down (matches the WS
/// replay window).
const MAX_REPLAY_AGE: Duration = Duration::from_secs(300);
/// How often the background sweep runs.
const REPLAY_SWEEP_INTERVAL: Duration = Duration::from_secs(300);
/// Upper bound on concurrent session channels a single authenticated user may
/// hold open at once. Reconnects reuse an existing channel (keyed by the JWT
/// session id), so this only caps genuinely distinct sessions and prevents a
/// single account from spawning unbounded pumps / event-bus registrations.
const MAX_SESSION_CHANNELS_PER_USER: usize = 32;
/// Upper bound on concurrent SSE *attachments* per user.
///
/// `MAX_SESSION_CHANNELS_PER_USER` caps channels, not attachments: many streams
/// may attach to one channel, and every attach deep-clones up to
/// `MAX_REPLAY_EVENTS` rendered frames into the connection's replay queue. Cap
/// the attachments too.
const MAX_SSE_ATTACHMENTS_PER_USER: usize = 8;
/// Hard lifetime of an established SSE stream.
///
/// The stream authenticates once (single-use ticket) and then tails events
/// forever; nothing re-checks the token, the login session, or a ban. Bounding
/// the lifetime forces a re-authenticated reconnect, so logout / token
/// revocation / ban take effect within this window instead of never.
const MAX_STREAM_LIFETIME: Duration = Duration::from_secs(15 * 60);
/// How often an attached stream re-validates that its login session is still
/// active. Cheap (one indexed lookup) relative to the stream's lifetime.
const STREAM_REVALIDATE_INTERVAL: Duration = Duration::from_secs(60);

// ── Owner-bound realtime session ids ────────────────────────────────────────
//
// A realtime session id is the key into the process-wide event-bus session map,
// a keyspace the WebSocket gateway shares. `stream_events` takes the id straight
// from the query string, so an id carrying no proof of ownership let any caller
// register a session that had been issued to somebody else — and session ids are
// disclosed to co-members, because READY publishes every visible voice state's
// `session_id`.
//
// Every id the server hands out is therefore `"<base>.<tag>"`, where the tag is
// an HMAC-SHA256 over the owner's user id and the base, keyed with the server's
// JWT secret. Forging an id for a user requires that secret, and replaying
// another user's id fails because the tag is verified against the *caller's*
// user id. The base stays stable per login session so reconnects keep landing on
// the same channel (and so keep their replay buffer and cursor).

/// Bytes of HMAC output retained in a session-id tag (rendered as hex). 128 bits
/// is far beyond guessing range for an online check.
const SESSION_ID_TAG_BYTES: usize = 16;

fn session_id_tag(secret: &str, user_id: i64, base: &str) -> String {
    use hmac::{Hmac, Mac};
    type HmacSha256 = Hmac<sha2::Sha256>;

    // `new_from_slice` only fails for key lengths this HMAC accepts anyway.
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts a key of any length");
    mac.update(b"paracord-realtime-session-v1:");
    mac.update(user_id.to_string().as_bytes());
    mac.update(b":");
    mac.update(base.as_bytes());
    mac.finalize().into_bytes()[..SESSION_ID_TAG_BYTES]
        .iter()
        .fold(
            String::with_capacity(SESSION_ID_TAG_BYTES * 2),
            |mut out, byte| {
                use std::fmt::Write;
                let _ = write!(out, "{byte:02x}");
                out
            },
        )
}

/// Mint a realtime session id bound to `user_id`. `base` is the stable part
/// (the login-session id when the caller has one), so the same login session
/// keeps landing on the same channel across reconnects.
fn mint_session_id(state: &AppState, user_id: i64, base: &str) -> String {
    format!(
        "{base}.{}",
        session_id_tag(&state.config.jwt_secret, user_id, base)
    )
}

/// Whether `session_id` is one this server issued to `user_id`.
fn session_id_issued_to(state: &AppState, session_id: &str, user_id: i64) -> bool {
    let Some((base, tag)) = session_id.rsplit_once('.') else {
        return false;
    };
    if base.is_empty() {
        return false;
    }
    let expected = session_id_tag(&state.config.jwt_secret, user_id, base);
    // Length is public; compare the contents without an early exit.
    if expected.len() != tag.len() {
        return false;
    }
    expected
        .bytes()
        .zip(tag.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// Per-user count of attached SSE connections, enforcing
/// `MAX_SSE_ATTACHMENTS_PER_USER`.
fn user_attachment_counts() -> &'static DashMap<i64, usize> {
    static USER_ATTACHMENT_COUNTS: OnceLock<DashMap<i64, usize>> = OnceLock::new();
    USER_ATTACHMENT_COUNTS.get_or_init(DashMap::new)
}

/// Reserve an attachment slot for `user_id`, or return `false` when the cap is
/// already reached. Released by `AttachmentGuard::drop`.
fn try_acquire_attachment_slot(user_id: i64) -> bool {
    let mut count = user_attachment_counts().entry(user_id).or_insert(0);
    if *count >= MAX_SSE_ATTACHMENTS_PER_USER {
        return false;
    }
    *count += 1;
    true
}

fn release_attachment_slot(user_id: i64) {
    if let Some(mut count) = user_attachment_counts().get_mut(&user_id) {
        *count = count.saturating_sub(1);
        if *count == 0 {
            drop(count);
            user_attachment_counts().remove(&user_id);
        }
    }
}

/// Current number of live stream attachments for `user_id`.
fn attachment_count(user_id: i64) -> usize {
    user_attachment_counts()
        .get(&user_id)
        .map(|c| *c)
        .unwrap_or(0)
}

/// RAII release of a per-user SSE attachment slot.
///
/// Dropping the last attachment is what takes the user offline. The transition
/// is deferred through `PresenceManager` rather than applied here, because a
/// client that is merely reconnecting drops and re-attaches within moments and
/// must not flicker offline for everyone watching.
struct AttachmentGuard {
    user_id: i64,
    state: AppState,
}

impl Drop for AttachmentGuard {
    fn drop(&mut self) {
        release_attachment_slot(self.user_id);
        if attachment_count(self.user_id) > 0 {
            return;
        }
        let user_id = self.user_id;
        let state = self.state.clone();
        state
            .presence_manager
            .clone()
            .schedule_offline(user_id, async move {
                // They may have reconnected during the grace period.
                if attachment_count(user_id) > 0 {
                    return;
                }
                mark_stream_user_offline(&state, user_id).await;
            });
    }
}

// ── Command-bus rate limiting ──────────────────────────────────────────────
//
// The WS gateway meters presence (60/min), typing (120/min) and voice (60/min)
// per user. The HTTP command bus reaches the same handlers with no limiter at
// all, so a client could just move to HTTP to bypass them. Mirror the gateway's
// budgets here, keyed by user id.
const HTTP_MAX_COMMANDS_PER_MINUTE: u32 = 240;
const HTTP_MAX_PRESENCE_UPDATES_PER_MINUTE: u32 = 60;
const HTTP_MAX_TYPING_EVENTS_PER_MINUTE: u32 = 120;
const HTTP_MAX_VOICE_UPDATES_PER_MINUTE: u32 = 60;

struct CommandRateLimits {
    commands: governor::DefaultKeyedRateLimiter<i64>,
    presence: governor::DefaultKeyedRateLimiter<i64>,
    typing: governor::DefaultKeyedRateLimiter<i64>,
    voice: governor::DefaultKeyedRateLimiter<i64>,
}

fn command_rate_limits() -> &'static CommandRateLimits {
    static COMMAND_RATE_LIMITS: OnceLock<CommandRateLimits> = OnceLock::new();
    COMMAND_RATE_LIMITS.get_or_init(|| {
        fn limiter(per_minute: u32) -> governor::DefaultKeyedRateLimiter<i64> {
            governor::RateLimiter::keyed(governor::Quota::per_minute(
                std::num::NonZeroU32::new(per_minute).expect("non-zero command quota"),
            ))
        }
        let limits = CommandRateLimits {
            commands: limiter(HTTP_MAX_COMMANDS_PER_MINUTE),
            presence: limiter(HTTP_MAX_PRESENCE_UPDATES_PER_MINUTE),
            typing: limiter(HTTP_MAX_TYPING_EVENTS_PER_MINUTE),
            voice: limiter(HTTP_MAX_VOICE_UPDATES_PER_MINUTE),
        };
        tokio::spawn(async {
            let mut interval = tokio::time::interval(Duration::from_secs(300));
            interval.tick().await;
            loop {
                interval.tick().await;
                let rl = command_rate_limits();
                for limiter in [&rl.commands, &rl.presence, &rl.typing, &rl.voice] {
                    limiter.retain_recent();
                    limiter.shrink_to_fit();
                }
            }
        });
        limits
    })
}

/// Charge the shared and per-command-type budgets for `user_id`.
fn check_command_rate_limit(user_id: i64, command_type: &str) -> Result<(), ApiError> {
    use governor::clock::{Clock, DefaultClock};

    let limits = command_rate_limits();
    let clock = DefaultClock::default();
    let now = clock.now();
    let retry_after = |not_until: governor::NotUntil<_>| {
        ApiError::RateLimited(not_until.wait_time_from(now).as_secs().max(1) as i64)
    };

    if let Err(not_until) = limits.commands.check_key(&user_id) {
        return Err(retry_after(not_until));
    }
    let per_type = match command_type {
        "presence_update" => limits.presence.check_key(&user_id).err(),
        "typing_start" => limits.typing.check_key(&user_id).err(),
        "voice_state_update" => limits.voice.check_key(&user_id).err(),
        _ => None,
    };
    match per_type {
        Some(not_until) => Err(retry_after(not_until)),
        None => Ok(()),
    }
}

/// A fully-rendered gateway frame retained for replay. `data` is the exact SSE
/// `data:` body (with `s`/`event_id` already embedded) so replayed and live
/// frames are byte-identical.
#[derive(Clone)]
struct BufferedSseEvent {
    sequence: u64,
    data: String,
    timestamp: Instant,
}

/// Persistent per-session state that outlives individual SSE connections.
struct SessionChannel {
    /// Session id this channel serves, used to release the event-bus
    /// registration when the channel is reclaimed.
    session_id: String,
    /// Authenticated user that created (owns) this channel. Every attach is
    /// checked against this so a caller cannot bind to another user's session by
    /// supplying their `session_id`.
    owner_user_id: i64,
    /// Number of SSE connections currently attached. The sweep never reclaims a
    /// channel while a connection is attached (even an idle one that receives no
    /// events), so a live-but-quiet stream is not torn out from under itself.
    active_connections: AtomicUsize,
    /// Event bus handle so the channel can unregister its own session on Drop,
    /// keeping the pump, buffer, and event-bus registration reclaimed together.
    event_bus: paracord_core::events::EventBus,
    /// Monotonic sequence generator for this session's dispatched events.
    next_sequence: AtomicU64,
    /// Ordered ring buffer of recent rendered frames for replay.
    buffer: Mutex<VecDeque<BufferedSseEvent>>,
    /// Live fan-out to any currently attached SSE connection(s).
    live_tx: broadcast::Sender<Arc<BufferedSseEvent>>,
    /// Wall-clock of the last time this channel saw activity, used by the sweep
    /// to decide when to reclaim an idle session (including its event-bus
    /// registration) even if no events have arrived.
    last_active: Mutex<Instant>,
    /// Handle to the background pump; aborted when the channel is dropped.
    pump: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl SessionChannel {
    fn touch(&self) {
        if let Ok(mut la) = self.last_active.lock() {
            *la = Instant::now();
        }
    }

    /// Append a rendered frame to the ring buffer, evicting stale/overflow
    /// entries first, and fan it out to any attached connection.
    fn record(&self, event: BufferedSseEvent) {
        if let Ok(mut buffer) = self.buffer.lock() {
            while buffer
                .front()
                .map(|e| e.timestamp.elapsed() > MAX_REPLAY_AGE)
                .unwrap_or(false)
            {
                buffer.pop_front();
            }
            if buffer.len() >= MAX_REPLAY_EVENTS {
                buffer.pop_front();
            }
            buffer.push_back(event.clone());
        }
        // Ignore send errors: no connection attached is normal (gap buffering).
        let _ = self.live_tx.send(Arc::new(event));
    }

    /// Snapshot of buffered frames with `sequence > cursor`, in order.
    fn replay_since(&self, cursor: u64) -> Vec<Arc<BufferedSseEvent>> {
        self.buffer
            .lock()
            .map(|buffer| {
                buffer
                    .iter()
                    .filter(|e| e.sequence > cursor)
                    .map(|e| Arc::new(e.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The oldest buffered sequence still available, if any.
    fn oldest_sequence(&self) -> Option<u64> {
        self.buffer
            .lock()
            .ok()
            .and_then(|buffer| buffer.front().map(|e| e.sequence))
    }

    /// The current (latest assigned) sequence.
    fn current_sequence(&self) -> u64 {
        self.next_sequence.load(Ordering::SeqCst)
    }
}

impl Drop for SessionChannel {
    fn drop(&mut self) {
        // Release the event-bus registration (which also closes the pump's
        // receiver) and abort the pump task, so nothing leaks once the channel
        // is reclaimed. The pump only holds a `Weak` reference to this channel,
        // so this Drop is reachable: once the map entry and every attached
        // connection are gone, the last strong reference is dropped and cleanup
        // runs here.
        self.event_bus.unregister_session(&self.session_id);
        if let Ok(mut pump) = self.pump.lock() {
            if let Some(handle) = pump.take() {
                handle.abort();
            }
        }
        decrement_user_channel_count(self.owner_user_id);
    }
}

/// RAII guard tying an attached SSE connection's lifetime to the session
/// channel's `active_connections` counter. Held for the whole duration of a
/// stream; on drop (client disconnect) the counter is decremented so the sweep
/// can eventually reclaim the now-idle channel.
struct ConnectionGuard {
    channel: Arc<SessionChannel>,
}

impl ConnectionGuard {
    fn new(channel: Arc<SessionChannel>) -> Self {
        channel.active_connections.fetch_add(1, Ordering::SeqCst);
        Self { channel }
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.channel
            .active_connections
            .fetch_sub(1, Ordering::SeqCst);
    }
}

/// Per-user count of live session channels, used to enforce
/// `MAX_SESSION_CHANNELS_PER_USER`. Kept in lock-step with channel
/// creation/reclamation (incremented when a channel is created, decremented in
/// `SessionChannel::drop`).
fn user_channel_counts() -> &'static DashMap<i64, usize> {
    static USER_CHANNEL_COUNTS: OnceLock<DashMap<i64, usize>> = OnceLock::new();
    USER_CHANNEL_COUNTS.get_or_init(DashMap::new)
}

fn user_channel_count(user_id: i64) -> usize {
    user_channel_counts().get(&user_id).map(|v| *v).unwrap_or(0)
}

fn increment_user_channel_count(user_id: i64) {
    *user_channel_counts().entry(user_id).or_insert(0) += 1;
}

fn decrement_user_channel_count(user_id: i64) {
    if let Some(mut count) = user_channel_counts().get_mut(&user_id) {
        *count = count.saturating_sub(1);
        if *count == 0 {
            drop(count);
            user_channel_counts().remove(&user_id);
        }
    }
}

fn session_channels() -> &'static DashMap<String, Arc<SessionChannel>> {
    static SESSION_CHANNELS: OnceLock<DashMap<String, Arc<SessionChannel>>> = OnceLock::new();
    SESSION_CHANNELS.get_or_init(|| {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(REPLAY_SWEEP_INTERVAL);
            interval.tick().await; // skip immediate first tick
            loop {
                interval.tick().await;
                if let Some(channels) = SESSION_CHANNELS.get() {
                    let stale: Vec<String> = channels
                        .iter()
                        .filter(|entry| {
                            let channel = entry.value();
                            // Never reclaim a channel that still has a connection
                            // attached, even one that has been idle (no events)
                            // past MAX_REPLAY_AGE — keep-alive frames do not flow
                            // through the event pump, so idleness alone must not
                            // tear a live stream's channel out of the map.
                            channel.active_connections.load(Ordering::SeqCst) == 0
                                && channel
                                    .last_active
                                    .lock()
                                    .map(|la| la.elapsed() > MAX_REPLAY_AGE)
                                    .unwrap_or(true)
                        })
                        .map(|entry| entry.key().clone())
                        .collect();
                    for sid in stale {
                        remove_session_channel(&sid);
                    }
                }
            }
        });
        DashMap::new()
    })
}

/// Remove a session channel, dropping the last strong reference so its Drop
/// impl unregisters the event-bus session and aborts the pump.
fn remove_session_channel(session_id: &str) {
    session_channels().remove(session_id);
}

/// Get the existing channel for `session_id`, or create it and spawn the
/// background pump that owns the event-bus receiver for the session lifetime.
///
/// The lookup/creation runs under the DashMap `entry` write lock so that exactly
/// one channel (and one registration) exists per session id even under
/// concurrent connect races. On the existing-channel path the caller's
/// `user_id` is checked against the channel's owner and a mismatch is rejected,
/// so a caller cannot attach to another user's session by guessing/replaying its
/// `session_id`. Creation is capped per user to bound resource usage.
///
/// The *vacant* path used to have no such check: it registered whatever id the
/// caller supplied into the (gateway-shared) event bus under the caller's user
/// id, which is how a co-member who learned a victim's session id could claim
/// it — locking the victim out of realtime and diverting their user-targeted
/// events. Every id is now owner-bound (see `session_id_issued_to`) and that is
/// verified up front, before either branch runs.
///
/// The spawned pump holds only a `Weak` reference to the channel, so the channel
/// (and thus its Drop-based cleanup) is not kept alive by the pump.
fn get_or_create_channel(
    state: &AppState,
    session_id: &str,
    user_id: i64,
    guild_ids: &[i64],
    guild_owner_ids: HashMap<i64, i64>,
) -> Result<Arc<SessionChannel>, ApiError> {
    if !session_id_issued_to(state, session_id, user_id) {
        tracing::warn!(
            user_id,
            "realtime: refusing a session id that was not issued to this user"
        );
        return Err(ApiError::Forbidden);
    }
    match session_channels().entry(session_id.to_string()) {
        Entry::Occupied(entry) => {
            let channel = Arc::clone(entry.get());
            drop(entry);
            if channel.owner_user_id != user_id {
                // Session id belongs to a different user; refuse to attach.
                return Err(ApiError::Forbidden);
            }
            channel.touch();
            Ok(channel)
        }
        Entry::Vacant(entry) => {
            if user_channel_count(user_id) >= MAX_SESSION_CHANNELS_PER_USER {
                return Err(ApiError::RateLimited(0));
            }

            // Refused when the id is live on the gateway under a different user.
            // Bail out before the channel exists, so its Drop cannot unregister
            // the incumbent's subscription on the way out.
            let Some(receiver) =
                state
                    .event_bus
                    .register_session(session_id.to_string(), user_id, guild_ids)
            else {
                tracing::warn!(
                    user_id,
                    "realtime: session id is already registered to another user"
                );
                return Err(ApiError::Forbidden);
            };
            let (live_tx, _) = broadcast::channel::<Arc<BufferedSseEvent>>(MAX_REPLAY_EVENTS);
            let channel = Arc::new(SessionChannel {
                session_id: session_id.to_string(),
                owner_user_id: user_id,
                active_connections: AtomicUsize::new(0),
                event_bus: state.event_bus.clone(),
                next_sequence: AtomicU64::new(0),
                buffer: Mutex::new(VecDeque::new()),
                live_tx,
                last_active: Mutex::new(Instant::now()),
                pump: Mutex::new(None),
            });
            increment_user_channel_count(user_id);

            let pump_handle = tokio::spawn(session_pump(
                state.clone(),
                session_id.to_string(),
                user_id,
                guild_owner_ids,
                Arc::downgrade(&channel),
                receiver,
            ));
            if let Ok(mut pump) = channel.pump.lock() {
                *pump = Some(pump_handle);
            }

            entry.insert(Arc::clone(&channel));
            channel.touch();
            Ok(channel)
        }
    }
}

/// Whether a session owned by `user_id`, a member of the guilds `is_member_of`
/// answers `true` for, should receive an event with this scope.
///
/// This is `paracord_ws::session::Session::should_receive_event` for the SSE
/// transport. The pump used to have no equivalent — it trusted the event bus's
/// routing completely and filtered only on channel permissions — so anything
/// that reached its receiver, including a user-targeted DM addressed to somebody
/// else, was rendered straight into this session's buffer. The event bus's
/// indexes are the only thing that decided delivery, and those indexes are
/// exactly what a session-id takeover corrupts. Re-checking the recipient here
/// means a desynced index cannot become a delivery.
///
/// Exposed (as `#[doc(hidden)]`) so the crate's integration tests can drive the
/// decision directly; not part of the supported public API.
#[doc(hidden)]
pub fn session_should_receive_event(
    user_id: i64,
    is_member_of: impl Fn(i64) -> bool,
    guild_id: Option<i64>,
    target_user_ids: Option<&[i64]>,
) -> bool {
    // A targeted event goes to its targets and nobody else, whatever its guild.
    if let Some(targets) = target_user_ids {
        return targets.contains(&user_id);
    }
    match guild_id {
        None => true,
        Some(guild_id) => is_member_of(guild_id),
    }
}

/// Background pump: owns the event-bus receiver for a session's whole lifetime,
/// applies permission filtering + guild-scope mutations, assigns sequences, and
/// records rendered frames into the session's ring buffer.
async fn session_pump(
    state: AppState,
    session_id: String,
    user_id: i64,
    mut guild_owner_ids: HashMap<i64, i64>,
    channel: Weak<SessionChannel>,
    mut receiver: broadcast::Receiver<paracord_core::events::ServerEvent>,
) {
    loop {
        match receiver.recv().await {
            Ok(event) => {
                // The channel is only weakly held so this pump never keeps it
                // alive; if it has been reclaimed there is nothing left to feed.
                let Some(channel) = channel.upgrade() else {
                    break;
                };
                // ── Recipient filtering (mirrors the gateway) ──
                if !session_should_receive_event(
                    user_id,
                    |gid| guild_owner_ids.contains_key(&gid),
                    event.guild_id,
                    event.target_user_ids.as_deref(),
                ) {
                    continue;
                }

                // ── Channel permission filtering (mirrors WS handler) ──
                if let Some(guild_id) = event.guild_id {
                    if let Some(channel_id) =
                        extract_channel_id_from_event(&event.event_type, &event.payload)
                    {
                        let owner_id = guild_owner_ids.get(&guild_id).copied().unwrap_or(0);
                        if !can_receive_channel_event(
                            &state, guild_id, channel_id, owner_id, user_id,
                        )
                        .await
                        {
                            continue;
                        }
                    }
                }

                // ── Dynamic guild scope updates ──
                apply_guild_scope_update(
                    &state,
                    &session_id,
                    user_id,
                    &event,
                    &mut guild_owner_ids,
                )
                .await;

                let sequence = channel.next_sequence.fetch_add(1, Ordering::SeqCst) + 1;
                let data = render_dispatch_frame(sequence, &event);
                channel.touch();
                channel.record(BufferedSseEvent {
                    sequence,
                    data,
                    timestamp: Instant::now(),
                });
            }
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                let Some(channel) = channel.upgrade() else {
                    break;
                };
                // The event-bus channel overflowed for this session: we can no
                // longer guarantee a gapless buffer. Record a reconnect frame
                // so any attached/future connection learns replay is broken.
                let sequence = channel.next_sequence.fetch_add(1, Ordering::SeqCst) + 1;
                let data = json!({
                    "event_id": sequence,
                    "op": 7,
                    "d": { "reason": "lagged", "skipped": skipped },
                })
                .to_string();
                channel.touch();
                channel.record(BufferedSseEvent {
                    sequence,
                    data,
                    timestamp: Instant::now(),
                });
            }
            Err(broadcast::error::RecvError::Closed) => {
                // Event bus dropped the session sender (session unregistered):
                // the pump's job is done.
                break;
            }
        }
    }
}

/// Render an op-0 dispatch frame identically to how it is sent live, so
/// replayed and live frames are byte-for-byte identical.
fn render_dispatch_frame(sequence: u64, event: &paracord_core::events::ServerEvent) -> String {
    if let Some(serialized) = &event.serialized_payload {
        format!(
            r#"{{"event_id":{},"op":0,"t":"{}","s":{},"d":{}}}"#,
            sequence, event.event_type, sequence, serialized
        )
    } else {
        json!({
            "event_id": sequence,
            "op": 0,
            "t": event.event_type,
            "s": sequence,
            "d": *event.payload,
        })
        .to_string()
    }
}

/// Apply the same dynamic guild-scope bookkeeping the WS handler performs, so a
/// session's guild set (and cached owner ids) stay correct as membership
/// changes while the pump runs.
async fn apply_guild_scope_update(
    state: &AppState,
    session_id: &str,
    user_id: i64,
    event: &paracord_core::events::ServerEvent,
    guild_owner_ids: &mut HashMap<i64, i64>,
) {
    match event.event_type.as_str() {
        "GUILD_MEMBER_ADD" => {
            if event
                .payload
                .get("user_id")
                .and_then(|v| v.as_str())
                .is_some_and(|uid| uid == user_id.to_string())
            {
                if let Some(gid) = event
                    .payload
                    .get("guild_id")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<i64>().ok())
                {
                    // `guild_owner_ids` doubles as this pump's guild-membership
                    // set, so the key must land even when the owner lookup
                    // fails; 0 is the same fallback the permission check
                    // already applies for a missing owner.
                    let owner_id = paracord_db::guilds::get_guild(&state.db, gid)
                        .await
                        .ok()
                        .flatten()
                        .map(|guild| guild.owner_id)
                        .unwrap_or(0);
                    guild_owner_ids.insert(gid, owner_id);
                    state.event_bus.add_session_guild(session_id, gid);
                }
            }
        }
        "GUILD_MEMBER_REMOVE" | "GUILD_BAN_ADD" => {
            if event
                .payload
                .get("user_id")
                .and_then(|v| v.as_str())
                .is_some_and(|uid| uid == user_id.to_string())
            {
                if let Some(gid) = event
                    .payload
                    .get("guild_id")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<i64>().ok())
                {
                    guild_owner_ids.remove(&gid);
                    state.event_bus.remove_session_guild(session_id, gid);
                }
            }
        }
        "GUILD_DELETE" => {
            if let Some(gid) = event
                .payload
                .get("id")
                .or_else(|| event.payload.get("guild_id"))
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<i64>().ok())
            {
                guild_owner_ids.remove(&gid);
                state.event_bus.remove_session_guild(session_id, gid);
            }
        }
        "GUILD_UPDATE" => {
            if let Some(gid) = event.guild_id {
                if let Some(new_owner) = event
                    .payload
                    .get("owner_id")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<i64>().ok())
                {
                    guild_owner_ids.insert(gid, new_owner);
                }
            }
        }
        _ => {}
    }
}

async fn build_ready_payload(
    state: &AppState,
    user_id: i64,
    session_id: &str,
    ready_seq: u64,
) -> Value {
    let user = paracord_db::users::get_user_by_id(&state.db, user_id)
        .await
        .ok()
        .flatten();
    let user_json = if let Some(u) = user {
        json!({
            "id": u.id.to_string(),
            "username": u.username,
            "discriminator": u.discriminator,
            "avatar_hash": u.avatar_hash,
            "display_name": u.display_name,
        })
    } else {
        json!({
            "id": user_id.to_string(),
        })
    };

    let guild_rows = paracord_db::guilds::get_user_guilds(&state.db, user_id.into())
        .await
        .unwrap_or_default();
    let mut guilds_json = Vec::with_capacity(guild_rows.len());
    for guild in guild_rows {
        let member_count = paracord_db::members::get_member_count(&state.db, guild.id)
            .await
            .unwrap_or(0);
        let voice_states = paracord_db::voice_states::get_guild_voice_states(&state.db, guild.id)
            .await
            .unwrap_or_default();

        // Only expose the voice roster of channels this user can view. The live
        // voice event path gates on VIEW_CHANNEL via can_receive_channel_event;
        // apply the same check to the READY snapshot so a hidden voice channel's
        // participant list is not leaked. Compute permissions once per distinct
        // channel to bound extra queries.
        let mut channel_visibility: HashMap<i64, bool> = HashMap::new();
        for vs in &voice_states {
            if let std::collections::hash_map::Entry::Vacant(e) =
                channel_visibility.entry(vs.channel_id)
            {
                let visible = paracord_core::permissions::compute_channel_permissions_cached(
                    &state.permission_cache,
                    &state.db,
                    guild.id,
                    vs.channel_id,
                    guild.owner_id,
                    user_id,
                )
                .await
                .map(|perms| perms.contains(Permissions::VIEW_CHANNEL))
                .unwrap_or(false);
                e.insert(visible);
            }
        }

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
                    "request_to_speak_at": vs.request_to_speak_at.map(|value| value.to_rfc3339()),
                    "mute": false,
                    "deaf": false,
                    "username": &vs.username,
                    "avatar_hash": &vs.avatar_hash,
                })
            })
            .collect();

        // Who in this space is online right now. Without this the client learns
        // presence only from events that arrive after it connects, so everybody
        // already online renders as offline until they happen to change status.
        // Only online members are looked up, mirroring the gateway's READY.
        let presences_json: Vec<Value> =
            match paracord_db::members::get_guild_member_user_ids(&state.db, guild.id).await {
                Ok(member_ids) => member_ids
                    .iter()
                    .filter(|uid| state.online_users.contains(uid))
                    .map(|uid| {
                        state
                            .user_presences
                            .get(uid)
                            .map(|entry| entry.value().clone())
                            .unwrap_or_else(|| {
                                build_presence_payload(*uid, Some("online"), None, None)
                            })
                    })
                    .collect(),
                Err(_) => Vec::new(),
            };

        guilds_json.push(json!({
            "id": guild.id.to_string(),
            "name": guild.name,
            "owner_id": guild.owner_id.to_string(),
            "icon_hash": guild.icon_hash,
            "member_count": member_count,
            "channels": [],
            "voice_states": voice_states_json,
            "presences": presences_json,
            "lazy": true,
        }));
    }

    json!({
        // Carry the connection's resume point so the client's cursor tracks the
        // sequence it is actually caught up to. Hardcoding 1 here would drive the
        // client cursor backwards on every reconnect and, combined with the op-9
        // resync path, wedge a resuming client into a permanent resync loop.
        "event_id": ready_seq,
        "op": 0,
        "t": "READY",
        "s": ready_seq,
        "d": {
            "user": user_json,
            "guilds": guilds_json,
            "session_id": session_id,
        }
    })
}

/// Per-connection stream state. Owns only a live subscription to the persistent
/// `SessionChannel`; sequencing, buffering, permission filtering and guild-scope
/// bookkeeping all live in the channel's background pump so they survive
/// reconnects.
struct RealtimeStreamState {
    /// Kept alive so the channel (and its event-bus registration) survives while
    /// a connection is attached; the sweep reclaims it once idle.
    channel: Arc<SessionChannel>,
    /// Keeps `active_connections` incremented for this connection's lifetime so
    /// the sweep does not reclaim the channel while the stream is attached.
    _conn_guard: ConnectionGuard,
    /// Releases this user's SSE attachment slot when the stream ends.
    _attach_guard: AttachmentGuard,
    /// Used for the periodic login-session revalidation below.
    app_state: AppState,
    user_id: i64,
    /// Login-session id this stream was authorized under. `None` for callers
    /// that presented a credential without one (e.g. a bot token), which then
    /// rely solely on `MAX_STREAM_LIFETIME`.
    auth_session_id: Option<String>,
    /// When the stream attached, for the `MAX_STREAM_LIFETIME` bound.
    started_at: Instant,
    /// Next scheduled login-session revalidation.
    next_revalidate: Instant,
    /// READY payload sent once at the start of the connection.
    ready_payload: Option<String>,
    /// Buffered frames to replay (seq > cursor) before tailing live events.
    replay_queue: std::collections::vec_deque::VecDeque<Arc<BufferedSseEvent>>,
    /// Live tail subscription to the channel.
    live_rx: broadcast::Receiver<Arc<BufferedSseEvent>>,
    /// Highest sequence already emitted to this connection, to suppress
    /// duplicates between the replay snapshot and the live tail.
    last_emitted: u64,
}

/// Decide whether an attached SSE stream must be torn down.
///
/// Enforces the hard `MAX_STREAM_LIFETIME` and, at most once per
/// `STREAM_REVALIDATE_INTERVAL`, re-checks that the login session the stream was
/// authorized under is still live (not logged out, revoked, or expired). A
/// transient DB error does NOT kill a live stream — the lifetime cap still
/// bounds it.
async fn stream_should_terminate(st: &mut RealtimeStreamState) -> bool {
    if st.started_at.elapsed() >= MAX_STREAM_LIFETIME {
        return true;
    }
    if Instant::now() < st.next_revalidate {
        return false;
    }
    st.next_revalidate = Instant::now() + STREAM_REVALIDATE_INTERVAL;

    let Some(session_id) = st.auth_session_id.as_deref() else {
        return false;
    };
    match paracord_db::sessions::get_session_by_id(&st.app_state.db, session_id).await {
        Ok(Some(row)) => {
            row.user_id != st.user_id || row.revoked_at.is_some() || row.expires_at <= Utc::now()
        }
        Ok(None) => true,
        Err(err) => {
            tracing::warn!("sse: session revalidation failed for {session_id}: {err}");
            false
        }
    }
}

/// Extract the channel_id from a guild event payload, checking both
/// `channel_id` field and the `id` field for channel lifecycle events.
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

/// Check whether this SSE session user can see a channel within a guild.
async fn can_receive_channel_event(
    state: &AppState,
    guild_id: i64,
    channel_id: i64,
    owner_id: i64,
    user_id: i64,
) -> bool {
    let Ok(perms) = paracord_core::permissions::compute_channel_permissions_cached(
        &state.permission_cache,
        &state.db,
        guild_id,
        channel_id,
        owner_id,
        user_id,
    )
    .await
    else {
        return false;
    };

    perms.contains(Permissions::VIEW_CHANNEL)
}

/// Mint a short-lived single-use ticket the client exchanges for the SSE stream.
/// Requires a Bearer-authenticated user; the ticket is bound to that user id so
/// the raw access token never has to travel in the stream's query string.
pub async fn create_stream_ticket(
    State(_state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let tickets = stream_tickets();
    // Opportunistic sweep of expired tickets so the map cannot grow unbounded
    // from tickets that are minted but never redeemed.
    tickets.retain(|_, (_, _, minted_at)| minted_at.elapsed() < STREAM_TICKET_TTL);
    if tickets.len() >= MAX_PENDING_STREAM_TICKETS {
        return Err(ApiError::RateLimited(1));
    }

    let ticket = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    tickets.insert(
        ticket.clone(),
        (auth.user_id, auth.session_id.clone(), Instant::now()),
    );

    Ok(Json(json!({ "ticket": ticket })))
}

pub async fn create_session(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    // Owner-bound id: stable per login session (so reconnects reuse the same
    // channel, buffer and cursor) but unforgeable by anyone else.
    let session_base = auth
        .session_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let session_id = mint_session_id(&state, auth.user_id, &session_base);
    let guild_rows = paracord_db::guilds::get_user_guilds(&state.db, auth.user_id.into())
        .await
        .unwrap_or_default();
    let guild_ids: Vec<i64> = guild_rows.iter().map(|g| g.id).collect();
    let guild_owner_ids: HashMap<i64, i64> =
        guild_rows.iter().map(|g| (g.id, g.owner_id)).collect();

    // Establish (or reuse) the persistent session channel so that events are
    // buffered from this point forward, and advertise the true current cursor
    // rather than a cosmetic 0. Reconnecting with this cursor replays any events
    // emitted during the gap.
    let channel = get_or_create_channel(
        &state,
        &session_id,
        auth.user_id,
        &guild_ids,
        guild_owner_ids,
    )?;

    Ok(Json(json!({
        "session_id": session_id,
        "cursor": channel.current_sequence(),
        "user_id": auth.user_id.to_string(),
        "guild_ids": guild_ids.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
        "mode": "sse_http_v2",
    })))
}

pub async fn stream_events(
    State(state): State<AppState>,
    Query(query): Query<RealtimeEventsQuery>,
) -> Result<Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    // The stream authenticates solely via a single-use ticket (minted by
    // `POST /api/v1/stream/ticket`), never the raw access token in the query
    // string. Reject missing/expired/reused tickets.
    let (user_id, auth_session_id) = query
        .ticket
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .and_then(consume_stream_ticket)
        .ok_or(ApiError::Unauthorized)?;

    // Cap concurrent attachments per user. `MAX_SESSION_CHANNELS_PER_USER` only
    // caps channels; many streams can attach to one channel and each attach
    // deep-clones up to MAX_REPLAY_EVENTS rendered frames.
    if !try_acquire_attachment_slot(user_id) {
        return Err(ApiError::RateLimited(1));
    }
    let attach_guard = AttachmentGuard {
        user_id,
        state: state.clone(),
    };

    // Attaching the stream is the moment this person is reachable — publish it,
    // so everyone sharing a space or a friendship with them sees them arrive.
    mark_stream_user_online(&state, user_id).await;

    // A supplied `session_id` is only honored when this server issued it to the
    // ticket's user; anything else is refused outright rather than silently
    // swapped for a fresh id, so a takeover attempt is a visible 403 instead of
    // a working stream. Callers that supply nothing get an id minted here,
    // keyed off their login session so it matches what `create_session` mints.
    let session_id = match query.session_id.filter(|sid| !sid.trim().is_empty()) {
        Some(supplied) => {
            if !session_id_issued_to(&state, &supplied, user_id) {
                tracing::warn!(
                    user_id,
                    "realtime: stream requested with a session id not issued to this user"
                );
                return Err(ApiError::Forbidden);
            }
            supplied
        }
        None => {
            let base = auth_session_id
                .clone()
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            mint_session_id(&state, user_id, &base)
        }
    };
    let guild_rows = paracord_db::guilds::get_user_guilds(&state.db, user_id.into())
        .await
        .unwrap_or_default();
    let guild_ids: Vec<i64> = guild_rows.iter().map(|g| g.id).collect();
    let guild_owner_ids: HashMap<i64, i64> =
        guild_rows.iter().map(|g| (g.id, g.owner_id)).collect();

    // Attach to (or lazily establish) the persistent session channel. The
    // channel's background pump keeps buffering events across reconnect gaps, so
    // the ring buffer already holds anything emitted since `create_session`.
    let channel = get_or_create_channel(&state, &session_id, user_id, &guild_ids, guild_owner_ids)?;

    // Count this connection against the channel for the whole stream lifetime so
    // the sweep cannot reclaim the channel while we are attached (even if idle).
    let conn_guard = ConnectionGuard::new(Arc::clone(&channel));

    // Subscribe to the live tail BEFORE snapshotting the replay window so no
    // event can slip between the two without appearing in one of them.
    let live_rx = channel.live_tx.subscribe();

    // Resolve the resume cursor. If the caller resumes from a cursor older than
    // the oldest buffered event, the gap is unrecoverable: signal a full resync
    // (op 9, already understood by the client as "invalid session") instead of
    // silently dropping the missed events.
    let cursor = query.cursor.unwrap_or(0);
    let mut resync_required = false;
    if cursor > 0 {
        if let Some(oldest) = channel.oldest_sequence() {
            if oldest > cursor.saturating_add(1) {
                resync_required = true;
            }
        } else if channel.current_sequence() > cursor {
            // Events were dispatched past the cursor but nothing remains
            // buffered (aged/evicted): cannot replay the gap.
            resync_required = true;
        }
    }

    // Snapshot the frames to replay in order, and decide the sequence the client
    // should track after READY (`ready_seq`).
    //
    // - Healthy resume: replay `seq > cursor`; READY carries `cursor`, and the
    //   replay frames then advance the client cursor up to the buffer head. If
    //   the connection drops right after READY, the client resumes from the same
    //   valid `cursor`.
    // - Forced resync: skip replay (the READY payload is the authoritative full
    //   state) and advertise the channel's current sequence so the client's
    //   cursor jumps forward to "now". Without this the client would keep
    //   resuming from a stale cursor that predates the buffer and loop on op-9
    //   forever.
    let (replay_queue, last_emitted, ready_seq): (VecDeque<Arc<BufferedSseEvent>>, u64, u64) =
        if resync_required {
            let current = channel.current_sequence();
            (VecDeque::new(), current, current)
        } else {
            let queue: VecDeque<Arc<BufferedSseEvent>> =
                channel.replay_since(cursor).into_iter().collect();
            let last = queue.back().map(|e| e.sequence).unwrap_or(cursor);
            (queue, last, cursor)
        };

    let ready_payload = build_ready_payload(&state, user_id, &session_id, ready_seq)
        .await
        .to_string();

    let stream_state = RealtimeStreamState {
        channel,
        _conn_guard: conn_guard,
        _attach_guard: attach_guard,
        app_state: state.clone(),
        user_id,
        auth_session_id,
        started_at: Instant::now(),
        next_revalidate: Instant::now() + STREAM_REVALIDATE_INTERVAL,
        ready_payload: Some(ready_payload),
        replay_queue,
        live_rx,
        last_emitted,
    };

    // Frames emitted ahead of the live tail: READY first, then an optional
    // resync marker, then the replay snapshot.
    let mut prelude: VecDeque<(String, String)> = VecDeque::new();
    if resync_required {
        // op 9 = invalid session / full resync required (matches WS + client).
        prelude.push_back((
            "resync".to_string(),
            json!({
                "op": 9,
                "d": { "reason": "replay_gap", "resumable": false },
            })
            .to_string(),
        ));
    }

    let stream_state = (stream_state, prelude);

    let event_stream = stream::unfold(stream_state, |(mut st, mut prelude)| async move {
        // 1. READY payload (full state) exactly once.
        if let Some(payload) = st.ready_payload.take() {
            let event = Event::default().event("gateway").id("1").data(payload);
            return Some((Ok(event), (st, prelude)));
        }

        // 2. Optional resync marker.
        if let Some((id, data)) = prelude.pop_front() {
            let event = Event::default().event("gateway").id(id).data(data);
            return Some((Ok(event), (st, prelude)));
        }

        // 3. Replay buffered gap events (seq > cursor), in order.
        if let Some(buffered) = st.replay_queue.pop_front() {
            let event = Event::default()
                .event("gateway")
                .id(buffered.sequence.to_string())
                .data(buffered.data.clone());
            return Some((Ok(event), (st, prelude)));
        }

        // 4. Tail live events, skipping any the replay snapshot already sent.
        loop {
            // An established stream authenticates exactly once, at attach time.
            // Without this check logout, token revocation and bans never
            // terminate it. The select also wakes an idle stream so the
            // lifetime/revalidation bound applies even with no traffic.
            if stream_should_terminate(&mut st).await {
                return None;
            }
            let recv = tokio::time::timeout(STREAM_REVALIDATE_INTERVAL, st.live_rx.recv()).await;
            let Ok(recv) = recv else {
                // Idle tick: loop back into the revalidation check above.
                continue;
            };
            match recv {
                Ok(buffered) => {
                    if buffered.sequence <= st.last_emitted {
                        continue;
                    }
                    st.last_emitted = buffered.sequence;
                    st.channel.touch();
                    let event = Event::default()
                        .event("gateway")
                        .id(buffered.sequence.to_string())
                        .data(buffered.data.clone());
                    return Some((Ok(event), (st, prelude)));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    // This connection's live tail overflowed. The pump already
                    // records an op-7 reconnect frame into the ring buffer on
                    // its own lag, so just resync from the buffer here.
                    for buffered in st.channel.replay_since(st.last_emitted) {
                        st.replay_queue.push_back(buffered);
                    }
                    if let Some(buffered) = st.replay_queue.pop_front() {
                        st.last_emitted = buffered.sequence;
                        let event = Event::default()
                            .event("gateway")
                            .id(buffered.sequence.to_string())
                            .data(buffered.data.clone());
                        return Some((Ok(event), (st, prelude)));
                    }
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    return None;
                }
            }
        }
    });

    Ok(Sse::new(event_stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

pub async fn post_command(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<RealtimeCommandRequest>,
) -> Result<Json<Value>, ApiError> {
    if req.command_id.trim().is_empty() {
        return Err(ApiError::BadRequest("command_id is required".into()));
    }

    // Mirror the gateway's per-user governors; without this the HTTP bus was an
    // unmetered path to the same presence/typing/voice handlers.
    check_command_rate_limit(auth.user_id, req.command_type.as_str())?;

    match req.command_type.as_str() {
        "presence_update" => {
            // Refuse an oversized payload up front: this value is retained in
            // process-global state and re-broadcast, so silently truncating a
            // multi-megabyte blob would hide a misbehaving client.
            if serde_json::to_vec(&req.payload)
                .map(|v| v.len())
                .unwrap_or(0)
                > MAX_PRESENCE_PAYLOAD_BYTES
            {
                return Err(ApiError::BadRequest(format!(
                    "presence payload exceeds {MAX_PRESENCE_PAYLOAD_BYTES} bytes"
                )));
            }
            let status = req.payload.get("status").and_then(|v| v.as_str());
            let activities = req.payload.get("activities");
            let custom_status = req.payload.get("custom_status").and_then(|v| v.as_str());
            let presence_payload =
                build_presence_payload(auth.user_id, status, activities, custom_status);
            state
                .user_presences
                .insert(auth.user_id, presence_payload.clone());

            let recipients = presence_recipient_ids(&state, auth.user_id).await;
            state
                .event_bus
                .dispatch_to_users("PRESENCE_UPDATE", presence_payload, recipients);
        }
        "voice_state_update" => {
            let payload: VoiceStateCommandPayload = serde_json::from_value(req.payload.clone())
                .map_err(|e| {
                    ApiError::BadRequest(format!("invalid voice_state_update payload: {e}"))
                })?;
            let requested_guild_id = parse_i64_id(payload.guild_id.as_deref());
            let channel_id = parse_i64_id(payload.channel_id.as_deref());
            let self_mute = payload.self_mute.unwrap_or(false);
            let self_deaf = payload.self_deaf.unwrap_or(false);
            let self_video = payload.self_video.unwrap_or(false);

            if let Some(channel_id) = channel_id {
                let channel = paracord_db::channels::get_channel(&state.db, channel_id)
                    .await
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                    .ok_or(ApiError::NotFound)?;
                if channel.channel_type != 2 && channel.channel_type != 13 {
                    return Err(ApiError::BadRequest("Not a voice channel".into()));
                }
                let guild_id = channel.guild_id().ok_or(ApiError::BadRequest(
                    "Voice is only supported in guild channels".into(),
                ))?;
                if requested_guild_id.is_some() && requested_guild_id != Some(guild_id) {
                    return Err(ApiError::BadRequest("guild_id/channel_id mismatch".into()));
                }
                paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id)
                    .await?;
                let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
                    .await
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                    .ok_or(ApiError::NotFound)?;
                let perms = paracord_core::permissions::compute_channel_permissions(
                    &state.db,
                    guild_id,
                    channel_id,
                    guild.owner_id,
                    auth.user_id,
                )
                .await?;
                if !perms.contains(Permissions::VIEW_CHANNEL)
                    || !perms.contains(Permissions::CONNECT)
                {
                    return Err(ApiError::Forbidden);
                }

                let existing_voice_state = paracord_db::voice_states::get_user_voice_state(
                    &state.db,
                    auth.user_id,
                    Some(guild_id),
                )
                .await
                .ok()
                .flatten();
                let same_channel = existing_voice_state
                    .as_ref()
                    .is_some_and(|voice_state| voice_state.channel_id == channel_id);
                let suppress = if channel.channel_type == 13 {
                    if same_channel {
                        existing_voice_state
                            .as_ref()
                            .is_some_and(|voice_state| voice_state.suppress)
                    } else {
                        !(perms.contains(Permissions::SPEAK)
                            && perms.contains(Permissions::MANAGE_CHANNELS))
                    }
                } else {
                    false
                };

                let session_id = auth
                    .session_id
                    .clone()
                    .unwrap_or_else(|| Uuid::new_v4().to_string());
                let _ = paracord_db::voice_states::upsert_voice_state(
                    &state.db,
                    auth.user_id,
                    Some(guild_id),
                    channel_id,
                    &session_id,
                )
                .await;
                if !same_channel {
                    let _ = paracord_db::voice_states::update_suppress(
                        &state.db,
                        auth.user_id,
                        Some(guild_id),
                        suppress,
                    )
                    .await;
                }
                state
                    .voice
                    .update_self_mute(channel_id, auth.user_id, self_mute)
                    .await;
                state
                    .voice
                    .update_self_deaf(channel_id, auth.user_id, self_deaf)
                    .await;
                state
                    .voice
                    .update_self_video(channel_id, auth.user_id, self_video)
                    .await;

                let current_self_stream = state
                    .voice
                    .get_participant_stream_state(channel_id, auth.user_id)
                    .await;
                let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
                    .await
                    .ok()
                    .flatten();
                state.event_bus.dispatch(
                    "VOICE_STATE_UPDATE",
                    json!({
                        "user_id": auth.user_id.to_string(),
                        "channel_id": channel_id.to_string(),
                        "guild_id": Some(guild_id.to_string()),
                        "self_mute": self_mute,
                        "self_deaf": self_deaf,
                        "self_stream": current_self_stream,
                        "self_video": self_video,
                        "suppress": suppress,
                        "request_to_speak_at": existing_voice_state
                            .as_ref()
                            .and_then(|voice_state| voice_state.request_to_speak_at)
                            .map(|value| value.to_rfc3339()),
                        "mute": false,
                        "deaf": false,
                        "username": user.as_ref().map(|u| u.username.as_str()),
                        "avatar_hash": user.as_ref().and_then(|u| u.avatar_hash.as_deref()),
                    }),
                    Some(guild_id),
                );
            } else {
                let existing = paracord_db::voice_states::get_user_voice_state(
                    &state.db,
                    auth.user_id,
                    requested_guild_id,
                )
                .await
                .ok()
                .flatten();
                if let Some(existing_state) = existing {
                    let _ = paracord_db::voice_states::remove_voice_state(
                        &state.db,
                        auth.user_id,
                        existing_state.guild_id(),
                    )
                    .await;
                    let _ = state
                        .voice
                        .leave_room(existing_state.channel_id, auth.user_id)
                        .await;
                    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
                        .await
                        .ok()
                        .flatten();
                    state.event_bus.dispatch(
                        "VOICE_STATE_UPDATE",
                        json!({
                            "user_id": auth.user_id.to_string(),
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
                            "username": user.as_ref().map(|u| u.username.as_str()),
                            "avatar_hash": user.as_ref().and_then(|u| u.avatar_hash.as_deref()),
                        }),
                        existing_state.guild_id(),
                    );
                }
            }
        }
        "typing_start" => {
            let payload: TypingStartCommandPayload = serde_json::from_value(req.payload.clone())
                .map_err(|e| ApiError::BadRequest(format!("invalid typing_start payload: {e}")))?;
            let channel_id = payload
                .channel_id
                .parse::<i64>()
                .map_err(|_| ApiError::BadRequest("invalid channel_id".into()))?;
            let channel = paracord_db::channels::get_channel(&state.db, channel_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                .ok_or(ApiError::NotFound)?;
            let guild_id = channel.guild_id();

            let allowed = if let Some(gid) = guild_id {
                let member_ok =
                    paracord_core::permissions::ensure_guild_member(&state.db, gid, auth.user_id)
                        .await
                        .is_ok();
                if !member_ok {
                    false
                } else {
                    let guild = paracord_db::guilds::get_guild(&state.db, gid)
                        .await
                        .ok()
                        .flatten();
                    if let Some(guild) = guild {
                        let perms = paracord_core::permissions::compute_channel_permissions(
                            &state.db,
                            gid,
                            channel_id,
                            guild.owner_id,
                            auth.user_id,
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
                }
            } else {
                paracord_db::dms::is_dm_recipient(&state.db, channel_id, auth.user_id)
                    .await
                    .unwrap_or(false)
            };
            if !allowed {
                return Err(ApiError::Forbidden);
            }

            let typing_payload = json!({
                "channel_id": channel_id.to_string(),
                "user_id": auth.user_id.to_string(),
                "timestamp": Utc::now().timestamp(),
            });
            if guild_id.is_none() {
                let recipient_ids = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
                    .await
                    .unwrap_or_default();
                state
                    .event_bus
                    .dispatch_to_users("TYPING_START", typing_payload, recipient_ids);
            } else {
                state
                    .event_bus
                    .dispatch("TYPING_START", typing_payload, guild_id);
            }
        }
        _ => {
            return Err(ApiError::BadRequest("Unsupported command type".into()));
        }
    }

    Ok(Json(json!({
        "ok": true,
        "command_id": req.command_id,
        "accepted_at": Utc::now().timestamp_millis(),
    })))
}
