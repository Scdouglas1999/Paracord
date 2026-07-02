mod common;

use anyhow::Context;
use axum::{
    body::Body,
    http::{Method, Request, StatusCode},
    Router,
};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use paracord_models::permissions::Permissions;
use serde_json::{json, Value};

// ── Shared test harness ──────────────────────────────────────────────────────

struct TestContext {
    app: Router,
    db: paracord_db::DbPool,
    jwt_secret: String,
    owner_token: String,
    _test_app: TestApp,
}

impl TestContext {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions::default()).await?;
        let owner_token = create_authenticated_user_token(
            &test_app.db,
            &test_app.jwt_secret,
            "owner",
            "OwnerPass123!",
        )
        .await?;
        Ok(Self {
            app: test_app.app.clone(),
            db: test_app.db.clone(),
            jwt_secret: test_app.jwt_secret.clone(),
            owner_token,
            _test_app: test_app,
        })
    }

    async fn request(
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
            .request(Method::GET, "/api/v1/users/@me", None, token)
            .await?;
        assert_eq!(status, StatusCode::OK, "fetch @me failed: {payload}");
        Ok(payload["id"]
            .as_str()
            .context("user id should be string")?
            .parse::<i64>()?)
    }

    async fn add_user(&self, prefix: &str) -> anyhow::Result<(String, i64)> {
        let token =
            create_authenticated_user_token(&self.db, &self.jwt_secret, prefix, "MemberPass123!")
                .await?;
        let uid = self.user_id(&token).await?;
        Ok((token, uid))
    }

    async fn create_guild(&self, name: &str) -> anyhow::Result<i64> {
        let (status, payload) = self
            .request(
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": name, "icon": Value::Null })),
                &self.owner_token,
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "create guild failed: {payload}"
        );
        Ok(payload["id"]
            .as_str()
            .context("guild id should be string")?
            .parse::<i64>()?)
    }

    async fn create_text_channel(&self, guild_id: i64, name: &str) -> anyhow::Result<String> {
        let (status, payload) = self
            .request(
                Method::POST,
                &format!("/api/v1/guilds/{guild_id}/channels"),
                Some(json!({
                    "name": name,
                    "channel_type": 0,
                    "parent_id": Value::Null,
                    "required_role_ids": Value::Null,
                })),
                &self.owner_token,
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "create channel failed: {payload}"
        );
        Ok(payload["id"]
            .as_str()
            .context("channel id should be string")?
            .to_string())
    }
}

struct BotApp {
    app_id: String,
}

