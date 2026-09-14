//! What an attached realtime stream does when the server is going away.
//!
//! The SSE stream is open for as long as a browser tab is, and axum's
//! `with_graceful_shutdown` waits for every in-flight connection — so a stream
//! that does not end itself is a server that never restarts while anyone is
//! watching. These cover the order (the restart notice reaches the client
//! before the stream ends) and the door (a stream opened during the drain is
//! refused rather than handed a connection the drain would then wait for).

mod common;

use std::time::Duration;

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
    Router,
};
use common::{build_test_app, create_authenticated_user_token, TestAppOptions};
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
    body.get("ticket")
        .and_then(|v| v.as_str())
        .expect("ticket present")
        .to_string()
}

fn stream_request(ticket: &str) -> Request<Body> {
    Request::builder()
        .method(Method::GET)
        .uri(format!("/api/v2/rt/events?ticket={ticket}"))
        .body(Body::empty())
        .expect("build sse request")
}

/// Parse whatever complete `data:` frames are in `buf`, leaving any partial one.
fn drain_frames(buf: &mut String, frames: &mut Vec<Value>) {
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_attached_stream_is_told_the_server_is_restarting_and_then_ends() {
    let app_ctx = build_test_app(TestAppOptions::default()).await.unwrap();
    let token = create_authenticated_user_token(
        &app_ctx.db,
        &app_ctx.jwt_secret,
        "drainwatcher",
        "hunter2hunter2",
    )
    .await
    .unwrap();

    let ticket = mint_stream_ticket(&app_ctx.app, &token).await;
    let response = app_ctx
        .app
        .clone()
        .oneshot(stream_request(&ticket))
        .await
        .expect("sse stream response");
    assert!(response.status().is_success());
    let mut stream = response.into_body().into_data_stream();

    let mut buf = String::new();
    let mut frames: Vec<Value> = Vec::new();
    // READY first, so the stream is genuinely attached before the signal.
    while frames.is_empty() {
        let chunk = tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .expect("READY arrives")
            .expect("stream is open")
            .expect("chunk reads");
        buf.push_str(&String::from_utf8_lossy(&chunk));
        drain_frames(&mut buf, &mut frames);
    }
    assert_eq!(frames[0]["t"], "READY");

    // Exactly what the shutdown path does, in its order: publish the notice,
    // then latch the signal.
    app_ctx
        .state
        .event_bus
        .dispatch("SERVER_RESTART", json!({}), None);
    app_ctx.state.shutdown.trigger();

    let mut saw_notice = false;
    let mut ended = false;
    for _ in 0..20 {
        match tokio::time::timeout(Duration::from_secs(5), stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                buf.push_str(&String::from_utf8_lossy(&chunk));
                let before = frames.len();
                drain_frames(&mut buf, &mut frames);
                saw_notice |= frames[before..]
                    .iter()
                    .any(|frame| frame["t"] == "SERVER_RESTART");
            }
            Ok(Some(Err(err))) => panic!("stream failed instead of ending: {err}"),
            Ok(None) => {
                ended = true;
                break;
            }
            Err(_) => panic!("the stream neither delivered nor ended within 5s"),
        }
    }

    assert!(
        saw_notice,
        "the client is told why the stream is ending before it ends: {frames:?}"
    );
    assert!(
        ended,
        "an attached stream must end itself once shutdown is signalled — nothing \
         else closes it, and the drain waits for every open connection"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stream_opened_during_the_drain_is_refused() {
    let app_ctx = build_test_app(TestAppOptions::default()).await.unwrap();
    let token = create_authenticated_user_token(
        &app_ctx.db,
        &app_ctx.jwt_secret,
        "latecomer",
        "hunter2hunter2",
    )
    .await
    .unwrap();
    let ticket = mint_stream_ticket(&app_ctx.app, &token).await;

    app_ctx.state.shutdown.trigger();

    let response = app_ctx
        .app
        .clone()
        .oneshot(stream_request(&ticket))
        .await
        .expect("sse stream response");
    assert_eq!(
        response.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "a client reconnecting on the restart notice must not be handed a new \
         long-lived stream by the server that is going away"
    );
}
