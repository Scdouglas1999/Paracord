//! Availability coverage for the WebSocket gateway's inbound budgets.
//!
//! Every test here pins a bound that a *single* authenticated (or, for the
//! pre-auth cases, unauthenticated) socket could previously exceed without
//! limit: unmetered heartbeats, unmetered non-Text frames, an uncapped
//! `OP_MEDIA_KEY_ANNOUNCE` recipient array, `OP_REQUEST_GUILD_MEMBERS` riding the
//! shared message budget, connections-per-IP, and `user_presences` growth.
//!
//! Like `gateway_integration.rs`, these drive the internal seams against a real
//! in-memory SQLite database + `EventBus` + `AppState` instead of standing up an
//! HTTP upgrade. Rate limiters and connection counters are process-global, so
//! every test uses a freshly generated user id / IP string to keep its bucket
//! isolated from the rest of the binary.

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::extract::ws::Message;
use chrono::{Duration as ChronoDuration, Utc};
use dashmap::{DashMap, DashSet};
use futures_util::{Sink, Stream};
use paracord_core::{build_permission_cache, AppConfig, AppState, RuntimeSettings};
use paracord_media::{
    LiveKitConfig, LocalStorage, Storage, StorageConfig, StorageManager, VoiceManager,
};
use paracord_models::gateway::{
    EVENT_GUILD_MEMBERS_CHUNK, OP_HEARTBEAT, OP_HEARTBEAT_ACK, OP_IDENTIFY, OP_MEDIA_KEY_ANNOUNCE,
    OP_REQUEST_GUILD_MEMBERS,
};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::sync::{Notify, RwLock};

use paracord_ws::{
    run_session, test_acquire_ip_connection_slot, test_allow_gateway_handshake,
    test_mark_user_offline, test_max_connections_per_ip, test_max_control_frames_per_minute,
    test_max_guild_member_requests_per_minute, test_max_handshakes_per_minute_per_ip,
    test_max_heartbeats_per_minute, test_max_preauth_frames, test_release_ip_connection_slot,
    wait_for_identify_or_resume, Session, WsCompressor,
};

// ── Mock stream/sink ────────────────────────────────────────────────────────

struct MockClient {
    rx: UnboundedReceiver<Result<Message, axum::Error>>,
}

impl Stream for MockClient {
    type Item = Result<Message, axum::Error>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx)
    }
}

struct MockServer {
    tx: UnboundedSender<Message>,
}

impl Sink<Message> for MockServer {
    type Error = ();
    fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
        Poll::Ready(Ok(()))
    }
    fn start_send(self: Pin<&mut Self>, item: Message) -> Result<(), ()> {
        self.tx.send(item).map_err(|_| ())
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
        Poll::Ready(Ok(()))
    }
}

fn duplex() -> (
    MockClient,
    UnboundedSender<Result<Message, axum::Error>>,
    MockServer,
    UnboundedReceiver<Message>,
) {
    let (client_tx, client_rx) = tokio::sync::mpsc::unbounded_channel();
    let (server_tx, server_rx) = tokio::sync::mpsc::unbounded_channel();
    (
        MockClient { rx: client_rx },
        client_tx,
        MockServer { tx: server_tx },
        server_rx,
    )
}

fn text_frame(value: Value) -> Result<Message, axum::Error> {
    Ok(Message::Text(value.to_string().into()))
}

/// Every frame the gateway emitted, split into parsed Text payloads and a flag
/// for whether a Close frame was sent.
struct Emitted {
    texts: Vec<Value>,
    closed_with: Option<u16>,
}

fn drain(rx: &mut UnboundedReceiver<Message>) -> Emitted {
    let mut texts = Vec::new();
    let mut closed_with = None;
    while let Ok(msg) = rx.try_recv() {
        match msg {
            Message::Text(t) => {
                if let Ok(value) = serde_json::from_str::<Value>(&t) {
                    texts.push(value);
                }
            }
            Message::Close(Some(frame)) => closed_with = Some(frame.code),
            Message::Close(None) => closed_with = Some(1000),
            _ => {}
        }
    }
    Emitted { texts, closed_with }
}

impl Emitted {
    fn count_op(&self, op: u64) -> usize {
        self.texts
            .iter()
            .filter(|v| v.get("op").and_then(Value::as_u64) == Some(op))
            .count()
    }

