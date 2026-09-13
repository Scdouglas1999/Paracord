//! A reply's target has to be a message the channel actually holds.
//!
//! `POST /api/v1/channels/{id}/messages` accepts a `referenced_message_id` and
//! writes it straight into the `messages.reference_id` column. It parsed the id
//! and stored it unread: any `i64` persisted as a reply target, including the
//! id of a message in a private channel of a guild the author is not in, and
//! the id of a message that never existed.
//!
//! The sibling route that stores the very same column — `POST
//! /api/v1/channels/{id}/scheduled-messages` — has always run both checks
//! ("referenced_message_id does not exist" / "must belong to this channel"), as
//! has the same handler's `attachment_ids` loop for its own ids. One of the two
//! ways to write a reply validated it and the other did not.
//!
//! Nothing leaked through the gap — the stored reply carries only the id, and a
//! reader who fetches the referenced message is still refused by the channel
//! permission check. What it produced was a row the product can never resolve:
//! every client renders such a reply with a quote that silently resolves to
//! nothing, which is the degradation the project's own rule forbids.
//!
//! The assertions match the bound's own error text so a 400 from some unrelated
//! validator cannot be mistaken for this one firing.

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
    _test_app: TestApp,
}

impl Ctx {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions::default()).await?;
        Ok(Self {
            app: test_app.app.clone(),
            _test_app: test_app,
        })
    }

    async fn token(&self, prefix: &str) -> anyhow::Result<String> {
        create_authenticated_user_token(
            &self._test_app.db,
            &self._test_app.jwt_secret,
            prefix,
            "ReferencePass123!",
        )
        .await
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        token: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let request = build_json_request(method, path, body, Some(token))?;
        dispatch_json(&self.app, request).await
    }

    /// A guild owned by `token`, plus one text channel in it.
    async fn space(&self, token: &str, name: &str) -> anyhow::Result<(String, String)> {
        let (status, guild) = self
            .call(
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": name, "icon": Value::Null })),
                token,
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "guild create failed: {guild}");
        let guild_id = guild["id"].as_str().context("guild id")?.to_string();

        let (status, channel) = self
            .call(
                Method::POST,
                &format!("/api/v1/guilds/{guild_id}/channels"),
                Some(json!({ "name": "general", "channel_type": 0 })),
                token,
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "channel create failed: {channel}"
        );
        let channel_id = channel["id"].as_str().context("channel id")?.to_string();
        Ok((guild_id, channel_id))
    }

    async fn send(
        &self,
        channel_id: &str,
        body: Value,
        token: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        self.call(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(body),
            token,
        )
        .await
    }
}

fn message(payload: &Value) -> String {
    payload["message"].as_str().unwrap_or_default().to_string()
}

#[tokio::test]
async fn reply_to_a_message_in_the_same_channel_is_accepted() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let token = ctx.token("replyowner").await?;
    let (_guild, channel) = ctx.space(&token, "Reply Bounds").await?;

    let (status, target) = ctx
        .send(&channel, json!({ "content": "the question" }), &token)
        .await?;
    assert_eq!(status, StatusCode::CREATED, "target send failed: {target}");
    let target_id = target["id"].as_str().context("message id")?.to_string();

    let (status, reply) = ctx
        .send(
            &channel,
            json!({ "content": "the answer", "referenced_message_id": target_id }),
            &token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "valid reply rejected: {reply}");
    assert_eq!(
        reply["reference_id"].as_str(),
        Some(target_id.as_str()),
        "the accepted reply should carry its target: {reply}"
    );
    Ok(())
}

#[tokio::test]
async fn reply_to_a_message_that_does_not_exist_is_rejected() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let token = ctx.token("ghostowner").await?;
    let (_guild, channel) = ctx.space(&token, "Ghost Bounds").await?;

    let (status, payload) = ctx
        .send(
            &channel,
            json!({ "content": "reply to nothing", "referenced_message_id": "1" }),
            &token,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{payload}");
    assert!(
        message(&payload).contains("does not exist"),
        "rejected for the wrong reason: {payload}"
    );
    Ok(())
}

#[tokio::test]
async fn reply_to_a_message_in_another_channel_is_rejected() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let token = ctx.token("crosschannel").await?;
    let (guild, channel) = ctx.space(&token, "Cross Channel").await?;

    let (status, other) = ctx
        .call(
            Method::POST,
            &format!("/api/v1/guilds/{guild}/channels"),
            Some(json!({ "name": "elsewhere", "channel_type": 0 })),
            &token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "{other}");
    let other_channel = other["id"].as_str().context("channel id")?.to_string();

    let (status, target) = ctx
        .send(&other_channel, json!({ "content": "over here" }), &token)
        .await?;
    assert_eq!(status, StatusCode::CREATED, "{target}");
    let target_id = target["id"].as_str().context("message id")?.to_string();

    let (status, payload) = ctx
        .send(
            &channel,
            json!({ "content": "quoting elsewhere", "referenced_message_id": target_id }),
            &token,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{payload}");
    assert!(
        message(&payload).contains("must belong to this channel"),
        "rejected for the wrong reason: {payload}"
    );
    Ok(())
}

/// The case that motivated the bound: the target is a message in a private
/// channel of a space the author has never joined. The id is guessable (it is a
/// snowflake echoed by every client that can see it), and before the check the
/// server stored it without ever loading the row.
#[tokio::test]
async fn reply_to_a_message_in_a_space_the_author_cannot_see_is_rejected() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let stranger = ctx.token("stranger").await?;
    let insider = ctx.token("insider").await?;

    let (_their_guild, their_channel) = ctx.space(&insider, "Private Vault").await?;
    let (status, secret) = ctx
        .send(&their_channel, json!({ "content": "the secret" }), &insider)
        .await?;
    assert_eq!(status, StatusCode::CREATED, "{secret}");
    let secret_id = secret["id"].as_str().context("message id")?.to_string();

    // Sanity: the stranger genuinely cannot read the target.
    let (status, _) = ctx
        .call(
            Method::GET,
            &format!("/api/v1/channels/{their_channel}/messages"),
            None,
            &stranger,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "the stranger should not be able to read the target channel"
    );

    let (_guild, own_channel) = ctx.space(&stranger, "Stranger Space").await?;
    let (status, payload) = ctx
        .send(
            &own_channel,
            json!({ "content": "quoting a secret", "referenced_message_id": secret_id }),
            &stranger,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{payload}");
    assert!(
        message(&payload).contains("must belong to this channel"),
        "rejected for the wrong reason: {payload}"
    );
    Ok(())
}
