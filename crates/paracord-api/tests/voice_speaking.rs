//! Who is talking in a voice channel, relayed to people outside the call.
//!
//! Covers the rules the brief sets: only somebody whose voice state is in that
//! channel (and unmuted) may report speaking, edges are rate limited per user,
//! `VOICE_SPEAKING` reaches the people who can view the channel and nobody else,
//! a speaker is cleared by a leave, a mute or a missed refresh, and a fresh
//! READY carries who is talking right now.

mod common;

use std::time::Duration;

use anyhow::Context;
use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
    Router,
};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use futures_util::StreamExt;
use paracord_core::permissions::OVERWRITE_TARGET_MEMBER;
use paracord_models::permissions::Permissions;
use serde_json::{json, Value};
use tokio::sync::broadcast;

const SECRET: &str = "speaking-test-secret";

struct Ctx {
    app: Router,
    db: paracord_db::DbPool,
    test_app: TestApp,
    owner: String,
    owner_id: i64,
    guild_id: i64,
    voice_id: i64,
}

fn user_id_of(token: &str) -> i64 {
    paracord_core::auth::validate_token(token, SECRET)
        .expect("valid token")
        .sub
}

impl Ctx {
    async fn new() -> anyhow::Result<Self> {
        let test_app = build_test_app(TestAppOptions {
            jwt_secret: SECRET.to_string(),
            native_media_enabled: true,
            ..Default::default()
        })
        .await?;
        let owner =
            create_authenticated_user_token(&test_app.db, SECRET, "owner", "SpeakingPass123!")
                .await?;
        let owner_id = user_id_of(&owner);
        let mut ctx = Self {
            app: test_app.app.clone(),
            db: test_app.db.clone(),
            test_app,
            owner,
            owner_id,
            guild_id: 0,
            voice_id: 0,
        };
        let (status, guild) = ctx
            .call(
                &ctx.owner.clone(),
                Method::POST,
                "/api/v1/guilds",
                Some(json!({ "name": "Lantern Works" })),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "guild: {guild}");
        ctx.guild_id = guild["id"].as_str().context("guild id")?.parse()?;
        ctx.voice_id = ctx.create_channel("studio", 2).await?;
        Ok(ctx)
    }

    async fn create_channel(&self, name: &str, channel_type: i64) -> anyhow::Result<i64> {
        let (status, channel) = self
            .call(
                &self.owner,
                Method::POST,
                &format!("/api/v1/guilds/{}/channels", self.guild_id),
                Some(
                    json!({ "name": name, "channel_type": channel_type, "parent_id": Value::Null }),
                ),
            )
            .await?;
        assert_eq!(status, StatusCode::CREATED, "channel: {channel}");
        Ok(channel["id"].as_str().context("channel id")?.parse()?)
    }

    async fn member(&self, prefix: &str) -> anyhow::Result<(String, i64)> {
        let token =
            create_authenticated_user_token(&self.db, SECRET, prefix, "SpeakingPass123!").await?;
        let id = user_id_of(&token);
        paracord_db::members::add_member(&self.db, id, self.guild_id).await?;
        Ok((token, id))
    }

    async fn call(
        &self,
        token: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let request = build_json_request(method, path, body, Some(token))?;
        dispatch_json(&self.app, request).await
    }

    async fn join(&self, token: &str, channel_id: i64) -> anyhow::Result<()> {
        let (status, body) = self
            .call(
                token,
                Method::GET,
                &format!("/api/v1/voice/{channel_id}/join"),
                None,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "join voice: {body}");
        Ok(())
    }

    async fn leave(&self, token: &str) -> anyhow::Result<()> {
        let (status, body) = self
            .call(
                token,
                Method::POST,
                &format!("/api/v1/voice/{}/leave", self.voice_id),
                None,
            )
            .await?;
        assert!(status.is_success(), "leave voice: {status} {body}");
        Ok(())
    }

    async fn command(
        &self,
        token: &str,
        command_type: &str,
        payload: Value,
    ) -> anyhow::Result<(StatusCode, Value)> {
        self.call(
            token,
            Method::POST,
            "/api/v2/rt/commands",
            Some(json!({
                "command_id": format!("{command_type}-{}", rand_suffix()),
                "type": command_type,
                "payload": payload,
            })),
        )
        .await
    }

