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
            "integration",
            "IntegrationPass123!",
        )
        .await?;

        Ok(Self {
            app: test_app.app.clone(),
            token,
            db: test_app.db.clone(),
            _test_app: test_app,
        })
    }

    /// Send an authenticated request using the default user token.
    async fn request_json(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        self.request_json_with_token(method, path, body, &self.token)
            .await
    }

    /// Send an authenticated request with a custom auth token.
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

    /// Send a request with no auth header (for public endpoints / token-based auth).
    async fn request_json_no_auth(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let request = build_json_request(method, path, body, None)?;
        dispatch_json(&self.app, request).await
    }
}

async fn create_guild(ctx: &TestContext, name: &str) -> anyhow::Result<String> {
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": name, "icon": Value::Null })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create guild failed: {payload}"
    );
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
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create channel failed: {payload}"
    );
    Ok(payload["id"]
        .as_str()
        .context("channel id should be a string")?
        .to_string())
}

// ── Bot-specific helpers ────────────────────────────────────────────────────

struct BotAppInfo {
    json: Value,
    token: String,
    app_id: String,
    bot_user_id: String,
}

async fn create_bot_application_with_permissions(
    ctx: &TestContext,
    name: &str,
    permissions: Option<&str>,
) -> anyhow::Result<BotAppInfo> {
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/bots/applications",
            Some(json!({
                "name": name,
                "description": "Test bot application",
                "permissions": permissions,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create bot app failed: {payload}"
    );
    let app_id = payload["id"]
        .as_str()
        .context("app id should be a string")?
        .to_string();
    let bot_user_id = payload["bot_user_id"]
        .as_str()
        .context("bot_user_id should be a string")?
        .to_string();
    let token = payload["token"]
        .as_str()
        .context("token should be a string")?
        .to_string();
    Ok(BotAppInfo {
        json: payload,
        token,
        app_id,
        bot_user_id,
    })
}

async fn create_bot_application(ctx: &TestContext, name: &str) -> anyhow::Result<BotAppInfo> {
    // Grant minimal channel permissions needed for interaction response tests.
    // VIEW_CHANNEL (1<<10) | SEND_MESSAGES (1<<11) = 3072
    create_bot_application_with_permissions(ctx, name, Some("3072")).await
}

async fn authorize_bot_in_guild(
    ctx: &TestContext,
    app_id: &str,
    guild_id: &str,
) -> anyhow::Result<Value> {
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/oauth2/authorize",
            Some(json!({
                "application_id": app_id,
                "guild_id": guild_id,
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "oauth2 authorize failed: {payload}");
    Ok(payload)
}

async fn create_global_command(
    ctx: &TestContext,
    app_id: &str,
    name: &str,
    description: &str,
) -> anyhow::Result<(Value, String)> {
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/applications/{app_id}/commands"),
            Some(json!({
                "name": name,
                "description": description,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create global command failed: {payload}"
    );
    let cmd_id = payload["id"]
        .as_str()
        .context("command id should be a string")?
        .to_string();
    Ok((payload, cmd_id))
}

async fn create_guild_command(
    ctx: &TestContext,
    app_id: &str,
    guild_id: &str,
    name: &str,
    description: &str,
) -> anyhow::Result<(Value, String)> {
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/applications/{app_id}/guilds/{guild_id}/commands"),
            Some(json!({
                "name": name,
                "description": description,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create guild command failed: {payload}"
    );
    let cmd_id = payload["id"]
        .as_str()
        .context("command id should be a string")?
        .to_string();
    Ok((payload, cmd_id))
}

async fn invoke_slash_command(
    ctx: &TestContext,
    command_name: &str,
    guild_id: &str,
    channel_id: &str,
) -> anyhow::Result<(Value, String)> {
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/interactions",
            Some(json!({
                "command_name": command_name,
                "guild_id": guild_id,
                "channel_id": channel_id,
                "type": 2,
                "options": [],
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "invoke slash command failed: {payload}"
    );
    let token = payload["token"]
        .as_str()
        .context("interaction token should be a string")?
        .to_string();
    Ok((payload, token))
}

async fn interaction_callback(
    ctx: &TestContext,
    interaction_id: &str,
    token: &str,
    callback_type: u8,
    data: Option<Value>,
) -> anyhow::Result<(StatusCode, Value)> {
    let body = if let Some(data) = data {
        json!({ "type": callback_type, "data": data })
    } else {
        json!({ "type": callback_type })
    };
    ctx.request_json_no_auth(
        Method::POST,
        &format!("/api/v1/interactions/{interaction_id}/{token}/callback"),
        Some(body),
    )
    .await
}

// ═══════════════════════════════════════════════════════════════════════════
// Group 1: Bot Application Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

#[allow(dead_code)]
async fn _debug_create_bot_app_steps_disabled() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;

    // Step 1: call the API and print full response
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/bots/applications",
            Some(json!({
                "name": "DebugBot",
                "description": "Debug bot",
            })),
        )
        .await?;
    eprintln!("create_bot_application status={status} payload={payload}");

    // Step 2: manually try the DB steps that the handler does
    let app_id = paracord_util::snowflake::generate(1);
    let bot_user_id = paracord_util::snowflake::generate(1);
    let bot_username = format!("bot-{}", app_id);
    let bot_email = format!("bot-{}@bots.paracord.local", bot_user_id);
    let discriminator = ((bot_user_id % 9000) + 1000) as i16;

    eprintln!("bot_username={bot_username} bot_email={bot_email} discriminator={discriminator}");

    let bot_password_hash = paracord_core::auth::hash_password("dummy_token_12345")
        .map_err(|e| anyhow::anyhow!("hash_password failed: {e}"))?;
    eprintln!("hash_password succeeded, len={}", bot_password_hash.len());

    let bot_user_result = paracord_db::users::create_user(
        &ctx.db,
        bot_user_id,
        &bot_username,
        discriminator,
        &bot_email,
        &bot_password_hash,
    )
    .await;
    match &bot_user_result {
        Ok(u) => eprintln!("create_user succeeded: id={}", u.id),
        Err(e) => eprintln!("create_user FAILED: {e:?}"),
    }
    let _bot_user = bot_user_result?;

    let token_hash = paracord_db::bot_applications::hash_token("test_token_value");
    eprintln!("token_hash len={}", token_hash.len());

    // The authenticated user_id - we need to find it
    // Let's just use a user from the DB
    let all_users: Vec<(i64,)> = sqlx::query_as("SELECT id FROM users ORDER BY id LIMIT 2")
        .fetch_all(&ctx.db)
        .await?;
    eprintln!("users in DB: {:?}", all_users);
    let owner_id = all_users[0].0;

    let app_result = paracord_db::bot_applications::create_bot_application(
        &ctx.db,
        app_id,
        "ManualBot",
        Some("Manual test"),
        owner_id,
        bot_user_id,
        &token_hash,
        None,
        0,
    )
    .await;
    match &app_result {
        Ok(a) => eprintln!("create_bot_application succeeded: id={}", a.id),
        Err(e) => eprintln!("create_bot_application FAILED: {e:?}"),
    }

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Group 1: Bot Application Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn create_bot_application_returns_token_and_user() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "TestBot").await?;

    // Verify all expected fields
    assert!(!bot.token.is_empty(), "token should not be empty");
    assert!(!bot.app_id.is_empty(), "app_id should not be empty");
    assert!(
        !bot.bot_user_id.is_empty(),
        "bot_user_id should not be empty"
    );
    assert_eq!(bot.json["name"], "TestBot");
    assert!(bot.json.get("scopes").is_some(), "should have scopes field");
    assert!(
        bot.json.get("intents").is_some(),
        "should have intents field"
    );
    assert!(
        bot.json.get("public_listed").is_some(),
        "should have public_listed field"
    );
    assert!(
        bot.json.get("category").is_some(),
        "should have category field"
    );
    assert!(bot.json.get("tags").is_some(), "should have tags field");
    assert!(
        bot.json.get("icon_hash").is_some(),
        "should have icon_hash field"
    );
    assert!(
        bot.json.get("install_count").is_some(),
        "should have install_count field"
    );
    assert_eq!(bot.json["install_count"], 0);

    Ok(())
}

#[tokio::test]
async fn list_and_get_bot_application() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "ListBot").await?;

    // List all applications for the user
    let (status, list) = ctx
        .request_json(Method::GET, "/api/v1/bots/applications", None)
        .await?;
    assert_eq!(status, StatusCode::OK, "list failed: {list}");
    let apps = list.as_array().context("should be an array")?;
    assert!(
        apps.iter().any(|a| a["id"].as_str() == Some(&bot.app_id)),
        "created bot should appear in list"
    );

    // Get by ID
    let (status, got) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/bots/applications/{}", bot.app_id),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "get failed: {got}");
    assert_eq!(got["id"], bot.app_id);
    assert_eq!(got["name"], "ListBot");
    // Token should NOT be returned on GET (only on create/regenerate)
    assert!(got.get("token").is_none() || got["token"].is_null());

    Ok(())
}

#[tokio::test]
async fn update_bot_application_fields() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "UpdateBot").await?;

    let (status, updated) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/bots/applications/{}", bot.app_id),
            Some(json!({
                "name": "RenamedBot",
                "description": "New description",
                "redirect_uri": "http://localhost:3000/callback",
                "permissions": "4096",
                "intents": 513,
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "update failed: {updated}");
    assert_eq!(updated["name"], "RenamedBot");
    assert_eq!(updated["description"], "New description");
    assert_eq!(updated["redirect_uri"], "http://localhost:3000/callback");
    assert_eq!(updated["permissions"], "4096");
    assert_eq!(updated["intents"], 513);

    Ok(())
}

#[tokio::test]
async fn delete_bot_application_cleans_up_user() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "DeleteBot").await?;
    let bot_user_id: i64 = bot.bot_user_id.parse()?;

    // Verify bot user exists
    let user = paracord_db::users::get_user_by_id(&ctx.db, bot_user_id).await?;
    assert!(user.is_some(), "bot user should exist before deletion");

    // Delete the application
    let (status, _) = ctx
        .request_json(
            Method::DELETE,
            &format!("/api/v1/bots/applications/{}", bot.app_id),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Verify the application is gone
    let (status, _) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/bots/applications/{}", bot.app_id),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Verify the bot user is also deleted
    let user = paracord_db::users::get_user_by_id(&ctx.db, bot_user_id).await?;
    assert!(
        user.is_none(),
        "bot user should be deleted after app deletion"
    );

    Ok(())
}

#[tokio::test]
async fn regenerate_bot_token_invalidates_old() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "RegenBot").await?;
    let old_token = bot.token.clone();

    // Regenerate
    let (status, regen) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/bots/applications/{}/token", bot.app_id),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "regenerate failed: {regen}");
    let new_token = regen["token"]
        .as_str()
        .context("new token should be a string")?;
    assert_ne!(old_token, new_token, "new token should differ from old");

    // Verify old token hash no longer matches stored hash
    let old_hash = paracord_db::bot_applications::hash_token(&old_token);
    let new_hash = paracord_db::bot_applications::hash_token(new_token);
    let app = paracord_db::bot_applications::get_bot_application(&ctx.db, bot.app_id.parse()?)
        .await?
        .context("app should still exist")?;
    assert_ne!(app.token_hash, old_hash, "old hash should no longer match");
    assert_eq!(
        app.token_hash, new_hash,
        "new hash should match stored hash"
    );

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Group 2: OAuth2 Authorization + Guild Install
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn oauth2_authorize_adds_bot_to_guild() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "GuildBot").await?;
    let guild_id = create_guild(&ctx, "BotGuild").await?;

    let result = authorize_bot_in_guild(&ctx, &bot.app_id, &guild_id).await?;
    assert_eq!(result["authorized"], true);
    assert_eq!(result["application_id"], bot.app_id);
    assert_eq!(result["guild_id"], guild_id);

    // Verify bot is now a member of the guild
    let bot_user_id: i64 = bot.bot_user_id.parse()?;
    let guild_id_i64: i64 = guild_id.parse()?;
    let member = paracord_db::members::get_member(&ctx.db, bot_user_id, guild_id_i64).await?;
    assert!(
        member.is_some(),
        "bot should be a guild member after authorize"
    );

    Ok(())
}

#[tokio::test]
async fn list_guild_bots_after_install() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "ListGuildBot").await?;
    let guild_id = create_guild(&ctx, "BotListGuild").await?;
    authorize_bot_in_guild(&ctx, &bot.app_id, &guild_id).await?;

    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/bots"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "list guild bots failed: {payload}");
    let bots = payload.as_array().context("should be an array")?;
    assert_eq!(bots.len(), 1, "should have exactly one installed bot");
    assert_eq!(bots[0]["application"]["id"], bot.app_id);

    Ok(())
}