    fn count_event(&self, event_type: &str) -> usize {
        self.texts
            .iter()
            .filter(|v| v.get("t").and_then(Value::as_str) == Some(event_type))
            .count()
    }
}

// ── AppState / fixtures ─────────────────────────────────────────────────────

struct TestEnv {
    state: AppState,
    db: paracord_db::DbPool,
    jwt_secret: String,
    _dirs: Vec<TempDir>,
}

async fn build_env() -> TestEnv {
    let jwt_secret = "ws-availability-secret".to_string();
    let db = paracord_db::create_pool("sqlite::memory:", 1)
        .await
        .expect("create pool");
    paracord_db::run_migrations(&db).await.expect("migrations");

    let storage_dir = tempfile::tempdir().unwrap();
    let media_dir = tempfile::tempdir().unwrap();
    let backup_dir = tempfile::tempdir().unwrap();

    let livekit = Arc::new(LiveKitConfig {
        api_key: "lk-test-key".to_string(),
        api_secret: "lk-test-secret".to_string(),
        url: "ws://localhost:7880".to_string(),
        http_url: "http://localhost:7880".to_string(),
    });

    let state = AppState {
        db: db.clone(),
        event_bus: paracord_core::events::EventBus::default(),
        config: AppConfig {
            jwt_secret: jwt_secret.clone(),
            jwt_expiry_seconds: 3600,
            registration_enabled: true,
            allow_username_login: false,
            require_email: true,
            storage_path: storage_dir.path().to_string_lossy().into_owned(),
            max_upload_size: 10 * 1024 * 1024,
            livekit_api_key: livekit.api_key.clone(),
            livekit_api_secret: livekit.api_secret.clone(),
            livekit_url: livekit.url.clone(),
            livekit_http_url: livekit.http_url.clone(),
            livekit_public_url: livekit.url.clone(),
            livekit_available: false,
            public_url: None,
            media_storage_path: media_dir.path().to_string_lossy().into_owned(),
            media_max_file_size: 10 * 1024 * 1024,
            media_p2p_threshold: 1024 * 1024,
            file_cryptor: None,
            totp_cryptor: None,
            backup_dir: backup_dir.path().to_string_lossy().into_owned(),
            database_url: "sqlite::memory:".to_string(),
            federation_max_events_per_peer_per_minute: None,
            federation_max_user_creates_per_peer_per_hour: None,
            native_media_enabled: false,
            native_media_port: 8443,
            native_media_max_participants: 50,
            native_media_e2ee_required: false,
            max_guild_storage_quota: 0,
            federation_file_cache_enabled: false,
            federation_file_cache_max_size: 0,
            federation_file_cache_ttl_hours: 0,
            tenor_api_key: None,
            require_email_verification: false,
            ai_provider: None,
            ai_base_url: None,
            ai_api_key: None,
            ai_model: None,
            ai_timeout_seconds: 20,
            bind_address: "127.0.0.1:0".to_string(),
            tls_enabled: false,
            tls_self_signed: false,
            auto_backup_enabled: false,
            auto_backup_interval_seconds: 86_400,
            federation_enabled: false,
            started_at: chrono::Utc::now(),
        },
        runtime: Arc::new(RwLock::new(RuntimeSettings::default())),
        voice: Arc::new(VoiceManager::new(livekit)),
        storage: Arc::new(StorageManager::new(StorageConfig {
            base_path: media_dir.path().to_path_buf(),
            max_file_size: 10 * 1024 * 1024,
            p2p_threshold: 1024 * 1024,
            allowed_extensions: None,
        })),
        storage_backend: Arc::new(Storage::Local(LocalStorage::new(storage_dir.path()))),
        shutdown: Arc::new(Notify::new()),
        online_users: Arc::new(DashSet::new()),
        user_presences: Arc::new(DashMap::new()),
        permission_cache: build_permission_cache(10_000),
        federation_service: None,
        member_index: Arc::new(paracord_core::member_index::MemberIndex::empty()),
        presence_manager: Arc::new(paracord_core::presence_manager::PresenceManager::new()),
        native_media: None,
        mfa_tickets: moka::future::Cache::builder()
            .max_capacity(10_000)
            .time_to_live(std::time::Duration::from_secs(300))
            .build(),
    };

    TestEnv {
        state,
        db,
        jwt_secret,
        _dirs: vec![storage_dir, media_dir, backup_dir],
    }
}

