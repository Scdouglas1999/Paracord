//! Regression coverage for realtime session-id squatting (SSE transport).
//!
//! `stream_events` takes `session_id` straight from the query string. The
//! *occupied* path in `get_or_create_channel` always rejected an owner mismatch,
//! but the *vacant* path registered whatever id the caller supplied into the
//! (gateway-shared) event bus under the caller's user id. Session ids were also
//! disclosed — the realtime session id was the login-session id, which READY
//! publishes for every visible voice state — so a co-member could claim a
//! victim's id before the victim did, permanently locking the victim out of
//! realtime (their own `create_session` then hit the occupied branch and 403'd)
//! and diverting the victim's user-targeted events, DMs included.
//!
//! Every id the server issues is now bound to its owner, so an id can only be
//! presented by the user it was issued to.

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

const JWT_SECRET: &str = "sse-squatting-secret";

/// The login-session id embedded in an access token. This models what an
/// attacker can learn about a victim: READY publishes every visible voice
/// state's `session_id`, and that value is the login-session id.
fn login_session_id(token: &str) -> String {
    paracord_core::auth::validate_token(token, JWT_SECRET)
        .expect("token validates")
        .sid
        .expect("session token carries sid")
}

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

async fn create_session_body(app: &Router, token: &str) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(Method::POST)
        .uri("/api/v2/rt/session")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .expect("session request");
    common::dispatch_json(app, request)
        .await
        .expect("create session")
}

/// Attempt to open the SSE stream with an explicit `session_id`, returning the
/// response status.
async fn open_stream_status(app: &Router, token: &str, session_id: &str) -> StatusCode {
    let ticket = mint_stream_ticket(app, token).await;
    let request = Request::builder()
        .method(Method::GET)
        .uri(format!(
            "/api/v2/rt/events?session_id={session_id}&cursor=0&ticket={ticket}"
        ))
        .body(Body::empty())
        .expect("build sse request");
    app.clone()
        .oneshot(request)
        .await
        .expect("sse response")
        .status()
}

/// Read gateway frames off the SSE stream until `want` are collected or a read
/// times out.
async fn collect_frames(app: &Router, token: &str, session_id: &str, want: usize) -> Vec<Value> {
    let ticket = mint_stream_ticket(app, token).await;
    let request = Request::builder()
        .method(Method::GET)
        .uri(format!(
            "/api/v2/rt/events?session_id={session_id}&cursor=0&ticket={ticket}"
        ))
        .body(Body::empty())
        .expect("build sse request");
    let response = app.clone().oneshot(request).await.expect("sse response");
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
            _ => break,
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));
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

