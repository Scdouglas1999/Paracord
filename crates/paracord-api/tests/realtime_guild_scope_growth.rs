//! A server made while you are sitting in the app.
//!
//! A realtime session snapshots which guilds it belongs to when it is created,
//! and the event bus fanned guild-scoped events out through exactly that
//! snapshot. A guild created *after* a client connected was therefore in no
//! session's set: `GUILD_CREATE` was published to an audience of nobody, and
//! the creator watched their own new server fail to appear until they
//! relaunched. Everything that followed inside it — rooms, roles, members —
//! was addressed to the same empty audience.
//!
//! Recording the membership is what widens the fan-out now (see
//! `MemberIndex::add_member`), and the per-session recipient filter asks the
//! live membership index as well as its snapshot. These tests drive the real
//! routes over the real stream, so both halves have to hold: the bus has to
//! deliver, and the session has to accept.

mod common;

use std::time::Duration;

use axum::{
    body::Body,
    http::{header, Method, Request},
    Router,
};
use common::{build_json_request, build_test_app, create_authenticated_user_token, TestAppOptions};
use futures_util::StreamExt;
use serde_json::{json, Value};
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

async fn create_session(app: &Router, token: &str) -> String {
    let request = Request::builder()
        .method(Method::POST)
        .uri("/api/v2/rt/session")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .expect("session request");
    let (status, body) = common::dispatch_json(app, request)
        .await
        .expect("create session");
    assert!(status.is_success(), "create session failed: {status}");
    body["session_id"].as_str().expect("session id").to_string()
}

/// Attach the stream and read dispatch frames until `stop` is satisfied.
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
        while frames.len() < 32 {
            let chunk = match tokio::time::timeout(Duration::from_secs(5), stream.next()).await {
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

fn frame_of_type<'a>(frames: &'a [Value], event_type: &str) -> Option<&'a Value> {
    frames.iter().find(|frame| frame["t"] == event_type)
}

#[tokio::test]
async fn a_server_created_while_connected_reaches_the_creator() {
    let ctx = build_test_app(TestAppOptions::default())
        .await
        .expect("test app");
    let token =
        create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "founder", "hunter2hunter2")
            .await
            .expect("token");

    // Signed in, in the app, belonging to nothing yet — the session's guild
    // snapshot is empty, which is the whole point.
    let session_id = create_session(&ctx.app, &token).await;
    let ticket = mint_stream_ticket(&ctx.app, &token).await;
    let frames = reader(ctx.app.clone(), ticket, session_id, |frame| {
        frame["t"] == "GUILD_DELETE"
    });
    tokio::time::sleep(Duration::from_millis(300)).await;

    let (status, guild) = common::dispatch_json(
        &ctx.app,
        build_json_request(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": "Kestrel Robotics" })),
            Some(&token),
        )
        .expect("create guild request"),
    )
    .await
    .expect("create guild");
    assert_eq!(status, axum::http::StatusCode::CREATED, "{guild}");
    let guild_id = guild["id"].as_str().expect("guild id").to_string();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // ...and the rooms opened inside it, which are fanned out by the same
    // guild scope the session had no entry for.
    let (status, channel) = common::dispatch_json(
        &ctx.app,
        build_json_request(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(json!({ "name": "workshop", "channel_type": 0 })),
            Some(&token),
        )
        .expect("create channel request"),
    )
    .await
    .expect("create channel");
    assert_eq!(status, axum::http::StatusCode::CREATED, "{channel}");
    tokio::time::sleep(Duration::from_millis(300)).await;

    let (status, _) = common::dispatch_json(
        &ctx.app,
        build_json_request(
            Method::DELETE,
            &format!("/api/v1/guilds/{guild_id}"),
            None,
            Some(&token),
        )
        .expect("delete guild request"),
    )
    .await
    .expect("delete guild");
    assert_eq!(status, axum::http::StatusCode::NO_CONTENT);

    let frames = frames.await.expect("reader");
    let created = frame_of_type(&frames, "GUILD_CREATE")
        .unwrap_or_else(|| panic!("the creator was never told: {frames:?}"));
    assert_eq!(created["d"]["id"], json!(guild_id));

    let room = frame_of_type(&frames, "CHANNEL_CREATE")
        .unwrap_or_else(|| panic!("no room news from the new server: {frames:?}"));
    assert_eq!(room["d"]["guild_id"], json!(guild_id));

    let deleted = frame_of_type(&frames, "GUILD_DELETE")
        .unwrap_or_else(|| panic!("the server went away in silence: {frames:?}"));
    assert_eq!(deleted["d"]["id"], json!(guild_id));
}

