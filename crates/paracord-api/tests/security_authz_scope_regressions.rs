//! Regressions for authorization defects found in the guild-management,
//! moderation, webhook, template and interaction routes.
//!
//! Each test pins one exploit that worked before the fix:
//!   * webhooks: a per-channel MANAGE_WEBHOOKS deny was unenforceable, so a
//!     token for a denied channel could still be minted (F5)
//!   * reports: GUILD_REPORT_* fanned out to every session in the space,
//!     including the reported user (F2)
//!   * commands: `default_member_permissions` was stored but never gated (F3)
//!   * guild templates: apply enforced no visibility rule at all (F8)
//!   * moderation templates: MOD_ACTION_NOTICE reachable for any account on the
//!     instance, and kick/ban reasons broadcast guild-wide (F9, F11)
//!   * the bot install-permission cap was bypassed on ~20 guild gates (F6)
//!   * interaction callbacks skipped authorization (F4)
//!   * CHANGE_NICKNAME was never enforced (F10)
//!   * voice: `stop_stream` had no membership check and leave events omitted
//!     `prior_channel_id` (F14, F7)

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
use paracord_core::events::ServerEvent;
use paracord_models::permissions::Permissions;
use serde_json::{json, Value};
use tokio::sync::broadcast::Receiver;

const OVERWRITE_TARGET_ROLE: i16 = 0;

struct Ctx {
    app: Router,
    db: paracord_db::DbPool,
    jwt_secret: String,
    owner_token: String,
    owner_id: i64,
    test_app: TestApp,
}

impl Ctx {
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
        let mut ctx = Self {
            app: test_app.app.clone(),
            db: test_app.db.clone(),
            jwt_secret: test_app.jwt_secret.clone(),
            owner_token,
            owner_id: 0,
            test_app,
        };
        ctx.owner_id = ctx.user_id(&ctx.owner_token.clone()).await?;
        Ok(ctx)
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

    async fn request_no_auth(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let request = build_json_request(method, path, body, None)?;
        dispatch_json(&self.app, request).await
    }

    /// Authenticate as a bot application: the gateway accepts `Bot <token>`
    /// alongside `Bearer <jwt>`, and it is the only way a bot reaches a route.
    async fn request_as_bot(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        bot_token: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        use axum::body::Body;
        use axum::http::{header, Request};
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header(header::AUTHORIZATION, format!("Bot {bot_token}"));
        let request = if let Some(payload) = body {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            builder.body(Body::from(payload.to_string()))?
        } else {
            builder.body(Body::empty())?
        };
        dispatch_json(&self.app, request).await
    }

    async fn user_id(&self, token: &str) -> anyhow::Result<i64> {
        let (status, payload) = self
            .request(Method::GET, "/api/v1/users/@me", None, token)
            .await?;
        assert_eq!(status, StatusCode::OK, "fetch @me failed: {payload}");
        Ok(payload["id"].as_str().context("user id")?.parse::<i64>()?)
    }

    async fn add_user(&self, prefix: &str) -> anyhow::Result<(String, i64)> {
        let token =
            create_authenticated_user_token(&self.db, &self.jwt_secret, prefix, "MemberPass123!")
                .await?;
        let uid = self.user_id(&token).await?;
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
        assert_eq!(status, StatusCode::CREATED, "create guild: {payload}");
        Ok(payload["id"].as_str().context("guild id")?.parse::<i64>()?)
    }

    async fn create_channel(
        &self,
        guild_id: i64,
        name: &str,
        channel_type: i16,
        token: &str,
    ) -> anyhow::Result<i64> {
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
                token,
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "create channel: {payload}");
        Ok(payload["id"]
            .as_str()
            .context("channel id")?
            .parse::<i64>()?)
    }

    async fn create_role(
        &self,
        guild_id: i64,
        name: &str,
        permissions: Permissions,
        token: &str,
    ) -> anyhow::Result<i64> {
        let (status, payload) = self
            .request(
                Method::POST,
                &format!("/api/v1/guilds/{guild_id}/roles"),
                Some(json!({ "name": name, "permissions": permissions.bits() })),
                token,
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "create role: {payload}");
        Ok(payload["id"].as_str().context("role id")?.parse::<i64>()?)
    }

    /// Join `user_id` to `guild_id` and give them `role_id`.
    async fn join_with_role(
        &self,
        guild_id: i64,
        user_id: i64,
        role_id: Option<i64>,
    ) -> anyhow::Result<()> {
        paracord_db::members::add_member(&self.db, user_id, guild_id).await?;
        self.test_app
            .state
            .member_index
            .add_member(guild_id, user_id);
        if let Some(role_id) = role_id {
            paracord_db::roles::add_member_role(&self.db, user_id, guild_id, role_id).await?;
        }
        Ok(())
    }

    async fn deny_on_channel(
        &self,
        channel_id: i64,
        target_id: i64,
        deny: Permissions,
    ) -> anyhow::Result<()> {
        let (status, payload) = self
            .request(
                Method::PUT,
                &format!("/api/v1/channels/{channel_id}/overwrites/{target_id}"),
                Some(json!({
                    "target_type": OVERWRITE_TARGET_ROLE,
                    "allow_perms": 0,
                    "deny_perms": deny.bits(),
                })),
                &self.owner_token,
            )
            .await?;
        assert!(
            status.is_success(),
            "upsert channel overwrite: {status} {payload}"
        );
        Ok(())
    }
}

