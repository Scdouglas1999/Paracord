mod common;

use std::{net::SocketAddr, sync::OnceLock};

use axum::{
    body::Body,
    extract::connect_info::ConnectInfo,
    http::{header, Request, StatusCode},
    routing::get,
    Json, Router,
};
use common::{build_test_app, dispatch_json, TestApp, TestAppOptions};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

// Serializes tests that mutate process-global federation env vars. A tokio
// mutex is used (not `std::sync::Mutex`) because the guard is held across the
// `.await` points of each test body; an async-aware guard avoids blocking the
// runtime and the `await_holding_lock` lint.
fn env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

struct TestHarness {
    app: Router,
    db: paracord_db::DbPool,
    _test_app: TestApp,
}

impl TestHarness {
    async fn new(run_migrations: bool) -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions {
            run_migrations,
            ..Default::default()
        })
        .await?;
        Ok(Self {
            app: test_app.app.clone(),
            db: test_app.db.clone(),
            _test_app: test_app,
        })
    }

    async fn request(&self, request: Request<Body>) -> anyhow::Result<(StatusCode, Value)> {
        dispatch_json(&self.app, request).await
    }
}

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

fn json_request_with_peer(method: &str, uri: &str, body: Value) -> anyhow::Result<Request<Body>> {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))?;
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 49152))));
    Ok(request)
}

async fn make_admin_token(harness: &TestHarness, prefix: &str) -> anyhow::Result<String> {
    let token = common::create_authenticated_user_token(
        &harness.db,
        &harness._test_app.jwt_secret,
        prefix,
        "Adm1nPassw0rd!",
    )
    .await?;

    let me_request = Request::builder()
        .uri("/api/v1/users/@me")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())?;
    let (status, payload) = harness.request(me_request).await?;
    anyhow::ensure!(status == StatusCode::OK, "failed to fetch @me: {payload}");
    let user_id = payload
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("@me response missing id"))?
        .parse::<i64>()?;
    let user = paracord_db::users::get_user_by_id(&harness.db, user_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("admin user missing"))?;
    paracord_db::users::update_user_flags(
        &harness.db,
        user_id,
        user.flags | paracord_core::USER_FLAG_ADMIN,
    )
    .await?;
    Ok(token)
}

