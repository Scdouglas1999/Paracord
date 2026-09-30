//! `GET /api/v1/guilds/{guild_id}/channel-previews`: the newest message of each
//! channel the viewer can read, for the places panel's channel rows
//! (docs/glass-spec.md §3.1, docs/design/glass-plan.md §3, WP-G4).
//!
//! Runs on in-memory SQLite by default and on PostgreSQL when
//! `PARACORD_TEST_POSTGRES_URL` is set (the harness provisions a database).

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
use paracord_contracts::channel::ChannelPreview;
use paracord_models::permissions::Permissions;
use serde_json::{json, Value};

struct TestContext {
    app: Router,
    db: paracord_db::DbPool,
    jwt_secret: String,
    token: String,
    owner_id: i64,
    test_app: TestApp,
}

impl TestContext {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions::default()).await?;
        let token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "previewowner",
            "IntegrationPass123!",
        )
        .await?;
        let mut ctx = Self {
            app: test_app.app.clone(),
            db: test_app.db.clone(),
            jwt_secret: test_app.jwt_secret.clone(),
            token,
            owner_id: 0,
            test_app,
        };
        ctx.owner_id = ctx.user_id(&ctx.token).await?;
        Ok(ctx)
    }

    async fn request_as(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        token: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let request = build_json_request(method, path, body, Some(token))?;
        dispatch_json(&self.app, request).await
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        self.request_as(method, path, body, &self.token).await
    }

    async fn user_id(&self, token: &str) -> anyhow::Result<i64> {
        let (status, payload) = self
            .request_as(Method::GET, "/api/v1/users/@me", None, token)
            .await?;
        assert_eq!(status, StatusCode::OK, "fetch @me failed: {payload}");
        Ok(payload["id"].as_str().context("user id")?.parse::<i64>()?)
    }

    async fn stranger(&self, prefix: &str) -> anyhow::Result<(String, i64)> {
        let token =
            create_authenticated_user_token(&self.db, &self.jwt_secret, prefix, "MemberPass123!")
                .await?;
        let uid = self.user_id(&token).await?;
        Ok((token, uid))
    }

    async fn add_member(&self, prefix: &str, guild_id: &str) -> anyhow::Result<(String, i64)> {
        let guild_id = guild_id.parse::<i64>()?;
        let (token, uid) = self.stranger(prefix).await?;
        paracord_db::members::add_member(&self.db, uid, guild_id).await?;
        paracord_db::roles::add_member_role(&self.db, uid, guild_id, guild_id).await?;
        Ok((token, uid))
    }

    async fn create_guild(&self, name: &str) -> anyhow::Result<String> {
        let (status, payload) = self
            .request(
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": name, "icon": Value::Null })),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "guild create: {payload}");
        Ok(payload["id"].as_str().context("guild id")?.to_string())
    }

    async fn create_channel(
        &self,
        guild_id: &str,
        name: &str,
        channel_type: i64,
    ) -> anyhow::Result<String> {
        let (status, payload) = self
            .request(
                Method::POST,
                &format!("/api/v1/guilds/{guild_id}/channels"),
                Some(json!({
                    "name": name,
                    "channel_type": channel_type,
                    "parent_id": Value::Null,
                    "required_role_ids": Value::Null,
                })),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "channel create: {payload}");
        Ok(payload["id"].as_str().context("channel id")?.to_string())
    }

    async fn post_as(
        &self,
        token: &str,
        channel_id: &str,
        content: &str,
    ) -> anyhow::Result<String> {
        let (status, payload) = self
            .request_as(
                Method::POST,
                &format!("/api/v1/channels/{channel_id}/messages"),
                Some(json!({ "content": content })),
                token,
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "post: {payload}");
        Ok(payload["id"].as_str().context("message id")?.to_string())
    }

    async fn post(&self, channel_id: &str, content: &str) -> anyhow::Result<String> {
        self.post_as(&self.token, channel_id, content).await
    }

    /// Deny `deny` to @everyone (the role whose id is the guild id) in a channel.
    async fn deny_everyone(
        &self,
        guild_id: &str,
        channel_id: &str,
        deny: Permissions,
        affected_user: i64,
    ) -> anyhow::Result<()> {
        let guild_num = guild_id.parse::<i64>()?;
        paracord_db::channel_overwrites::upsert_channel_overwrite(
            &self.db,
            channel_id.parse::<i64>()?,
            guild_num,
            paracord_core::permissions::OVERWRITE_TARGET_ROLE,
            0,
            deny.bits(),
        )
        .await?;
        paracord_core::permissions::invalidate_user(
            &self.test_app.state.permission_cache,
            affected_user,
        )
        .await;
        Ok(())
    }

    async fn previews_as(&self, token: &str, guild_id: &str) -> anyhow::Result<Vec<Value>> {
        let (status, payload) = self
            .request_as(
                Method::GET,
                &format!("/api/v1/guilds/{guild_id}/channel-previews"),
                None,
                token,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "previews: {payload}");
        let list = payload.as_array().context("previews is a list")?.clone();
        // Every entry must satisfy the exported wire contract.
        for entry in &list {
            serde_json::from_value::<ChannelPreview>(entry.clone())
                .with_context(|| format!("preview breaks the contract: {entry}"))?;
        }
        Ok(list)
    }

    async fn previews(&self, guild_id: &str) -> anyhow::Result<Vec<Value>> {
        self.previews_as(&self.token, guild_id).await
    }
}