/// Drain a session receiver into `(event_type, payload)` pairs.
///
/// `try_recv` consumes, so anything not collected here is gone — always drain
/// once and filter the result rather than draining per event type.
fn drain_all(rx: &mut Receiver<ServerEvent>) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    while let Ok(event) = rx.try_recv() {
        out.push((event.event_type.clone(), (*event.payload).clone()));
    }
    out
}

/// Drain a session receiver and return the payloads of matching events.
fn drain(rx: &mut Receiver<ServerEvent>, event_type: &str) -> Vec<Value> {
    drain_all(rx)
        .into_iter()
        .filter(|(ty, _)| ty == event_type)
        .map(|(_, payload)| payload)
        .collect()
}

/// Payloads of `event_type` inside an already-drained batch.
fn only<'a>(events: &'a [(String, Value)], event_type: &str) -> Vec<&'a Value> {
    events
        .iter()
        .filter(|(ty, _)| ty == event_type)
        .map(|(_, payload)| payload)
        .collect()
}

// ═══════════════════════════════════════════════════════════════════════════
// F5: a per-channel MANAGE_WEBHOOKS deny must actually block
// ═══════════════════════════════════════════════════════════════════════════

/// `require_manage_webhooks` folded guild role bits, so a channel overwrite that
/// denied MANAGE_WEBHOOKS was a no-op on every webhook route. The proven exploit
/// used `create_webhook`, whose `channel_id` comes from the request body: a role
/// granted MANAGE_WEBHOOKS space-wide but denied it on `#general` could still
/// mint a webhook there, receive its token, and post under an arbitrary name.
#[tokio::test]
async fn channel_deny_blocks_webhook_creation_in_that_channel() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let guild_id = ctx.create_guild("Webhook Guild", &ctx.owner_token).await?;
    let general = ctx
        .create_channel(guild_id, "general", 0, &ctx.owner_token)
        .await?;
    let lounge = ctx
        .create_channel(guild_id, "lounge", 0, &ctx.owner_token)
        .await?;

    // A role that legitimately holds MANAGE_WEBHOOKS across the space...
    let integrator = ctx
        .create_role(
            guild_id,
            "Integrator",
            Permissions::VIEW_CHANNEL | Permissions::MANAGE_WEBHOOKS,
            &ctx.owner_token,
        )
        .await?;
    let (agent_token, agent_id) = ctx.add_user("integrator").await?;
    ctx.join_with_role(guild_id, agent_id, Some(integrator))
        .await?;

    // ...but explicitly denied it in #general.
    ctx.deny_on_channel(general, integrator, Permissions::MANAGE_WEBHOOKS)
        .await?;

    let (status, payload) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/webhooks"),
            Some(json!({ "name": "Server Admin", "channel_id": general.to_string() })),
            &agent_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a channel deny must block minting a webhook there: {payload}"
    );
    assert!(
        payload.get("token").is_none(),
        "no webhook token may be handed out on a denied channel: {payload}"
    );

    // The deny is per channel, not a blanket revocation: #lounge still works.
    let (status, payload) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/webhooks"),
            Some(json!({ "name": "Lounge Hook", "channel_id": lounge.to_string() })),
            &agent_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "an undenied channel must still accept a webhook: {payload}"
    );
    let webhook_id = payload["id"].as_str().context("webhook id")?.to_string();

    // Nothing was persisted for #general.
    let stored = paracord_db::webhooks::get_channel_webhooks(&ctx.db, general).await?;
    assert!(
        stored.is_empty(),
        "no webhook row may exist in the denied channel: {stored:?}"
    );

    // And the read/update/delete surface is channel-scoped too: move the lounge
    // webhook's channel to #general and the same actor loses access to it.
    sqlx::query("UPDATE webhooks SET channel_id = $1 WHERE id = $2")
        .bind(general)
        .bind(webhook_id.parse::<i64>()?)
        .execute(&ctx.db)
        .await?;
    let (status, payload) = ctx
        .request(
            Method::GET,
            &format!("/api/v1/webhooks/{webhook_id}"),
            None,
            &agent_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "reading a webhook in a denied channel must be refused: {payload}"
    );

    Ok(())
}