    async fn speak(&self, token: &str, speaking: bool) -> anyhow::Result<StatusCode> {
        let (status, _) = self
            .command(
                token,
                "voice_speaking",
                json!({ "channel_id": self.voice_id.to_string(), "speaking": speaking }),
            )
            .await?;
        Ok(status)
    }

    async fn set_self_mute(&self, token: &str, mute: bool) -> anyhow::Result<()> {
        let (status, body) = self
            .command(
                token,
                "voice_state_update",
                json!({
                    "guild_id": self.guild_id.to_string(),
                    "channel_id": self.voice_id.to_string(),
                    "self_mute": mute,
                    "self_deaf": false,
                }),
            )
            .await?;
        assert!(status.is_success(), "mute: {status} {body}");
        Ok(())
    }

    fn is_speaking(&self, user_id: i64) -> bool {
        self.test_app
            .state
            .speaking
            .is_speaking(self.voice_id, user_id)
    }

    fn events(&self) -> broadcast::Receiver<paracord_core::events::ServerEvent> {
        self.test_app.state.event_bus.subscribe_system()
    }
}

fn rand_suffix() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Every `VOICE_SPEAKING` payload published within `window`.
async fn speaking_events(
    events: &mut broadcast::Receiver<paracord_core::events::ServerEvent>,
    window: Duration,
) -> Vec<Value> {
    let deadline = tokio::time::Instant::now() + window;
    let mut seen = Vec::new();
    while let Ok(Ok(event)) = tokio::time::timeout_at(deadline, events.recv()).await {
        if event.event_type == "VOICE_SPEAKING" {
            seen.push((*event.payload).clone());
        }
    }
    seen
}

#[tokio::test]
async fn only_an_unmuted_user_in_the_channel_can_report() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (outsider, outsider_id) = ctx.member("outsider").await?;
    let (elsewhere, elsewhere_id) = ctx.member("elsewhere").await?;
    let other_voice = ctx.create_channel("lounge", 2).await?;

    // Not in any call.
    assert_eq!(ctx.speak(&outsider, true).await?, StatusCode::FORBIDDEN);
    assert!(!ctx.is_speaking(outsider_id));

    // In a different voice channel of the same server.
    ctx.join(&elsewhere, other_voice).await?;
    assert_eq!(ctx.speak(&elsewhere, true).await?, StatusCode::FORBIDDEN);
    assert!(!ctx.is_speaking(elsewhere_id));

    // A stop from somebody who is not speaking is a harmless no-op.
    assert_eq!(ctx.speak(&outsider, false).await?, StatusCode::OK);

    // In the channel: accepted.
    ctx.join(&ctx.owner, ctx.voice_id).await?;
    let mut events = ctx.events();
    assert_eq!(ctx.speak(&ctx.owner, true).await?, StatusCode::OK);
    assert!(ctx.is_speaking(ctx.owner_id));
    let seen = speaking_events(&mut events, Duration::from_millis(200)).await;
    assert_eq!(seen.len(), 1, "{seen:?}");
    assert_eq!(seen[0]["user_id"], ctx.owner_id.to_string());
    assert_eq!(seen[0]["channel_id"], ctx.voice_id.to_string());
    assert_eq!(seen[0]["guild_id"], ctx.guild_id.to_string());
    assert_eq!(seen[0]["speaking"], true);

    // A refresh while already speaking is not a new edge.
    tokio::time::sleep(Duration::from_millis(450)).await;
    assert_eq!(ctx.speak(&ctx.owner, true).await?, StatusCode::OK);
    assert!(speaking_events(&mut events, Duration::from_millis(200))
        .await
        .is_empty());

    // Self-muted: a start is dropped (and never an error for this ambient
    // signal).
    let (muted, muted_id) = ctx.member("muted").await?;
    ctx.join(&muted, ctx.voice_id).await?;
    ctx.set_self_mute(&muted, true).await?;
    assert_eq!(ctx.speak(&muted, true).await?, StatusCode::OK);
    assert!(!ctx.is_speaking(muted_id));
    Ok(())
}