#[tokio::test]
async fn remove_guild_bot() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "RemoveBot").await?;
    let guild_id = create_guild(&ctx, "RemoveGuild").await?;
    authorize_bot_in_guild(&ctx, &bot.app_id, &guild_id).await?;

    // Remove the bot
    let (status, _) = ctx
        .request_json(
            Method::DELETE,
            &format!("/api/v1/guilds/{guild_id}/bots/{}", bot.app_id),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Verify bot is removed from members
    let bot_user_id: i64 = bot.bot_user_id.parse()?;
    let guild_id_i64: i64 = guild_id.parse()?;
    let member = paracord_db::members::get_member(&ctx.db, bot_user_id, guild_id_i64).await?;
    assert!(
        member.is_none(),
        "bot should no longer be a guild member after removal"
    );

    Ok(())
}

#[tokio::test]
async fn oauth2_permissions_exceed_app_default_rejected() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    // Create bot with default permissions (0)
    let bot = create_bot_application_with_permissions(&ctx, "PermBot", Some("0")).await?;
    let guild_id = create_guild(&ctx, "PermGuild").await?;

    // Try to authorize with permissions that exceed the app default (0)
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/oauth2/authorize",
            Some(json!({
                "application_id": bot.app_id,
                "guild_id": guild_id,
                "permissions": "8", // ADMINISTRATOR bit
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "should reject excess permissions: {payload}"
    );

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Group 3: Command CRUD
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn oauth2_authorize_rejects_redirect_uri_mismatch() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/bots/applications",
            Some(json!({
                "name": "RedirectGuardBot",
                "description": "Test bot application",
                "redirect_uri": "https://example.com/callback",
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create bot app failed: {payload}"
    );
    let app_id = payload["id"]
        .as_str()
        .context("app id should be a string")?
        .to_string();

    let guild_id = create_guild(&ctx, "RedirectGuardGuild").await?;

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/oauth2/authorize",
            Some(json!({
                "application_id": app_id,
                "guild_id": guild_id,
                "redirect_uri": "https://evil.example/callback",
            })),
        )
        .await?;

    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "redirect_uri mismatch should be rejected: {payload}"
    );
    let message = payload["error"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    assert!(
        message.contains("redirect_uri"),
        "expected redirect_uri validation error, got: {payload}"
    );

    Ok(())
}

// ── Private-app metadata disclosure / forced-install regressions ─────────────

#[tokio::test]
async fn public_bot_application_hidden_from_non_owner_unless_listed() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    // Owner (the default ctx user) creates a private/unlisted bot application.
    let bot = create_bot_application(&ctx, "PrivateBot").await?;
    let app_id_num: i64 = bot.app_id.parse()?;

    // The owner can always read their own app's public view.
    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/bots/applications/{}/public", bot.app_id),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "owner should read own app public view: {payload}"
    );

    // A different authenticated user must NOT be able to read an unlisted app's
    // metadata. Old behavior returned 200 with name/description/bot_user_id/etc.
    let other_token = create_authenticated_user_token(
        &ctx.db,
        &ctx._test_app.jwt_secret,
        "otherviewer",
        "OtherViewerPass123!",
    )
    .await?;
    let (status, payload) = ctx
        .request_json_with_token(
            Method::GET,
            &format!("/api/v1/bots/applications/{}/public", bot.app_id),
            None,
            &other_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "non-owner must not read an unlisted app's metadata: {payload}"
    );

    // Once the app is publicly listed, any authenticated user may read it.
    sqlx::query("UPDATE bot_applications SET public_listed = TRUE WHERE id = $1")
        .bind(app_id_num)
        .execute(&ctx.db)
        .await?;
    let (status, payload) = ctx
        .request_json_with_token(
            Method::GET,
            &format!("/api/v1/bots/applications/{}/public", bot.app_id),
            None,
            &other_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "a publicly listed app must be readable by any authenticated user: {payload}"
    );

    Ok(())
}

