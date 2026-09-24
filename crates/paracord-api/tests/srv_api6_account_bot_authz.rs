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
        Self::with_options(TestAppOptions::default()).await
    }

    async fn with_options(options: TestAppOptions) -> anyhow::Result<Self> {
        let test_app = build_test_app(options).await?;
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
    token: String,
    user_id: i64,
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
        token: payload["token"].as_str().context("bot token")?.to_owned(),
        user_id: payload["bot_user_id"]
            .as_str()
            .context("bot user id")?
            .parse()?,
        app_id: payload["id"]
            .as_str()
            .context("app id should be string")?
            .to_string(),
    })
}

#[tokio::test]
async fn reducing_bot_install_permissions_revokes_cached_channel_access() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild = ctx.create_guild("bot reauthorization").await?;
    let channel = ctx.create_text_channel(guild, "private").await?;
    let grant = Permissions::VIEW_CHANNEL | Permissions::READ_MESSAGE_HISTORY;
    let bot = create_bot_app(&ctx, "ReauthorizeBot", &grant.bits().to_string()).await?;
    let (status, body) = ctx
        .request(
            Method::POST,
            "/api/v1/oauth2/authorize",
            Some(json!({
                "application_id": bot.app_id, "guild_id": guild.to_string(),
            })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "initial install: {body}");
    paracord_db::roles::add_member_role(&ctx.db, bot.user_id, guild, guild).await?;
    let request = || {
        Request::builder()
            .method("GET")
            .uri(format!("/api/v1/channels/{channel}/messages"))
            .header("authorization", format!("Bot {}", bot.token))
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(dispatch_json(&ctx.app, request()).await?.0, StatusCode::OK);

    let (status, body) = ctx
        .request(
            Method::POST,
            "/api/v1/oauth2/authorize",
            Some(json!({
                "application_id": bot.app_id, "guild_id": guild.to_string(), "permissions": "0",
            })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "reauthorization: {body}");
    let (status, body) = dispatch_json(&ctx.app, request()).await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "old grant must not remain cached: {body}"
    );
    Ok(())
}

#[tokio::test]
async fn existing_members_cannot_trigger_raid_lockdown_by_replaying_an_invite() -> anyhow::Result<()>
{
    let ctx = TestContext::new().await?;
    let guild = ctx.create_guild("raid counter").await?;
    let channel: i64 = ctx.create_text_channel(guild, "entry").await?.parse()?;
    let owner = ctx.user_id(&ctx.owner_token).await?;
    let (member_token, member) = ctx.add_user("existinginvite").await?;
    paracord_db::members::add_member(&ctx.db, member, guild).await?;
    paracord_db::invites::create_invite(&ctx.db, "raid-replay", guild, channel, owner, None, None)
        .await?;
    let settings = json!({"auto_mod": {"anti_raid": {
        "enabled": true, "join_threshold": 2, "join_window_seconds": 600,
        "lockdown_minutes": 240,
    }}})
    .to_string();
    paracord_db::guilds::update_guild(&ctx.db, guild, None, None, None, None, Some(&settings))
        .await?;
    for _ in 0..4 {
        let (status, body) = ctx
            .request(
                Method::POST,
                "/api/v1/invites/raid-replay",
                Some(json!({})),
                &member_token,
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::OK,
            "replaying an existing membership must be idempotent: {body}"
        );
    }
    let updated = paracord_db::guilds::get_guild(&ctx.db, guild)
        .await?
        .unwrap();
    let settings: Value = serde_json::from_str(updated.bot_settings.as_deref().unwrap())?;
    assert!(settings["auto_mod"]["anti_raid"]["lockdown_until_ms"].is_null());

    let (outsider_token, outsider) = ctx.add_user("inviteoutsider").await?;
    let settings = json!({"auto_mod": {
        "anti_raid": {"enabled": true, "join_threshold": 2, "join_window_seconds": 600, "lockdown_minutes": 240},
        "verification_gate": {"enabled": true, "require_ack": true},
    }}).to_string();
    paracord_db::guilds::update_guild(&ctx.db, guild, None, None, None, None, Some(&settings))
        .await?;
    for _ in 0..4 {
        let (status, body) = ctx
            .request(
                Method::POST,
                "/api/v1/invites/raid-replay",
                Some(json!({})),
                &outsider_token,
            )
            .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(
            body.to_string().contains("Verification acknowledgment"),
            "{body}"
        );
    }
    // A real join still succeeds after rejected attempts, and repeated actual
    // joins by the same account count once rather than triggering a fake raid.
    for _ in 0..3 {
        let (status, body) = ctx
            .request(
                Method::POST,
                "/api/v1/invites/raid-replay",
                Some(json!({"verification_ack": true})),
                &outsider_token,
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::OK,
            "a single account is not a raid: {body}"
        );
        paracord_db::members::remove_member(&ctx.db, outsider, guild).await?;
    }
    // A second distinct joining account reaches the configured threshold.
    let (other_token, _) = ctx.add_user("otherinviteoutsider").await?;
    let (status, body) = ctx
        .request(
            Method::POST,
            "/api/v1/invites/raid-replay",
            Some(json!({"verification_ack": true})),
            &other_token,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        body.to_string().contains("Raid protection triggered"),
        "legitimate raid detection must remain active: {body}"
    );
    Ok(())
}

#[tokio::test]
async fn concurrent_distinct_raid_claims_preserve_the_threshold_for_duplicates(
) -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    use paracord_db::rate_limits::increment_distinct_window_counter as count;
    assert_eq!(count(&ctx.db, "raid:distinct-test", 1, 100, 30).await?, 1);
    let (first, duplicate) = tokio::join!(
        count(&ctx.db, "raid:distinct-test", 2, 100, 30),
        count(&ctx.db, "raid:distinct-test", 2, 100, 30),
    );
    assert_eq!(first?, 2);
    assert_eq!(
        duplicate?, 2,
        "a duplicate must observe the reached lockdown threshold"
    );
    assert_eq!(count(&ctx.db, "raid:distinct-test", 1, 100, 30).await?, 2);
    assert_eq!(count(&ctx.db, "raid:distinct-test", 1, 101, 30).await?, 1);
    Ok(())
}

