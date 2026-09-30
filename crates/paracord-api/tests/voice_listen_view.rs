//! Glass (WP-G5): listening in, in-place mode switches, view sessions
//! (watch / ambient) with watcher counts, the per-channel listen-in switch,
//! and the stream start time on the voice state.
//!
//! Runs on in-memory SQLite by default and on PostgreSQL when
//! `PARACORD_TEST_POSTGRES_URL` is set (see `common::build_test_app`).

mod common;

use std::time::Duration;

use anyhow::Context;
use axum::http::{Method, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use paracord_contracts::voice as wire;
use paracord_core::events::ServerEvent;
use paracord_models::permissions::Permissions;
use paracord_models::voice::VoiceMode;
use serde_json::{json, Value};
use tokio::sync::broadcast::Receiver;

const JWT_SECRET: &str = "listen-view-secret";
/// Channel permission overwrite on a single member.
const OVERWRITE_TARGET_MEMBER: i16 = 1;

struct Ctx {
    app: TestApp,
    owner_token: String,
    owner_id: i64,
    guild_id: i64,
    voice_id: i64,
}

impl Ctx {
    async fn new() -> anyhow::Result<Self> {
        Self::with_native_media(true).await
    }

    async fn with_native_media(native_media_enabled: bool) -> anyhow::Result<Self> {
        let app = build_test_app(TestAppOptions {
            jwt_secret: JWT_SECRET.to_string(),
            native_media_enabled,
            ..Default::default()
        })
        .await?;
        let owner_token =
            create_authenticated_user_token(&app.db, JWT_SECRET, "owner", "OwnerPass123!").await?;
        let owner_id = paracord_core::auth::validate_token(&owner_token, JWT_SECRET)?.sub;
        let mut ctx = Self {
            app,
            owner_token,
            owner_id,
            guild_id: 0,
            voice_id: 0,
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
        ctx.guild_id = guild["id"].as_str().context("guild id")?.parse()?;
        ctx.voice_id = ctx.channel("Lounge", 2).await?;
        Ok(ctx)
    }

    async fn channel(&self, name: &str, channel_type: i16) -> anyhow::Result<i64> {
        let (status, channel) = self
            .request(
                Method::POST,
                &format!("/api/v1/guilds/{}/channels", self.guild_id),
                Some(json!({
                    "name": name,
                    "channel_type": channel_type,
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

    async fn join(&self, token: &str, mode: Option<&str>) -> anyhow::Result<(StatusCode, Value)> {
        let query = mode.map(|mode| format!("?mode={mode}")).unwrap_or_default();
        self.request(
            Method::POST,
            &format!("/api/v2/voice/{}/join{query}", self.voice_id),
            None,
            token,
        )
        .await
    }

    async fn joined(&self, token: &str, mode: Option<&str>) -> anyhow::Result<String> {
        let (status, body) = self.join(token, mode).await?;
        assert_eq!(status, StatusCode::OK, "join {mode:?}: {body}");
        Ok(body["session_id"].as_str().context("receipt")?.to_string())
    }

    async fn set_mode(
        &self,
        token: &str,
        mode: &str,
        session_id: Option<&str>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let mut body = json!({ "mode": mode });
        if let Some(session_id) = session_id {
            body["session_id"] = json!(session_id);
        }
        self.request(
            Method::POST,
            &format!("/api/v2/voice/{}/mode", self.voice_id),
            Some(body),
            token,
        )
        .await
    }

    async fn start_stream(&self, token: &str, session_id: &str) -> anyhow::Result<StatusCode> {
        let (status, body) = self
            .request(
                Method::POST,
                &format!(
                    "/api/v1/voice/{}/stream?session_id={session_id}",
                    self.voice_id
                ),
                None,
                token,
            )
            .await?;
        assert!(
            status == StatusCode::OK || status.is_client_error(),
            "{body}"
        );
        Ok(status)
    }

    async fn view(
        &self,
        token: &str,
        kind: &str,
        streamer: i64,
    ) -> anyhow::Result<(StatusCode, Value)> {
        self.request(
            Method::POST,
            &format!("/api/v2/voice/{}/view", self.voice_id),
            Some(json!({ "kind": kind, "user_id": streamer.to_string() })),
            token,
        )
        .await
    }

    async fn watchers(&self, token: &str) -> anyhow::Result<Value> {
        let (status, body) = self
            .request(
                Method::GET,
                &format!("/api/v2/voice/{}/watchers", self.voice_id),
                None,
                token,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        serde_json::from_value::<wire::VoiceWatchers>(body.clone())
            .context("watchers match the contract")?;
        Ok(body)
    }

    async fn overwrite_member(
        &self,
        channel_id: i64,
        user_id: i64,
        deny: Permissions,
    ) -> anyhow::Result<()> {
        let (status, body) = self
            .request(
                Method::PUT,
                &format!("/api/v1/channels/{channel_id}/overwrites/{user_id}"),
                Some(json!({
                    "target_type": OVERWRITE_TARGET_MEMBER,
                    "allow_perms": 0,
                    "deny_perms": deny.bits(),
                })),
                &self.owner_token,
            )
            .await?;
        assert!(status.is_success(), "overwrite: {status} {body}");
        Ok(())
    }

    async fn voice_row(
        &self,
        user_id: i64,
    ) -> anyhow::Result<Option<paracord_db::voice_states::VoiceStateRow>> {
        Ok(paracord_db::voice_states::get_user_voice_state(
            &self.app.db,
            user_id,
            Some(self.guild_id),
        )
        .await?)
    }

    fn native(&self) -> &paracord_core::NativeMediaState {
        self.app
            .state
            .native_media
            .as_ref()
            .expect("native media is on in this context")
    }

    /// `(can_publish, session_id, is_viewer)` of `user_id` in the voice room.
    fn relay_member(&self, user_id: i64) -> Option<(bool, String, bool)> {
        self.native()
            .rooms
            .get_room_by_channel(self.guild_id, self.voice_id)
            .and_then(|room| room.participants.get(&user_id).cloned())
            .map(|p| (p.can_publish, p.session_id.clone(), p.is_viewer()))
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

/// Wait (bounded) for the next `VOICE_WATCHERS_UPDATE`.
async fn next_watchers(rx: &mut Receiver<ServerEvent>) -> anyhow::Result<Value> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = rx.recv().await?;
            if event.event_type == "VOICE_WATCHERS_UPDATE" {
                return anyhow::Ok((*event.payload).clone());
            }
        }
    })
    .await
    .context("a VOICE_WATCHERS_UPDATE arrives")?
}

fn stream_watchers(payload: &Value, streamer: i64) -> Option<u64> {
    payload["streams"]
        .as_array()?
        .iter()
        .find(|stream| stream["user_id"] == json!(streamer.to_string()))
        .and_then(|stream| stream["watchers"].as_u64())
}

fn assert_snapshot(event: &Value) {
    serde_json::from_value::<wire::VoiceStateSnapshot>(event.clone())
        .unwrap_or_else(|error| panic!("VOICE_STATE_UPDATE is not a snapshot ({error}): {event}"));
}

#[tokio::test]
async fn a_listen_join_is_receive_only_and_announced_as_listening() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (token, user_id) = ctx.member("listener").await?;
    let mut events = ctx.app.event_bus.subscribe_system();

    let (status, body) = ctx.join(&token, Some("listen")).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["mode"], "listen");
    assert_eq!(body["native_media"], true);
    let session_id = body["session_id"].as_str().context("receipt")?;

    let row = ctx.voice_row(user_id).await?.context("a voice state")?;
    assert_eq!(row.mode, VoiceMode::Listen);
    assert_eq!(row.session_id, session_id);
    assert_eq!(
        ctx.relay_member(user_id),
        Some((false, session_id.to_string(), false)),
        "the relay admits a listener receive-only"
    );

    let updates = drain(&mut events, "VOICE_STATE_UPDATE");
    let update = updates.last().context("the listen join is announced")?;
    assert_eq!(update["mode"], "listen", "{update}");
    assert_eq!(update["self_stream_started_at"], Value::Null);
    assert_snapshot(update);

    // A full join is still the default, and says so.
    let (joiner, joiner_id) = ctx.member("joiner").await?;
    let (status, body) = ctx
        .request(
            Method::GET,
            &format!("/api/v1/voice/{}/join", ctx.voice_id),
            None,
            &joiner,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["mode"], "joined");
    assert_eq!(
        ctx.voice_row(joiner_id).await?.map(|row| row.mode),
        Some(VoiceMode::Joined)
    );
    assert!(ctx.relay_member(joiner_id).is_some_and(|(can, _, _)| can));

    // Only the two modes exist.
    let (status, body) = ctx.join(&joiner, Some("full")).await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    // A listener never streams.
    assert_eq!(
        ctx.start_stream(&token, session_id).await?,
        StatusCode::CONFLICT
    );
    Ok(())
}

#[tokio::test]
async fn listen_upgrades_to_joined_in_place_and_back() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (token, user_id) = ctx.member("upgrader").await?;
    let session_id = ctx.joined(&token, Some("listen")).await?;
    let mut events = ctx.app.event_bus.subscribe_system();

    let (status, body) = ctx.set_mode(&token, "joined", Some(&session_id)).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    let response: wire::VoiceModeResponse = serde_json::from_value(body.clone())?;
    assert_eq!(response.mode, wire::VoiceMode::Joined);
    assert!(response.can_publish);
    assert_eq!(response.session_id, session_id, "same call, no reconnect");
    assert_eq!(
        ctx.relay_member(user_id),
        Some((true, session_id.clone(), false)),
        "publishing is flipped on the same relay membership"
    );
    assert_eq!(
        ctx.voice_row(user_id).await?.map(|row| row.mode),
        Some(VoiceMode::Joined)
    );
    let update = drain(&mut events, "VOICE_STATE_UPDATE")
        .pop()
        .context("the upgrade is announced")?;
    assert_eq!(update["mode"], "joined", "{update}");
    assert_eq!(update["session_id"], session_id.as_str());
    assert_snapshot(&update);

    // Joined, the member can share; then going back to listening ends the
    // share and the publish rights, still on the same call.
    assert_eq!(ctx.start_stream(&token, &session_id).await?, StatusCode::OK);
    assert!(ctx
        .voice_row(user_id)
        .await?
        .is_some_and(|row| row.self_stream && row.self_stream_started_at.is_some()));
    drain(&mut events, "VOICE_STATE_UPDATE");

    let (status, body) = ctx.set_mode(&token, "listen", None).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["can_publish"], false);
    assert_eq!(
        ctx.relay_member(user_id),
        Some((false, session_id.clone(), false))
    );
    let row = ctx.voice_row(user_id).await?.context("still in the call")?;
    assert_eq!(row.mode, VoiceMode::Listen);
    assert!(!row.self_stream && row.self_stream_started_at.is_none());
    let update = drain(&mut events, "VOICE_STATE_UPDATE")
        .pop()
        .context("the downgrade is announced")?;
    assert_eq!(update["mode"], "listen");
    assert_eq!(update["self_stream"], false);
    assert_eq!(update["self_stream_started_at"], Value::Null);

    // The same mode again is a no-op, announced to nobody.
    let (status, _) = ctx.set_mode(&token, "listen", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert!(drain(&mut events, "VOICE_STATE_UPDATE").is_empty());

    // A stale receipt, or someone not in the channel, cannot switch.
    let (status, _) = ctx.set_mode(&token, "joined", Some("stale")).await?;
    assert_eq!(status, StatusCode::CONFLICT);
    let (outsider, _) = ctx.member("outsider").await?;
    let (status, _) = ctx.set_mode(&outsider, "joined", None).await?;
    assert_eq!(status, StatusCode::CONFLICT);

    // Joined without SPEAK is still receive-only at the relay.
    let (mute, mute_id) = ctx.member("nospeak").await?;
    ctx.overwrite_member(ctx.voice_id, mute_id, Permissions::SPEAK)
        .await?;
    ctx.joined(&mute, Some("listen")).await?;
    let (status, body) = ctx.set_mode(&mute, "joined", None).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["mode"], "joined");
    assert_eq!(body["can_publish"], false);
    assert!(ctx.relay_member(mute_id).is_some_and(|(can, _, _)| !can));
    Ok(())
}

#[tokio::test]
async fn a_channel_can_turn_listening_in_off() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let features = format!("/api/v1/channels/{}/features", ctx.voice_id);
    let (status, body) = ctx
        .request(Method::GET, &features, None, &ctx.owner_token)
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["listen_in_enabled"], true, "on by default");

    let (token, user_id) = ctx.member("member").await?;
    let (status, _) = ctx
        .request(
            Method::PATCH,
            &features,
            Some(json!({ "listen_in_enabled": false })),
            &token,
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "MANAGE_CHANNELS only");
    let (status, body) = ctx
        .request(
            Method::PATCH,
            &features,
            Some(json!({ "listen_in_enabled": false })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["listen_in_enabled"], false);
    let (_, body) = ctx
        .request(Method::GET, &features, None, &ctx.owner_token)
        .await?;
    assert_eq!(body["listen_in_enabled"], false, "the setting persists");

    let (status, body) = ctx.join(&token, Some("listen")).await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["code"], "LISTEN_IN_DISABLED", "{body}");
    assert!(
        ctx.voice_row(user_id).await?.is_none(),
        "nothing was joined"
    );

    let (status, body) = ctx
        .request(
            Method::POST,
            "/api/v2/voice/recover?mode=listen",
            Some(json!({ "channel_id": ctx.voice_id })),
            &token,
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["code"], "LISTEN_IN_DISABLED");

    // Joining is unaffected, and a joined member cannot drop to listening.
    ctx.joined(&token, None).await?;
    let (status, body) = ctx.set_mode(&token, "listen", None).await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["code"], "LISTEN_IN_DISABLED");

    // The switch is a voice-channel setting.
    let text = ctx.channel("general", 0).await?;
    let (status, _) = ctx
        .request(
            Method::PATCH,
            &format!("/api/v1/channels/{text}/features"),
            Some(json!({ "listen_in_enabled": false })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Turned back on, listening in works again.
    let (status, _) = ctx
        .request(
            Method::PATCH,
            &features,
            Some(json!({ "listen_in_enabled": true })),
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let (other, _) = ctx.member("later").await?;
    ctx.joined(&other, Some("listen")).await?;
    Ok(())
}

#[tokio::test]
async fn the_stream_start_time_is_set_while_streaming_and_cleared_after() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let session_id = ctx.joined(&ctx.owner_token, None).await?;
    let mut events = ctx.app.event_bus.subscribe_system();

    let before = chrono::Utc::now() - chrono::Duration::seconds(2);
    assert_eq!(
        ctx.start_stream(&ctx.owner_token, &session_id).await?,
        StatusCode::OK
    );
    let started_at = ctx
        .voice_row(ctx.owner_id)
        .await?
        .and_then(|row| row.self_stream_started_at)
        .context("a stream start is stamped")?;
    assert!(
        started_at >= before && started_at <= chrono::Utc::now() + chrono::Duration::seconds(1)
    );
    let update = drain(&mut events, "VOICE_STATE_UPDATE")
        .pop()
        .context("the start is announced")?;
    assert_eq!(update["self_stream"], true);
    let wire_started = update["self_stream_started_at"]
        .as_str()
        .context("an RFC 3339 start time")?;
    assert_eq!(
        chrono::DateTime::parse_from_rfc3339(wire_started)?.with_timezone(&chrono::Utc),
        started_at
    );
    assert_snapshot(&update);

    // A second start while sharing keeps the original time (it is one stream).
    assert_eq!(
        ctx.start_stream(&ctx.owner_token, &session_id).await?,
        StatusCode::OK
    );
    assert_eq!(
        ctx.voice_row(ctx.owner_id)
            .await?
            .and_then(|row| row.self_stream_started_at),
        Some(started_at)
    );

    // A mute or deafen while sharing keeps it too.
    let (status, body) = dispatch_json(
        &ctx.app.app,
        build_json_request(
            Method::POST,
            "/api/v2/voice/state",
            Some(json!({
                "guild_id": ctx.guild_id.to_string(),
                "channel_id": ctx.voice_id.to_string(),
                "self_mute": true,
                "self_deaf": false,
            })),
            Some(&ctx.owner_token),
        )?,
    )
    .await?;
    assert!(status.is_success(), "{status} {body}");
    let row = ctx.voice_row(ctx.owner_id).await?.context("in the call")?;
    assert!(row.self_mute && row.self_stream);
    assert_eq!(row.self_stream_started_at, Some(started_at));

    let (status, _) = ctx
        .request(
            Method::POST,
            &format!(
                "/api/v1/voice/{}/stream/stop?session_id={session_id}",
                ctx.voice_id
            ),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let row = ctx.voice_row(ctx.owner_id).await?.context("in the call")?;
    assert!(!row.self_stream && row.self_stream_started_at.is_none());
    let update = drain(&mut events, "VOICE_STATE_UPDATE")
        .pop()
        .context("the stop is announced")?;
    assert_eq!(update["self_stream"], false);
    assert_eq!(update["self_stream_started_at"], Value::Null);
    assert_eq!(update["self_mute"], true, "the mute is kept");

    // Nobody streams into a channel they are not in.
    let (outsider, _) = ctx.member("outsider").await?;
    let (status, _) = ctx
        .request(
            Method::POST,
            &format!("/api/v1/voice/{}/stream", ctx.voice_id),
            None,
            &outsider,
        )
        .await?;
    assert_eq!(status, StatusCode::CONFLICT);
    Ok(())
}

#[tokio::test]
async fn a_watch_view_is_counted_and_ambient_is_not() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let streamer_session = ctx.joined(&ctx.owner_token, None).await?;
    assert_eq!(
        ctx.start_stream(&ctx.owner_token, &streamer_session)
            .await?,
        StatusCode::OK
    );
    let (token, viewer_id) = ctx.member("viewer").await?;
    let mut events = ctx.app.event_bus.subscribe_system();

    let (status, body) = ctx.view(&token, "watch", ctx.owner_id).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    let view: wire::VoiceViewSession = serde_json::from_value(body.clone())?;
    assert!(!view.via_membership);
    assert_eq!(view.kind, wire::VoiceViewKind::Watch);
    let session_id = view.session_id.clone().context("a view receipt")?;
    let media = view.media.clone().context("media credentials")?;
    assert_eq!(
        media.room_name,
        format!("{}:{}", ctx.guild_id, ctx.voice_id)
    );

    // The token admits exactly this view.
    let claims = jsonwebtoken::decode::<Value>(
        &media.media_token,
        &jsonwebtoken::DecodingKey::from_secret(JWT_SECRET.as_bytes()),
        &jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256),
    )?
    .claims;
    assert_eq!(claims["view"], "watch");
    assert_eq!(claims["sid"], session_id.as_str());
    assert_eq!(claims["sub"], viewer_id.to_string());
    let rooms = &ctx.native().rooms;
    assert_eq!(
        rooms.resolve_view_admission(viewer_id, &session_id, claims["room"].as_str()),
        Some(media.room_name.clone())
    );

    // A viewer is not in the call: no voice state, no roster entry.
    assert!(ctx.voice_row(viewer_id).await?.is_none());
    assert_eq!(
        ctx.relay_member(viewer_id),
        Some((false, session_id.clone(), true))
    );
    assert!(drain(&mut events, "VOICE_STATE_UPDATE").is_empty());

    let update = next_watchers(&mut events).await?;
    assert_eq!(update["channel_id"], ctx.voice_id.to_string());
    assert_eq!(stream_watchers(&update, ctx.owner_id), Some(1), "{update}");
    serde_json::from_value::<wire::VoiceWatchers>(update)?;
    assert_eq!(
        stream_watchers(&ctx.watchers(&token).await?, ctx.owner_id),
        Some(1)
    );

    // Switching to ambient replaces the watch: the room light is not watching.
    let (status, body) = ctx.view(&token, "ambient", ctx.owner_id).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_ne!(body["session_id"], session_id.as_str(), "a new receipt");
    let update = next_watchers(&mut events).await?;
    assert_eq!(update["streams"], json!([]), "{update}");
    assert_eq!(ctx.watchers(&token).await?["streams"], json!([]));
    let ambient_session = body["session_id"].as_str().context("receipt")?.to_string();
    assert_eq!(
        rooms.resolve_view_admission(viewer_id, &session_id, None),
        None,
        "the replaced view's token no longer admits anything"
    );

    // Stopping ends it; stopping again is still fine.
    for _ in 0..2 {
        let (status, _) = ctx
            .request(
                Method::DELETE,
                &format!("/api/v2/voice/{}/view", ctx.voice_id),
                None,
                &token,
            )
            .await?;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }
    assert!(rooms.view_for_user(viewer_id).is_none());
    assert_eq!(
        rooms.resolve_view_admission(viewer_id, &ambient_session, None),
        None
    );
    assert!(ctx.relay_member(viewer_id).is_none());
    Ok(())
}

