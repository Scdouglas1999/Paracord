//! Screen share and voice state in DM and group DM calls
//! (docs/design/glass-fix-dm-calls.md).
//!
//! A DM call has no guild. Its recipients may share a screen into it and watch
//! each other's share (through the call, or as a view session when they are
//! not in it); nobody else may, and there is no ambient view (the room light is
//! for servers). Every voice state and watcher count of a DM call goes to the
//! DM's recipients and to nobody else, over both realtime transports, and
//! READY lists the people in a recipient's ongoing DM calls.
//!
//! Runs on in-memory SQLite by default and on PostgreSQL when
//! `PARACORD_TEST_POSTGRES_URL` is set (see `common::build_test_app`).

mod common;

use std::time::Duration;

use anyhow::Context;
use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use futures_util::StreamExt;
use paracord_contracts::voice as wire;
use paracord_core::events::ServerEvent;
use serde_json::{json, Value};
use tokio::sync::broadcast::Receiver;
use tower::ServiceExt;

const JWT_SECRET: &str = "dm-call-streams-secret";
/// `relationships.rel_type` for a block.
const BLOCKED: i16 = 2;

struct Person {
    token: String,
    id: i64,
}

struct Ctx {
    app: TestApp,
    jeremy: Person,
    sean: Person,
    /// Not a recipient of any DM here.
    outsider: Person,
    dm_id: i64,
}

impl Ctx {
    async fn new() -> anyhow::Result<Self> {
        let app = build_test_app(TestAppOptions {
            jwt_secret: JWT_SECRET.to_string(),
            native_media_enabled: true,
            ..Default::default()
        })
        .await?;
        let jeremy = person(&app, "jeremy").await?;
        let sean = person(&app, "sean").await?;
        let outsider = person(&app, "outsider").await?;
        let dm_id = paracord_util::snowflake::generate(1);
        paracord_db::dms::create_dm_channel(&app.db, dm_id, jeremy.id, sean.id).await?;
        Ok(Self {
            app,
            jeremy,
            sean,
            outsider,
            dm_id,
        })
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

    async fn join(&self, who: &Person, channel_id: i64) -> anyhow::Result<String> {
        let (status, body) = self
            .request(
                Method::POST,
                &format!("/api/v1/dms/{channel_id}/voice/join"),
                None,
                &who.token,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "DM join: {body}");
        Ok(body["session_id"].as_str().context("receipt")?.to_string())
    }

    async fn stream(
        &self,
        who: &Person,
        channel_id: i64,
        receipt: Option<&str>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let query = receipt
            .map(|receipt| format!("?session_id={receipt}"))
            .unwrap_or_default();
        self.request(
            Method::POST,
            &format!("/api/v1/voice/{channel_id}/stream{query}"),
            Some(json!({ "quality_preset": "720p30" })),
            &who.token,
        )
        .await
    }

    async fn stop_stream(&self, who: &Person, channel_id: i64) -> anyhow::Result<StatusCode> {
        let (status, _) = self
            .request(
                Method::POST,
                &format!("/api/v1/voice/{channel_id}/stream/stop"),
                None,
                &who.token,
            )
            .await?;
        Ok(status)
    }

    async fn view(
        &self,
        who: &Person,
        channel_id: i64,
        kind: &str,
        streamer: i64,
    ) -> anyhow::Result<(StatusCode, Value)> {
        self.request(
            Method::POST,
            &format!("/api/v2/voice/{channel_id}/view"),
            Some(json!({ "kind": kind, "user_id": streamer.to_string() })),
            &who.token,
        )
        .await
    }

    async fn voice_state(&self, who: &Person, body: Value) -> anyhow::Result<(StatusCode, Value)> {
        // The SSE transport's command (`POST /api/v2/voice/state` is the
        // `voice_state_update` realtime command).
        self.request(
            Method::POST,
            "/api/v2/rt/commands",
            Some(json!({
                "command_id": format!("cmd-{}", uuid::Uuid::new_v4()),
                "type": "voice_state_update",
                "payload": body,
            })),
            &who.token,
        )
        .await
    }

    fn native(&self) -> &paracord_core::NativeMediaState {
        self.app
            .state
            .native_media
            .as_ref()
            .expect("native media is on in this context")
    }
}

async fn person(app: &TestApp, prefix: &str) -> anyhow::Result<Person> {
    let token =
        create_authenticated_user_token(&app.db, JWT_SECRET, prefix, "DmCallPass123!").await?;
    let id = paracord_core::auth::validate_token(&token, JWT_SECRET)?.sub;
    Ok(Person { token, id })
}

/// Every `event_type` event published so far, with its audience.
fn drain(rx: &mut Receiver<ServerEvent>, event_type: &str) -> Vec<ServerEvent> {
    let mut out = Vec::new();
    while let Ok(event) = rx.try_recv() {
        if event.event_type == event_type {
            out.push(event);
        }
    }
    out
}

/// The event went to exactly `expected` (sorted), never to a guild or to
/// everyone.
fn assert_recipients_only(event: &ServerEvent, expected: &[i64]) {
    assert_eq!(event.guild_id, None, "a DM call event has no guild");
    let mut targets = event
        .target_user_ids
        .clone()
        .expect("a DM call event targets the DM's recipients, never everyone");
    targets.sort_unstable();
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    assert_eq!(targets, expected);
}

fn assert_snapshot(payload: &Value) {
    serde_json::from_value::<wire::VoiceStateSnapshot>(payload.clone()).unwrap_or_else(|error| {
        panic!("VOICE_STATE_UPDATE is not a snapshot ({error}): {payload}")
    });
}

#[tokio::test]
async fn a_dm_recipient_shares_into_the_call_and_nobody_else_may() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let jeremy_call = ctx.join(&ctx.jeremy, ctx.dm_id).await?;
    let _sean_call = ctx.join(&ctx.sean, ctx.dm_id).await?;
    let mut events = ctx.app.event_bus.subscribe_system();