#[tokio::test]
async fn password_reset_completion_updates_password_revokes_sessions_and_consumes_token(
) -> anyhow::Result<()> {
    let harness = TestHarness::new(true).await?;
    let user_id = paracord_util::snowflake::generate(1);
    let email = "reset-flow@example.com";
    let old_password = "OriginalPass123!";
    let new_password = "NewPassword123!";
    let password_hash = paracord_core::auth::hash_password(old_password)?;
    let user = paracord_db::users::create_user(
        &harness.db,
        user_id,
        "resetuser",
        1,
        email,
        &password_hash,
    )
    .await?;

    let old_session_id = "reset-session";
    let old_jti = "reset-jti";
    paracord_db::sessions::create_session(
        &harness.db,
        old_session_id,
        user.id,
        "refresh-token-hash",
        old_jti,
        user.public_key.as_deref(),
        None,
        None,
        None,
        chrono::Utc::now() + chrono::Duration::days(1),
    )
    .await?;
    let old_access_token = paracord_core::auth::create_session_token(
        user.id,
        user.public_key.as_deref(),
        &harness._test_app.jwt_secret,
        3600,
        old_session_id,
        old_jti,
    )?;

    let raw_reset_token = "known-reset-token-for-test";
    paracord_db::password_reset::create_reset_token(
        &harness.db,
        &sha256_hex(raw_reset_token),
        user.id,
        chrono::Utc::now() + chrono::Duration::minutes(10),
    )
    .await?;

    let reset_request = json_request_with_peer(
        "POST",
        "/api/v1/auth/reset-password",
        json!({
            "token": raw_reset_token,
            "new_password": new_password
        }),
    )?;
    let (reset_status, reset_body) = harness.request(reset_request).await?;
    assert_eq!(
        reset_status,
        StatusCode::OK,
        "password reset failed: {reset_body}"
    );

    let reuse_request = json_request_with_peer(
        "POST",
        "/api/v1/auth/reset-password",
        json!({
            "token": raw_reset_token,
            "new_password": "AnotherPass123!"
        }),
    )?;
    let (reuse_status, _) = harness.request(reuse_request).await?;
    assert_eq!(reuse_status, StatusCode::BAD_REQUEST);

    let old_session_request = Request::builder()
        .uri("/api/v1/users/@me")
        .header(header::AUTHORIZATION, format!("Bearer {old_access_token}"))
        .body(Body::empty())?;
    let (old_session_status, _) = harness.request(old_session_request).await?;
    assert_eq!(old_session_status, StatusCode::UNAUTHORIZED);

    let old_login_request = json_request_with_peer(
        "POST",
        "/api/v1/auth/login",
        json!({
            "email": email,
            "password": old_password
        }),
    )?;
    let (old_login_status, _) = harness.request(old_login_request).await?;
    assert_eq!(old_login_status, StatusCode::UNAUTHORIZED);

    let new_login_request = json_request_with_peer(
        "POST",
        "/api/v1/auth/login",
        json!({
            "email": email,
            "password": new_password
        }),
    )?;
    let (new_login_status, new_login_body) = harness.request(new_login_request).await?;
    assert_eq!(
        new_login_status,
        StatusCode::OK,
        "new password login failed: {new_login_body}"
    );
    assert!(
        new_login_body
            .get("token")
            .and_then(|v| v.as_str())
            .is_some(),
        "new password login did not issue an access token: {new_login_body}"
    );

    Ok(())
}

#[tokio::test]
async fn federation_read_rejects_unsigned_requests_without_token() -> anyhow::Result<()> {
    let _guard = env_lock().lock().await;
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
async fn csrf_blocks_cookie_authenticated_mutations_without_matching_header() -> anyhow::Result<()>
{
    let harness = TestHarness::new(true).await?;
    let access_cookie = common::create_authenticated_user_token(
        &harness.db,
        &harness._test_app.jwt_secret,
        "csrfuser",
        "S3cur3P@ssword!",
    )
    .await?;
    let csrf_cookie = "csrf-test-token".to_string();
    let cookie_header = format!("paracord_access={access_cookie}; paracord_csrf={csrf_cookie}");

    let patch_without_csrf = Request::builder()
        .method("PATCH")
        .uri("/api/v1/users/@me")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::COOKIE, &cookie_header)
        .body(Body::from(
            json!({ "display_name": "NoHeader" }).to_string(),
        ))?;
    let (status_without, _) = harness.request(patch_without_csrf).await?;
    assert_eq!(status_without, StatusCode::FORBIDDEN);

    let patch_with_csrf = Request::builder()
        .method("PATCH")
        .uri("/api/v1/users/@me")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::COOKIE, &cookie_header)
        .header("x-paracord-csrf", csrf_cookie)
        .body(Body::from(
            json!({ "display_name": "WithHeader" }).to_string(),
        ))?;
    let (status_with, body_with) = harness.request(patch_with_csrf).await?;
    assert_eq!(status_with, StatusCode::OK, "unexpected body: {body_with}");
    assert_eq!(
        body_with.get("display_name").and_then(|v| v.as_str()),
        Some("WithHeader")
    );

    Ok(())
}

