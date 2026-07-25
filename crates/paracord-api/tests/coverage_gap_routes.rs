mod common;

use anyhow::Context;
use axum::http::{header, HeaderMap, Request};
use axum::{
    body::{to_bytes, Body},
    http::{Method, StatusCode},
    routing::post,
    Json, Router,
};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tower::ServiceExt;

struct TestContext {
    app: axum::Router,
    db: paracord_db::DbPool,
    token: String,
    _test_app: TestApp,
}

impl TestContext {
    async fn new() -> anyhow::Result<Self> {
        Self::new_with_options(TestAppOptions {
            install_http_rate_limiter: true,
            ..Default::default()
        })
        .await
    }

    async fn new_with_options(options: TestAppOptions) -> anyhow::Result<Self> {
        let test_app = build_test_app(options).await?;
        let token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "coverage",
            "CoveragePass123!",
        )
        .await?;

        Ok(Self {
            app: test_app.app.clone(),
            db: test_app.db.clone(),
            token,
            _test_app: test_app,
        })
    }

    async fn request_json(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        self.request_json_with_token(method, path, body, &self.token)
            .await
    }

    async fn request_json_with_token(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        token: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let request = build_json_request(method, path, body, Some(token))?;
        dispatch_json(&self.app, request).await
    }

    async fn request_json_no_auth(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let request = build_json_request(method, path, body, None)?;
        dispatch_json(&self.app, request).await
    }

    async fn request_raw(
        &self,
        method: Method,
        path: &str,
        body: Vec<u8>,
        content_type: Option<&str>,
    ) -> anyhow::Result<(StatusCode, HeaderMap, Vec<u8>)> {
        self.request_raw_with_token(method, path, body, content_type, Some(&self.token))
            .await
    }

    async fn request_raw_with_token(
        &self,
        method: Method,
        path: &str,
        body: Vec<u8>,
        content_type: Option<&str>,
        token: Option<&str>,
    ) -> anyhow::Result<(StatusCode, HeaderMap, Vec<u8>)> {
        let mut builder = Request::builder().method(method).uri(path);
        if let Some(token) = token {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        if let Some(content_type) = content_type {
            builder = builder.header(header::CONTENT_TYPE, content_type);
        }
        let response = self
            .app
            .clone()
            .oneshot(builder.body(Body::from(body))?)
            .await?;
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), usize::MAX).await?.to_vec();
        Ok((status, headers, bytes))
    }
}

async fn promote_default_user_to_admin(ctx: &TestContext) -> anyhow::Result<()> {
    let claims = paracord_core::auth::validate_token(&ctx.token, "integration-test-secret")?;
    paracord_db::users::update_user_flags(&ctx.db, claims.sub, paracord_core::USER_FLAG_ADMIN)
        .await?;
    Ok(())
}

#[tokio::test]
async fn admin_settings_update_returns_full_settings_payload() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    promote_default_user_to_admin(&ctx).await?;

    let expected = json!({
        "server_name": "Updated Test Server",
        "server_description": "Settings response coverage",
        "registration_enabled": "false",
        "max_guilds_per_user": "12",
        "max_members_per_guild": "345",
        "max_guild_storage_quota": "2048",
        "federation_file_cache_enabled": "true",
        "federation_file_cache_max_size": "321",
        "federation_file_cache_ttl_hours": "72"
    });

    let (status, payload) = ctx
        .request_json(
            Method::PATCH,
            "/api/v1/admin/settings",
            Some(expected.clone()),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "settings update failed: {payload}");
    for (key, value) in expected.as_object().expect("expected object") {
        assert_eq!(payload.get(key), Some(value), "missing or mismatched {key}");
    }

    let (status, reloaded) = ctx
        .request_json(Method::GET, "/api/v1/admin/settings", None)
        .await?;
    assert_eq!(status, StatusCode::OK, "settings reload failed: {reloaded}");
    for (key, value) in expected.as_object().expect("expected object") {
        assert_eq!(
            reloaded.get(key),
            Some(value),
            "reloaded setting mismatch for {key}"
        );
    }

    Ok(())
}

async fn create_guild(ctx: &TestContext, name: &str) -> anyhow::Result<String> {
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": name, "icon": Value::Null })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create guild failed: {payload}"
    );
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
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create channel failed: {payload}"
    );
    Ok(payload["id"]
        .as_str()
        .context("channel id should be a string")?
        .to_string())
}

#[tokio::test]
async fn admin_backup_routes_reject_header_unsafe_filenames() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    promote_default_user_to_admin(&ctx).await?;

    let (status, payload) = ctx
        .request_json(Method::GET, "/api/v1/admin/backups/bad%22name.tar.gz", None)
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "unsafe backup download name should be rejected: {payload}"
    );

    let (status, payload) = ctx
        .request_json(
            Method::DELETE,
            "/api/v1/admin/backups/bad%0Aname.tar.gz",
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "unsafe backup delete name should be rejected: {payload}"
    );

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/admin/restore",
            Some(json!({ "name": "bad\"name.tar.gz" })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "unsafe backup restore name should be rejected: {payload}"
    );

    Ok(())
}

#[tokio::test]
async fn upload_policy_uses_active_content_downgraded_type() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Upload Policy").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "uploads").await?;
    let guild_id_num = guild_id.parse::<i64>()?;

    let allowed_types = json!(["image/*"]).to_string();
    paracord_db::guild_storage_policies::upsert_guild_storage_policy(
        &ctx.db,
        guild_id_num,
        None,
        None,
        None,
        Some(&allowed_types),
        None,
    )
    .await?;

    let boundary = "----paracord-active-content-policy-boundary";
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"fake-image.png\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: image/png\r\n\r\n");
    body.extend_from_slice(b"<html><script>alert(1)</script></html>");
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

    let (status, _, response_body) = ctx
        .request_raw(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/attachments"),
            body,
            Some(&format!("multipart/form-data; boundary={boundary}")),
        )
        .await?;

    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "active content must not bypass image-only guild upload policy: {}",
        String::from_utf8_lossy(&response_body)
    );

    Ok(())
}

#[tokio::test]
async fn custom_emoji_images_require_membership_and_support_download_tickets() -> anyhow::Result<()>
{
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Emoji Image Auth").await?;
    let png_bytes: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8,
        0xCF, 0xC0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xDD, 0x8D, 0xB1, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    let boundary = "----paracord-emoji-image-auth-boundary";
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"name\"\r\n\r\n");
    body.extend_from_slice(b"lockdown\r\n");
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"image\"; filename=\"lockdown.png\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: image/png\r\n\r\n");
    body.extend_from_slice(png_bytes);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

    let (status, _, response_body) = ctx
        .request_raw(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/emojis"),
            body,
            Some(&format!("multipart/form-data; boundary={boundary}")),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create emoji failed: {}",
        String::from_utf8_lossy(&response_body)
    );
    let payload: Value =
        serde_json::from_slice(&response_body).context("emoji response should be json")?;
    let emoji_id = payload["id"]
        .as_str()
        .context("emoji id should be a string")?;
    let path = format!("/api/v1/guilds/{guild_id}/emojis/{emoji_id}/image");

    let (status, _, _) = ctx
        .request_raw_with_token(Method::GET, &path, Vec::new(), None, None)
        .await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (ticket_status, ticket_body) = ctx
        .request_json(Method::POST, "/api/v1/download/ticket", None)
        .await?;
    assert_eq!(ticket_status, StatusCode::OK);
    let download_ticket = ticket_body["ticket"]
        .as_str()
        .context("download ticket should be present")?;

    let (status, headers, image_body) = ctx
        .request_raw_with_token(
            Method::GET,
            &format!("{path}?ticket={download_ticket}"),
            Vec::new(),
            None,
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get(header::X_CONTENT_TYPE_OPTIONS)
            .and_then(|v| v.to_str().ok()),
        Some("nosniff")
    );
    assert!(image_body.starts_with(&[0x89, 0x50, 0x4E, 0x47]));

    Ok(())
}