#[tokio::test]
async fn oauth2_authorize_rejects_non_owner_installing_unlisted_app() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    // Owner (the default ctx user) creates a private/unlisted bot application.
    let bot = create_bot_application(&ctx, "UnlistedInstallBot").await?;
    let app_id_num: i64 = bot.app_id.parse()?;

    // A second user creates and thus owns their own guild → holds MANAGE_GUILD
    // there, but does NOT own the bot application.
    let installer_token = create_authenticated_user_token(
        &ctx.db,
        &ctx._test_app.jwt_secret,
        "installer",
        "InstallerPass123!",
    )
    .await?;
    let (status, guild_payload) = ctx
        .request_json_with_token(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": "Installer Guild", "icon": Value::Null })),
            &installer_token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "guild create: {guild_payload}");
    let guild_id = guild_payload["id"]
        .as_str()
        .context("guild id should be a string")?
        .to_string();

    // MANAGE_GUILD alone must not let a non-owner force-install an unlisted bot.
    let (status, payload) = ctx
        .request_json_with_token(
            Method::POST,
            "/api/v1/oauth2/authorize",
            Some(json!({ "application_id": bot.app_id, "guild_id": guild_id })),
            &installer_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "non-owner must not force-install an unlisted app: {payload}"
    );

    // After the app is publicly listed, the same MANAGE_GUILD holder may install.
    sqlx::query("UPDATE bot_applications SET public_listed = TRUE WHERE id = $1")
        .bind(app_id_num)
        .execute(&ctx.db)
        .await?;
    let (status, payload) = ctx
        .request_json_with_token(
            Method::POST,
            "/api/v1/oauth2/authorize",
            Some(json!({ "application_id": bot.app_id, "guild_id": guild_id })),
            &installer_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "a publicly listed app must be installable by a MANAGE_GUILD holder: {payload}"
    );

    Ok(())
}