#[tokio::test]
async fn federation_read_accepts_configured_token() -> anyhow::Result<()> {
    let _guard = env_lock().lock().await;
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
    let _guard = env_lock().lock().await;
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
    let _guard = env_lock().lock().await;
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
async fn federation_transport_rejects_unsupported_protocol_version() -> anyhow::Result<()> {
    let _guard = env_lock().lock().await;
    std::env::set_var("PARACORD_FEDERATION_ENABLED", "true");

    let harness = TestHarness::new(true).await?;
    let body = json!({
        "event_id": "$event:remote.example",
        "room_id": "!1:remote.example",
        "event_type": "m.message",
        "sender": "@alice:remote.example",
        "origin_server": "remote.example",
        "origin_ts": chrono::Utc::now().timestamp_millis(),
        "content": { "body": "test" },
        "depth": 1,
        "state_key": Value::Null,
        "signatures": {}
    });
    let request = Request::builder()
        .method("POST")
        .uri("/_paracord/federation/v1/event")
        .header("content-type", "application/json")
        .header("x-paracord-origin", "remote.example")
        .header("x-paracord-key-id", "ed25519:test")
        .header(
            "x-paracord-timestamp",
            chrono::Utc::now().timestamp_millis().to_string(),
        )
        .header("x-paracord-signature", "deadbeef")
        .header("x-paracord-fed-version", "federation-v999")
        .body(Body::from(body.to_string()))?;

    let (status, payload) = harness.request(request).await?;
    assert_eq!(
        status,
        StatusCode::UPGRADE_REQUIRED,
        "expected unsupported version to return 426: {payload}"
    );

    std::env::remove_var("PARACORD_FEDERATION_ENABLED");
    Ok(())
}

#[tokio::test]
async fn discovery_includes_federated_guilds_when_requested() -> anyhow::Result<()> {
    let _guard = env_lock().lock().await;
    std::env::set_var("PARACORD_ALLOW_PRIVATE_FEDERATION_URLS", "true");
    let harness = TestHarness::new(true).await?;

    let remote_app = Router::new().route(
        "/api/v1/discovery/guilds",
        get(|| async move {
            Json(json!({
                "guilds": [{
                    "id": "4444",
                    "name": "Remote Guild",
                    "description": "Federated discovery result",
                    "member_count": 321,
                    "online_count": 12,
                    "tags": ["federated", "games"],
                    "created_at": "2026-03-02T00:00:00Z"
                }],
                "total": 1
            }))
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    tokio::spawn(async move {
        let _ = axum::serve(listener, remote_app.into_make_service()).await;
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let endpoint = format!("http://{}/_paracord/federation/v1", addr);
    paracord_db::federation::upsert_federated_server(
        &harness.db,
        42,
        "remote.example",
        "remote.example",
        &endpoint,
        None,
        None,
        true,
    )
    .await?;
    let trusted = paracord_db::federation::list_trusted_federated_servers(&harness.db).await?;
    assert!(
        trusted
            .iter()
            .any(|peer| peer.server_name == "remote.example"),
        "trusted peer should be persisted for federated discovery"
    );

    let request = Request::builder()
        .method("GET")
        .uri("/api/v1/discovery/guilds?include_federated=true")
        .body(Body::empty())?;
    let (status, payload) = harness.request(request).await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "federated discovery should succeed: {payload}"
    );
    let guilds = payload
        .get("guilds")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow::anyhow!("guilds should be an array"))?;
    assert!(
        guilds.iter().any(|entry| {
            entry.get("federated").and_then(|v| v.as_bool()) == Some(true)
                && entry.get("origin_server").and_then(|v| v.as_str()) == Some("remote.example")
                && entry.get("name").and_then(|v| v.as_str()) == Some("Remote Guild")
        }),
        "expected remote discovery entry in response: {payload}"
    );
    std::env::remove_var("PARACORD_ALLOW_PRIVATE_FEDERATION_URLS");
    Ok(())
}

#[tokio::test]
async fn moderation_list_apply_updates_peer_trust_state() -> anyhow::Result<()> {
    let harness = TestHarness::new(true).await?;
    let admin_token = make_admin_token(&harness, "fedmod").await?;

    let apply_request = Request::builder()
        .method("POST")
        .uri("/_paracord/federation/v1/moderation/apply")
        .header("content-type", "application/json")
        .header(header::AUTHORIZATION, format!("Bearer {admin_token}"))
        .body(Body::from(
            json!({
                "source": "test-list",
                "entries": [
                    { "server_name": "bad.remote", "action": "block", "reason": "malware" },
                    { "server_name": "slow.remote", "action": "quarantine", "quarantine_minutes": 30 }
                ]
            })
            .to_string(),
        ))?;
    let (status, payload) = harness.request(apply_request).await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "moderation apply should succeed: {payload}"
    );
    assert_eq!(payload.get("applied").and_then(|v| v.as_u64()), Some(2));

    let state_request = Request::builder()
        .method("GET")
        .uri("/_paracord/federation/v1/moderation/state")
        .header(header::AUTHORIZATION, format!("Bearer {admin_token}"))
        .body(Body::empty())?;
    let (status, payload) = harness.request(state_request).await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "moderation state should list applied trust entries: {payload}"
    );
    let states = payload
        .get("states")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow::anyhow!("states should be array"))?;
    assert!(
        states.iter().any(|entry| {
            entry.get("server_name").and_then(|v| v.as_str()) == Some("bad.remote")
                && entry.get("mode").and_then(|v| v.as_str()) == Some("block")
        }),
        "expected blocked peer in trust state: {payload}"
    );
    assert!(
        states.iter().any(|entry| {
            entry.get("server_name").and_then(|v| v.as_str()) == Some("slow.remote")
                && entry.get("mode").and_then(|v| v.as_str()) == Some("quarantine")
        }),
        "expected quarantined peer in trust state: {payload}"
    );
    Ok(())
}

#[tokio::test]
async fn moderation_subscription_crud_round_trip() -> anyhow::Result<()> {
    let harness = TestHarness::new(true).await?;
    let admin_token = make_admin_token(&harness, "fedsub").await?;

    let create_request = Request::builder()
        .method("POST")
        .uri("/_paracord/federation/v1/moderation/subscriptions")
        .header("content-type", "application/json")
        .header(header::AUTHORIZATION, format!("Bearer {admin_token}"))
        .body(Body::from(
            json!({
                "source_url": "https://example.com/blocklist.json",
                "source_server": "example.com",
                "enabled": true
            })
            .to_string(),
        ))?;
    let (status, payload) = harness.request(create_request).await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "subscription create should succeed: {payload}"
    );
    let subscription_id = payload
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("create response missing subscription id"))?
        .to_string();

    let list_request = Request::builder()
        .method("GET")
        .uri("/_paracord/federation/v1/moderation/subscriptions")
        .header(header::AUTHORIZATION, format!("Bearer {admin_token}"))
        .body(Body::empty())?;
    let (status, payload) = harness.request(list_request).await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "subscription list should succeed: {payload}"
    );
    let subscriptions = payload
        .get("subscriptions")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow::anyhow!("subscriptions should be array"))?;
    assert!(
        subscriptions.iter().any(|entry| {
            entry.get("id").and_then(|v| v.as_i64()) == subscription_id.parse::<i64>().ok()
                && entry.get("source_url").and_then(|v| v.as_str())
                    == Some("https://example.com/blocklist.json")
        }),
        "expected persisted moderation subscription in list: {payload}"
    );

    let delete_request = Request::builder()
        .method("DELETE")
        .uri(format!(
            "/_paracord/federation/v1/moderation/subscriptions/{}",
            subscription_id
        ))
        .header(header::AUTHORIZATION, format!("Bearer {admin_token}"))
        .body(Body::empty())?;
    let (status, payload) = harness.request(delete_request).await?;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "subscription delete should succeed: {payload}"
    );
    Ok(())
}

