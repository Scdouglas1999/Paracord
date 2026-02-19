use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    Router,
};
use paracord_core::{build_permission_cache, AppConfig, AppState, RuntimeSettings};
use paracord_media::{
    LiveKitConfig, LocalStorage, Storage, StorageConfig, StorageManager, VoiceManager,
};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::sync::{Notify, RwLock};
use tower::ServiceExt;

fn env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

struct TestHarness {
    app: Router,
    db: paracord_db::DbPool,
    _storage_dir: TempDir,
    _media_dir: TempDir,
    _backup_dir: TempDir,
}

impl TestHarness {
    async fn new(run_migrations: bool) -> anyhow::Result<Self> {
        let db = paracord_db::create_pool("sqlite::memory:", 1).await?;
        if run_migrations {
            paracord_db::run_migrations(&db).await?;
        }

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
            db: db.clone(),
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
            member_index: Arc::new(paracord_core::member_index::MemberIndex::empty()),
        };

        let app = paracord_api::build_router().with_state(state);
        Ok(Self {
            app,
            db,
            _storage_dir: storage_dir,
            _media_dir: media_dir,
            _backup_dir: backup_dir,
        })
    }

    async fn request(&self, request: Request<Body>) -> anyhow::Result<(StatusCode, Value)> {
        let response = self.app.clone().oneshot(request).await?;
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await?;
        let payload = if body.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&body)
                .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&body) }))
        };
        Ok((status, payload))
    }
}

#[tokio::test]
async fn federation_read_rejects_unsigned_requests_without_token() -> anyhow::Result<()> {
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("PARACORD_FEDERATION_ENABLED", "true");
    std::env::remove_var("PARACORD_FEDERATION_READ_TOKEN");

    let harness = TestHarness::new(true).await?;
    let request = Request::builder()
        .uri("/_paracord/federation/v1/event/nonexistent")
        .body(Body::empty())?;

    let (status, _) = harness.request(request).await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    std::env::remove_var("PARACORD_FEDERATION_ENABLED");
    Ok(())
}

#[tokio::test]
async fn federation_read_accepts_configured_token() -> anyhow::Result<()> {
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("PARACORD_FEDERATION_ENABLED", "true");
    std::env::set_var("PARACORD_FEDERATION_READ_TOKEN", "token-123");

    let harness = TestHarness::new(true).await?;
    let request = Request::builder()
        .uri("/_paracord/federation/v1/event/nonexistent")
        .header("x-paracord-federation-token", "token-123")
        .header(header::ACCEPT, "application/json")
        .body(Body::empty())?;

    let (status, _) = harness.request(request).await?;
    assert_eq!(status, StatusCode::NOT_FOUND);

    std::env::remove_var("PARACORD_FEDERATION_ENABLED");
    std::env::remove_var("PARACORD_FEDERATION_READ_TOKEN");
    Ok(())
}