async fn create_message(
    ctx: &TestContext,
    channel_id: &str,
    content: &str,
) -> anyhow::Result<String> {
    create_message_with_token(ctx, &ctx.token, channel_id, content).await
}

async fn create_message_with_token(
    ctx: &TestContext,
    token: &str,
    channel_id: &str,
    content: &str,
) -> anyhow::Result<String> {
    let (status, payload) = ctx
        .request_json_with_token(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({
                "content": content,
            })),
            token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create message failed: {payload}"
    );
    Ok(payload["id"]
        .as_str()
        .context("message id should be a string")?
        .to_string())
}

async fn list_messages(ctx: &TestContext, channel_id: &str) -> anyhow::Result<Vec<Value>> {
    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/messages"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "list channel messages failed: {payload}"
    );
    let array = payload
        .as_array()
        .context("channel messages should be an array")?
        .clone();
    Ok(array)
}

async fn current_user_id(ctx: &TestContext) -> anyhow::Result<String> {
    let (status, payload) = ctx
        .request_json(Method::GET, "/api/v1/users/@me", None)
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "fetch current user failed: {payload}"
    );
    Ok(payload["id"]
        .as_str()
        .context("user id should be string")?
        .to_string())
}

async fn current_user_id_with_token(ctx: &TestContext, token: &str) -> anyhow::Result<String> {
    let (status, payload) = ctx
        .request_json_with_token(Method::GET, "/api/v1/users/@me", None, token)
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "fetch current user with token failed: {payload}"
    );
    Ok(payload["id"]
        .as_str()
        .context("user id should be string")?
        .to_string())
}

/// Render a snowflake as base-36 so a unique suffix costs 12 characters
/// instead of the 18 a decimal snowflake needs.
fn base36(mut value: i64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("base36 digits are ASCII")
}

/// Create a user straight through the database layer, bypassing registration.
///
/// The generated username must still respect the product's 32-character limit.
/// PostgreSQL declares `users.username` as `VARCHAR(32)` and enforces it;
/// SQLite ignores the length entirely. Formatting the full 18-digit decimal
/// snowflake into the name overflowed that budget for any prefix of 14
/// characters or more — passing on SQLite and failing on PostgreSQL with
/// "value too long for type character varying(32)". Base-36 keeps the suffix
/// unique in 12 characters, and the explicit validation below makes a future
/// over-long prefix fail loudly in the fixture instead of as an engine-specific
/// 500.
async fn create_external_user(ctx: &TestContext, prefix: &str) -> anyhow::Result<i64> {
    let user_id = paracord_util::snowflake::generate(1);
    let username = format!("{prefix}_{}", base36(user_id));
    paracord_util::validation::validate_username(&username).map_err(|err| {
        anyhow::anyhow!("test fixture built an invalid username {username:?}: {err}")
    })?;
    let email = format!("{prefix}-{user_id}@example.com");
    let password_hash = paracord_core::auth::hash_password("CoveragePass123!")?;
    let user =
        paracord_db::users::create_user(&ctx.db, user_id, &username, 1, &email, &password_hash)
            .await?;
    Ok(user.id)
}