fn sid() -> i64 {
    paracord_util::snowflake::generate(1)
}

async fn make_user(env: &TestEnv) -> i64 {
    let user_id = sid();
    let uniq = uuid::Uuid::new_v4().simple().to_string();
    let username = format!("u{}", &uniq[..10]);
    let email = format!("{uniq}@example.com");
    let password_hash = paracord_core::auth::hash_password("hunter2password").unwrap();
    paracord_db::users::create_user(&env.db, user_id, &username, 1, &email, &password_hash)
        .await
        .expect("create user")
        .id
}

/// Create a user with a live auth session and return `(user_id, access_token)`.
async fn make_user_token(env: &TestEnv) -> (i64, String) {
    let user_id = make_user(env).await;
    let uniq = uuid::Uuid::new_v4().simple().to_string();
    let session_id = format!("auth-{uniq}");
    let jti = format!("jti-{uniq}");
    paracord_db::sessions::create_session(
        &env.db,
        &session_id,
        user_id,
        &format!("rh-{uniq}"),
        &jti,
        None,
        None,
        None,
        None,
        Utc::now() + ChronoDuration::days(1),
    )
    .await
    .expect("create session");

    let token = paracord_core::auth::create_session_token(
        user_id,
        None,
        &env.jwt_secret,
        3600,
        &session_id,
        &jti,
    )
    .expect("token");
    (user_id, token)
}

async fn make_guild(env: &TestEnv, guild_id: i64, owner_id: i64) -> i64 {
    paracord_db::guilds::create_guild(&env.db, guild_id, "Test Guild", owner_id, None)
        .await
        .expect("create guild");
    paracord_db::members::add_member(&env.db, owner_id, guild_id)
        .await
        .expect("add owner member");
    guild_id
}

fn session_for(user_id: i64, guilds: &[(i64, i64)]) -> Session {
    Session::new(
        user_id,
        guilds.iter().map(|(gid, _)| *gid).collect(),
        guilds.iter().copied().collect(),
    )
}

/// Unique per-test IP so the process-global per-IP buckets stay isolated. A
/// counter rather than a snowflake: two tests must never land in the same bucket.
fn unique_ip() -> String {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("198.51.{}.{}", (n / 254) % 254, (n % 254) + 1)
}

// ── Heartbeats ──────────────────────────────────────────────────────────────

/// `OP_HEARTBEAT` skipped the rate limiter entirely, so one socket could spin op
/// 1 as fast as it could write and get a JSON parse plus an ACK echo for each.
/// It now has its own budget, separate from the general message budget so a
/// client that exhausts that can still keep its socket alive.
#[tokio::test]
async fn heartbeat_flood_is_metered() {
    let env = build_env().await;
    let user_id = make_user(&env).await;
    let max = test_max_heartbeats_per_minute() as usize;

    let (client, tx, server, mut server_rx) = duplex();
    let over = max + 25;
    for _ in 0..over {
        tx.send(text_frame(json!({ "op": OP_HEARTBEAT }))).unwrap();
    }
    drop(tx);

    let _ = run_session(
        server,
        client,
        session_for(user_id, &[]),
        env.state.clone(),
        &WsCompressor::new(false),
    )
    .await;

    let emitted = drain(&mut server_rx);
    let acks = emitted.count_op(OP_HEARTBEAT_ACK as u64);
    assert!(
        acks < over,
        "an unbounded heartbeat flood must not be answered in full: {acks} acks for {over} beats"
    );
    // Exactly the budget, modulo the fraction of a cell the limiter replenishes
    // while the test runs.
    assert!(
        (max.saturating_sub(1)..=max).contains(&acks),
        "expected about {max} heartbeat acks, got {acks}"
    );
}

/// The bound has to be far above what a real client does: the gateway advertises
/// a ~41s heartbeat interval, so a legitimate socket sends ~1.5 per minute.
#[tokio::test]
async fn normal_heartbeat_cadence_is_never_limited() {
    let env = build_env().await;
    let user_id = make_user(&env).await;

    let (client, tx, server, mut server_rx) = duplex();
    // Two minutes' worth of heartbeats at the advertised interval, plus slack for
    // a client that re-beats immediately after a reconnect.
    let realistic = 10;
    for _ in 0..realistic {
        tx.send(text_frame(json!({ "op": OP_HEARTBEAT }))).unwrap();
    }
    drop(tx);

    let _ = run_session(
        server,
        client,
        session_for(user_id, &[]),
        env.state.clone(),
        &WsCompressor::new(false),
    )
    .await;

    assert_eq!(
        drain(&mut server_rx).count_op(OP_HEARTBEAT_ACK as u64),
        realistic,
        "a normal heartbeat cadence must be answered in full"
    );
}