#[tokio::test]
async fn federation_media_token_requires_existing_room_membership() -> anyhow::Result<()> {
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("PARACORD_FEDERATION_ENABLED", "true");

    let harness = TestHarness::new(true).await?;

    let owner_id = 5001;
    paracord_db::users::create_user(
        &harness.db,
        owner_id,
        "owner",
        1,
        "owner@example.com",
        "hash",
    )
    .await?;
    let guild_id = 7001;
    paracord_db::guilds::create_guild(&harness.db, guild_id, "Guild", owner_id, None).await?;
    paracord_db::channels::create_channel(&harness.db, 7002, guild_id, "voice", 2, 0, None, None)
        .await?;
    std::env::set_var(
        "PARACORD_FEDERATION_ALLOWED_GUILD_IDS",
        guild_id.to_string(),
    );

    let origin_server = "remote.example";
    let key_id = "ed25519:test";
    let (signing_key, public_key_hex) = paracord_federation::signing::generate_keypair();
    paracord_db::federation::upsert_federated_server(
        &harness.db,
        9001,
        origin_server,
        origin_server,
        "https://remote.example/_paracord/federation/v1",
        Some(&public_key_hex),
        Some(key_id),
        true,
    )
    .await?;
    let service =
        paracord_federation::FederationService::new(paracord_federation::FederationConfig {
            enabled: true,
            server_name: "local.example".to_string(),
            domain: "local.example".to_string(),
            key_id: "ed25519:local".to_string(),
            signing_key: None,
            allow_discovery: false,
        });
    service
        .upsert_server_key(
            &harness.db,
            &paracord_federation::FederationServerKey {
                server_name: origin_server.to_string(),
                key_id: key_id.to_string(),
                public_key: public_key_hex.to_string(),
                valid_until: chrono::Utc::now().timestamp_millis() + 600_000,
            },
        )
        .await?;

    let body = json!({
        "origin_server": origin_server,
        "channel_id": "7002",
        "user_id": "@alice:remote.example"
    });
    let body_bytes = serde_json::to_vec(&body)?;
    let timestamp_ms = chrono::Utc::now().timestamp_millis();
    let canonical = paracord_federation::transport::canonical_transport_bytes_with_body(
        "POST",
        "/_paracord/federation/v1/media/token",
        timestamp_ms,
        &body_bytes,
    );
    let signature = paracord_federation::signing::sign(&signing_key, &canonical);

    let request = Request::builder()
        .method("POST")
        .uri("/_paracord/federation/v1/media/token")
        .header("content-type", "application/json")
        .header("x-paracord-origin", origin_server)
        .header("x-paracord-key-id", key_id)
        .header("x-paracord-timestamp", timestamp_ms.to_string())
        .header("x-paracord-signature", signature)
        .body(Body::from(body_bytes))?;

    let (status, _) = harness.request(request).await?;
    assert_eq!(status, StatusCode::FORBIDDEN);

    std::env::remove_var("PARACORD_FEDERATION_ENABLED");
    std::env::remove_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS");
    Ok(())
}

