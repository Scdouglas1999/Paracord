//! Index (docs/index-spec.md §11): the server color (`spaces.hue`) and when
//! each voice member joined (`voice_states.joined_at`).
//!
//! - `PATCH /guilds/{id}` sets the hue (0-359), `null` clears it, out of range
//!   is a 400 and needs Manage Server; guild payloads, READY and
//!   `GUILD_UPDATE` carry it.
//! - `joined_at` is stamped on every join and listen join, kept while the
//!   member stays in the channel (a mode switch or a rejoin), reset by a move,
//!   and carried on voice states in READY and `VOICE_STATE_UPDATE`.
//! - The migration backfills voice states that exist when it runs.
//!
//! Runs on in-memory SQLite by default and on PostgreSQL when
//! `PARACORD_TEST_POSTGRES_URL` is set (see `common::build_test_app`).

mod common;

use std::borrow::Cow;
use std::time::Duration;

use anyhow::Context;
use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
    Router,
};
use chrono::{DateTime, Utc};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use futures_util::StreamExt;
use paracord_contracts::{guild as guild_wire, voice as voice_wire};
use paracord_core::events::ServerEvent;
use serde_json::{json, Value};
use tokio::sync::broadcast::Receiver;
use tower::ServiceExt;

const JWT_SECRET: &str = "index-hue-joined-at-secret";
/// The first migration this package adds; everything before it is the schema
/// a server upgrading to Index starts from.
const INDEX_MIGRATION: i64 = 20261004000001;
/// A `joined_at` far enough in the past that "kept" and "reset" are told apart
/// without sleeping.
const EARLIER: &str = "2026-01-01 00:00:00";

struct Ctx {
    app: TestApp,
    owner_token: String,
    guild_id: i64,
    lounge_id: i64,
    pitch_id: i64,
}

impl Ctx {
    async fn new() -> anyhow::Result<Self> {
        let app = build_test_app(TestAppOptions {
            jwt_secret: JWT_SECRET.to_string(),
            native_media_enabled: true,
            ..Default::default()
        })
        .await?;
        let owner_token =
            create_authenticated_user_token(&app.db, JWT_SECRET, "owner", "OwnerPass123!").await?;
        let mut ctx = Self {
            app,
            owner_token,
            guild_id: 0,
            lounge_id: 0,
            pitch_id: 0,
        };
        let (status, guild) = ctx
            .request(
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": "Game Night", "icon": Value::Null })),
                &ctx.owner_token.clone(),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "{guild}");
        assert_eq!(guild["hue"], Value::Null, "a new server has no color yet");
        assert!(guild.as_object().unwrap().contains_key("hue"), "{guild}");
        ctx.guild_id = guild["id"].as_str().context("guild id")?.parse()?;
        ctx.lounge_id = ctx.voice_channel("Lounge").await?;
        ctx.pitch_id = ctx.voice_channel("Pitch").await?;
        Ok(ctx)
    }

    async fn voice_channel(&self, name: &str) -> anyhow::Result<i64> {
        let (status, channel) = self
            .request(
                Method::POST,
                &format!("/api/v1/guilds/{}/channels", self.guild_id),
                Some(json!({
                    "name": name,
                    "channel_type": 2,
                    "parent_id": Value::Null,
                    "required_role_ids": Value::Null,
                })),
                &self.owner_token,
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "{channel}");
        Ok(channel["id"].as_str().context("channel id")?.parse()?)
    }

    async fn member(&self, prefix: &str) -> anyhow::Result<(String, i64)> {
        let token =
            create_authenticated_user_token(&self.app.db, JWT_SECRET, prefix, "MemberPass123!")
                .await?;
        let user_id = paracord_core::auth::validate_token(&token, JWT_SECRET)?.sub;
        paracord_db::members::add_member(&self.app.db, user_id, self.guild_id).await?;
        self.app
            .state
            .member_index
            .add_member(self.guild_id, user_id);
        Ok((token, user_id))
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        token: &str,
    ) -> anyhow::Result<(StatusCode, Value)> {
        dispatch_json(
            &self.app.app,
            build_json_request(method, path, body, Some(token))?,
        )
        .await
    }

