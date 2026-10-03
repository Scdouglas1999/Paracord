//! Glass (WP-G5), SSE transport: READY and the realtime `voice_state_update`
//! command carry the listen mode and the stream start time, as the gateway
//! does. (Part of the out-of-scope patch to `routes/realtime.rs`.)

mod common;

use std::time::Duration;

use axum::{
    body::Body,
    http::{header, Method, Request},
    Router,
};
use common::{build_json_request, build_test_app, create_authenticated_user_token, dispatch_json};
use futures_util::StreamExt;
use serde_json::{json, Value};
use tower::ServiceExt;

async fn post(app: &Router, token: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    let (status, body) = dispatch_json(
        app,
        build_json_request(Method::POST, path, body, Some(token)).unwrap(),
    )
    .await
    .unwrap();
    (status.as_u16(), body)
}

async fn ready_frame(app: &Router, token: &str) -> Value {
    let (_, session) = post(app, token, "/api/v2/rt/session", None).await;
    let session_id = session["session_id"].as_str().unwrap().to_string();
    let (_, ticket) = post(app, token, "/api/v1/stream/ticket", None).await;
    let ticket = ticket["ticket"].as_str().unwrap().to_string();
    let request = Request::builder()
        .method(Method::GET)
        .uri(format!(
            "/api/v2/rt/events?session_id={session_id}&cursor=0&ticket={ticket}"
        ))
        .header(header::ACCEPT, "text/event-stream")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let mut stream = response.into_body().into_data_stream();
    let mut buf = String::new();
    loop {
        let chunk = tokio::time::timeout(Duration::from_secs(3), stream.next())
            .await
            .expect("a frame")
            .expect("stream open")
            .unwrap();
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(idx) = buf.find('\n') {
            let line = buf[..idx].trim().to_string();
            buf.drain(..=idx);
            if let Some(payload) = line.strip_prefix("data:") {
                if let Ok(value) = serde_json::from_str::<Value>(payload.trim()) {
                    if value["t"] == "READY" {
                        return value;
                    }
                }
            }
        }
    }
}

#[tokio::test]
async fn sse_ready_and_voice_state_commands_carry_mode_and_stream_start() {
    let ctx = build_test_app(common::TestAppOptions {
        native_media_enabled: true,
        ..Default::default()
    })
    .await
    .unwrap();
    let owner = create_authenticated_user_token(&ctx.db, &ctx.jwt_secret, "owner", "OwnerPass123!")
        .await
        .unwrap();
    let (_, guild) = post(
        &ctx.app,
        &owner,
        "/api/v1/guilds",
        Some(json!({ "name": "Game Night", "icon": Value::Null })),
    )
    .await;
    let guild_id = guild["id"].as_str().unwrap().to_string();
    let (_, channel) = post(
        &ctx.app,
        &owner,
        &format!("/api/v1/guilds/{guild_id}/channels"),
        Some(
            json!({ "name": "Lounge", "channel_type": 2, "parent_id": Value::Null,
                     "required_role_ids": Value::Null }),
        ),
    )
    .await;
    let channel_id = channel["id"].as_str().unwrap().to_string();

    let (status, joined) = post(
        &ctx.app,
        &owner,
        &format!("/api/v2/voice/{channel_id}/join"),
        None,
    )
    .await;
    assert_eq!(status, 200, "{joined}");
    let receipt = joined["session_id"].as_str().unwrap().to_string();
    let (status, _) = post(
        &ctx.app,
        &owner,
        &format!("/api/v1/voice/{channel_id}/stream?session_id={receipt}"),
        None,
    )
    .await;
    assert_eq!(status, 200);

    // The realtime mute command repeats the stored mode and start time.
    let mut events = ctx.event_bus.subscribe_system();
    let (status, body) = post(
        &ctx.app,
        &owner,
        "/api/v2/voice/state",
        Some(json!({ "guild_id": guild_id, "channel_id": channel_id, "self_mute": true })),
    )
    .await;
    assert!((200..300).contains(&status), "{body}");
    let mut update = None;
    while let Ok(event) = events.try_recv() {
        if event.event_type == "VOICE_STATE_UPDATE" {
            update = Some((*event.payload).clone());
        }
    }
    let update = update.expect("the mute is announced");
    assert_eq!(update["mode"], "joined", "{update}");
    assert!(update["self_stream_started_at"].is_string(), "{update}");

    // SSE READY lists the voice state with both fields.
    let ready = ready_frame(&ctx.app, &owner).await;
    let state = &ready["d"]["guilds"][0]["voice_states"][0];
    assert_eq!(state["mode"], "joined", "{ready}");
    assert!(state["self_stream_started_at"].is_string(), "{state}");
    serde_json::from_value::<paracord_contracts::voice::VoiceStateSnapshot>(state.clone())
        .expect("READY voice state matches the contract");
}