#[tokio::test]
async fn federation_message_ingest_materializes_missing_space_and_channel() -> anyhow::Result<()> {
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("PARACORD_FEDERATION_ENABLED", "true");

    let harness = TestHarness::new(true).await?;
    let origin_server = "remote.example";
    let key_id = "ed25519:test";
    let (signing_key, public_key_hex) = paracord_federation::signing::generate_keypair();

    paracord_db::federation::upsert_federated_server(
        &harness.db,
        9101,
        origin_server,
        origin_server,
        "https://remote.example/_paracord/federation/v1",
        Some(&public_key_hex),
        Some(key_id),
        true,
    )
    .await?;

    let service =
        paracord_federation::FederationService::new(paracord_federation::FederationConfig {
            enabled: true,
            server_name: "local.example".to_string(),
            domain: "local.example".to_string(),
            key_id: "ed25519:local".to_string(),
            signing_key: None,
            allow_discovery: false,
        });
    service
        .upsert_server_key(
            &harness.db,
            &paracord_federation::FederationServerKey {
                server_name: origin_server.to_string(),
                key_id: key_id.to_string(),
                public_key: public_key_hex.to_string(),
                valid_until: chrono::Utc::now().timestamp_millis() + 600_000,
            },
        )
        .await?;

    let mut envelope = paracord_federation::FederationEventEnvelope {
        event_id: "$evt1:remote.example".to_string(),
        room_id: "!7010:remote.example".to_string(),
        event_type: "m.message".to_string(),
        sender: "@alice:remote.example".to_string(),
        origin_server: origin_server.to_string(),
        origin_ts: chrono::Utc::now().timestamp_millis(),
        content: json!({
            "body": "hello from remote",
            "msgtype": "m.text",
            "guild_id": "7010",
            "guild_name": "Remote Guild",
            "channel_id": "7020",
            "channel_name": "general",
            "channel_type": 0,
            "message_id": "90001",
        }),
        depth: chrono::Utc::now().timestamp_millis(),
        state_key: None,
        signatures: json!({}),
    };
    let payload_sig = paracord_federation::signing::sign(
        &signing_key,
        &paracord_federation::canonical_envelope_bytes(&envelope),
    );
    envelope.signatures = json!({
        origin_server: {
            key_id: payload_sig,
        }
    });

    let body_bytes = serde_json::to_vec(&envelope)?;
    let timestamp_ms = chrono::Utc::now().timestamp_millis();
    let canonical = paracord_federation::transport::canonical_transport_bytes_with_body(
        "POST",
        "/_paracord/federation/v1/event",
        timestamp_ms,
        &body_bytes,
    );
    let transport_sig = paracord_federation::signing::sign(&signing_key, &canonical);

    let request = Request::builder()
        .method("POST")
        .uri("/_paracord/federation/v1/event")
        .header("content-type", "application/json")
        .header("x-paracord-origin", origin_server)
        .header("x-paracord-key-id", key_id)
        .header("x-paracord-timestamp", timestamp_ms.to_string())
        .header("x-paracord-signature", transport_sig)
        .body(Body::from(body_bytes))?;

    let (status, body) = harness.request(request).await?;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(body.get("inserted").and_then(|v| v.as_bool()), Some(true));

    let space_mapping =
        paracord_db::federation::get_space_mapping_by_remote(&harness.db, origin_server, "7010")
            .await?
            .expect("space mapping should be created");
    let local_guild_id = space_mapping.local_guild_id;
    let space = paracord_db::guilds::get_guild(&harness.db, local_guild_id)
        .await?
        .expect("space should be materialized");
    assert_eq!(space.name, "Remote Guild");
    let channel_mapping =
        paracord_db::federation::get_channel_mapping_by_remote(&harness.db, origin_server, "7020")
            .await?
            .expect("channel mapping should be created");
    let local_channel_id = channel_mapping.local_channel_id;
    let channel = paracord_db::channels::get_channel(&harness.db, local_channel_id)
        .await?
        .expect("channel should be materialized");
    assert_eq!(channel.guild_id(), Some(local_guild_id));
    assert_eq!(channel.name.as_deref(), Some("general"));

    let msgs =
        paracord_db::messages::get_channel_messages(&harness.db, local_channel_id, None, None, 10)
            .await?;
    assert!(
        msgs.iter()
            .any(|m| m.content.as_deref() == Some("hello from remote")),
        "expected message content to be stored after federated ingest"
    );

    std::env::remove_var("PARACORD_FEDERATION_ENABLED");
    Ok(())
}