#[tokio::test]
async fn federation_ingest_does_not_collide_with_existing_local_ids() -> anyhow::Result<()> {
    let _guard = env_lock().lock().await;
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

/// Register a trusted federated peer plus its signing key, returning the
/// signing key for producing envelope/transport signatures in tests.
async fn register_signed_peer(
    harness: &TestHarness,
    peer_id: i64,
    server_name: &str,
    key_id: &str,
) -> anyhow::Result<ed25519_dalek::SigningKey> {
    let (signing_key, public_key_hex) = paracord_federation::signing::generate_keypair();
    paracord_db::federation::upsert_federated_server(
        &harness.db,
        peer_id,
        server_name,
        server_name,
        &format!("https://{server_name}/_paracord/federation/v1"),
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
                server_name: server_name.to_string(),
                key_id: key_id.to_string(),
                public_key: public_key_hex,
                valid_until: chrono::Utc::now().timestamp_millis() + 600_000,
            },
        )
        .await?;
    Ok(signing_key)
}

/// Build a signed POST /event request for an envelope from `transport_origin`.
fn signed_event_request(
    envelope: &mut paracord_federation::FederationEventEnvelope,
    signing_key: &ed25519_dalek::SigningKey,
    transport_origin: &str,
    key_id: &str,
) -> anyhow::Result<Request<Body>> {
    let payload_sig = paracord_federation::signing::sign(
        signing_key,
        &paracord_federation::canonical_envelope_bytes(envelope),
    );
    envelope.signatures = json!({
        envelope.origin_server.clone(): { key_id: payload_sig },
    });
    let body_bytes = serde_json::to_vec(envelope)?;
    let timestamp_ms = chrono::Utc::now().timestamp_millis();
    let canonical = paracord_federation::transport::canonical_transport_bytes_with_body(
        "POST",
        "/_paracord/federation/v1/event",
        timestamp_ms,
        &body_bytes,
    );
    let transport_sig = paracord_federation::signing::sign(signing_key, &canonical);
    Ok(Request::builder()
        .method("POST")
        .uri("/_paracord/federation/v1/event")
        .header("content-type", "application/json")
        .header("x-paracord-origin", transport_origin)
        .header("x-paracord-key-id", key_id)
        .header("x-paracord-timestamp", timestamp_ms.to_string())
        .header("x-paracord-signature", transport_sig)
        .body(Body::from(body_bytes))?)
}

