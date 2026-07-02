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
        let test_app = build_test_app(TestAppOptions {
            install_http_rate_limiter: true,
            ..Default::default()
        })
        .await?;
        let token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "integration",
            "IntegrationPass123!",
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

    /// Dispatch a request authenticated as an arbitrary token (used for
    /// non-owner members in the permission tests below).
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

    /// Resolve the numeric user id backing an auth token.
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

    /// Create an additional authenticated user and join them to `guild_id` with
    /// the default Member role. Returns their (token, user_id).
    async fn add_member(&self, prefix: &str, guild_id: i64) -> anyhow::Result<(String, i64)> {
        let token =
            create_authenticated_user_token(&self.db, &self.jwt_secret, prefix, "MemberPass123!")
                .await?;
        let uid = self.user_id(&token).await?;
        paracord_db::members::add_member(&self.db, uid, guild_id).await?;
        // Grant the default Member role (role id == guild id) so the member has
        // the normal baseline permissions (SEND_MESSAGES, ADD_REACTIONS, ...).
        paracord_db::roles::add_member_role(&self.db, uid, guild_id, guild_id).await?;
        Ok((token, uid))
    }
}

fn guild_id_i64(guild_id: &str) -> anyhow::Result<i64> {
    Ok(guild_id.parse::<i64>()?)
}

async fn create_guild(ctx: &TestContext, name: &str) -> anyhow::Result<String> {
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": name, "icon": Value::Null })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    Ok(payload["id"]
        .as_str()
        .context("guild id should be a string")?
        .to_string())
}

async fn create_text_channel(
    ctx: &TestContext,
    guild_id: &str,
    name: &str,
) -> anyhow::Result<String> {
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
    assert_eq!(status, StatusCode::CREATED);
    Ok(payload["id"]
        .as_str()
        .context("channel id should be a string")?
        .to_string())
}

#[tokio::test]
async fn create_guild_channel_send_message_flow_works_end_to_end() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Flow Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "flow-chat").await?;

    let (status, message) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({ "content": "integration hello world" })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    let message_id = message["id"]
        .as_str()
        .context("message id should be a string")?
        .to_string();

    let (status, messages) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/messages"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected response payload: {messages}"
    );
    let list = messages
        .as_array()
        .context("messages list should be an array")?;
    assert!(list
        .iter()
        .any(|m| m.get("id").and_then(Value::as_str) == Some(message_id.as_str())));

    Ok(())
}

#[tokio::test]
async fn channel_crud_routes_work() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Channel CRUD Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "general").await?;

    let (status, channel) = ctx
        .request_json(Method::GET, &format!("/api/v1/channels/{channel_id}"), None)
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(channel["id"], channel_id);
    assert_eq!(channel["name"], "general");

    let (status, updated) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/channels/{channel_id}"),
            Some(json!({
                "name": "renamed-general",
                "topic": "Updated integration topic",
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["name"], "renamed-general");
    assert_eq!(updated["topic"], "Updated integration topic");

    let (status, _) = ctx
        .request_json(
            Method::DELETE,
            &format!("/api/v1/channels/{channel_id}"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _) = ctx
        .request_json(Method::GET, &format!("/api/v1/channels/{channel_id}"), None)
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);

    Ok(())
}

#[tokio::test]
async fn message_crud_routes_work() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Message CRUD Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "chat").await?;

    let (status, created) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({ "content": "original body" })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    let message_id = created["id"]
        .as_str()
        .context("message id should be a string")?
        .to_string();

    let (status, edited) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/channels/{channel_id}/messages/{message_id}"),
            Some(json!({ "content": "edited body" })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "unexpected PATCH payload: {edited}");
    assert_eq!(edited["content"], "edited body");

    let (status, messages) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/messages"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let list = messages
        .as_array()
        .context("messages list should be an array")?;
    assert!(list
        .iter()
        .any(|m| m.get("id").and_then(Value::as_str) == Some(message_id.as_str())));

    let (status, _) = ctx
        .request_json(
            Method::DELETE,
            &format!("/api/v1/channels/{channel_id}/messages/{message_id}"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, messages_after_delete) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/messages"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let list_after_delete = messages_after_delete
        .as_array()
        .context("messages list should be an array")?;
    assert!(!list_after_delete
        .iter()
        .any(|m| m.get("id").and_then(Value::as_str) == Some(message_id.as_str())));

    Ok(())
}

