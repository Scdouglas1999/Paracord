//! The guild-admin display names obey the shared markup contract.
//!
//! `paracord_util::validation::contains_dangerous_markup` documents itself as
//! "the single definition for fields that never legitimately contain markup —
//! display names, bios, custom statuses, channel/space/bot/event/template
//! names, topics, descriptions, moderator reasons and notes". Four of the
//! fields it names had never actually called it: a space's name, a room's name,
//! a role's name, and a member's nickname. A guild description, a channel
//! topic, an event name, a bot name and a template-applied space name all
//! rejected `<script>` — the four labels a reader actually sees most often did
//! not, and each one is copied verbatim into the audit log's `changes` payload,
//! which is exactly the moderation-dashboard surface the contract exists for.
//!
//! The same hole ran through the moderation surfaces that sit beside them: a
//! webhook's name (which *is* the author name on every message it posts), an
//! AutoMod rule's name (echoed into every hit row and moderator alert), a
//! moderation template's name, and the two short onboarding labels every
//! arriving member reads.
//!
//! `welcome_body` and `rules_text` stay out of it on purpose: they are
//! long-form prose where `<` and `>` are ordinary characters, which is the same
//! reason the contract exempts message content.
//!
//! The assertions match on the bound's own error text so a 400 from some
//! unrelated validator cannot be mistaken for this one firing.

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

const MARKUP: &str = "<img src=x onerror=alert(1)>";

struct Ctx {
    app: Router,
    token: String,
    _test_app: TestApp,
}

impl Ctx {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions::default()).await?;
        let token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "markupowner",
            "MarkupPass123!",
        )
        .await?;
        Ok(Self {
            app: test_app.app.clone(),
            token,
            _test_app: test_app,
        })
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let request = build_json_request(method, path, body, Some(&self.token))?;
        dispatch_json(&self.app, request).await
    }

    async fn me(&self) -> anyhow::Result<String> {
        let (status, payload) = self.call(Method::GET, "/api/v1/users/@me", None).await?;
        assert_eq!(status, StatusCode::OK, "fetch @me failed: {payload}");
        Ok(payload["id"]
            .as_str()
            .context("user id should be a string")?
            .to_string())
    }

    async fn guild(&self) -> anyhow::Result<String> {
        let (status, payload) = self
            .call(
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": "Markup Contract", "icon": Value::Null })),
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "guild create failed: {payload}"
        );
        Ok(payload["id"]
            .as_str()
            .context("guild id should be a string")?
            .to_string())
    }
}

fn message(payload: &Value) -> String {
    payload["message"].as_str().unwrap_or_default().to_string()
}

#[tokio::test]
async fn space_name_rejects_markup_on_create_and_rename() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;

    let (status, payload) = ctx
        .call(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": MARKUP, "icon": Value::Null })),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "create: {payload}");
    assert!(
        message(&payload).contains("unsafe markup"),
        "create rejected for the wrong reason: {payload}"
    );

    let guild_id = ctx.guild().await?;
    let (status, payload) = ctx
        .call(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}"),
            Some(json!({ "name": MARKUP })),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "rename: {payload}");
    assert!(
        message(&payload).contains("unsafe markup"),
        "rename rejected for the wrong reason: {payload}"
    );

    // The ordinary name still goes through — the check is a markup gate, not a
    // ban on punctuation.
    let (status, payload) = ctx
        .call(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}"),
            Some(json!({ "name": "Renamed — still fine" })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "benign rename refused: {payload}");
    Ok(())
}