/// A validly-signed peer must not be able to assert a message authored by an
/// identity that belongs to a different server (sender-vs-origin binding).
#[tokio::test]
async fn federation_message_forged_sender_is_rejected() -> anyhow::Result<()> {
    let _guard = env_lock().lock().await;
    std::env::set_var("PARACORD_FEDERATION_ENABLED", "true");

    let harness = TestHarness::new(true).await?;
    let origin_server = "attacker.example";
    let key_id = "ed25519:test";
    let signing_key = register_signed_peer(&harness, 9401, origin_server, key_id).await?;

    let mut envelope = paracord_federation::FederationEventEnvelope {
        event_id: "$forged:attacker.example".to_string(),
        room_id: "!7010:attacker.example".to_string(),
        event_type: "m.message".to_string(),
        // Sender claims to be a user on a DIFFERENT server than the origin.
        sender: "@victim:trusted.example".to_string(),
        origin_server: origin_server.to_string(),
        origin_ts: chrono::Utc::now().timestamp_millis(),
        content: json!({
            "body": "forged message",
            "msgtype": "m.text",
            "guild_id": "7010",
            "guild_name": "Attacker Guild",
            "channel_id": "7020",
            "channel_name": "general",
            "channel_type": 0,
            "message_id": "93001",
        }),
        depth: chrono::Utc::now().timestamp_millis(),
        state_key: None,
        signatures: json!({}),
    };
    let request = signed_event_request(&mut envelope, &signing_key, origin_server, key_id)?;
    // Transport/signature are valid, so ingestion is accepted at the wire level;
    // the forged sender is dropped during dispatch and never stored.
    let (status, _) = harness.request(request).await?;
    assert_eq!(status, StatusCode::ACCEPTED);

    // No space/channel should have been materialized and no message stored.
    let space_mapping =
        paracord_db::federation::get_space_mapping_by_remote(&harness.db, origin_server, "7010")
            .await?;
    assert!(
        space_mapping.is_none(),
        "forged-sender message must not materialize a space"
    );
    let local_msg = paracord_db::federation::get_local_message_id_by_remote(
        &harness.db,
        origin_server,
        "93001",
    )
    .await?;
    assert!(
        local_msg.is_none(),
        "forged-sender message must not be stored locally"
    );

    std::env::remove_var("PARACORD_FEDERATION_ENABLED");
    Ok(())
}