    // Somebody who is not a recipient may not share into the DM's call.
    let (status, body) = ctx.stream(&ctx.outsider, ctx.dm_id, None).await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(drain(&mut events, "VOICE_STATE_UPDATE").is_empty());

    // A recipient in the call shares; the share is announced to the DM only.
    let (status, body) = ctx
        .stream(&ctx.jeremy, ctx.dm_id, Some(&jeremy_call))
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["native_media"], true);
    let row = paracord_db::voice_states::get_user_voice_state(&ctx.app.db, ctx.jeremy.id, None)
        .await?
        .context("Jeremy's DM call voice state")?;
    assert!(row.self_stream && row.self_stream_started_at.is_some());
    let updates = drain(&mut events, "VOICE_STATE_UPDATE");
    let update = updates.last().context("the share is announced")?;
    assert_recipients_only(update, &[ctx.jeremy.id, ctx.sean.id]);
    assert_eq!(update.payload["self_stream"], true);
    assert_eq!(update.payload["guild_id"], Value::Null);
    assert_eq!(update.payload["channel_id"], ctx.dm_id.to_string());
    assert_snapshot(&update.payload);

    // A stale receipt is refused like a server call's.
    let (status, _) = ctx
        .stream(&ctx.jeremy, ctx.dm_id, Some("an-older-call"))
        .await?;
    assert_eq!(status, StatusCode::CONFLICT);

    // A recipient may not stop a share they do not have; nobody else may touch it.
    assert_eq!(
        ctx.stop_stream(&ctx.outsider, ctx.dm_id).await?,
        StatusCode::FORBIDDEN
    );

    // Stopping is announced to the DM only, and keeps the other flags.
    assert_eq!(
        ctx.stop_stream(&ctx.jeremy, ctx.dm_id).await?,
        StatusCode::NO_CONTENT
    );
    let updates = drain(&mut events, "VOICE_STATE_UPDATE");
    let update = updates.last().context("the stop is announced")?;
    assert_recipients_only(update, &[ctx.jeremy.id, ctx.sean.id]);
    assert_eq!(update.payload["self_stream"], false);
    assert_eq!(update.payload["self_stream_started_at"], Value::Null);
    Ok(())
}

