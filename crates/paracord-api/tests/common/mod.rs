#![allow(dead_code)]

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{header, Method, Request, StatusCode},
    middleware::{from_fn, Next},
    Router,
};
use chrono::{Duration, Utc};
use dashmap::{DashMap, DashSet};
use paracord_core::{build_permission_cache, AppConfig, AppState, RuntimeSettings};
use paracord_media::{
    LiveKitConfig, LocalStorage, Storage, StorageConfig, StorageManager, VoiceManager,
};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::sync::{Notify, RwLock};
use tower::ServiceExt;
use uuid::Uuid;

pub struct TestAppOptions {
    pub database_url: Option<String>,
    pub run_migrations: bool,
    pub install_http_rate_limiter: bool,
    pub jwt_secret: String,
    pub registration_enabled: bool,
    pub allow_username_login: bool,
    pub require_email: bool,
    pub native_media_enabled: bool,
    pub native_media_port: u16,
    pub native_media_max_participants: u32,
    pub native_media_e2ee_required: bool,
    pub livekit_available: bool,
    pub ai_provider: Option<String>,
    pub ai_base_url: Option<String>,
    pub ai_api_key: Option<String>,
    pub ai_model: Option<String>,
    pub ai_timeout_seconds: u64,
}

impl Default for TestAppOptions {
    fn default() -> Self {
        Self {
            database_url: None,
            run_migrations: true,
            install_http_rate_limiter: false,
            jwt_secret: "integration-test-secret".to_string(),
            registration_enabled: true,
            allow_username_login: false,
            require_email: true,
            native_media_enabled: false,
            native_media_port: 8443,
            native_media_max_participants: 50,
            native_media_e2ee_required: false,
            livekit_available: false,
            ai_provider: None,
            ai_base_url: None,
            ai_api_key: None,
            ai_model: None,
            ai_timeout_seconds: 20,
        }
    }
}

pub struct TestApp {
    pub app: Router,
    pub db: paracord_db::DbPool,
    pub jwt_secret: String,
    pub event_bus: paracord_core::events::EventBus,
    _storage_dir: TempDir,
    _media_dir: TempDir,
    _backup_dir: TempDir,
}

