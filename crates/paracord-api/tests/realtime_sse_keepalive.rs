//! The idle realtime stream must say something a client can actually hear.
//!
//! The v2 SSE stream carries no periodic dispatch: a quiet account receives
//! READY and then nothing until something happens in its guilds. The only other
//! traffic is the keepalive, and for the 3.0 release candidate that keepalive
//! was an SSE *comment* (`: keep-alive`). The SSE specification requires every
//! consumer to discard comment lines — a browser `EventSource` fires no
//! `message` and no named listener, and the desktop client's native parser
//! drops them for the same reason — so a healthy idle stream was, to every
//! client, indistinguishable from one that had silently died. Each client's
//! liveness watchdog duly tore the connection down and rebuilt it, forever, on
//! a fixed cycle: one realtime session, one stream and one full world re-fetch
//! every ninety seconds, for as long as the app was open.
//!
//! This is the test that would have caught it: wait past the keepalive interval
//! on an idle stream and require an observable frame.

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

/// Longer than the server's 15s keepalive interval, with room for scheduling.
const IDLE_WAIT: Duration = Duration::from_secs(25);

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
    body.get("ticket")
        .and_then(|v| v.as_str())
        .expect("ticket present")
        .to_string()
}

/// One parsed SSE frame: its `event:` name and its joined `data:` payload.
#[derive(Debug)]
struct Frame {
    event: Option<String>,
    data: String,
}

/// Drain whatever complete frames are in `buf`, leaving any partial one behind.
///
/// Unlike a client, this keeps comment-only frames as `Frame { data: "" }` so a
/// test can tell "the server said nothing observable" from "the server spoke".
fn drain_frames(buf: &mut String, frames: &mut Vec<Frame>) {
    while let Some(idx) = buf.find("\n\n") {
        let raw: String = buf.drain(..idx + 2).collect();
        let mut event = None;
        let mut data: Vec<String> = Vec::new();
        for line in raw.lines() {
            if let Some(value) = line.strip_prefix("event:") {
                event = Some(value.trim().to_string());
            } else if let Some(value) = line.strip_prefix("data:") {
                data.push(value.trim().to_string());
            }
        }
        frames.push(Frame {
            event,
            data: data.join("\n"),
        });
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_stream_heartbeats_with_a_frame_the_client_can_see() {
    let app_ctx = build_test_app(TestAppOptions::default()).await.unwrap();
    let token = create_authenticated_user_token(
        &app_ctx.db,
        &app_ctx.jwt_secret,
        "idlewatcher",
        "hunter2hunter2",
    )
    .await
    .unwrap();

    let ticket = mint_stream_ticket(&app_ctx.app, &token).await;
    let response = app_ctx
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/v2/rt/events?ticket={ticket}"))
                .body(Body::empty())
                .expect("build sse request"),
        )
        .await
        .expect("sse stream response");
    assert!(response.status().is_success());
    let mut stream = response.into_body().into_data_stream();

    let mut buf = String::new();
    let mut frames: Vec<Frame> = Vec::new();
    while frames.is_empty() {
        let chunk = tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .expect("READY arrives")
            .expect("stream is open")
            .expect("chunk reads");
        buf.push_str(&String::from_utf8_lossy(&chunk));
        drain_frames(&mut buf, &mut frames);
    }
    let ready: Value = serde_json::from_str(&frames[0].data).expect("READY is JSON");
    assert_eq!(ready["t"], "READY");

    // Nothing happens in this account's world from here on. The next thing the
    // stream produces is the keepalive, and it has to be a frame a client can
    // observe — a comment would be discarded by every SSE consumer alive.
    frames.clear();
    let deadline = tokio::time::Instant::now() + IDLE_WAIT;
    while frames.is_empty() && tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                buf.push_str(&String::from_utf8_lossy(&chunk));
                drain_frames(&mut buf, &mut frames);
            }
            Ok(Some(Err(err))) => panic!("idle stream failed: {err}"),
            Ok(None) => panic!("idle stream ended instead of heartbeating"),
            Err(_) => {}
        }
    }

    let heartbeat = frames
        .first()
        .expect("an idle stream sends a keepalive within its interval");
    assert!(
        !heartbeat.data.is_empty(),
        "the keepalive was a comment, which every SSE client discards: {heartbeat:?}"
    );
    assert_eq!(
        heartbeat.event.as_deref(),
        Some("gateway"),
        "the keepalive must use the same event name as every other frame, or a \
         client listening for `gateway` never sees it: {heartbeat:?}"
    );
    let payload: Value =
        serde_json::from_str(&heartbeat.data).expect("the keepalive frame is JSON a client parses");
    assert_eq!(
        payload["op"], 11,
        "the keepalive reuses HEARTBEAT_ACK, which every shipped client already \
         understands as proof of life: {payload}"
    );
}