#[tokio::test]
async fn a_call_member_watches_through_its_call() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let streamer_session = ctx.joined(&ctx.owner_token, None).await?;
    assert_eq!(
        ctx.start_stream(&ctx.owner_token, &streamer_session)
            .await?,
        StatusCode::OK
    );
    let (token, member_id) = ctx.member("listener").await?;
    let member_session = ctx.joined(&token, Some("listen")).await?;
    let mut events = ctx.app.event_bus.subscribe_system();

    let (status, body) = ctx.view(&token, "watch", ctx.owner_id).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["via_membership"], true);
    assert_eq!(body["media"], Value::Null);
    assert_eq!(body["session_id"], Value::Null);
    assert_eq!(
        ctx.relay_member(member_id),
        Some((false, member_session.clone(), false)),
        "still the same (listening) call member"
    );
    let update = next_watchers(&mut events).await?;
    assert_eq!(stream_watchers(&update, ctx.owner_id), Some(1), "{update}");

    // Leaving the call stops the watch, and everyone hears the count drop.
    let (status, _) = ctx
        .request(
            Method::POST,
            &format!(
                "/api/v2/voice/{}/leave?session_id={member_session}",
                ctx.voice_id
            ),
            None,
            &token,
        )
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let update = next_watchers(&mut events).await?;
    assert_eq!(update["streams"], json!([]), "{update}");
    Ok(())
}