pub async fn build_test_app(options: TestAppOptions) -> anyhow::Result<TestApp> {
    let database_url = options
        .database_url
        .clone()
        .unwrap_or_else(|| "sqlite::memory:".to_string());
    let db = paracord_db::create_pool(&database_url, 1).await?;
    if options.run_migrations {
        paracord_db::run_migrations(&db).await?;
    }

    if options.install_http_rate_limiter {
        paracord_api::install_http_rate_limiter();
    }

    let storage_dir = tempfile::tempdir()?;
    let media_dir = tempfile::tempdir()?;
    let backup_dir = tempfile::tempdir()?;
    let event_bus = paracord_core::events::EventBus::default();

    let livekit = Arc::new(LiveKitConfig {
        api_key: "lk-test-key".to_string(),
        api_secret: "lk-test-secret".to_string(),
        url: "ws://localhost:7880".to_string(),
        http_url: "http://localhost:7880".to_string(),
    });

    // When native media is enabled, build a real NativeMediaState so the voice
    // routes exercise the full native contract (room manager + cert_hash). The
    // QUIC endpoint binds an ephemeral loopback port — the response payload uses
    // the configured `native_media_port`, so the actual bound port is irrelevant.
    let native_media = if options.native_media_enabled {
        use paracord_transport::endpoint::{
            certificate_hash, generate_self_signed_cert, MediaEndpoint,
        };
        let tls = generate_self_signed_cert()?;
        let cert_hash = certificate_hash(&tls.cert_chain[0]);
        let endpoint = MediaEndpoint::bind("127.0.0.1:0".parse().unwrap(), tls)?;
        let rooms = Arc::new(paracord_relay::room::MediaRoomManager::new());
        let speaker_detector = Arc::new(paracord_relay::speaker::SpeakerDetector::new());
        let relay_forwarder = Arc::new(paracord_relay::relay::RelayForwarder::new(
            Arc::clone(&rooms),
            Arc::clone(&speaker_detector),
        ));
        Some(paracord_core::NativeMediaState {
            rooms,
            speaker_detector,
            endpoint: Arc::new(endpoint),
            relay_forwarder,
            cert_hash,
        })
    } else {
        None
    };

    let state = AppState {
        db: db.clone(),
        event_bus: event_bus.clone(),
        config: AppConfig {
            jwt_secret: options.jwt_secret.clone(),
            jwt_expiry_seconds: 3600,
            registration_enabled: options.registration_enabled,
            allow_username_login: options.allow_username_login,
            require_email: options.require_email,
            storage_path: storage_dir.path().to_string_lossy().into_owned(),
            max_upload_size: 10 * 1024 * 1024,
            livekit_api_key: livekit.api_key.clone(),
            livekit_api_secret: livekit.api_secret.clone(),
            livekit_url: livekit.url.clone(),
            livekit_http_url: livekit.http_url.clone(),
            livekit_public_url: livekit.url.clone(),
            livekit_available: options.livekit_available,
            public_url: None,
            media_storage_path: media_dir.path().to_string_lossy().into_owned(),
            media_max_file_size: 10 * 1024 * 1024,
            media_p2p_threshold: 1024 * 1024,
            file_cryptor: None,
            totp_cryptor: None,
            backup_dir: backup_dir.path().to_string_lossy().into_owned(),
            database_url,
            federation_max_events_per_peer_per_minute: None,
            federation_max_user_creates_per_peer_per_hour: None,
            native_media_enabled: options.native_media_enabled,
            native_media_port: options.native_media_port,
            native_media_max_participants: options.native_media_max_participants,
            native_media_e2ee_required: options.native_media_e2ee_required,
            max_guild_storage_quota: 0,
            federation_file_cache_enabled: false,
            federation_file_cache_max_size: 0,
            federation_file_cache_ttl_hours: 0,
            tenor_api_key: None,
            require_email_verification: false,
            ai_provider: options.ai_provider.clone(),
            ai_base_url: options.ai_base_url.clone(),
            ai_api_key: options.ai_api_key.clone(),
            ai_model: options.ai_model.clone(),
            ai_timeout_seconds: options.ai_timeout_seconds,
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
        native_media,
        mfa_tickets: moka::future::Cache::builder()
            .max_capacity(10_000)
            .time_to_live(std::time::Duration::from_secs(300))
            .build(),
    };

    // The HTTP rate limiter is a process-global keyed on the peer IP. Test
    // requests carry no `ConnectInfo`, so without this every test app would
    // share the "unknown" bucket and collectively trip the global limit when
    // the suite runs in parallel. Stamp each app with a distinct client IP so
    // its rate-limit buckets are isolated (mirroring distinct real clients). A
    // request that already carries an explicit `ConnectInfo` (e.g. a test that
    // pins a specific peer address) is left untouched.
    static TEST_CLIENT_SEQ: AtomicU32 = AtomicU32::new(1);
    let client_addr = SocketAddr::new(
        IpAddr::V4(Ipv4Addr::from(
            0x0a00_0000 | (TEST_CLIENT_SEQ.fetch_add(1, Ordering::Relaxed) & 0x00ff_ffff),
        )),
        0,
    );
    let app = paracord_api::build_router()
        .with_state(state)
        .layer(from_fn(
            move |mut req: Request<Body>, next: Next| async move {
                if req.extensions().get::<ConnectInfo<SocketAddr>>().is_none() {
                    req.extensions_mut().insert(ConnectInfo(client_addr));
                }
                next.run(req).await
            },
        ));
    Ok(TestApp {
        app,
        db,
        jwt_secret: options.jwt_secret,
        event_bus,
        _storage_dir: storage_dir,
        _media_dir: media_dir,
        _backup_dir: backup_dir,
    })
}

pub fn build_json_request(
    method: Method,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> anyhow::Result<Request<Body>> {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    if let Some(payload) = body {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
        Ok(builder.body(Body::from(payload.to_string()))?)
    } else {
        Ok(builder.body(Body::empty())?)
    }
}

pub async fn dispatch_json(
    app: &Router,
    request: Request<Body>,
) -> anyhow::Result<(StatusCode, Value)> {
    let response = app.clone().oneshot(request).await?;
    let status = response.status();
    let body_bytes = to_bytes(response.into_body(), usize::MAX).await?;
    let payload = if body_bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body_bytes)
            .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&body_bytes) }))
    };
    Ok((status, payload))
}

pub async fn create_authenticated_user_token(
    db: &paracord_db::DbPool,
    jwt_secret: &str,
    username_prefix: &str,
    password: &str,
) -> anyhow::Result<String> {
    let user_id = paracord_util::snowflake::generate(1);
    let nonce = Uuid::new_v4().simple().to_string();
    let suffix = &nonce[..12];
    let prefix_max_len = 32usize.saturating_sub(suffix.len() + 1);
    let prefix: String = username_prefix.chars().take(prefix_max_len).collect();
    let username = format!("{prefix}_{suffix}");
    let email = format!("{nonce}@example.com");
    let password_hash = paracord_core::auth::hash_password(password)?;

    let user =
        paracord_db::users::create_user(db, user_id, &username, 1, &email, &password_hash).await?;

    let session_id = format!("sess-{}", Uuid::new_v4().simple());
    let jti = format!("jti-{}", Uuid::new_v4().simple());
    let refresh_hash = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    paracord_db::sessions::create_session(
        db,
        &session_id,
        user.id,
        &refresh_hash,
        &jti,
        user.public_key.as_deref(),
        None,
        None,
        None,
        Utc::now() + Duration::days(1),
    )
    .await?;

    let token = paracord_core::auth::create_session_token(
        user.id,
        user.public_key.as_deref(),
        jwt_secret,
        3600,
        &session_id,
        &jti,
    )?;
    Ok(token)
}