/// A trusted peer that learns another server's event_id must not be able to
/// edit or delete that message: resolution is scoped to the envelope origin and
/// the editing sender must belong to the origin.
#[tokio::test]
async fn federation_cross_origin_edit_and_delete_are_rejected() -> anyhow::Result<()> {
    let _guard = env_lock().lock().await;
    std::env::set_var("PARACORD_FEDERATION_ENABLED", "true");

    let harness = TestHarness::new(true).await?;
    let victim_server = "victim.example";
    let attacker_server = "attacker.example";
    let key_id = "ed25519:test";
    let victim_key = register_signed_peer(&harness, 9501, victim_server, key_id).await?;
    let attacker_key = register_signed_peer(&harness, 9502, attacker_server, key_id).await?;

    // Victim server sends a legitimate message.
    let victim_event_id = "$victimmsg:victim.example";
    let mut victim_msg = paracord_federation::FederationEventEnvelope {
        event_id: victim_event_id.to_string(),
        room_id: "!8010:victim.example".to_string(),
        event_type: "m.message".to_string(),
        sender: "@alice:victim.example".to_string(),
        origin_server: victim_server.to_string(),
        origin_ts: chrono::Utc::now().timestamp_millis(),
        content: json!({
            "body": "original victim message",
            "msgtype": "m.text",
            "guild_id": "8010",
            "guild_name": "Victim Guild",
            "channel_id": "8020",
            "channel_name": "general",
            "channel_type": 0,
            "message_id": "94001",
        }),
        depth: chrono::Utc::now().timestamp_millis(),
        state_key: None,
        signatures: json!({}),
    };
    let request = signed_event_request(&mut victim_msg, &victim_key, victim_server, key_id)?;
    let (status, _) = harness.request(request).await?;
    assert_eq!(status, StatusCode::ACCEPTED);

    let local_msg_id = paracord_db::federation::get_local_message_id_by_remote(
        &harness.db,
        victim_server,
        "94001",
    )
    .await?
    .expect("victim message should be stored");
    let original = paracord_db::messages::get_message(&harness.db, local_msg_id)
        .await?
        .expect("stored victim message");
    assert_eq!(original.content.as_deref(), Some("original victim message"));

    // Attacker, who learned the victim's event_id, tries to edit it.
    let mut attacker_edit = paracord_federation::FederationEventEnvelope {
        event_id: "$attackeredit:attacker.example".to_string(),
        room_id: "!8010:victim.example".to_string(),
        event_type: "m.message.edit".to_string(),
        sender: "@mallory:attacker.example".to_string(),
        origin_server: attacker_server.to_string(),
        origin_ts: chrono::Utc::now().timestamp_millis(),
        content: json!({
            "body": "TAMPERED by attacker",
            "target_event_id": victim_event_id,
        }),
        depth: chrono::Utc::now().timestamp_millis(),
        state_key: None,
        signatures: json!({}),
    };
    let request = signed_event_request(&mut attacker_edit, &attacker_key, attacker_server, key_id)?;
    let (status, _) = harness.request(request).await?;
    assert_eq!(status, StatusCode::ACCEPTED);

    let after_edit = paracord_db::messages::get_message(&harness.db, local_msg_id)
        .await?
        .expect("victim message still present");
    assert_eq!(
        after_edit.content.as_deref(),
        Some("original victim message"),
        "cross-origin edit must not modify another server's message"
    );

    // Attacker tries to delete the victim's message.
    let mut attacker_delete = paracord_federation::FederationEventEnvelope {
        event_id: "$attackerdelete:attacker.example".to_string(),
        room_id: "!8010:victim.example".to_string(),
        event_type: "m.message.delete".to_string(),
        sender: "@mallory:attacker.example".to_string(),
        origin_server: attacker_server.to_string(),
        origin_ts: chrono::Utc::now().timestamp_millis(),
        content: json!({
            "target_event_id": victim_event_id,
        }),
        depth: chrono::Utc::now().timestamp_millis(),
        state_key: None,
        signatures: json!({}),
    };
    let request =
        signed_event_request(&mut attacker_delete, &attacker_key, attacker_server, key_id)?;
    let (status, _) = harness.request(request).await?;
    assert_eq!(status, StatusCode::ACCEPTED);

    let after_delete = paracord_db::messages::get_message(&harness.db, local_msg_id).await?;
    assert!(
        after_delete.is_some(),
        "cross-origin delete must not remove another server's message"
    );

    std::env::remove_var("PARACORD_FEDERATION_ENABLED");
    Ok(())
}