#[tokio::test]
async fn global_command_crud() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "CmdBot").await?;

    // Create
    let (cmd_json, cmd_id) =
        create_global_command(&ctx, &bot.app_id, "ping", "Responds with pong").await?;
    assert_eq!(cmd_json["name"], "ping");
    assert_eq!(cmd_json["description"], "Responds with pong");

    // Get
    let (status, got) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/applications/{}/commands/{cmd_id}", bot.app_id),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "get command failed: {got}");
    assert_eq!(got["id"], cmd_id);
    assert_eq!(got["name"], "ping");

    // Update
    let (status, updated) = ctx
        .request_json(
            Method::PATCH,
            &format!("/api/v1/applications/{}/commands/{cmd_id}", bot.app_id),
            Some(json!({
                "description": "Updated description",
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "update command failed: {updated}");
    assert_eq!(updated["description"], "Updated description");

    // Delete
    let (status, _) = ctx
        .request_json(
            Method::DELETE,
            &format!("/api/v1/applications/{}/commands/{cmd_id}", bot.app_id),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Verify deleted
    let (status, _) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/applications/{}/commands/{cmd_id}", bot.app_id),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);

    Ok(())
}

#[tokio::test]
async fn global_command_validation_rejects_bad_names() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "ValidationBot").await?;

    // Name with spaces
    let (status, _) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/applications/{}/commands", bot.app_id),
            Some(json!({
                "name": "bad name",
                "description": "Has spaces",
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "names with spaces should be rejected"
    );

    // Name with special chars
    let (status, _) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/applications/{}/commands", bot.app_id),
            Some(json!({
                "name": "bad!name",
                "description": "Has special chars",
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "names with special chars should be rejected"
    );

    Ok(())
}

#[tokio::test]
async fn global_command_limit_enforced() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "LimitBot").await?;

    // Create 100 commands
    for i in 0..100 {
        let (status, payload) = ctx
            .request_json(
                Method::POST,
                &format!("/api/v1/applications/{}/commands", bot.app_id),
                Some(json!({
                    "name": format!("cmd{i:03}"),
                    "description": format!("Command number {i}"),
                })),
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::CREATED,
            "creating command {i} failed: {payload}"
        );
    }

    // 101st should fail
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!("/api/v1/applications/{}/commands", bot.app_id),
            Some(json!({
                "name": "overflow",
                "description": "One too many",
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "101st command should be rejected: {payload}"
    );

    Ok(())
}

#[tokio::test]
async fn guild_command_requires_bot_installed() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "NotInstalledBot").await?;
    let guild_id = create_guild(&ctx, "NoInstallGuild").await?;

    // Try to create guild command without installing the bot
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            &format!(
                "/api/v1/applications/{}/guilds/{guild_id}/commands",
                bot.app_id
            ),
            Some(json!({
                "name": "test",
                "description": "Should fail",
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "guild command without install should fail: {payload}"
    );

    Ok(())
}

#[tokio::test]
async fn guild_command_crud() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "GuildCmdBot").await?;
    let guild_id = create_guild(&ctx, "GuildCmdGuild").await?;
    authorize_bot_in_guild(&ctx, &bot.app_id, &guild_id).await?;

    // Create guild command
    let (cmd_json, cmd_id) =
        create_guild_command(&ctx, &bot.app_id, &guild_id, "guildcmd", "A guild command").await?;
    assert_eq!(cmd_json["name"], "guildcmd");
    assert_eq!(cmd_json["guild_id"], guild_id);

    // Get
    let (status, got) = ctx
        .request_json(
            Method::GET,
            &format!(
                "/api/v1/applications/{}/guilds/{guild_id}/commands/{cmd_id}",
                bot.app_id
            ),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "get guild command failed: {got}");
    assert_eq!(got["id"], cmd_id);

    // Update
    let (status, updated) = ctx
        .request_json(
            Method::PATCH,
            &format!(
                "/api/v1/applications/{}/guilds/{guild_id}/commands/{cmd_id}",
                bot.app_id
            ),
            Some(json!({ "description": "Updated guild cmd" })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "update guild command failed: {updated}"
    );
    assert_eq!(updated["description"], "Updated guild cmd");

    // Delete
    let (status, _) = ctx
        .request_json(
            Method::DELETE,
            &format!(
                "/api/v1/applications/{}/guilds/{guild_id}/commands/{cmd_id}",
                bot.app_id
            ),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Verify deleted
    let (status, _) = ctx
        .request_json(
            Method::GET,
            &format!(
                "/api/v1/applications/{}/guilds/{guild_id}/commands/{cmd_id}",
                bot.app_id
            ),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);

    Ok(())
}

#[tokio::test]
async fn bulk_overwrite_global_commands() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "BulkBot").await?;

    // Create some initial commands
    create_global_command(&ctx, &bot.app_id, "old1", "Old command 1").await?;
    create_global_command(&ctx, &bot.app_id, "old2", "Old command 2").await?;

    // Bulk overwrite with a new set
    let (status, payload) = ctx
        .request_json(
            Method::PUT,
            &format!("/api/v1/applications/{}/commands", bot.app_id),
            Some(json!([
                { "name": "new1", "description": "New command 1" },
                { "name": "new2", "description": "New command 2" },
                { "name": "new3", "description": "New command 3" },
            ])),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "bulk overwrite failed: {payload}");
    let cmds = payload.as_array().context("should be an array")?;
    assert_eq!(
        cmds.len(),
        3,
        "should have exactly 3 commands after overwrite"
    );

    // Verify old commands are gone
    let (status, list) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/applications/{}/commands", bot.app_id),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let list = list.as_array().context("should be an array")?;
    assert_eq!(list.len(), 3);
    let names: Vec<&str> = list.iter().filter_map(|c| c["name"].as_str()).collect();
    assert!(names.contains(&"new1"));
    assert!(names.contains(&"new2"));
    assert!(names.contains(&"new3"));
    assert!(!names.contains(&"old1"));
    assert!(!names.contains(&"old2"));

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Group 4: Guild Available Commands Discovery
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn list_guild_available_commands_includes_global_and_guild() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "DiscoveryBot").await?;
    let guild_id = create_guild(&ctx, "DiscoveryGuild").await?;
    authorize_bot_in_guild(&ctx, &bot.app_id, &guild_id).await?;

    // Register a global command and a guild command
    create_global_command(&ctx, &bot.app_id, "globalcmd", "A global command").await?;
    create_guild_command(&ctx, &bot.app_id, &guild_id, "guildcmd", "A guild command").await?;

    // List available commands for the guild
    let (status, payload) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/commands"),
            None,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "list guild commands failed: {payload}"
    );
    let cmds = payload.as_array().context("should be an array")?;
    let names: Vec<&str> = cmds.iter().filter_map(|c| c["name"].as_str()).collect();
    assert!(
        names.contains(&"globalcmd"),
        "should include global command: got {names:?}"
    );
    assert!(
        names.contains(&"guildcmd"),
        "should include guild command: got {names:?}"
    );

    Ok(())
}

#[tokio::test]
async fn list_guild_available_commands_requires_membership() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = create_guild(&ctx, "MembershipGuild").await?;

    // Create a second user who is NOT a member of this guild
    let token2 = create_authenticated_user_token(
        &ctx.db,
        "integration-test-secret",
        "integration",
        "IntegrationPass123!",
    )
    .await?;

    let (status, _payload) = ctx
        .request_json_with_token(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/commands"),
            None,
            &token2,
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "non-member should get 403");

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Group 5: Interaction Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn invoke_slash_command_creates_interaction() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "InteractionBot").await?;
    let guild_id = create_guild(&ctx, "InteractionGuild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "chat").await?;
    authorize_bot_in_guild(&ctx, &bot.app_id, &guild_id).await?;
    create_global_command(&ctx, &bot.app_id, "hello", "Says hello").await?;

    let (interaction, token) = invoke_slash_command(&ctx, "hello", &guild_id, &channel_id).await?;

    assert!(interaction["id"].is_string(), "should have interaction id");
    assert_eq!(interaction["application_id"], bot.app_id);
    assert_eq!(interaction["type"], 2);
    assert!(!token.is_empty(), "should have interaction token");
    assert!(interaction["data"].is_object(), "should have data object");
    assert_eq!(interaction["data"]["name"], "hello");

    Ok(())
}