#[tokio::test]
async fn federation_ingest_does_not_collide_with_existing_local_ids() -> anyhow::Result<()> {
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("PARACORD_FEDERATION_ENABLED", "true");

    let harness = TestHarness::new(true).await?;
    let owner_id = 42_001;
    paracord_db::users::create_user(
        &harness.db,
        owner_id,
        "owner",
        1,
        "owner@example.com",
        "hash",
    )
    .await?;
    paracord_db::guilds::create_guild(&harness.db, 7010, "Local Guild", owner_id, None).await?;
    paracord_db::channels::create_channel(
        &harness.db,
        7020,
        7010,
        "local-general",
        0,
        0,
        None,
        None,
    )
    .await?;

    let origin_server = "remote.example";
    let key_id = "ed25519:test";
    let (signing_key, public_key_hex) = paracord_federation::signing::generate_keypair();
    paracord_db::federation::upsert_federated_server(
        &harness.db,
        9201,
        origin_server,
        origin_server,
        "https://remote.example/_paracord/federation/v1",
        Some(&public_key_hex),
        Some(key_id),
        true,
    )
    .await?;
    let service =
        paracord_federation::FederationService::new(paracord_federation::FederationConfig {
            enabled: true,
            server_name: "local.example".to_string(),
            domain: "local.example".to_string(),
            key_id: "ed25519:local".to_string(),
            signing_key: None,
            allow_discovery: false,
        });
    service
        .upsert_server_key(
            &harness.db,
            &paracord_federation::FederationServerKey {
                server_name: origin_server.to_string(),
                key_id: key_id.to_string(),
                public_key: public_key_hex.to_string(),
                valid_until: chrono::Utc::now().timestamp_millis() + 600_000,
            },
        )
        .await?;

    let mut envelope = paracord_federation::FederationEventEnvelope {
        event_id: "$evt-collision:remote.example".to_string(),
        room_id: "!7010:remote.example".to_string(),
        event_type: "m.message".to_string(),
        sender: "@alice:remote.example".to_string(),
        origin_server: origin_server.to_string(),
        origin_ts: chrono::Utc::now().timestamp_millis(),
        content: json!({
            "body": "remote payload",
            "msgtype": "m.text",
            "guild_id": "7010",
            "guild_name": "Remote Guild",
            "channel_id": "7020",
            "channel_name": "remote-general",
            "channel_type": 0,
            "message_id": "91001",
        }),
        depth: chrono::Utc::now().timestamp_millis(),
        state_key: None,
        signatures: json!({}),
    };
    let payload_sig = paracord_federation::signing::sign(
        &signing_key,
        &paracord_federation::canonical_envelope_bytes(&envelope),
    );
    envelope.signatures = json!({
        origin_server: {
            key_id: payload_sig,
        }
    });

    let body_bytes = serde_json::to_vec(&envelope)?;
    let timestamp_ms = chrono::Utc::now().timestamp_millis();
    let canonical = paracord_federation::transport::canonical_transport_bytes_with_body(
        "POST",
        "/_paracord/federation/v1/event",
        timestamp_ms,
        &body_bytes,
    );
    let transport_sig = paracord_federation::signing::sign(&signing_key, &canonical);

    let request = Request::builder()
        .method("POST")
        .uri("/_paracord/federation/v1/event")
        .header("content-type", "application/json")
        .header("x-paracord-origin", origin_server)
        .header("x-paracord-key-id", key_id)
        .header("x-paracord-timestamp", timestamp_ms.to_string())
        .header("x-paracord-signature", transport_sig)
        .body(Body::from(body_bytes))?;
    let (status, _) = harness.request(request).await?;
    assert_eq!(status, StatusCode::ACCEPTED);

    let space_mapping =
        paracord_db::federation::get_space_mapping_by_remote(&harness.db, origin_server, "7010")
            .await?
            .expect("remote space should map");
    let channel_mapping =
        paracord_db::federation::get_channel_mapping_by_remote(&harness.db, origin_server, "7020")
            .await?
            .expect("remote channel should map");
    assert_ne!(space_mapping.local_guild_id, 7010);
    assert_ne!(channel_mapping.local_channel_id, 7020);

    let local_msgs =
        paracord_db::messages::get_channel_messages(&harness.db, 7020, None, None, 10).await?;
    assert!(
        local_msgs
            .iter()
            .all(|m| m.content.as_deref() != Some("remote payload")),
        "remote message should not land in pre-existing local channel"
    );

    let remote_msgs = paracord_db::messages::get_channel_messages(
        &harness.db,
        channel_mapping.local_channel_id,
        None,
        None,
        10,
    )
    .await?;
    assert!(
        remote_msgs
            .iter()
            .any(|m| m.content.as_deref() == Some("remote payload")),
        "remote message should be stored in mapped federated channel"
    );

    std::env::remove_var("PARACORD_FEDERATION_ENABLED");
    Ok(())
}