// ── Non-Text frames ─────────────────────────────────────────────────────────

/// Post-auth, anything that was not a Text frame fell through `_ => {}` — parsed
/// by the websocket layer (and, for Ping, answered with an automatic Pong) but
/// never counted against any budget.
#[tokio::test]
async fn non_text_frame_flood_closes_the_socket() {
    let env = build_env().await;
    let user_id = make_user(&env).await;
    let max = test_max_control_frames_per_minute() as usize;

    let (client, tx, server, mut server_rx) = duplex();
    for _ in 0..(max + 5) {
        tx.send(Ok(Message::Ping(Vec::new().into()))).unwrap();
    }
    // A Text frame after the flood: if the socket were still open it would be
    // answered, which would show the loop had not terminated.
    tx.send(text_frame(json!({ "op": OP_HEARTBEAT }))).unwrap();
    drop(tx);

    let _ = run_session(
        server,
        client,
        session_for(user_id, &[]),
        env.state.clone(),
        &WsCompressor::new(false),
    )
    .await;

    let emitted = drain(&mut server_rx);
    assert_eq!(
        emitted.closed_with,
        Some(1008),
        "a control-frame flood must close the socket"
    );
    assert_eq!(
        emitted.count_op(OP_HEARTBEAT_ACK as u64),
        0,
        "the socket must be gone before the trailing text frame is served"
    );
}

/// The server pings every 20s and clients answer in kind, so a real connection
/// emits single-digit control frames per minute. Those must pass untouched.
#[tokio::test]
async fn normal_control_frame_rate_keeps_the_socket_open() {
    let env = build_env().await;
    let user_id = make_user(&env).await;

    let (client, tx, server, mut server_rx) = duplex();
    for _ in 0..10 {
        tx.send(Ok(Message::Pong(Vec::new().into()))).unwrap();
    }
    tx.send(text_frame(json!({ "op": OP_HEARTBEAT }))).unwrap();
    drop(tx);

    let _ = run_session(
        server,
        client,
        session_for(user_id, &[]),
        env.state.clone(),
        &WsCompressor::new(false),
    )
    .await;

    let emitted = drain(&mut server_rx);
    assert_eq!(
        emitted.closed_with, None,
        "a normal pong rate must not close"
    );
    assert_eq!(
        emitted.count_op(OP_HEARTBEAT_ACK as u64),
        1,
        "the socket must still serve traffic after normal control frames"
    );
}

// ── Pre-auth budget ─────────────────────────────────────────────────────────

/// The pre-auth frame budget only counted Text frames, so binary and control
/// frames were free: an unauthenticated socket could hold the handshake open for
/// the full 30s identify timeout without spending any of it.
#[tokio::test]
async fn preauth_budget_counts_non_text_frames() {
    let env = build_env().await;
    let (_user_id, token) = make_user_token(&env).await;
    let max = test_max_preauth_frames() as usize;

    let (mut client, tx, _server, _server_rx) = duplex();
    for _ in 0..max {
        tx.send(Ok(Message::Binary(vec![0u8; 8].into()))).unwrap();
    }
    tx.send(text_frame(
        json!({ "op": OP_IDENTIFY, "d": { "token": token } }),
    ))
    .unwrap();
    drop(tx);

    assert!(
        wait_for_identify_or_resume(&mut client, &env.state)
            .await
            .is_none(),
        "a socket that burned its pre-auth budget on non-text frames must be refused"
    );
}

/// One IDENTIFY is all a real client sends; the budget must not interfere.
#[tokio::test]
async fn immediate_identify_is_never_refused() {
    let env = build_env().await;
    let (user_id, token) = make_user_token(&env).await;

    let (mut client, tx, _server, _server_rx) = duplex();
    tx.send(text_frame(
        json!({ "op": OP_IDENTIFY, "d": { "token": token } }),
    ))
    .unwrap();
    drop(tx);

    let (session, resumed, _) = wait_for_identify_or_resume(&mut client, &env.state)
        .await
        .expect("a first-frame IDENTIFY must be accepted");
    assert_eq!(session.user_id, user_id);
    assert!(!resumed);
}