#[tokio::test]
async fn a_block_stops_a_share_in_a_one_to_one_dm() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let jeremy_call = ctx.join(&ctx.jeremy, ctx.dm_id).await?;
    paracord_db::relationships::create_relationship(
        &ctx.app.db,
        ctx.sean.id,
        ctx.jeremy.id,
        BLOCKED,
    )
    .await?;
    let (status, body) = ctx
        .stream(&ctx.jeremy, ctx.dm_id, Some(&jeremy_call))
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    Ok(())
}

#[tokio::test]
async fn a_dm_recipient_in_the_call_watches_through_it() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let jeremy_call = ctx.join(&ctx.jeremy, ctx.dm_id).await?;
    let sean_call = ctx.join(&ctx.sean, ctx.dm_id).await?;
    let (status, _) = ctx
        .stream(&ctx.jeremy, ctx.dm_id, Some(&jeremy_call))
        .await?;
    assert_eq!(status, StatusCode::OK);
    let mut events = ctx.app.event_bus.subscribe_system();

    let (status, body) = ctx
        .view(&ctx.sean, ctx.dm_id, "watch", ctx.jeremy.id)
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    let view: wire::VoiceViewSession = serde_json::from_value(body.clone())?;
    assert!(view.via_membership, "{body}");
    assert_eq!(view.guild_id, None, "a DM call has no guild: {body}");
    assert!(view.media.is_none() && view.session_id.is_none());
    let room = ctx
        .native()
        .rooms
        .get_room_by_channel(0, ctx.dm_id)
        .context("the DM call's relay room")?;
    assert_eq!(
        room.participants
            .get(&ctx.sean.id)
            .map(|p| p.session_id.clone()),
        Some(sean_call.clone()),
        "Sean watches through his own call membership"
    );

    // The watcher count goes to the DM's recipients only, with no guild.
    let update = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.recv().await?;
            if event.event_type == "VOICE_WATCHERS_UPDATE" {
                return anyhow::Ok(event);
            }
        }
    })
    .await
    .context("a VOICE_WATCHERS_UPDATE arrives")??;
    assert_recipients_only(&update, &[ctx.jeremy.id, ctx.sean.id]);
    let counts: wire::VoiceWatchers = serde_json::from_value((*update.payload).clone())?;
    assert_eq!(counts.guild_id, None);
    assert_eq!(counts.channel_id, ctx.dm_id.to_string());
    assert_eq!(counts.streams.len(), 1);
    assert_eq!(counts.streams[0].user_id, ctx.jeremy.id.to_string());

    // The counts read back for a recipient, never for anybody else.
    let (status, body) = ctx
        .request(
            Method::GET,
            &format!("/api/v2/voice/{}/watchers", ctx.dm_id),
            None,
            &ctx.sean.token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    let counts: wire::VoiceWatchers = serde_json::from_value(body)?;
    assert_eq!(counts.guild_id, None);
    let (status, _) = ctx
        .request(
            Method::GET,
            &format!("/api/v2/voice/{}/watchers", ctx.dm_id),
            None,
            &ctx.outsider.token,
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Stopping the watch is scoped to the call it rides.
    let (status, _) = ctx
        .request(
            Method::DELETE,
            &format!("/api/v2/voice/{}/view?session_id={sean_call}", ctx.dm_id),
            None,
            &ctx.sean.token,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);
    Ok(())
}

#[tokio::test]
async fn only_recipients_watch_a_dm_share_and_there_is_no_room_light() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    // A group DM: Jeremy and Sean are in the call, Luke is a recipient who is not.
    let luke = person(&ctx.app, "luke").await?;
    let group_id = paracord_util::snowflake::generate(1);
    paracord_db::dms::create_group_dm_channel(
        &ctx.app.db,
        group_id,
        Some("Friday"),
        ctx.jeremy.id,
        &[ctx.sean.id, luke.id],
    )
    .await?;
    let jeremy_call = ctx.join(&ctx.jeremy, group_id).await?;
    ctx.join(&ctx.sean, group_id).await?;
    let (status, body) = ctx
        .stream(&ctx.jeremy, group_id, Some(&jeremy_call))
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Not a recipient: no watch, no counts.
    let (status, body) = ctx
        .view(&ctx.outsider, group_id, "watch", ctx.jeremy.id)
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    // The room light is for servers.
    let (status, body) = ctx.view(&luke, group_id, "ambient", ctx.jeremy.id).await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    // Somebody who is not sharing has nothing to watch.
    let (status, _) = ctx.view(&luke, group_id, "watch", ctx.sean.id).await?;
    assert_eq!(status, StatusCode::CONFLICT);

    // A recipient outside the call watches as a view session in the DM's room.
    let (status, body) = ctx.view(&luke, group_id, "watch", ctx.jeremy.id).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    let view: wire::VoiceViewSession = serde_json::from_value(body.clone())?;
    assert!(!view.via_membership);
    assert_eq!(view.guild_id, None);
    let media = view.media.context("a view session's media")?;
    assert_eq!(media.room_name, format!("0:{group_id}"));
    let receipt = view.session_id.context("a view receipt")?;
    let viewer = ctx
        .native()
        .rooms
        .get_room_by_channel(0, group_id)
        .and_then(|room| room.participants.get(&luke.id).cloned())
        .context("Luke is in the relay room as a viewer")?;
    assert!(viewer.is_viewer());
    assert_eq!(viewer.session_id, receipt);
    // The view never shows Luke in the call.
    assert!(
        paracord_db::voice_states::get_user_voice_state(&ctx.app.db, luke.id, None)
            .await?
            .is_none()
    );
    assert_eq!(
        ctx.native()
            .rooms
            .resolve_view_admission(luke.id, &receipt, Some(&media.room_name)),
        Some(format!("0:{group_id}")),
        "the media endpoint admits the view's token to the DM's room"
    );

    // Still a recipient: the sweep keeps the view.
    assert_eq!(
        paracord_api::routes::voice::revoke_views_without_access(&ctx.app.state).await,
        0
    );
    // Removed from the group DM: the next sweep ends the view.
    paracord_db::dms::remove_group_dm_recipient(&ctx.app.db, group_id, luke.id).await?;
    assert_eq!(
        paracord_api::routes::voice::revoke_views_without_access(&ctx.app.state).await,
        1
    );
    assert!(ctx.native().rooms.view_for_user(luke.id).is_none());
    Ok(())
}