fn preview_for<'a>(list: &'a [Value], channel_id: &str) -> Option<&'a Value> {
    list.iter().find(|entry| entry["channel_id"] == channel_id)
}

fn channel_ids(list: &[Value]) -> Vec<String> {
    let mut ids: Vec<String> = list
        .iter()
        .filter_map(|entry| entry["channel_id"].as_str().map(str::to_string))
        .collect();
    ids.sort();
    ids
}

async fn attach(
    ctx: &TestContext,
    message_id: i64,
    filename: &str,
    content_type: &str,
) -> anyhow::Result<i64> {
    let id = paracord_util::snowflake::generate(1);
    paracord_db::attachments::create_attachment(
        &ctx.db,
        id,
        Some(message_id),
        filename,
        Some(content_type),
        128,
        &format!("/api/v1/attachments/{id}"),
        Some(640),
        Some(480),
        None,
        None,
        None,
        None,
    )
    .await?;
    Ok(id)
}

#[tokio::test]
async fn previews_carry_the_newest_message_of_each_text_like_channel() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Preview Guild").await?;
    let general = ctx.create_channel(&guild_id, "general", 0).await?;
    let lounge = ctx.create_channel(&guild_id, "lounge", 2).await?;
    let quiet = ctx.create_channel(&guild_id, "quiet", 0).await?;
    let category = ctx.create_channel(&guild_id, "Topics", 4).await?;
    let (member_token, member_id) = ctx.add_member("previewjeremy", &guild_id).await?;

    ctx.post(&general, "first").await?;
    let newest = ctx
        .post_as(
            &member_token,
            &general,
            "  @Sean is movie\n\nnight still on?  ",
        )
        .await?;
    let lounge_message = ctx.post(&lounge, "voice chat text").await?;

    let list = ctx.previews(&guild_id).await?;
    let mut expected = vec![general.clone(), lounge.clone()];
    expected.sort();
    assert_eq!(channel_ids(&list), expected, "{list:?}");
    assert!(preview_for(&list, &quiet).is_none(), "empty channel listed");
    assert!(preview_for(&list, &category).is_none(), "category listed");

    let row = preview_for(&list, &general).context("general preview")?;
    assert_eq!(row["message_id"], newest);
    assert_eq!(row["author_id"], member_id.to_string());
    assert_eq!(row["author_kind"], "user");
    // The harness suffixes usernames to keep them unique.
    assert!(
        row["author_name"]
            .as_str()
            .is_some_and(|name| name.starts_with("previewjeremy")),
        "{row}"
    );
    assert_eq!(row["content"], "@Sean is movie night still on?");
    assert_eq!(row["truncated"], false);
    assert_eq!(row["encrypted"], false);
    assert_eq!(row["media"], Value::Null);
    assert_eq!(row["attachment_count"], 0);
    assert_eq!(row["message_type"], 0);
    let created_at = row["created_at"].as_str().context("created_at")?;
    chrono::DateTime::parse_from_rfc3339(created_at)?;

    let row = preview_for(&list, &lounge).context("lounge preview")?;
    assert_eq!(row["message_id"], lounge_message);
    assert_eq!(row["author_id"], ctx.owner_id.to_string());

    // A member's guild nickname wins over the account name.
    sqlx::query("UPDATE members SET nick = $1 WHERE user_id = $2 AND guild_id = $3")
        .bind("Jeremy")
        .bind(member_id)
        .bind(guild_id.parse::<i64>()?)
        .execute(&ctx.db)
        .await?;
    let list = ctx.previews(&guild_id).await?;
    assert_eq!(
        preview_for(&list, &general).context("general")?["author_name"],
        "Jeremy"
    );
    Ok(())
}