#[tokio::test]
async fn a_server_joined_while_connected_reaches_the_joiner() {
    let ctx = build_test_app(TestAppOptions::default())
        .await
        .expect("test app");
    let owner_token =
        create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "owner", "hunter2hunter2")
            .await
            .expect("owner token");
    let joiner_token =
        create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "joiner", "hunter2hunter2")
            .await
            .expect("joiner token");

    let (status, guild) = common::dispatch_json(
        &ctx.app,
        build_json_request(
            Method::POST,
            "/api/v1/guilds",
            Some(json!({ "name": "Kestrel Robotics" })),
            Some(&owner_token),
        )
        .expect("create guild request"),
    )
    .await
    .expect("create guild");
    assert_eq!(status, axum::http::StatusCode::CREATED, "{guild}");
    let guild_id = guild["id"].as_str().expect("guild id").to_string();

    // The joiner is already signed in and connected when they walk in, so
    // their session's guild snapshot does not contain this server either.
    let session_id = create_session(&ctx.app, &joiner_token).await;
    let ticket = mint_stream_ticket(&ctx.app, &joiner_token).await;
    let frames = reader(ctx.app.clone(), ticket, session_id, |frame| {
        frame["t"] == "CHANNEL_CREATE"
    });
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Walk in the way a person does: an invite to a room in that server.
    let (status, channels) = common::dispatch_json(
        &ctx.app,
        build_json_request(
            Method::GET,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            None,
            Some(&owner_token),
        )
        .expect("list channels request"),
    )
    .await
    .expect("list channels");
    assert!(
        status.is_success(),
        "list channels failed: {status} {channels}"
    );
    let lobby = channels[0]["id"].as_str().expect("a room to invite into");
    let (status, invite) = common::dispatch_json(
        &ctx.app,
        build_json_request(
            Method::POST,
            &format!("/api/v1/channels/{lobby}/invites"),
            Some(json!({})),
            Some(&owner_token),
        )
        .expect("create invite request"),
    )
    .await
    .expect("create invite");
    assert!(
        status.is_success(),
        "create invite failed: {status} {invite}"
    );
    let code = invite["code"].as_str().expect("invite code");
    let (status, joined) = common::dispatch_json(
        &ctx.app,
        build_json_request(
            Method::POST,
            &format!("/api/v1/invites/{code}"),
            None,
            Some(&joiner_token),
        )
        .expect("accept invite request"),
    )
    .await
    .expect("accept invite");
    assert!(status.is_success(), "join failed: {status} {joined}");
    tokio::time::sleep(Duration::from_millis(300)).await;

    let (status, channel) = common::dispatch_json(
        &ctx.app,
        build_json_request(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(json!({ "name": "workshop", "channel_type": 0 })),
            Some(&owner_token),
        )
        .expect("create channel request"),
    )
    .await
    .expect("create channel");
    assert_eq!(status, axum::http::StatusCode::CREATED, "{channel}");

    let frames = frames.await.expect("reader");
    // Walking in is news in its own right: GUILD_MEMBER_ADD carries no guild,
    // so a session that joined elsewhere would have no server to show.
    let joined_event = frame_of_type(&frames, "GUILD_CREATE")
        .unwrap_or_else(|| panic!("the joiner was never told what they joined: {frames:?}"));
    assert_eq!(joined_event["d"]["id"], json!(guild_id));

    let room = frame_of_type(&frames, "CHANNEL_CREATE").unwrap_or_else(|| {
        panic!("a room opened in a server this session just joined went unheard: {frames:?}")
    });
    assert_eq!(room["d"]["guild_id"], json!(guild_id));
}