#[tokio::test]
async fn federation_room_namespace_mapping_is_used_even_when_sender_differs() -> anyhow::Result<()>
{
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("PARACORD_FEDERATION_ENABLED", "true");

    let harness = TestHarness::new(true).await?;

    let owner_id = 58_001;
    paracord_db::users::create_user(
        &harness.db,
        owner_id,
        "owner",
        1,
        "owner@example.com",
        "hash",
    )
    .await?;

    let local_guild_id = 88_001;
    let local_channel_id = 88_002;
    paracord_db::guilds::create_guild(
        &harness.db,
        local_guild_id,
        "Mirrored Remote",
        owner_id,
        None,
    )
    .await?;
    paracord_db::channels::create_channel(
        &harness.db,
        local_channel_id,
        local_guild_id,
        "remote-general",
        0,
        0,
        None,
        None,
    )
    .await?;

    // Namespace mapping says room IDs in remote.example should map to these local IDs.
    paracord_db::federation::upsert_space_mapping(
        &harness.db,
        "remote.example",
        "7010",
        local_guild_id,
    )
    .await?;
    paracord_db::federation::upsert_channel_mapping(
        &harness.db,
        "remote.example",
        "7020",
        local_channel_id,
        local_guild_id,
    )
    .await?;

    let sender_server = "relay.example";
    let key_id = "ed25519:test";
    let (signing_key, public_key_hex) = paracord_federation::signing::generate_keypair();
    paracord_db::federation::upsert_federated_server(
        &harness.db,
        9301,
        sender_server,
        sender_server,
        "https://relay.example/_paracord/federation/v1",
        Some(&public_key_hex),
        Some(key_id),
        true,
    )
    .await?;

    let service =
        paracord_federation::FederationService::new(paracord_federation::FederationConfig {
            enabled: true,
            server_name: "local.example".to_string(),
            domain: "local.example".to_string(),
            key_id: "ed25519:local".to_string(),
            signing_key: None,
            allow_discovery: false,
        });
    service
        .upsert_server_key(
            &harness.db,
            &paracord_federation::FederationServerKey {
                server_name: sender_server.to_string(),
                key_id: key_id.to_string(),
                public_key: public_key_hex.to_string(),
                valid_until: chrono::Utc::now().timestamp_millis() + 600_000,
            },
        )
        .await?;

    let mut envelope = paracord_federation::FederationEventEnvelope {
        event_id: "$evt-ns:relay.example".to_string(),
        room_id: "!7010:remote.example".to_string(),
        event_type: "m.message".to_string(),
        sender: "@bob:relay.example".to_string(),
        origin_server: sender_server.to_string(),
        origin_ts: chrono::Utc::now().timestamp_millis(),
        content: json!({
            "body": "cross-origin room message",
            "msgtype": "m.text",
            "guild_id": "7010",
            "channel_id": "7020",
            "message_id": "92001",
        }),
        depth: chrono::Utc::now().timestamp_millis(),
        state_key: None,
        signatures: json!({}),
    };
    let payload_sig = paracord_federation::signing::sign(
        &signing_key,
        &paracord_federation::canonical_envelope_bytes(&envelope),
    );
    envelope.signatures = json!({
        sender_server: {
            key_id: payload_sig,
        }
    });

    let body_bytes = serde_json::to_vec(&envelope)?;
    let timestamp_ms = chrono::Utc::now().timestamp_millis();
    let canonical = paracord_federation::transport::canonical_transport_bytes_with_body(
        "POST",
        "/_paracord/federation/v1/event",
        timestamp_ms,
        &body_bytes,
    );
    let transport_sig = paracord_federation::signing::sign(&signing_key, &canonical);
    let request = Request::builder()
        .method("POST")
        .uri("/_paracord/federation/v1/event")
        .header("content-type", "application/json")
        .header("x-paracord-origin", sender_server)
        .header("x-paracord-key-id", key_id)
        .header("x-paracord-timestamp", timestamp_ms.to_string())
        .header("x-paracord-signature", transport_sig)
        .body(Body::from(body_bytes))?;
    let (status, _) = harness.request(request).await?;
    assert_eq!(status, StatusCode::ACCEPTED);

    let msgs =
        paracord_db::messages::get_channel_messages(&harness.db, local_channel_id, None, None, 10)
            .await?;
    assert!(
        msgs.iter()
            .any(|m| m.content.as_deref() == Some("cross-origin room message")),
        "message should resolve via room namespace mapping instead of sender namespace"
    );

    let wrong_space_map =
        paracord_db::federation::get_space_mapping_by_remote(&harness.db, sender_server, "7010")
            .await?;
    assert!(
        wrong_space_map.is_none(),
        "sender namespace should not be used for room mapping keys"
    );

    std::env::remove_var("PARACORD_FEDERATION_ENABLED");
    Ok(())
}
