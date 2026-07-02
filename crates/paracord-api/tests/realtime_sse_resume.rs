//! Integration coverage for honest SSE resume/replay.
//!
//! Verifies that events emitted during a reconnect gap are actually replayed
//! from the advertised cursor, in order — i.e. the resume is real, not the
//! old cosmetic `"cursor": 0` illusion that silently dropped gap events.

mod common;

use std::time::Duration;

use axum::{
    body::Body,
    http::{header, Method, Request},
    Router,
};
use common::{build_test_app, create_authenticated_user_token, TestAppOptions};
use futures_util::StreamExt;
use serde_json::{json, Value};
use tower::ServiceExt;

/// Open the SSE stream and collect gateway `data:` JSON frames until either
/// `want` frames are gathered or the per-read timeout elapses. Keep-alive
/// comments/lines are ignored.
async fn collect_gateway_frames(
    app: &Router,
    token: &str,
    session_id: &str,
    cursor: u64,
    want: usize,
) -> Vec<Value> {
    let uri = format!("/api/v2/rt/events?session_id={session_id}&cursor={cursor}");
    let request = Request::builder()
        .method(Method::GET)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .expect("build sse request");

    let response = app
        .clone()
        .oneshot(request)
        .await
        .expect("sse stream response");
    assert!(
        response.status().is_success(),
        "sse endpoint returned {}",
        response.status()
    );

    let mut stream = response.into_body().into_data_stream();
    let mut buf = String::new();
    let mut frames: Vec<Value> = Vec::new();

    while frames.len() < want {
        let chunk = match tokio::time::timeout(Duration::from_secs(3), stream.next()).await {
            Ok(Some(Ok(bytes))) => bytes,
            // Timed out or stream ended: return whatever we managed to collect.
            _ => break,
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));

        // SSE frames are delimited by a blank line. Parse any complete frames.
        while let Some(idx) = buf.find("\n\n") {
            let frame: String = buf.drain(..idx + 2).collect();
            for line in frame.lines() {
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data == "keep-alive" || data.is_empty() {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<Value>(data) {
                    frames.push(value);
                }
            }
        }
    }

    frames
}

fn frame_event_name(frame: &Value) -> Option<&str> {
    frame.get("t").and_then(|v| v.as_str())
}

fn frame_seq(frame: &Value) -> Option<u64> {
    frame.get("s").and_then(|v| v.as_u64())
}