/// The origin server can legitimately edit its own message (valid-path guard).
#[tokio::test]
async fn federation_same_origin_edit_succeeds() -> anyhow::Result<()> {
    let _guard = env_lock().lock().await;
    std::env::set_var("PARACORD_FEDERATION_ENABLED", "true");

    let harness = TestHarness::new(true).await?;
    let origin_server = "victim.example";
    let key_id = "ed25519:test";
    let signing_key = register_signed_peer(&harness, 9601, origin_server, key_id).await?;

    let event_id = "$origmsg:victim.example";
    let mut msg = paracord_federation::FederationEventEnvelope {
        event_id: event_id.to_string(),
        room_id: "!8110:victim.example".to_string(),
        event_type: "m.message".to_string(),
        sender: "@alice:victim.example".to_string(),
        origin_server: origin_server.to_string(),
        origin_ts: chrono::Utc::now().timestamp_millis(),
        content: json!({
            "body": "original",
            "msgtype": "m.text",
            "guild_id": "8110",
            "guild_name": "Guild",
            "channel_id": "8120",
            "channel_name": "general",
            "channel_type": 0,
            "message_id": "95001",
        }),
        depth: chrono::Utc::now().timestamp_millis(),
        state_key: None,
        signatures: json!({}),
    };
    let request = signed_event_request(&mut msg, &signing_key, origin_server, key_id)?;
    let (status, _) = harness.request(request).await?;
    assert_eq!(status, StatusCode::ACCEPTED);

    let local_msg_id = paracord_db::federation::get_local_message_id_by_remote(
        &harness.db,
        origin_server,
        "95001",
    )
    .await?
    .expect("message stored");

    let mut edit = paracord_federation::FederationEventEnvelope {
        event_id: "$origedit:victim.example".to_string(),
        room_id: "!8110:victim.example".to_string(),
        event_type: "m.message.edit".to_string(),
        sender: "@alice:victim.example".to_string(),
        origin_server: origin_server.to_string(),
        origin_ts: chrono::Utc::now().timestamp_millis(),
        content: json!({
            "body": "edited by origin",
            "target_event_id": event_id,
        }),
        depth: chrono::Utc::now().timestamp_millis(),
        state_key: None,
        signatures: json!({}),
    };
    let request = signed_event_request(&mut edit, &signing_key, origin_server, key_id)?;
    let (status, _) = harness.request(request).await?;
    assert_eq!(status, StatusCode::ACCEPTED);

    let after = paracord_db::messages::get_message(&harness.db, local_msg_id)
        .await?
        .expect("message present");
    assert_eq!(
        after.content.as_deref(),
        Some("edited by origin"),
        "same-origin edit should apply"
    );

    std::env::remove_var("PARACORD_FEDERATION_ENABLED");
    Ok(())
}

