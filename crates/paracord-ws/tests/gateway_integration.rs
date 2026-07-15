//! Integration coverage for the WebSocket gateway hot path.
//!
//! These tests drive the internal seams `wait_for_identify_or_resume` and
//! `run_session` (plus the origin/capacity helpers) against a real in-memory
//! SQLite database + `EventBus` + `AppState`, mirroring the `paracord-api`
//! `TestContext` pattern. They avoid a live HTTP upgrade by feeding the generic
//! stream/sink seams with in-process channels.

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::extract::ws::Message;
use axum::http::{header, HeaderMap};
use chrono::{Duration as ChronoDuration, Utc};
use dashmap::{DashMap, DashSet};
use futures_util::{Sink, Stream};
use paracord_core::{build_permission_cache, AppConfig, AppState, RuntimeSettings};
use paracord_media::{
    LiveKitConfig, LocalStorage, Storage, StorageConfig, StorageManager, VoiceManager,
};
use paracord_models::gateway::{OP_IDENTIFY, OP_RESUME};
use paracord_models::permissions::Permissions;
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::sync::{Notify, RwLock};
use tokio::time::{timeout, Duration};

use paracord_ws::{
    run_session, test_acquire_preauth_slot, test_acquire_user_connection_slot,
    test_insert_cached_session, test_is_origin_allowed, test_max_connections_per_user,
    test_max_preauth_per_ip, test_push_buffered_event, test_release_preauth_slot,
    wait_for_identify_or_resume, Session, WsCompressor,
};

// ── Mock stream/sink ────────────────────────────────────────────────────────

/// Client→server side: yields the frames a test pushes, then ends (which the
/// gateway treats as the socket closing).
struct MockClient {
    rx: UnboundedReceiver<Result<Message, axum::Error>>,
}

impl Stream for MockClient {
    type Item = Result<Message, axum::Error>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx)
    }
}

/// Server→client side: captures every frame the gateway emits into an unbounded
/// channel a test can drain.
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

/// Await the next textual gateway frame (parsed as JSON), skipping ping/binary
/// control frames. Returns `None` on timeout or channel close.
async fn next_text(rx: &mut UnboundedReceiver<Message>, ms: u64) -> Option<Value> {
    loop {
        match timeout(Duration::from_millis(ms), rx.recv()).await {
            Ok(Some(Message::Text(t))) => return serde_json::from_str::<Value>(&t).ok(),
            Ok(Some(_)) => continue,
            Ok(None) | Err(_) => return None,
        }
    }
}

fn identify_frame(token: &str) -> Result<Message, axum::Error> {
    Ok(Message::Text(
        json!({ "op": OP_IDENTIFY, "d": { "token": token } })
            .to_string()
            .into(),
    ))
}

fn resume_frame(token: &str, session_id: &str, seq: u64) -> Result<Message, axum::Error> {
    Ok(Message::Text(
        json!({
            "op": OP_RESUME,
            "d": { "token": token, "session_id": session_id, "seq": seq }
        })
        .to_string()
        .into(),
    ))
}

// ── AppState / fixtures ─────────────────────────────────────────────────────

struct TestEnv {
    state: AppState,
    db: paracord_db::DbPool,
    jwt_secret: String,
    _dirs: Vec<TempDir>,
}