/// `stage.rs` had the same shape as the webhook gate for MANAGE_CHANNELS: every
/// stage operation names one stage channel, but the check folded guild role bits
/// so a per-channel deny could not stop it.
#[tokio::test]
async fn channel_deny_blocks_stage_management_in_that_channel() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let guild_id = ctx.create_guild("Stage Guild", &ctx.owner_token).await?;
    // channel_type 13 = stage
    let stage_channel = ctx
        .create_channel(guild_id, "town-hall", 13, &ctx.owner_token)
        .await?;

    let host = ctx
        .create_role(
            guild_id,
            "Host",
            Permissions::VIEW_CHANNEL | Permissions::MANAGE_CHANNELS,
            &ctx.owner_token,
        )
        .await?;
    let (host_token, host_id) = ctx.add_user("host").await?;
    ctx.join_with_role(guild_id, host_id, Some(host)).await?;
    ctx.deny_on_channel(stage_channel, host, Permissions::MANAGE_CHANNELS)
        .await?;

    let (status, payload) = ctx
        .request(
            Method::POST,
            "/api/v1/stage-instances",
            Some(json!({ "channel_id": stage_channel.to_string(), "topic": "hijack" })),
            &host_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a channel deny must block opening a stage there: {payload}"
    );
    assert!(
        paracord_db::stage_instances::get_stage_instance_by_channel(&ctx.db, stage_channel)
            .await?
            .is_none(),
        "no stage instance may have been created"
    );

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// F2: moderation reports are for moderators, not the whole space
// ═══════════════════════════════════════════════════════════════════════════

