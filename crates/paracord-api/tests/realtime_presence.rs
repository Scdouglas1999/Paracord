//! Presence over the realtime stream.
//!
//! Attaching the realtime stream is how a client tells the server it is here.
//! That accounting used to live only in the WebSocket gateway, so every client
//! on the SSE transport — which is what the app actually uses — stayed absent
//! from `online_users` for its whole session and rendered as offline to
//! everyone else. These tests pin the behaviour down at both ends: the
//! transition is published to the people entitled to see it, the READY snapshot
//! carries whoever is already online, and the subject never receives its own
//! connect event (which would eat a slot in its own resume window).

mod common;

use std::time::Duration;

use axum::{
    body::Body,
    http::{header, Method, Request},
    Router,
};
use common::{build_test_app, create_authenticated_user_token, TestAppOptions};
use futures_util::StreamExt;
use serde_json::Value;
use tower::ServiceExt;

async fn mint_stream_ticket(app: &Router, token: &str) -> String {
    let request = Request::builder()
        .method(Method::POST)
        .uri("/api/v1/stream/ticket")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .expect("ticket request");
    let (status, body) = common::dispatch_json(app, request)
        .await
        .expect("mint stream ticket");
    assert!(status.is_success(), "mint ticket failed: {status}");
    body["ticket"].as_str().expect("ticket present").to_string()
}

async fn create_session(app: &Router, token: &str) -> (String, i64) {
    let request = Request::builder()
        .method(Method::POST)
        .uri("/api/v2/rt/session")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .expect("session request");
    let (_, body) = common::dispatch_json(app, request)
        .await
        .expect("create session");
    (
        body["session_id"].as_str().unwrap().to_string(),
        body["user_id"].as_str().unwrap().parse().unwrap(),
    )
}

/// Attach the stream and collect up to `want` frames, holding the connection
/// open for the duration so the attachment stays live while we assert.
async fn collect_frames(
    app: &Router,
    token: &str,
    session_id: &str,
    cursor: u64,
    want: usize,
) -> Vec<Value> {
    let ticket = mint_stream_ticket(app, token).await;
    let uri = format!("/api/v2/rt/events?session_id={session_id}&cursor={cursor}&ticket={ticket}");
    let request = Request::builder()
        .method(Method::GET)
        .uri(uri)
        .body(Body::empty())
        .expect("build sse request");
    let response = app.clone().oneshot(request).await.expect("sse response");
    assert!(response.status().is_success());

    let mut stream = response.into_body().into_data_stream();
    let mut buf = String::new();
    let mut frames = Vec::new();
    while frames.len() < want {
        let chunk = match tokio::time::timeout(Duration::from_millis(600), stream.next()).await {
            Ok(Some(Ok(bytes))) => bytes,
            _ => break,
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(idx) = buf.find('\n') {
            let line = buf[..idx].trim().to_string();
            buf.drain(..=idx);
            if let Some(payload) = line.strip_prefix("data:") {
                if let Ok(value) = serde_json::from_str::<Value>(payload.trim()) {
                    frames.push(value);
                }
            }
        }
    }
    frames
}

fn presence_updates_for(frames: &[Value], user_id: i64) -> Vec<&Value> {
    // Ids cross the wire as strings; compare as `&str` so this cannot silently
    // become a always-false `Value::String == i64` check.
    let wanted = user_id.to_string();
    frames
        .iter()
        .filter(|f| f["t"] == "PRESENCE_UPDATE")
        .filter(|f| f["d"]["user_id"].as_str() == Some(wanted.as_str()))
        .collect()
}

#[tokio::test]
async fn attaching_the_stream_marks_the_user_online() {
    let ctx = build_test_app(TestAppOptions::default())
        .await
        .expect("test app");
    let token =
        create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "preson", "hunter2hunter2")
            .await
            .expect("token");
    let (session_id, user_id) = create_session(&ctx.app, &token).await;

    assert!(
        !ctx.state.online_users.contains(&user_id),
        "user must not be online before attaching a stream",
    );

    let _ = collect_frames(&ctx.app, &token, &session_id, 0, 1).await;

    assert!(
        ctx.state.online_users.contains(&user_id),
        "attaching the realtime stream must mark the user online",
    );
    assert_eq!(
        ctx.state
            .user_presences
            .get(&user_id)
            .map(|v| v["status"].clone()),
        Some(Value::from("online")),
        "the stored presence must say online",
    );
}