#[tokio::test]
async fn channel_feature_settings_anonymous_and_thread_slowmode_enforced() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Channel Feature Guild").await?;
    let guild_id_i64 = guild_id.parse::<i64>()?;
    let channel_id = create_text_channel(&ctx, &guild_id, "feature-chat").await?;
    let reader_token = create_authenticated_user_token(
        &ctx.db,
        &ctx._test_app.jwt_secret,
        "anonreader",
        "CoveragePass123!",
    )
    .await?;
    let reader_user_id = current_user_id_with_token(&ctx, &reader_token).await?;
    paracord_db::members::add_member(&ctx.db, reader_user_id.parse::<i64>()?, guild_id_i64).await?;

    let (status, payload) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/channels/{channel_id}/features"),
            Some(json!({
                "anonymous_posting_enabled": true,
                "disappearing_seconds": 3600,
                "thread_rate_limit_per_user": 60,
                "adaptive_slowmode_enabled": true,
                "adaptive_slowmode_window_seconds": 30,
                "adaptive_slowmode_threshold": 1,
                "adaptive_slowmode_step_seconds": 5
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "update features failed: {payload}");
    assert_eq!(payload["anonymous_posting_enabled"], json!(true));
    assert_eq!(payload["thread_rate_limit_per_user"], json!(60));

    let (status, payload) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/channels/{channel_id}"),
            Some(json!({
                "rate_limit_per_user": 30
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "update channel slowmode failed: {payload}"
    );
    assert_eq!(payload["rate_limit_per_user"], json!(30));

    let user_id = current_user_id(&ctx).await?;
    let message_id = create_message(&ctx, &channel_id, "anonymous message").await?;

    let (status, payload) = ctx
        .request_json_with_token(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/messages"),
            None,
            &reader_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "list messages failed: {payload}");
    let messages = payload.as_array().context("messages should be an array")?;
    let created = messages
        .iter()
        .find(|message| message["id"] == json!(message_id))
        .context("created message should exist")?;
    assert_ne!(
        created["author"]["id"],
        json!(user_id),
        "anonymous message should not expose real author id to normal viewer"
    );
    assert_eq!(created["anonymous"]["is_anonymous"], json!(true));
    assert!(created["expires_at"].is_string());

    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/anonymous/deanonymize/{message_id}"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "deanonymize failed: {payload}");
    assert_eq!(payload["user_id"], json!(user_id));

    let (status, first_reader_message) = ctx
        .request_json_with_token(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({
                "content": "first non-owner message",
            })),
            &reader_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "first non-owner message should succeed: {first_reader_message}"
    );

    let (status, second_reader_message) = ctx
        .request_json_with_token(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({
                "content": "second non-owner message",
            })),
            &reader_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::TOO_MANY_REQUESTS,
        "second non-owner message should be slowmode-limited: {second_reader_message}"
    );

    let (status, first_thread) = ctx
        .request_json_with_token(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/threads"),
            Some(json!({ "name": "First Thread" })),
            &reader_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "first thread creation failed: {first_thread}"
    );

    let (status, second_thread) = ctx
        .request_json_with_token(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/threads"),
            Some(json!({ "name": "Second Thread" })),
            &reader_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::TOO_MANY_REQUESTS,
        "second thread should be slowmode-limited: {second_thread}"
    );

    let exempt_role_id = paracord_util::snowflake::generate(1);
    paracord_db::roles::create_role(&ctx.db, exempt_role_id, guild_id_i64, "Slowmode Exempt", 0)
        .await?;
    paracord_db::roles::add_member_role(
        &ctx.db,
        reader_user_id.parse::<i64>()?,
        guild_id_i64,
        exempt_role_id,
    )
    .await?;

    let (status, payload) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/channels/{channel_id}/features"),
            Some(json!({
                "slowmode_exempt_role_ids": [exempt_role_id.to_string()],
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "update exempt roles failed: {payload}"
    );
    assert!(
        payload["slowmode_exempt_role_ids"]
            .as_array()
            .is_some_and(|rows| rows
                .iter()
                .any(|id| id == &json!(exempt_role_id.to_string()))),
        "slowmode_exempt_role_ids should include exempt role: {payload}"
    );

    let (status, exempt_thread) = ctx
        .request_json_with_token(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/threads"),
            Some(json!({ "name": "Third Thread Exempt" })),
            &reader_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "exempt role should bypass thread slowmode: {exempt_thread}"
    );

    let (status, exempt_message) = ctx
        .request_json_with_token(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({
                "content": "third non-owner message with exempt role",
            })),
            &reader_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "exempt role should bypass message slowmode: {exempt_message}"
    );
    Ok(())
}

#[tokio::test]
async fn scheduled_messages_create_list_and_cancel() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Scheduled Message Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "scheduled-chat").await?;
    let send_at = (chrono::Utc::now() + chrono::Duration::seconds(15)).to_rfc3339();

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/scheduled-messages"),
            Some(json!({
                "content": "scheduled hello",
                "send_at": send_at,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create scheduled message failed: {payload}"
    );
    let scheduled_id = payload["id"]
        .as_str()
        .context("scheduled message id should exist")?
        .to_string();

    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/scheduled-messages"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "list scheduled messages failed: {payload}"
    );
    let rows = payload
        .as_array()
        .context("scheduled messages should be an array")?;
    assert!(
        rows.iter().any(|row| row["id"] == json!(scheduled_id)),
        "scheduled message should be listed"
    );

    let (status, payload) = ctx
        .request_json(
            Method::DELETE,
            &format!("/api/v1/channels/{channel_id}/scheduled-messages/{scheduled_id}"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "cancel scheduled message failed: {payload}"
    );
    Ok(())
}

#[tokio::test]
async fn scheduled_messages_edit_and_reschedule() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Scheduled Edit Guild").await?;
    let guild_id_i64 = guild_id.parse::<i64>()?;
    let channel_id = create_text_channel(&ctx, &guild_id, "scheduled-edit").await?;
    let send_at = (chrono::Utc::now() + chrono::Duration::seconds(15)).to_rfc3339();

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/scheduled-messages"),
            Some(json!({
                "content": "original content",
                "send_at": send_at,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create scheduled message failed: {payload}"
    );
    let scheduled_id = payload["id"]
        .as_str()
        .context("scheduled message id should exist")?
        .to_string();

    // Author edits content + reschedules -> 200 reflected.
    let new_send_at = (chrono::Utc::now() + chrono::Duration::seconds(120)).to_rfc3339();
    let (status, payload) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/channels/{channel_id}/scheduled-messages/{scheduled_id}"),
            Some(json!({
                "content": "edited content",
                "send_at": new_send_at,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "edit scheduled message failed: {payload}"
    );
    assert_eq!(payload["content"], json!("edited content"));
    assert_eq!(
        payload["id"],
        json!(scheduled_id),
        "edited scheduled message id should match"
    );

    // Past send_at -> 400.
    let past_send_at = (chrono::Utc::now() - chrono::Duration::seconds(60)).to_rfc3339();
    let (status, _payload) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/channels/{channel_id}/scheduled-messages/{scheduled_id}"),
            Some(json!({
                "content": "too late",
                "send_at": past_send_at,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "past send_at should be 400"
    );

    // Non-author non-manager -> 403.
    let other_token = create_authenticated_user_token(
        &ctx.db,
        &ctx._test_app.jwt_secret,
        "schededitor",
        "CoveragePass123!",
    )
    .await?;
    let other_user_id = current_user_id_with_token(&ctx, &other_token).await?;
    paracord_db::members::add_member(&ctx.db, other_user_id.parse::<i64>()?, guild_id_i64).await?;
    let (status, _payload) = ctx
        .request_json_with_token(
            Method::PATCH,
            &format!("/api/v1/channels/{channel_id}/scheduled-messages/{scheduled_id}"),
            Some(json!({
                "content": "not mine",
                "send_at": new_send_at,
            })),
            &other_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "non-author non-manager should be 403"
    );

    // Cancel then edit -> 409.
    let (status, _payload) = ctx
        .request_json(
            Method::DELETE,
            &format!("/api/v1/channels/{channel_id}/scheduled-messages/{scheduled_id}"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "cancel should succeed");

    let (status, _payload) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/channels/{channel_id}/scheduled-messages/{scheduled_id}"),
            Some(json!({
                "content": "after cancel",
                "send_at": new_send_at,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "editing a cancelled scheduled message should be 409"
    );

    Ok(())
}

#[tokio::test]
async fn data_export_includes_visible_messages_memberships_and_prekeys() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let user_id = current_user_id(&ctx).await?;
    let guild_id = create_guild(&ctx, "Export Guild").await?;
    let guild_id_i64 = guild_id.parse::<i64>()?;
    let channel_id = create_text_channel(&ctx, &guild_id, "export-feed").await?;

    let _ = create_message(&ctx, &channel_id, "my message").await?;

    let peer_token = create_authenticated_user_token(
        &ctx.db,
        &ctx._test_app.jwt_secret,
        "export_peer",
        "CoveragePass123!",
    )
    .await?;
    let peer_user_id = current_user_id_with_token(&ctx, &peer_token).await?;
    paracord_db::members::add_member(&ctx.db, peer_user_id.parse::<i64>()?, guild_id_i64).await?;
    let _ = create_message_with_token(&ctx, &peer_token, &channel_id, "peer message").await?;

    let (status, payload) = ctx
        .request_json(
            Method::PUT,
            "/api/v1/users/@me/keys",
            Some(json!({
                "signed_prekey": {
                    "id": 11001,
                    "public_key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                    "signature": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
                },
                "one_time_prekeys": [
                    { "id": 12001, "public_key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
                    { "id": 12002, "public_key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
                ]
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "uploading prekeys failed: {payload}"
    );

    let (status, payload) = ctx
        .request_json(Method::GET, "/api/v1/users/@me/data-export", None)
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "data export request failed: {payload}"
    );

    let messages = payload["messages"]
        .as_array()
        .context("messages should be an array")?;
    assert!(
        messages
            .iter()
            .any(|msg| msg["author_id"] == json!(user_id)),
        "export should include caller-authored messages: {payload}"
    );
    assert!(
        messages
            .iter()
            .any(|msg| msg["author_id"] == json!(peer_user_id)),
        "export should include visible peer messages from shared channels: {payload}"
    );

    let memberships = payload["guild_memberships"]
        .as_array()
        .context("guild_memberships should be an array")?;
    assert!(
        memberships
            .iter()
            .any(|entry| entry["guild_id"] == json!(guild_id)),
        "expected guild membership export row for the created guild: {payload}"
    );

    assert!(
        payload["encryption_keys"]["signed_prekey"].is_object(),
        "signed prekey should be exported"
    );
    let otks = payload["encryption_keys"]["one_time_prekeys"]
        .as_array()
        .context("one_time_prekeys should be an array")?;
    assert!(
        otks.len() >= 2,
        "expected uploaded one-time prekeys in export"
    );

    Ok(())
}

#[tokio::test]
async fn identity_import_restores_settings_and_prekeys() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;

    std::env::set_var(
        "PARACORD_FEDERATION_SIGNING_KEY_HEX",
        "1111111111111111111111111111111111111111111111111111111111111111",
    );
    std::env::set_var("PARACORD_SERVER_NAME", "localhost");

    let (status, payload) = ctx
        .request_json(
            Method::PATCH,
            "/api/v1/users/@me/settings",
            Some(json!({
                "theme": "light",
                "locale": "en-US",
                "message_display_compact": true,
                "crypto_auth_enabled": true,
                "notifications": { "desktop": true, "messageSound": false },
                "keybinds": { "toggleMute": "Ctrl+Shift+M" }
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "updating settings failed before export/import: {payload}"
    );

    let (status, payload) = ctx
        .request_json(
            Method::PUT,
            "/api/v1/users/@me/keys",
            Some(json!({
                "signed_prekey": {
                    "id": 21001,
                    "public_key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                    "signature": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
                },
                "one_time_prekeys": [
                    { "id": 22001, "public_key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
                    { "id": 22002, "public_key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
                ]
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "upload prekeys failed: {payload}");

    let (status, bundle) = ctx
        .request_json(Method::POST, "/api/v1/users/@me/export", None)
        .await?;
    assert_eq!(status, StatusCode::OK, "identity export failed: {bundle}");
    assert!(
        bundle["settings"].is_object(),
        "export should include settings snapshot"
    );
    assert!(
        bundle["prekeys"]["signed_prekey"].is_object(),
        "export should include signed prekey"
    );

    let (status, payload) = ctx
        .request_json(Method::POST, "/api/v1/users/@me/import", Some(bundle))
        .await?;
    assert_eq!(status, StatusCode::OK, "identity import failed: {payload}");
    assert_eq!(payload["profile_updated"], json!(true));
    assert_eq!(payload["settings_imported"], json!(true));
    assert!(
        payload["prekeys_imported"].as_u64().unwrap_or(0) >= 1,
        "expected imported prekeys count in response: {payload}"
    );

    Ok(())
}

#[tokio::test]
async fn group_sender_keys_post_get_and_ack() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let recipient_token = create_authenticated_user_token(
        &ctx.db,
        &ctx._test_app.jwt_secret,
        "groupkeypeer",
        "CoveragePass123!",
    )
    .await?;
    let recipient_id = current_user_id_with_token(&ctx, &recipient_token).await?;

    // Group DM creation requires a friend or shared-guild relationship with each
    // recipient (block/consent parity with 1:1 DMs) — befriend the recipient.
    let caller_id = current_user_id(&ctx).await?.parse::<i64>()?;
    paracord_db::relationships::create_relationship(
        &ctx.db,
        caller_id,
        recipient_id.parse::<i64>()?,
        1,
    )
    .await?;

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/users/@me/channels",
            Some(json!({
                "recipient_ids": [recipient_id],
                "name": "Sender Key DM",
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create group DM failed: {payload}"
    );
    let channel_id = payload["id"]
        .as_str()
        .context("group dm id should exist")?
        .to_string();

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/e2ee/sender-keys"),
            Some(json!({
                "epoch": 0,
                "envelopes": [
                    {
                        "recipient_id": recipient_id,
                        "ciphertext": "ZmFrZS1jaXBoZXJ0ZXh0",
                        "header": "{\"nonce\":\"ZmFrZS1ub25jZQ==\"}"
                    }
                ]
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "post sender keys failed: {payload}"
    );

    let (status, payload) = ctx
        .request_json_with_token(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/e2ee/sender-keys"),
            None,
            &recipient_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "recipient should fetch pending sender keys: {payload}"
    );
    let sender_keys = payload["sender_keys"]
        .as_array()
        .context("sender_keys should be an array")?;
    assert_eq!(sender_keys.len(), 1);

    let sender_id = sender_keys[0]["sender_id"]
        .as_str()
        .context("sender_id should exist")?;
    let (status, payload) = ctx
        .request_json_with_token(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/e2ee/sender-keys/ack"),
            Some(json!({
                "sender_id": sender_id,
                "up_to_epoch": 0
            })),
            &recipient_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "ack sender keys failed: {payload}");
    assert_eq!(payload["acknowledged"], json!(1));

    let (status, payload) = ctx
        .request_json_with_token(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/e2ee/sender-keys"),
            None,
            &recipient_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "recipient pending sender-key fetch after ack failed: {payload}"
    );
    assert_eq!(
        payload["sender_keys"]
            .as_array()
            .context("sender_keys should be an array after ack")?
            .len(),
        0,
        "default sender-key fetch should only return pending records"
    );

    let (status, payload) = ctx
        .request_json_with_token(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/e2ee/sender-keys?since_epoch=0"),
            None,
            &recipient_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "recipient sender-key recovery fetch after ack failed: {payload}"
    );
    let sender_keys = payload["sender_keys"]
        .as_array()
        .context("recovery sender_keys should be an array")?;
    assert_eq!(
        sender_keys.len(),
        1,
        "since_epoch sender-key fetch should include acknowledged records for cache recovery"
    );
    assert_eq!(sender_keys[0]["epoch"], json!(0));
    Ok(())
}

#[tokio::test]
async fn moderation_templates_apply_timed_mute() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Template Apply Guild").await?;
    let guild_id_i64 = guild_id.parse::<i64>()?;
    let target_user_id = create_external_user(&ctx, "templatemember").await?;
    paracord_db::members::add_member(&ctx.db, target_user_id, guild_id_i64).await?;

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/moderation/templates"),
            Some(json!({
                "name": "5m mute",
                "action_type": 2,
                "duration_minutes": 5,
                "reason_template": "Muted: {reason}",
                "dm_template": "You were muted by {moderator}.",
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create moderation template failed: {payload}"
    );
    let template_id = payload["id"]
        .as_str()
        .context("template id should exist")?
        .to_string();

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/moderation/templates/{template_id}/apply"),
            Some(json!({
                "target_user_id": target_user_id.to_string(),
                "reason": "spam test",
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "apply moderation template failed: {payload}"
    );
    assert_eq!(payload["status"], json!("muted"));
    assert!(payload["until"].is_string());

    let member = paracord_db::members::get_member(&ctx.db, target_user_id, guild_id_i64)
        .await?
        .context("target member should exist")?;
    assert!(
        member.communication_disabled_until.is_some(),
        "member timeout should be set after applying timed mute template"
    );
    Ok(())
}

#[tokio::test]
async fn dm_group_routes_create_and_list_channels() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let recipient_id = create_external_user(&ctx, "dmpeer").await?;
    let caller_id = current_user_id(&ctx).await?.parse::<i64>()?;
    paracord_db::relationships::create_relationship(&ctx.db, caller_id, recipient_id, 1).await?;

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/users/@me/channels",
            Some(json!({
                "recipient_ids": [recipient_id.to_string()],
                "name": "Coverage Group DM",
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create group DM failed: {payload}"
    );
    assert_eq!(payload["channel_type"], json!(3));
    let channel_id = payload["id"]
        .as_str()
        .context("group DM id should be a string")?
        .to_string();

    let (status, payload) = ctx
        .request_json(Method::GET, "/api/v1/users/@me/dms", None)
        .await?;
    assert_eq!(status, StatusCode::OK, "list dms failed: {payload}");
    let channels = payload.as_array().context("DM list should be an array")?;
    assert!(
        channels.iter().any(|entry| entry["id"] == channel_id),
        "expected group DM in list response: {payload}"
    );
    Ok(())
}

#[tokio::test]
async fn group_dm_create_and_add_recipient_enforce_block_and_consent() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let caller_id = current_user_id(&ctx).await?.parse::<i64>()?;

    // A user who has blocked the caller must not be pullable into a group DM.
    let blocker_id = create_external_user(&ctx, "dmblocker").await?;
    paracord_db::relationships::create_relationship(&ctx.db, blocker_id, caller_id, 2).await?;

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/users/@me/channels",
            Some(json!({ "recipient_ids": [blocker_id.to_string()] })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "group DM creation must reject a blocking recipient: {payload}"
    );

    // A stranger (no friendship / shared guild) must also be rejected on create.
    let stranger_id = create_external_user(&ctx, "dmstranger").await?;
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/users/@me/channels",
            Some(json!({ "recipient_ids": [stranger_id.to_string()] })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "group DM creation must reject a non-consenting recipient: {payload}"
    );

    // Create a legitimate group DM with a friend, then try to add the blocker.
    let friend_id = create_external_user(&ctx, "dmfriend").await?;
    paracord_db::relationships::create_relationship(&ctx.db, caller_id, friend_id, 1).await?;
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/users/@me/channels",
            Some(json!({ "recipient_ids": [friend_id.to_string()] })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "group DM setup failed: {payload}"
    );
    let channel_id = payload["id"]
        .as_str()
        .context("group DM id should be a string")?
        .to_string();

    let (status, payload) = ctx
        .request_json(
            Method::PUT,
            &format!("/api/v1/channels/{channel_id}/recipients/{blocker_id}"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "add-recipient must reject pulling in a blocking user: {payload}"
    );

    let (status, payload) = ctx
        .request_json(
            Method::PUT,
            &format!("/api/v1/channels/{channel_id}/recipients/{stranger_id}"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "add-recipient must reject a non-consenting user: {payload}"
    );

    Ok(())
}

#[tokio::test]
async fn invite_create_rejects_out_of_range_limits() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Invite Limit Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "invites").await?;

    for (payload, expected_message) in [
        (
            json!({ "max_uses": -1, "max_age": 3600 }),
            "max_uses must be between 0 and 100",
        ),
        (
            json!({ "max_uses": 101, "max_age": 3600 }),
            "max_uses must be between 0 and 100",
        ),
        (
            json!({ "max_uses": 1, "max_age": -1 }),
            "max_age must be between 0 and 604800 seconds",
        ),
        (
            json!({ "max_uses": 1, "max_age": 604801 }),
            "max_age must be between 0 and 604800 seconds",
        ),
    ] {
        let (status, response) = ctx
            .request_json(
                Method::POST,
                &format!("/api/v1/channels/{channel_id}/invites"),
                Some(payload),
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "expected invalid invite bounds to be rejected: {response}"
        );
        assert!(
            response.to_string().contains(expected_message),
            "expected {expected_message:?} in response: {response}"
        );
    }

    let (status, invite) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/invites"),
            Some(json!({ "max_uses": 0, "max_age": 0 })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "zero invite bounds should mean unlimited/never: {invite}"
    );
    assert_eq!(invite["max_uses"], json!(0));
    assert_eq!(invite["max_age"], json!(0));

    Ok(())
}

#[tokio::test]
async fn public_guild_invites_are_visible_to_discovery_joiners() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Public Discovery Join Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "welcome").await?;
    let outsider_token = create_authenticated_user_token(
        &ctx.db,
        &ctx._test_app.jwt_secret,
        "discoveryjoiner",
        "CoveragePass123!",
    )
    .await?;

    let (status, invite) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/invites"),
            Some(json!({ "max_uses": 0, "max_age": 0 })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "invite create failed: {invite}"
    );
    let invite_code = invite["code"]
        .as_str()
        .context("invite code should be a string")?;

    let (status, private_invites) = ctx
        .request_json_with_token(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/invites"),
            None,
            &outsider_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "private guild invites must remain manager-only: {private_invites}"
    );

    let (status, published) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}"),
            Some(json!({
                "visibility": "public",
                "discovery_tags": ["technology"]
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "publishing guild failed: {published}"
    );

    let (status, public_invites) = ctx
        .request_json_with_token(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/invites"),
            None,
            &outsider_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "public discovery invite lookup failed: {public_invites}"
    );
    let invites = public_invites
        .as_array()
        .context("guild invites response should be an array")?;
    assert!(
        invites.iter().any(|entry| entry["code"] == invite_code),
        "public guild did not expose its usable invite for discovery join: {public_invites}"
    );

    let (status, joined) = ctx
        .request_json_with_token(
            Method::POST,
            &format!("/api/v1/invites/{invite_code}"),
            None,
            &outsider_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "outsider could not join with public discovery invite: {joined}"
    );
    assert_eq!(joined["guild"]["id"], guild_id);

    Ok(())
}

#[tokio::test]
async fn dm_create_route_forbids_unrelated_users() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let recipient_id = create_external_user(&ctx, "dmdenied").await?;

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/users/@me/dms",
            Some(json!({
                "recipient_id": recipient_id.to_string(),
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "expected unrelated DM creation to be forbidden: {payload}"
    );
    Ok(())
}

#[tokio::test]
async fn group_dm_recipients_route_denies_non_member_access() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let recipient_id = create_external_user(&ctx, "dmgrouppeer").await?;
    let caller_id = current_user_id(&ctx).await?.parse::<i64>()?;
    paracord_db::relationships::create_relationship(&ctx.db, caller_id, recipient_id, 1).await?;

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/users/@me/channels",
            Some(json!({
                "recipient_ids": [recipient_id.to_string()],
                "name": "Recipients Visibility Coverage DM",
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "group DM setup failed: {payload}"
    );
    let channel_id = payload["id"]
        .as_str()
        .context("group DM id should be a string")?
        .to_string();

    let outsider_token = create_authenticated_user_token(
        &ctx.db,
        "integration-test-secret",
        "dmoutsider",
        "CoveragePass123!",
    )
    .await?;

    let (status, payload) = ctx
        .request_json_with_token(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/recipients"),
            None,
            &outsider_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "expected non-member to be forbidden from recipient list: {payload}"
    );
    Ok(())
}

#[tokio::test]
async fn webhook_execution_creates_message_via_token_route() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Webhook Coverage Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "webhook-feed").await?;

    let (status, webhook) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/webhooks"),
            Some(json!({
                "name": "Coverage Hook",
                "channel_id": channel_id,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create webhook failed: {webhook}"
    );
    let webhook_id = webhook["id"]
        .as_str()
        .context("webhook id should be a string")?;
    let token = webhook["token"]
        .as_str()
        .context("webhook token should be a string")?;

    let (status, payload) = ctx
        .request_json_no_auth(
            Method::POST,
            &format!("/api/v1/webhooks/{webhook_id}/{token}"),
            Some(json!({
                "content": "coverage webhook payload"
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "execute webhook failed: {payload}"
    );
    assert_eq!(payload["content"], json!("coverage webhook payload"));
    assert_eq!(payload["channel_id"], json!(channel_id));
    Ok(())
}

/// Issue 2 regression: the per-webhook rate-limit budget must only be consumed
/// by token-authenticated requests. The webhook_id is public (part of the
/// delivery URL), so a flood of bogus-token requests must not exhaust the
/// per-webhook window and deny a legitimate delivery. Each test app is stamped
/// with a distinct client IP, so the global per-IP limiter does not interfere.
#[tokio::test]
async fn webhook_rate_budget_only_consumed_after_token_auth() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Webhook RateLimit Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "webhook-rl").await?;

    let (status, webhook) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/webhooks"),
            Some(json!({ "name": "RateLimit Hook", "channel_id": channel_id })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create webhook failed: {webhook}"
    );
    let webhook_id = webhook["id"].as_str().context("webhook id")?.to_string();
    let real_token = webhook["token"]
        .as_str()
        .context("webhook token")?
        .to_string();

    // WEBHOOK_RATE_LIMIT is 30 requests / 60s. Fire that many bogus-token
    // requests against the known webhook_id. Each must be rejected as NotFound
    // (token checked first) and must NOT charge the per-webhook window.
    let bogus_token = "0".repeat(64);
    for _ in 0..30 {
        let (status, _payload) = ctx
            .request_json_no_auth(
                Method::POST,
                &format!("/api/v1/webhooks/{webhook_id}/{bogus_token}"),
                Some(json!({ "content": "should not authenticate" })),
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "bogus-token webhook execution must be rejected as NotFound, not rate-limited",
        );
    }

    // The legitimate delivery must still succeed. Before the fix (rate limit
    // charged before token validation) the bogus flood filled the window and
    // this returned 429 Too Many Requests.
    let (status, payload) = ctx
        .request_json_no_auth(
            Method::POST,
            &format!("/api/v1/webhooks/{webhook_id}/{real_token}"),
            Some(json!({ "content": "legit delivery" })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "legit delivery must not be denied by a bogus-token flood: {payload}",
    );
    Ok(())
}

/// Issue 1 (defense-in-depth) regression: a presented token that equals the
/// SHA-256 hash of the raw token must NOT authenticate. A raw token still
/// authenticates (round-trip preserved); presenting its hash does not, so
/// knowledge of the stored digest can never be replayed as a credential.
#[tokio::test]
async fn webhook_token_digest_is_not_accepted_as_credential() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Webhook Token Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "webhook-token").await?;

    let (status, webhook) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/webhooks"),
            Some(json!({ "name": "Token Hook", "channel_id": channel_id })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create webhook failed: {webhook}"
    );
    let webhook_id = webhook["id"].as_str().context("webhook id")?.to_string();
    let raw_token = webhook["token"]
        .as_str()
        .context("webhook token")?
        .to_string();

    // Legit path: the RAW token returned by create must authenticate.
    let (status, payload) = ctx
        .request_json_no_auth(
            Method::POST,
            &format!("/api/v1/webhooks/{webhook_id}/{raw_token}"),
            Some(json!({ "content": "legit via raw token" })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "legit webhook execution with the raw token must succeed: {payload}",
    );

    // Pass-the-hash: presenting sha256(raw_token) must NOT authenticate.
    let token_digest = paracord_api::secure_tokens::hash_token_sha256_hex(&raw_token);
    let (status, _payload) = ctx
        .request_json_no_auth(
            Method::POST,
            &format!("/api/v1/webhooks/{webhook_id}/{token_digest}"),
            Some(json!({ "content": "attempted pass-the-hash" })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "presenting the sha256 digest of the raw token must not authenticate",
    );

    Ok(())
}

#[tokio::test]
async fn webhook_discord_compat_supports_embeds_edit_and_delete() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Webhook Compat Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "webhook-compat").await?;

    let (status, webhook) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/webhooks"),
            Some(json!({
                "name": "Compat Hook",
                "channel_id": channel_id,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create webhook failed: {webhook}"
    );
    let webhook_id = webhook["id"]
        .as_str()
        .context("webhook id should be a string")?;
    let token = webhook["token"]
        .as_str()
        .context("webhook token should be a string")?;

    let (status, payload) = ctx
        .request_json_no_auth(
            Method::POST,
            &format!("/api/v1/webhooks/{webhook_id}/{token}"),
            Some(json!({
                "content": "Initial Discord-compatible payload",
                "username": "GitHub Actions",
                "avatar_url": "https://cdn.example/avatar.png",
                "embeds": [
                    {
                        "title": "CI",
                        "description": "Build succeeded",
                        "url": "https://ci.example/build/123"
                    }
                ]
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "execute webhook with embeds failed: {payload}"
    );
    let message_id = payload["id"]
        .as_str()
        .context("webhook message id should be returned")?
        .to_string();
    assert_eq!(payload["author"]["username"], json!("GitHub Actions"));
    assert_eq!(
        payload["author"]["avatar_url"],
        json!("https://cdn.example/avatar.png")
    );
    assert!(
        payload["embeds"]
            .as_array()
            .is_some_and(|embeds| !embeds.is_empty()),
        "expected embeds to round-trip on execution: {payload}"
    );

    let (status, payload) = ctx
        .request_json_no_auth(
            Method::PATCH,
            &format!("/api/v1/webhooks/{webhook_id}/{token}/messages/{message_id}"),
            Some(json!({
                "content": "Edited webhook payload",
                "embeds": [
                    {
                        "title": "CI",
                        "description": "Build rerun complete",
                    }
                ]
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "editing webhook message failed: {payload}"
    );
    assert_eq!(payload["content"], json!("Edited webhook payload"));

    let (status, payload) = ctx
        .request_json_no_auth(
            Method::DELETE,
            &format!("/api/v1/webhooks/{webhook_id}/{token}/messages/{message_id}"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "deleting webhook message failed: {payload}"
    );

    let messages = list_messages(&ctx, &channel_id).await?;
    assert!(
        !messages
            .iter()
            .any(|message| message["id"] == json!(message_id)),
        "expected deleted webhook message to be absent from channel messages"
    );
    Ok(())
}

#[tokio::test]
async fn guild_webhooks_route_denies_non_member_access() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Webhook Permission Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "admin-webhooks").await?;

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/webhooks"),
            Some(json!({
                "name": "Permission Hook",
                "channel_id": channel_id,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create webhook failed: {payload}"
    );

    let outsider_token = create_authenticated_user_token(
        &ctx.db,
        "integration-test-secret",
        "outsider",
        "CoveragePass123!",
    )
    .await?;

    let (status, payload) = ctx
        .request_json_with_token(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/webhooks"),
            None,
            &outsider_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "expected non-member webhook list to be forbidden: {payload}"
    );
    Ok(())
}

#[tokio::test]
async fn profile_fields_include_pronouns_and_linked_accounts() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;

    let (status, payload) = ctx
        .request_json(
            Method::PATCH,
            "/api/v1/users/@me",
            Some(json!({ "display_name": "Visible Name" })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "update profile failed: {payload}");
    assert_eq!(payload["display_name"], json!("Visible Name"));

    let (status, payload) = ctx
        .request_json(
            Method::PATCH,
            "/api/v1/users/@me/settings",
            Some(json!({
                "notifications": {
                    "profilePronouns": "they/them",
                    "profileLinkedAccounts": [
                        { "label": "GitHub", "url": "https://github.com/paracord" },
                        { "label": "Website", "url": "https://paracord.chat" },
                        { "label": "Script", "url": "javascript:alert(1)" },
                        { "label": "Userinfo", "url": "https://user:pass@example.com" }
                    ]
                }
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "update settings failed: {payload}");

    let user_id = current_user_id(&ctx).await?;
    let (status, me_payload) = ctx
        .request_json(Method::GET, "/api/v1/users/@me", None)
        .await?;
    assert_eq!(status, StatusCode::OK, "get me failed: {me_payload}");
    assert_eq!(me_payload["display_name"], json!("Visible Name"));
    assert_eq!(me_payload["pronouns"], json!("they/them"));
    let me_accounts = me_payload["linked_accounts"]
        .as_array()
        .context("linked_accounts should be an array on /users/@me")?;
    assert_eq!(me_accounts.len(), 2);
    assert_eq!(me_accounts[0]["label"], json!("GitHub"));
    assert_eq!(me_accounts[0]["url"], json!("https://github.com/paracord"));

    let (status, profile_payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/users/{user_id}/profile"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "get profile failed: {profile_payload}"
    );
    assert_eq!(profile_payload["user"]["pronouns"], json!("they/them"));
    let profile_accounts = profile_payload["user"]["linked_accounts"]
        .as_array()
        .context("linked_accounts should be an array on profile")?;
    assert_eq!(profile_accounts.len(), 2);
    assert_eq!(profile_accounts[1]["label"], json!("Website"));
    assert_eq!(profile_accounts[1]["url"], json!("https://paracord.chat/"));
    Ok(())
}

#[tokio::test]
async fn automod_quarantine_report_approve_reposts_original_content() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let user_id = current_user_id(&ctx).await?;
    let guild_id = create_guild(&ctx, "Report Approve Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "general").await?;

    let reported_message_id = create_message(&ctx, &channel_id, "hello from original").await?;

    let report_id = paracord_util::snowflake::generate(1);
    let changes = json!({
        "target_type": "message",
        "target_id": reported_message_id,
        "message_id": reported_message_id,
        "channel_id": channel_id,
        "reported_user_id": user_id,
        "report_kind": "automod_quarantine",
        "auto_generated": true,
        "rule_name": "Keyword Block",
        "original_content": "restored quarantined content",
        "original_channel_id": channel_id,
        "status": "open"
    });
    paracord_db::audit_log::create_entry(
        &ctx.db,
        report_id,
        guild_id.parse::<i64>()?,
        user_id.parse::<i64>()?,
        90,
        Some(reported_message_id.parse::<i64>()?),
        Some("automod quarantine"),
        Some(&changes),
    )
    .await?;

    let before_messages = list_messages(&ctx, &channel_id).await?;

    let (status, payload) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/reports/{report_id}"),
            Some(json!({ "action": "approve" })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "approve report failed: {payload}");
    assert_eq!(payload["status"], json!("approved"));
    assert_eq!(
        payload["changes"]["approved_by_automod_review"],
        json!(true)
    );
    let approved_message_id = payload["changes"]["approved_message_id"]
        .as_str()
        .context("approved_message_id should be set")?;
    assert!(!approved_message_id.is_empty());

    let after_messages = list_messages(&ctx, &channel_id).await?;
    assert!(
        after_messages.len() > before_messages.len(),
        "expected approved message to be posted"
    );
    assert!(
        after_messages.iter().any(|message| {
            message["id"] == approved_message_id
                && message["content"] == json!("restored quarantined content")
                && message["author"]["id"] == json!(user_id)
        }),
        "approved message should exist with original content and author: {after_messages:?}"
    );
    Ok(())
}

#[tokio::test]
async fn economy_progression_awards_xp_and_assigns_level_roles() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let user_id_str = current_user_id(&ctx).await?;
    let user_id = user_id_str.parse::<i64>()?;
    let guild_id = create_guild(&ctx, "Economy Progression Guild").await?;
    let guild_id_i64 = guild_id.parse::<i64>()?;
    let channel_id = create_text_channel(&ctx, &guild_id, "economy-feed").await?;

    let role_id = paracord_util::snowflake::generate(1);
    let role =
        paracord_db::roles::create_role(&ctx.db, role_id, guild_id_i64, "Level Starter", 0).await?;
    assert_eq!(role.id, role_id, "expected custom role to be created");

    let (status, payload) = ctx
        .request_json(
            Method::PUT,
            &format!("/api/v1/guilds/{guild_id}/economy/level-roles"),
            Some(json!({
                "mappings": [
                    {
                        "level": 0,
                        "role_id": role_id.to_string(),
                    }
                ]
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "updating level role mappings failed: {payload}"
    );
    let mappings = payload["mappings"]
        .as_array()
        .context("level-role mappings should be an array")?;
    assert!(
        mappings
            .iter()
            .any(|entry| entry["role_id"] == json!(role_id.to_string())
                && entry["level"] == json!(0)),
        "expected level-role mapping to include the new role: {payload}"
    );

    let _ = create_message(&ctx, &channel_id, "This message should award XP.").await?;

    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/economy/me"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "fetching my economy progress failed: {payload}"
    );
    let xp = payload["xp"]
        .as_i64()
        .context("xp should be present in economy/me response")?;
    assert!(
        xp >= 15,
        "expected XP to be awarded after sending a message"
    );
    assert_eq!(
        payload["streak"]["days"],
        json!(1),
        "expected streak to start at 1 day after first message"
    );
    let achievements = payload["achievements"]
        .as_array()
        .context("achievements should be an array")?;
    assert!(
        achievements
            .iter()
            .any(|entry| entry["key"] == json!("first-message")),
        "expected first-message achievement to be awarded: {payload}"
    );

    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/economy/leaderboard?limit=10"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "fetching leaderboard failed: {payload}"
    );
    let entries = payload["entries"]
        .as_array()
        .context("leaderboard entries should be an array")?;
    assert!(
        entries
            .iter()
            .any(|entry| entry["user"]["id"] == json!(user_id_str)
                && entry["xp"].as_i64().unwrap_or(0) >= 15),
        "expected sender to appear in leaderboard with awarded XP: {payload}"
    );

    let member_roles = paracord_db::roles::get_member_roles(&ctx.db, user_id, guild_id_i64).await?;
    assert!(
        member_roles.iter().any(|row| row.id == role_id),
        "expected configured level role to be auto-assigned after XP award"
    );

    Ok(())
}

#[tokio::test]
async fn guild_template_apply_rejects_malicious_stored_data_without_partial_guild(
) -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let user_id = current_user_id(&ctx).await?.parse::<i64>()?;

    let (status, before_guilds) = ctx
        .request_json(Method::GET, "/api/v1/users/@me/guilds", None)
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "list guilds before template apply failed: {before_guilds}"
    );
    let before_count = before_guilds
        .as_array()
        .context("guild list should be an array")?
        .len();

    let safe_template_data = json!({
        "roles": [{ "name": "Safe Role", "permissions": "0" }],
        "channels": [
            { "name": "Safe Category", "type": 4, "position": 2 },
            { "name": "safe-channel", "type": 0, "position": 3, "parent_name": "Safe Category" },
            { "name": "safe-forum", "type": 7, "position": 4, "parent_name": "Safe Category" }
        ]
    });
    let malicious_templates = [
        (
            910_000_000_001_i64,
            "Bad JSON",
            "{not valid json".to_string(),
        ),
        (
            910_000_000_002_i64,
            "Bad Role Name",
            json!({
                "roles": [{ "name": "<script>alert(1)</script>", "permissions": "0" }],
                "channels": []
            })
            .to_string(),
        ),
        (
            910_000_000_003_i64,
            "Bad Role Permissions",
            json!({
                "roles": [{ "name": "Bad Perms", "permissions": "-1" }],
                "channels": []
            })
            .to_string(),
        ),
        (
            910_000_000_004_i64,
            "Bad Channel Name",
            json!({
                "roles": [],
                "channels": [{ "name": "javascript:alert(1)", "type": 0, "position": 0 }]
            })
            .to_string(),
        ),
        (
            910_000_000_005_i64,
            "Bad Channel Type",
            json!({
                "roles": [],
                "channels": [{ "name": "weird-channel", "type": 999, "position": 0 }]
            })
            .to_string(),
        ),
    ];

    for (template_id, name, template_data) in malicious_templates {
        paracord_db::guild_templates::create_template(
            &ctx.db,
            template_id,
            name,
            "",
            user_id,
            None,
            &template_data,
        )
        .await?;

        let (status, payload) = ctx
            .request_json(
                Method::POST,
                &format!("/api/v1/templates/{template_id}/apply"),
                Some(json!({ "name": format!("Rejected {template_id}") })),
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "malicious template should be rejected: {payload}"
        );

        let (status, after_guilds) = ctx
            .request_json(Method::GET, "/api/v1/users/@me/guilds", None)
            .await?;
        assert_eq!(
            status,
            StatusCode::OK,
            "list guilds after rejected template failed: {after_guilds}"
        );
        assert_eq!(
            after_guilds
                .as_array()
                .context("guild list should be an array")?
                .len(),
            before_count,
            "rejected template must not create a partial guild"
        );
    }

    let safe_template_id = 910_000_000_100_i64;
    paracord_db::guild_templates::create_template(
        &ctx.db,
        safe_template_id,
        "Safe Template",
        "",
        user_id,
        None,
        &safe_template_data.to_string(),
    )
    .await?;

    let (status, created) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/templates/{safe_template_id}/apply"),
            Some(json!({ "name": "Applied Safe Template" })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "safe template should apply: {created}"
    );
    let created_guild_id = created["id"]
        .as_str()
        .context("created guild id should be a string")?;

    let (status, channels) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/guilds/{created_guild_id}/channels"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "list channels failed: {channels}");
    let channel_names = channels
        .as_array()
        .context("channels should be an array")?
        .iter()
        .filter_map(|channel| channel["name"].as_str())
        .collect::<std::collections::HashSet<_>>();
    assert!(channel_names.contains("Safe Category"));
    assert!(channel_names.contains("safe-channel"));
    assert!(channel_names.contains("safe-forum"));
    let safe_forum = channels
        .as_array()
        .context("channels should be an array")?
        .iter()
        .find(|channel| channel["name"] == json!("safe-forum"))
        .context("safe template forum should be created")?;
    assert_eq!(safe_forum["type"], json!(7));

    let (status, roles) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/guilds/{created_guild_id}/roles"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "list roles failed: {roles}");
    assert!(
        roles
            .as_array()
            .context("roles should be an array")?
            .iter()
            .any(|role| role["name"] == json!("Safe Role")),
        "safe template role should be created: {roles}"
    );

    let template = paracord_db::guild_templates::get_by_id(&ctx.db, safe_template_id)
        .await?
        .context("safe template should still exist")?;
    assert_eq!(template.usage_count, 1);

    Ok(())
}

#[tokio::test]
async fn moderation_templates_can_be_created_applied_and_deleted() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Moderation Template Guild").await?;
    let target_user_id = create_external_user(&ctx, "template_target").await?;

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/moderation/templates"),
            Some(json!({
                "name": "Warn User",
                "action_type": 1,
                "reason_template": "Warning issued to {target} by {moderator}: {reason}",
                "dm_template": "You received a warning: {reason}"
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create moderation template failed: {payload}"
    );
    let template_id = payload["id"]
        .as_str()
        .context("template id should be present")?
        .to_string();

    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/moderation/templates"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "list templates failed: {payload}");
    let templates = payload
        .as_array()
        .context("templates response should be an array")?;
    assert!(
        templates
            .iter()
            .any(|template| template["id"] == json!(template_id)),
        "created template should be listed: {payload}"
    );

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/moderation/templates/{template_id}/apply"),
            Some(json!({
                "target_user_id": target_user_id.to_string(),
                "reason": "Please follow the rules"
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "apply template failed: {payload}");
    assert_eq!(payload["status"], json!("warned"));
    let reason = payload["reason"]
        .as_str()
        .context("reason should be rendered in apply response")?;
    assert!(
        reason.contains("Please follow the rules"),
        "expected rendered reason to include supplied reason: {payload}"
    );

    let (status, payload) = ctx
        .request_json(
            Method::DELETE,
            &format!("/api/v1/guilds/{guild_id}/moderation/templates/{template_id}"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "delete template failed: {payload}"
    );

    Ok(())
}

#[tokio::test]
async fn channel_summary_uses_configured_ai_provider() -> anyhow::Result<()> {
    let ai_app = Router::new().route(
        "/v1/chat/completions",
        post(|| async move {
            Json(json!({
                "id": "cmpl-test",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "Summary: team agreed to ship on Friday and investigate retry errors."
                    }
                }]
            }))
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    tokio::spawn(async move {
        let _ = axum::serve(listener, ai_app.into_make_service()).await;
    });

    let ctx = TestContext::new_with_options(TestAppOptions {
        install_http_rate_limiter: true,
        ai_provider: Some("openai_compatible".to_string()),
        ai_base_url: Some(format!("http://{}", addr)),
        ai_api_key: None,
        ai_model: Some("mock-model".to_string()),
        ai_timeout_seconds: 20,
        ..Default::default()
    })
    .await?;

    let guild_id = create_guild(&ctx, "Summary Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "standup").await?;
    let _ = create_message(&ctx, &channel_id, "We should ship by Friday.").await?;
    let _ = create_message(&ctx, &channel_id, "Retry errors still need investigation.").await?;

    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/summary?limit=100"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "channel summary request should succeed: {payload}"
    );
    assert_eq!(
        payload.get("provider").and_then(|v| v.as_str()),
        Some("openai_compatible")
    );
    assert_eq!(
        payload.get("model").and_then(|v| v.as_str()),
        Some("mock-model")
    );
    let summary = payload
        .get("summary")
        .and_then(|v| v.as_str())
        .context("summary text should be returned")?;
    assert!(
        summary.contains("ship on Friday"),
        "expected AI summary content in response: {payload}"
    );
    Ok(())
}

#[tokio::test]
async fn tenor_search_and_trending_require_auth() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;

    // Tenor proxy routes take AuthUser — unauthenticated callers must get 401
    // even when a Tenor API key is not configured (auth runs before the key check).
    let (search_status, _) = ctx
        .request_json_no_auth(Method::GET, "/api/v1/tenor/search?q=cats&limit=5", None)
        .await?;
    assert_eq!(
        search_status,
        StatusCode::UNAUTHORIZED,
        "tenor search must require authentication"
    );

    let (trending_status, _) = ctx
        .request_json_no_auth(Method::GET, "/api/v1/tenor/trending?limit=5", None)
        .await?;
    assert_eq!(
        trending_status,
        StatusCode::UNAUTHORIZED,
        "tenor trending must require authentication"
    );

    Ok(())
}

#[tokio::test]
async fn instance_info_exposes_upload_limit_and_requires_auth() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;

    // Unauthenticated callers must not be able to read instance limits.
    let (status, _) = ctx
        .request_json_no_auth(Method::GET, "/api/v1/instance", None)
        .await?;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "instance info must require authentication"
    );

    // Authenticated callers get the configured, non-sensitive limits. The test
    // harness configures max_upload_size = 10 MB (see tests/common/mod.rs).
    let (status, body) = ctx
        .request_json(Method::GET, "/api/v1/instance", None)
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body.get("max_upload_size").and_then(Value::as_u64),
        Some(10 * 1024 * 1024),
        "instance info should report the configured upload limit: {body}"
    );
    assert!(
        body.get("p2p_threshold").and_then(Value::as_u64).is_some(),
        "instance info should report the p2p threshold: {body}"
    );

    // Must not leak secrets or internal configuration.
    let raw = body.to_string().to_lowercase();
    for forbidden in ["jwt", "secret", "path", "database", "cryptor", "token"] {
        assert!(
            !raw.contains(forbidden),
            "instance info leaked sensitive field '{forbidden}': {body}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn oversized_upload_reports_the_limit_in_the_error() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Size Limit").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "uploads").await?;
    let guild_id_num = guild_id.parse::<i64>()?;

    // Admin configures a tiny per-guild maximum file size (1 KB).
    paracord_db::guild_storage_policies::upsert_guild_storage_policy(
        &ctx.db,
        guild_id_num,
        Some(1024),
        None,
        None,
        None,
        None,
    )
    .await?;

    let boundary = "----paracord-size-limit-boundary";
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"big.bin\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(&vec![0u8; 4096]); // 4 KB, over the 1 KB policy
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

    let (status, _, response_body) = ctx
        .request_raw(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/attachments"),
            body,
            Some(&format!("multipart/form-data; boundary={boundary}")),
        )
        .await?;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    let text = String::from_utf8_lossy(&response_body);
    assert!(
        text.contains("maximum") && text.contains("KB"),
        "oversize rejection should state the configured limit: {text}"
    );
    Ok(())
}