#[tokio::test]
async fn concurrent_first_invite_accepts_consume_one_use_and_emit_one_join() -> anyhow::Result<()> {
    let ctx = TestContext::with_options(TestAppOptions {
        database_connections: 8,
        ..Default::default()
    })
    .await?;
    let guild = ctx.create_guild("atomic invite").await?;
    let channel: i64 = ctx.create_text_channel(guild, "entry").await?.parse()?;
    let owner = ctx.user_id(&ctx.owner_token).await?;
    let (token, member) = ctx.add_user("paralleljoin").await?;
    paracord_db::invites::create_invite(
        &ctx.db,
        "parallel-accept",
        guild,
        channel,
        owner,
        Some(4),
        None,
    )
    .await?;
    let mut observer = ctx
        ._test_app
        .event_bus
        .register_session(format!("invite-observer-{guild}"), owner, &[guild])
        .expect("observer registration");

    // All requests start together while the account is not a member. The old
    // read/use/insert sequence let them each consume a use before the first
    // membership insert reached the pool, exhausting this four-use invite.
    let responses = futures_util::future::join_all((0..16).map(|_| {
        ctx.request(
            Method::POST,
            "/api/v1/invites/parallel-accept",
            Some(json!({})),
            &token,
        )
    }))
    .await;
    let (uses,): (i32,) = sqlx::query_as("SELECT uses FROM invites WHERE code = 'parallel-accept'")
        .fetch_one(&ctx.db)
        .await?;
    assert_eq!(
        uses, 1,
        "concurrent accepts by one account must consume one use"
    );
    for response in responses {
        let (status, body) = response?;
        assert_eq!(
            status,
            StatusCode::OK,
            "duplicate accept must remain usable: {body}"
        );
    }
    let mut joins = 0;
    while let Ok(event) = observer.try_recv() {
        let joined = event.payload["user_id"]
            .as_str()
            .and_then(|id| id.parse::<i64>().ok());
        if event.event_type == "GUILD_MEMBER_ADD" && joined == Some(member) {
            joins += 1;
        }
    }
    assert_eq!(
        joins, 1,
        "only the committed membership insertion emits a join"
    );

    // A distinct member and a legitimate rejoin still consume another use.
    let (other_token, _) = ctx.add_user("secondjoin").await?;
    assert_eq!(
        ctx.request(
            Method::POST,
            "/api/v1/invites/parallel-accept",
            Some(json!({})),
            &other_token
        )
        .await?
        .0,
        StatusCode::OK
    );
    paracord_db::members::remove_member(&ctx.db, member, guild).await?;
    assert_eq!(
        ctx.request(
            Method::POST,
            "/api/v1/invites/parallel-accept",
            Some(json!({})),
            &token
        )
        .await?
        .0,
        StatusCode::OK
    );
    let (uses,): (i32,) = sqlx::query_as("SELECT uses FROM invites WHERE code = 'parallel-accept'")
        .fetch_one(&ctx.db)
        .await?;
    assert_eq!(uses, 3);
    Ok(())
}