/// /events must only serve room history to a peer that participates in the room.
#[tokio::test]
async fn federation_list_events_enforces_room_membership() -> anyhow::Result<()> {
    let _guard = env_lock().lock().await;
    std::env::set_var("PARACORD_FEDERATION_ENABLED", "true");
    std::env::remove_var("PARACORD_FEDERATION_READ_TOKEN");

    let harness = TestHarness::new(true).await?;
    let member_server = "member.example";
    let outsider_server = "outsider.example";
    let key_id = "ed25519:test";
    let member_key = register_signed_peer(&harness, 9701, member_server, key_id).await?;
    let outsider_key = register_signed_peer(&harness, 9702, outsider_server, key_id).await?;

    // A room with a single event and one participating member from member.example.
    let room_id = "!8210:local.example";
    let owner_id = 8290;
    paracord_db::users::create_user(
        &harness.db,
        owner_id,
        "guild_owner",
        1,
        "owner8290@example.com",
        "hash",
    )
    .await?;
    paracord_db::guilds::create_guild(&harness.db, 8210, "Guild", owner_id, None).await?;
    paracord_db::users::create_user(
        &harness.db,
        8299,
        "member_user",
        1,
        "member@example.com",
        "hash",
    )
    .await?;
    paracord_db::federation::upsert_room_membership(
        &harness.db,
        room_id,
        "@bob:member.example",
        8299,
        8210,
    )
    .await?;

    let mut room_event = paracord_federation::FederationEventEnvelope {
        event_id: "$roomevt:member.example".to_string(),
        room_id: room_id.to_string(),
        event_type: "m.message".to_string(),
        sender: "@bob:member.example".to_string(),
        origin_server: member_server.to_string(),
        origin_ts: chrono::Utc::now().timestamp_millis(),
        content: json!({ "body": "room history", "msgtype": "m.text" }),
        depth: 5,
        state_key: None,
        signatures: json!({}),
    };
    // Persist the event directly so /events has something to return.
    let payload_sig = paracord_federation::signing::sign(
        &member_key,
        &paracord_federation::canonical_envelope_bytes(&room_event),
    );
    room_event.signatures = json!({ member_server: { key_id: payload_sig } });
    let service =
        paracord_federation::FederationService::new(paracord_federation::FederationConfig {
            enabled: true,
            server_name: "local.example".to_string(),
            domain: "local.example".to_string(),
            key_id: "ed25519:local".to_string(),
            signing_key: None,
            allow_discovery: false,
        });
    service.persist_event(&harness.db, &room_event).await?;

    let sign_get =
        |origin: &str, key: &ed25519_dalek::SigningKey| -> anyhow::Result<Request<Body>> {
            let path = format!("/_paracord/federation/v1/events?room_id={room_id}");
            let timestamp_ms = chrono::Utc::now().timestamp_millis();
            let canonical = paracord_federation::transport::canonical_transport_bytes_with_body(
                "GET",
                &path,
                timestamp_ms,
                &[],
            );
            let sig = paracord_federation::signing::sign(key, &canonical);
            Ok(Request::builder()
                .method("GET")
                .uri(path)
                .header("x-paracord-origin", origin)
                .header("x-paracord-key-id", key_id)
                .header("x-paracord-timestamp", timestamp_ms.to_string())
                .header("x-paracord-signature", sig)
                .body(Body::empty())?)
        };

    // Outsider (not a member of the room) is denied.
    let (status, _) = harness
        .request(sign_get(outsider_server, &outsider_key)?)
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "non-participant peer must not read room history"
    );

    // Participating member gets the history.
    let (status, body) = harness
        .request(sign_get(member_server, &member_key)?)
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "participating peer should read room history"
    );
    let events = body
        .get("events")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow::anyhow!("events should be array"))?;
    assert!(
        !events.is_empty(),
        "participating peer should receive room events"
    );

    std::env::remove_var("PARACORD_FEDERATION_ENABLED");
    Ok(())
}

#[tokio::test]
async fn federation_room_namespace_mapping_is_used_even_when_sender_differs() -> anyhow::Result<()>
{
    let _guard = env_lock().lock().await;
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