// ── OP_REQUEST_GUILD_MEMBERS ────────────────────────────────────────────────

/// Each request reads and serializes up to 1000 member rows, which is far too
/// expensive to leave on the shared 240/min message budget.
#[tokio::test]
async fn guild_member_requests_are_metered() {
    let env = build_env().await;
    let user_id = make_user(&env).await;
    let guild_id = make_guild(&env, sid(), user_id).await;
    let max = test_max_guild_member_requests_per_minute() as usize;

    let (client, tx, server, mut server_rx) = duplex();
    let over = max + 5;
    for _ in 0..over {
        tx.send(text_frame(json!({
            "op": OP_REQUEST_GUILD_MEMBERS,
            "d": { "guild_id": guild_id.to_string() }
        })))
        .unwrap();
    }
    drop(tx);

    let _ = run_session(
        server,
        client,
        session_for(user_id, &[(guild_id, user_id)]),
        env.state.clone(),
        &WsCompressor::new(false),
    )
    .await;

    let emitted = drain(&mut server_rx);
    let chunks = emitted.count_event(EVENT_GUILD_MEMBERS_CHUNK);
    assert!(
        chunks < over,
        "member-chunk requests must not all be served: {chunks} of {over}"
    );
    assert!(
        (max.saturating_sub(1)..=max).contains(&chunks),
        "expected about {max} member chunks, got {chunks}"
    );
    assert!(
        emitted.count_event("RATE_LIMIT") > 0,
        "the client must be told it was limited"
    );
}

/// Opening a couple of member lists is well inside the budget.
#[tokio::test]
async fn a_handful_of_member_requests_are_all_served() {
    let env = build_env().await;
    let user_id = make_user(&env).await;
    let guild_id = make_guild(&env, sid(), user_id).await;

    let (client, tx, server, mut server_rx) = duplex();
    for _ in 0..5 {
        tx.send(text_frame(json!({
            "op": OP_REQUEST_GUILD_MEMBERS,
            "d": { "guild_id": guild_id.to_string() }
        })))
        .unwrap();
    }
    drop(tx);

    let _ = run_session(
        server,
        client,
        session_for(user_id, &[(guild_id, user_id)]),
        env.state.clone(),
        &WsCompressor::new(false),
    )
    .await;

    let emitted = drain(&mut server_rx);
    assert_eq!(emitted.count_event(EVENT_GUILD_MEMBERS_CHUNK), 5);
    assert_eq!(emitted.count_event("RATE_LIMIT"), 0);
}

// ── OP_MEDIA_KEY_ANNOUNCE ───────────────────────────────────────────────────

/// Put two users into the same voice room via the DB fallback path the handler
/// uses when native media is off, and return `(sender, recipient, channel_id)`.
///
/// The handler resolves the sender with `get_user_voice_state(.., None)` and then
/// the room with `get_guild_voice_states(guild_id().unwrap_or(0))`, so the room
/// has to live under space id 0 for both lookups to agree.
async fn make_voice_room(env: &TestEnv) -> (i64, i64, i64) {
    let sender = make_user(env).await;
    let recipient = make_user(env).await;
    let space_id = 0i64;
    if paracord_db::guilds::get_guild(&env.db, space_id)
        .await
        .ok()
        .flatten()
        .is_none()
    {
        paracord_db::guilds::create_guild(&env.db, space_id, "Voice Space", sender, None)
            .await
            .expect("create space");
    }
    let channel_id = sid();
    paracord_db::channels::create_channel(&env.db, channel_id, space_id, "vc", 2, 0, None, None)
        .await
        .expect("create voice channel");
    for user_id in [sender, recipient] {
        paracord_db::members::add_member(&env.db, user_id, space_id)
            .await
            .expect("add member");
        paracord_db::voice_states::upsert_voice_state(
            &env.db,
            user_id,
            Some(space_id),
            channel_id,
            &format!("vs-{user_id}"),
        )
        .await
        .expect("upsert voice state");
    }
    (sender, recipient, channel_id)
}