    async fn patch_guild(&self, body: Value, token: &str) -> anyhow::Result<(StatusCode, Value)> {
        self.request(
            Method::PATCH,
            &format!("/api/v1/guilds/{}", self.guild_id),
            Some(body),
            token,
        )
        .await
    }

    async fn stored_hue(&self) -> anyhow::Result<Option<u16>> {
        Ok(paracord_db::guilds::get_guild(&self.app.db, self.guild_id)
            .await?
            .context("the server exists")?
            .hue)
    }

    async fn join(
        &self,
        token: &str,
        channel_id: i64,
        mode: Option<&str>,
    ) -> anyhow::Result<String> {
        let query = mode.map(|mode| format!("?mode={mode}")).unwrap_or_default();
        let (status, body) = self
            .request(
                Method::POST,
                &format!("/api/v2/voice/{channel_id}/join{query}"),
                None,
                token,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "join {mode:?}: {body}");
        Ok(body["session_id"].as_str().context("receipt")?.to_string())
    }

    async fn joined_at(&self, user_id: i64) -> anyhow::Result<DateTime<Utc>> {
        Ok(paracord_db::voice_states::get_user_voice_state(
            &self.app.db,
            user_id,
            Some(self.guild_id),
        )
        .await?
        .context("a voice state")?
        .joined_at)
    }

    /// Move the stored `joined_at` back to [`EARLIER`].
    async fn backdate(&self, user_id: i64) -> anyhow::Result<()> {
        sqlx::query("UPDATE voice_states SET joined_at = $1 WHERE user_id = $2")
            .bind(EARLIER)
            .bind(user_id)
            .execute(&self.app.db)
            .await?;
        Ok(())
    }
}

fn drain(rx: &mut Receiver<ServerEvent>, event_type: &str) -> Vec<Value> {
    let mut out = Vec::new();
    while let Ok(event) = rx.try_recv() {
        if event.event_type == event_type {
            out.push((*event.payload).clone());
        }
    }
    out
}

fn earlier() -> DateTime<Utc> {
    chrono::NaiveDateTime::parse_from_str(EARLIER, "%Y-%m-%d %H:%M:%S")
        .unwrap()
        .and_utc()
}

/// The last `VOICE_STATE_UPDATE` for `user_id`, checked against the contract.
fn last_update_for(rx: &mut Receiver<ServerEvent>, user_id: i64) -> Value {
    let update = drain(rx, "VOICE_STATE_UPDATE")
        .into_iter()
        .rev()
        .find(|update| update["user_id"] == json!(user_id.to_string()))
        .unwrap_or_else(|| panic!("a VOICE_STATE_UPDATE for {user_id}"));
    serde_json::from_value::<voice_wire::VoiceStateSnapshot>(update.clone())
        .unwrap_or_else(|error| panic!("not a snapshot ({error}): {update}"));
    update
}

fn wire_time(update: &Value) -> DateTime<Utc> {
    let raw = update["joined_at"]
        .as_str()
        .unwrap_or_else(|| panic!("joined_at is a string: {update}"));
    DateTime::parse_from_rfc3339(raw)
        .unwrap_or_else(|error| panic!("joined_at is RFC 3339 ({error}): {raw}"))
        .with_timezone(&Utc)
}

