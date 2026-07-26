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
            "posowner",
            "PosOwnerPass123!",
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

    async fn owner(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        self.call(method, path, body, &self.token).await
    }

    async fn add_member(&self, prefix: &str, guild_id: i64) -> anyhow::Result<(String, i64)> {
        let token =
            create_authenticated_user_token(&self.db, &self.jwt_secret, prefix, "PosPass123!")
                .await?;
        let (status, me) = self
            .call(Method::GET, "/api/v1/users/@me", None, &token)
            .await?;
        assert_eq!(status, StatusCode::OK, "@me: {me}");
        let uid: i64 = me["id"].as_str().context("user id")?.parse()?;
        paracord_db::members::add_member(&self.db, uid, guild_id).await?;
        paracord_db::roles::add_member_role(&self.db, uid, guild_id, guild_id).await?;
        Ok((token, uid))
    }
}

/// A thread's `parent_id` is its entire access-control input: `resolve_permission_gate`
/// reads a thread's overwrites and required roles through the parent. The
/// channel-position route wrote `parent_id` straight from the request body with
/// no validation, so re-pointing a private channel's thread at a public channel
/// published its contents to everyone — and the route's guild-level gate never
/// saw the private channel's deny.
#[tokio::test]
async fn a_thread_cannot_be_reparented_out_of_its_private_channel() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;

    let (status, guild) = ctx
        .owner(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": "Reparent Guild", "icon": Value::Null })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "guild: {guild}");
    let guild_id = guild["id"].as_str().context("guild id")?.to_string();
    let gid: i64 = guild_id.parse()?;

    // A public channel everyone can see, and a private one only the owner can.
    let (status, public_channel) = ctx
        .owner(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(json!({ "name": "public-lounge", "channel_type": 0 })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "public channel: {public_channel}"
    );
    let public_id = public_channel["id"]
        .as_str()
        .context("public id")?
        .to_string();

    let (status, private_channel) = ctx
        .owner(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(json!({ "name": "boardroom", "channel_type": 0 })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "private channel: {private_channel}"
    );
    let private_id = private_channel["id"]
        .as_str()
        .context("private id")?
        .to_string();

    // Deny @everyone VIEW_CHANNEL on the private channel (role id == guild id).
    let view_channel: i64 = 1 << 10;
    let (status, payload) = ctx
        .owner(
            Method::PUT,
            &format!("/api/v1/channels/{private_id}/overwrites/{guild_id}"),
            Some(json!({ "target_type": 0, "allow_perms": 0, "deny_perms": view_channel })),
        )
        .await?;
    assert!(
        status.is_success(),
        "deny overwrite should apply: {status} {payload}"
    );

    // A thread inside the private channel, with a secret in it.
    let (status, thread) = ctx
        .owner(
            Method::POST,
            &format!("/api/v1/channels/{private_id}/threads"),
            Some(json!({ "name": "board-thread" })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "thread: {thread}");
    let thread_id = thread["id"].as_str().context("thread id")?.to_string();

    let (status, _) = ctx
        .owner(
            Method::POST,
            &format!("/api/v1/channels/{thread_id}/messages"),
            Some(json!({ "content": "BOARDROOM-SECRET-XYZ" })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);

    // A plain member cannot read the thread — the gate resolves through the parent.
    let (member_token, _) = ctx.add_member("posmember", gid).await?;
    let (status, _) = ctx
        .call(
            Method::GET,
            &format!("/api/v1/channels/{thread_id}/messages"),
            None,
            &member_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "baseline: the thread must be unreadable before the move"
    );

    // The attack: re-point the thread at the public channel.
    let (status, payload) = ctx
        .owner(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(json!([{ "id": thread_id, "position": 9, "parent_id": public_id }])),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "re-parenting a thread must be rejected outright: {payload}"
    );

    // ...and the secret is still not readable.
    let (status, _) = ctx
        .call(
            Method::GET,
            &format!("/api/v1/channels/{thread_id}/messages"),
            None,
            &member_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "the private thread must remain unreadable after the attempted move"
    );

    Ok(())
}

/// `parent_id` was never checked for existence, guild, or type, so a channel
/// could be parented to another space's channel or to an id that resolves to
/// nothing.
#[tokio::test]
async fn channel_parent_must_be_a_category_in_the_same_space() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;

    let (_, guild) = ctx
        .owner(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": "Parent Validation", "icon": Value::Null })),
        )
        .await?;
    let guild_id = guild["id"].as_str().context("guild id")?.to_string();

    let (_, other_guild) = ctx
        .owner(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": "Other Space", "icon": Value::Null })),
        )
        .await?;
    let other_guild_id = other_guild["id"]
        .as_str()
        .context("other guild id")?
        .to_string();
    let (_, other_channels) = ctx
        .owner(
            Method::GET,
            &format!("/api/v1/guilds/{other_guild_id}/channels"),
            None,
        )
        .await?;
    let foreign_channel = other_channels
        .as_array()
        .context("channels array")?
        .first()
        .and_then(|c| c["id"].as_str())
        .context("a channel in the other space")?
        .to_string();

    let (status, channel) = ctx
        .owner(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(json!({ "name": "movable", "channel_type": 0 })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "channel: {channel}");
    let channel_id = channel["id"].as_str().context("channel id")?.to_string();

    for (label, parent) in [
        ("a channel in another space", foreign_channel.as_str()),
        ("an id that does not exist", "123456789012345678"),
    ] {
        let (status, payload) = ctx
            .owner(
                Method::PATCH,
                &format!("/api/v1/guilds/{guild_id}/channels"),
                Some(json!([{ "id": channel_id, "position": 1, "parent_id": parent }])),
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "parent_id must reject {label}: {payload}"
        );
    }

    // A plain reorder with no re-parenting still works.
    let (status, payload) = ctx
        .owner(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(json!([{ "id": channel_id, "position": 3 }])),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "reordering must still work: {payload}"
    );

    Ok(())
}