#[tokio::test]
async fn dm_voice_state_updates_reach_the_recipients_only() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let jeremy_call = ctx.join(&ctx.jeremy, ctx.dm_id).await?;
    let mut events = ctx.app.event_bus.subscribe_system();

    // Jeremy mutes and turns his camera on.
    let (status, body) = ctx
        .voice_state(
            &ctx.jeremy,
            json!({
                "session_id": jeremy_call,
                "guild_id": Value::Null,
                "channel_id": ctx.dm_id.to_string(),
                "self_mute": true,
                "self_deaf": false,
                "self_video": true,
            }),
        )
        .await?;
    assert!(status.is_success(), "{status} {body}");
    let row = paracord_db::voice_states::get_user_voice_state(&ctx.app.db, ctx.jeremy.id, None)
        .await?
        .context("Jeremy's DM call voice state")?;
    assert!(row.self_mute && row.self_video && !row.self_deaf);
    let updates = drain(&mut events, "VOICE_STATE_UPDATE");
    assert_eq!(updates.len(), 1, "one announcement");
    assert_recipients_only(&updates[0], &[ctx.jeremy.id, ctx.sean.id]);
    assert_eq!(updates[0].payload["self_mute"], true);
    assert_eq!(updates[0].payload["self_video"], true);
    assert_eq!(updates[0].payload["session_id"], jeremy_call);
    assert_snapshot(&updates[0].payload);

    // A mute while sharing keeps the share.
    let (status, _) = ctx
        .stream(&ctx.jeremy, ctx.dm_id, Some(&jeremy_call))
        .await?;
    assert_eq!(status, StatusCode::OK);
    drain(&mut events, "VOICE_STATE_UPDATE");
    let (status, _) = ctx
        .voice_state(
            &ctx.jeremy,
            json!({ "session_id": jeremy_call, "channel_id": ctx.dm_id.to_string(),
                    "self_mute": false, "self_video": true }),
        )
        .await?;
    assert!(status.is_success());
    let updates = drain(&mut events, "VOICE_STATE_UPDATE");
    assert_eq!(
        updates[0].payload["self_stream"], true,
        "{}",
        updates[0].payload
    );

    // An older receipt, someone outside the DM, a recipient who is not in the
    // call, and a guild that does not match are all refused, unannounced.
    let (status, _) = ctx
        .voice_state(
            &ctx.jeremy,
            json!({ "session_id": "an-older-call", "channel_id": ctx.dm_id.to_string(), "self_mute": true }),
        )
        .await?;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = ctx
        .voice_state(
            &ctx.outsider,
            json!({ "channel_id": ctx.dm_id.to_string(), "self_mute": true }),
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = ctx
        .voice_state(
            &ctx.sean,
            json!({ "channel_id": ctx.dm_id.to_string(), "self_mute": true }),
        )
        .await?;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "a status update never joins a DM call"
    );
    assert!(
        paracord_db::voice_states::get_user_voice_state(&ctx.app.db, ctx.sean.id, None)
            .await?
            .is_none()
    );
    let (status, _) = ctx
        .voice_state(
            &ctx.jeremy,
            json!({ "guild_id": "12345", "channel_id": ctx.dm_id.to_string(), "self_mute": true }),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(drain(&mut events, "VOICE_STATE_UPDATE").is_empty());

    // Leaving through the command is announced to the DM only (it used to go
    // to every connected session).
    let (status, _) = ctx
        .voice_state(
            &ctx.jeremy,
            json!({ "session_id": jeremy_call, "guild_id": Value::Null, "channel_id": Value::Null }),
        )
        .await?;
    assert!(status.is_success());
    let updates = drain(&mut events, "VOICE_STATE_UPDATE");
    let leave = updates.last().context("the leave is announced")?;
    assert_recipients_only(leave, &[ctx.jeremy.id, ctx.sean.id]);
    assert_eq!(leave.payload["channel_id"], Value::Null);
    Ok(())
}