/// The SSE transport's READY frame for `token` (the gateway builds the same
/// payload; see `crates/paracord-ws/tests/gateway_integration.rs`).
async fn ready_frame(app: &Router, token: &str) -> anyhow::Result<Value> {
    let (_, session) = dispatch_json(
        app,
        build_json_request(Method::POST, "/api/v2/rt/session", None, Some(token))?,
    )
    .await?;
    let session_id = session["session_id"]
        .as_str()
        .context("rt session")?
        .to_string();
    let (_, ticket) = dispatch_json(
        app,
        build_json_request(Method::POST, "/api/v1/stream/ticket", None, Some(token))?,
    )
    .await?;
    let ticket = ticket["ticket"]
        .as_str()
        .context("stream ticket")?
        .to_string();
    let request = Request::builder()
        .method(Method::GET)
        .uri(format!(
            "/api/v2/rt/events?session_id={session_id}&cursor=0&ticket={ticket}"
        ))
        .header(header::ACCEPT, "text/event-stream")
        .body(Body::empty())?;
    let response = app.clone().oneshot(request).await?;
    let mut stream = response.into_body().into_data_stream();
    let mut buf = String::new();
    loop {
        let chunk = tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .context("a frame arrives")?
            .context("the stream stays open")??;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(idx) = buf.find('\n') {
            let line = buf[..idx].trim().to_string();
            buf.drain(..=idx);
            if let Some(payload) = line.strip_prefix("data:") {
                if let Ok(value) = serde_json::from_str::<Value>(payload.trim()) {
                    if value["t"] == "READY" {
                        return Ok(value);
                    }
                }
            }
        }
    }
}

fn ready_guild(ready: &Value, guild_id: i64) -> Value {
    let guild = ready["d"]["guilds"]
        .as_array()
        .and_then(|guilds| {
            guilds
                .iter()
                .find(|guild| guild["id"] == json!(guild_id.to_string()))
        })
        .unwrap_or_else(|| panic!("READY lists the server: {ready}"))
        .clone();
    serde_json::from_value::<guild_wire::ReadyGuildCore>(guild.clone())
        .unwrap_or_else(|error| panic!("READY guild is not the core contract ({error}): {guild}"));
    guild
}

#[tokio::test]
async fn hue_is_set_kept_cleared_and_carried_on_every_guild_payload() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let mut events = ctx.app.event_bus.subscribe_system();

    let (status, body) = ctx
        .patch_guild(json!({ "hue": 214 }), &ctx.owner_token)
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["hue"], 214);
    serde_json::from_value::<guild_wire::GuildDetail>(body.clone()).context("GuildDetail")?;
    assert_eq!(ctx.stored_hue().await?, Some(214));
    let update = drain(&mut events, "GUILD_UPDATE");
    let update = update.last().context("the change is announced")?;
    assert_eq!(update["hue"], 214, "{update}");

    let (status, detail) = ctx
        .request(
            Method::GET,
            &format!("/api/v1/guilds/{}", ctx.guild_id),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["hue"], 214);
    let (status, list) = ctx
        .request(
            Method::GET,
            "/api/v1/users/@me/guilds",
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{list}");
    serde_json::from_value::<Vec<guild_wire::GuildSummary>>(list.clone())
        .context("GuildSummaryList")?;
    assert_eq!(list[0]["hue"], 214, "{list}");

    let ready = ready_frame(&ctx.app.app, &ctx.owner_token).await?;
    assert_eq!(ready_guild(&ready, ctx.guild_id)["hue"], 214);

    // An update without the field leaves the color alone.
    let (status, body) = ctx
        .patch_guild(json!({ "name": "Game Night 2" }), &ctx.owner_token)
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["hue"], 214, "absent means unchanged");

    // The wheel's ends are both colors.
    for hue in [0, 359] {
        let (status, body) = ctx
            .patch_guild(json!({ "hue": hue }), &ctx.owner_token)
            .await?;
        assert_eq!(status, StatusCode::OK, "{hue}: {body}");
        assert_eq!(body["hue"], hue);
    }

    // `null` clears it, everywhere.
    drain(&mut events, "GUILD_UPDATE");
    let (status, body) = ctx
        .patch_guild(json!({ "hue": null }), &ctx.owner_token)
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["hue"], Value::Null);
    assert!(body.as_object().unwrap().contains_key("hue"), "{body}");
    assert_eq!(ctx.stored_hue().await?, None);
    let update = drain(&mut events, "GUILD_UPDATE");
    let update = update.last().context("the clear is announced")?;
    assert_eq!(update["hue"], Value::Null, "{update}");
    assert!(update.as_object().unwrap().contains_key("hue"));
    let ready = ready_frame(&ctx.app.app, &ctx.owner_token).await?;
    assert_eq!(ready_guild(&ready, ctx.guild_id)["hue"], Value::Null);
    Ok(())
}

