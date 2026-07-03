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
/// Mint a single-use SSE stream ticket for `token`. The stream endpoint no
/// longer accepts the raw access token — it is exchanged for a ticket first.
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

async fn collect_gateway_frames(
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

fn frame_event_id(frame: &Value) -> Option<u64> {
    frame.get("event_id").and_then(|v| v.as_u64())
}

async fn create_session_body(app: &Router, token: &str) -> Value {
    let session_req = Request::builder()
        .method(Method::POST)
        .uri("/api/v2/rt/session")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .expect("session request");
    let (status, body) = common::dispatch_json(app, session_req)
        .await
        .expect("create session");
    assert!(status.is_success(), "create_session failed: {status}");
    body
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

/// A user must not be able to attach to another user's session channel by
/// supplying the victim's `session_id`; doing so would replay/tail the victim's
/// permission-filtered event stream (DMs, private channels).
#[tokio::test]
async fn sse_attach_with_foreign_session_id_is_rejected() {
    let app_ctx = build_test_app(TestAppOptions {
        jwt_secret: "sse-ownership-secret".to_string(),
        ..Default::default()
    })
    .await
    .expect("build test app");

    let token_a = create_authenticated_user_token(
        &app_ctx.db,
        &app_ctx.jwt_secret,
        "victim",
        "hunter2hunter2",
    )
    .await
    .expect("create user a token");
    let token_b = create_authenticated_user_token(
        &app_ctx.db,
        &app_ctx.jwt_secret,
        "attacker",
        "hunter2hunter2",
    )
    .await
    .expect("create user b token");

    // Victim establishes their session channel.
    let body_a = create_session_body(&app_ctx.app, &token_a).await;
    let victim_session = body_a["session_id"].as_str().unwrap().to_string();

    // Attacker (authenticated as themselves via their own ticket) tries to
    // attach to the victim's session id. This must be refused rather than
    // returning the victim's stream.
    let attacker_ticket = mint_stream_ticket(&app_ctx.app, &token_b).await;
    let uri =
        format!("/api/v2/rt/events?session_id={victim_session}&cursor=0&ticket={attacker_ticket}");
    let request = Request::builder()
        .method(Method::GET)
        .uri(uri)
        .body(Body::empty())
        .expect("build sse request");
    let response = app_ctx
        .app
        .clone()
        .oneshot(request)
        .await
        .expect("sse response");
    assert_eq!(
        response.status(),
        axum::http::StatusCode::FORBIDDEN,
        "attaching to another user's session id must be forbidden",
    );

    // The legitimate owner can still attach to their own session.
    let owner_frames = collect_gateway_frames(&app_ctx.app, &token_a, &victim_session, 0, 1).await;
    assert_eq!(
        owner_frames.first().and_then(frame_event_name),
        Some("READY"),
        "owner should still receive READY on their own session",
    );
}

/// The READY frame must carry the connection's resume cursor as its `event_id`
/// (not a hardcoded 1). A hardcoded 1 drives the client cursor backwards and,
/// on a forced resync, wedges the client into a permanent op-9 loop.
#[tokio::test]
async fn sse_ready_event_id_tracks_resume_cursor() {
    let app_ctx = build_test_app(TestAppOptions {
        jwt_secret: "sse-ready-cursor-secret".to_string(),
        ..Default::default()
    })
    .await
    .expect("build test app");

    let token = create_authenticated_user_token(
        &app_ctx.db,
        &app_ctx.jwt_secret,
        "readyuser",
        "hunter2hunter2",
    )
    .await
    .expect("create user token");

    let body = create_session_body(&app_ctx.app, &token).await;
    let session_id = body["session_id"].as_str().unwrap().to_string();
    let user_id: i64 = body["user_id"].as_str().unwrap().parse().unwrap();

    // Buffer a few events so a mid-stream resume cursor (2) is valid.
    for i in 1..=3 {
        app_ctx.event_bus.dispatch_to_users(
            "MESSAGE_CREATE",
            json!({ "id": i.to_string(), "content": format!("m{i}") }),
            vec![user_id],
        );
    }

    // Resume from cursor 2 (healthy replay of seq 3). READY.event_id must equal
    // the resume cursor, proving it is no longer hardcoded to 1.
    let frames = collect_gateway_frames(&app_ctx.app, &token, &session_id, 2, 2).await;
    let ready = frames.first().expect("at least the READY frame");
    assert_eq!(
        frame_event_name(ready),
        Some("READY"),
        "first frame is READY"
    );
    assert_eq!(
        frame_event_id(ready),
        Some(2),
        "READY event_id must equal the resume cursor, got {ready:?}",
    );
}
