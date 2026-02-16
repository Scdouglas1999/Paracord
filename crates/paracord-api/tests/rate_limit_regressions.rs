use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use paracord_core::{build_permission_cache, AppConfig, AppState, RuntimeSettings};
use paracord_media::{
    LiveKitConfig, LocalStorage, Storage, StorageConfig, StorageManager, VoiceManager,
};
use tempfile::TempDir;
use tokio::sync::{Notify, RwLock};
use tower::ServiceExt;

fn env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

struct TestHarness {
    app: Router,
    _storage_dir: TempDir,
    _media_dir: TempDir,
    _backup_dir: TempDir,
}

impl TestHarness {
    async fn new_without_migrations() -> anyhow::Result<Self> {
        let db = paracord_db::create_pool("sqlite::memory:", 1).await?;
        paracord_api::install_rate_limit_backend(db.clone());

        let storage_dir = tempfile::tempdir()?;
        let media_dir = tempfile::tempdir()?;
        let backup_dir = tempfile::tempdir()?;
        let livekit = Arc::new(LiveKitConfig {
            api_key: "lk-test-key".to_string(),
            api_secret: "lk-test-secret".to_string(),
            url: "ws://localhost:7880".to_string(),
            http_url: "http://localhost:7880".to_string(),
        });

        let state = AppState {
            db,
            event_bus: paracord_core::events::EventBus::default(),
            config: AppConfig {
                jwt_secret: "integration-test-secret".to_string(),
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
                backup_dir: backup_dir.path().to_string_lossy().into_owned(),
                database_url: "sqlite::memory:".to_string(),
                federation_max_events_per_peer_per_minute: None,
                federation_max_user_creates_per_peer_per_hour: None,
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
            online_users: Arc::new(RwLock::new(HashSet::new())),
            user_presences: Arc::new(RwLock::new(HashMap::new())),
            permission_cache: build_permission_cache(),
            federation_service: None,
        };

        let app = paracord_api::build_router().with_state(state);
        Ok(Self {
            app,
            _storage_dir: storage_dir,
            _media_dir: media_dir,
            _backup_dir: backup_dir,
        })
    }
}

#[tokio::test]
async fn rate_limit_backend_failure_fails_closed_unless_explicit_fail_open() -> anyhow::Result<()> {
    let _guard = env_lock().lock().expect("env lock");
    std::env::remove_var("PARACORD_RATE_LIMIT_FAIL_OPEN");
    let harness = TestHarness::new_without_migrations().await?;

    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/refresh")
        .body(Body::empty())?;
    let response = harness.app.clone().oneshot(request).await?;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);

    std::env::set_var("PARACORD_RATE_LIMIT_FAIL_OPEN", "true");
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/refresh")
        .body(Body::empty())?;
    let response = harness.app.clone().oneshot(request).await?;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    std::env::remove_var("PARACORD_RATE_LIMIT_FAIL_OPEN");

    Ok(())
}