#[tokio::test]
async fn hue_outside_the_wheel_is_a_bad_request_and_changes_nothing() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (status, _) = ctx
        .patch_guild(json!({ "hue": 100 }), &ctx.owner_token)
        .await?;
    assert_eq!(status, StatusCode::OK);

    for hue in [json!(360), json!(-1), json!(100_000), json!(i32::MAX)] {
        let (status, body) = ctx
            .patch_guild(json!({ "hue": hue, "name": "Renamed" }), &ctx.owner_token)
            .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{hue}: {body}");
        assert_eq!(ctx.stored_hue().await?, Some(100), "{hue}");
    }
    // Nothing else in a rejected body was written either.
    let guild = paracord_db::guilds::get_guild(&ctx.app.db, ctx.guild_id)
        .await?
        .context("the server")?;
    assert_eq!(guild.name, "Game Night");

    // Not a number at all is refused by the body parser.
    for hue in [json!("12"), json!(1.5), json!([12]), json!(i64::MAX)] {
        let (status, body) = ctx
            .patch_guild(json!({ "hue": hue }), &ctx.owner_token)
            .await?;
        assert!(status.is_client_error(), "{hue}: {status} {body}");
        assert_eq!(ctx.stored_hue().await?, Some(100), "{hue}");
    }

    // The column's CHECK holds even for a write that skips the route.
    assert!(
        paracord_db::guilds::set_space_hue(&ctx.app.db, ctx.guild_id.into(), Some(360))
            .await
            .is_err(),
        "spaces.hue CHECK rejects 360"
    );
    assert_eq!(ctx.stored_hue().await?, Some(100));
    Ok(())
}

#[tokio::test]
async fn hue_needs_manage_server() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (status, _) = ctx
        .patch_guild(json!({ "hue": 22 }), &ctx.owner_token)
        .await?;
    assert_eq!(status, StatusCode::OK);
    let (member_token, _) = ctx.member("member").await?;

    for body in [json!({ "hue": 150 }), json!({ "hue": null })] {
        let (status, response) = ctx.patch_guild(body.clone(), &member_token).await?;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}: {response}");
        assert_eq!(ctx.stored_hue().await?, Some(22), "{body}");
    }
    // A member still reads it.
    let (status, detail) = ctx
        .request(
            Method::GET,
            &format!("/api/v1/guilds/{}", ctx.guild_id),
            None,
            &member_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["hue"], 22);
    Ok(())
}

