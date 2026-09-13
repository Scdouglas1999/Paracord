//! The typing indicator's start *and* stop.
//!
//! Until a stop existed, the only thing that ever cleared "…is typing" was the
//! recipient's own expiry timer, so the indicator outlived the message it was
//! announcing by several seconds. The stop travels on the same route, under the
//! same permission check, as its own gateway event.

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
use std::time::Duration;

struct Ctx {
    app: Router,
    db: paracord_db::DbPool,
    jwt_secret: String,
    token: String,
    test_app: TestApp,
}

impl Ctx {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions::default()).await?;
        let token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "typingowner",
            "TypingOwnerPass123!",
        )
        .await?;
        Ok(Self {
            app: test_app.app.clone(),
            db: test_app.db.clone(),
            jwt_secret: test_app.jwt_secret.clone(),
            token,
            test_app,
        })
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        token: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        dispatch_json(
            &self.app,
            build_json_request(method, path, None, Some(token))?,
        )
        .await
    }

    async fn user_id(&self, token: &str) -> anyhow::Result<i64> {
        let (status, payload) = self.call(Method::GET, "/api/v1/users/@me", token).await?;
        assert_eq!(status, StatusCode::OK, "fetch @me: {payload}");
        Ok(payload["id"].as_str().context("user id")?.parse()?)
    }
}

async fn guild_with_channel(ctx: &Ctx) -> anyhow::Result<(String, String)> {
    let (status, guild) = dispatch_json(
        &ctx.app,
        build_json_request(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": "Typing", "icon": Value::Null })),
            Some(&ctx.token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "create guild: {guild}");
    let guild_id = guild["id"].as_str().context("guild id")?.to_string();
    let (status, channels) = ctx
        .call(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            &ctx.token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "list channels: {channels}");
    let channel_id = channels
        .as_array()
        .context("channels array")?
        .iter()
        .find(|channel| channel["type"] == json!(0))
        .context("a text channel")?["id"]
        .as_str()
        .context("channel id")?
        .to_string();
    Ok((guild_id, channel_id))
}

#[tokio::test]
async fn typing_start_and_stop_are_announced_as_distinct_events() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (guild_id, channel_id) = guild_with_channel(&ctx).await?;
    let author = ctx.user_id(&ctx.token).await?;
    let mut events = ctx.test_app.event_bus.subscribe_system();

    let (status, _) = ctx
        .call(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/typing"),
            &ctx.token,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let start = tokio::time::timeout(Duration::from_secs(1), events.recv()).await??;
    assert_eq!(start.event_type, "TYPING_START");
    assert_eq!(start.guild_id.map(|id| id.to_string()), Some(guild_id));
    assert_eq!(start.payload["channel_id"], json!(channel_id));
    assert_eq!(start.payload["user_id"], json!(author.to_string()));

    // The same route, the same permission check, the opposite meaning.
    let (status, _) = ctx
        .call(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/typing?stop=true"),
            &ctx.token,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let stop = tokio::time::timeout(Duration::from_secs(1), events.recv()).await??;
    assert_eq!(stop.event_type, "TYPING_STOP");
    assert_eq!(stop.payload["channel_id"], json!(channel_id));
    assert_eq!(stop.payload["user_id"], json!(author.to_string()));

    // An explicit `stop=false` is still a start, so an older client that starts
    // sending the parameter cannot accidentally suppress its own indicator.
    let (status, _) = ctx
        .call(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/typing?stop=false"),
            &ctx.token,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let again = tokio::time::timeout(Duration::from_secs(1), events.recv()).await??;
    assert_eq!(again.event_type, "TYPING_START");
    Ok(())
}

#[tokio::test]
async fn a_typing_stop_reaches_the_dm_recipient_and_nobody_else() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let peer = create_authenticated_user_token(
        &ctx.db,
        &ctx.jwt_secret,
        "typingpeer",
        "TypingPeerPass123!",
    )
    .await?;
    let peer_id = ctx.user_id(&peer).await?;
    let author = ctx.user_id(&ctx.token).await?;
    // A DM needs consent: become friends first.
    let (status, sent) = dispatch_json(
        &ctx.app,
        build_json_request(
            Method::POST,
            "/api/v1/users/@me/relationships",
            Some(json!({ "user_id": peer_id.to_string(), "type": 1 })),
            Some(&ctx.token),
        )?,
    )
    .await?;
    assert!(status.is_success(), "friend request: {status} {sent}");
    let (status, accepted) = ctx
        .call(
            Method::PUT,
            &format!("/api/v1/users/@me/relationships/{author}"),
            &peer,
        )
        .await?;
    assert!(status.is_success(), "accept friend: {status} {accepted}");
    let (status, dm) = dispatch_json(
        &ctx.app,
        build_json_request(
            Method::POST,
            "/api/v1/users/@me/dms",
            Some(json!({ "recipient_id": peer_id.to_string() })),
            Some(&ctx.token),
        )?,
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "create DM: {dm}");
    let channel_id = dm["id"].as_str().context("dm id")?.to_string();

    let mut events = ctx.test_app.event_bus.subscribe_system();
    let (status, _) = ctx
        .call(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/typing?stop=true"),
            &ctx.token,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let stop = tokio::time::timeout(Duration::from_secs(1), events.recv()).await??;
    assert_eq!(stop.event_type, "TYPING_STOP");
    assert_eq!(stop.guild_id, None);
    let mut targets = stop.target_user_ids.clone().context("DM targets")?;
    targets.sort_unstable();
    let mut expected = vec![author, peer_id];
    expected.sort_unstable();
    assert_eq!(targets, expected);
    Ok(())
}

#[tokio::test]
async fn a_stop_needs_the_same_permission_a_start_does() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (_, channel_id) = guild_with_channel(&ctx).await?;
    let outsider = create_authenticated_user_token(
        &ctx.db,
        &ctx.jwt_secret,
        "typingoutsider",
        "TypingOutPass123!",
    )
    .await?;
    for path in [
        format!("/api/v1/channels/{channel_id}/typing"),
        format!("/api/v1/channels/{channel_id}/typing?stop=true"),
    ] {
        let (status, payload) = ctx.call(Method::POST, &path, &outsider).await?;
        assert!(
            status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND,
            "{path} should not be open to a non-member: {status} {payload}"
        );
    }
    Ok(())
}
