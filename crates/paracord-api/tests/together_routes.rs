//! Watch together / Listen together: the server-authoritative session of a
//! voice channel.
//!
//! Covers the rules the brief sets: only people in the call may touch the
//! session, the starter can lock the controls, every change carries a strictly
//! larger `revision`, the session ends when the call empties (after a grace
//! period that survives a brief reconnect), and the slim guild-wide summary only
//! reaches people who can see the voice channel.

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
use tower::ServiceExt;

const SECRET: &str = "together-test-secret";
const CLIP: &str = "https://media.example.com/clips/timer%20test.mp4";

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
            create_authenticated_user_token(&test_app.db, SECRET, "owner", "TogetherPass123!")
                .await?;
        let owner_id = user_id_of(&owner);
        let app = test_app.app.clone();
        let db = test_app.db.clone();
        let mut ctx = Self {
            app,
            db,
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
            create_authenticated_user_token(&self.db, SECRET, prefix, "TogetherPass123!").await?;
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

    async fn join(&self, token: &str) -> anyhow::Result<()> {
        let (status, body) = self
            .call(
                token,
                Method::GET,
                &format!("/api/v1/voice/{}/join", self.voice_id),
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

    fn together(&self) -> String {
        format!("/api/v1/channels/{}/together", self.voice_id)
    }

    async fn start(&self, token: &str, policy: &str) -> anyhow::Result<(StatusCode, Value)> {
        self.call(
            token,
            Method::POST,
            &self.together(),
            Some(json!({
                "kind": "watch",
                "controller_policy": policy,
                "items": [
                    { "source": "url", "ref": CLIP },
                    { "source": "url", "ref": "https://example.com/song.mp3" },
                ],
            })),
        )
        .await
    }

    async fn playback(&self, token: &str, body: Value) -> anyhow::Result<(StatusCode, Value)> {
        self.call(
            token,
            Method::POST,
            &format!("{}/playback", self.together()),
            Some(body),
        )
        .await
    }

    async fn guild_activities(&self, token: &str) -> anyhow::Result<Value> {
        let (status, body) = self
            .call(
                token,
                Method::GET,
                &format!("/api/v1/guilds/{}/together", self.guild_id),
                None,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "guild activities: {body}");
        Ok(body)
    }
}

fn revision(value: &Value) -> u64 {
    value["revision"].as_u64().expect("numeric revision")
}

#[tokio::test]
async fn start_control_and_stop_a_session() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    ctx.join(&ctx.owner).await?;

    let (status, empty) = ctx
        .call(&ctx.owner, Method::GET, &ctx.together(), None)
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert!(empty["session"].is_null());
    assert!(empty["server_time_ms"].as_i64().unwrap() > 0);

    let (status, started) = ctx.start(&ctx.owner, "everyone").await?;
    assert_eq!(status, StatusCode::CREATED, "start: {started}");
    assert!(revision(&started) > revision(&empty));
    assert_eq!(started["kind"], "watch");
    assert_eq!(started["playing"], true);
    assert_eq!(started["current_index"], 0);
    assert_eq!(started["items"][0]["source"], "url");
    assert_eq!(started["items"][0]["title"], "timer test.mp4");
    assert_eq!(started["items"][0]["content_type"], "video/mp4");
    assert_eq!(started["items"][1]["content_type"], "audio/mpeg");
    assert_eq!(started["started_by"], ctx.owner_id.to_string());

    // A second start in the same call is refused.
    let (status, _) = ctx.start(&ctx.owner, "everyone").await?;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, paused) = ctx
        .playback(&ctx.owner, json!({ "action": "pause" }))
        .await?;
    assert_eq!(status, StatusCode::OK, "pause: {paused}");
    assert_eq!(paused["playing"], false);
    assert!(revision(&paused) > revision(&started));

    let (status, sought) = ctx
        .playback(
            &ctx.owner,
            json!({ "action": "seek", "position_ms": 760_000 }),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(sought["position_ms"], 760_000);
    assert_eq!(sought["playing"], false);

    let (status, playing) = ctx
        .playback(&ctx.owner, json!({ "action": "play" }))
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(playing["playing"], true);

    let second = started["items"][1]["id"].as_str().unwrap().to_string();
    let (status, skipped) = ctx
        .playback(&ctx.owner, json!({ "action": "skip" }))
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(skipped["current_index"], 1);
    assert_eq!(skipped["position_ms"], 0);

    // The media ending twice advances once.
    let (_, ended) = ctx
        .playback(&ctx.owner, json!({ "action": "ended", "item_id": second }))
        .await?;
    assert_eq!(ended["current_index"], 2);
    assert_eq!(ended["playing"], false);
    let (_, again) = ctx
        .playback(&ctx.owner, json!({ "action": "ended", "item_id": second }))
        .await?;
    assert_eq!(revision(&again), revision(&ended));

    // Queue: add, reorder, remove.
    let (status, added) = ctx
        .call(
            &ctx.owner,
            Method::POST,
            &format!("{}/items", ctx.together()),
            Some(json!({ "items": [{ "source": "url", "ref": "https://example.com/b.webm" }] })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "add: {added}");
    assert_eq!(added["items"].as_array().unwrap().len(), 3);
    // Nothing was current, so the new item starts.
    assert_eq!(added["current_index"], 2);
    assert_eq!(added["playing"], true);
    let newest = added["items"][2]["id"].as_str().unwrap().to_string();
    let (status, moved) = ctx
        .call(
            &ctx.owner,
            Method::PATCH,
            &format!("{}/items/{newest}", ctx.together()),
            Some(json!({ "index": 0 })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "move: {moved}");
    assert_eq!(moved["items"][0]["id"], newest.as_str());
    assert_eq!(moved["current_index"], 0, "the playing item keeps playing");
    let (status, removed) = ctx
        .call(
            &ctx.owner,
            Method::DELETE,
            &format!("{}/items/{second}", ctx.together()),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(removed["items"].as_array().unwrap().len(), 2);

    let (status, _) = ctx
        .call(&ctx.owner, Method::DELETE, &ctx.together(), None)
        .await?;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, after) = ctx
        .call(&ctx.owner, Method::GET, &ctx.together(), None)
        .await?;
    assert!(after["session"].is_null());
    assert!(revision(&after) > revision(&removed));
    Ok(())
}

#[tokio::test]
async fn only_people_in_the_call_may_use_it() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    ctx.join(&ctx.owner).await?;
    let (status, _) = ctx.start(&ctx.owner, "everyone").await?;
    assert_eq!(status, StatusCode::CREATED);

    // A member of the server who has not joined the call.
    let (outside, _) = ctx.member("outside").await?;
    let (status, body) = ctx
        .call(&outside, Method::GET, &ctx.together(), None)
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, _) = ctx.playback(&outside, json!({ "action": "pause" })).await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = ctx
        .call(&outside, Method::DELETE, &ctx.together(), None)
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Someone who is not in the server at all.
    let stranger =
        create_authenticated_user_token(&ctx.db, SECRET, "stranger", "TogetherPass123!").await?;
    let (status, _) = ctx
        .call(&stranger, Method::GET, &ctx.together(), None)
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Someone in the call who has since lost CONNECT.
    let (guest, guest_id) = ctx.member("guest").await?;
    ctx.join(&guest).await?;
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &ctx.db,
        ctx.voice_id,
        guest_id,
        OVERWRITE_TARGET_MEMBER,
        0,
        Permissions::CONNECT.bits(),
    )
    .await?;
    paracord_core::permissions::invalidate_user(&ctx.test_app.state.permission_cache, guest_id)
        .await;
    let (status, _) = ctx.call(&guest, Method::GET, &ctx.together(), None).await?;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Text channels have no call.
    let text_id = ctx.create_channel("general-chat", 0).await?;
    let (status, _) = ctx
        .call(
            &ctx.owner,
            Method::GET,
            &format!("/api/v1/channels/{text_id}/together"),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    Ok(())
}

#[tokio::test]
async fn sources_other_than_youtube_and_media_files_are_refused() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    ctx.join(&ctx.owner).await?;
    for item in [
        json!({ "source": "url", "ref": "https://example.com/page.html" }),
        json!({ "source": "url", "ref": "file:///etc/passwd.mp4" }),
        json!({ "source": "youtube", "ref": "not-an-id" }),
        json!({ "source": "twitch", "ref": "anything" }),
        // Direct links are https only, on the web and the desktop alike.
        json!({ "source": "url", "ref": "http://media.example.com/clip.mp4" }),
        // A preview image rides only with a file.
        json!({ "source": "url", "ref": "https://media.example.com/clip.mp4", "thumbnail": "data:image/jpeg;base64,/9j/" }),
    ] {
        let (status, body) = ctx
            .call(
                &ctx.owner,
                Method::POST,
                &ctx.together(),
                Some(json!({ "kind": "listen", "items": [item] })),
            )
            .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{item} -> {body}");
    }
    let (_, body) = ctx
        .call(
            &ctx.owner,
            Method::POST,
            &ctx.together(),
            Some(json!({ "kind": "watch", "items": [{ "source": "url", "ref": "https://example.com/x.html" }] })),
        )
        .await?;
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("Paracord can play YouTube links and direct video or audio files"),
        "{body}"
    );
    Ok(())
}

