//! Availability regressions: request bodies that used to be unbounded.
//!
//! Two shapes are covered here.
//!
//! * Uncapped id arrays whose validation loops issue one query per element
//!   (`attachment_ids`, `sticker_ids`, group-sender-key `envelopes`). A 2 MiB
//!   body of repeated ids was tens of thousands of sequential queries, each
//!   holding one of the connection pool's slots.
//! * Uncapped strings that are stored verbatim and then broadcast in
//!   `GUILD_UPDATE` to every session in the guild (`icon`, `hub_settings`,
//!   `bot_settings`), so one large PATCH cost its own size in transient egress
//!   allocation *per connected session*.
//!
//! The assertions deliberately match on the bound's own error text: an
//! over-long array is rejected by every other validator too (an unknown
//! attachment id 404s the same way), so only the message distinguishes "the cap
//! fired" from "the element lookup happened to fail".

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

struct TestContext {
    app: Router,
    db: paracord_db::DbPool,
    jwt_secret: String,
    token: String,
    _test_app: TestApp,
}

impl TestContext {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions::default()).await?;
        let token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "bounds",
            "BoundsPass123!",
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

    async fn request_json(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let request = build_json_request(method, path, body, Some(&self.token))?;
        dispatch_json(&self.app, request).await
    }

    async fn request_json_as(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        token: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let request = build_json_request(method, path, body, Some(token))?;
        dispatch_json(&self.app, request).await
    }

    async fn user_id(&self, token: &str) -> anyhow::Result<i64> {
        let (status, payload) = self
            .request_json_as(Method::GET, "/api/v1/users/@me", None, token)
            .await?;
        assert_eq!(status, StatusCode::OK, "fetch @me failed: {payload}");
        Ok(payload["id"]
            .as_str()
            .context("user id should be a string")?
            .parse::<i64>()?)
    }

    async fn create_guild(&self, name: &str) -> anyhow::Result<String> {
        let (status, payload) = self
            .request_json(
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": name, "icon": Value::Null })),
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

    async fn create_text_channel(&self, guild_id: &str, name: &str) -> anyhow::Result<String> {
        let (status, payload) = self
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
            "channel create failed: {payload}"
        );
        Ok(payload["id"]
            .as_str()
            .context("channel id should be a string")?
            .to_string())
    }
}

fn error_message(payload: &Value) -> String {
    payload["message"].as_str().unwrap_or_default().to_string()
}

// ── Uncapped id arrays ──────────────────────────────────────────────────────

#[tokio::test]
async fn send_message_caps_and_deduplicates_attachment_ids() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Attachment Bounds").await?;
    let channel_id = ctx.create_text_channel(&guild_id, "bounds").await?;
    let channel_id_num = channel_id.parse::<i64>()?;
    let uploader_id = ctx.user_id(&ctx.token).await?;

    // One real, attacker-owned attachment is all the original overload needed:
    // the array was not deduplicated, so the same id repeated ~95k times drove
    // ~95k sequential SELECTs on pooled connections.
    let attachment = paracord_db::attachments::create_attachment(
        &ctx.db,
        paracord_util::snowflake::generate(1),
        None,
        "bounds.png",
        Some("image/png"),
        16,
        "/api/v1/attachments/bounds",
        None,
        None,
        Some(uploader_id),
        Some(channel_id_num),
        Some(chrono::Utc::now() + chrono::Duration::minutes(30)),
        None,
    )
    .await?;
    let attachment_id = attachment.id.to_string();

    let over_cap: Vec<Value> = std::iter::repeat_n(json!(attachment_id), 11).collect();
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({ "content": "too many", "attachment_ids": over_cap })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "an over-long attachment_ids array must be rejected: {payload}"
    );
    assert!(
        error_message(&payload).contains("at most 10 attachments"),
        "rejection must come from the cap, not from a per-element lookup: {payload}"
    );

    // At the cap, and repeated: still accepted, and the repeats collapse to the
    // one attachment that actually exists.
    let at_cap: Vec<Value> = std::iter::repeat_n(json!(attachment_id), 10).collect();
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({ "content": "just enough", "attachment_ids": at_cap })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "a repeated id at the cap must still send: {payload}"
    );
    let message_id = payload["id"]
        .as_str()
        .context("message id should be a string")?
        .parse::<i64>()?;
    let linked = paracord_db::attachments::get_message_attachments(&ctx.db, message_id).await?;
    assert_eq!(
        linked.len(),
        1,
        "a repeated attachment id must link exactly once"
    );

    Ok(())
}

#[tokio::test]
async fn send_message_caps_sticker_ids() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Sticker Bounds").await?;
    let channel_id = ctx.create_text_channel(&guild_id, "stickers").await?;

    let over_cap: Vec<Value> = (1..=4).map(|n| json!(n.to_string())).collect();
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({ "content": "too many", "sticker_ids": over_cap })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "an over-long sticker_ids array must be rejected: {payload}"
    );
    assert!(
        error_message(&payload).contains("at most 3 stickers"),
        "rejection must come from the cap, not from a per-element lookup: {payload}"
    );

    Ok(())
}

