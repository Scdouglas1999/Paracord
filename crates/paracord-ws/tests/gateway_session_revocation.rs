//! Regression coverage for gateway session revocation.
//!
//! A gateway socket used to authenticate exactly once, in
//! `wait_for_identify_or_resume`. The main loop never revalidated and had no
//! maximum lifetime, and the only thing that could end an idle socket was the
//! heartbeat timeout — which the client resets with every op 1. So after
//! `POST /auth/logout`, after a password change, and after revoking all other
//! sessions, REST correctly 401'd while the gateway kept delivering events
//! (DMs included) and kept accepting writes, past the access token's own `exp`.
//!
//! The gateway now re-checks its credential on the same cadence the SSE
//! transport uses (`STREAM_REVALIDATE_INTERVAL`), and a socket closed for
//! revocation cannot RESUME back into its state.

use std::pin::Pin;
use std::sync::{Arc, Once};
use std::task::{Context, Poll};

use axum::extract::ws::Message;
use chrono::{Duration as ChronoDuration, Utc};
use dashmap::{DashMap, DashSet};
use futures_util::{Sink, Stream};
use paracord_core::{build_permission_cache, AppConfig, AppState, RuntimeSettings};
use paracord_media::{
    LiveKitConfig, LocalStorage, Storage, StorageConfig, StorageManager, VoiceManager,
};
use paracord_models::gateway::{OP_IDENTIFY, OP_RESUME};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::sync::{Notify, RwLock};
use tokio::time::{timeout, Duration};

use paracord_ws::{run_session, wait_for_identify_or_resume, Session, WsCompressor};

/// Revalidation cadence used by this test binary. Production defaults to 60s
/// (matching SSE); the tests would otherwise have to wait a minute per assert.
const REVALIDATE_MS: u64 = 150;
/// Generous bound for "a revalidation tick has definitely happened".
const TICK_BUDGET_MS: u64 = 3_000;

static INIT: Once = Once::new();

fn install_fast_revalidation() {
    INIT.call_once(|| {
        std::env::set_var(
            "PARACORD_WS_SESSION_REVALIDATE_MS",
            REVALIDATE_MS.to_string(),
        );
    });
}

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

/// Next textual gateway frame (parsed as JSON), skipping control frames.
async fn next_text(rx: &mut UnboundedReceiver<Message>, ms: u64) -> Option<Value> {
    loop {
        match timeout(Duration::from_millis(ms), rx.recv()).await {
            Ok(Some(Message::Text(t))) => return serde_json::from_str::<Value>(&t).ok(),
            Ok(Some(_)) => continue,
            Ok(None) | Err(_) => return None,
        }
    }
}

