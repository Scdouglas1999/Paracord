mod common;

use anyhow::Context;
use axum::{
    http::{Method, StatusCode},
    Router,
};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use serde_json::{json, Value};

// ── Test context ────────────────────────────────────────────────────────────

struct TestContext {
    app: Router,
    token: String,
    db: paracord_db::DbPool,
    jwt_secret: String,
    _test_app: TestApp,
}

impl TestContext {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions {
            install_http_rate_limiter: false,
            ..Default::default()
        })
        .await?;
        let token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "attacker",
            "AttackerPass123!",
        )
        .await?;

        Ok(Self {
            app: test_app.app.clone(),
            token,
            db: test_app.db.clone(),
            jwt_secret: test_app.jwt_secret.clone(),
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

    /// Register a second, independent user and return their bearer token.
    async fn new_user_token(&self, prefix: &str) -> anyhow::Result<String> {
        create_authenticated_user_token(&self.db, &self.jwt_secret, prefix, "VictimPass123!").await
    }
}

async fn create_guild(ctx: &TestContext, token: &str, name: &str) -> anyhow::Result<String> {
    let (status, payload) = ctx
        .request_json_with_token(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": name, "icon": Value::Null })),
            token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "create guild failed: {payload}");
    Ok(payload["id"]
        .as_str()
        .context("guild id should be a string")?
        .to_string())
}

/// Create a channel of an explicit type (0 = text, 5 = announcement).
async fn create_channel(
    ctx: &TestContext,
    token: &str,
    guild_id: &str,
    name: &str,
    channel_type: i64,
) -> anyhow::Result<String> {
    let (status, payload) = ctx
        .request_json_with_token(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(json!({
                "name": name,
                "channel_type": channel_type,
                "parent_id": Value::Null,
                "required_role_ids": Value::Null,
            })),
            token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "create channel failed: {payload}");
    Ok(payload["id"]
        .as_str()
        .context("channel id should be a string")?
        .to_string())
}

// ── Regression: broken access control on POST /channels/{id}/followers ───────

/// An attacker who owns a source announcement channel but has NO permission in
/// the TARGET channel's guild must be rejected (403). Before the fix the handler
/// only authorized the attacker-controlled source and trusted the body's target,
/// so this returned 201 and injected a follow into a victim guild.
#[tokio::test]
async fn follow_rejected_when_actor_lacks_permission_on_target_guild() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;

    // Attacker owns an announcement (type 5) channel in their own guild.
    let attacker_guild = create_guild(&ctx, &ctx.token, "AttackerGuild").await?;
    let source_channel =
        create_channel(&ctx, &ctx.token, &attacker_guild, "announcements", 5).await?;

    // Victim owns a separate guild + channel the attacker never joined.
    let victim_token = ctx.new_user_token("victim").await?;
    let victim_guild = create_guild(&ctx, &victim_token, "VictimGuild").await?;
    let victim_channel =
        create_channel(&ctx, &victim_token, &victim_guild, "private-ops", 0).await?;

    // Attacker follows their announcement channel INTO the victim's channel.
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{source_channel}/followers"),
            Some(json!({
                "target_channel_id": victim_channel,
                "target_guild_id": victim_guild,
            })),
        )
        .await?;

    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "attacker must not be able to follow content into a guild they do not manage; got {status}: {payload}"
    );
    Ok(())
}

/// A legitimate cross-guild follow — actor holds MANAGE_WEBHOOKS on the target
/// (guild owner) and VIEW_CHANNEL on the source — still succeeds. Also asserts
/// the persisted target_guild_id is DERIVED from the target channel, not taken
/// from the (deliberately bogus) body value.
#[tokio::test]
async fn legitimate_cross_guild_follow_succeeds_and_derives_target_guild() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;

    // Actor owns both guilds → holds all permissions in each.
    let source_guild = create_guild(&ctx, &ctx.token, "SourceGuild").await?;
    let source_channel = create_channel(&ctx, &ctx.token, &source_guild, "news", 5).await?;

    let target_guild = create_guild(&ctx, &ctx.token, "TargetGuild").await?;
    let target_channel = create_channel(&ctx, &ctx.token, &target_guild, "feed", 0).await?;

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{source_channel}/followers"),
            Some(json!({
                "target_channel_id": target_channel,
                // Deliberately bogus: the handler must ignore this and derive the
                // real guild from the target channel.
                "target_guild_id": "999999999999",
            })),
        )
        .await?;

    assert_eq!(
        status,
        StatusCode::CREATED,
        "legitimate follow should succeed; got {status}: {payload}"
    );
    assert_eq!(
        payload["target_channel_id"].as_str(),
        Some(target_channel.as_str()),
        "follow should record the requested target channel: {payload}"
    );
    assert_eq!(
        payload["target_guild_id"].as_str(),
        Some(target_guild.as_str()),
        "target_guild_id must be derived from the target channel, not the body: {payload}"
    );
    Ok(())
}