#[tokio::test]
async fn view_sessions_check_permissions_and_that_someone_is_streaming() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let streamer_session = ctx.joined(&ctx.owner_token, None).await?;
    let (token, _) = ctx.member("viewer").await?;

    // Nothing to watch yet.
    let (status, body) = ctx.view(&token, "watch", ctx.owner_id).await?;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(
        ctx.start_stream(&ctx.owner_token, &streamer_session)
            .await?,
        StatusCode::OK
    );

    // Your own stream is not something to view.
    let (status, _) = ctx
        .view(&ctx.owner_token.clone(), "watch", ctx.owner_id)
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Ambient needs only VIEW_CHANNEL; watching needs CONNECT too.
    let (no_connect, no_connect_id) = ctx.member("noconnect").await?;
    ctx.overwrite_member(ctx.voice_id, no_connect_id, Permissions::CONNECT)
        .await?;
    let (status, body) = ctx.view(&no_connect, "watch", ctx.owner_id).await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, body) = ctx.view(&no_connect, "ambient", ctx.owner_id).await?;
    assert_eq!(status, StatusCode::OK, "{body}");

    // A channel the member cannot see is neither viewable nor countable.
    let (hidden, hidden_id) = ctx.member("hidden").await?;
    ctx.overwrite_member(ctx.voice_id, hidden_id, Permissions::VIEW_CHANNEL)
        .await?;
    for kind in ["watch", "ambient"] {
        let (status, _) = ctx.view(&hidden, kind, ctx.owner_id).await?;
        assert_eq!(status, StatusCode::FORBIDDEN, "{kind}");
    }
    let (status, _) = ctx
        .request(
            Method::GET,
            &format!("/api/v2/voice/{}/watchers", ctx.voice_id),
            None,
            &hidden,
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Someone outside the server cannot view it.
    let outsider =
        create_authenticated_user_token(&ctx.app.db, JWT_SECRET, "outsider", "OutPass123!").await?;
    let (status, _) = ctx.view(&outsider, "ambient", ctx.owner_id).await?;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Unknown kinds are refused.
    let (status, _) = ctx.view(&token, "everything", ctx.owner_id).await?;
    assert!(status.is_client_error());
    Ok(())
}