#[tokio::test]
async fn edges_beyond_the_per_user_budget_are_dropped_quietly() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    ctx.join(&ctx.owner, ctx.voice_id).await?;
    let mut events = ctx.events();

    // Twenty flips as fast as the router will take them. Stops are always
    // honored, so only the starts are charged; every call still answers 200.
    for index in 0..20 {
        let status = ctx.speak(&ctx.owner, index % 2 == 0).await?;
        assert_eq!(status, StatusCode::OK, "flip {index}");
    }
    let seen = speaking_events(&mut events, Duration::from_millis(300)).await;
    let starts = seen.iter().filter(|e| e["speaking"] == true).count();
    assert!(
        (1..=6).contains(&starts),
        "the burst lets a few through and drops the rest: {starts} starts in {seen:?}"
    );
    // The broadcast stream still alternates: every start is followed by its stop.
    let stops = seen.iter().filter(|e| e["speaking"] == false).count();
    assert_eq!(starts, stops, "{seen:?}");
    assert!(!ctx.is_speaking(ctx.owner_id));

    // Once the budget refills, an edge goes through again.
    tokio::time::sleep(Duration::from_millis(1300)).await;
    assert_eq!(ctx.speak(&ctx.owner, true).await?, StatusCode::OK);
    assert!(ctx.is_speaking(ctx.owner_id));
    Ok(())
}

// ── Delivery over a real realtime stream ────────────────────────────────────

async fn mint_stream_ticket(app: &Router, token: &str) -> String {
    let request = Request::builder()
        .method(Method::POST)
        .uri("/api/v1/stream/ticket")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .expect("ticket request");
    let (status, body) = dispatch_json(app, request).await.expect("mint ticket");
    assert!(status.is_success(), "mint ticket failed: {status}");
    body["ticket"].as_str().expect("ticket").to_string()
}

async fn create_stream_session(app: &Router, token: &str) -> String {
    let request = Request::builder()
        .method(Method::POST)
        .uri("/api/v2/rt/session")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .expect("session request");
    let (_, body) = dispatch_json(app, request).await.expect("create session");
    body["session_id"].as_str().unwrap().to_string()
}

/// Read a user's stream for `window` and return every dispatch frame.
async fn read_stream(
    app: &Router,
    token: &str,
    window: Duration,
) -> tokio::task::JoinHandle<Vec<Value>> {
    let session_id = create_stream_session(app, token).await;
    let ticket = mint_stream_ticket(app, token).await;
    let app = app.clone();
    tokio::spawn(async move {
        use tower::ServiceExt;
        let uri = format!("/api/v2/rt/events?session_id={session_id}&cursor=0&ticket={ticket}");
        let request = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Body::empty())
            .expect("sse request");
        let response = app.oneshot(request).await.expect("sse response");
        let mut stream = response.into_body().into_data_stream();
        let mut buf = String::new();
        let mut frames = Vec::new();
        let deadline = tokio::time::Instant::now() + window;
        while let Ok(Some(Ok(chunk))) = tokio::time::timeout_at(deadline, stream.next()).await {
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(idx) = buf.find('\n') {
                let line = buf[..idx].trim().to_string();
                buf.drain(..=idx);
                if let Some(payload) = line.strip_prefix("data:") {
                    if let Ok(value) = serde_json::from_str::<Value>(payload.trim()) {
                        if value["t"].is_string() {
                            frames.push(value);
                        }
                    }
                }
            }
        }
        frames
    })
}

fn speaking_frames(frames: &[Value]) -> Vec<&Value> {
    frames
        .iter()
        .filter(|frame| frame["t"] == "VOICE_SPEAKING")
        .map(|frame| &frame["d"])
        .collect()
}

#[tokio::test]
async fn the_signal_reaches_channel_viewers_and_nobody_else() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (seer, _) = ctx.member("seer").await?;
    let (blind, blind_id) = ctx.member("blind").await?;
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &ctx.db,
        ctx.voice_id,
        blind_id,
        OVERWRITE_TARGET_MEMBER,
        0,
        Permissions::VIEW_CHANNEL.bits(),
    )
    .await?;
    paracord_core::permissions::invalidate_user(&ctx.test_app.state.permission_cache, blind_id)
        .await;

    ctx.join(&ctx.owner, ctx.voice_id).await?;
    let window = Duration::from_secs(2);
    let seer_reader = read_stream(&ctx.app, &seer, window).await;
    let blind_reader = read_stream(&ctx.app, &blind, window).await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    assert_eq!(ctx.speak(&ctx.owner, true).await?, StatusCode::OK);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(ctx.speak(&ctx.owner, false).await?, StatusCode::OK);

    let seen = seer_reader.await?;
    let blind_seen = blind_reader.await?;
    let edges = speaking_frames(&seen);
    assert_eq!(edges.len(), 2, "{seen:?}");
    assert_eq!(edges[0]["speaking"], true);
    assert_eq!(edges[0]["user_id"], ctx.owner_id.to_string());
    assert_eq!(edges[1]["speaking"], false);
    assert!(
        speaking_frames(&blind_seen).is_empty(),
        "cannot see the channel: {blind_seen:?}"
    );
    Ok(())
}

