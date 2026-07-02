use axum::{
    extract::{Query, State},
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use chrono::Utc;
use dashmap::DashMap;
use futures_util::stream;
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::error::ApiError;
use crate::middleware::AuthUser;

#[derive(Deserialize)]
pub struct RealtimeEventsQuery {
    pub session_id: Option<String>,
    pub cursor: Option<u64>,
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
/// Max age a session channel is kept alive with no fresh events before the
/// background sweep tears it down (matches the WS replay window).
const MAX_REPLAY_AGE: Duration = Duration::from_secs(300);
/// How often the background sweep runs.
const REPLAY_SWEEP_INTERVAL: Duration = Duration::from_secs(300);

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
        // is reclaimed.
        self.event_bus.unregister_session(&self.session_id);
        if let Ok(mut pump) = self.pump.lock() {
            if let Some(handle) = pump.take() {
                handle.abort();
            }
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
                            entry
                                .value()
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
/// The event-bus registration and pump spawn happen inside the DashMap `entry`
/// so that exactly one channel (and one registration) exists per session id
/// even under concurrent connect races.
fn get_or_create_channel(
    state: &AppState,
    session_id: &str,
    user_id: i64,
    guild_ids: &[i64],
    guild_owner_ids: HashMap<i64, i64>,
) -> Arc<SessionChannel> {
    let entry = session_channels()
        .entry(session_id.to_string())
        .or_insert_with(|| {
            let receiver =
                state
                    .event_bus
                    .register_session(session_id.to_string(), user_id, guild_ids);
            let (live_tx, _) = broadcast::channel::<Arc<BufferedSseEvent>>(MAX_REPLAY_EVENTS);
            let channel = Arc::new(SessionChannel {
                session_id: session_id.to_string(),
                event_bus: state.event_bus.clone(),
                next_sequence: AtomicU64::new(0),
                buffer: Mutex::new(VecDeque::new()),
                live_tx,
                last_active: Mutex::new(Instant::now()),
                pump: Mutex::new(None),
            });

            let pump_handle = tokio::spawn(session_pump(
                state.clone(),
                session_id.to_string(),
                user_id,
                guild_owner_ids,
                Arc::clone(&channel),
                receiver,
            ));
            if let Ok(mut pump) = channel.pump.lock() {
                *pump = Some(pump_handle);
            }
            channel
        });

    let channel = Arc::clone(entry.value());
    drop(entry);
    channel.touch();
    channel
}

/// Background pump: owns the event-bus receiver for a session's whole lifetime,
/// applies permission filtering + guild-scope mutations, assigns sequences, and
/// records rendered frames into the session's ring buffer.
async fn session_pump(
    state: AppState,
    session_id: String,
    user_id: i64,
    mut guild_owner_ids: HashMap<i64, i64>,
    channel: Arc<SessionChannel>,
    mut receiver: broadcast::Receiver<paracord_core::events::ServerEvent>,
) {
    loop {
        match receiver.recv().await {
            Ok(event) => {
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
                    if let Ok(Some(guild)) = paracord_db::guilds::get_guild(&state.db, gid).await {
                        guild_owner_ids.insert(gid, guild.owner_id);
                    }
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

async fn build_ready_payload(state: &AppState, user_id: i64, session_id: &str) -> Value {
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

        guilds_json.push(json!({
            "id": guild.id.to_string(),
            "name": guild.name,
            "owner_id": guild.owner_id.to_string(),
            "icon_hash": guild.icon_hash,
            "member_count": member_count,
            "channels": [],
            "voice_states": voice_states_json,
            "presences": [],
            "lazy": true,
        }));
    }

    json!({
        "event_id": 1u64,
        "op": 0,
        "t": "READY",
        "s": 1u64,
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

/// Extract the channel_id from a guild event payload, checking both
/// `channel_id` field and the `id` field for channel lifecycle events.
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

pub async fn create_session(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let session_id = auth
        .session_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
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
    );

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
    auth: AuthUser,
    Query(query): Query<RealtimeEventsQuery>,
) -> Result<Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let session_id = query
        .session_id
        .filter(|sid| !sid.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let guild_rows = paracord_db::guilds::get_user_guilds(&state.db, auth.user_id.into())
        .await
        .unwrap_or_default();
    let guild_ids: Vec<i64> = guild_rows.iter().map(|g| g.id).collect();
    let guild_owner_ids: HashMap<i64, i64> =
        guild_rows.iter().map(|g| (g.id, g.owner_id)).collect();

    // Attach to (or lazily establish) the persistent session channel. The
    // channel's background pump keeps buffering events across reconnect gaps, so
    // the ring buffer already holds anything emitted since `create_session`.
    let channel = get_or_create_channel(
        &state,
        &session_id,
        auth.user_id,
        &guild_ids,
        guild_owner_ids,
    );

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

    // Snapshot the frames to replay in order. When a resync is required we skip
    // replay entirely — the READY payload below is the authoritative full state.
    let replay_queue: VecDeque<Arc<BufferedSseEvent>> = if resync_required {
        VecDeque::new()
    } else {
        channel.replay_since(cursor).into_iter().collect()
    };
    let last_emitted = replay_queue.back().map(|e| e.sequence).unwrap_or(cursor);

    let ready_payload = build_ready_payload(&state, auth.user_id, &session_id)
        .await
        .to_string();

    let stream_state = RealtimeStreamState {
        channel,
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
            match st.live_rx.recv().await {
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

    match req.command_type.as_str() {
        "presence_update" => {
            let status = req
                .payload
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("online");
            let activities = req
                .payload
                .get("activities")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let custom_status = req
                .payload
                .get("custom_status")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let presence_payload = json!({
                "user_id": auth.user_id.to_string(),
                "status": status,
                "custom_status": custom_status,
                "activities": activities,
            });
            state
                .user_presences
                .insert(auth.user_id, presence_payload.clone());

            let mut recipients: std::collections::HashSet<i64> = std::collections::HashSet::new();
            recipients.insert(auth.user_id);
            if let Ok(guilds) =
                paracord_db::guilds::get_user_guilds(&state.db, auth.user_id.into()).await
            {
                for guild in guilds {
                    if let Ok(member_ids) =
                        paracord_db::members::get_guild_member_user_ids(&state.db, guild.id).await
                    {
                        recipients.extend(member_ids);
                    }
                }
            }
            if let Ok(friend_ids) =
                paracord_db::relationships::get_friend_user_ids(&state.db, auth.user_id).await
            {
                recipients.extend(friend_ids);
            }
            state.event_bus.dispatch_to_users(
                "PRESENCE_UPDATE",
                presence_payload,
                recipients.into_iter().collect(),
            );
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
                if channel.channel_type != 2 {
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
                        "suppress": false,
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