#[tokio::test]
async fn attachments_must_be_media_the_adder_can_see_in_this_server() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    ctx.join(&ctx.owner).await?;
    let text_id = ctx.create_channel("clips", 0).await?;
    let (status, message) = ctx
        .call(
            &ctx.owner,
            Method::POST,
            &format!("/api/v1/channels/{text_id}/messages"),
            Some(json!({ "content": "the clip" })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "{message}");
    let message_id: i64 = message["id"].as_str().unwrap().parse()?;
    let attach = |content_type: &'static str, filename: &'static str| {
        let db = ctx.db.clone();
        let owner_id = ctx.owner_id;
        async move {
            let id = paracord_util::snowflake::generate(1);
            paracord_db::attachments::create_attachment(
                &db,
                id,
                Some(message_id),
                filename,
                Some(content_type),
                1024,
                &format!("/api/v1/attachments/{id}"),
                None,
                None,
                Some(owner_id),
                Some(text_id),
                None,
                None,
            )
            .await
            .map(|row| row.id)
        }
    };
    let video = attach("video/mp4", "match-highlights.mp4").await?;
    let image = attach("image/png", "poster.png").await?;

    let (status, body) = ctx
        .call(
            &ctx.owner,
            Method::POST,
            &ctx.together(),
            Some(json!({ "kind": "watch", "items": [{ "source": "attachment", "ref": image.to_string() }] })),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    // A still that is not a small JPEG is refused.
    let (status, body) = ctx
        .call(
            &ctx.owner,
            Method::POST,
            &ctx.together(),
            Some(json!({ "kind": "watch", "items": [{ "source": "attachment", "ref": video.to_string(), "thumbnail": "data:image/svg+xml;base64,PHN2Zz4=" }] })),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    let still = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
    let (status, started) = ctx
        .call(
            &ctx.owner,
            Method::POST,
            &ctx.together(),
            Some(json!({ "kind": "watch", "items": [{ "source": "attachment", "ref": video.to_string(), "thumbnail": still }] })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED, "{started}");
    assert_eq!(started["items"][0]["title"], "match-highlights.mp4");
    assert_eq!(started["items"][0]["thumbnail"], still);
    assert_eq!(started["items"][0]["ref"], video.to_string());

    // A member in the call who cannot see the channel the file was posted in.
    let (guest, guest_id) = ctx.member("guest").await?;
    ctx.join(&guest).await?;
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &ctx.db,
        text_id,
        guest_id,
        OVERWRITE_TARGET_MEMBER,
        0,
        Permissions::VIEW_CHANNEL.bits(),
    )
    .await?;
    paracord_core::permissions::invalidate_user(&ctx.test_app.state.permission_cache, guest_id)
        .await;
    let (status, body) = ctx
        .call(
            &guest,
            Method::POST,
            &format!("{}/items", ctx.together()),
            Some(json!({ "items": [{ "source": "attachment", "ref": video.to_string() }] })),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    Ok(())
}

#[tokio::test]
async fn the_starter_can_lock_the_controls() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    ctx.join(&ctx.owner).await?;
    let (guest, _) = ctx.member("guest").await?;
    ctx.join(&guest).await?;
    let (status, started) = ctx.start(&ctx.owner, "starter").await?;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(started["controller_policy"], "starter");

    let (status, _) = ctx.playback(&guest, json!({ "action": "pause" })).await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = ctx
        .call(
            &guest,
            Method::POST,
            &format!("{}/items", ctx.together()),
            Some(json!({ "items": [{ "source": "url", "ref": "https://example.com/c.mp4" }] })),
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = ctx
        .call(&guest, Method::DELETE, &ctx.together(), None)
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // Only the starter changes who controls it.
    let (status, _) = ctx
        .call(
            &guest,
            Method::PATCH,
            &ctx.together(),
            Some(json!({ "controller_policy": "everyone" })),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // The media ending is not someone choosing: anyone may report it.
    let first = started["items"][0]["id"].as_str().unwrap();
    let (status, ended) = ctx
        .playback(&guest, json!({ "action": "ended", "item_id": first }))
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ended["current_index"], 1);

    let (status, _) = ctx
        .playback(&ctx.owner, json!({ "action": "pause" }))
        .await?;
    assert_eq!(status, StatusCode::OK);

    // A locked session whose starter leaves the call opens up to everyone.
    ctx.leave(&ctx.owner).await?;
    let mut policy = String::new();
    for _ in 0..50 {
        let (_, body) = ctx.call(&guest, Method::GET, &ctx.together(), None).await?;
        policy = body["session"]["controller_policy"]
            .as_str()
            .unwrap_or("")
            .to_string();
        if policy == "everyone" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(policy, "everyone");
    let (status, _) = ctx.playback(&guest, json!({ "action": "play" })).await?;
    assert_eq!(status, StatusCode::OK);
    Ok(())
}

#[tokio::test]
async fn updates_reach_the_call_in_revision_order() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    ctx.join(&ctx.owner).await?;
    let (guest, guest_id) = ctx.member("guest").await?;
    ctx.join(&guest).await?;
    let mut receiver = ctx
        .test_app
        .event_bus
        .register_session("guest-socket", guest_id, &[ctx.guild_id])
        .expect("register");

    ctx.start(&ctx.owner, "everyone").await?;
    ctx.playback(&ctx.owner, json!({ "action": "pause" }))
        .await?;
    ctx.playback(&guest, json!({ "action": "seek", "position_ms": 5_000 }))
        .await?;
    ctx.playback(&ctx.owner, json!({ "action": "play" }))
        .await?;
    ctx.call(&ctx.owner, Method::DELETE, &ctx.together(), None)
        .await?;

    let mut revisions = Vec::new();
    let mut actions = Vec::new();
    let mut slim = 0;
    while let Ok(event) = receiver.try_recv() {
        match event.event_type.as_str() {
            "TOGETHER_SESSION_UPDATE" => {
                revisions.push(revision(&event.payload));
                actions.push(
                    event.payload["action"]["type"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                );
                assert!(event.payload["server_time_ms"].as_i64().unwrap() > 0);
            }
            "TOGETHER_ACTIVITY_UPDATE" => slim += 1,
            _ => {}
        }
    }
    assert_eq!(actions, ["start", "pause", "seek", "play", "stop"]);
    assert!(revisions.windows(2).all(|w| w[0] < w[1]), "{revisions:?}");
    assert_eq!(slim, 5);
    Ok(())
}

#[tokio::test]
async fn a_late_joiner_is_handed_the_current_state() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    ctx.join(&ctx.owner).await?;
    ctx.start(&ctx.owner, "everyone").await?;
    ctx.playback(
        &ctx.owner,
        json!({ "action": "seek", "position_ms": 90_000 }),
    )
    .await?;
    let (late, late_id) = ctx.member("late").await?;
    let mut receiver = ctx
        .test_app
        .event_bus
        .register_session("late-socket", late_id, &[ctx.guild_id])
        .expect("register");
    ctx.join(&late).await?;
    let mut handed = None;
    for _ in 0..50 {
        while let Ok(event) = receiver.try_recv() {
            if event.event_type == "TOGETHER_SESSION_UPDATE" {
                handed = Some(event.payload.clone());
            }
        }
        if handed.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let handed = handed.context("late joiner got the session")?;
    assert!(handed["session"]["position_ms"].as_u64().unwrap() >= 90_000);
    assert!(handed["action"].is_null());
    Ok(())
}

#[tokio::test]
async fn the_session_ends_when_the_call_empties() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    ctx.test_app.state.together.set_empty_grace(Duration::ZERO);
    ctx.join(&ctx.owner).await?;
    let (watcher, _) = ctx.member("watcher").await?;
    ctx.start(&ctx.owner, "everyone").await?;
    assert_eq!(
        ctx.guild_activities(&watcher).await?["activities"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    ctx.leave(&ctx.owner).await?;
    let mut remaining = usize::MAX;
    for _ in 0..50 {
        remaining = ctx.guild_activities(&watcher).await?["activities"]
            .as_array()
            .unwrap()
            .len();
        if remaining == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(remaining, 0);
    Ok(())
}

#[tokio::test]
async fn the_queue_survives_everyone_briefly_dropping() -> anyhow::Result<()> {
    let ctx = Ctx::new().await?;
    // Default grace (30 s) applies.
    ctx.join(&ctx.owner).await?;
    let (_, started) = ctx.start(&ctx.owner, "everyone").await?;
    ctx.leave(&ctx.owner).await?;
    tokio::time::sleep(Duration::from_millis(200)).await;
    ctx.join(&ctx.owner).await?;
    let (status, body) = ctx
        .call(&ctx.owner, Method::GET, &ctx.together(), None)
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["session"]["session_id"], started["session_id"]);
    assert_eq!(body["session"]["items"].as_array().unwrap().len(), 2);
    Ok(())
}

// ── The slim summary over a real realtime stream ───────────────────────────

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

/// Read the stream for a few seconds and return every dispatch type seen.
fn read_stream(
    app: Router,
    ticket: String,
    session_id: String,
) -> tokio::task::JoinHandle<Vec<String>> {
    tokio::spawn(async move {
        let uri = format!("/api/v2/rt/events?session_id={session_id}&cursor=0&ticket={ticket}");
        let request = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Body::empty())
            .expect("sse request");
        let response = app.oneshot(request).await.expect("sse response");
        let mut stream = response.into_body().into_data_stream();
        let mut buf = String::new();
        let mut types = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while let Ok(Some(Ok(chunk))) = tokio::time::timeout_at(deadline, stream.next()).await {
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(idx) = buf.find('\n') {
                let line = buf[..idx].trim().to_string();
                buf.drain(..=idx);
                if let Some(payload) = line.strip_prefix("data:") {
                    if let Ok(value) = serde_json::from_str::<Value>(payload.trim()) {
                        if let Some(t) = value["t"].as_str() {
                            types.push(t.to_string());
                        }
                    }
                }
            }
        }
        types
    })
}

#[tokio::test]
async fn the_slim_summary_only_reaches_people_who_can_see_the_channel() -> anyhow::Result<()> {
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

    let seer_session = create_stream_session(&ctx.app, &seer).await;
    let blind_session = create_stream_session(&ctx.app, &blind).await;
    let seer_reader = read_stream(
        ctx.app.clone(),
        mint_stream_ticket(&ctx.app, &seer).await,
        seer_session,
    );
    let blind_reader = read_stream(
        ctx.app.clone(),
        mint_stream_ticket(&ctx.app, &blind).await,
        blind_session,
    );
    tokio::time::sleep(Duration::from_millis(300)).await;

    ctx.join(&ctx.owner).await?;
    let (status, _) = ctx.start(&ctx.owner, "everyone").await?;
    assert_eq!(status, StatusCode::CREATED);

    let seen = seer_reader.await?;
    let blind_seen = blind_reader.await?;
    assert!(
        seen.iter().any(|t| t == "TOGETHER_ACTIVITY_UPDATE"),
        "{seen:?}"
    );
    assert!(
        !seen.iter().any(|t| t == "TOGETHER_SESSION_UPDATE"),
        "not in the call: {seen:?}"
    );
    assert!(
        !blind_seen.iter().any(|t| t.starts_with("TOGETHER_")),
        "{blind_seen:?}"
    );

    // The REST listing applies the same rule.
    assert_eq!(
        ctx.guild_activities(&seer).await?["activities"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        ctx.guild_activities(&blind).await?["activities"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    Ok(())
}