#[tokio::test]
async fn joined_at_is_stamped_on_join_kept_in_the_channel_and_reset_by_a_move() -> anyhow::Result<()>
{
    let ctx = Ctx::new().await?;
    let (sean, sean_id) = ctx.member("sean").await?;
    let (jeremy, jeremy_id) = ctx.member("jeremy").await?;
    let mut events = ctx.app.event_bus.subscribe_system();

    // A listen join stamps it, and announces the stored time.
    let before = Utc::now() - chrono::Duration::seconds(2);
    let receipt = ctx.join(&sean, ctx.lounge_id, Some("listen")).await?;
    let stored = ctx.joined_at(sean_id).await?;
    assert!(stored >= before && stored <= Utc::now() + chrono::Duration::seconds(2));
    let update = last_update_for(&mut events, sean_id);
    assert_eq!(update["mode"], "listen");
    assert_eq!(wire_time(&update), stored, "{update}");

    // Switching to a full membership in place keeps it.
    ctx.backdate(sean_id).await?;
    let (status, body) = ctx
        .request(
            Method::POST,
            &format!("/api/v2/voice/{}/mode", ctx.lounge_id),
            Some(json!({ "mode": "joined", "session_id": receipt })),
            &sean,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(ctx.joined_at(sean_id).await?, earlier());
    let update = last_update_for(&mut events, sean_id);
    assert_eq!(update["mode"], "joined");
    assert_eq!(wire_time(&update), earlier(), "{update}");

    // So does joining again in the same channel (a new receipt, same room).
    ctx.join(&sean, ctx.lounge_id, None).await?;
    assert_eq!(ctx.joined_at(sean_id).await?, earlier());
    assert_eq!(wire_time(&last_update_for(&mut events, sean_id)), earlier());

    // A full join stamps its own time.
    ctx.join(&jeremy, ctx.lounge_id, None).await?;
    let jeremy_joined = ctx.joined_at(jeremy_id).await?;
    assert!(jeremy_joined > earlier());
    assert_eq!(
        wire_time(&last_update_for(&mut events, jeremy_id)),
        jeremy_joined
    );

    // READY carries both, so a fresh client can work out the room's start
    // (the earliest joined_at among its members).
    let ready = ready_frame(&ctx.app.app, &ctx.owner_token).await?;
    let guild = ready_guild(&ready, ctx.guild_id);
    let states = guild["voice_states"].as_array().context("voice_states")?;
    assert_eq!(states.len(), 2, "{guild}");
    for state in states {
        serde_json::from_value::<voice_wire::VoiceStateSnapshot>(state.clone())
            .with_context(|| format!("READY voice state is a snapshot: {state}"))?;
        let expected = if state["user_id"] == json!(sean_id.to_string()) {
            earlier()
        } else {
            jeremy_joined
        };
        assert_eq!(wire_time(state), expected, "{state}");
    }

    // A move to another channel resets it.
    ctx.join(&sean, ctx.pitch_id, Some("listen")).await?;
    let moved = ctx.joined_at(sean_id).await?;
    assert!(moved > earlier(), "a move resets joined_at: {moved}");
    let update = last_update_for(&mut events, sean_id);
    assert_eq!(update["channel_id"], ctx.pitch_id.to_string());
    assert_eq!(wire_time(&update), moved);

    // Leaving and coming back is a new membership too.
    ctx.backdate(sean_id).await?;
    let (status, body) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/voice/{}/leave", ctx.pitch_id),
            None,
            &sean,
        )
        .await?;
    assert!(status.is_success(), "leave: {status} {body}");
    ctx.join(&sean, ctx.pitch_id, None).await?;
    assert!(ctx.joined_at(sean_id).await? > earlier());
    Ok(())
}

#[tokio::test]
async fn joined_at_on_the_legacy_membership_path_follows_the_same_rule() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (_, sean_id) = ctx.member("sean").await?;
    let db = &ctx.app.db;
    let guild = Some(ctx.guild_id);

    paracord_db::voice_states::upsert_voice_state(db, sean_id, guild, ctx.lounge_id, "a").await?;
    assert!(ctx.joined_at(sean_id).await? > earlier());
    ctx.backdate(sean_id).await?;
    // A repeat in the same channel (a status update without a receipt) keeps it.
    paracord_db::voice_states::upsert_voice_state(db, sean_id, guild, ctx.lounge_id, "b").await?;
    assert_eq!(ctx.joined_at(sean_id).await?, earlier());
    // A flag update keeps it and returns it.
    let row = paracord_db::voice_states::update_voice_state(
        db, sean_id, guild, true, false, false, false,
    )
    .await?
    .context("the row")?;
    assert_eq!(row.joined_at, earlier());
    // A move resets it.
    paracord_db::voice_states::upsert_voice_state(db, sean_id, guild, ctx.pitch_id, "c").await?;
    assert!(ctx.joined_at(sean_id).await? > earlier());
    Ok(())
}