#[tokio::test]
async fn room_name_rejects_markup_on_create_and_rename() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let guild_id = ctx.guild().await?;

    let (status, payload) = ctx
        .call(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(json!({
                "name": MARKUP,
                "channel_type": 0,
                "parent_id": Value::Null,
                "required_role_ids": Value::Null,
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "create: {payload}");
    assert!(
        message(&payload).contains("unsafe markup"),
        "create rejected for the wrong reason: {payload}"
    );

    let (status, payload) = ctx
        .call(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(json!({
                "name": "benign-room",
                "channel_type": 0,
                "parent_id": Value::Null,
                "required_role_ids": Value::Null,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "benign create refused: {payload}"
    );
    let channel_id = payload["id"]
        .as_str()
        .context("channel id should be a string")?
        .to_string();

    let (status, payload) = ctx
        .call(
            Method::PATCH,
            &format!("/api/v1/channels/{channel_id}"),
            Some(json!({ "name": MARKUP })),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "rename: {payload}");
    assert!(
        message(&payload).contains("unsafe markup"),
        "rename rejected for the wrong reason: {payload}"
    );
    Ok(())
}

#[tokio::test]
async fn role_name_rejects_markup_on_create_and_rename() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let guild_id = ctx.guild().await?;

    let (status, payload) = ctx
        .call(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/roles"),
            Some(json!({ "name": MARKUP, "permissions": 0 })),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "create: {payload}");
    assert!(
        message(&payload).contains("unsafe markup"),
        "create rejected for the wrong reason: {payload}"
    );

    let (status, payload) = ctx
        .call(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/roles"),
            Some(json!({ "name": "Moderators", "permissions": 0 })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "benign create refused: {payload}"
    );
    let role_id = payload["id"]
        .as_str()
        .context("role id should be a string")?
        .to_string();

    let (status, payload) = ctx
        .call(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/roles/{role_id}"),
            Some(json!({ "name": MARKUP })),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "rename: {payload}");
    assert!(
        message(&payload).contains("unsafe markup"),
        "rename rejected for the wrong reason: {payload}"
    );
    Ok(())
}

#[tokio::test]
async fn member_nickname_rejects_markup() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let guild_id = ctx.guild().await?;
    let user_id = ctx.me().await?;

    let (status, payload) = ctx
        .call(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/members/{user_id}"),
            Some(json!({ "nick": MARKUP })),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "nick: {payload}");
    assert!(
        message(&payload).contains("unsafe markup"),
        "nick rejected for the wrong reason: {payload}"
    );

    let (status, payload) = ctx
        .call(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/members/{user_id}"),
            Some(json!({ "nick": "Nickname ünï 🎈" })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "benign nick refused: {payload}");
    assert_eq!(payload["nick"], json!("Nickname ünï 🎈"));
    Ok(())
}

#[tokio::test]
async fn moderation_surfaces_reject_markup_in_their_labels() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let guild_id = ctx.guild().await?;

    // The default space comes with a text room; the webhook route needs one.
    let (status, channels) = ctx
        .call(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "channel list: {channels}");
    let channel_id = channels
        .as_array()
        .and_then(|rooms| {
            rooms
                .iter()
                .find(|room| room["channel_type"] == json!(0) || room["type"] == json!(0))
        })
        .and_then(|room| room["id"].as_str())
        .context("the new space should have a text room")?
        .to_string();

    let probes: Vec<(&str, Method, String, Value)> = vec![
        (
            "webhook name",
            Method::POST,
            format!("/api/v1/guilds/{guild_id}/webhooks"),
            json!({ "name": MARKUP, "channel_id": channel_id }),
        ),
        (
            "automod rule name",
            Method::POST,
            format!("/api/v1/guilds/{guild_id}/automod/rules"),
            json!({
                "name": MARKUP,
                "event_type": 1,
                "trigger_type": 1,
                "trigger_metadata": { "kind": "keyword", "keywords": ["spam"] },
                "actions": [{ "kind": "block_message" }],
                "enabled": true,
            }),
        ),
        (
            "moderation template name",
            Method::POST,
            format!("/api/v1/guilds/{guild_id}/moderation/templates"),
            json!({ "name": MARKUP, "action_type": 3 }),
        ),
        (
            "onboarding welcome title",
            Method::PATCH,
            format!("/api/v1/guilds/{guild_id}/onboarding"),
            json!({ "welcome_title": MARKUP }),
        ),
        (
            "onboarding role prompt",
            Method::PATCH,
            format!("/api/v1/guilds/{guild_id}/onboarding"),
            json!({ "role_prompt": MARKUP }),
        ),
    ];

    for (label, method, path, body) in probes {
        let (status, payload) = ctx.call(method, &path, Some(body)).await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{label}: {payload}");
        assert!(
            message(&payload).contains("unsafe markup"),
            "{label} rejected for the wrong reason: {payload}"
        );
    }

    // Prose keeps its angle brackets: a rules document that says "fewer than
    // <10 messages" is not an injection attempt.
    let (status, payload) = ctx
        .call(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/onboarding"),
            Some(json!({ "rules_text": "No posting if you have < 10 messages." })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "prose rules refused: {payload}");
    Ok(())
}