#[tokio::test]
async fn long_text_is_cut_and_deleting_the_newest_falls_back() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Tail Guild").await?;
    let general = ctx.create_channel(&guild_id, "general", 0).await?;

    let older = ctx.post(&general, "the one before").await?;
    let long = format!("{} <#{general}> and more words after", "word ".repeat(40));
    let newest = ctx.post(&general, &long).await?;

    let list = ctx.previews(&guild_id).await?;
    let row = preview_for(&list, &general).context("general")?;
    assert_eq!(row["message_id"], newest);
    assert_eq!(row["truncated"], true);
    let content = row["content"].as_str().context("content")?;
    assert!(content.chars().count() <= 140, "{content}");
    assert!(content.ends_with('…'), "{content}");

    let (status, body) = ctx
        .request(
            Method::DELETE,
            &format!("/api/v1/channels/{general}/messages/{newest}"),
            None,
        )
        .await?;
    assert!(status.is_success(), "delete: {status} {body}");
    let list = ctx.previews(&guild_id).await?;
    let row = preview_for(&list, &general).context("general after delete")?;
    assert_eq!(row["message_id"], older);
    assert_eq!(row["content"], "the one before");
    Ok(())
}

#[tokio::test]
async fn channels_the_viewer_cannot_read_are_excluded() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Hidden Guild").await?;
    let general = ctx.create_channel(&guild_id, "general", 0).await?;
    let staff = ctx.create_channel(&guild_id, "staff", 0).await?;
    let no_history = ctx.create_channel(&guild_id, "drop-box", 0).await?;
    let (member_token, member_id) = ctx.add_member("hiddenviewer", &guild_id).await?;

    ctx.post(&general, "hello everyone").await?;
    ctx.post(&staff, "secret plans").await?;
    ctx.post(&no_history, "only for those present").await?;
    ctx.deny_everyone(&guild_id, &staff, Permissions::VIEW_CHANNEL, member_id)
        .await?;
    ctx.deny_everyone(
        &guild_id,
        &no_history,
        Permissions::READ_MESSAGE_HISTORY,
        member_id,
    )
    .await?;

    let member_view = ctx.previews_as(&member_token, &guild_id).await?;
    assert_eq!(channel_ids(&member_view), vec![general.clone()]);
    let text = serde_json::to_string(&member_view)?;
    assert!(!text.contains("secret plans"), "{text}");
    assert!(!text.contains("only for those present"), "{text}");

    // The owner can read all three.
    let owner_view = ctx.previews(&guild_id).await?;
    let mut all = vec![general, staff, no_history];
    all.sort();
    assert_eq!(channel_ids(&owner_view), all);

    // Someone outside the guild gets nothing.
    let (outsider, _) = ctx.stranger("previewoutsider").await?;
    let (status, body) = ctx
        .request_as(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/channel-previews"),
            None,
            &outsider,
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "outsider: {body}");
    Ok(())
}