#[tokio::test]
async fn a_guild_peer_is_told_when_someone_comes_online() {
    let ctx = build_test_app(TestAppOptions::default())
        .await
        .expect("test app");

    let watcher_token =
        create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "watcher", "hunter2hunter2")
            .await
            .expect("watcher token");
    let (watcher_session, watcher_id) = create_session(&ctx.app, &watcher_token).await;

    let joiner_token =
        create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "joiner", "hunter2hunter2")
            .await
            .expect("joiner token");
    let (joiner_session, joiner_id) = create_session(&ctx.app, &joiner_token).await;

    // Put both in one space so the joiner's presence is scoped to the watcher.
    let guild_id = paracord_util::snowflake::generate(1);
    paracord_db::guilds::create_guild(&ctx.db, guild_id, "Presence Test", watcher_id, None)
        .await
        .expect("create guild");
    paracord_db::members::add_member(&ctx.db, watcher_id, guild_id)
        .await
        .expect("add watcher");
    paracord_db::members::add_member(&ctx.db, joiner_id, guild_id)
        .await
        .expect("add joiner");

    // The watcher stays attached — the case that matters is somebody sitting in
    // the app while another person arrives — so its stream is read on a task
    // that outlives the joiner's connect.
    let watcher_app = ctx.app.clone();
    let watcher_ticket = mint_stream_ticket(&ctx.app, &watcher_token).await;
    let watcher_reader = tokio::spawn(async move {
        let uri = format!(
            "/api/v2/rt/events?session_id={watcher_session}&cursor=0&ticket={watcher_ticket}"
        );
        let request = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Body::empty())
            .expect("build sse request");
        let response = watcher_app.oneshot(request).await.expect("sse response");
        let mut stream = response.into_body().into_data_stream();
        let mut buf = String::new();
        let mut frames: Vec<Value> = Vec::new();
        // Read past READY and keep going until the presence event lands.
        while frames.len() < 4 {
            let chunk = match tokio::time::timeout(Duration::from_secs(3), stream.next()).await {
                Ok(Some(Ok(bytes))) => bytes,
                _ => break,
            };
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(idx) = buf.find('\n') {
                let line = buf[..idx].trim().to_string();
                buf.drain(..=idx);
                if let Some(payload) = line.strip_prefix("data:") {
                    if let Ok(v) = serde_json::from_str::<Value>(payload.trim()) {
                        let is_presence = v["t"] == "PRESENCE_UPDATE";
                        frames.push(v);
                        if is_presence {
                            return frames;
                        }
                    }
                }
            }
        }
        frames
    });

    // Give the watcher's stream a moment to attach before the joiner arrives.
    tokio::time::sleep(Duration::from_millis(300)).await;

    // The joiner arrives.
    let joiner_frames = collect_frames(&ctx.app, &joiner_token, &joiner_session, 0, 1).await;

    // The watcher must be told about it.
    let watcher_frames = watcher_reader.await.expect("watcher reader");
    assert!(
        !presence_updates_for(&watcher_frames, joiner_id).is_empty(),
        "a guild peer must receive PRESENCE_UPDATE when someone connects; got {watcher_frames:?}",
    );

    // …and the joiner must not be handed its own connect event, which would
    // occupy a slot in its own replay window.
    assert!(
        presence_updates_for(&joiner_frames, joiner_id).is_empty(),
        "the connecting user must not receive its own presence event; got {joiner_frames:?}",
    );
}

#[tokio::test]
async fn ready_carries_guild_members_who_are_already_online() {
    let ctx = build_test_app(TestAppOptions::default())
        .await
        .expect("test app");

    let early_token =
        create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "early", "hunter2hunter2")
            .await
            .expect("early token");
    let (early_session, early_id) = create_session(&ctx.app, &early_token).await;

    let late_token =
        create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "late", "hunter2hunter2")
            .await
            .expect("late token");
    let (late_session, late_id) = create_session(&ctx.app, &late_token).await;

    let guild_id = paracord_util::snowflake::generate(1);
    paracord_db::guilds::create_guild(&ctx.db, guild_id, "Ready Test", early_id, None)
        .await
        .expect("create guild");
    paracord_db::members::add_member(&ctx.db, early_id, guild_id)
        .await
        .expect("add early");
    paracord_db::members::add_member(&ctx.db, late_id, guild_id)
        .await
        .expect("add late");

    // Someone is already here before the late arrival ever connects.
    let _ = collect_frames(&ctx.app, &early_token, &early_session, 0, 1).await;
    assert!(ctx.state.online_users.contains(&early_id));

    let frames = collect_frames(&ctx.app, &late_token, &late_session, 0, 1).await;
    let ready = frames
        .iter()
        .find(|f| f["t"] == "READY")
        .expect("READY frame");
    let presences = ready["d"]["guilds"]
        .as_array()
        .and_then(|guilds| guilds.first())
        .map(|g| g["presences"].clone())
        .unwrap_or(Value::Null);

    let wanted = early_id.to_string();
    let listed = presences
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .any(|p| p["user_id"].as_str() == Some(wanted.as_str()) && p["status"] == "online")
        })
        .unwrap_or(false);
    assert!(
        listed,
        "READY must list guild members who are already online, else they render \
         as offline until they happen to change status; got {presences:?}",
    );
}

