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
use tokio::sync::RwLock;
use tokio::time::{timeout, Duration};

use paracord_ws::{
    run_session, test_acquire_preauth_slot, test_acquire_user_connection_slot,
    test_buffered_event_count, test_drain_event_buffer, test_event_buffer_is_disconnected,
    test_insert_cached_session, test_is_origin_allowed, test_max_connections_per_user,
    test_max_preauth_per_ip, test_push_buffered_event, test_release_event_buffer,
    test_release_preauth_slot, wait_for_identify_or_resume, Session, WsCompressor,
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
        database_history_epoch: paracord_db::server_settings::get_or_create_database_history_epoch(
            &db,
        )
        .await
        .unwrap(),
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
        shutdown: paracord_core::shutdown::ShutdownSignal::new(),
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
        together: Arc::new(paracord_core::together::TogetherManager::new()),
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
async fn resume_with_future_sequence_requires_fresh_identification() {
    let env = build_env().await;
    let (user_id, token) = make_user_token(&env).await;
    let gw_session = format!("gw-{}", uuid::Uuid::new_v4().simple());
    test_insert_cached_session(gw_session.clone(), user_id, vec![], Default::default(), 4).await;
    let (mut client, tx, _srv, _srv_rx) = duplex();
    tx.send(resume_frame(&token, &gw_session, u64::MAX))
        .unwrap();
    let (session, resumed, requested_seq) = wait_for_identify_or_resume(&mut client, &env.state)
        .await
        .expect("fresh identification");
    assert!(!resumed);
    assert_eq!(requested_seq, 0);
    assert_ne!(session.session_id, gw_session);
    assert_eq!(session.sequence, 0);
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

/// Buffer through the live dispatch path so the test covers audience metadata
/// even when it is absent from the JSON payload.
async fn buffer_event_for_resume(
    env: &TestEnv,
    user_id: i64,
    guild_id: i64,
    owner_id: i64,
    event_type: &str,
    payload: Value,
) -> String {
    let session = Session::new(user_id, vec![guild_id], [(guild_id, owner_id)].into());
    let session_id = session.session_id.clone();
    let (handle, client_tx, mut server_rx) = spawn_session(session, env.state.clone());
    tokio::time::sleep(Duration::from_millis(100)).await;
    env.state
        .event_bus
        .dispatch(event_type, payload, Some(guild_id));
    let frame = next_text(&mut server_rx, 1000)
        .await
        .expect("initial delivery");
    assert_eq!(frame["t"], event_type);
    assert_eq!(frame["s"], 1);
    drop(client_tx);
    handle.await.unwrap();
    session_id
}

#[tokio::test]
async fn resume_reauthorizes_buffered_guild_events_even_without_payload_scope() {
    let env = build_env().await;
    let (owner_id, _) = make_user_token(&env).await;
    let (member_id, token) = make_user_token(&env).await;
    let guild_id = make_guild(&env, owner_id).await;
    paracord_db::members::add_member(&env.db, member_id, guild_id)
        .await
        .unwrap();
    let session_id = buffer_event_for_resume(
        &env,
        member_id,
        guild_id,
        owner_id,
        "GUILD_UPDATE",
        json!({"name":"private details"}),
    )
    .await;

    // Unchanged access still permits normal replay.
    let (mut client, tx, _, _) = duplex();
    tx.send(resume_frame(&token, &session_id, 0)).unwrap();
    let (_, resumed, _) = wait_for_identify_or_resume(&mut client, &env.state)
        .await
        .unwrap();
    assert!(resumed);

    paracord_db::members::remove_member(&env.db, member_id, guild_id)
        .await
        .unwrap();
    let (mut client, tx, _, _) = duplex();
    tx.send(resume_frame(&token, &session_id, 0)).unwrap();
    let (fresh, resumed, seq) = wait_for_identify_or_resume(&mut client, &env.state)
        .await
        .unwrap();
    assert!(!resumed, "revoked content must not enter the replay path");
    assert_ne!(fresh.session_id, session_id);
    assert_eq!(seq, 0);
    assert!(fresh.guild_ids.is_empty());
}

#[tokio::test]
async fn resume_reauthorizes_channel_overwrites_with_current_database_state() {
    let env = build_env().await;
    let (owner_id, _) = make_user_token(&env).await;
    let (member_id, token) = make_user_token(&env).await;
    let guild_id = make_guild(&env, owner_id).await;
    let channel_id = sid();
    paracord_db::members::add_member(&env.db, member_id, guild_id)
        .await
        .unwrap();
    paracord_db::channels::create_channel(
        &env.db, channel_id, guild_id, "general", 0, 0, None, None,
    )
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
    let session_id = buffer_event_for_resume(
        &env,
        member_id,
        guild_id,
        owner_id,
        "MESSAGE_CREATE",
        json!({"channel_id":channel_id.to_string(), "content":"revoked secret"}),
    )
    .await;

    // Deliberately leave the live permission cache populated with the old allow.
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &env.db,
        channel_id,
        member_id,
        1,
        0,
        Permissions::VIEW_CHANNEL.bits(),
    )
    .await
    .unwrap();
    let (mut client, tx, _, _) = duplex();
    tx.send(resume_frame(&token, &session_id, 0)).unwrap();
    let (fresh, resumed, _) = wait_for_identify_or_resume(&mut client, &env.state)
        .await
        .unwrap();
    assert!(
        !resumed,
        "a cached allow cannot authorize replay after channel access is revoked"
    );
    assert_ne!(fresh.session_id, session_id);
    assert!(fresh.guild_ids.contains(&guild_id));
}

#[tokio::test]
async fn targeted_report_events_recheck_moderator_authority_on_delivery_and_resume() {
    for event_type in ["GUILD_REPORT_CREATE", "GUILD_REPORT_UPDATE"] {
        let env = build_env().await;
        let (owner_id, _) = make_user_token(&env).await;
        let (moderator_id, token) = make_user_token(&env).await;
        let guild_id = make_guild(&env, owner_id).await;
        let role_id = sid();
        paracord_db::members::add_member(&env.db, moderator_id, guild_id)
            .await
            .unwrap();
        paracord_db::roles::create_role(
            &env.db,
            role_id,
            guild_id,
            "moderator",
            Permissions::MANAGE_MESSAGES.bits(),
        )
        .await
        .unwrap();
        paracord_db::roles::add_member_role(&env.db, moderator_id, guild_id, role_id)
            .await
            .unwrap();

        let session = Session::new(moderator_id, vec![guild_id], [(guild_id, owner_id)].into());
        let session_id = session.session_id.clone();
        let (handle, client_tx, mut server_rx) = spawn_session(session, env.state.clone());
        tokio::time::sleep(Duration::from_millis(100)).await;
        let payload = json!({"guild_id":guild_id.to_string(), "reason":"confidential report"});
        // Production report dispatch has no bus guild scope or channel id.
        env.state
            .event_bus
            .dispatch_to_users(event_type, payload.clone(), vec![moderator_id]);
        let frame = next_text(&mut server_rx, 1000)
            .await
            .expect("moderator report delivery");
        assert_eq!(frame["t"], event_type);
        drop(client_tx);
        handle.await.unwrap();

        let (mut client, tx, _, _) = duplex();
        tx.send(resume_frame(&token, &session_id, 0)).unwrap();
        assert!(
            wait_for_identify_or_resume(&mut client, &env.state)
                .await
                .unwrap()
                .1
        );

        paracord_db::roles::remove_member_role(&env.db, moderator_id, guild_id, role_id)
            .await
            .unwrap();
        let (mut client, tx, _, _) = duplex();
        tx.send(resume_frame(&token, &session_id, 0)).unwrap();
        let (fresh, resumed, _) = wait_for_identify_or_resume(&mut client, &env.state)
            .await
            .unwrap();
        assert!(!resumed, "old report target list must not survive demotion");
        assert!(fresh.guild_ids.contains(&guild_id));

        let (handle, client_tx, mut server_rx) = spawn_session(fresh, env.state.clone());
        tokio::time::sleep(Duration::from_millis(100)).await;
        env.state
            .event_bus
            .dispatch_to_users(event_type, payload, vec![moderator_id]);
        assert!(
            next_text(&mut server_rx, 150).await.is_none(),
            "stale live target leaked report"
        );
        // A personal notice remains deliverable independently of moderation.
        env.state.event_bus.dispatch_to_users(
            "MOD_ACTION_NOTICE",
            json!({"guild_id":guild_id.to_string()}),
            vec![moderator_id],
        );
        assert_eq!(
            next_text(&mut server_rx, 1000).await.unwrap()["t"],
            "MOD_ACTION_NOTICE"
        );
        drop(client_tx);
        handle.await.unwrap();
    }
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

// ── Regression: EVENT_BUFFERS is released on disconnect ────────────────────
//
// `ConnectionGuard::Drop` released connection counters but never touched the
// replay buffer, and the sweep only evicted a buffer once its *newest* event was
// an hour old. The map had no size cap either (unlike SESSION_CACHE), so a
// single authenticated user could loop connect -> self-addressed event ->
// disconnect and accumulate hour-lived 100-event buffers indefinitely.
#[tokio::test]
async fn empty_event_buffer_is_dropped_on_disconnect() {
    let gw_session = format!("gw-{}", uuid::Uuid::new_v4().simple());

    // A connection that produced no replayable events still creates a buffer
    // entry the moment anything touches it.
    test_push_buffered_event(&gw_session, 1, "MESSAGE_CREATE", json!({"content": "a"}));
    assert_eq!(test_buffered_event_count(&gw_session), Some(1));

    test_release_event_buffer(&gw_session);
    // Non-empty: retained for RESUME, but explicitly marked disconnected so the
    // sweep and the disconnected-buffer cap can reclaim it.
    assert_eq!(
        test_event_buffer_is_disconnected(&gw_session),
        Some(true),
        "a disconnected buffer must be marked, not left indistinguishable from a live one"
    );
}

#[tokio::test]
async fn event_buffer_with_nothing_to_replay_is_removed_on_disconnect() {
    let gw_session = format!("gw-{}", uuid::Uuid::new_v4().simple());

    // Create the entry, then drain it so there is nothing left to replay.
    test_push_buffered_event(&gw_session, 1, "MESSAGE_CREATE", json!({"content": "a"}));
    test_drain_event_buffer(&gw_session);
    assert_eq!(test_buffered_event_count(&gw_session), Some(0));

    test_release_event_buffer(&gw_session);
    assert_eq!(
        test_buffered_event_count(&gw_session),
        None,
        "a disconnected buffer with nothing to replay must be dropped outright"
    );
}

/// Drive the real WebSocket upgrade and both authenticated handshake paths so
/// the published epoch cannot diverge from the instance's database identity.
#[tokio::test]
async fn ready_and_resumed_publish_the_instance_database_history_epoch() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as ClientMessage;

    let env = build_env().await;
    let (user_id, token) = make_user_token(&env).await;
    let (peer_id, _) = make_user_token(&env).await;
    let guild_id = make_guild(&env, user_id).await;
    paracord_db::members::add_member(&env.db, peer_id, guild_id)
        .await
        .unwrap();
    assert!(
        env.state.member_index.members_of(guild_id).is_empty(),
        "fixture deliberately leaves the process cache stale"
    );
    let guild = paracord_db::guilds::get_guild(&env.db, guild_id)
        .await
        .unwrap()
        .unwrap();
    let epoch = env.state.database_history_epoch.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = paracord_ws::gateway_router().with_state(env.state.clone());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let url = format!("ws://{address}/gateway");
    let (mut identified, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let hello = timeout(Duration::from_secs(5), identified.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(hello.to_text().unwrap()).unwrap()["op"],
        10
    );
    identified.send(ClientMessage::Text(json!({
        "op":OP_IDENTIFY,"d":{"token":token,"database_history_epoch":"client-cannot-choose-history"},
    }).to_string().into())).await.unwrap();
    let ready = timeout(Duration::from_secs(5), identified.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let ready: Value = serde_json::from_str(ready.to_text().unwrap()).unwrap();
    assert_eq!(ready["t"], "READY");
    assert_eq!(ready["d"]["database_history_epoch"], epoch);
    assert_eq!(ready["d"]["recovery_required"], true);
    assert_eq!(ready["d"]["guilds"][0]["id"], guild_id.to_string());
    assert_eq!(
        ready["d"]["guilds"][0]["member_count"], 2,
        "READY must use persisted membership, not the process cache"
    );
    assert_eq!(
        ready["d"]["guilds"][0]["created_at"],
        guild.created_at.to_rfc3339()
    );
    let session_id = ready["d"]["session_id"].as_str().unwrap().to_owned();
    let ready_seq = ready["s"].as_u64().unwrap();
    // Coming online dispatches the user's own PRESENCE_UPDATE to this live
    // session (the user is one of their own presence recipients), and the live
    // session buffers it for replay under the next sequence. The events seeded
    // below must come after it: seeded at `ready_seq + 1` they collided with it,
    // and whenever the presence landed in the buffer first (a slower machine,
    // or coverage instrumentation) RESUME replayed the presence where this test
    // expected "first". Wait for that frame, then seed behind it.
    let presence = timeout(Duration::from_secs(5), identified.next())
        .await
        .expect("the live session must receive its own online presence")
        .unwrap()
        .unwrap();
    let presence: Value = serde_json::from_str(presence.to_text().unwrap()).unwrap();
    assert_eq!(presence["t"], "PRESENCE_UPDATE");
    assert_eq!(presence["d"]["user_id"], user_id.to_string());
    assert_eq!(presence["s"], ready_seq + 1);
    let seq = ready_seq + 1;
    // A live connection need not have disconnected yet for the authenticated
    // resume path to read its cached session, so seed the same known snapshot.
    test_insert_cached_session(
        session_id.clone(),
        user_id,
        vec![],
        Default::default(),
        seq + 2,
    )
    .await;
    test_push_buffered_event(
        &session_id,
        seq + 1,
        "MESSAGE_UPDATE",
        json!({"id":"first"}),
    );
    test_push_buffered_event(
        &session_id,
        seq + 2,
        "MESSAGE_UPDATE",
        json!({"id":"second"}),
    );
    let (mut resumed, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let _ = timeout(Duration::from_secs(5), resumed.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    resumed
        .send(ClientMessage::Text(
            json!({
                "op":OP_RESUME,"d":{"token":token,"session_id":session_id,"seq":seq},
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let resumed_frame = timeout(Duration::from_secs(5), resumed.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let resumed_frame: Value = serde_json::from_str(resumed_frame.to_text().unwrap()).unwrap();
    assert_eq!(resumed_frame["t"], "RESUMED");
    assert_eq!(resumed_frame["d"]["database_history_epoch"], epoch);
    assert_eq!(resumed_frame["d"]["recovery_required"], true);
    assert_eq!(
        resumed_frame["s"], seq,
        "RESUMED must not acknowledge replay before delivery"
    );
    for (expected_seq, expected_id) in [(seq + 1, "first"), (seq + 2, "second")] {
        let replay = timeout(Duration::from_secs(5), resumed.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let replay: Value = serde_json::from_str(replay.to_text().unwrap()).unwrap();
        assert_eq!(replay["s"], expected_seq);
        assert_eq!(replay["d"]["id"], expected_id);
    }
    let _ = identified.close(None).await;
    let _ = resumed.close(None).await;
    server.abort();
}

#[tokio::test]
async fn voice_status_and_leave_require_the_current_call_receipt() {
    let env = build_env().await;
    let (user_id, _) = make_user_token(&env).await;
    let guild_id = make_guild(&env, user_id).await;
    let channel_id = paracord_util::snowflake::generate(1);
    paracord_db::channels::create_channel(&env.db, channel_id, guild_id, "voice", 2, 0, None, None)
        .await
        .unwrap();
    paracord_db::voice_states::upsert_voice_state(
        &env.db,
        user_id,
        Some(guild_id),
        channel_id,
        "call-current",
    )
    .await
    .unwrap();
    env.state
        .voice
        .join_room(guild_id, channel_id, user_id, "call-current")
        .await;
    let mut session = Session::new(user_id, vec![guild_id], Default::default());
    session.guild_owner_ids.insert(guild_id, user_id);
    let (handle, tx, mut rx) = spawn_session(session, env.state.clone());
    for (receipt, target) in [
        ("call-old", Some(channel_id)),
        ("call-old", None),
        ("call-current", Some(channel_id)),
    ] {
        tx.send(Ok(Message::Text(json!({"op":4,"d":{"guild_id":guild_id.to_string(),"channel_id":target.map(|id| id.to_string()),"session_id":receipt,"self_mute":true}}).to_string().into()))).unwrap();
        tx.send(Ok(Message::Text(json!({"op":1}).to_string().into())))
            .unwrap();
        loop {
            if next_text(&mut rx, 1000)
                .await
                .expect("heartbeat after command")["op"]
                == 11
            {
                break;
            }
        }
        let current =
            paracord_db::voice_states::get_user_voice_session(&env.db, user_id, Some(guild_id))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(current.session_id, "call-current");
    }
    tx.send(Ok(Message::Text(json!({"op":4,"d":{"guild_id":guild_id.to_string(),"channel_id":null,"session_id":"call-current"}}).to_string().into()))).unwrap();
    tx.send(Ok(Message::Text(json!({"op":1}).to_string().into())))
        .unwrap();
    loop {
        if next_text(&mut rx, 1000)
            .await
            .expect("heartbeat after leave")["op"]
            == 11
        {
            break;
        }
    }
    assert!(
        paracord_db::voice_states::get_user_voice_session(&env.db, user_id, Some(guild_id))
            .await
            .unwrap()
            .is_none()
    );
    drop(tx);
    handle.await.unwrap();
}

#[tokio::test]
async fn websocket_snapshot_query_failures_never_publish_empty_ready_state() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as ClientMessage;

    let env = build_env().await;
    let (user_id, token) = make_user_token(&env).await;
    make_guild(&env, user_id).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = paracord_ws::gateway_router().with_state(env.state.clone());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    for table in ["members", "voice_states"] {
        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/gateway"))
            .await
            .unwrap();
        let hello = timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(hello.to_text().unwrap()).unwrap()["op"],
            10
        );
        sqlx::query(&format!(
            "ALTER TABLE {table} RENAME TO unavailable_snapshot_table"
        ))
        .execute(&env.db)
        .await
        .unwrap();
        socket
            .send(ClientMessage::Text(
                json!({"op": OP_IDENTIFY, "d": {"token": token}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let reply = timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if table == "members" {
            assert_eq!(
                serde_json::from_str::<Value>(reply.to_text().unwrap()).unwrap()["op"],
                9
            );
        } else {
            assert!(
                matches!(reply, ClientMessage::Close(Some(ref frame)) if u16::from(frame.code) == 1011),
                "failed READY snapshot must close for retry: {reply:?}"
            );
        }
        let _ = socket.close(None).await;
        sqlx::query(&format!(
            "ALTER TABLE unavailable_snapshot_table RENAME TO {table}"
        ))
        .execute(&env.db)
        .await
        .unwrap();
    }
    server.abort();
}

// ── run_session: shutdown ───────────────────────────────────────────────────

/// A gateway socket is open until a client closes it, and axum's graceful
/// shutdown waits for every in-flight connection — so a session that ignores
/// the shutdown signal is a server that never restarts while anyone is
/// connected. The order matters as much as the fact: the notice that explains
/// the close has to reach the client before the close does.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shutting_down_server_closes_its_sessions_after_the_restart_notice() {
    let env = build_env().await;
    let (user_id, _token) = make_user_token(&env).await;
    let session = Session::new(user_id, vec![], Default::default());

    // `client_tx` is held for the whole test: this is a client that is doing
    // nothing wrong and simply keeping its socket open, which is exactly the
    // client that used to hold the process up.
    let (handle, _client_tx, mut server_rx) = spawn_session(session, env.state.clone());
    tokio::time::sleep(Duration::from_millis(150)).await;

    // Exactly what the shutdown path does, in its order: publish the notice,
    // then latch the signal.
    env.state
        .event_bus
        .dispatch("SERVER_RESTART", json!({}), None);
    env.state.shutdown.trigger();

    let notice = next_text(&mut server_rx, 2000)
        .await
        .expect("the restart notice must arrive");
    assert_eq!(
        notice["t"], "SERVER_RESTART",
        "the client is told why before it is closed"
    );

    let mut saw_close = false;
    while let Ok(Some(frame)) = timeout(Duration::from_secs(5), server_rx.recv()).await {
        if let Message::Close(Some(close)) = frame {
            assert_eq!(
                close.code, 1012,
                "a restart closes with 1012 Service Restart"
            );
            saw_close = true;
            break;
        }
    }
    assert!(saw_close, "the session must close its own socket");

    let ended = timeout(Duration::from_secs(5), handle).await;
    assert!(
        ended.is_ok(),
        "the session must end itself: nothing else will, and the drain waits for it"
    );
}

async fn make_gateway_bot(env: &TestEnv) -> (i64, i64, String) {
    let (user_id, _) = make_user_token(env).await;
    paracord_db::users::update_user_flags(&env.db, user_id, paracord_core::USER_FLAG_BOT)
        .await
        .unwrap();
    let app_id = sid();
    let token = uuid::Uuid::new_v4().simple().to_string();
    paracord_db::bot_applications::create_bot_application(
        &env.db,
        app_id,
        "Gateway Bot",
        None,
        user_id,
        user_id,
        &paracord_db::bot_applications::hash_token(&token),
        None,
        Permissions::VIEW_CHANNEL.bits(),
    )
    .await
    .unwrap();
    (app_id, user_id, token)
}

async fn identify_gateway_bot(env: &TestEnv, token: &str) -> Option<Session> {
    let (mut client, tx, _, _) = duplex();
    tx.send(identify_frame(token)).unwrap();
    drop(tx);
    wait_for_identify_or_resume(&mut client, &env.state)
        .await
        .map(|result| result.0)
}

#[tokio::test]
async fn bot_identify_accepts_opaque_credentials_and_only_installed_guilds() {
    let env = build_env().await;
    let (app_id, bot_id, token) = make_gateway_bot(&env).await;
    let (owner_id, _) = make_user_token(&env).await;
    let installed = make_guild(&env, owner_id).await;
    let uninstalled = make_guild(&env, owner_id).await;
    for guild_id in [installed, uninstalled] {
        paracord_db::members::add_member(&env.db, bot_id, guild_id)
            .await
            .unwrap();
    }
    paracord_db::bot_applications::add_bot_to_guild(
        &env.db,
        app_id,
        installed,
        owner_id,
        Permissions::VIEW_CHANNEL.bits(),
    )
    .await
    .unwrap();
    for credential in [token.clone(), format!("Bot {token}")] {
        let session = identify_gateway_bot(&env, &credential)
            .await
            .expect("valid bot credential");
        assert_eq!(session.user_id, bot_id);
        assert_eq!(
            session.guild_ids,
            vec![installed],
            "membership alone is not a bot installation"
        );
        assert_eq!(
            session.bot_token_hash,
            Some(paracord_db::bot_applications::hash_token(&token))
        );
        assert!(session.auth_session_id.is_empty());
    }
    paracord_db::bot_applications::set_bot_application_revoked(&env.db, app_id, true)
        .await
        .unwrap();
    assert!(identify_gateway_bot(&env, &token).await.is_none());
    let rotated = "rotated-gateway-bot-fixture-token";
    paracord_db::bot_applications::regenerate_bot_token(
        &env.db,
        app_id,
        &paracord_db::bot_applications::hash_token(rotated),
    )
    .await
    .unwrap();
    assert!(identify_gateway_bot(&env, &token).await.is_none());
    assert!(identify_gateway_bot(&env, rotated).await.is_some());
    paracord_db::users::update_user_flags(&env.db, bot_id, 0)
        .await
        .unwrap();
    assert!(
        identify_gateway_bot(&env, rotated).await.is_none(),
        "bot credential must never authenticate an ordinary user"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bot_gateway_rotation_closes_live_socket_and_refuses_old_resume() {
    let env = build_env().await;
    let (app_id, _, token) = make_gateway_bot(&env).await;
    let session = identify_gateway_bot(&env, &token).await.unwrap();
    let session_id = session.session_id.clone();
    let (handle, client_tx, mut server_rx) = spawn_session(session, env.state.clone());
    paracord_db::bot_applications::regenerate_bot_token(
        &env.db,
        app_id,
        &paracord_db::bot_applications::hash_token("new-bot-token"),
    )
    .await
    .unwrap();
    client_tx
        .send(Ok(Message::Text(
            json!({"op":1,"d":null}).to_string().into(),
        )))
        .unwrap();
    loop {
        match timeout(Duration::from_secs(2), server_rx.recv())
            .await
            .expect("revoked socket closes")
        {
            Some(Message::Close(Some(frame))) => {
                assert_eq!(frame.code, 4004);
                break;
            }
            Some(Message::Ping(_)) => {}
            other => panic!("revoked bot must not receive a heartbeat ACK: {other:?}"),
        }
    }
    handle.await.unwrap();
    let (mut client, tx, _, _) = duplex();
    tx.send(resume_frame(&token, &session_id, 0)).unwrap();
    drop(tx);
    assert!(wait_for_identify_or_resume(&mut client, &env.state)
        .await
        .is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bot_targeted_interactions_recheck_install_and_channel_grants() {
    let env = build_env().await;
    let (app_id, bot_id, token) = make_gateway_bot(&env).await;
    let (owner_id, _) = make_user_token(&env).await;
    let guild_id = make_guild(&env, owner_id).await;
    paracord_db::members::add_member(&env.db, bot_id, guild_id)
        .await
        .unwrap();
    paracord_db::roles::create_role(
        &env.db,
        guild_id,
        guild_id,
        "@everyone",
        Permissions::VIEW_CHANNEL.bits(),
    )
    .await
    .unwrap();
    paracord_db::bot_applications::add_bot_to_guild(
        &env.db,
        app_id,
        guild_id,
        owner_id,
        Permissions::VIEW_CHANNEL.bits(),
    )
    .await
    .unwrap();
    let channel_id = sid();
    paracord_db::channels::create_channel(
        &env.db,
        channel_id,
        guild_id,
        "bot-commands",
        0,
        0,
        None,
        None,
    )
    .await
    .unwrap();
    let session = identify_gateway_bot(&env, &token).await.unwrap();
    let session_id = session.session_id.clone();
    let (handle, client_tx, mut server_rx) = spawn_session(session, env.state.clone());
    tokio::time::sleep(Duration::from_millis(100)).await;
    let interaction = json!({"guild_id":guild_id.to_string(), "channel_id":channel_id.to_string(), "token":"private-interaction-token"});
    env.state
        .event_bus
        .dispatch_to_users("INTERACTION_CREATE", interaction.clone(), vec![bot_id]);
    assert_eq!(
        next_text(&mut server_rx, 1000).await.unwrap()["t"],
        "INTERACTION_CREATE"
    );
    // A queued target list is not authority after an install permission reduction.
    paracord_db::bot_applications::add_bot_to_guild(&env.db, app_id, guild_id, owner_id, 0)
        .await
        .unwrap();
    env.state
        .event_bus
        .dispatch_to_users("INTERACTION_CREATE", interaction.clone(), vec![bot_id]);
    env.state
        .event_bus
        .dispatch_to_users("SENTINEL", json!({}), vec![bot_id]);
    assert_eq!(
        next_text(&mut server_rx, 1000).await.unwrap()["t"],
        "SENTINEL"
    );
    // Even stale membership must not preserve an uninstalled bot's subscriptions.
    paracord_db::bot_applications::remove_bot_from_guild(&env.db, app_id, guild_id)
        .await
        .unwrap();
    env.state
        .event_bus
        .dispatch_to_users("INTERACTION_CREATE", interaction, vec![bot_id]);
    env.state.event_bus.dispatch(
        "GUILD_UPDATE",
        json!({"id":guild_id.to_string()}),
        Some(guild_id),
    );
    env.state
        .event_bus
        .dispatch_to_users("SENTINEL", json!({}), vec![bot_id]);
    assert_eq!(
        next_text(&mut server_rx, 1000).await.unwrap()["t"],
        "SENTINEL"
    );
    client_tx
        .send(Ok(Message::Text(
            json!({"op":8,"d":{"guild_id":guild_id.to_string()}})
                .to_string()
                .into(),
        )))
        .unwrap();
    client_tx
        .send(Ok(Message::Text(
            json!({"op":1,"d":null}).to_string().into(),
        )))
        .unwrap();
    assert_eq!(
        next_text(&mut server_rx, 1000).await.unwrap()["op"],
        11,
        "uninstalled bot must not fetch a roster from its stale session scope"
    );
    drop(client_tx);
    handle.await.unwrap();
    let (mut client, tx, _, _) = duplex();
    tx.send(resume_frame(&token, &session_id, 0)).unwrap();
    drop(tx);
    let (session, resumed, _) = wait_for_identify_or_resume(&mut client, &env.state)
        .await
        .unwrap();
    assert!(
        !resumed,
        "uninstalled bot must not replay its old interaction token"
    );
    assert!(session.guild_ids.is_empty());
}