/// `report_entry_to_json` emits no top-level `channel_id`, so the gateway's
/// per-channel VIEW_CHANNEL filter has nothing to key on and skips filtering;
/// `EventBus::publish` then delivered `GUILD_REPORT_CREATE` to every session in
/// the guild. A plain member — including the *reported* member — received the
/// reporter's identity and the confidential reason in real time.
#[tokio::test]
async fn report_events_reach_moderators_only() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let guild_id = ctx.create_guild("Report Guild", &ctx.owner_token).await?;
    let channel_id = ctx
        .create_channel(guild_id, "general", 0, &ctx.owner_token)
        .await?;

    let (reporter_token, reporter_id) = ctx.add_user("reporter").await?;
    ctx.join_with_role(guild_id, reporter_id, None).await?;
    let (_bystander_token, bystander_id) = ctx.add_user("bystander").await?;
    ctx.join_with_role(guild_id, bystander_id, None).await?;
    let (_accused_token, accused_id) = ctx.add_user("accused").await?;
    ctx.join_with_role(guild_id, accused_id, None).await?;

    let mut bystander_rx = ctx
        .test_app
        .event_bus
        .register_session("bystander-session", bystander_id, &[guild_id])
        .context("bystander session registers")?;
    let mut accused_rx = ctx
        .test_app
        .event_bus
        .register_session("accused-session", accused_id, &[guild_id])
        .context("accused session registers")?;
    let mut owner_rx = ctx
        .test_app
        .event_bus
        .register_session("owner-session", ctx.owner_id, &[guild_id])
        .context("owner session registers")?;

    let (status, report) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/reports"),
            Some(json!({
                "target_type": "user",
                "target_id": accused_id.to_string(),
                "reported_user_id": accused_id.to_string(),
                "channel_id": channel_id.to_string(),
                "reason": "confidential-moderator-only-reason",
            })),
            &reporter_token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "create report: {report}");
    let report_id = report["id"].as_str().context("report id")?.to_string();

    let leaked_to_bystander = drain(&mut bystander_rx, "GUILD_REPORT_CREATE");
    assert!(
        leaked_to_bystander.is_empty(),
        "a plain member must not receive moderation reports: {leaked_to_bystander:?}"
    );
    let leaked_to_accused = drain(&mut accused_rx, "GUILD_REPORT_CREATE");
    assert!(
        leaked_to_accused.is_empty(),
        "the reported member must never learn they were reported: {leaked_to_accused:?}"
    );

    // The moderator (here the owner) still gets it — the fix scopes delivery,
    // it does not silence the event.
    let delivered = drain(&mut owner_rx, "GUILD_REPORT_CREATE");
    assert_eq!(
        delivered.len(),
        1,
        "a moderator must still receive the report: {delivered:?}"
    );
    assert_eq!(delivered[0]["reporter_id"], json!(reporter_id.to_string()));

    // Resolution has the same shape and the same exposure.
    let (status, resolved) = ctx
        .request(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/reports/{report_id}"),
            Some(json!({ "action": "dismiss", "note": "internal moderator note" })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "resolve report: {resolved}");

    let leaked_update = drain(&mut bystander_rx, "GUILD_REPORT_UPDATE");
    assert!(
        leaked_update.is_empty(),
        "report resolutions must not fan out guild-wide: {leaked_update:?}"
    );
    assert_eq!(
        drain(&mut owner_rx, "GUILD_REPORT_UPDATE").len(),
        1,
        "a moderator must still receive the resolution"
    );

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// F3: `default_member_permissions` must gate invocation
// ═══════════════════════════════════════════════════════════════════════════

/// The field was written, validated and returned by the command CRUD routes but
/// never read as a gate: `invoke_interaction` only checked guild membership plus
/// VIEW_CHANNEL. A default-role member could therefore run a command registered
/// with `default_member_permissions: "8"` (ADMINISTRATOR).
#[tokio::test]
async fn admin_only_command_is_not_invocable_by_a_plain_member() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let guild_id = ctx.create_guild("Command Guild", &ctx.owner_token).await?;
    let channel_id = ctx
        .create_channel(guild_id, "general", 0, &ctx.owner_token)
        .await?;

    // VIEW_CHANNEL | SEND_MESSAGES so the bot can respond.
    let (status, app) = ctx
        .request(
            Method::POST,
            "/api/v1/bots/applications",
            Some(json!({ "name": "GateBot", "permissions": "3072" })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "create bot app: {app}");
    let app_id = app["id"].as_str().context("app id")?.to_string();

    let (status, payload) = ctx
        .request(
            Method::POST,
            "/api/v1/oauth2/authorize",
            Some(json!({ "application_id": app_id, "guild_id": guild_id.to_string() })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "authorize bot: {payload}");

    let (status, payload) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/applications/{app_id}/commands"),
            Some(json!({
                "name": "purge",
                "description": "destructive admin command",
                "default_member_permissions": Permissions::ADMINISTRATOR.bits().to_string(),
            })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "create command: {payload}");
    assert_eq!(
        payload["default_member_permissions"],
        json!(Permissions::ADMINISTRATOR.bits().to_string()),
        "the field must still round-trip: {payload}"
    );

    let (member_token, member_id) = ctx.add_user("plain").await?;
    ctx.join_with_role(guild_id, member_id, None).await?;

    let (status, payload) = ctx
        .request(
            Method::POST,
            "/api/v1/interactions",
            Some(json!({
                "command_name": "purge",
                "guild_id": guild_id.to_string(),
                "channel_id": channel_id.to_string(),
                "type": 2,
                "options": [],
            })),
            &member_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "an ADMINISTRATOR-gated command must not dispatch for a default member: {payload}"
    );

    // Autocomplete resolves the same command and must not be a way around it.
    let (status, payload) = ctx
        .request(
            Method::POST,
            "/api/v1/interactions",
            Some(json!({
                "command_name": "purge",
                "guild_id": guild_id.to_string(),
                "channel_id": channel_id.to_string(),
                "type": 4,
                "options": [],
            })),
            &member_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "autocomplete must honour the same gate: {payload}"
    );

    // The command is hidden from the member's picker, but still listed for a
    // caller who actually holds the bits.
    let (status, listed) = ctx
        .request(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/commands"),
            None,
            &member_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "list commands: {listed}");
    assert!(
        !listed
            .as_array()
            .context("commands list")?
            .iter()
            .any(|c| c["name"] == json!("purge")),
        "an admin-only command must not be listed for a plain member: {listed}"
    );

    // The owner (administrator by ownership) can still invoke it.
    let (status, payload) = ctx
        .request(
            Method::POST,
            "/api/v1/interactions",
            Some(json!({
                "command_name": "purge",
                "guild_id": guild_id.to_string(),
                "channel_id": channel_id.to_string(),
                "type": 2,
                "options": [],
            })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "an administrator must still be able to invoke it: {payload}"
    );

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// F8: applying a guild template must obey the same visibility rule as listing
// ═══════════════════════════════════════════════════════════════════════════

/// `get_by_id` filters on id alone. `list_templates` was hardened to filter by
/// membership and `delete_template` enforces `creator_id`, but apply enforced
/// neither — so a stranger could materialize a victim's full channel tree plus
/// every role name and raw permission bitmask out of a template they were never
/// allowed to see.
#[tokio::test]
async fn applying_a_template_requires_visibility_of_it() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;

    // The victim snapshots a space with a distinctive private structure.
    let victim_guild = ctx.create_guild("Victim HQ", &ctx.owner_token).await?;
    ctx.create_channel(victim_guild, "board-secrets", 0, &ctx.owner_token)
        .await?;
    ctx.create_role(
        victim_guild,
        "Board",
        Permissions::MANAGE_GUILD | Permissions::BAN_MEMBERS,
        &ctx.owner_token,
    )
    .await?;
    let (status, tmpl) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/guilds/{victim_guild}/template"),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "snapshot template: {tmpl}");
    let template_id = tmpl["id"].as_str().context("template id")?.to_string();

    // A stranger: not the creator, not a member of the source guild.
    let (attacker_token, _attacker_id) = ctx.add_user("stranger").await?;

    // Listing already hid it...
    let (status, listed) = ctx
        .request(Method::GET, "/api/v1/templates", None, &attacker_token)
        .await?;
    assert_eq!(status, StatusCode::OK, "list templates: {listed}");
    assert!(
        listed.as_array().context("templates list")?.is_empty(),
        "a stranger must not see the victim's template: {listed}"
    );

    // ...so applying it must be refused too, and with the same 404 that keeps
    // the template's existence unconfirmed.
    let (status, payload) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/templates/{template_id}/apply"),
            Some(json!({ "name": "Stolen Structure" })),
            &attacker_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "a stranger must not be able to apply a template they cannot see: {payload}"
    );

    let stored = paracord_db::guild_templates::get_by_id(&ctx.db, template_id.parse()?)
        .await?
        .context("template should still exist")?;
    assert_eq!(
        stored.usage_count, 0,
        "the refused apply must not have counted as a use"
    );

    // A member of the source guild may still apply it — the rule is visibility,
    // not creator-only.
    let (member_token, member_id) = ctx.add_user("insider").await?;
    ctx.join_with_role(victim_guild, member_id, None).await?;
    let (status, payload) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/templates/{template_id}/apply"),
            Some(json!({ "name": "Insider Copy" })),
            &member_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "a member of the source guild must still be able to apply: {payload}"
    );

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// F9 / F11: moderation templates
// ═══════════════════════════════════════════════════════════════════════════

/// `apply_template` gated on the *actor's* own guild and then did a bare
/// `get_user_by_id`. The WARN branch changes no state, so it never reached the
/// membership/hierarchy checks inside `paracord_core::admin`, and the closing
/// `dispatch_to_users` routes purely by user id — so anyone could stand up a
/// space and push attacker-authored text onto a stranger's socket.
#[tokio::test]
async fn moderation_template_cannot_target_a_non_member() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;

    // The attacker's own space, where they are legitimately the owner.
    let (attacker_token, _attacker_id) = ctx.add_user("attacker").await?;
    let attacker_guild = ctx.create_guild("Attacker Space", &attacker_token).await?;

    // A stranger who has never heard of that space.
    let (_victim_token, victim_id) = ctx.add_user("stranger").await?;
    let mut victim_rx = ctx
        .test_app
        .event_bus
        .register_session("victim-session", victim_id, &[])
        .context("victim session registers")?;

    let (status, tmpl) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/guilds/{attacker_guild}/moderation/templates"),
            Some(json!({
                "name": "Notice",
                "action_type": 1,
                "reason_template": "{reason}",
                "dm_template": "attacker-authored text delivered to your socket",
            })),
            &attacker_token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "create template: {tmpl}");
    let template_id = tmpl["id"].as_str().context("template id")?.to_string();

    let (status, payload) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/guilds/{attacker_guild}/moderation/templates/{template_id}/apply"),
            Some(json!({ "target_user_id": victim_id.to_string(), "reason": "spam" })),
            &attacker_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "a moderation template must not apply to a non-member: {payload}"
    );

    let leaked = drain(&mut victim_rx, "MOD_ACTION_NOTICE");
    assert!(
        leaked.is_empty(),
        "no account outside the acting space may receive MOD_ACTION_NOTICE: {leaked:?}"
    );

    Ok(())
}