#[tokio::test]
async fn unavailable_invite_redemption_rolls_back_reserved_membership() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild = ctx.create_guild("rollback invite").await?;
    let channel: i64 = ctx.create_text_channel(guild, "entry").await?.parse()?;
    let owner = ctx.user_id(&ctx.owner_token).await?;
    let (_, member) = ctx.add_user("failedjoin").await?;
    for (code, exhausted) in [("exhausted-rsv", true), ("expired-rsv", false)] {
        paracord_db::invites::create_invite(
            &ctx.db,
            code,
            guild,
            channel,
            owner,
            Some(1),
            Some(60),
        )
        .await?;
        if exhausted {
            paracord_db::invites::use_invite(&ctx.db, code).await?;
        } else {
            sqlx::query("UPDATE invites SET created_at = '2000-01-01 00:00:00' WHERE code = $1")
                .bind(code)
                .execute(&ctx.db)
                .await?;
        }
        // Model expiry/exhaustion after a route's initial valid preview.
        assert!(paracord_db::invites::redeem_invite_membership(
            &ctx.db, code, member, guild, channel
        )
        .await?
        .is_none());
        assert!(
            paracord_db::members::get_member(&ctx.db, member, guild)
                .await?
                .is_none(),
            "failed redemption left a membership for {code}"
        );
        let (uses,): (i32,) = sqlx::query_as("SELECT uses FROM invites WHERE code = $1")
            .bind(code)
            .fetch_one(&ctx.db)
            .await?;
        assert_eq!(
            uses,
            i32::from(exhausted),
            "failed redemption changed invite accounting"
        );
    }
    Ok(())
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

    // The token is delivered to the bot over the gateway, never to the invoker
    // in the HTTP response, so subscribe before invoking.
    let mut events = ctx._test_app.event_bus.subscribe_system();
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
    let interaction_token = loop {
        let event = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
            .await
            .context("timed out waiting for INTERACTION_CREATE")??;
        if event.event_type == "INTERACTION_CREATE" {
            break event
                .payload
                .get("token")
                .and_then(Value::as_str)
                .context("interaction token")?
                .to_string();
        }
    };

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
    // Publicly list the bot so a non-owner manager may legitimately install it;
    // this test exercises the permission-capping path, not the visibility gate.
    sqlx::query("UPDATE bot_applications SET public_listed = TRUE WHERE id = $1")
        .bind(bot.app_id.parse::<i64>()?)
        .execute(&ctx.db)
        .await?;

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

// ═══════════════════════════════════════════════════════════════════════════
// (10) a blocked user cannot clear the blocker's block via DELETE relationship
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn blocked_user_cannot_delete_blockers_block() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    // Owner ("A") is the blocked party; "B" is the blocker.
    let uid_a = ctx.user_id(&ctx.owner_token).await?;
    let (token_b, uid_b) = ctx.add_user("blocker").await?;

    // B blocks A — stored as a single directional row (B -> A, type=2).
    let (status, _) = ctx
        .request(
            Method::POST,
            "/api/v1/users/@me/relationships",
            Some(json!({ "user_id": uid_a.to_string(), "type": 2 })),
            &token_b,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "block should succeed");
    assert!(
        paracord_db::relationships::is_blocked_either_direction(&ctx.db, uid_a, uid_b).await?,
        "precondition: B's block on A must be in place"
    );

    // A (the blocked party) calls DELETE on the relationship with B. The call
    // succeeds (A has no row of their own to remove) but must NOT touch B's block.
    let (status, _) = ctx
        .request(
            Method::DELETE,
            &format!("/api/v1/users/@me/relationships/{uid_b}"),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "delete should succeed");

    // The block placed by B must still exist.
    let block = paracord_db::relationships::get_relationship(&ctx.db, uid_b, uid_a)
        .await?
        .context("B's block row (B -> A, type=2) must be preserved")?;
    assert_eq!(
        block.rel_type, 2,
        "a blocked user must not be able to clear the blocker's block"
    );
    assert!(
        paracord_db::relationships::is_blocked_either_direction(&ctx.db, uid_a, uid_b).await?,
        "B's block must still be reported after A's DELETE"
    );
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// (11) a genuine mutual unfriend still clears both friend rows
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn mutual_unfriend_removes_both_rows() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let uid_a = ctx.user_id(&ctx.owner_token).await?;
    let (token_b, uid_b) = ctx.add_user("friend").await?;

    // A sends a friend request to B, then B accepts — both directions become friends.
    let (status, _) = ctx
        .request(
            Method::POST,
            "/api/v1/users/@me/relationships",
            Some(json!({ "user_id": uid_b.to_string(), "type": 1 })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = ctx
        .request(
            Method::PUT,
            &format!("/api/v1/users/@me/relationships/{uid_a}"),
            None,
            &token_b,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "accept should succeed");

    // Both friend rows should now exist.
    assert_eq!(
        paracord_db::relationships::get_relationship(&ctx.db, uid_a, uid_b)
            .await?
            .context("A -> B friend row")?
            .rel_type,
        1
    );
    assert_eq!(
        paracord_db::relationships::get_relationship(&ctx.db, uid_b, uid_a)
            .await?
            .context("B -> A friend row")?
            .rel_type,
        1
    );

    // A unfriends B — a mutual friendship, so BOTH rows must be cleared.
    let (status, _) = ctx
        .request(
            Method::DELETE,
            &format!("/api/v1/users/@me/relationships/{uid_b}"),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "unfriend should succeed");

    assert!(
        paracord_db::relationships::get_relationship(&ctx.db, uid_a, uid_b)
            .await?
            .is_none(),
        "A -> B friend row must be removed"
    );
    assert!(
        paracord_db::relationships::get_relationship(&ctx.db, uid_b, uid_a)
            .await?
            .is_none(),
        "B -> A friend row must be removed on a mutual unfriend"
    );
    Ok(())
}
