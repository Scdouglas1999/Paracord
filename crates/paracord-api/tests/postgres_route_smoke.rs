mod common;

use anyhow::Context;
use axum::{
    body::{to_bytes, Body},
    http::{header, Method, Request, StatusCode},
};
use chrono::{Duration, Utc};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json,
    TestAppOptions,
};
use serde_json::{json, Value};
use tower::ServiceExt;

async fn request_json(
    app: &axum::Router,
    token: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> anyhow::Result<(StatusCode, Value)> {
    let request = build_json_request(method, path, body, Some(token))?;
    dispatch_json(app, request).await
}

async fn request_json_with_token(
    app: &axum::Router,
    token: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> anyhow::Result<(StatusCode, Value)> {
    let request = build_json_request(method, path, body, Some(token))?;
    dispatch_json(app, request).await
}

async fn request_json_no_auth(
    app: &axum::Router,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> anyhow::Result<(StatusCode, Value)> {
    let request = build_json_request(method, path, body, None)?;
    dispatch_json(app, request).await
}

async fn request_raw(
    app: &axum::Router,
    token: &str,
    method: Method,
    path: &str,
    body: Vec<u8>,
    content_type: Option<&str>,
) -> anyhow::Result<(StatusCode, Vec<u8>)> {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header(header::AUTHORIZATION, format!("Bearer {token}"));
    if let Some(content_type) = content_type {
        builder = builder.header(header::CONTENT_TYPE, content_type);
    }
    let response = app.clone().oneshot(builder.body(Body::from(body))?).await?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await?.to_vec();
    Ok((status, bytes))
}

async fn current_user_id(app: &axum::Router, token: &str) -> anyhow::Result<String> {
    let (status, payload) =
        request_json(app, token, Method::GET, "/api/v1/users/@me", None).await?;
    assert_eq!(status, StatusCode::OK, "unexpected current user: {payload}");
    Ok(payload["id"]
        .as_str()
        .context("user id should be a string")?
        .to_string())
}

#[tokio::test]
async fn basic_route_flow_uses_postgres_when_configured() -> anyhow::Result<()> {
    let database_url = match std::env::var("PARACORD_TEST_POSTGRES_URL") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => {
            eprintln!("skipping PostgreSQL route smoke: PARACORD_TEST_POSTGRES_URL is not set");
            return Ok(());
        }
    };

    assert!(
        database_url.starts_with("postgres://") || database_url.starts_with("postgresql://"),
        "PARACORD_TEST_POSTGRES_URL must use a PostgreSQL URL"
    );

    let test_app = build_test_app(TestAppOptions {
        database_url: Some(database_url),
        install_http_rate_limiter: true,
        ..Default::default()
    })
    .await?;
    let token = create_authenticated_user_token(
        &test_app.db,
        &test_app.jwt_secret,
        "postgres_route",
        "PostgresRoutePass123!",
    )
    .await?;
    let user_id = current_user_id(&test_app.app, &token).await?;

    let (status, guild) = request_json(
        &test_app.app,
        &token,
        Method::POST,
        "/api/v1/guilds",
        Some(json!({ "name": "PostgreSQL Route Smoke", "icon": Value::Null })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "unexpected guild payload: {guild}"
    );
    let guild_id = guild["id"]
        .as_str()
        .context("guild id should be a string")?;

    let (status, updated_guild) = request_json(
        &test_app.app,
        &token,
        Method::PATCH,
        &format!("/api/v1/guilds/{guild_id}"),
        Some(json!({
            "name": "PostgreSQL Route Smoke Updated",
            "description": "PostgreSQL route smoke update path",
        })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected guild update payload: {updated_guild}"
    );
    assert_eq!(updated_guild["name"], "PostgreSQL Route Smoke Updated");

    let (status, channel) = request_json(
        &test_app.app,
        &token,
        Method::POST,
        &format!("/api/v1/guilds/{guild_id}/channels"),
        Some(json!({
            "name": "postgres-route-smoke",
            "channel_type": 0,
            "parent_id": Value::Null,
            "required_role_ids": Value::Null,
        })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "unexpected channel payload: {channel}"
    );
    let channel_id = channel["id"]
        .as_str()
        .context("channel id should be a string")?;

    let (status, updated_channel) = request_json(
        &test_app.app,
        &token,
        Method::PATCH,
        &format!("/api/v1/channels/{channel_id}"),
        Some(json!({
            "name": "postgres-route-smoke-updated",
            "topic": "PostgreSQL channel update path",
            "rate_limit_per_user": 0,
            "nsfw": false,
        })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected channel update payload: {updated_channel}"
    );
    assert_eq!(updated_channel["name"], "postgres-route-smoke-updated");
    assert_eq!(
        updated_channel["topic"],
        json!("PostgreSQL channel update path")
    );

    let (status, message) = request_json(
        &test_app.app,
        &token,
        Method::POST,
        &format!("/api/v1/channels/{channel_id}/messages"),
        Some(json!({ "content": "postgres route smoke message" })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "unexpected message payload: {message}"
    );
    let message_id = message["id"]
        .as_str()
        .context("message id should be a string")?;
    assert_eq!(
        paracord_db::active_database_engine(),
        paracord_db::DatabaseEngine::Postgres
    );
    let guild_id_i64 = guild_id.parse::<i64>()?;
    let user_id_i64 = user_id.parse::<i64>()?;
    let xp_after_message =
        paracord_db::economy::get_user_xp(&test_app.db, user_id_i64, guild_id_i64).await?;
    assert!(
        xp_after_message.is_some(),
        "PostgreSQL-backed message send should award economy XP"
    );

    let send_at = (Utc::now() + Duration::seconds(30)).to_rfc3339();
    let (status, scheduled) = request_json(
        &test_app.app,
        &token,
        Method::POST,
        &format!("/api/v1/channels/{channel_id}/scheduled-messages"),
        Some(json!({
            "content": "postgres scheduled message",
            "send_at": send_at,
        })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "unexpected scheduled message: {scheduled}"
    );
    let scheduled_id = scheduled["id"]
        .as_str()
        .context("scheduled message id should be a string")?;

    let (status, scheduled_messages) = request_json(
        &test_app.app,
        &token,
        Method::GET,
        &format!("/api/v1/channels/{channel_id}/scheduled-messages"),
        None,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected scheduled message list: {scheduled_messages}"
    );
    assert!(
        scheduled_messages
            .as_array()
            .context("scheduled messages should be an array")?
            .iter()
            .any(|item| item.get("id").and_then(Value::as_str) == Some(scheduled_id)),
        "created scheduled message should be listed"
    );

    let (status, cancelled_scheduled) = request_json(
        &test_app.app,
        &token,
        Method::DELETE,
        &format!("/api/v1/channels/{channel_id}/scheduled-messages/{scheduled_id}"),
        None,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "unexpected scheduled message cancel response: {cancelled_scheduled}"
    );

    let (status, messages) = request_json(
        &test_app.app,
        &token,
        Method::GET,
        &format!("/api/v1/channels/{channel_id}/messages"),
        None,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected messages payload: {messages}"
    );
    let messages = messages
        .as_array()
        .context("messages response should be an array")?;
    assert!(
        messages
            .iter()
            .any(|item| item.get("id").and_then(Value::as_str) == Some(message_id)),
        "created message should be returned by PostgreSQL-backed message listing"
    );

    let (status, role) = request_json(
        &test_app.app,
        &token,
        Method::POST,
        &format!("/api/v1/guilds/{guild_id}/roles"),
        Some(json!({
            "name": "PostgreSQL Smoke Role",
            "permissions": 0,
            "color": 3368601,
            "hoist": true,
            "mentionable": true,
        })),
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "unexpected role: {role}");
    let role_id = role["id"].as_str().context("role id should be a string")?;

    let (status, roles) = request_json(
        &test_app.app,
        &token,
        Method::GET,
        &format!("/api/v1/guilds/{guild_id}/roles"),
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "unexpected roles: {roles}");
    assert!(
        roles
            .as_array()
            .context("roles response should be an array")?
            .iter()
            .any(|item| item.get("id").and_then(Value::as_str) == Some(role_id)),
        "created role should be listed by PostgreSQL-backed role listing"
    );

    let (status, updated_role) = request_json(
        &test_app.app,
        &token,
        Method::PATCH,
        &format!("/api/v1/guilds/{guild_id}/roles/{role_id}"),
        Some(json!({
            "name": "PostgreSQL Smoke Role Updated",
            "mentionable": false,
        })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected updated role: {updated_role}"
    );
    assert_eq!(updated_role["name"], "PostgreSQL Smoke Role Updated");
    assert_eq!(updated_role["mentionable"], false);

    let (status, updated_member) = request_json(
        &test_app.app,
        &token,
        Method::PATCH,
        &format!("/api/v1/guilds/{guild_id}/members/{user_id}"),
        Some(json!({
            "nick": "pg-smoke-owner",
            "roles": [role_id],
        })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected updated member: {updated_member}"
    );
    assert_eq!(updated_member["nick"], "pg-smoke-owner");
    assert!(
        updated_member["roles"]
            .as_array()
            .is_some_and(|roles| roles.iter().any(|id| id.as_str() == Some(role_id))),
        "updated member should include assigned role: {updated_member}"
    );

    let (status, members) = request_json(
        &test_app.app,
        &token,
        Method::GET,
        &format!("/api/v1/guilds/{guild_id}/members"),
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "unexpected members: {members}");
    assert!(
        members
            .as_array()
            .context("members response should be an array")?
            .iter()
            .any(|member| {
                member.get("user_id").and_then(Value::as_str) == Some(user_id.as_str())
                    && member.get("nick").and_then(Value::as_str) == Some("pg-smoke-owner")
            }),
        "updated member should be listed with nick"
    );

    let (status, invite) = request_json(
        &test_app.app,
        &token,
        Method::POST,
        &format!("/api/v1/channels/{channel_id}/invites"),
        Some(json!({ "max_uses": 1, "max_age": 3600 })),
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "unexpected invite: {invite}");
    let invite_code = invite["code"]
        .as_str()
        .context("invite code should be a string")?;

    let (status, invite_preview) = request_json(
        &test_app.app,
        &token,
        Method::GET,
        &format!("/api/v1/invites/{invite_code}"),
        None,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected invite preview: {invite_preview}"
    );
    assert_eq!(invite_preview["code"], invite_code);

    let (status, guild_invites) = request_json(
        &test_app.app,
        &token,
        Method::GET,
        &format!("/api/v1/guilds/{guild_id}/invites"),
        None,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected guild invites: {guild_invites}"
    );
    assert!(
        guild_invites
            .as_array()
            .context("guild invites response should be an array")?
            .iter()
            .any(|item| item.get("code").and_then(Value::as_str) == Some(invite_code)),
        "created invite should be listed"
    );

    let invited_token = create_authenticated_user_token(
        &test_app.db,
        &test_app.jwt_secret,
        "postgres_route_invited",
        "PostgresRoutePass123!",
    )
    .await?;
    let invited_user_id = current_user_id(&test_app.app, &invited_token).await?;
    let (status, accepted) = request_json_with_token(
        &test_app.app,
        &invited_token,
        Method::POST,
        &format!("/api/v1/invites/{invite_code}"),
        Some(json!({})),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected accepted invite: {accepted}"
    );
    assert_eq!(accepted["guild"]["id"], guild_id);

    let exhausted_token = create_authenticated_user_token(
        &test_app.db,
        &test_app.jwt_secret,
        "postgres_route_exhausted",
        "PostgresRoutePass123!",
    )
    .await?;
    let (status, exhausted) = request_json_with_token(
        &test_app.app,
        &exhausted_token,
        Method::POST,
        &format!("/api/v1/invites/{invite_code}"),
        Some(json!({})),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "single-use invite should be hidden after exhaustion: {exhausted}"
    );

    let (status, members_after_invite) = request_json(
        &test_app.app,
        &token,
        Method::GET,
        &format!("/api/v1/guilds/{guild_id}/members"),
        None,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected members after invite: {members_after_invite}"
    );
    assert!(
        members_after_invite
            .as_array()
            .context("members response should be an array")?
            .iter()
            .any(|member| member.get("user_id").and_then(Value::as_str)
                == Some(invited_user_id.as_str())),
        "accepted invite should add the invited user as a member"
    );

    let (status, dm_channel) = request_json(
        &test_app.app,
        &token,
        Method::POST,
        "/api/v1/users/@me/channels",
        Some(json!({
            "recipient_ids": [invited_user_id],
            "name": "PostgreSQL Route DM",
        })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "unexpected group DM create response: {dm_channel}"
    );
    assert_eq!(dm_channel["channel_type"], json!(3));
    let dm_channel_id = dm_channel["id"]
        .as_str()
        .context("DM channel id should be a string")?;

    let (status, dm_channels) = request_json(
        &test_app.app,
        &token,
        Method::GET,
        "/api/v1/users/@me/dms",
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "unexpected DM list: {dm_channels}");
    assert!(
        dm_channels
            .as_array()
            .context("DM list should be an array")?
            .iter()
            .any(|item| item.get("id").and_then(Value::as_str) == Some(dm_channel_id)),
        "created group DM should be listed"
    );

    let (status, _) = request_json(
        &test_app.app,
        &token,
        Method::PUT,
        &format!("/api/v1/channels/{channel_id}/messages/{message_id}/reactions/thumbsup/@me"),
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, reacted_messages) = request_json(
        &test_app.app,
        &token,
        Method::GET,
        &format!("/api/v1/channels/{channel_id}/messages"),
        None,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected reacted messages: {reacted_messages}"
    );
    let reacted_message = reacted_messages
        .as_array()
        .context("reacted messages should be an array")?
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(message_id))
        .context("reacted message should be listed")?;
    assert!(
        reacted_message["reactions"]
            .as_array()
            .is_some_and(|reactions| reactions
                .iter()
                .any(|reaction| reaction["emoji"] == "thumbsup"
                    && reaction["count"].as_i64().unwrap_or_default() == 1
                    && reaction["me"] == true)),
        "added reaction should be visible in message listing: {reacted_message}"
    );

    let (status, _) = request_json(
        &test_app.app,
        &token,
        Method::DELETE,
        &format!("/api/v1/channels/{channel_id}/messages/{message_id}/reactions/thumbsup/@me"),
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, webhook) = request_json(
        &test_app.app,
        &token,
        Method::POST,
        &format!("/api/v1/guilds/{guild_id}/webhooks"),
        Some(json!({
            "name": "PostgreSQL Hook",
            "channel_id": channel_id,
        })),
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "unexpected webhook: {webhook}");
    let webhook_id = webhook["id"]
        .as_str()
        .context("webhook id should be a string")?;
    let webhook_token = webhook["token"]
        .as_str()
        .context("webhook token should be a string")?;
    let (status, webhook_message) = request_json_no_auth(
        &test_app.app,
        Method::POST,
        &format!("/api/v1/webhooks/{webhook_id}/{webhook_token}"),
        Some(json!({ "content": "postgres webhook payload" })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "unexpected webhook execution: {webhook_message}"
    );
    assert_eq!(
        webhook_message["content"],
        json!("postgres webhook payload")
    );
    assert_eq!(webhook_message["channel_id"], json!(channel_id));

    let (status, economy) = request_json(
        &test_app.app,
        &token,
        Method::GET,
        &format!("/api/v1/guilds/{guild_id}/economy/me"),
        None,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected economy progress: {economy}"
    );
    let xp = economy["xp"]
        .as_i64()
        .context("economy progress should include xp")?;
    assert!(xp >= 15, "message send should award XP: {economy}");
    assert_eq!(
        economy["streak"]["days"],
        json!(1),
        "first economy activity should start a streak: {economy}"
    );

    let (status, leaderboard) = request_json(
        &test_app.app,
        &token,
        Method::GET,
        &format!("/api/v1/guilds/{guild_id}/economy/leaderboard?limit=10"),
        None,
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected economy leaderboard: {leaderboard}"
    );
    assert!(
        leaderboard["entries"]
            .as_array()
            .context("leaderboard entries should be an array")?
            .iter()
            .any(|entry| entry["user"]["id"] == json!(user_id)
                && entry["xp"].as_i64().unwrap_or_default() >= 15),
        "sender should appear in PostgreSQL-backed leaderboard: {leaderboard}"
    );

    let boundary = "----paracord-postgres-smoke-boundary";
    let mut attachment_body = Vec::new();
    attachment_body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    attachment_body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"postgres-smoke.txt\"\r\n",
    );
    attachment_body.extend_from_slice(b"Content-Type: text/plain\r\n\r\n");
    attachment_body.extend_from_slice(b"postgres smoke attachment\n");
    attachment_body.extend_from_slice(b"\r\n");
    attachment_body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

    let (status, attachment_bytes) = request_raw(
        &test_app.app,
        &token,
        Method::POST,
        &format!("/api/v1/channels/{channel_id}/attachments"),
        attachment_body,
        Some(&format!("multipart/form-data; boundary={boundary}")),
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "attachment upload failed");
    let attachment: Value =
        serde_json::from_slice(&attachment_bytes).context("attachment response should be json")?;
    let attachment_id = attachment["id"]
        .as_str()
        .context("attachment id should be a string")?;
    assert_eq!(attachment["filename"], "postgres-smoke.txt");
    assert_eq!(attachment["content_type"], "text/plain");

    let (status, attachment_message) = request_json(
        &test_app.app,
        &token,
        Method::POST,
        &format!("/api/v1/channels/{channel_id}/messages"),
        Some(json!({ "content": "", "attachment_ids": [attachment_id] })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "unexpected attachment message: {attachment_message}"
    );
    assert!(
        attachment_message["attachments"]
            .as_array()
            .is_some_and(|attachments| attachments.iter().any(|item| {
                item.get("id").and_then(Value::as_str) == Some(attachment_id)
                    && item.get("filename").and_then(Value::as_str) == Some("postgres-smoke.txt")
            })),
        "message response should include attached file metadata: {attachment_message}"
    );

    let (status, _) = request_json(
        &test_app.app,
        &token,
        Method::DELETE,
        &format!("/api/v1/attachments/{attachment_id}"),
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _) = request_json(
        &test_app.app,
        &token,
        Method::DELETE,
        &format!("/api/v1/guilds/{guild_id}/roles/{role_id}"),
        None,
    )
    .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    Ok(())
}