/// Drain frames until a Close frame appears, returning its code. Any dispatch
/// frames seen on the way are returned too, so a test can assert that nothing
/// was delivered after the credential died.
async fn next_close(rx: &mut UnboundedReceiver<Message>, ms: u64) -> (Option<u16>, Vec<Value>) {
    let mut seen = Vec::new();
    loop {
        match timeout(Duration::from_millis(ms), rx.recv()).await {
            Ok(Some(Message::Close(frame))) => return (frame.map(|f| f.code), seen),
            Ok(Some(Message::Text(t))) => {
                if let Ok(value) = serde_json::from_str::<Value>(&t) {
                    seen.push(value);
                }
            }
            Ok(Some(_)) => continue,
            Ok(None) | Err(_) => return (None, seen),
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
    install_fast_revalidation();

    let jwt_secret = "ws-revocation-secret".to_string();
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
            bind_address: "127.0.0.1:0".to_string(),
            tls_enabled: false,
            tls_self_signed: false,
            auto_backup_enabled: false,
            auto_backup_interval_seconds: 86_400,
            federation_enabled: false,
            started_at: Utc::now(),
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

/// Create a user with a live login session; returns `(user_id, login_session_id,
/// access_token)`.
async fn make_user(env: &TestEnv) -> (i64, String, String) {
    let user_id = sid();
    let uniq = uuid::Uuid::new_v4().simple().to_string();
    let username = format!("u{}", &uniq[..10]);
    let email = format!("{uniq}@example.com");
    let password_hash = paracord_core::auth::hash_password("hunter2password").unwrap();
    let user =
        paracord_db::users::create_user(&env.db, user_id, &username, 1, &email, &password_hash)
            .await
            .expect("create user");
    let (session_id, token) = add_login_session(env, user.id).await;
    (user.id, session_id, token)
}

/// Add another live login session (and access token) for an existing user.
async fn add_login_session(env: &TestEnv, user_id: i64) -> (String, String) {
    let uniq = uuid::Uuid::new_v4().simple().to_string();
    let session_id = format!("auth-{uniq}");
    let jti = format!("jti-{uniq}");
    let refresh_hash = format!("rh-{uniq}");
    paracord_db::sessions::create_session(
        &env.db,
        &session_id,
        user_id,
        &refresh_hash,
        &jti,
        None,
        None,
        None,
        None,
        Utc::now() + ChronoDuration::days(1),
    )
    .await
    .expect("create login session");

    let token = paracord_core::auth::create_session_token(
        user_id,
        None,
        &env.jwt_secret,
        3600,
        &session_id,
        &jti,
    )
    .expect("token");
    (session_id, token)
}

/// Run IDENTIFY through the real handshake so the session carries whatever the
/// production path puts on it (login-session id, token expiry).
async fn identify(env: &TestEnv, token: &str) -> Session {
    let (mut client, tx, _srv, _srv_rx) = duplex();
    tx.send(identify_frame(token)).unwrap();
    let (session, resumed, _) = wait_for_identify_or_resume(&mut client, &env.state)
        .await
        .expect("identify accepted");
    assert!(!resumed, "IDENTIFY produces a fresh session");
    session
}

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

// ── Tests ───────────────────────────────────────────────────────────────────

/// Logout / password change / "revoke my other sessions" all write
/// `auth_sessions.revoked_at`. A live socket must notice and close.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoking_the_login_session_closes_the_live_socket() {
    let env = build_env().await;
    let (user_id, login_session_id, token) = make_user(&env).await;

    let session = identify(&env, &token).await;
    assert_eq!(
        session.auth_session_id, login_session_id,
        "the handshake must record the login session id for revalidation"
    );
    assert!(
        session.token_expires_at.is_some(),
        "the handshake must record the access token's expiry"
    );

    let bus = env.state.event_bus.clone();
    let (handle, _client_tx, mut server_rx) = spawn_session(session, env.state.clone());
    tokio::time::sleep(Duration::from_millis(100)).await;

    // While authenticated, a DM reaches the socket.
    bus.dispatch_to_users(
        "MESSAGE_CREATE",
        json!({ "content": "before" }),
        vec![user_id],
    );
    let frame = next_text(&mut server_rx, 1_000)
        .await
        .expect("event delivered while the session is live");
    assert_eq!(frame["t"], "MESSAGE_CREATE");

    // Log out.
    paracord_db::sessions::revoke_session(
        &env.db,
        &login_session_id,
        user_id,
        "logout",
        Utc::now(),
    )
    .await
    .expect("revoke session");

    let (code, _) = next_close(&mut server_rx, TICK_BUDGET_MS).await;
    assert_eq!(
        code,
        Some(4004),
        "a revoked session must be closed with the authentication-failed code"
    );

    let session = timeout(Duration::from_secs(2), handle)
        .await
        .expect("run_session must return after the credential is revoked")
        .expect("session task");

    // Nothing is delivered after the close.
    bus.dispatch_to_users(
        "MESSAGE_CREATE",
        json!({ "content": "after" }),
        vec![user_id],
    );
    assert!(
        next_text(&mut server_rx, 500).await.is_none(),
        "a revoked socket must stop delivering events"
    );
    // ...and the socket is no longer a registered event-bus session.
    assert!(
        bus.register_session(session.session_id.clone(), user_id + 1, &[])
            .is_some(),
        "the closed socket must have released its event-bus registration"
    );
}

/// The socket must not outlive the access token that opened it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_expired_access_token_closes_the_live_socket() {
    let env = build_env().await;
    let (user_id, _login_session_id, token) = make_user(&env).await;

    let mut session = identify(&env, &token).await;
    // The socket has now been open long enough that its token has expired; the
    // login session itself is still perfectly valid.
    session.token_expires_at = Some(Utc::now() - ChronoDuration::seconds(1));

    let bus = env.state.event_bus.clone();
    let (handle, _client_tx, mut server_rx) = spawn_session(session, env.state.clone());

    let (code, _) = next_close(&mut server_rx, TICK_BUDGET_MS).await;
    assert_eq!(
        code,
        Some(4004),
        "a socket whose access token has expired must be closed"
    );
    timeout(Duration::from_secs(2), handle)
        .await
        .expect("run_session must return once the token has expired")
        .expect("session task");

    bus.dispatch_to_users(
        "MESSAGE_CREATE",
        json!({ "content": "after" }),
        vec![user_id],
    );
    assert!(
        next_text(&mut server_rx, 500).await.is_none(),
        "an expired socket must stop delivering events"
    );
}

/// A socket closed for revocation must not be able to RESUME straight back into
/// the state it was closed out of.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_socket_closed_for_revocation_cannot_resume_back_in() {
    let env = build_env().await;
    let (user_id, login_session_id, token) = make_user(&env).await;

    // 1. A normal connect/disconnect leaves a resumable session behind.
    let session = identify(&env, &token).await;
    let gateway_session_id = session.session_id.clone();
    let bus = env.state.event_bus.clone();
    let (handle, client_tx, mut server_rx) = spawn_session(session, env.state.clone());
    tokio::time::sleep(Duration::from_millis(100)).await;
    bus.dispatch_to_users("MESSAGE_CREATE", json!({ "content": "one" }), vec![user_id]);
    assert!(next_text(&mut server_rx, 1_000).await.is_some());
    drop(client_tx);
    timeout(Duration::from_secs(2), handle)
        .await
        .expect("first session ends")
        .expect("session task");

    // 2. RESUME works while the credential is good.
    let (mut client, tx, _srv, _srv_rx) = duplex();
    tx.send(resume_frame(&token, &gateway_session_id, 1_000))
        .unwrap();
    let (resumed_session, resumed, _) = wait_for_identify_or_resume(&mut client, &env.state)
        .await
        .expect("resume accepted");
    assert!(resumed, "a live credential must be able to resume");
    assert_eq!(resumed_session.session_id, gateway_session_id);

    // 3. The resumed socket is then revoked out from under itself.
    let (handle, _client_tx, mut server_rx) = spawn_session(resumed_session, env.state.clone());
    tokio::time::sleep(Duration::from_millis(100)).await;
    paracord_db::sessions::revoke_session(
        &env.db,
        &login_session_id,
        user_id,
        "logout",
        Utc::now(),
    )
    .await
    .expect("revoke session");
    let (code, _) = next_close(&mut server_rx, TICK_BUDGET_MS).await;
    assert_eq!(code, Some(4004));
    timeout(Duration::from_secs(2), handle)
        .await
        .expect("revoked session ends")
        .expect("session task");

    // 4. The user logs in again (a genuinely valid credential) and tries to
    //    RESUME the socket that was killed. It must not come back: the state was
    //    dropped, so the client is forced through a fresh IDENTIFY.
    let (_new_login_session_id, new_token) = add_login_session(&env, user_id).await;
    let (mut client, tx, _srv, _srv_rx) = duplex();
    tx.send(resume_frame(&new_token, &gateway_session_id, 1_000))
        .unwrap();
    let (fresh, resumed, _) = wait_for_identify_or_resume(&mut client, &env.state)
        .await
        .expect("handshake accepted with the new credential");
    assert!(
        !resumed,
        "a socket closed for revocation must not be resumable"
    );
    assert_ne!(
        fresh.session_id, gateway_session_id,
        "the revoked gateway session must not be handed back"
    );
}

/// Control: revalidation must not disturb a socket whose credential is fine.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_live_credential_survives_repeated_revalidation() {
    let env = build_env().await;
    let (user_id, _login_session_id, token) = make_user(&env).await;

    let session = identify(&env, &token).await;
    let bus = env.state.event_bus.clone();
    let (handle, client_tx, mut server_rx) = spawn_session(session, env.state.clone());

    // Span several revalidation ticks.
    for i in 0..4 {
        tokio::time::sleep(Duration::from_millis(REVALIDATE_MS + 60)).await;
        bus.dispatch_to_users(
            "MESSAGE_CREATE",
            json!({ "content": format!("tick-{i}") }),
            vec![user_id],
        );
        let frame = next_text(&mut server_rx, 1_000)
            .await
            .unwrap_or_else(|| panic!("event {i} must still be delivered"));
        assert_eq!(frame["t"], "MESSAGE_CREATE");
    }

    drop(client_tx);
    timeout(Duration::from_secs(2), handle)
        .await
        .expect("session ends on client disconnect")
        .expect("session task");
}