#[tokio::test]
async fn removing_a_member_ends_their_view_of_the_server() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let streamer_session = ctx.joined(&ctx.owner_token, None).await?;
    assert_eq!(
        ctx.start_stream(&ctx.owner_token, &streamer_session)
            .await?,
        StatusCode::OK
    );
    let (token, viewer_id) = ctx.member("kicked").await?;
    let mut events = ctx.app.event_bus.subscribe_system();
    let (status, body) = ctx.view(&token, "watch", ctx.owner_id).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        stream_watchers(&next_watchers(&mut events).await?, ctx.owner_id),
        Some(1)
    );

    let (status, body) = ctx
        .request(
            Method::DELETE,
            &format!("/api/v1/guilds/{}/members/{viewer_id}", ctx.guild_id),
            None,
            &ctx.owner_token,
        )
        .await?;
    assert!(status.is_success(), "kick: {status} {body}");
    assert!(ctx.native().rooms.view_for_user(viewer_id).is_none());
    assert_eq!(next_watchers(&mut events).await?["streams"], json!([]));
    Ok(())
}

/// A view is re-checked after it starts: a viewer who loses VIEW_CHANNEL
/// (either kind), or CONNECT (a watch), has the view ended; a viewer who keeps
/// what the view needs keeps the view.
#[tokio::test]
async fn losing_access_mid_view_ends_the_view() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let streamer_session = ctx.joined(&ctx.owner_token, None).await?;
    assert_eq!(
        ctx.start_stream(&ctx.owner_token, &streamer_session)
            .await?,
        StatusCode::OK
    );
    let (hidden, hidden_id) = ctx.member("hidden-later").await?;
    let (no_connect_watch, no_connect_watch_id) = ctx.member("watch-noconnect").await?;
    let (no_connect_ambient, no_connect_ambient_id) = ctx.member("ambient-noconnect").await?;
    let (kept, kept_id) = ctx.member("kept").await?;
    for (token, kind) in [
        (&hidden, "watch"),
        (&no_connect_watch, "watch"),
        (&no_connect_ambient, "ambient"),
        (&kept, "watch"),
    ] {
        let (status, body) = ctx.view(token, kind, ctx.owner_id).await?;
        assert_eq!(status, StatusCode::OK, "{kind}: {body}");
    }
    let revoke = paracord_api::routes::voice::revoke_views_without_access;
    assert_eq!(revoke(&ctx.app.state).await, 0, "everybody may still view");

    ctx.overwrite_member(ctx.voice_id, hidden_id, Permissions::VIEW_CHANNEL)
        .await?;
    ctx.overwrite_member(ctx.voice_id, no_connect_watch_id, Permissions::CONNECT)
        .await?;
    ctx.overwrite_member(ctx.voice_id, no_connect_ambient_id, Permissions::CONNECT)
        .await?;
    assert_eq!(revoke(&ctx.app.state).await, 2);
    let rooms = &ctx.native().rooms;
    assert!(
        rooms.view_for_user(hidden_id).is_none(),
        "lost VIEW_CHANNEL"
    );
    assert!(
        rooms.view_for_user(no_connect_watch_id).is_none(),
        "a watch needs CONNECT"
    );
    assert!(
        rooms.view_for_user(no_connect_ambient_id).is_some(),
        "ambient needs only VIEW_CHANNEL"
    );
    assert!(rooms.view_for_user(kept_id).is_some());
    assert_eq!(revoke(&ctx.app.state).await, 0, "nothing left to end");
    Ok(())
}

#[tokio::test]
async fn view_sessions_need_native_media() -> anyhow::Result<()> {
    let ctx = Ctx::with_native_media(false).await?;
    let (token, _) = ctx.member("viewer").await?;
    let (status, body) = ctx.view(&token, "watch", ctx.owner_id).await?;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    Ok(())
}