#[tokio::test]
async fn sse_resume_replays_gap_events_in_order() {
    let app_ctx = build_test_app(TestAppOptions {
        jwt_secret: "sse-resume-secret".to_string(),
        ..Default::default()
    })
    .await
    .expect("build test app");

    let token = create_authenticated_user_token(
        &app_ctx.db,
        &app_ctx.jwt_secret,
        "sseuser",
        "hunter2hunter2",
    )
    .await
    .expect("create user token");

    // 1. Create the realtime session. This must advertise a real cursor and
    //    establish the persistent buffer/pump.
    let session_req = Request::builder()
        .method(Method::POST)
        .uri("/api/v2/rt/session")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .expect("session request");
    let (status, body) = common::dispatch_json(&app_ctx.app, session_req)
        .await
        .expect("create session");
    assert!(status.is_success(), "create_session failed: {status}");

    let session_id = body
        .get("session_id")
        .and_then(|v| v.as_str())
        .expect("session_id present")
        .to_string();
    let cursor = body
        .get("cursor")
        .and_then(|v| v.as_u64())
        .expect("cursor present");
    // Fresh session: no events dispatched yet, cursor starts at 0.
    assert_eq!(cursor, 0, "fresh session should advertise cursor 0");

    let user_id: i64 = body
        .get("user_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .expect("user_id present");

    // 2. Simulate the reconnect gap: while no SSE connection is attached, emit
    //    events that would previously have been lost.
    app_ctx.event_bus.dispatch_to_users(
        "MESSAGE_CREATE",
        json!({ "id": "1", "content": "gap-one" }),
        vec![user_id],
    );
    app_ctx.event_bus.dispatch_to_users(
        "MESSAGE_CREATE",
        json!({ "id": "2", "content": "gap-two" }),
        vec![user_id],
    );
    app_ctx.event_bus.dispatch_to_users(
        "MESSAGE_UPDATE",
        json!({ "id": "1", "content": "gap-one-edited" }),
        vec![user_id],
    );

    // 3. Reconnect with the advertised cursor and read the stream. Expect the
    //    READY frame followed by the three gap events replayed in order.
    let frames = collect_gateway_frames(&app_ctx.app, &token, &session_id, cursor, 4).await;

    let names: Vec<&str> = frames.iter().filter_map(frame_event_name).collect();
    assert!(
        names.first() == Some(&"READY"),
        "first frame must be READY, got: {names:?}",
    );

    let replayed: Vec<&str> = names.iter().copied().skip(1).collect();
    assert_eq!(
        replayed,
        vec!["MESSAGE_CREATE", "MESSAGE_CREATE", "MESSAGE_UPDATE"],
        "gap events must be replayed in emission order; got {names:?}",
    );

    // Sequences on replayed frames must be strictly increasing and > cursor.
    let seqs: Vec<u64> = frames.iter().skip(1).filter_map(frame_seq).collect();
    assert_eq!(
        seqs.len(),
        3,
        "expected 3 sequenced replay frames: {seqs:?}"
    );
    assert!(
        seqs.windows(2).all(|w| w[1] > w[0]),
        "replay sequences must be strictly increasing: {seqs:?}",
    );
    assert!(
        seqs.iter().all(|&s| s > cursor),
        "replayed sequences must exceed the resume cursor: {seqs:?}",
    );

    // Payload contents survive replay intact.
    let contents: Vec<&str> = frames
        .iter()
        .skip(1)
        .filter_map(|f| {
            f.get("d")
                .and_then(|d| d.get("content"))
                .and_then(|c| c.as_str())
        })
        .collect();
    assert_eq!(contents, vec!["gap-one", "gap-two", "gap-one-edited"]);
}

#[tokio::test]
async fn sse_resume_after_partial_read_does_not_duplicate_or_drop() {
    let app_ctx = build_test_app(TestAppOptions {
        jwt_secret: "sse-resume-secret-2".to_string(),
        ..Default::default()
    })
    .await
    .expect("build test app");

    let token = create_authenticated_user_token(
        &app_ctx.db,
        &app_ctx.jwt_secret,
        "sseuser2",
        "hunter2hunter2",
    )
    .await
    .expect("create user token");

    let session_req = Request::builder()
        .method(Method::POST)
        .uri("/api/v2/rt/session")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .expect("session request");
    let (_, body) = common::dispatch_json(&app_ctx.app, session_req)
        .await
        .expect("create session");
    let session_id = body["session_id"].as_str().unwrap().to_string();
    let user_id: i64 = body["user_id"].as_str().unwrap().parse().unwrap();

    // First gap: two events. Connect at cursor 0 and read them.
    app_ctx.event_bus.dispatch_to_users(
        "MESSAGE_CREATE",
        json!({ "id": "10", "content": "a" }),
        vec![user_id],
    );
    app_ctx.event_bus.dispatch_to_users(
        "MESSAGE_CREATE",
        json!({ "id": "11", "content": "b" }),
        vec![user_id],
    );

    let first = collect_gateway_frames(&app_ctx.app, &token, &session_id, 0, 3).await;
    // READY + 2 events.
    let first_replayed: Vec<u64> = first.iter().skip(1).filter_map(frame_seq).collect();
    assert_eq!(first_replayed.len(), 2, "first connect frames: {first:?}");
    let resume_cursor = *first_replayed.last().unwrap();

    // Second gap: one more event emitted after we "disconnected". Reconnecting
    // from the last-seen cursor must replay ONLY the new event (no duplicate of
    // the already-seen ones, no drop of the new one).
    app_ctx.event_bus.dispatch_to_users(
        "MESSAGE_CREATE",
        json!({ "id": "12", "content": "c" }),
        vec![user_id],
    );

    let second = collect_gateway_frames(&app_ctx.app, &token, &session_id, resume_cursor, 2).await;
    let second_events: Vec<&str> = second
        .iter()
        .skip(1)
        .filter_map(|f| {
            f.get("d")
                .and_then(|d| d.get("content"))
                .and_then(|c| c.as_str())
        })
        .collect();
    assert_eq!(
        second_events,
        vec!["c"],
        "reconnect must replay only the post-cursor event; got {second:?}",
    );
}
