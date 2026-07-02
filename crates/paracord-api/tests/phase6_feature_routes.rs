mod common;

use anyhow::Context;
use axum::{
    body::{to_bytes, Body},
    http::{header, Method, Request, StatusCode},
    Router,
};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use serde_json::{json, Value};
use tower::ServiceExt;

struct TestContext {
    app: Router,
    db: paracord_db::DbPool,
    token: String,
    _test_app: TestApp,
}

impl TestContext {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions {
            install_http_rate_limiter: true,
            ..Default::default()
        })
        .await?;
        let token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "phase6",
            "Phase6Pass123!",
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

    async fn request_raw_with_token(
        &self,
        method: Method,
        path: &str,
        body: Vec<u8>,
        content_type: Option<&str>,
        token: Option<&str>,
    ) -> anyhow::Result<(StatusCode, String, Vec<u8>)> {
        let mut builder = Request::builder().method(method).uri(path);
        if let Some(value) = content_type {
            builder = builder.header(header::CONTENT_TYPE, value);
        }
        if let Some(value) = token {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {value}"));
        }
        let request = builder.body(Body::from(body))?;
        let response = self.app.clone().oneshot(request).await?;
        let status = response.status();
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let bytes = to_bytes(response.into_body(), usize::MAX).await?.to_vec();
        Ok((status, content_type, bytes))
    }
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
        .context("guild id should be string")?
        .to_string())
}

async fn create_channel(ctx: &TestContext, guild_id: &str, name: &str) -> anyhow::Result<String> {
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
        .context("channel id should be string")?
        .to_string())
}

