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

struct Ctx {
    app: Router,
    db: paracord_db::DbPool,
    jwt_secret: String,
    token: String,
    _test_app: TestApp,
}

impl Ctx {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions::default()).await?;
        let token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "notifowner",
            "NotifOwnerPass123!",
        )
        .await?;
        Ok(Self {
            app: test_app.app.clone(),
            db: test_app.db.clone(),
            jwt_secret: test_app.jwt_secret.clone(),
            token,
            _test_app: test_app,
        })
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        token: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        dispatch_json(
            &self.app,
            build_json_request(method, path, body, Some(token))?,
        )
        .await
    }

    async fn as_owner(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        self.call(method, path, body, &self.token).await
    }

    async fn user_id(&self, token: &str) -> anyhow::Result<i64> {
        let (status, payload) = self
            .call(Method::GET, "/api/v1/users/@me", None, token)
            .await?;
        assert_eq!(status, StatusCode::OK, "fetch @me: {payload}");
        Ok(payload["id"].as_str().context("user id")?.parse()?)
    }

    /// An additional authenticated user, joined to `guild_id` with the default
    /// Member role (role id == guild id).
    async fn add_member(&self, prefix: &str, guild_id: i64) -> anyhow::Result<String> {
        let token =
            create_authenticated_user_token(&self.db, &self.jwt_secret, prefix, "NotifPass123!")
                .await?;
        let uid = self.user_id(&token).await?;
        paracord_db::members::add_member(&self.db, uid, guild_id).await?;
        paracord_db::roles::add_member_role(&self.db, uid, guild_id, guild_id).await?;
        Ok(token)
    }

    /// A user who is authenticated but joined to nothing.
    async fn add_outsider(&self, prefix: &str) -> anyhow::Result<String> {
        create_authenticated_user_token(&self.db, &self.jwt_secret, prefix, "NotifPass123!").await
    }
}