#[tokio::test]
async fn message_list_page_shape_with_reactions_is_stable() -> anyhow::Result<()> {
    // Regression test for the batched message serialization path: a multi-message
    // page with reactions must still expose the full author / attachments /
    // reactions JSON shape, and the per-viewer `me` flag must be correct.
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Batch Shape Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "batch-chat").await?;

    // Send several messages so the page exercises the batch path (not a
    // single-message fast path).
    let mut message_ids = Vec::new();
    for i in 0..5 {
        let (status, created) = ctx
            .request_json(
                Method::POST,
                &format!("/api/v1/channels/{channel_id}/messages"),
                Some(json!({ "content": format!("batch message {i}") })),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED);
        message_ids.push(
            created["id"]
                .as_str()
                .context("message id should be a string")?
                .to_string(),
        );
    }

    // React to the first message with two emoji, and the second with one.
    let first = &message_ids[0];
    let second = &message_ids[1];
    for (message_id, emoji) in [(first, "thumbsup"), (first, "heart"), (second, "thumbsup")] {
        let (status, _) = ctx
            .request_json(
                Method::PUT,
                &format!(
                    "/api/v1/channels/{channel_id}/messages/{message_id}/reactions/{emoji}/@me"
                ),
                None,
            )
            .await?;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    let (status, messages) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/messages"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected list payload: {messages}"
    );
    let list = messages
        .as_array()
        .context("messages list should be an array")?;
    assert_eq!(list.len(), 5, "expected all five messages on the page");

    let find = |id: &str| -> &Value {
        list.iter()
            .find(|m| m.get("id").and_then(Value::as_str) == Some(id))
            .unwrap_or_else(|| panic!("message {id} missing from page"))
    };

    // Every message carries the full stable shape.
    for msg in list {
        let author = msg.get("author").context("author field present")?;
        assert!(author.get("id").and_then(Value::as_str).is_some());
        assert!(author.get("username").and_then(Value::as_str).is_some());
        assert!(author.get("discriminator").is_some());
        assert!(author.get("bot").and_then(Value::as_bool).is_some());
        assert!(msg.get("attachments").and_then(Value::as_array).is_some());
        assert!(msg.get("stickers").and_then(Value::as_array).is_some());
        assert!(msg.get("reactions").and_then(Value::as_array).is_some());
        assert!(msg.get("embeds").and_then(Value::as_array).is_some());
        assert!(msg.get("components").and_then(Value::as_array).is_some());
        assert_eq!(
            msg.get("channel_id").and_then(Value::as_str),
            Some(channel_id.as_str())
        );
    }

    // First message: two reactions, both authored by the viewer => me == true.
    let first_reactions = find(first)
        .get("reactions")
        .and_then(Value::as_array)
        .context("first message reactions array")?;
    assert_eq!(first_reactions.len(), 2);
    // Both reactions belong to the viewer and each has a single reactor. Ordering
    // is by earliest reaction (`MIN(created_at)`); the two were added within the
    // same second so we assert on the set rather than a tie-broken order.
    let mut first_emojis: Vec<&str> = first_reactions
        .iter()
        .map(|r| r["emoji"].as_str().unwrap_or_default())
        .collect();
    first_emojis.sort_unstable();
    assert_eq!(first_emojis, vec!["heart", "thumbsup"]);
    for reaction in first_reactions {
        assert_eq!(reaction["count"], json!(1));
        assert_eq!(reaction["me"], json!(true));
    }

    // Second message: one reaction with me == true.
    let second_reactions = find(second)
        .get("reactions")
        .and_then(Value::as_array)
        .context("second message reactions array")?;
    assert_eq!(second_reactions.len(), 1);
    assert_eq!(second_reactions[0]["emoji"], "thumbsup");
    assert_eq!(second_reactions[0]["count"], json!(1));
    assert_eq!(second_reactions[0]["me"], json!(true));

    // Remaining messages have no reactions.
    for id in &message_ids[2..] {
        let reactions = find(id)
            .get("reactions")
            .and_then(Value::as_array)
            .context("reactions array present")?;
        assert!(reactions.is_empty());
    }

    Ok(())
}