async fn current_user_id(ctx: &TestContext, token: &str) -> anyhow::Result<String> {
    let (status, payload) = ctx
        .request_json_with_token(Method::GET, "/api/v1/users/@me", None, token)
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

#[tokio::test]
async fn scheduled_events_support_recurrence_reminders_and_ical() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Events Feature Guild").await?;
    let channel_id = create_channel(&ctx, &guild_id, "events").await?;
    let start_at = (chrono::Utc::now() + chrono::Duration::minutes(15)).to_rfc3339();
    let end_at = (chrono::Utc::now() + chrono::Duration::minutes(60)).to_rfc3339();

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/events"),
            Some(json!({
                "name": "Weekly Sync",
                "description": "Team standup",
                "scheduled_start": start_at,
                "scheduled_end": end_at,
                "entity_type": 2,
                "channel_id": channel_id,
                "location": "Voice Room",
                "recurrence_rule": "weekly",
                "reminder_minutes": 20,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create event failed: {payload}"
    );
    let event_id = payload["id"]
        .as_str()
        .context("event id should be returned")?
        .to_string();
    assert_eq!(payload["recurrence_rule"], json!("weekly"));
    assert_eq!(payload["reminder_minutes"], json!(20));

    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/events/{event_id}"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "get event failed: {payload}");
    assert_eq!(payload["recurrence_rule"], json!("weekly"));

    let (status, content_type, bytes) = ctx
        .request_raw_with_token(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/events/{event_id}/ical"),
            Vec::new(),
            None,
            Some(&ctx.token),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "event iCal export failed with content-type {content_type}"
    );
    assert!(
        content_type.starts_with("text/calendar"),
        "unexpected content type: {content_type}"
    );
    let text = String::from_utf8(bytes).context("ical payload should be utf8")?;
    assert!(text.contains("BEGIN:VCALENDAR"));
    assert!(text.contains("RRULE:FREQ=WEEKLY"));
    assert!(text.contains("BEGIN:VALARM"));
    assert!(text.contains("TRIGGER:-PT20M"));

    let (status, _, bytes) = ctx
        .request_raw_with_token(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/events.ics"),
            Vec::new(),
            None,
            Some(&ctx.token),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "guild iCal export failed");
    let text = String::from_utf8(bytes).context("guild ical should be utf8")?;
    assert!(text.contains("Weekly Sync"));
    assert!(text.contains("BEGIN:VEVENT"));

    let (status, payload) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/events/{event_id}"),
            Some(json!({
                "description": null,
                "scheduled_end": null,
                "entity_type": 1,
                "channel_id": null,
                "location": null,
                "recurrence_rule": null,
                "reminder_minutes": null
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "clear event fields failed: {payload}"
    );
    assert_eq!(payload["description"], json!(null));
    assert_eq!(payload["scheduled_end"], json!(null));
    assert_eq!(payload["entity_type"], json!(1));
    assert_eq!(payload["channel_id"], json!(null));
    assert_eq!(payload["location"], json!(null));
    assert_eq!(payload["recurrence_rule"], json!(null));
    assert_eq!(payload["reminder_minutes"], json!(null));

    Ok(())
}

#[tokio::test]
async fn onboarding_flow_enforces_rules_and_assigns_selected_roles() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Onboarding Feature Guild").await?;
    let guild_id_i64 = guild_id.parse::<i64>()?;

    let role_id = paracord_util::snowflake::generate(1);
    paracord_db::roles::create_role(&ctx.db, role_id, guild_id_i64, "Reader", 0).await?;

    let (status, payload) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/onboarding"),
            Some(json!({
                "welcome_title": "Welcome to the guild",
                "rules_text": "Be respectful.",
                "role_prompt": "Pick your role",
                "progressive_channel_min_messages": 2,
                "role_options": [
                    {
                        "role_id": role_id.to_string(),
                        "label": "Reader",
                        "position": 0
                    }
                ]
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "update onboarding settings failed: {payload}"
    );
    assert_eq!(
        payload["role_options"][0]["role_id"],
        json!(role_id.to_string())
    );

    let member_token = create_authenticated_user_token(
        &ctx.db,
        &ctx._test_app.jwt_secret,
        "onboarding_member",
        "Phase6Pass123!",
    )
    .await?;
    let member_id = current_user_id(&ctx, &member_token).await?;
    paracord_db::members::add_member(&ctx.db, member_id.parse::<i64>()?, guild_id_i64).await?;

    let (status, payload) = ctx
        .request_json_with_token(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/onboarding/me"),
            None,
            &member_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "get my onboarding state failed: {payload}"
    );
    assert_eq!(
        payload["settings"]["role_options"][0]["role_id"],
        json!(role_id.to_string())
    );

    let (status, payload) = ctx
        .request_json_with_token(
            Method::PUT,
            &format!("/api/v1/guilds/{guild_id}/onboarding/me"),
            Some(json!({
                "accepted_rules": false,
                "selected_role_ids": [role_id.to_string()],
                "completed": true
            })),
            &member_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "rules gate should reject completion without acceptance: {payload}"
    );

    let (status, payload) = ctx
        .request_json_with_token(
            Method::PUT,
            &format!("/api/v1/guilds/{guild_id}/onboarding/me"),
            Some(json!({
                "accepted_rules": true,
                "selected_role_ids": [role_id.to_string()],
                "completed": true
            })),
            &member_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "complete onboarding failed: {payload}"
    );
    assert!(payload["completed_at"].is_string());

    let member_roles =
        paracord_db::roles::get_member_roles(&ctx.db, member_id.parse::<i64>()?, guild_id_i64)
            .await?;
    assert!(
        member_roles.iter().any(|role| role.id == role_id),
        "selected onboarding role should be assigned"
    );

    Ok(())
}

#[tokio::test]
async fn sticker_upload_list_image_and_delete_flow() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Sticker Feature Guild").await?;

    // 1x1 PNG
    let png_bytes: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8,
        0xCF, 0xC0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xDD, 0x8D, 0xB1, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    let boundary = "----paracord-test-boundary";
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"name\"\r\n\r\n");
    body.extend_from_slice(b"wave\r\n");
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"image\"; filename=\"wave.png\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: image/png\r\n\r\n");
    body.extend_from_slice(png_bytes);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

    let (status, _, bytes) = ctx
        .request_raw_with_token(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/stickers"),
            body,
            Some(&format!("multipart/form-data; boundary={boundary}")),
            Some(&ctx.token),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "create sticker failed");
    let payload: Value =
        serde_json::from_slice(&bytes).context("sticker response should be json")?;
    let sticker_id = payload["id"]
        .as_str()
        .context("sticker id should exist")?
        .to_string();
    assert!(payload["image_url"].is_string());

    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/stickers"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "list stickers failed: {payload}");
    let stickers = payload.as_array().context("stickers should be an array")?;
    assert!(
        stickers.iter().any(|row| row["id"] == json!(sticker_id)),
        "created sticker should be listed"
    );

    let (status, content_type, bytes) = ctx
        .request_raw_with_token(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/stickers/{sticker_id}/image"),
            Vec::new(),
            None,
            Some(&ctx.token),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "fetch sticker image failed");
    assert!(content_type.starts_with("image/png"));
    assert!(bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]));

    let (status, payload) = ctx
        .request_json(
            Method::DELETE,
            &format!("/api/v1/guilds/{guild_id}/stickers/{sticker_id}"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "delete sticker failed: {payload}"
    );

    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/stickers"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "list stickers failed: {payload}");
    let stickers = payload.as_array().context("stickers should be an array")?;
    assert!(
        stickers.iter().all(|row| row["id"] != json!(sticker_id)),
        "deleted sticker should not appear in list"
    );

    Ok(())
}

#[tokio::test]
async fn bot_store_reviews_and_metrics_track_installs() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/bots/applications",
            Some(json!({
                "name": "ReviewBot",
                "description": "Review metrics bot",
                "permissions": "3072",
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create bot app failed: {payload}"
    );
    let app_id = payload["id"]
        .as_str()
        .context("bot app id should exist")?
        .to_string();
    let app_id_i64 = app_id.parse::<i64>()?;
    sqlx::query(
        "UPDATE bot_applications SET public_listed = TRUE, category = 'utility' WHERE id = $1",
    )
    .bind(app_id_i64)
    .execute(&ctx.db)
    .await?;

    let guild_id = create_guild(&ctx, "Bot Metrics Guild").await?;
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/oauth2/authorize",
            Some(json!({
                "application_id": app_id,
                "guild_id": guild_id,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "authorize/install bot failed: {payload}"
    );

    let (status, payload) = ctx
        .request_json(
            Method::PUT,
            &format!("/api/v1/bots/store/{app_id}/reviews/@me"),
            Some(json!({
                "rating": 5,
                "title": "Great bot",
                "body": "Very useful",
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "submit review failed: {payload}");
    assert_eq!(payload["summary"]["review_count"], json!(1));
    assert_eq!(payload["summary"]["average_rating"], json!(5.0));

    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/bots/store/{app_id}/reviews?limit=10"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "list reviews failed: {payload}");
    assert_eq!(payload["summary"]["review_count"], json!(1));
    let reviews = payload["reviews"]
        .as_array()
        .context("reviews should be an array")?;
    assert_eq!(reviews.len(), 1);
    assert_eq!(reviews[0]["rating"], json!(5));

    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/bots/applications/{app_id}/metrics"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "fetch bot metrics failed: {payload}"
    );
    assert!(
        payload["install_count"].as_i64().unwrap_or(0) >= 1,
        "expected install_count >= 1 after oauth install"
    );
    assert_eq!(payload["review_count"], json!(1));

    Ok(())
}
