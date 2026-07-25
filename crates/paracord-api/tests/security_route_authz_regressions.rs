//! Regressions for confirmed authorization defects in the guild-feature routes.
//!
//! Each test pins one exploit that was reachable before the fix:
//!   * scheduled events: cross-guild channel takeover via `event_channel_id`
//!   * economy: privilege escalation via an auto-granted level role
//!   * relationships: a "block" that deleted the victim's block on the actor
//!   * interactions: the bot's interaction token handed to the invoking user

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
use paracord_models::permissions::Permissions;
use serde_json::{json, Value};

struct TestContext {
    app: Router,
    db: paracord_db::DbPool,
    jwt_secret: String,
    owner_token: String,
    test_app: TestApp,
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
            test_app,
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
            .context("user id should be a string")?
            .parse::<i64>()?)
    }

    async fn add_user(&self, prefix: &str) -> anyhow::Result<(String, i64)> {
        let token =
            create_authenticated_user_token(&self.db, &self.jwt_secret, prefix, "MemberPass123!")
                .await?;
        let uid = self.user_id(token.as_str()).await?;
        Ok((token, uid))
    }

    async fn create_guild(&self, name: &str, token: &str) -> anyhow::Result<i64> {
        let (status, payload) = self
            .request(
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": name, "icon": Value::Null })),
                token,
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
            .parse::<i64>()?)
    }

    async fn create_text_channel(
        &self,
        guild_id: i64,
        name: &str,
        token: &str,
    ) -> anyhow::Result<i64> {
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
                token,
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
            .parse::<i64>()?)
    }

    async fn create_role(
        &self,
        guild_id: i64,
        name: &str,
        permissions: i64,
        token: &str,
    ) -> anyhow::Result<i64> {
        let (status, payload) = self
            .request(
                Method::POST,
                &format!("/api/v1/guilds/{guild_id}/roles"),
                Some(json!({ "name": name, "permissions": permissions })),
                token,
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "create role failed: {payload}");
        Ok(payload["id"]
            .as_str()
            .context("role id should be a string")?
            .parse::<i64>()?)
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// CRITICAL: cross-guild channel takeover through scheduled events
// ═══════════════════════════════════════════════════════════════════════════

/// The background event worker deletes `event_channel_id` by id alone whenever
/// `event_channel_created` is set. Both create and update accepted a raw
/// integer for that field, so an attacker could aim it at a channel in a guild
/// they do not control and have the worker destroy it (cascading its messages).
#[tokio::test]
async fn scheduled_event_rejects_channel_from_another_guild() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;

    // Victim guild, owned by someone else, with a channel the attacker wants gone.
    let (victim_token, _victim_uid) = ctx.add_user("victim").await?;
    let victim_guild = ctx.create_guild("Victim Guild", &victim_token).await?;
    let victim_channel = ctx
        .create_text_channel(victim_guild, "secrets", &victim_token)
        .await?;

    // Attacker's own guild, where they legitimately hold MANAGE_GUILD.
    let attacker_guild = ctx.create_guild("Attacker Guild", &ctx.owner_token).await?;
    let attacker_channel = ctx
        .create_text_channel(attacker_guild, "events", &ctx.owner_token)
        .await?;

    // 1. Create must refuse a foreign `event_channel_id`.
    let (status, payload) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/guilds/{attacker_guild}/events"),
            Some(json!({
                "name": "Takeover",
                "scheduled_start": "2030-01-01T00:00:00Z",
                "entity_type": 2,
                "event_channel_id": victim_channel.to_string(),
            })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "create must reject a foreign event_channel_id: {payload}"
    );

    // 2. Create must equally refuse a foreign location `channel_id`.
    let (status, payload) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/guilds/{attacker_guild}/events"),
            Some(json!({
                "name": "Takeover",
                "scheduled_start": "2030-01-01T00:00:00Z",
                "entity_type": 2,
                "channel_id": victim_channel.to_string(),
            })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "create must reject a foreign channel_id: {payload}"
    );

    // A legitimate, same-guild event is still accepted.
    let (status, event) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/guilds/{attacker_guild}/events"),
            Some(json!({
                "name": "Legit",
                "scheduled_start": "2030-01-01T00:00:00Z",
                "entity_type": 2,
                "channel_id": attacker_channel.to_string(),
            })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "legit create failed: {event}");
    let event_id = event["id"].as_str().context("event id")?.to_string();

    // 3. The PATCH path -- the actual reported exploit -- must refuse too.
    let (status, payload) = ctx
        .request(
            Method::PATCH,
            &format!("/api/v1/guilds/{attacker_guild}/events/{event_id}"),
            Some(json!({
                "event_channel_id": victim_channel.to_string(),
                "scheduled_end": "2020-01-01T00:00:00Z",
            })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "update must reject a foreign event_channel_id: {payload}"
    );

    // The victim's channel is untouched and the event never adopted it.
    assert!(
        paracord_db::channels::get_channel(&ctx.db, victim_channel)
            .await?
            .is_some(),
        "victim channel must still exist"
    );
    let stored = paracord_db::scheduled_events::get_event(&ctx.db, event_id.parse()?)
        .await?
        .context("event should still exist")?;
    assert_ne!(
        stored.event_channel_id,
        Some(victim_channel),
        "event must not reference a channel outside its guild"
    );
    Ok(())
}

/// Re-pointing `event_channel_id` at a pre-existing channel must clear
/// `event_channel_created`, otherwise the worker would later delete a channel
/// it never created.
#[tokio::test]
async fn repointing_event_channel_clears_worker_created_flag() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Flag Guild", &ctx.owner_token).await?;
    let auto_channel = ctx
        .create_text_channel(guild_id, "auto", &ctx.owner_token)
        .await?;
    let existing_channel = ctx
        .create_text_channel(guild_id, "existing", &ctx.owner_token)
        .await?;

    let (status, event) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/events"),
            Some(json!({
                "name": "Flagged",
                "scheduled_start": "2030-01-01T00:00:00Z",
                "entity_type": 2,
            })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "create failed: {event}");
    let event_id: i64 = event["id"].as_str().context("event id")?.parse()?;

    // Simulate the worker provisioning its own discussion channel.
    paracord_db::scheduled_events::set_event_channel(&ctx.db, event_id, auto_channel, true).await?;

    let (status, updated) = ctx
        .request(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/events/{event_id}"),
            Some(json!({ "event_channel_id": existing_channel.to_string() })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "update failed: {updated}");
    assert_eq!(updated["event_channel_created"], json!(false));

    let stored = paracord_db::scheduled_events::get_event(&ctx.db, event_id)
        .await?
        .context("event should exist")?;
    assert_eq!(stored.event_channel_id, Some(existing_channel));
    assert!(
        !stored.event_channel_created,
        "an operator-supplied channel must never be marked worker-created"
    );
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// HIGH: privilege escalation via economy level roles
// ═══════════════════════════════════════════════════════════════════════════

/// Level-role mappings auto-grant the mapped role to every member who reaches
/// the level. A MANAGE_GUILD moderator could therefore map the ADMINISTRATOR
/// role to level 0 and escalate on their next message.
#[tokio::test]
async fn level_role_mapping_rejects_roles_the_actor_cannot_assign() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx.create_guild("Economy Guild", &ctx.owner_token).await?;

    let admin_role = ctx
        .create_role(
            guild_id,
            "Admin",
            Permissions::ADMINISTRATOR.bits(),
            &ctx.owner_token,
        )
        .await?;
    let ban_role = ctx
        .create_role(
            guild_id,
            "Banhammer",
            Permissions::BAN_MEMBERS.bits(),
            &ctx.owner_token,
        )
        .await?;
    let harmless_role = ctx
        .create_role(guild_id, "Regular", 0, &ctx.owner_token)
        .await?;

    // The moderator holds MANAGE_GUILD only.
    let mod_role = ctx
        .create_role(
            guild_id,
            "Moderator",
            Permissions::MANAGE_GUILD.bits(),
            &ctx.owner_token,
        )
        .await?;
    let (mod_token, mod_uid) = ctx.add_user("moderator").await?;
    paracord_db::members::add_member(&ctx.db, mod_uid, guild_id).await?;
    paracord_db::roles::add_member_role(&ctx.db, mod_uid, guild_id, mod_role).await?;

    for (label, role_id) in [("administrator", admin_role), ("ban", ban_role)] {
        let (status, payload) = ctx
            .request(
                Method::PUT,
                &format!("/api/v1/guilds/{guild_id}/economy/level-roles"),
                Some(json!({
                    "mappings": [{ "level": 0, "role_id": role_id.to_string() }]
                })),
                &mod_token,
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "moderator must not map the {label} role: {payload}"
        );
    }

    // Nothing was persisted by the rejected attempts.
    let mappings = paracord_db::economy::list_level_roles(&ctx.db, guild_id).await?;
    assert!(
        mappings.is_empty(),
        "a rejected mapping request must not persist anything: {mappings:?}"
    );

    // A role carrying no permissions the moderator lacks is still allowed.
    let (status, payload) = ctx
        .request(
            Method::PUT,
            &format!("/api/v1/guilds/{guild_id}/economy/level-roles"),
            Some(json!({
                "mappings": [{ "level": 5, "role_id": harmless_role.to_string() }]
            })),
            &mod_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::OK,
        "an assignable role must still be mappable: {payload}"
    );
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// HIGH: blocking someone must not delete their block on you
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn blocking_does_not_clear_the_targets_block() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let (alice_token, alice_uid) = ctx.add_user("alice").await?;
    let (mallory_token, mallory_uid) = ctx.add_user("mallory").await?;

    // Alice blocks Mallory.
    let (status, payload) = ctx
        .request(
            Method::POST,
            "/api/v1/users/@me/relationships",
            Some(json!({ "user_id": mallory_uid.to_string(), "type": 2 })),
            &alice_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "alice block failed: {payload}"
    );

    // Mallory "blocks" Alice back, then immediately unblocks. Before the fix
    // the first step deleted Alice's block row, so the second left no block at
    // all in either direction.
    let (status, payload) = ctx
        .request(
            Method::POST,
            "/api/v1/users/@me/relationships",
            Some(json!({ "user_id": alice_uid.to_string(), "type": 2 })),
            &mallory_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "mallory block failed: {payload}"
    );

    let alice_row =
        paracord_db::relationships::get_relationship(&ctx.db, alice_uid, mallory_uid).await?;
    assert_eq!(
        alice_row.map(|r| r.rel_type),
        Some(2),
        "alice's block must survive mallory blocking her"
    );

    let (status, payload) = ctx
        .request(
            Method::DELETE,
            &format!("/api/v1/users/@me/relationships/{alice_uid}"),
            None,
            &mallory_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "mallory unblock failed: {payload}"
    );

    let alice_row =
        paracord_db::relationships::get_relationship(&ctx.db, alice_uid, mallory_uid).await?;
    assert_eq!(
        alice_row.map(|r| r.rel_type),
        Some(2),
        "alice's block must survive mallory's block-then-unblock cycle"
    );
    assert!(
        paracord_db::relationships::is_blocked_either_direction(&ctx.db, alice_uid, mallory_uid)
            .await?,
        "a block must still be in force after the cycle"
    );
    Ok(())
}

/// Blocking still performs its legitimate housekeeping: a friendship the target
/// held toward the blocker is cleared.
#[tokio::test]
async fn blocking_still_clears_a_reverse_friendship() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let (alice_token, alice_uid) = ctx.add_user("alice").await?;
    let (bob_token, bob_uid) = ctx.add_user("bob").await?;

    // Bob sends a request, Alice accepts -> mutual friendship.
    let (status, _) = ctx
        .request(
            Method::POST,
            "/api/v1/users/@me/relationships",
            Some(json!({ "user_id": alice_uid.to_string(), "type": 1 })),
            &bob_token,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = ctx
        .request(
            Method::PUT,
            &format!("/api/v1/users/@me/relationships/{bob_uid}"),
            None,
            &alice_token,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Alice blocks Bob; Bob's friend row toward Alice must be dropped.
    let (status, _) = ctx
        .request(
            Method::POST,
            "/api/v1/users/@me/relationships",
            Some(json!({ "user_id": bob_uid.to_string(), "type": 2 })),
            &alice_token,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);

    assert!(
        paracord_db::relationships::get_relationship(&ctx.db, bob_uid, alice_uid)
            .await?
            .is_none(),
        "a reverse friendship must be cleared when the other side blocks"
    );
    assert_eq!(
        paracord_db::relationships::get_relationship(&ctx.db, alice_uid, bob_uid)
            .await?
            .map(|r| r.rel_type),
        Some(2),
        "the block itself must be recorded"
    );
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// HIGH: the interaction token must never reach the invoking user
// ═══════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn invoking_a_command_does_not_hand_the_user_the_bot_token() -> anyhow::Result<()> {
    let ctx = TestContext::new().await?;
    let guild_id = ctx
        .create_guild("Interaction Guild", &ctx.owner_token)
        .await?;
    let channel_id = ctx
        .create_text_channel(guild_id, "chat", &ctx.owner_token)
        .await?;

    // VIEW_CHANNEL | SEND_MESSAGES install grant.
    let (status, bot) = ctx
        .request(
            Method::POST,
            "/api/v1/bots/applications",
            Some(json!({
                "name": "TokenBot",
                "description": "leak check",
                "permissions": "3072",
            })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "create bot failed: {bot}");
    let app_id = bot["id"].as_str().context("app id")?.to_string();

    let (status, payload) = ctx
        .request(
            Method::POST,
            "/api/v1/oauth2/authorize",
            Some(json!({ "application_id": app_id, "guild_id": guild_id.to_string() })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "authorize failed: {payload}");

    let (status, payload) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/applications/{app_id}/commands"),
            Some(json!({ "name": "ping", "description": "ping" })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "create command failed: {payload}"
    );

    // A plain member with no elevated permissions runs the command.
    let (member_token, member_uid) = ctx.add_user("plain").await?;
    paracord_db::members::add_member(&ctx.db, member_uid, guild_id).await?;
    paracord_db::roles::add_member_role(&ctx.db, member_uid, guild_id, guild_id).await?;

    let mut events = ctx.test_app.event_bus.subscribe_system();
    let (status, interaction) = ctx
        .request(
            Method::POST,
            "/api/v1/interactions",
            Some(json!({
                "command_name": "ping",
                "guild_id": guild_id.to_string(),
                "channel_id": channel_id.to_string(),
                "type": 2,
                "options": [],
            })),
            &member_token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "invoke failed: {interaction}");

    // The credential must not be anywhere in the invoker's response...
    assert!(
        interaction.get("token").is_none(),
        "interaction token must not be returned to the invoking user: {interaction}"
    );
    assert!(
        !interaction.to_string().contains("\"token\""),
        "no token field of any kind may appear in the response: {interaction}"
    );

    // ...but the bot still receives it over the gateway.
    let gateway_token = loop {
        let event = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
            .await
            .context("timed out waiting for INTERACTION_CREATE")??;
        if event.event_type == "INTERACTION_CREATE" {
            break event
                .payload
                .get("token")
                .and_then(Value::as_str)
                .context("the bot's INTERACTION_CREATE must carry the token")?
                .to_string();
        }
    };
    assert!(!gateway_token.is_empty());

    // And the token really is a credential for acting as the bot, which is why
    // it must not be disclosed: used here it posts as the bot.
    let interaction_id = interaction["id"].as_str().context("interaction id")?;
    let request = build_json_request(
        Method::POST,
        &format!("/api/v1/interactions/{interaction_id}/{gateway_token}/callback"),
        Some(json!({ "type": 4, "data": { "content": "pong" } })),
        None,
    )?;
    let (status, payload) = dispatch_json(&ctx.app, request).await?;
    assert_eq!(status, StatusCode::OK, "bot callback failed: {payload}");
    Ok(())
}