async fn build_env() -> TestEnv {
    let jwt_secret = "ws-integration-secret".to_string();
    let db = paracord_db::create_pool("sqlite::memory:", 1)
        .await
        .expect("create pool");
    paracord_db::run_migrations(&db).await.expect("migrations");

    let storage_dir = tempfile::tempdir().unwrap();
    let media_dir = tempfile::tempdir().unwrap();
    let backup_dir = tempfile::tempdir().unwrap();
    let event_bus = paracord_core::events::EventBus::default();

    let livekit = Arc::new(LiveKitConfig {
        api_key: "lk-test-key".to_string(),
        api_secret: "lk-test-secret".to_string(),
        url: "ws://localhost:7880".to_string(),
        http_url: "http://localhost:7880".to_string(),
    });

    let state = AppState {
        db: db.clone(),
        event_bus,
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

/// Create a user with a live auth session and return `(user_id, access_token)`.
async fn make_user_token(env: &TestEnv) -> (i64, String) {
    let user_id = sid();
    let uniq = uuid::Uuid::new_v4().simple().to_string();
    let username = format!("u{}", &uniq[..10]);
    let email = format!("{uniq}@example.com");
    let password_hash = paracord_core::auth::hash_password("hunter2password").unwrap();
    let user =
        paracord_db::users::create_user(&env.db, user_id, &username, 1, &email, &password_hash)
            .await
            .expect("create user");

    let session_id = format!("auth-{uniq}");
    let jti = format!("jti-{uniq}");
    let refresh_hash = format!("rh-{uniq}");
    paracord_db::sessions::create_session(
        &env.db,
        &session_id,
        user.id,
        &refresh_hash,
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
        user.id,
        None,
        &env.jwt_secret,
        3600,
        &session_id,
        &jti,
    )
    .expect("token");
    (user.id, token)
}

/// Create a guild owned by `owner_id` and register `owner_id` as a member.
async fn make_guild(env: &TestEnv, owner_id: i64) -> i64 {
    let guild_id = sid();
    paracord_db::guilds::create_guild(&env.db, guild_id, "Test Guild", owner_id, None)
        .await
        .expect("create guild");
    paracord_db::members::add_member(&env.db, owner_id, guild_id)
        .await
        .expect("add owner member");
    guild_id
}

// ── IDENTIFY / RESUME ───────────────────────────────────────────────────────

#[tokio::test]
async fn identify_creates_fresh_session_with_user_guilds() {
    let env = build_env().await;
    let (user_id, token) = make_user_token(&env).await;
    let guild_id = make_guild(&env, user_id).await;

    let (mut client, tx, _srv, _srv_rx) = duplex();
    tx.send(identify_frame(&token)).unwrap();

    let result = wait_for_identify_or_resume(&mut client, &env.state)
        .await
        .expect("identify accepted");
    let (session, resumed, requested_seq) = result;
    assert!(!resumed, "IDENTIFY yields a fresh (non-resumed) session");
    assert_eq!(requested_seq, 0);
    assert_eq!(session.user_id, user_id);
    assert!(session.guild_ids.contains(&guild_id));
    assert_eq!(session.guild_owner_ids.get(&guild_id), Some(&user_id));
}

#[tokio::test]
async fn identify_with_invalid_token_is_rejected() {
    let env = build_env().await;
    let (mut client, tx, _srv, _srv_rx) = duplex();
    tx.send(identify_frame("not-a-real-jwt")).unwrap();
    drop(tx); // no further frames; stream ends after the bad IDENTIFY

    let result = wait_for_identify_or_resume(&mut client, &env.state).await;
    assert!(result.is_none(), "invalid token must not open a session");
}

#[tokio::test]
async fn resume_within_buffer_window_replays() {
    let env = build_env().await;
    let (user_id, token) = make_user_token(&env).await;

    let gw_session = format!("gw-{}", uuid::Uuid::new_v4().simple());
    // Cached gateway session advanced to seq 5, with buffered events 4 and 5.
    test_insert_cached_session(gw_session.clone(), user_id, vec![], Default::default(), 5).await;
    test_push_buffered_event(&gw_session, 4, "MESSAGE_CREATE", json!({"content": "a"}));
    test_push_buffered_event(&gw_session, 5, "MESSAGE_CREATE", json!({"content": "b"}));

    let (mut client, tx, _srv, _srv_rx) = duplex();
    tx.send(resume_frame(&token, &gw_session, 3)).unwrap();

    let (session, resumed, requested_seq) = wait_for_identify_or_resume(&mut client, &env.state)
        .await
        .expect("resume accepted");
    assert!(resumed, "resume with an intact buffer must replay");
    assert_eq!(requested_seq, 3);
    assert_eq!(session.session_id, gw_session);
    assert_eq!(
        session.sequence, 5,
        "resumed session keeps the cached sequence"
    );
    assert_eq!(session.user_id, user_id);
}

#[tokio::test]
async fn resume_drops_guilds_the_user_was_removed_from_while_disconnected() {
    // Regression for L09-01: RESUME must re-derive membership from the DB, not
    // trust the cached snapshot. A user kicked/banned while disconnected never
    // processed remove_guild(), so a cache-trusting resume would re-grant them
    // the guild event stream for the remainder of the session TTL.
    let env = build_env().await;
    let (user_id, token) = make_user_token(&env).await;
    let guild_id = make_guild(&env, user_id).await;

    let gw_session = format!("gw-{}", uuid::Uuid::new_v4().simple());
    // Session was cached (at disconnect) while the user was still a member.
    let mut cached_owners = std::collections::HashMap::new();
    cached_owners.insert(guild_id, user_id);
    test_insert_cached_session(
        gw_session.clone(),
        user_id,
        vec![guild_id],
        cached_owners,
        5,
    )
    .await;
    test_push_buffered_event(&gw_session, 4, "MESSAGE_CREATE", json!({"content": "a"}));
    test_push_buffered_event(&gw_session, 5, "MESSAGE_CREATE", json!({"content": "b"}));

    // Removed from the guild during the disconnect gap.
    paracord_db::members::remove_member(&env.db, user_id, guild_id)
        .await
        .expect("remove member");

    let (mut client, tx, _srv, _srv_rx) = duplex();
    tx.send(resume_frame(&token, &gw_session, 3)).unwrap();

    let (session, resumed, _requested_seq) = wait_for_identify_or_resume(&mut client, &env.state)
        .await
        .expect("resume accepted");
    assert!(
        resumed,
        "an intact buffer still resumes (replay continuity)"
    );
    assert_eq!(
        session.session_id, gw_session,
        "keeps the cached session id"
    );
    assert!(
        !session.guild_ids.contains(&guild_id),
        "resumed session must not carry a guild the user was removed from"
    );
    assert!(
        !session.guild_owner_ids.contains_key(&guild_id),
        "stale guild ownership must not survive the resume"
    );
}

#[tokio::test]
async fn resume_with_sequence_gap_falls_back_to_fresh() {
    let env = build_env().await;
    let (user_id, token) = make_user_token(&env).await;
    let guild_id = make_guild(&env, user_id).await;

    let gw_session = format!("gw-{}", uuid::Uuid::new_v4().simple());
    // Cached at seq 10 but the oldest buffered event is 8 — a client asking to
    // resume from seq 3 has an unbridgeable gap (missed 4..=7).
    test_insert_cached_session(
        gw_session.clone(),
        user_id,
        vec![guild_id],
        Default::default(),
        10,
    )
    .await;
    test_push_buffered_event(&gw_session, 8, "MESSAGE_CREATE", json!({"content": "x"}));
    test_push_buffered_event(&gw_session, 9, "MESSAGE_CREATE", json!({"content": "y"}));

    let (mut client, tx, _srv, _srv_rx) = duplex();
    tx.send(resume_frame(&token, &gw_session, 3)).unwrap();

    let (session, resumed, requested_seq) = wait_for_identify_or_resume(&mut client, &env.state)
        .await
        .expect("falls back to a fresh session");
    assert!(!resumed, "a replay gap must force a fresh session");
    assert_eq!(requested_seq, 0);
    // Fresh session gets a brand-new id and reloads guilds from the DB.
    assert_ne!(session.session_id, gw_session);
    assert!(session.guild_ids.contains(&guild_id));
}

#[tokio::test]
async fn resume_unknown_session_falls_back_to_fresh() {
    let env = build_env().await;
    let (user_id, token) = make_user_token(&env).await;

    let (mut client, tx, _srv, _srv_rx) = duplex();
    tx.send(resume_frame(&token, "does-not-exist", 42)).unwrap();

    let (session, resumed, requested_seq) = wait_for_identify_or_resume(&mut client, &env.state)
        .await
        .expect("cache miss falls back to fresh");
    assert!(!resumed);
    assert_eq!(requested_seq, 0);
    assert_eq!(session.user_id, user_id);
}

// ── Origin checks ───────────────────────────────────────────────────────────

#[tokio::test]
async fn origin_accept_and_reject() {
    let env = build_env().await;

    // No Origin header (native clients) → allowed.
    assert!(test_is_origin_allowed(&HeaderMap::new(), &env.state));

    // A known-good browser dev origin → allowed.
    let mut ok = HeaderMap::new();
    ok.insert(header::ORIGIN, "http://localhost:1420".parse().unwrap());
    assert!(test_is_origin_allowed(&ok, &env.state));

    // A cross-origin site with no matching Host → rejected.
    let mut bad = HeaderMap::new();
    bad.insert(header::ORIGIN, "https://evil.example.com".parse().unwrap());
    assert!(!test_is_origin_allowed(&bad, &env.state));
}

// ── Capacity guard ──────────────────────────────────────────────────────────

#[tokio::test]
async fn per_user_capacity_guard_rejects_over_limit() {
    // Unique user id so this test owns an isolated slot bucket in the process
    // global counter.
    let user_id = sid();
    let limit = test_max_connections_per_user();
    assert!(limit >= 1);

    for i in 0..limit {
        assert!(
            test_acquire_user_connection_slot(user_id),
            "slot {i} within the per-user limit must be granted"
        );
    }
    assert!(
        !test_acquire_user_connection_slot(user_id),
        "the connection over the per-user limit must be rejected"
    );
}

#[tokio::test]
async fn preauth_per_ip_capacity_guard_rejects_over_limit() {
    // Unique per-IP bucket key so this test is isolated from any concurrent test.
    let ip = format!("test-preauth-{}", sid());
    let limit = test_max_preauth_per_ip();
    assert!(limit >= 1);

    for i in 0..limit {
        assert!(
            test_acquire_preauth_slot(&ip),
            "pre-auth handshake slot {i} within the per-IP limit must be granted"
        );
    }
    // A single IP cannot exceed its concurrent-handshake budget, so an
    // unauthenticated flood from one source can't monopolize the pre-auth pool.
    assert!(
        !test_acquire_preauth_slot(&ip),
        "the pre-auth connection over the per-IP limit must be rejected"
    );

    // Release everything we acquired so the shared global pre-auth counter stays
    // clean for other tests in this binary.
    for _ in 0..limit {
        test_release_preauth_slot(&ip);
    }
    // After releasing, the IP can acquire again.
    assert!(
        test_acquire_preauth_slot(&ip),
        "slot must be grantable again once prior handshakes are released"
    );
    test_release_preauth_slot(&ip);
}

// ── run_session: dynamic scope subscribe/unsubscribe ────────────────────────

/// Drive `run_session` on a background task; returns the join handle plus the
/// client sender (drop it to end the session) and the server frame receiver.
fn spawn_session(
    session: Session,
    state: AppState,
) -> (
    tokio::task::JoinHandle<Session>,
    UnboundedSender<Result<Message, axum::Error>>,
    UnboundedReceiver<Message>,
) {
    let (client, client_tx, server, server_rx) = duplex();
    let handle = tokio::spawn(async move {
        let compressor = WsCompressor::new(false);
        run_session(server, client, session, state, &compressor).await
    });
    (handle, client_tx, server_rx)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dynamic_scope_controls_event_delivery() {
    let env = build_env().await;
    let (user_id, _token) = make_user_token(&env).await;
    let g1 = make_guild(&env, user_id).await;
    let g2 = make_guild(&env, user_id).await; // created but not yet in session scope

    let mut session = Session::new(user_id, vec![g1], Default::default());
    session.guild_owner_ids.insert(g1, user_id);
    let bus = env.state.event_bus.clone();

    let (handle, client_tx, mut server_rx) = spawn_session(session, env.state.clone());
    // Let run_session register its broadcast receiver before we publish.
    tokio::time::sleep(Duration::from_millis(150)).await;

    // In-scope guild event is delivered.
    bus.dispatch("SCOPE_A", json!({ "v": 1 }), Some(g1));
    let f = next_text(&mut server_rx, 1000).await.expect("g1 delivered");
    assert_eq!(f["t"], "SCOPE_A");

    // Out-of-scope guild event is dropped: publish g2 (unsubscribed) then a g1
    // sentinel; the next frame we see must be the sentinel.
    bus.dispatch("SCOPE_DROP", json!({ "v": 2 }), Some(g2));
    bus.dispatch("SENTINEL_1", json!({ "v": 3 }), Some(g1));
    let f = next_text(&mut server_rx, 1000).await.expect("sentinel_1");
    assert_eq!(
        f["t"], "SENTINEL_1",
        "the out-of-scope g2 event must not be delivered"
    );

    // Joining g2 (targeted so it passes the membership gate) expands the scope.
    bus.dispatch_to_users(
        "GUILD_MEMBER_ADD",
        json!({ "user_id": user_id.to_string(), "guild_id": g2.to_string() }),
        vec![user_id],
    );
    let f = next_text(&mut server_rx, 1000)
        .await
        .expect("member_add frame");
    assert_eq!(f["t"], "GUILD_MEMBER_ADD");

    // Now g2 events are delivered.
    bus.dispatch("SCOPE_B", json!({ "v": 4 }), Some(g2));
    let f = next_text(&mut server_rx, 1000)
        .await
        .expect("g2 now delivered");
    assert_eq!(f["t"], "SCOPE_B");

    // Leaving g2 via GUILD_DELETE removes it from scope again.
    bus.dispatch("GUILD_DELETE", json!({ "id": g2.to_string() }), Some(g2));
    let f = next_text(&mut server_rx, 1000)
        .await
        .expect("guild_delete frame");
    assert_eq!(f["t"], "GUILD_DELETE");

    bus.dispatch("SCOPE_DROP_2", json!({ "v": 5 }), Some(g2));
    bus.dispatch("SENTINEL_2", json!({ "v": 6 }), Some(g1));
    let f = next_text(&mut server_rx, 1000).await.expect("sentinel_2");
    assert_eq!(
        f["t"], "SENTINEL_2",
        "after leaving g2 its events must be dropped again"
    );

    drop(client_tx); // end the session
    let _ = handle.await;
}

// ── run_session: per-channel authorization ──────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn channel_scoped_events_respect_per_channel_authorization() {
    let env = build_env().await;
    let (owner_id, _owner_tok) = make_user_token(&env).await;
    let guild_id = make_guild(&env, owner_id).await;

    // A text channel in the guild.
    let channel_id = sid();
    paracord_db::channels::create_channel(
        &env.db, channel_id, guild_id, "general", 0, 0, None, None,
    )
    .await
    .expect("create channel");

    // A member who holds a role granting VIEW_CHANNEL guild-wide...
    let (member_id, _tok) = make_user_token(&env).await;
    paracord_db::members::add_member(&env.db, member_id, guild_id)
        .await
        .unwrap();
    let role_id = sid();
    paracord_db::roles::create_role(
        &env.db,
        role_id,
        guild_id,
        "viewers",
        Permissions::VIEW_CHANNEL.bits(),
    )
    .await
    .unwrap();
    paracord_db::roles::add_member_role(&env.db, member_id, guild_id, role_id)
        .await
        .unwrap();
    // ...but a member-specific overwrite denies VIEW_CHANNEL on THIS channel.
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &env.db,
        channel_id,
        member_id,
        1, // OVERWRITE_TARGET_MEMBER
        0,
        Permissions::VIEW_CHANNEL.bits(),
    )
    .await
    .unwrap();

    // Negative: the member cannot view this channel → channel-scoped event dropped.
    let mut member_session = Session::new(member_id, vec![guild_id], Default::default());
    member_session.guild_owner_ids.insert(guild_id, owner_id);
    let bus = env.state.event_bus.clone();
    let (handle, client_tx, mut server_rx) = spawn_session(member_session, env.state.clone());
    tokio::time::sleep(Duration::from_millis(150)).await;

    bus.dispatch(
        "MESSAGE_CREATE",
        json!({ "channel_id": channel_id.to_string(), "content": "secret" }),
        Some(guild_id),
    );
    // A non-channel guild event the member is allowed to see, used as a sentinel.
    bus.dispatch("SENTINEL", json!({ "v": 1 }), Some(guild_id));
    let f = next_text(&mut server_rx, 1000).await.expect("sentinel");
    assert_eq!(
        f["t"], "SENTINEL",
        "the channel event the member cannot view must be dropped"
    );
    drop(client_tx);
    let _ = handle.await;

    // Positive: the guild owner (all permissions) receives the channel event.
    let mut owner_session = Session::new(owner_id, vec![guild_id], Default::default());
    owner_session.guild_owner_ids.insert(guild_id, owner_id);
    let (handle, client_tx, mut server_rx) = spawn_session(owner_session, env.state.clone());
    tokio::time::sleep(Duration::from_millis(150)).await;

    bus.dispatch(
        "MESSAGE_CREATE",
        json!({ "channel_id": channel_id.to_string(), "content": "hi" }),
        Some(guild_id),
    );
    let f = next_text(&mut server_rx, 1000)
        .await
        .expect("owner delivery");
    assert_eq!(f["t"], "MESSAGE_CREATE");
    drop(client_tx);
    let _ = handle.await;
}

// ── run_session: message rate limiting ──────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn message_flood_trips_rate_limit() {
    let env = build_env().await;
    // Unique user id → an isolated keyed rate-limit bucket.
    let user_id = sid();
    let session = Session::new(user_id, vec![], Default::default());
    let (handle, client_tx, mut server_rx) = spawn_session(session, env.state.clone());

    // Opcode 99 is unknown: it is not a heartbeat (so it counts toward the
    // per-user message quota) and not a silent-drop high-frequency op, so the
    // over-limit response is an explicit RATE_LIMIT dispatch frame.
    let flood = json!({ "op": 99, "d": {} }).to_string();
    for _ in 0..320 {
        if client_tx
            .send(Ok(Message::Text(flood.clone().into())))
            .is_err()
        {
            break;
        }
    }

    let mut saw_rate_limit = false;
    // Drain frames; the only frames this opcode can produce are RATE_LIMIT ones.
    while let Some(frame) = next_text(&mut server_rx, 1500).await {
        if frame["t"] == "RATE_LIMIT" {
            saw_rate_limit = true;
            assert_eq!(frame["d"]["type"], "messages");
            break;
        }
    }
    assert!(
        saw_rate_limit,
        "flooding past the per-user quota must emit a RATE_LIMIT frame"
    );

    drop(client_tx);
    let _ = handle.await;
}