#[tokio::test]
async fn a_media_only_message_leads_with_its_first_attachment() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Media Guild").await?;
    let photos = ctx.create_channel(&guild_id, "photos", 0).await?;
    let photos_id = photos.parse::<i64>()?;

    ctx.post(&photos, "earlier words").await?;
    let message_id = paracord_util::snowflake::generate(1);
    paracord_db::messages::create_message(
        &ctx.db,
        message_id,
        photos_id,
        ctx.owner_id,
        "",
        0,
        None,
    )
    .await?;
    let first = attach(&ctx, message_id, "sunset.png", "image/png").await?;
    attach(&ctx, message_id, "clip.webm", "video/webm").await?;

    let list = ctx.previews(&guild_id).await?;
    let row = preview_for(&list, &photos).context("photos")?;
    assert_eq!(row["message_id"], message_id.to_string());
    assert_eq!(row["content"], Value::Null);
    assert_eq!(row["attachment_count"], 2);
    assert_eq!(row["media"]["attachment_id"], first.to_string());
    assert_eq!(row["media"]["content_type"], "image/png");
    assert_eq!(row["media"]["filename"], "sunset.png");
    assert_eq!(row["media"]["width"], 640);
    assert_eq!(row["media"]["height"], 480);
    assert_eq!(row["has_sticker"], false);
    Ok(())
}

#[tokio::test]
async fn an_encrypted_message_shows_only_ids_and_time() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Sealed Guild").await?;
    let sealed = ctx.create_channel(&guild_id, "sealed", 0).await?;
    let sealed_id = sealed.parse::<i64>()?;

    let message_id = paracord_util::snowflake::generate(1);
    paracord_db::messages::create_message_with_meta(
        &ctx.db,
        message_id,
        sealed_id,
        ctx.owner_id,
        "c2VjcmV0IGNpcGhlcnRleHQ=",
        0,
        None,
        paracord_core::MESSAGE_FLAG_DM_E2EE,
        Some("aXYtbm9uY2U="),
        Some(r#"{"v":3}"#),
    )
    .await?;
    attach(&ctx, message_id, "opaque.bin", "application/octet-stream").await?;

    let list = ctx.previews(&guild_id).await?;
    let row = preview_for(&list, &sealed).context("sealed")?;
    assert_eq!(row["message_id"], message_id.to_string());
    assert_eq!(row["author_id"], ctx.owner_id.to_string());
    assert_eq!(row["encrypted"], true);
    assert_eq!(row["content"], Value::Null);
    assert_eq!(row["media"], Value::Null);
    assert!(row["created_at"].as_str().is_some_and(|s| !s.is_empty()));
    let text = row.to_string();
    assert!(!text.contains("c2VjcmV0"), "ciphertext leaked: {text}");
    assert!(!text.contains("opaque.bin"), "file name leaked: {text}");
    Ok(())
}

#[tokio::test]
async fn an_anonymous_author_stays_anonymous_to_members() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Anon Guild").await?;
    let confessions = ctx.create_channel(&guild_id, "confessions", 0).await?;
    let (ada_token, ada_id) = ctx.add_member("previewada", &guild_id).await?;
    let (ben_token, _) = ctx.add_member("previewben", &guild_id).await?;

    let (status, features) = ctx
        .request(
            Method::PATCH,
            &format!("/api/v1/channels/{confessions}/features"),
            Some(json!({ "anonymous_posting_enabled": true })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "features: {features}");
    ctx.post_as(&ada_token, &confessions, "it was me").await?;

    let ben_view = ctx.previews_as(&ben_token, &guild_id).await?;
    let row = preview_for(&ben_view, &confessions).context("confessions")?;
    assert_eq!(row["author_kind"], "anonymous");
    let author = row["author_id"].as_str().context("author id")?;
    assert!(author.starts_with("anon:"), "{row}");
    let text = row.to_string();
    assert!(!text.contains(&ada_id.to_string()), "{text}");
    assert!(!text.contains("previewada"), "{text}");
    assert!(row["author_name"]
        .as_str()
        .is_some_and(|name| !name.is_empty()));

    // The owner (MANAGE_MESSAGES) may unmask it, as in the message routes.
    let owner_view = ctx.previews(&guild_id).await?;
    let row = preview_for(&owner_view, &confessions).context("owner confessions")?;
    assert_eq!(row["author_kind"], "anonymous");
    assert_eq!(row["author_id"], ada_id.to_string());
    Ok(())
}
