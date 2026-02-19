use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::Context;
use axum::{
    body::{to_bytes, Body},
    http::{header, Method, Request, StatusCode},
    Router,
};
use chrono::{Duration, Utc};
use paracord_core::{build_permission_cache, AppConfig, AppState, RuntimeSettings};
use paracord_media::{
    LiveKitConfig, LocalStorage, Storage, StorageConfig, StorageManager, VoiceManager,
};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::sync::{Notify, RwLock};
use tower::ServiceExt;
use uuid::Uuid;

struct TestContext {
    app: Router,
    token: String,
    _storage_dir: TempDir,
    _media_dir: TempDir,
    _backup_dir: TempDir,
}

impl TestContext {
    async fn new() -> anyhow::Result<Self> {
        let db = paracord_db::create_pool("sqlite::memory:", 1).await?;
        paracord_db::run_migrations(&db).await?;

        let storage_dir = tempfile::tempdir()?;
        let media_dir = tempfile::tempdir()?;
        let backup_dir = tempfile::tempdir()?;
        let jwt_secret = "integration-test-secret".to_string();

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
            member_index: Arc::new(paracord_core::member_index::MemberIndex::empty()),
        };

        paracord_api::install_http_rate_limiter();
        let app = paracord_api::build_router().with_state(state);
        let token = create_authenticated_user_token(&db, &jwt_secret).await?;

        Ok(Self {
            app,
            token,
            _storage_dir: storage_dir,
            _media_dir: media_dir,
            _backup_dir: backup_dir,
        })
    }

    async fn request_json(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token));

        let request = if let Some(payload) = body {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            builder.body(Body::from(payload.to_string()))?
        } else {
            builder.body(Body::empty())?
        };

        let response = self.app.clone().oneshot(request).await?;
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
}

async fn create_authenticated_user_token(
    db: &paracord_db::DbPool,
    jwt_secret: &str,
) -> anyhow::Result<String> {
    let user_id = paracord_util::snowflake::generate(1);
    let nonce = Uuid::new_v4().simple().to_string();
    let username = format!("integration_{nonce}");
    let email = format!("{nonce}@example.com");
    let password_hash = paracord_core::auth::hash_password("IntegrationPass123!")?;

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

async fn create_guild(ctx: &TestContext, name: &str) -> anyhow::Result<String> {
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": name, "icon": Value::Null })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    Ok(payload["id"]
        .as_str()
        .context("guild id should be a string")?
        .to_string())
}

async fn create_text_channel(
    ctx: &TestContext,
    guild_id: &str,
    name: &str,
) -> anyhow::Result<String> {
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(json!({
                "name": name,
                "channel_type": 0,
                "parent_id": Value::Null,
                "required_role_ids": Value::Null,
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    Ok(payload["id"]
        .as_str()
        .context("channel id should be a string")?
        .to_string())
}

#[tokio::test]
async fn create_guild_channel_send_message_flow_works_end_to_end() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Flow Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "flow-chat").await?;

    let (status, message) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({ "content": "integration hello world" })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    let message_id = message["id"]
        .as_str()
        .context("message id should be a string")?
        .to_string();

    let (status, messages) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/messages"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected response payload: {messages}"
    );
    let list = messages
        .as_array()
        .context("messages list should be an array")?;
    assert!(list
        .iter()
        .any(|m| m.get("id").and_then(Value::as_str) == Some(message_id.as_str())));

    Ok(())
}

#[tokio::test]
async fn channel_crud_routes_work() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Channel CRUD Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "general").await?;

    let (status, channel) = ctx
        .request_json(Method::GET, &format!("/api/v1/channels/{channel_id}"), None)
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(channel["id"], channel_id);
    assert_eq!(channel["name"], "general");

    let (status, updated) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/channels/{channel_id}"),
            Some(json!({
                "name": "renamed-general",
                "topic": "Updated integration topic",
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["name"], "renamed-general");
    assert_eq!(updated["topic"], "Updated integration topic");

    let (status, _) = ctx
        .request_json(
            Method::DELETE,
            &format!("/api/v1/channels/{channel_id}"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _) = ctx
        .request_json(Method::GET, &format!("/api/v1/channels/{channel_id}"), None)
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);

    Ok(())
}

#[tokio::test]
async fn message_crud_routes_work() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Message CRUD Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "chat").await?;

    let (status, created) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({ "content": "original body" })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    let message_id = created["id"]
        .as_str()
        .context("message id should be a string")?
        .to_string();

    let (status, edited) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/channels/{channel_id}/messages/{message_id}"),
            Some(json!({ "content": "edited body" })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "unexpected PATCH payload: {edited}");
    assert_eq!(edited["content"], "edited body");

    let (status, messages) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/messages"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let list = messages
        .as_array()
        .context("messages list should be an array")?;
    assert!(list
        .iter()
        .any(|m| m.get("id").and_then(Value::as_str) == Some(message_id.as_str())));

    let (status, _) = ctx
        .request_json(
            Method::DELETE,
            &format!("/api/v1/channels/{channel_id}/messages/{message_id}"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, messages_after_delete) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/messages"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let list_after_delete = messages_after_delete
        .as_array()
        .context("messages list should be an array")?;
    assert!(!list_after_delete
        .iter()
        .any(|m| m.get("id").and_then(Value::as_str) == Some(message_id.as_str())));

    Ok(())
}

#[tokio::test]
async fn thread_routes_work() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Thread Routes Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "thread-parent").await?;

    let (status, created_thread) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/threads"),
            Some(json!({
                "name": "first-thread",
                "auto_archive_duration": 1440
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "unexpected thread payload: {created_thread}");
    let thread_id = created_thread["id"]
        .as_str()
        .context("thread id should be a string")?
        .to_string();
    assert_eq!(created_thread["parent_id"], channel_id);
    assert!(created_thread["owner_id"].is_string());

    let (status, threads) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/threads"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let active_threads = threads
        .as_array()
        .context("threads response should be an array")?;
    assert!(active_threads
        .iter()
        .any(|thread| thread.get("id").and_then(Value::as_str) == Some(thread_id.as_str())));

    let (status, archived) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/channels/{channel_id}/threads/{thread_id}"),
            Some(json!({ "archived": true })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "unexpected archived payload: {archived}");
    assert_eq!(archived["id"], thread_id);

    let (status, archived_threads) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/threads/archived"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let archived_list = archived_threads
        .as_array()
        .context("archived threads response should be an array")?;
    assert!(archived_list
        .iter()
        .any(|thread| thread.get("id").and_then(Value::as_str) == Some(thread_id.as_str())));

    let (status, _) = ctx
        .request_json(
            Method::DELETE,
            &format!("/api/v1/channels/{channel_id}/threads/{thread_id}"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    Ok(())
}