#[tokio::test]
async fn a_speaker_without_a_refresh_goes_stale() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    ctx.test_app
        .state
        .speaking
        .set_stale_after(Duration::from_millis(400));
    ctx.join(&ctx.owner, ctx.voice_id).await?;
    let mut events = ctx.events();
    assert_eq!(ctx.speak(&ctx.owner, true).await?, StatusCode::OK);
    assert!(ctx.is_speaking(ctx.owner_id));

    let seen = speaking_events(&mut events, Duration::from_millis(1200)).await;
    assert_eq!(
        seen.iter()
            .map(|e| e["speaking"].clone())
            .collect::<Vec<_>>(),
        vec![json!(true), json!(false)],
        "{seen:?}"
    );
    assert!(!ctx.is_speaking(ctx.owner_id));
    Ok(())
}

#[tokio::test]
async fn leaving_or_muting_clears_the_speaker() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (talker, talker_id) = ctx.member("talker").await?;
    ctx.join(&ctx.owner, ctx.voice_id).await?;
    ctx.join(&talker, ctx.voice_id).await?;

    // Leave.
    assert_eq!(ctx.speak(&ctx.owner, true).await?, StatusCode::OK);
    let mut events = ctx.events();
    ctx.leave(&ctx.owner).await?;
    let seen = speaking_events(&mut events, Duration::from_millis(400)).await;
    assert!(
        seen.iter().any(
            |e| e["user_id"].as_str() == Some(ctx.owner_id.to_string().as_str())
                && e["speaking"] == false
        ),
        "{seen:?}"
    );
    assert!(!ctx.is_speaking(ctx.owner_id));

    // Mute.
    assert_eq!(ctx.speak(&talker, true).await?, StatusCode::OK);
    assert!(ctx.is_speaking(talker_id));
    let mut events = ctx.events();
    ctx.set_self_mute(&talker, true).await?;
    let seen = speaking_events(&mut events, Duration::from_millis(400)).await;
    assert!(
        seen.iter().any(
            |e| e["user_id"].as_str() == Some(talker_id.to_string().as_str())
                && e["speaking"] == false
        ),
        "{seen:?}"
    );
    assert!(!ctx.is_speaking(talker_id));
    Ok(())
}

#[tokio::test]
async fn ready_carries_who_is_talking_now() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    let (quiet, quiet_id) = ctx.member("quiet").await?;
    let (viewer, _) = ctx.member("viewer").await?;
    ctx.join(&ctx.owner, ctx.voice_id).await?;
    ctx.join(&quiet, ctx.voice_id).await?;
    assert_eq!(ctx.speak(&ctx.owner, true).await?, StatusCode::OK);

    let frames = read_stream(&ctx.app, &viewer, Duration::from_millis(800))
        .await
        .await?;
    let ready = frames
        .iter()
        .find(|frame| frame["t"] == "READY")
        .context("READY frame")?;
    let guild = ready["d"]["guilds"]
        .as_array()
        .context("guilds")?
        .iter()
        .find(|guild| guild["id"].as_str() == Some(ctx.guild_id.to_string().as_str()))
        .context("guild in READY")?;
    let states = guild["voice_states"].as_array().context("voice states")?;
    let speaking_of = |user_id: i64| {
        states
            .iter()
            .find(|state| state["user_id"].as_str() == Some(user_id.to_string().as_str()))
            .map(|state| state["speaking"].clone())
    };
    assert_eq!(speaking_of(ctx.owner_id), Some(json!(true)), "{states:?}");
    assert_eq!(speaking_of(quiet_id), Some(json!(false)), "{states:?}");
    Ok(())
}