/// Attach the stream and read frames until `stop` says we have what we came for,
/// holding the connection open in a task so the attachment outlives the call.
fn reader(
    app: Router,
    ticket: String,
    session_id: String,
    stop: fn(&Value) -> bool,
) -> tokio::task::JoinHandle<Vec<Value>> {
    tokio::spawn(async move {
        let uri = format!("/api/v2/rt/events?session_id={session_id}&cursor=0&ticket={ticket}");
        let request = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Body::empty())
            .expect("build sse request");
        let response = app.oneshot(request).await.expect("sse response");
        let mut stream = response.into_body().into_data_stream();
        let mut buf = String::new();
        let mut frames: Vec<Value> = Vec::new();
        while frames.len() < 16 {
            let chunk = match tokio::time::timeout(Duration::from_secs(3), stream.next()).await {
                Ok(Some(Ok(bytes))) => bytes,
                _ => break,
            };
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(idx) = buf.find('\n') {
                let line = buf[..idx].trim().to_string();
                buf.drain(..=idx);
                if let Some(payload) = line.strip_prefix("data:") {
                    if let Ok(value) = serde_json::from_str::<Value>(payload.trim()) {
                        let done = stop(&value);
                        frames.push(value);
                        if done {
                            return frames;
                        }
                    }
                }
            }
        }
        frames
    })
}

/// Two people, two live sessions, one building — joined into while both are
/// already signed in.
///
/// This is the shape the app is actually used in and the one nothing covered:
/// connecting publishes presence to the people you *already* share a space
/// with, and READY carries the presence of people in the buildings you were
/// *already* in. Somebody who signs in and then walks through an invite falls
/// between the two. Both of them stayed dark to each other for the whole
/// session — the member list right, every light off, "1 in" on both screens.
#[tokio::test]
async fn joining_a_building_lights_the_joiner_and_the_people_already_there() {
    let ctx = build_test_app(TestAppOptions::default())
        .await
        .expect("test app");

    let resident_token =
        create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "resident", "hunter2hunter2")
            .await
            .expect("resident token");
    let (resident_session, resident_id) = create_session(&ctx.app, &resident_token).await;

    let guild_id = paracord_util::snowflake::generate(1);
    paracord_db::guilds::create_guild(&ctx.db, guild_id, "Join Test", resident_id, None)
        .await
        .expect("create guild");
    paracord_db::members::add_member(&ctx.db, resident_id, guild_id)
        .await
        .expect("add resident");
    ctx.state.member_index.add_member(guild_id, resident_id);

    let channel_id = paracord_util::snowflake::generate(1);
    paracord_db::channels::create_channel(
        &ctx.db, channel_id, guild_id, "general", 0, 0, None, None,
    )
    .await
    .expect("create channel");

    // The joiner is signed in BEFORE they belong to anything — the whole point.
    let joiner_token =
        create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "joiner", "hunter2hunter2")
            .await
            .expect("joiner token");
    let (joiner_session, joiner_id) = create_session(&ctx.app, &joiner_token).await;

    // Both are sitting in the app with a live stream attached.
    let resident_ticket = mint_stream_ticket(&ctx.app, &resident_token).await;
    let resident_reader = reader(
        ctx.app.clone(),
        resident_ticket,
        resident_session,
        |frame| frame["t"] == "PRESENCE_UPDATE",
    );
    let joiner_ticket = mint_stream_ticket(&ctx.app, &joiner_token).await;
    let joiner_reader = reader(ctx.app.clone(), joiner_ticket, joiner_session, |frame| {
        frame["t"] == "PRESENCE_UPDATE"
    });
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        ctx.state.online_users.contains(&resident_id)
            && ctx.state.online_users.contains(&joiner_id),
        "both people must be online before the join",
    );

    // The resident mints an invite and the joiner walks through it.
    let invite_request = common::build_json_request(
        Method::POST,
        &format!("/api/v1/channels/{channel_id}/invites"),
        Some(serde_json::json!({})),
        Some(&resident_token),
    )
    .expect("invite request");
    let (status, invite) = common::dispatch_json(&ctx.app, invite_request)
        .await
        .expect("create invite");
    assert!(
        status.is_success(),
        "create invite failed: {status} {invite}"
    );
    let code = invite["code"].as_str().expect("invite code").to_string();

    let accept_request = common::build_json_request(
        Method::POST,
        &format!("/api/v1/invites/{code}"),
        Some(serde_json::json!({})),
        Some(&joiner_token),
    )
    .expect("accept request");
    let (status, accepted) = common::dispatch_json(&ctx.app, accept_request)
        .await
        .expect("accept invite");
    assert!(
        status.is_success(),
        "accept invite failed: {status} {accepted}"
    );

    let resident_frames = resident_reader.await.expect("resident reader");
    assert!(
        !presence_updates_for(&resident_frames, joiner_id).is_empty(),
        "somebody already in the building must be told the joiner's lights are on; \
         got {resident_frames:?}",
    );

    let joiner_frames = joiner_reader.await.expect("joiner reader");
    assert!(
        !presence_updates_for(&joiner_frames, resident_id).is_empty(),
        "the joiner must be told about the people already in the building, else \
         everyone there renders as offline until they happen to change status; \
         got {joiner_frames:?}",
    );
}