/// The guild-scoped `GUILD_MEMBER_REMOVE` / `GUILD_BAN_ADD` emitted by
/// `apply_template` carried the moderator's private `reason`, unlike the
/// dedicated ban route which deliberately omits it.
#[tokio::test]
async fn kick_and_ban_events_do_not_broadcast_the_moderator_reason() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let guild_id = ctx.create_guild("Mod Guild", &ctx.owner_token).await?;

    let (_kicked_token, kicked_id) = ctx.add_user("kicked").await?;
    ctx.join_with_role(guild_id, kicked_id, None).await?;
    let (_banned_token, banned_id) = ctx.add_user("banned").await?;
    ctx.join_with_role(guild_id, banned_id, None).await?;
    let (_watcher_token, watcher_id) = ctx.add_user("watcher").await?;
    ctx.join_with_role(guild_id, watcher_id, None).await?;

    let mut watcher_rx = ctx
        .test_app
        .event_bus
        .register_session("watcher-session", watcher_id, &[guild_id])
        .context("watcher session registers")?;

    for (name, action_type) in [("Kick", 3), ("Ban", 4)] {
        let (status, tmpl) = ctx
            .request(
                Method::POST,
                &format!("/api/v1/guilds/{guild_id}/moderation/templates"),
                Some(json!({
                    "name": name,
                    "action_type": action_type,
                    "reason_template": "{reason}",
                })),
                &ctx.owner_token,
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "create template: {tmpl}");
        let template_id = tmpl["id"].as_str().context("template id")?.to_string();

        let target = if action_type == 3 {
            kicked_id
        } else {
            banned_id
        };
        let (status, payload) = ctx
            .request(
                Method::POST,
                &format!("/api/v1/guilds/{guild_id}/moderation/templates/{template_id}/apply"),
                Some(json!({
                    "target_user_id": target.to_string(),
                    "reason": "private-moderator-justification",
                })),
                &ctx.owner_token,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "apply {name} template: {payload}");
    }

    let received = drain_all(&mut watcher_rx);
    for event_type in ["GUILD_MEMBER_REMOVE", "GUILD_BAN_ADD"] {
        let events = only(&received, event_type);
        assert!(
            !events.is_empty(),
            "expected a {event_type}: {:?}",
            received.iter().map(|(ty, _)| ty).collect::<Vec<_>>()
        );
        for payload in events {
            assert!(
                payload.get("reason").is_none(),
                "{event_type} must not broadcast the moderator's reason: {payload}"
            );
        }
    }

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// F6: the bot install-permission cap applies on guild gates
// ═══════════════════════════════════════════════════════════════════════════