/// The SSE transport's READY for `token`.
async fn sse_ready(ctx: &Ctx, token: &str) -> anyhow::Result<Value> {
    let (_, session) = ctx
        .request(Method::POST, "/api/v2/rt/session", None, token)
        .await?;
    let session_id = session["session_id"]
        .as_str()
        .context("rt session")?
        .to_string();
    let (_, ticket) = ctx
        .request(Method::POST, "/api/v1/stream/ticket", None, token)
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
    let response = ctx.app.app.clone().oneshot(request).await?;
    let mut stream = response.into_body().into_data_stream();
    let mut buf = String::new();
    loop {
        let chunk = tokio::time::timeout(Duration::from_secs(3), stream.next())
            .await
            .context("a frame")?
            .context("stream open")??;
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

#[tokio::test]
async fn sse_ready_lists_the_people_in_a_recipients_dm_calls() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let jeremy_call = ctx.join(&ctx.jeremy, ctx.dm_id).await?;
    let (status, _) = ctx
        .voice_state(
            &ctx.jeremy,
            json!({ "session_id": jeremy_call, "channel_id": ctx.dm_id.to_string(),
                    "self_mute": true, "self_video": true }),
        )
        .await?;
    assert!(status.is_success());

    let ready = sse_ready(&ctx, &ctx.sean.token).await?;
    let states = ready["d"]["dm_voice_states"]
        .as_array()
        .context("READY carries dm_voice_states")?;
    assert_eq!(states.len(), 1, "{ready}");
    assert_eq!(states[0]["user_id"], ctx.jeremy.id.to_string());
    assert_eq!(states[0]["channel_id"], ctx.dm_id.to_string());
    assert_eq!(states[0]["guild_id"], Value::Null);
    assert_eq!(states[0]["self_mute"], true);
    assert_eq!(states[0]["self_video"], true);
    assert_snapshot(&states[0]);

    // Somebody outside the DM is told nothing about its call.
    let ready = sse_ready(&ctx, &ctx.outsider.token).await?;
    assert_eq!(ready["d"]["dm_voice_states"], json!([]), "{ready}");
    Ok(())
}