#[tokio::test]
async fn thread_routes_work() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Thread Routes Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "thread-parent").await?;

    let (status, created_thread) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/threads"),
            Some(json!({
                "name": "first-thread",
                "auto_archive_duration": 1440
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "unexpected thread payload: {created_thread}"
    );
    let thread_id = created_thread["id"]
        .as_str()
        .context("thread id should be a string")?
        .to_string();
    assert_eq!(created_thread["parent_id"], channel_id);
    assert!(created_thread["owner_id"].is_string());

    let (status, threads) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/threads"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let active_threads = threads
        .as_array()
        .context("threads response should be an array")?;
    assert!(active_threads
        .iter()
        .any(|thread| thread.get("id").and_then(Value::as_str) == Some(thread_id.as_str())));

    let (status, archived) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/channels/{channel_id}/threads/{thread_id}"),
            Some(json!({ "archived": true })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected archived payload: {archived}"
    );
    assert_eq!(archived["id"], thread_id);

    let (status, archived_threads) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/threads/archived"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let archived_list = archived_threads
        .as_array()
        .context("archived threads response should be an array")?;
    assert!(archived_list
        .iter()
        .any(|thread| thread.get("id").and_then(Value::as_str) == Some(thread_id.as_str())));

    let (status, _) = ctx
        .request_json(
            Method::DELETE,
            &format!("/api/v1/channels/{channel_id}/threads/{thread_id}"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    Ok(())
}

#[tokio::test]
async fn mass_mention_without_permission_does_not_increment_mention_counts() -> anyhow::Result<()> {
    // A member with only the default Member role lacks MENTION_EVERYONE, so an
    // `@everyone` in their message must be delivered as plain text without fanning
    // out mention counts to every other member.
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Mass Mention Guild").await?;
    let guild_id_num = guild_id_i64(&guild_id)?;
    let channel_id = create_text_channel(&ctx, &guild_id, "no-mention-spam").await?;

    let (sender_token, _sender_uid) = ctx.add_member("massmention", guild_id_num).await?;
    let (_recipient_token, recipient_uid) = ctx.add_member("recipient", guild_id_num).await?;

    let (status, message) = ctx
        .request_json_as(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({ "content": "@everyone please read this" })),
            &sender_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "message should still be delivered: {message}"
    );
    // Text is preserved verbatim; only the side effect is suppressed.
    assert_eq!(message["content"], "@everyone please read this");

    let channel_id_num = channel_id.parse::<i64>()?;
    let recipient_state =
        paracord_db::read_states::get_read_state(&ctx.db, recipient_uid, channel_id_num).await?;
    let mention_count = recipient_state.map(|s| s.mention_count).unwrap_or(0);
    assert_eq!(
        mention_count, 0,
        "member without MENTION_EVERYONE must not trigger a mass-mention fan-out"
    );

    // Sanity check the gate is not simply suppressing everything: the guild owner
    // (who holds MENTION_EVERYONE via the ADMINISTRATOR/owner bypass) DOES fan out.
    let (status, _) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({ "content": "@everyone from the owner" })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    let recipient_state_after =
        paracord_db::read_states::get_read_state(&ctx.db, recipient_uid, channel_id_num).await?;
    assert_eq!(
        recipient_state_after.map(|s| s.mention_count).unwrap_or(0),
        1,
        "owner with MENTION_EVERYONE should fan out the mass mention"
    );

    Ok(())
}

#[tokio::test]
async fn add_reaction_without_add_reactions_permission_is_forbidden() -> anyhow::Result<()> {
    use paracord_core::permissions::OVERWRITE_TARGET_MEMBER;
    use paracord_models::permissions::Permissions;

    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Reaction Perm Guild").await?;
    let guild_id_num = guild_id_i64(&guild_id)?;
    let channel_id = create_text_channel(&ctx, &guild_id, "react-gated").await?;
    let channel_id_num = channel_id.parse::<i64>()?;

    // Owner posts a message that the member will try to react to.
    let (status, message) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({ "content": "react to me" })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    let message_id = message["id"]
        .as_str()
        .context("message id should be a string")?
        .to_string();

    let (member_token, member_uid) = ctx.add_member("reactor", guild_id_num).await?;

    // Deny ADD_REACTIONS for this member on this channel while leaving
    // VIEW_CHANNEL / READ_MESSAGE_HISTORY intact.
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &ctx.db,
        channel_id_num,
        member_uid,
        OVERWRITE_TARGET_MEMBER,
        0,
        Permissions::ADD_REACTIONS.bits(),
    )
    .await?;

    let (status, payload) = ctx
        .request_json_as(
            Method::PUT,
            &format!("/api/v1/channels/{channel_id}/messages/{message_id}/reactions/thumbsup/@me"),
            None,
            &member_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "member without ADD_REACTIONS must be forbidden: {payload}"
    );

    Ok(())
}

#[tokio::test]
async fn moderator_edit_emits_edited_mod_log_entry() -> anyhow::Result<()> {
    // A moderator edit must produce a mod-log entry labelled as an edit, not a
    // (copy-pasted) deletion.
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Mod Log Edit Guild").await?;
    let guild_id_num = guild_id_i64(&guild_id)?;
    let channel_id = create_text_channel(&ctx, &guild_id, "chat").await?;
    let mod_log_channel_id = create_text_channel(&ctx, &guild_id, "mod-log").await?;

    // Point the guild's mod-log at the dedicated channel.
    paracord_db::guilds::update_guild(
        &ctx.db,
        guild_id_num,
        None,
        None,
        None,
        None,
        Some(&json!({ "mod_log_channel_id": mod_log_channel_id }).to_string()),
    )
    .await?;

    let (status, created) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/messages"),
            Some(json!({ "content": "before edit" })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    let message_id = created["id"]
        .as_str()
        .context("message id should be a string")?
        .to_string();

    let (status, edited) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/channels/{channel_id}/messages/{message_id}"),
            Some(json!({ "content": "after edit" })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "unexpected edit payload: {edited}");

    let (status, mod_log_messages) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{mod_log_channel_id}/messages"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let entries = mod_log_messages
        .as_array()
        .context("mod-log messages should be an array")?;
    let content_blob: String = entries
        .iter()
        .filter_map(|m| m.get("content").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        content_blob.contains("Message Edited"),
        "mod-log should record an edit, got: {content_blob}"
    );
    assert!(
        !content_blob.contains("Message Deleted"),
        "mod-log must not mislabel an edit as a deletion, got: {content_blob}"
    );

    Ok(())
}

#[tokio::test]
async fn create_thread_accepts_100_char_multibyte_name() -> anyhow::Result<()> {
    // A 100-character name made of multibyte code points is 300 bytes; the length
    // bound is in characters, not bytes, so it must be accepted.
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "Thread Name Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "thread-parent").await?;

    let name: String = "\u{4f60}".repeat(100); // 100 '你' characters == 300 bytes
    assert_eq!(name.chars().count(), 100);
    assert_eq!(name.len(), 300);

    let (status, created_thread) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/channels/{channel_id}/threads"),
            Some(json!({ "name": name, "auto_archive_duration": 1440 })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "100-char multibyte thread name must be accepted: {created_thread}"
    );

    Ok(())
}