#[tokio::test]
async fn interaction_callback_type4_creates_message() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "Callback4Bot").await?;
    let guild_id = create_guild(&ctx, "Callback4Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "chat").await?;
    authorize_bot_in_guild(&ctx, &bot.app_id, &guild_id).await?;
    create_global_command(&ctx, &bot.app_id, "respond", "Sends a response").await?;

    let (interaction, token) =
        invoke_slash_command(&ctx, "respond", &guild_id, &channel_id).await?;
    let interaction_id = interaction["id"].as_str().unwrap();

    // Callback type 4: CHANNEL_MESSAGE_WITH_SOURCE
    let components = json!([
        {
            "type": 1,
            "components": [
                { "type": 2, "label": "Click me", "custom_id": "btn1", "style": 1 }
            ]
        }
    ]);
    let (status, result) = interaction_callback(
        &ctx,
        interaction_id,
        &token,
        4,
        Some(json!({
            "content": "Hello from bot!",
            "components": components,
        })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "callback type 4 failed: {result}");

    // Verify message was created with correct author (bot_user_id, not app_id)
    assert_eq!(
        result["author_id"], bot.bot_user_id,
        "author should be bot_user_id"
    );
    assert_eq!(result["content"], "Hello from bot!");
    assert_eq!(
        result["message_type"], 20,
        "should be APPLICATION_COMMAND type"
    );

    // Verify components are included
    assert!(
        result.get("components").is_some(),
        "components should be in the response"
    );
    assert_eq!(result["components"], components);

    let (status, messages) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/messages"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "get messages failed: {messages}");
    let persisted = messages
        .as_array()
        .and_then(|items| items.iter().find(|msg| msg["id"] == result["id"]))
        .context("interaction response should be present in message history")?;
    assert_eq!(
        persisted["components"], components,
        "interaction response components should survive a history reload"
    );

    Ok(())
}

/// Post a bot-authored message into `channel_id` via a slash command + type-4
/// callback, returning the created message id. Used to obtain a real message
/// that carries a component the invoker could legitimately click.
async fn post_bot_message(
    ctx: &TestContext,
    bot: &BotAppInfo,
    guild_id: &str,
    channel_id: &str,
    command_name: &str,
) -> anyhow::Result<String> {
    create_global_command(ctx, &bot.app_id, command_name, "posts a panel").await?;
    let (interaction, token) =
        invoke_slash_command(ctx, command_name, guild_id, channel_id).await?;
    let interaction_id = interaction["id"].as_str().unwrap();
    let (status, result) = interaction_callback(
        ctx,
        interaction_id,
        &token,
        4,
        Some(json!({
            "content": "control panel",
            "components": [
                { "type": 1, "components": [
                    { "type": 2, "label": "Ban", "custom_id": "ban:victim", "style": 4 }
                ]}
            ],
        })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "seed bot message failed: {result}");
    Ok(result["id"].as_str().context("message id")?.to_string())
}

/// L04-05: a type-3 (MessageComponent) interaction whose `channel_id` does not
/// match the target message's real channel must be rejected — otherwise a
/// member could forge a component click and steer the bot's response into an
/// arbitrary channel.
#[tokio::test]
async fn component_interaction_rejects_mismatched_channel() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "ComponentBot").await?;
    let guild_id = create_guild(&ctx, "ComponentGuild").await?;
    let channel_a = create_text_channel(&ctx, &guild_id, "panel").await?;
    let channel_b = create_text_channel(&ctx, &guild_id, "elsewhere").await?;
    authorize_bot_in_guild(&ctx, &bot.app_id, &guild_id).await?;

    let message_id = post_bot_message(&ctx, &bot, &guild_id, &channel_a, "panel").await?;

    // Forge a component interaction that claims the message lives in channel_b.
    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/interactions",
            Some(json!({
                "type": 3,
                "guild_id": guild_id,
                "channel_id": channel_b,
                "message_id": message_id,
                "custom_id": "ban:victim",
                "component_type": 2,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "mismatched channel component interaction must be rejected: {payload}"
    );

    Ok(())
}

/// L04-05 regression guard: a legitimate type-3 interaction (channel_id matches
/// the message's channel and the caller can view it) still succeeds.
#[tokio::test]
async fn component_interaction_accepts_matching_channel() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "ComponentBot2").await?;
    let guild_id = create_guild(&ctx, "ComponentGuild2").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "panel").await?;
    authorize_bot_in_guild(&ctx, &bot.app_id, &guild_id).await?;

    let message_id = post_bot_message(&ctx, &bot, &guild_id, &channel_id, "panel").await?;

    let (status, payload) = ctx
        .request_json(
            Method::POST,
            "/api/v1/interactions",
            Some(json!({
                "type": 3,
                "guild_id": guild_id,
                "channel_id": channel_id,
                "message_id": message_id,
                "custom_id": "ban:victim",
                "component_type": 2,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "legitimate component interaction should succeed: {payload}"
    );
    assert_eq!(payload["type"], 3);

    Ok(())
}

/// A caller may only invoke the exact component persisted on the bot message;
/// knowing a message ID must not allow invention of a privileged custom_id.
#[tokio::test]
async fn component_interaction_rejects_forged_custom_id_and_type() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "BoundComponentBot").await?;
    let guild_id = create_guild(&ctx, "BoundComponentGuild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "panel").await?;
    authorize_bot_in_guild(&ctx, &bot.app_id, &guild_id).await?;
    let message_id = post_bot_message(&ctx, &bot, &guild_id, &channel_id, "bound-panel").await?;

    for (custom_id, component_type) in [("admin:forged", 2), ("ban:victim", 3)] {
        let (status, payload) = ctx
            .request_json(
                Method::POST,
                "/api/v1/interactions",
                Some(json!({
                    "type": 3,
                    "guild_id": guild_id,
                    "channel_id": channel_id,
                    "message_id": message_id,
                    "custom_id": custom_id,
                    "component_type": component_type,
                })),
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "forged component must be rejected: {payload}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn modal_submit_requires_issued_user_bound_single_use_modal() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "BoundModalBot").await?;
    let guild_id = create_guild(&ctx, "BoundModalGuild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "modals").await?;
    authorize_bot_in_guild(&ctx, &bot.app_id, &guild_id).await?;
    create_global_command(&ctx, &bot.app_id, "open-modal", "opens a modal").await?;

    let (source, token) = invoke_slash_command(&ctx, "open-modal", &guild_id, &channel_id).await?;
    let source_id = source["id"].as_str().context("source interaction id")?;
    let (status, callback) = interaction_callback(
        &ctx,
        source_id,
        &token,
        9,
        Some(json!({
            "title": "Confirm action",
            "custom_id": "confirm-modal",
            "components": [{
                "type": 1,
                "components": [{
                    "type": 4,
                    "custom_id": "reason",
                    "label": "Reason",
                    "required": true,
                    "min_length": 3,
                    "max_length": 100
                }]
            }]
        })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "modal callback failed: {callback}");

    let submit = json!({
        "type": 5,
        "guild_id": guild_id,
        "channel_id": channel_id,
        "application_id": bot.app_id,
        "source_interaction_id": source_id,
        "custom_id": "confirm-modal",
        "components": [{
            "type": 1,
            "components": [{
                "type": 4,
                "custom_id": "reason",
                "value": "approved reason"
            }]
        }]
    });
    let (status, submitted) = ctx
        .request_json(Method::POST, "/api/v1/interactions", Some(submit.clone()))
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "valid modal failed: {submitted}"
    );

    let (status, replay) = ctx
        .request_json(Method::POST, "/api/v1/interactions", Some(submit))
        .await?;
    assert!(
        matches!(status, StatusCode::BAD_REQUEST | StatusCode::FORBIDDEN),
        "modal replay must fail: {replay}"
    );

    let (status, forged) = ctx
        .request_json(
            Method::POST,
            "/api/v1/interactions",
            Some(json!({
                "type": 5,
                "guild_id": guild_id,
                "channel_id": channel_id,
                "application_id": bot.app_id,
                "custom_id": "confirm-modal",
                "components": []
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "unissued modal accepted: {forged}"
    );
    Ok(())
}

#[tokio::test]
async fn interaction_messages_reject_unsafe_component_urls() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "UnsafeComponentBot").await?;
    let guild_id = create_guild(&ctx, "UnsafeComponentGuild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "chat").await?;
    authorize_bot_in_guild(&ctx, &bot.app_id, &guild_id).await?;
    create_global_command(&ctx, &bot.app_id, "unsafe", "Checks unsafe URLs").await?;

    let (interaction, token) = invoke_slash_command(&ctx, "unsafe", &guild_id, &channel_id).await?;
    let interaction_id = interaction["id"].as_str().unwrap();
    let unsafe_components = json!([
        {
            "type": 1,
            "components": [
                {
                    "type": 2,
                    "label": "Unsafe",
                    "style": 5,
                    "url": "javascript:alert(1)"
                }
            ]
        }
    ]);

    let (status, payload) = interaction_callback(
        &ctx,
        interaction_id,
        &token,
        4,
        Some(json!({
            "content": "This should be rejected",
            "components": unsafe_components.clone(),
        })),
    )
    .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "unsafe callback components should be rejected: {payload}"
    );
    assert!(
        payload["message"]
            .as_str()
            .unwrap_or_default()
            .contains("component URL must use http or https"),
        "unexpected callback error payload: {payload}"
    );

    let (status, payload) = ctx
        .request_json_no_auth(
            Method::POST,
            &format!("/api/v1/interactions/{}/{}/followup", bot.app_id, token),
            Some(json!({
                "content": "Followup should be rejected",
                "components": unsafe_components,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "unsafe followup components should be rejected: {payload}"
    );
    assert!(
        payload["message"]
            .as_str()
            .unwrap_or_default()
            .contains("component URL must use http or https"),
        "unexpected followup error payload: {payload}"
    );

    Ok(())
}

#[tokio::test]
async fn interaction_callback_type5_creates_placeholder() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "Callback5Bot").await?;
    let guild_id = create_guild(&ctx, "Callback5Guild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "chat").await?;
    authorize_bot_in_guild(&ctx, &bot.app_id, &guild_id).await?;
    create_global_command(&ctx, &bot.app_id, "defer", "Deferred response").await?;

    let (interaction, token) = invoke_slash_command(&ctx, "defer", &guild_id, &channel_id).await?;
    let interaction_id = interaction["id"].as_str().unwrap();

    // Callback type 5: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    let (status, result) = interaction_callback(&ctx, interaction_id, &token, 5, None).await?;
    assert_eq!(status, StatusCode::OK, "callback type 5 failed: {result}");

    // Should create an empty placeholder message
    assert_eq!(result["content"], "");
    assert_eq!(result["message_type"], 20);
    assert_eq!(result["author_id"], bot.bot_user_id);

    // Verify response_message_id is stored on the token row
    let interaction_id_i64: i64 = interaction_id.parse()?;
    let token_row =
        paracord_db::interaction_tokens::get_interaction_token(&ctx.db, interaction_id_i64)
            .await?
            .context("interaction token should exist")?;
    assert!(
        token_row.response_message_id.is_some(),
        "response_message_id should be stored"
    );

    Ok(())
}

#[tokio::test]
async fn edit_original_response_uses_stored_message_id() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "EditBot").await?;
    let guild_id = create_guild(&ctx, "EditGuild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "chat").await?;
    authorize_bot_in_guild(&ctx, &bot.app_id, &guild_id).await?;
    create_global_command(&ctx, &bot.app_id, "editable", "Will be edited").await?;

    let (interaction, token) =
        invoke_slash_command(&ctx, "editable", &guild_id, &channel_id).await?;
    let interaction_id = interaction["id"].as_str().unwrap();

    // First, create a deferred response (type 5)
    let (status, _) = interaction_callback(&ctx, interaction_id, &token, 5, None).await?;
    assert_eq!(status, StatusCode::OK);

    // Now edit the original response
    let edited_components = json!([
        {
            "type": 1,
            "components": [
                { "type": 2, "label": "Edited", "custom_id": "edited_btn", "style": 1 }
            ]
        }
    ]);
    let (status, edited) = ctx
        .request_json_no_auth(
            Method::PATCH,
            &format!(
                "/api/v1/interactions/{}/{}/messages/@original",
                bot.app_id, token
            ),
            Some(json!({
                "content": "Edited content!",
                "components": edited_components,
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "edit original failed: {edited}");
    assert_eq!(edited["content"], "Edited content!");
    assert_eq!(edited["components"], edited_components);

    Ok(())
}

#[tokio::test]
async fn delete_original_response() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "DeleteRespBot").await?;
    let guild_id = create_guild(&ctx, "DeleteRespGuild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "chat").await?;
    authorize_bot_in_guild(&ctx, &bot.app_id, &guild_id).await?;
    create_global_command(&ctx, &bot.app_id, "deletable", "Will be deleted").await?;

    let (interaction, token) =
        invoke_slash_command(&ctx, "deletable", &guild_id, &channel_id).await?;
    let interaction_id = interaction["id"].as_str().unwrap();

    // Create a response first (type 4)
    let (status, msg) = interaction_callback(
        &ctx,
        interaction_id,
        &token,
        4,
        Some(json!({ "content": "Soon to be deleted" })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let msg_id = msg["id"].as_str().context("msg should have id")?;

    // Delete the original response
    let (status, _) = ctx
        .request_json_no_auth(
            Method::DELETE,
            &format!(
                "/api/v1/interactions/{}/{}/messages/@original",
                bot.app_id, token
            ),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Verify message is deleted from DB
    let msg_id_i64: i64 = msg_id.parse()?;
    let deleted = paracord_db::messages::get_message(&ctx.db, msg_id_i64).await?;
    assert!(deleted.is_none(), "message should be deleted from DB");

    Ok(())
}

#[tokio::test]
async fn create_followup_message_uses_bot_user_id() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "FollowupBot").await?;
    let guild_id = create_guild(&ctx, "FollowupGuild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "chat").await?;
    authorize_bot_in_guild(&ctx, &bot.app_id, &guild_id).await?;
    create_global_command(&ctx, &bot.app_id, "followup", "Has followup").await?;

    let (interaction, token) =
        invoke_slash_command(&ctx, "followup", &guild_id, &channel_id).await?;
    let interaction_id = interaction["id"].as_str().unwrap();

    // Send initial response
    let (status, _) = interaction_callback(
        &ctx,
        interaction_id,
        &token,
        4,
        Some(json!({ "content": "Initial response" })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);

    // Create a followup message
    let followup_components = json!([
        {
            "type": 1,
            "components": [
                { "type": 2, "label": "Follow", "custom_id": "follow_btn", "style": 1 }
            ]
        }
    ]);
    let (status, followup) = ctx
        .request_json_no_auth(
            Method::POST,
            &format!("/api/v1/interactions/{}/{}/followup", bot.app_id, token),
            Some(json!({
                "content": "This is a followup!",
                "components": followup_components,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "followup creation failed: {followup}"
    );
    assert_eq!(
        followup["author_id"], bot.bot_user_id,
        "followup author should be bot_user_id, not app_id"
    );
    assert_eq!(followup["content"], "This is a followup!");
    assert_eq!(
        followup["message_type"], 20,
        "should be APPLICATION_COMMAND type"
    );
    assert_eq!(followup["components"], followup_components);

    let (status, messages) = ctx
        .request_json(
            Method::GET,
            &format!("/api/v1/channels/{channel_id}/messages"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "get messages failed: {messages}");
    let persisted = messages
        .as_array()
        .and_then(|items| items.iter().find(|msg| msg["id"] == followup["id"]))
        .context("followup should be present in message history")?;
    assert_eq!(
        persisted["components"], followup_components,
        "followup components should survive a history reload"
    );

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Group 6: Component Interactions
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn component_interaction_type3_dispatches() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "ComponentBot").await?;
    let guild_id = create_guild(&ctx, "ComponentGuild").await?;
    let channel_id = create_text_channel(&ctx, &guild_id, "chat").await?;
    authorize_bot_in_guild(&ctx, &bot.app_id, &guild_id).await?;
    create_global_command(&ctx, &bot.app_id, "button", "Has a button").await?;

    // Create interaction and respond with a message containing components
    let (interaction, token) = invoke_slash_command(&ctx, "button", &guild_id, &channel_id).await?;
    let interaction_id = interaction["id"].as_str().unwrap();

    let (status, msg) = interaction_callback(
        &ctx,
        interaction_id,
        &token,
        4,
        Some(json!({
            "content": "Click below!",
            "components": [
                {
                    "type": 1,
                    "components": [
                        { "type": 2, "label": "Click", "custom_id": "btn_test", "style": 1 }
                    ]
                }
            ],
        })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    let msg_id = msg["id"].as_str().unwrap();

    // Now simulate a component interaction (type 3)
    let (status, component_interaction) = ctx
        .request_json(
            Method::POST,
            "/api/v1/interactions",
            Some(json!({
                "type": 3,
                "guild_id": guild_id,
                "channel_id": channel_id,
                "message_id": msg_id,
                "custom_id": "btn_test",
                "component_type": 2,
            })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "component interaction failed: {component_interaction}"
    );
    assert_eq!(component_interaction["type"], 3);
    assert_eq!(
        component_interaction["application_id"], bot.app_id,
        "interaction should target the bot that authored the message"
    );
    assert!(
        component_interaction["token"].is_string(),
        "should have token"
    );

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Group 7: Bot Store
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn bot_store_search_returns_public_bots() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "StoreBot").await?;
    let app_id: i64 = bot.app_id.parse()?;

    // Mark the bot as public_listed via direct DB update (no API for this yet)
    sqlx::query(
        "UPDATE bot_applications SET public_listed = true, category = 'utility' WHERE id = $1",
    )
    .bind(app_id)
    .execute(&ctx.db)
    .await?;

    // Search the store
    let (status, payload) = ctx
        .request_json_no_auth(Method::GET, "/api/v1/bots/store?q=StoreBot", None)
        .await?;
    assert_eq!(status, StatusCode::OK, "store search failed: {payload}");
    let bots = payload["bots"]
        .as_array()
        .context("should have bots array")?;
    assert!(
        bots.iter().any(|b| b["id"].as_str() == Some(&bot.app_id)),
        "public bot should appear in store search results"
    );
    assert!(payload["total"].as_i64().unwrap_or(0) > 0);

    Ok(())
}

#[tokio::test]
async fn bot_store_categories_and_featured() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let bot = create_bot_application(&ctx, "FeaturedBot").await?;
    let app_id: i64 = bot.app_id.parse()?;

    // Mark as public with a category
    sqlx::query(
        "UPDATE bot_applications SET public_listed = true, category = 'moderation' WHERE id = $1",
    )
    .bind(app_id)
    .execute(&ctx.db)
    .await?;

    // Categories endpoint
    let (status, categories) = ctx
        .request_json_no_auth(Method::GET, "/api/v1/bots/store/categories", None)
        .await?;
    assert_eq!(status, StatusCode::OK, "categories failed: {categories}");
    assert!(
        categories.get("categories").is_some(),
        "should have categories field"
    );
    let cats = categories["categories"]
        .as_array()
        .context("categories should be an array")?;
    assert!(
        cats.iter().any(|c| c.as_str() == Some("moderation")),
        "should include the moderation category"
    );

    // Featured endpoint
    let (status, featured) = ctx
        .request_json_no_auth(Method::GET, "/api/v1/bots/store/featured", None)
        .await?;
    assert_eq!(status, StatusCode::OK, "featured failed: {featured}");
    assert!(featured.get("bots").is_some(), "should have bots field");
    let featured_bots = featured["bots"]
        .as_array()
        .context("featured bots should be an array")?;
    assert!(
        featured_bots
            .iter()
            .any(|b| b["id"].as_str() == Some(&bot.app_id)),
        "public bot should appear in featured"
    );

    Ok(())
}