#[tokio::test]
async fn a_dm_call_join_carries_joined_at() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (sean, sean_id) = ctx.member("sean").await?;
    let (_, jeremy_id) = ctx.member("jeremy").await?;
    let dm_id = paracord_util::snowflake::generate(1);
    paracord_db::dms::create_dm_channel(&ctx.app.db, dm_id, sean_id, jeremy_id).await?;
    let mut events = ctx.app.event_bus.subscribe_system();

    let (status, body) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/dms/{dm_id}/voice/join"),
            None,
            &sean,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    let stored = paracord_db::voice_states::get_user_voice_state(&ctx.app.db, sean_id, None)
        .await?
        .context("the DM call membership")?
        .joined_at;
    let update = last_update_for(&mut events, sean_id);
    assert_eq!(update["guild_id"], Value::Null);
    assert_eq!(wire_time(&update), stored, "{update}");
    Ok(())
}

/// The migration adds both columns to a database that already has rows: a
/// server keeps its (unset) color, a call in progress gets the migration time.
#[tokio::test]
async fn the_index_migration_backfills_voice_states_in_progress() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions {
        jwt_secret: JWT_SECRET.to_string(),
        run_migrations: false,
        instance_setup_complete: false,
        ..Default::default()
    })
    .await?;
    let db = &app.db;
    let full = match paracord_db::active_database_engine() {
        paracord_db::DatabaseEngine::Sqlite => sqlx::migrate!("../paracord-db/migrations"),
        paracord_db::DatabaseEngine::Postgres => sqlx::migrate!("../paracord-db/migrations_pg"),
    };
    assert!(
        full.migrations
            .iter()
            .any(|migration| migration.version == INDEX_MIGRATION),
        "the Index migration is in the set"
    );
    let before_index = sqlx::migrate::Migrator {
        migrations: Cow::Owned(
            full.migrations
                .iter()
                .filter(|migration| migration.version < INDEX_MIGRATION)
                .cloned()
                .collect(),
        ),
        ignore_missing: false,
        locking: full.locking,
        no_tx: full.no_tx,
    };
    before_index.run(db).await?;

    // The schema as it stood: no hue, no joined_at.
    let (user_id, guild_id, channel_id) = (9_100_000_001_i64, 9_100_000_002_i64, 9_100_000_003_i64);
    // Raw SQL: this schema also predates `users.credential_version`.
    sqlx::query(
        "INSERT INTO users (id, username, discriminator, email, password_hash)
         VALUES ($1, 'caller', 1, 'caller@example.com', 'hash')",
    )
    .bind(user_id)
    .execute(db)
    .await?;
    sqlx::query(
        "INSERT INTO spaces (id, name, owner_id, visibility) VALUES ($1, $2, $3, 'private')",
    )
    .bind(guild_id)
    .bind("Before Index")
    .bind(user_id)
    .execute(db)
    .await?;
    paracord_db::channels::create_channel(db, channel_id, guild_id, "Lounge", 2, 0, None, None)
        .await?;
    sqlx::query(
        "INSERT INTO voice_states (user_id, space_id, channel_id, session_id)
         VALUES ($1, $2, $3, 'in-progress')",
    )
    .bind(user_id)
    .bind(guild_id)
    .bind(channel_id)
    .execute(db)
    .await?;

    let before = Utc::now() - chrono::Duration::seconds(2);
    paracord_db::run_migrations(db).await?;
    let after = Utc::now() + chrono::Duration::seconds(2);

    let guild = paracord_db::guilds::get_guild(db, guild_id)
        .await?
        .context("the server survives")?;
    assert_eq!(guild.hue, None);
    let row = paracord_db::voice_states::get_user_voice_state(db, user_id, Some(guild_id))
        .await?
        .context("the call in progress survives")?;
    assert!(
        row.joined_at >= before && row.joined_at <= after,
        "backfilled to the migration time: {}",
        row.joined_at
    );
    Ok(())
}