/// The core squat: claim the victim's session id *before* the victim ever
/// establishes their channel. The vacant branch used to accept it.
#[tokio::test]
async fn a_disclosed_session_id_cannot_be_squatted_before_its_owner_connects() {
    let app_ctx = build_test_app(TestAppOptions {
        jwt_secret: JWT_SECRET.to_string(),
        ..Default::default()
    })
    .await
    .expect("build test app");

    let victim = create_authenticated_user_token(
        &app_ctx.db,
        &app_ctx.jwt_secret,
        "victim",
        "hunter2hunter2",
    )
    .await
    .expect("victim token");
    let attacker = create_authenticated_user_token(
        &app_ctx.db,
        &app_ctx.jwt_secret,
        "attacker",
        "hunter2hunter2",
    )
    .await
    .expect("attacker token");

    // The attacker knows the victim's session id and claims it first.
    let victim_sid = login_session_id(&victim);
    assert_eq!(
        open_stream_status(&app_ctx.app, &attacker, &victim_sid).await,
        StatusCode::FORBIDDEN,
        "claiming a session id issued to another user must be refused",
    );

    // The victim is not locked out: their own session still establishes.
    let (status, body) = create_session_body(&app_ctx.app, &victim).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the victim must still be able to establish realtime after a squat attempt",
    );
    let session_id = body["session_id"].as_str().expect("session_id").to_string();
    let user_id: i64 = body["user_id"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .expect("user_id");

    // ...and their user-targeted events still route to them, not the attacker.
    app_ctx.event_bus.dispatch_to_users(
        "MESSAGE_CREATE",
        json!({ "id": "1", "content": "private dm" }),
        vec![user_id],
    );
    let frames = collect_frames(&app_ctx.app, &victim, &session_id, 2).await;
    let names: Vec<&str> = frames
        .iter()
        .filter_map(|f| f["t"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        vec!["READY", "MESSAGE_CREATE"],
        "the victim must still receive their own DM; got {names:?}",
    );
    assert_eq!(
        frames[1]["d"]["content"].as_str(),
        Some("private dm"),
        "DM payload must reach its actual recipient",
    );
}

/// A session id the caller invented (or copied without its owner binding) is
/// refused, whether or not anything is registered under it.
#[tokio::test]
async fn a_session_id_the_server_never_issued_is_refused() {
    let app_ctx = build_test_app(TestAppOptions {
        jwt_secret: JWT_SECRET.to_string(),
        ..Default::default()
    })
    .await
    .expect("build test app");

    let token = create_authenticated_user_token(
        &app_ctx.db,
        &app_ctx.jwt_secret,
        "forger",
        "hunter2hunter2",
    )
    .await
    .expect("token");

    for forged in [
        "totally-made-up",
        "made-up.deadbeefdeadbeefdeadbeefdeadbeef",
        ".deadbeefdeadbeefdeadbeefdeadbeef",
    ] {
        assert_eq!(
            open_stream_status(&app_ctx.app, &token, forged).await,
            StatusCode::FORBIDDEN,
            "forged session id {forged:?} must be refused",
        );
    }
}

/// An issued id belongs to exactly one user: the owner may present it, a second
/// user may not, and the owner keeps working afterwards.
#[tokio::test]
async fn an_issued_session_id_is_usable_only_by_its_owner() {
    let app_ctx = build_test_app(TestAppOptions {
        jwt_secret: JWT_SECRET.to_string(),
        ..Default::default()
    })
    .await
    .expect("build test app");

    let owner = create_authenticated_user_token(
        &app_ctx.db,
        &app_ctx.jwt_secret,
        "owner",
        "hunter2hunter2",
    )
    .await
    .expect("owner token");
    let other = create_authenticated_user_token(
        &app_ctx.db,
        &app_ctx.jwt_secret,
        "other",
        "hunter2hunter2",
    )
    .await
    .expect("other token");

    let (status, body) = create_session_body(&app_ctx.app, &owner).await;
    assert_eq!(status, StatusCode::OK);
    let session_id = body["session_id"].as_str().expect("session_id").to_string();

    assert_eq!(
        open_stream_status(&app_ctx.app, &other, &session_id).await,
        StatusCode::FORBIDDEN,
        "a second user must not be able to present someone else's issued id",
    );
    assert!(
        open_stream_status(&app_ctx.app, &owner, &session_id)
            .await
            .is_success(),
        "the owner must still be able to attach to their own session",
    );
}

/// The owner binding must not cost session continuity: repeated
/// `create_session` calls from the same login session return the same id (and
/// therefore the same channel, buffer and cursor).
#[tokio::test]
async fn create_session_returns_a_stable_id_for_a_login_session() {
    let app_ctx = build_test_app(TestAppOptions {
        jwt_secret: JWT_SECRET.to_string(),
        ..Default::default()
    })
    .await
    .expect("build test app");

    let token = create_authenticated_user_token(
        &app_ctx.db,
        &app_ctx.jwt_secret,
        "stable",
        "hunter2hunter2",
    )
    .await
    .expect("token");

    let (_, first) = create_session_body(&app_ctx.app, &token).await;
    let first_id = first["session_id"]
        .as_str()
        .expect("session_id")
        .to_string();
    let user_id: i64 = first["user_id"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .expect("user_id");

    // An event arrives while nothing is attached; the cursor must advance.
    app_ctx.event_bus.dispatch_to_users(
        "MESSAGE_CREATE",
        json!({ "id": "1", "content": "gap" }),
        vec![user_id],
    );
    // Give the pump a moment to record it.
    tokio::time::sleep(Duration::from_millis(100)).await;

    let (_, second) = create_session_body(&app_ctx.app, &token).await;
    assert_eq!(
        second["session_id"].as_str(),
        Some(first_id.as_str()),
        "the same login session must keep the same realtime session id",
    );
    assert_eq!(
        second["cursor"].as_u64(),
        Some(1),
        "reconnecting must find the same channel, with its cursor intact",
    );
}

/// The pump's recipient filter (the SSE mirror of the gateway's
/// `Session::should_receive_event`). Without it the pump trusted the event bus's
/// indexes completely, so anything that reached its receiver — a DM addressed to
/// somebody else included — was rendered into this session's buffer.
#[test]
fn pump_recipient_filter_matches_the_gateway() {
    use paracord_api::routes::realtime::session_should_receive_event;

    const ME: i64 = 7;
    const SOMEONE_ELSE: i64 = 8;
    let member_of_10 = |gid: i64| gid == 10;

    // Targeted events reach their targets and nobody else...
    assert!(session_should_receive_event(
        ME,
        member_of_10,
        None,
        Some(&[ME])
    ));
    assert!(!session_should_receive_event(
        ME,
        member_of_10,
        None,
        Some(&[SOMEONE_ELSE])
    ));
    // ...even when the event also carries a guild this session belongs to.
    assert!(!session_should_receive_event(
        ME,
        member_of_10,
        Some(10),
        Some(&[SOMEONE_ELSE])
    ));

    // Guild-scoped events are gated on membership.
    assert!(session_should_receive_event(
        ME,
        member_of_10,
        Some(10),
        None
    ));
    assert!(!session_should_receive_event(
        ME,
        member_of_10,
        Some(99),
        None
    ));

    // Global events reach everyone.
    assert!(session_should_receive_event(ME, member_of_10, None, None));
}