async fn create_bot_app(
    ctx: &TestContext,
    name: &str,
    permissions: &str,
) -> anyhow::Result<BotApp> {
    let (status, payload) = ctx
        .request(
            Method::POST,
            "/api/v1/bots/applications",
            Some(json!({
                "name": name,
                "description": "Test bot",
                "permissions": permissions,
            })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create bot app failed: {payload}"
    );
    Ok(BotApp {
        app_id: payload["id"]
            .as_str()
            .context("app id should be string")?
            .to_string(),
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// (1) change_email clears email_verified
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn change_email_clears_email_verified() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let uid = ctx.user_id(&ctx.owner_token).await?;

    // Verify the current address, then change it to an unowned one.
    paracord_db::users::set_email_verified(&ctx.db, uid, true).await?;
    let before = paracord_db::users::get_user_by_id(&ctx.db, uid)
        .await?
        .context("user must exist")?;
    assert!(before.email_verified, "precondition: email is verified");

    let (status, payload) = ctx
        .request(
            Method::PUT,
            "/api/v1/users/@me/email",
            Some(json!({
                "current_password": "OwnerPass123!",
                "new_email": "unowned-address@example.com",
            })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "change_email failed: {payload}"
    );

    let after = paracord_db::users::get_user_by_id(&ctx.db, uid)
        .await?
        .context("user must exist")?;
    assert_eq!(after.email, "unowned-address@example.com");
    assert!(
        !after.email_verified,
        "email_verified must be cleared after change_email"
    );
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// (2) blocked user cannot send a friend request
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn blocked_user_cannot_send_friend_request() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let uid_a = ctx.user_id(&ctx.owner_token).await?;
    let (token_b, uid_b) = ctx.add_user("blocker").await?;

    // B blocks A.
    let (status, _) = ctx
        .request(
            Method::POST,
            "/api/v1/users/@me/relationships",
            Some(json!({ "user_id": uid_a.to_string(), "type": 2 })),
            &token_b,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "block should succeed");

    // A tries to friend B — must be refused, with no row created.
    let (status, _) = ctx
        .request(
            Method::POST,
            "/api/v1/users/@me/relationships",
            Some(json!({ "user_id": uid_b.to_string(), "type": 1 })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "blocked requester must not be able to send a friend request"
    );

    let created = paracord_db::relationships::get_relationship(&ctx.db, uid_a, uid_b).await?;
    assert!(
        created.is_none(),
        "no relationship row should be created for a blocked requester"
    );
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// (3) sending a block removes the reverse-direction pending/friend row
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn sending_block_removes_prior_relationship_row() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let uid_a = ctx.user_id(&ctx.owner_token).await?;
    let (token_b, uid_b) = ctx.add_user("friendly").await?;

    // B sends a friend request to A (stored as B -> A, type=4).
    let (status, _) = ctx
        .request(
            Method::POST,
            "/api/v1/users/@me/relationships",
            Some(json!({ "user_id": uid_a.to_string(), "type": 1 })),
            &token_b,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let pending = paracord_db::relationships::get_relationship(&ctx.db, uid_b, uid_a)
        .await?
        .context("B->A pending row should exist")?;
    assert_eq!(pending.rel_type, 4);

    // A blocks B — the reverse row (B -> A) must be dropped.
    let (status, _) = ctx
        .request(
            Method::POST,
            "/api/v1/users/@me/relationships",
            Some(json!({ "user_id": uid_b.to_string(), "type": 2 })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let reverse = paracord_db::relationships::get_relationship(&ctx.db, uid_b, uid_a).await?;
    assert!(
        reverse.is_none(),
        "block must remove the reverse-direction pending row"
    );
    let mine = paracord_db::relationships::get_relationship(&ctx.db, uid_a, uid_b)
        .await?
        .context("A->B block row should exist")?;
    assert_eq!(mine.rel_type, 2, "our direction should record the block");
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// (4) invalid rel_type is rejected
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn invalid_rel_type_is_rejected() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let (_token_b, uid_b) = ctx.add_user("target").await?;

    let (status, _) = ctx
        .request(
            Method::POST,
            "/api/v1/users/@me/relationships",
            Some(json!({ "user_id": uid_b.to_string(), "type": 99 })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "arbitrary rel_type must be rejected"
    );
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// (5) a blocked caller gets a minimal profile (no bio / mutual_friends)
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn blocked_caller_gets_minimal_profile() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let uid_a = ctx.user_id(&ctx.owner_token).await?;
    let (token_b, uid_b) = ctx.add_user("private").await?;

    // Give B a bio so we can assert it is omitted for a blocked caller.
    paracord_db::users::update_user(&ctx.db, uid_b, Some("Private B"), Some("secret bio"), None)
        .await?;

    // B blocks A.
    let (status, _) = ctx
        .request(
            Method::POST,
            "/api/v1/users/@me/relationships",
            Some(json!({ "user_id": uid_a.to_string(), "type": 2 })),
            &token_b,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // A views B's profile.
    let (status, payload) = ctx
        .request(
            Method::GET,
            &format!("/api/v1/users/{uid_b}/profile"),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "profile fetch should succeed: {payload}"
    );
    assert_eq!(
        payload["user"]["id"].as_str(),
        Some(uid_b.to_string().as_str())
    );
    assert!(
        payload["user"]["bio"].is_null(),
        "bio must be omitted for a blocked caller: {payload}"
    );
    assert_eq!(
        payload["mutual_friends"].as_array().map(|a| a.len()),
        Some(0),
        "mutual_friends must be empty for a blocked caller"
    );
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// (6) interaction followup is blocked after the bot is uninstalled
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn followup_blocked_after_uninstall() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    // VIEW_CHANNEL | SEND_MESSAGES = 3072
    let bot = create_bot_app(&ctx, "FollowupBot", "3072").await?;
    let guild_id = ctx.create_guild("FollowupGuild").await?;
    let channel_id = ctx.create_text_channel(guild_id, "chat").await?;

    // Install the bot and register a command, then invoke it to mint a token.
    let (status, _) = ctx
        .request(
            Method::POST,
            "/api/v1/oauth2/authorize",
            Some(json!({ "application_id": bot.app_id, "guild_id": guild_id.to_string() })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "authorize failed");

    let (status, _) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/applications/{}/commands", bot.app_id),
            Some(json!({ "name": "ping", "description": "ping" })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "create command failed");

    let (status, interaction) = ctx
        .request(
            Method::POST,
            "/api/v1/interactions",
            Some(json!({
                "command_name": "ping",
                "guild_id": guild_id.to_string(),
                "channel_id": channel_id,
                "type": 2,
                "options": [],
            })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "invoke failed: {interaction}");
    let interaction_token = interaction["token"]
        .as_str()
        .context("interaction token")?
        .to_string();

    // Uninstall the bot.
    let (status, _) = ctx
        .request(
            Method::DELETE,
            &format!("/api/v1/guilds/{guild_id}/bots/{}", bot.app_id),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "uninstall failed");

    // Followup must now be forbidden.
    let request = build_json_request(
        Method::POST,
        &format!(
            "/api/v1/interactions/{}/{}/followup",
            bot.app_id, interaction_token
        ),
        Some(json!({ "content": "late followup" })),
        None,
    )?;
    let (status, payload) = dispatch_json(&ctx.app, request).await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "followup must be forbidden after uninstall: {payload}"
    );
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// (7) GitHub webhook without a configured secret is rejected (fail-closed)
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn github_webhook_without_secret_rejected() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("HookGuild").await?;
    let _channel_id = ctx.create_text_channel(guild_id, "hooks").await?;

    let (status, webhook) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/webhooks"),
            Some(json!({ "name": "gh" })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create webhook failed: {webhook}"
    );
    let webhook_id = webhook["id"].as_str().context("webhook id")?.to_string();
    let token = webhook["token"]
        .as_str()
        .context("webhook token")?
        .to_string();

    let payload = json!({
        "pusher": { "name": "octocat" },
        "ref": "refs/heads/main",
        "repository": { "full_name": "octocat/hello" },
        "commits": [],
    });
    let request = Request::builder()
        .method(Method::POST)
        .uri(format!("/api/v1/webhooks/{webhook_id}/{token}"))
        .header("content-type", "application/json")
        .header("X-GitHub-Event", "push")
        .body(Body::from(payload.to_string()))?;
    let (status, body) = dispatch_json(&ctx.app, request).await?;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "GitHub event without github_secret must be rejected: {body}"
    );
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// (8) webhook auth succeeds with the issued token and fails with a wrong one
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn webhook_auth_requires_correct_token() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("ExecGuild").await?;
    let _channel_id = ctx.create_text_channel(guild_id, "exec").await?;

    let (status, webhook) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/webhooks"),
            Some(json!({ "name": "exec" })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create webhook failed: {webhook}"
    );
    let webhook_id = webhook["id"].as_str().context("webhook id")?.to_string();
    let token = webhook["token"]
        .as_str()
        .context("webhook token")?
        .to_string();

    // Correct token authenticates.
    let request = build_json_request(
        Method::POST,
        &format!("/api/v1/webhooks/{webhook_id}/{token}"),
        Some(json!({ "content": "hello from webhook" })),
        None,
    )?;
    let (status, body) = dispatch_json(&ctx.app, request).await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "correct token should authenticate: {body}"
    );

    // A wrong token is rejected.
    let request = build_json_request(
        Method::POST,
        &format!("/api/v1/webhooks/{webhook_id}/{}", "deadbeef".repeat(8)),
        Some(json!({ "content": "should not post" })),
        None,
    )?;
    let (status, _) = dispatch_json(&ctx.app, request).await?;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "wrong token must be rejected"
    );
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// (9) oauth2_authorize caps granted permissions to the authorizer's own perms
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn oauth2_authorize_caps_permissions_to_authorizer() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("CapGuild").await?;

    // A non-owner "manager" with MANAGE_GUILD | SEND_MESSAGES but NOT BAN_MEMBERS.
    let manager_perms = Permissions::MANAGE_GUILD | Permissions::SEND_MESSAGES;
    let (status, role) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/roles"),
            Some(json!({ "name": "Manager", "permissions": manager_perms.bits() })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "create role failed: {role}");
    let role_id: i64 = role["id"].as_str().context("role id")?.parse()?;

    let (manager_token, manager_uid) = ctx.add_user("manager").await?;
    paracord_db::members::add_member(&ctx.db, manager_uid, guild_id).await?;
    paracord_db::roles::add_member_role(&ctx.db, manager_uid, guild_id, role_id).await?;

    // A bot whose default (and requested) permissions include BAN_MEMBERS.
    let requested =
        Permissions::MANAGE_GUILD | Permissions::SEND_MESSAGES | Permissions::BAN_MEMBERS;
    let bot = create_bot_app(&ctx, "CapBot", &requested.bits().to_string()).await?;

    let (status, payload) = ctx
        .request(
            Method::POST,
            "/api/v1/oauth2/authorize",
            Some(json!({
                "application_id": bot.app_id,
                "guild_id": guild_id.to_string(),
                "permissions": requested.bits().to_string(),
            })),
            &manager_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "authorize failed: {payload}");

    let granted: i64 = payload["permissions"]
        .as_str()
        .context("permissions string")?
        .parse()?;
    assert_eq!(
        granted,
        manager_perms.bits(),
        "granted permissions must be capped to the authorizer's own guild permissions (BAN_MEMBERS dropped)"
    );
    assert_eq!(
        granted & Permissions::BAN_MEMBERS.bits(),
        0,
        "BAN_MEMBERS must not be granted since the authorizer lacks it"
    );
    Ok(())
}