/// Guild-scoped gates folded raw role bits, which cannot apply the bot
/// install-permission cap: a bot installed with `permissions=0` but holding a
/// privileged role exercised that role's full authority.
#[tokio::test]
async fn bot_install_permission_cap_applies_to_guild_gates() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let guild_id = ctx.create_guild("Bot Cap Guild", &ctx.owner_token).await?;

    let (status, app) = ctx
        .request(
            Method::POST,
            "/api/v1/bots/applications",
            Some(json!({ "name": "CapBot", "permissions": "0" })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "create bot app: {app}");
    let app_id = app["id"].as_str().context("app id")?.to_string();
    let bot_token = app["token"].as_str().context("bot token")?.to_string();
    let bot_user_id = app["bot_user_id"]
        .as_str()
        .context("bot_user_id")?
        .parse::<i64>()?;

    // Installed with permissions=0.
    let (status, payload) = ctx
        .request(
            Method::POST,
            "/api/v1/oauth2/authorize",
            Some(json!({
                "application_id": app_id,
                "guild_id": guild_id.to_string(),
                "permissions": "0",
            })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "authorize bot: {payload}");
    assert_eq!(
        paracord_db::bot_applications::get_bot_install_permissions_by_user(
            &ctx.db,
            bot_user_id,
            guild_id
        )
        .await?,
        Some(0),
        "the bot must be installed with no permissions"
    );

    // ...but handed a role that carries real authority.
    let staff = ctx
        .create_role(
            guild_id,
            "Staff",
            Permissions::VIEW_CHANNEL
                | Permissions::MANAGE_ROLES
                | Permissions::BAN_MEMBERS
                | Permissions::VIEW_AUDIT_LOG
                | Permissions::MANAGE_GUILD
                | Permissions::MANAGE_EMOJIS,
            &ctx.owner_token,
        )
        .await?;
    paracord_db::roles::add_member_role(&ctx.db, bot_user_id, guild_id, staff).await?;

    // Sanity: the raw role fold — what every one of these gates used to call —
    // still hands the bot full authority. Only the capped primitive refuses.
    let roles = paracord_db::roles::get_member_roles(&ctx.db, bot_user_id, guild_id).await?;
    assert!(
        paracord_core::permissions::compute_permissions_from_roles(
            &roles,
            ctx.owner_id,
            bot_user_id
        )
        .contains(Permissions::MANAGE_ROLES),
        "the fixture must reproduce the pre-fix input: a role that grants MANAGE_ROLES"
    );
    assert!(
        paracord_core::permissions::compute_guild_permissions(
            &ctx.db,
            guild_id,
            ctx.owner_id,
            bot_user_id
        )
        .await?
        .is_empty(),
        "the install cap must reduce a permissions=0 bot to nothing"
    );

    // One representative gate per migrated family.
    let denied: [(&str, Method, Option<Value>); 7] = [
        (
            "roles",
            Method::POST,
            Some(json!({ "name": "Escalation", "permissions": 0 })),
        ),
        ("bans", Method::GET, None),
        ("audit-logs", Method::GET, None),
        ("invites", Method::GET, None),
        ("webhooks", Method::GET, None),
        ("automod/rules", Method::GET, None),
        ("moderation/templates", Method::GET, None),
    ];
    for (segment, method, body) in denied {
        let (status, payload) = ctx
            .request_as_bot(
                method,
                &format!("/api/v1/guilds/{guild_id}/{segment}"),
                body,
                &bot_token,
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "/{segment} must refuse a permissions=0 bot: {payload}"
        );
    }

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// F4: interaction callbacks must be authorized
// ═══════════════════════════════════════════════════════════════════════════

/// Callback type 5 (DEFERRED) did no install check, no channel check and no
/// permission compute at all, yet it writes a bot message into the interaction's
/// channel and broadcasts MESSAGE_CREATE for it. Types 4 and 7 checked
/// VIEW_CHANNEL but never SEND_MESSAGES.
#[tokio::test]
async fn interaction_callbacks_require_the_bot_to_be_able_to_send() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let guild_id = ctx.create_guild("Callback Guild", &ctx.owner_token).await?;
    let channel_id = ctx
        .create_channel(guild_id, "general", 0, &ctx.owner_token)
        .await?;

    let (status, app) = ctx
        .request(
            Method::POST,
            "/api/v1/bots/applications",
            Some(json!({ "name": "DeferBot", "permissions": "3072" })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "create bot app: {app}");
    let app_id = app["id"].as_str().context("app id")?.to_string();
    let bot_user_id = app["bot_user_id"]
        .as_str()
        .context("bot_user_id")?
        .parse::<i64>()?;

    let (status, payload) = ctx
        .request(
            Method::POST,
            "/api/v1/oauth2/authorize",
            Some(json!({ "application_id": app_id, "guild_id": guild_id.to_string() })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "authorize bot: {payload}");

    let (status, payload) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/applications/{app_id}/commands"),
            Some(json!({ "name": "ping", "description": "ping" })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "create command: {payload}");

    // The owner invokes it and the bot picks the token off the gateway.
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
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "invoke: {interaction}");
    let interaction_id = interaction["id"].as_str().context("interaction id")?;

    let mut token = None;
    while let Ok(event) = events.try_recv() {
        if event.event_type == "INTERACTION_CREATE" {
            token = event
                .payload
                .get("token")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
    }
    let token = token.context("bot should have received the interaction token")?;

    // Now revoke the bot's ability to speak in that channel. The token is still
    // valid — authorization has to be re-evaluated at callback time.
    let bot_member_overwrite = json!({
        "target_type": 1,
        "allow_perms": 0,
        "deny_perms": Permissions::SEND_MESSAGES.bits(),
    });
    let (status, payload) = ctx
        .request(
            Method::PUT,
            &format!("/api/v1/channels/{channel_id}/overwrites/{bot_user_id}"),
            Some(bot_member_overwrite),
            &ctx.owner_token,
        )
        .await?;
    assert!(status.is_success(), "deny bot SEND_MESSAGES: {payload}");

    let before = paracord_db::messages::get_channel_messages(&ctx.db, channel_id, None, None, 100)
        .await?
        .len();

    let (status, payload) = ctx
        .request_no_auth(
            Method::POST,
            &format!("/api/v1/interactions/{interaction_id}/{token}/callback"),
            Some(json!({ "type": 5 })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a deferral must not place a message where the bot cannot send: {payload}"
    );

    let (status, payload) = ctx
        .request_no_auth(
            Method::POST,
            &format!("/api/v1/interactions/{interaction_id}/{token}/callback"),
            Some(json!({ "type": 4, "data": { "content": "hi" } })),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a message callback must not bypass SEND_MESSAGES: {payload}"
    );

    let after = paracord_db::messages::get_channel_messages(&ctx.db, channel_id, None, None, 100)
        .await?
        .len();
    assert_eq!(
        before, after,
        "no message may have been written by the refused callbacks"
    );

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// F10: CHANGE_NICKNAME
// ═══════════════════════════════════════════════════════════════════════════

/// The self-nickname branch of `update_member` checked nothing, so revoking
/// CHANGE_NICKNAME from @everyone had no effect anywhere on the instance, and a
/// timed-out member could keep rewriting their guild-visible label.
#[tokio::test]
async fn self_nickname_requires_change_nickname_and_no_timeout() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let guild_id = ctx.create_guild("Nick Guild", &ctx.owner_token).await?;
    let (member_token, member_id) = ctx.add_user("nickuser").await?;
    ctx.join_with_role(guild_id, member_id, None).await?;

    // Baseline: the default @everyone grant includes CHANGE_NICKNAME.
    let (status, payload) = ctx
        .request(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/members/{member_id}"),
            Some(json!({ "nick": "Allowed" })),
            &member_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "baseline self-rename: {payload}");

    // A timed-out member must not rewrite their label.
    paracord_db::members::set_member_timeout(
        &ctx.db,
        member_id,
        guild_id,
        Some(chrono::Utc::now() + chrono::Duration::hours(1)),
    )
    .await?;
    let (status, payload) = ctx
        .request(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/members/{member_id}"),
            Some(json!({ "nick": "DuringTimeout" })),
            &member_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a timed-out member must not rename themselves: {payload}"
    );
    paracord_db::members::set_member_timeout(&ctx.db, member_id, guild_id, None).await?;

    // Revoking the bit from @everyone must actually take effect.
    let everyone = Permissions::default() & !Permissions::CHANGE_NICKNAME;
    let (status, payload) = ctx
        .request(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/roles/{guild_id}"),
            Some(json!({ "permissions": everyone.bits() })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "revoke CHANGE_NICKNAME: {payload}");

    let (status, payload) = ctx
        .request(
            Method::PATCH,
            &format!("/api/v1/guilds/{guild_id}/members/{member_id}"),
            Some(json!({ "nick": "Forbidden" })),
            &member_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "revoking CHANGE_NICKNAME must block self-rename: {payload}"
    );

    let member = paracord_db::members::get_member(&ctx.db, member_id, guild_id)
        .await?
        .context("member row")?;
    assert_eq!(
        member.nick.as_deref(),
        Some("Allowed"),
        "the refused renames must not have landed"
    );

    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// F14 / F7: voice
// ═══════════════════════════════════════════════════════════════════════════

/// `stop_stream` checked only the channel type, then dispatched a guild-wide
/// VOICE_STATE_UPDATE naming the caller — so any authenticated account could
/// forge a voice state for a channel it is not even a member of.
#[tokio::test]
async fn stop_stream_requires_membership_and_channel_visibility() -> anyhow::Result<()> {
    let ctx = Ctx::with_options(TestAppOptions {
        livekit_available: true,
        ..Default::default()
    })
    .await?;
    let guild_id = ctx.create_guild("Voice Guild", &ctx.owner_token).await?;
    let channel_id = ctx
        .create_channel(guild_id, "stage-room", 2, &ctx.owner_token)
        .await?;

    // A complete outsider.
    let (outsider_token, outsider_id) = ctx.add_user("outsider").await?;
    let mut owner_rx = ctx
        .test_app
        .event_bus
        .register_session("voice-owner-session", ctx.owner_id, &[guild_id])
        .context("owner session registers")?;

    let (status, payload) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/voice/{channel_id}/stream/stop"),
            None,
            &outsider_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a non-member must not be able to stop a stream: {payload}"
    );
    assert!(
        drain(&mut owner_rx, "VOICE_STATE_UPDATE").is_empty(),
        "the refused call must not have forged a voice state"
    );

    // A member who is denied VIEW_CHANNEL is refused too.
    let (denied_token, denied_id) = ctx.add_user("denied").await?;
    ctx.join_with_role(guild_id, denied_id, None).await?;
    ctx.deny_on_channel(channel_id, guild_id, Permissions::VIEW_CHANNEL)
        .await?;
    let (status, payload) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/voice/{channel_id}/stream/stop"),
            None,
            &denied_token,
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a member denied VIEW_CHANNEL must not be able to stop a stream: {payload}"
    );
    assert_ne!(outsider_id, denied_id);

    Ok(())
}

/// A voice leave carries a null `channel_id`, so `prior_channel_id` is the only
/// field the gateway's per-channel VIEW_CHANNEL filter can key on. Omitting it
/// made every leave fan out guild-wide, disclosing presence in hidden voice
/// channels whose matching join was correctly filtered.
#[tokio::test]
async fn voice_leave_carries_prior_channel_id() -> anyhow::Result<()> {
    let ctx = Ctx::with_options(TestAppOptions {
        livekit_available: true,
        ..Default::default()
    })
    .await?;
    let guild_id = ctx.create_guild("Leave Guild", &ctx.owner_token).await?;
    let channel_id = ctx
        .create_channel(guild_id, "hidden-voice", 2, &ctx.owner_token)
        .await?;

    let mut events = ctx.test_app.event_bus.subscribe_system();

    let (status, payload) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/voice/{channel_id}/leave"),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT, "leave voice: {payload}");

    let mut leaves = Vec::new();
    while let Ok(event) = events.try_recv() {
        if event.event_type == "VOICE_STATE_UPDATE" && event.payload["channel_id"].is_null() {
            leaves.push((*event.payload).clone());
        }
    }
    assert_eq!(leaves.len(), 1, "expected one leave event: {leaves:?}");
    assert_eq!(
        leaves[0]["prior_channel_id"],
        json!(channel_id.to_string()),
        "a leave must name the channel it departed so the gateway can filter it: {:?}",
        leaves[0]
    );

    // The eviction path (kick/ban) emits the same shape.
    let (_evicted_token, evicted_id) = ctx.add_user("evicted").await?;
    ctx.join_with_role(guild_id, evicted_id, None).await?;
    paracord_db::voice_states::upsert_voice_state(
        &ctx.db,
        evicted_id,
        Some(guild_id),
        channel_id,
        "evicted-session",
    )
    .await?;

    let mut events = ctx.test_app.event_bus.subscribe_system();
    paracord_api::routes::voice::evict_user_from_guild_media(
        &ctx.test_app.state,
        guild_id,
        evicted_id,
    )
    .await;

    let mut evictions = Vec::new();
    while let Ok(event) = events.try_recv() {
        if event.event_type == "VOICE_STATE_UPDATE" && event.payload["channel_id"].is_null() {
            evictions.push((*event.payload).clone());
        }
    }
    assert_eq!(
        evictions.len(),
        1,
        "expected one eviction leave event: {evictions:?}"
    );
    assert_eq!(
        evictions[0]["prior_channel_id"],
        json!(channel_id.to_string()),
        "an eviction leave must also name the departed channel: {:?}",
        evictions[0]
    );

    Ok(())
}