#[tokio::test]
async fn group_sender_keys_caps_envelopes() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let caller_id = ctx.user_id(&ctx.token).await?;

    let recipient_token =
        create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "envelopepeer", "BoundsPass123!")
            .await?;
    let recipient_id = ctx.user_id(&recipient_token).await?;
    // Group DM creation requires a friend or shared-guild relationship.
    paracord_db::relationships::create_relationship(&ctx.db, caller_id, recipient_id, 1).await?;

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/users/@me/channels",
            Some(json!({
                "recipient_ids": [recipient_id.to_string()],
                "name": "Envelope Bounds",
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
        .context("group dm id should be a string")?
        .to_string();

    let envelope = json!({
        "recipient_id": recipient_id.to_string(),
        "ciphertext": "Y2lwaGVy",
        "header": Value::Null,
    });

    // Every element costs a membership SELECT *and* an upsert — a write — so an
    // uncapped array is a write amplifier for any DM participant.
    let over_cap: Vec<Value> = std::iter::repeat_n(envelope.clone(), 33).collect();
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/e2ee/sender-keys"),
            Some(json!({ "epoch": 1, "envelopes": over_cap })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "an over-long envelopes array must be rejected: {payload}"
    );
    assert!(
        error_message(&payload).contains("at most 32 envelopes"),
        "rejection must come from the cap, not from a per-element check: {payload}"
    );

    // A repeated recipient inside the cap still publishes, and the repeats
    // collapse into the single row the upsert would have left anyway.
    let within_cap: Vec<Value> = std::iter::repeat_n(envelope, 4).collect();
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/e2ee/sender-keys"),
            Some(json!({ "epoch": 1, "envelopes": within_cap })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "a repeated recipient within the cap must still publish: {payload}"
    );
    let pending = paracord_db::group_e2ee::list_pending_for_recipient(
        &ctx.db,
        channel_id.parse::<i64>()?,
        recipient_id,
        None,
    )
    .await?;
    assert_eq!(
        pending.len(),
        1,
        "a repeated recipient must produce exactly one sender-key row"
    );

    Ok(())
}

// ── Uncapped broadcast strings ──────────────────────────────────────────────

/// A `data:` URL of roughly `kib` kibibytes. `icon`/`icon_hash` legitimately
/// accepts an inline image, so the payload has to look like one.
fn data_url_of_size(kib: usize) -> String {
    format!("data:image/png;base64,{}", "A".repeat(kib * 1024))
}

#[tokio::test]
async fn update_guild_caps_icon_and_settings_blobs() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Broadcast Bounds").await?;

    // 512 KiB was verified to return 200 and be stored and echoed at full
    // length; the whole value is then copied per connected session by the
    // GUILD_UPDATE fan-out.
    let (status, payload) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}"),
            Some(json!({ "icon": data_url_of_size(512) })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "an over-long icon must be rejected before it is stored: {payload}"
    );
    assert!(
        error_message(&payload).contains("icon must be"),
        "rejection must name the icon bound: {payload}"
    );

    let (status, payload) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}"),
            Some(json!({ "hub_settings": { "blurb": "x".repeat(70 * 1024) } })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "an over-long hub_settings blob must be rejected: {payload}"
    );
    assert!(
        error_message(&payload).contains("hub_settings must be"),
        "rejection must name the hub_settings bound: {payload}"
    );

    let (status, payload) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}"),
            Some(json!({ "bot_settings": { "blurb": "x".repeat(70 * 1024) } })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "an over-long bot_settings blob must be rejected: {payload}"
    );
    assert!(
        error_message(&payload).contains("bot_settings must be"),
        "rejection must name the bot_settings bound: {payload}"
    );

    // The bound must still admit a real inline icon — that is why the column is
    // TEXT in the first place.
    let inline_icon = data_url_of_size(32);
    let (status, payload) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}"),
            Some(json!({ "icon": inline_icon, "hub_settings": { "blurb": "hello" } })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "a reasonable inline data: URL icon must still be accepted: {payload}"
    );
    assert_eq!(
        payload["icon_hash"].as_str().map(str::len),
        Some(inline_icon.len()),
        "the accepted icon must be stored verbatim: {payload}"
    );

    Ok(())
}

#[tokio::test]
async fn create_guild_caps_icon() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": "Oversized Icon", "icon": data_url_of_size(512) })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "guild creation must apply the same icon bound as the update path: {payload}"
    );
    assert!(
        error_message(&payload).contains("icon must be"),
        "rejection must name the icon bound: {payload}"
    );

    Ok(())
}