/// Create a guild and return `(guild_id, first_text_channel_id)`.
async fn guild_with_channel(ctx: &Ctx, name: &str) -> anyhow::Result<(String, String)> {
    let (status, guild) = ctx
        .as_owner(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": name, "icon": Value::Null })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "create guild: {guild}");
    let guild_id = guild["id"].as_str().context("guild id")?.to_string();

    let (status, channels) = ctx
        .as_owner(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "list channels: {channels}");
    let channel_id = channels
        .as_array()
        .context("channels array")?
        .iter()
        .find(|c| c["channel_type"].as_i64().or_else(|| c["type"].as_i64()) == Some(0))
        .and_then(|c| c["id"].as_str())
        .context("a text channel")?
        .to_string();
    Ok((guild_id, channel_id))
}

/// The whole point of the feature: quiet one scope without leaving it, and put
/// it back afterwards.
#[tokio::test]
async fn space_and_channel_settings_round_trip() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (guild_id, channel_id) = guild_with_channel(&ctx, "Notif Guild").await?;

    // Nothing is set until the user sets something.
    let (status, listed) = ctx
        .as_owner(Method::GET, "/api/v1/users/@me/notification-settings", None)
        .await?;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert!(listed["spaces"].as_array().context("spaces")?.is_empty());
    assert!(listed["channels"]
        .as_array()
        .context("channels")?
        .is_empty());

    let (status, space) = ctx
        .as_owner(
            Method::PUT,
            &format!("/api/v1/guilds/{guild_id}/notification-settings"),
            Some(json!({ "level": 1, "muted": true, "suppress_everyone": true })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "put space settings: {space}");
    assert_eq!(space["level"], json!(1));
    assert_eq!(space["muted"], json!(true));
    assert_eq!(space["muted_now"], json!(true));
    assert_eq!(space["suppress_everyone"], json!(true));

    // A channel override on top of a muted space — "follow this one channel".
    let (status, channel) = ctx
        .as_owner(
            Method::PUT,
            &format!("/api/v1/channels/{channel_id}/notification-settings"),
            Some(json!({ "level": 0, "muted": false })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "put channel settings: {channel}");
    assert_eq!(channel["muted"], json!(false));

    let (_, listed) = ctx
        .as_owner(Method::GET, "/api/v1/users/@me/notification-settings", None)
        .await?;
    assert_eq!(listed["spaces"].as_array().context("spaces")?.len(), 1);
    assert_eq!(listed["channels"].as_array().context("channels")?.len(), 1);

    // Writing again updates rather than duplicating.
    let (status, _) = ctx
        .as_owner(
            Method::PUT,
            &format!("/api/v1/guilds/{guild_id}/notification-settings"),
            Some(json!({ "level": 2 })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let (_, listed) = ctx
        .as_owner(Method::GET, "/api/v1/users/@me/notification-settings", None)
        .await?;
    let spaces = listed["spaces"].as_array().context("spaces")?;
    assert_eq!(spaces.len(), 1, "upsert must not duplicate: {listed}");
    assert_eq!(spaces[0]["level"], json!(2));

    // Clearing returns the scope to the default.
    for path in [
        format!("/api/v1/guilds/{guild_id}/notification-settings"),
        format!("/api/v1/channels/{channel_id}/notification-settings"),
    ] {
        let (status, _) = ctx.as_owner(Method::DELETE, &path, None).await?;
        assert_eq!(status, StatusCode::NO_CONTENT, "delete {path}");
    }
    let (_, listed) = ctx
        .as_owner(Method::GET, "/api/v1/users/@me/notification-settings", None)
        .await?;
    assert!(listed["spaces"].as_array().context("spaces")?.is_empty());
    assert!(listed["channels"]
        .as_array()
        .context("channels")?
        .is_empty());

    Ok(())
}

/// A preference is still a write keyed to a scope id. Accepting one for a space
/// the caller is not in, or a channel they cannot see, would both answer "does
/// this exist?" and leave rows naming scopes they have no business naming.
#[tokio::test]
async fn settings_cannot_be_written_for_scopes_the_caller_cannot_see() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (guild_id, channel_id) = guild_with_channel(&ctx, "Private Notif Guild").await?;
    let outsider = ctx.add_outsider("notifoutsider").await?;

    let (status, payload) = ctx
        .call(
            Method::PUT,
            &format!("/api/v1/guilds/{guild_id}/notification-settings"),
            Some(json!({ "muted": true })),
            &outsider,
        )
        .await?;
    assert!(
        status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND,
        "a non-member must not set settings on a space: {status} {payload}"
    );

    let (status, payload) = ctx
        .call(
            Method::PUT,
            &format!("/api/v1/channels/{channel_id}/notification-settings"),
            Some(json!({ "muted": true })),
            &outsider,
        )
        .await?;
    assert!(
        status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND,
        "a non-member must not set settings on a channel: {status} {payload}"
    );

    // ...and nothing was recorded for them.
    let (_, listed) = ctx
        .call(
            Method::GET,
            "/api/v1/users/@me/notification-settings",
            None,
            &outsider,
        )
        .await?;
    assert!(listed["spaces"].as_array().context("spaces")?.is_empty());
    assert!(listed["channels"]
        .as_array()
        .context("channels")?
        .is_empty());

    Ok(())
}

/// One user's preferences must never appear in another's, even in the same
/// space.
#[tokio::test]
async fn settings_are_scoped_to_the_caller() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (guild_id, _) = guild_with_channel(&ctx, "Shared Notif Guild").await?;
    let gid: i64 = guild_id.parse()?;
    let member = ctx.add_member("notifmember", gid).await?;

    let (status, _) = ctx
        .as_owner(
            Method::PUT,
            &format!("/api/v1/guilds/{guild_id}/notification-settings"),
            Some(json!({ "muted": true })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);

    let (_, listed) = ctx
        .call(
            Method::GET,
            "/api/v1/users/@me/notification-settings",
            None,
            &member,
        )
        .await?;
    assert!(
        listed["spaces"].as_array().context("spaces")?.is_empty(),
        "another member's mute must not leak into this user's settings: {listed}"
    );

    Ok(())
}

/// Bad input is a 400, never a 500 — and never a silently-stored nonsense value.
#[tokio::test]
async fn invalid_settings_are_rejected() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (guild_id, _) = guild_with_channel(&ctx, "Validation Notif Guild").await?;
    let path = format!("/api/v1/guilds/{guild_id}/notification-settings");

    for (label, body) in [
        ("level above the defined range", json!({ "level": 3 })),
        ("negative level", json!({ "level": -1 })),
        (
            "a duration without muted",
            json!({ "mute_duration_seconds": 600 }),
        ),
        (
            "a zero duration",
            json!({ "muted": true, "mute_duration_seconds": 0 }),
        ),
        (
            "a duration past the 28-day ceiling",
            json!({ "muted": true, "mute_duration_seconds": 60 * 60 * 24 * 29 }),
        ),
    ] {
        let (status, payload) = ctx.as_owner(Method::PUT, &path, Some(body)).await?;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{label} must be rejected: {payload}"
        );
    }

    // None of it was stored.
    let (_, listed) = ctx
        .as_owner(Method::GET, "/api/v1/users/@me/notification-settings", None)
        .await?;
    assert!(listed["spaces"].as_array().context("spaces")?.is_empty());

    Ok(())
}

/// A timed mute reports itself as muted while it runs, and the API resolves
/// `muted_now` so a client never has to re-derive it.
#[tokio::test]
async fn a_timed_mute_reports_itself_correctly() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (guild_id, _) = guild_with_channel(&ctx, "Timed Notif Guild").await?;

    let (status, space) = ctx
        .as_owner(
            Method::PUT,
            &format!("/api/v1/guilds/{guild_id}/notification-settings"),
            Some(json!({ "muted": true, "mute_duration_seconds": 3600 })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{space}");
    assert_eq!(space["muted"], json!(true));
    assert_eq!(space["muted_now"], json!(true));
    assert!(
        space["muted_until"].is_string(),
        "a timed mute must report when it lapses: {space}"
    );

    // An indefinite mute has no end.
    let (status, space) = ctx
        .as_owner(
            Method::PUT,
            &format!("/api/v1/guilds/{guild_id}/notification-settings"),
            Some(json!({ "muted": true })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{space}");
    assert_eq!(space["muted_until"], Value::Null);
    assert_eq!(space["muted_now"], json!(true));

    Ok(())
}