/// `WS_MEDIA_KEY_RECIPIENTS_FLOOR` (64) vs the test config's
/// `native_media_max_participants` (50): the handler takes the larger.
const WS_MEDIA_KEY_RECIPIENT_CAP: usize = 64;

fn announce_frame(sender: i64, recipient: i64, keys: usize) -> Result<Message, axum::Error> {
    let encrypted_keys: Vec<Value> = (0..keys)
        .map(|_| json!({ "recipient_user_id": recipient, "ciphertext": [1u8, 2, 3] }))
        .collect();
    text_frame(json!({
        "op": OP_MEDIA_KEY_ANNOUNCE,
        "d": { "user_id": sender, "epoch": 1, "encrypted_keys": encrypted_keys }
    }))
}

/// The recipient array was walked uncapped, emitting a log line *and* an
/// event-bus publish per element — thousands of both from one 32 KiB frame.
#[tokio::test]
async fn oversized_media_key_announce_is_rejected_whole() {
    let env = build_env().await;
    let (sender, recipient, _channel_id) = make_voice_room(&env).await;

    // Watch the recipient's user-targeted event stream.
    let mut probe = env
        .state
        .event_bus
        .register_session(format!("probe-{}", uuid::Uuid::new_v4()), recipient, &[])
        .expect("register probe session");

    // The cap is the configured room size floored at 64; the test config allows
    // 50, so 65 is exactly one recipient past the bound.
    let over_cap = WS_MEDIA_KEY_RECIPIENT_CAP + 1;
    let (client, tx, server, _server_rx) = duplex();
    tx.send(announce_frame(sender, recipient, over_cap))
        .unwrap();
    drop(tx);

    let _ = run_session(
        server,
        client,
        session_for(sender, &[]),
        env.state.clone(),
        &WsCompressor::new(false),
    )
    .await;

    // Specifically `Empty`, not merely `Err`: a partial fan-out large enough to
    // overrun the probe's queue would also surface as `Err(Lagged)`.
    assert!(
        matches!(
            probe.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ),
        "an announce whose recipient list exceeds the room cap must be dropped whole, \
         not fanned out one publish at a time"
    );
}

/// A real announce — one key per other participant — must still be delivered.
#[tokio::test]
async fn in_cap_media_key_announce_is_delivered() {
    let env = build_env().await;
    let (sender, recipient, _channel_id) = make_voice_room(&env).await;

    let mut probe = env
        .state
        .event_bus
        .register_session(format!("probe-{}", uuid::Uuid::new_v4()), recipient, &[])
        .expect("register probe session");

    // Exactly at the cap: a full room's worth of per-recipient keys must still
    // go out, so the bound cannot be tightened into breaking real E2EE rooms.
    let (client, tx, server, _server_rx) = duplex();
    tx.send(announce_frame(
        sender,
        recipient,
        WS_MEDIA_KEY_RECIPIENT_CAP,
    ))
    .unwrap();
    drop(tx);

    let _ = run_session(
        server,
        client,
        session_for(sender, &[]),
        env.state.clone(),
        &WsCompressor::new(false),
    )
    .await;

    let mut delivered = 0usize;
    while let Ok(event) = probe.try_recv() {
        assert_eq!(event.event_type, "MEDIA_KEY_DELIVER");
        delivered += 1;
    }
    assert_eq!(
        delivered, WS_MEDIA_KEY_RECIPIENT_CAP,
        "a within-cap announce must reach its recipient in full"
    );
}

// ── Per-IP bounds ───────────────────────────────────────────────────────────

/// Only the *pre-auth* handshake budget was ever bucketed by IP; once a socket
/// authenticated it held a global slot with nothing but the per-user cap of 5
/// standing between one source address and the whole 2000-slot pool.
#[test]
fn authenticated_connections_are_capped_per_ip() {
    let ip = unique_ip();
    let max = test_max_connections_per_ip();

    for i in 0..max {
        assert!(
            test_acquire_ip_connection_slot(Some(&ip)),
            "connection {i} from one IP should fit inside the cap of {max}"
        );
    }
    assert!(
        !test_acquire_ip_connection_slot(Some(&ip)),
        "the connection past the per-IP cap must be refused"
    );

    // Releasing frees the slot again, so a reconnect is not permanently blocked.
    test_release_ip_connection_slot(&ip);
    assert!(test_acquire_ip_connection_slot(Some(&ip)));

    for _ in 0..max {
        test_release_ip_connection_slot(&ip);
    }
}

/// A different source address must not be affected by a saturated one.
#[test]
fn per_ip_connection_cap_is_isolated_per_address() {
    let noisy = unique_ip();
    let quiet = unique_ip();
    let max = test_max_connections_per_ip();

    for _ in 0..max {
        assert!(test_acquire_ip_connection_slot(Some(&noisy)));
    }
    assert!(!test_acquire_ip_connection_slot(Some(&noisy)));
    assert!(
        test_acquire_ip_connection_slot(Some(&quiet)),
        "a saturated IP must not starve everyone else"
    );

    test_release_ip_connection_slot(&quiet);
    for _ in 0..max {
        test_release_ip_connection_slot(&noisy);
    }
}

/// When a reverse proxy terminates on the same host and `PARACORD_TRUST_PROXY`
/// is not configured, every client resolves to 127.0.0.1. A per-IP cap must not
/// silently become a cap on the entire server in that configuration.
// Async because the handshake limiter spawns its own bucket-cleanup task on
// first use, exactly as `user_rate_limits` does.
#[tokio::test]
async fn loopback_and_unknown_peers_are_exempt_from_per_ip_bounds() {
    let max = test_max_connections_per_ip();
    for _ in 0..(max * 2 + 10) {
        assert!(test_acquire_ip_connection_slot(Some("127.0.0.1")));
        assert!(test_acquire_ip_connection_slot(Some("::1")));
        assert!(test_acquire_ip_connection_slot(None));
    }
    for _ in 0..(test_max_handshakes_per_minute_per_ip() * 3) {
        assert!(test_allow_gateway_handshake(Some("127.0.0.1")));
        assert!(test_allow_gateway_handshake(None));
    }
}

/// `/gateway` is merged after `build_router()` has baked in its layer stack, so
/// no HTTP middleware — rate limiting included — runs for the upgrade. The
/// gateway meters it itself.
#[tokio::test]
async fn gateway_handshakes_are_rate_limited_per_ip() {
    let ip = unique_ip();
    let max = test_max_handshakes_per_minute_per_ip();

    for i in 0..max {
        assert!(
            test_allow_gateway_handshake(Some(&ip)),
            "handshake {i} should fit inside the per-IP rate of {max}/min"
        );
    }
    assert!(
        !test_allow_gateway_handshake(Some(&ip)),
        "the upgrade past the per-IP handshake rate must be refused"
    );
    assert!(
        test_allow_gateway_handshake(Some(&unique_ip())),
        "another address must be unaffected"
    );
}

// ── user_presences growth ───────────────────────────────────────────────────

/// `user_presences` had no eviction anywhere: the disconnect path wrote an
/// "offline" payload into it, so the map retained one JSON value per user that
/// had *ever* connected, for the life of the process.
#[tokio::test]
async fn offline_transition_evicts_the_presence_entry() {
    let env = build_env().await;
    let user_id = make_user(&env).await;

    env.state.online_users.insert(user_id);
    env.state.user_presences.insert(
        user_id,
        json!({ "user_id": user_id.to_string(), "status": "online", "activities": [] }),
    );

    let payload = test_mark_user_offline(&env.state, user_id);

    assert_eq!(
        payload.get("status").and_then(Value::as_str),
        Some("offline"),
        "the offline payload must still be produced for fan-out"
    );
    assert!(
        !env.state.online_users.contains(&user_id),
        "the user must leave the online set"
    );
    assert!(
        env.state.user_presences.get(&user_id).is_none(),
        "the presence entry must be evicted, not overwritten with an offline payload"
    );
    assert_eq!(
        env.state.user_presences.len(),
        0,
        "user_presences must track online users only"
    );
}

/// Many users cycling through connect/disconnect must leave the map empty
/// instead of one entry heavier each time.
#[tokio::test]
async fn repeated_connect_disconnect_cycles_do_not_grow_the_presence_map() {
    let env = build_env().await;

    for _ in 0..50 {
        let user_id = make_user(&env).await;
        env.state.online_users.insert(user_id);
        env.state
            .user_presences
            .insert(user_id, json!({ "status": "online" }));
        test_mark_user_offline(&env.state, user_id);
    }

    assert_eq!(
        env.state.user_presences.len(),
        0,
        "50 connect/disconnect cycles must not retain 50 presence entries"
    );
}
