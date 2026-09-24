//! Presence activities: what a client may put on its presence (a "Listening
//! to" track from the desktop app's now-playing reader, a watch-together
//! session, a foreground game), what everybody else is sent, and how fast a
//! client may change it.

mod common;

use std::time::Duration;

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
};
use common::{build_test_app, create_authenticated_user_token, TestApp, TestAppOptions};
use serde_json::{json, Value};

async fn post_presence(app: &TestApp, token: &str, command_id: &str, payload: Value) -> StatusCode {
    let request = Request::builder()
        .method(Method::POST)
        .uri("/api/v2/rt/commands")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({
                "command_id": command_id,
                "type": "presence_update",
                "payload": payload,
            })
            .to_string(),
        ))
        .expect("build request");
    let (status, _) = common::dispatch_json(&app.app, request)
        .await
        .expect("dispatch");
    status
}

fn user_id(app: &TestApp, token: &str) -> i64 {
    paracord_core::auth::validate_token(token, &app.jwt_secret)
        .expect("valid token")
        .sub
}

fn listening(title: &str) -> Value {
    json!({
        "name": "Spotify",
        "type": 2,
        "details": title,
        "state": "Aphex Twin",
        "started_at": "2026-09-24T10:00:00.000Z",
        "ends_at": "2026-09-24T10:06:07.000Z",
    })
}

#[tokio::test]
async fn listening_activity_is_stored_and_fanned_out_to_co_members() {
    let app = build_test_app(TestAppOptions::default())
        .await
        .expect("test app");
    let token =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "listener", "S3curePassw0rd!")
            .await
            .expect("token");
    let peer_token =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "peer", "S3curePassw0rd!")
            .await
            .expect("peer token");
    let stranger_token =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "stranger", "S3curePassw0rd!")
            .await
            .expect("stranger token");
    let listener = user_id(&app, &token);
    let peer = user_id(&app, &peer_token);
    let stranger = user_id(&app, &stranger_token);

    let guild = paracord_util::snowflake::generate(1);
    paracord_db::guilds::create_guild(&app.db, guild, "Listening room", listener, None)
        .await
        .expect("guild");
    paracord_db::members::add_member(&app.db, listener, guild)
        .await
        .expect("listener member");
    paracord_db::members::add_member(&app.db, peer, guild)
        .await
        .expect("peer member");

    let mut events = app.state.event_bus.subscribe_system();
    let status = post_presence(
        &app,
        &token,
        "listen-1",
        json!({
            "status": "online",
            "activities": [
                listening("Windowlicker"),
                // Unknown kinds are dropped rather than clamped to something
                // a client would render wrongly.
                { "name": "Mystery", "type": 42 },
                // A watch-together session the Together feature sets.
                { "name": "Paracord", "type": 3, "details": "Watching Koyaanisqatsi" },
            ],
        }),
    )
    .await;
    assert!(status.is_success(), "presence update refused: {status}");

    let stored = app
        .state
        .user_presences
        .get(&listener)
        .map(|v| v.clone())
        .expect("presence stored");
    let activities = stored["activities"].as_array().expect("activities");
    assert_eq!(activities.len(), 2, "the unknown kind is dropped: {stored}");
    assert_eq!(activities[0]["type"], 2);
    assert_eq!(activities[0]["name"], "Spotify");
    assert_eq!(activities[0]["details"], "Windowlicker");
    assert_eq!(activities[0]["state"], "Aphex Twin");
    assert_eq!(activities[0]["ends_at"], "2026-09-24T10:06:07.000Z");
    assert_eq!(activities[1]["type"], 3);

    let event = loop {
        let event = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .expect("a presence event within 3s")
            .expect("event bus open");
        if event.event_type == "PRESENCE_UPDATE" {
            break event;
        }
    };
    let targets = event.target_user_ids.clone().expect("user-targeted");
    assert!(targets.contains(&peer), "a co-member is told: {targets:?}");
    assert!(
        targets.contains(&listener),
        "the listener's other sessions are told"
    );
    assert!(
        !targets.contains(&stranger),
        "someone who shares nothing is not told: {targets:?}"
    );
    assert_eq!(event.payload["activities"], stored["activities"]);

    // Clearing: the desktop app sends an empty list when playback stops.
    let status = post_presence(
        &app,
        &token,
        "listen-2",
        json!({ "status": "online", "activities": [] }),
    )
    .await;
    assert!(status.is_success());
    let stored = app
        .state
        .user_presences
        .get(&listener)
        .map(|v| v.clone())
        .expect("presence stored");
    assert_eq!(stored["activities"], json!([]));
}

#[tokio::test]
async fn listening_activity_text_is_capped() {
    let app = build_test_app(TestAppOptions::default())
        .await
        .expect("test app");
    let token =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "longtitle", "S3curePassw0rd!")
            .await
            .expect("token");
    let listener = user_id(&app, &token);

    let long = "t".repeat(2000);
    let status = post_presence(
        &app,
        &token,
        "long-1",
        json!({
            "status": "online",
            "activities": [{
                "name": long,
                "type": 2,
                "details": long,
                "state": long,
                "started_at": "not a time",
            }],
        }),
    )
    .await;
    assert!(status.is_success());
    let stored = app
        .state
        .user_presences
        .get(&listener)
        .map(|v| v.clone())
        .expect("presence stored");
    let activity = &stored["activities"][0];
    for key in ["name", "details", "state"] {
        assert_eq!(
            activity[key].as_str().unwrap().chars().count(),
            256,
            "{key}"
        );
    }
    assert!(
        activity["started_at"].is_null(),
        "a malformed timestamp is dropped"
    );
}

#[tokio::test]
async fn a_client_changing_tracks_too_fast_is_rate_limited() {
    let app = build_test_app(TestAppOptions::default())
        .await
        .expect("test app");
    let token =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "skipper", "S3curePassw0rd!")
            .await
            .expect("token");
    let listener = user_id(&app, &token);

    // The desktop app sends at most one presence update per 5 s (12 a minute).
    // The server's budget is 60 a minute, so an honest client never meets it,
    // and one hammering the skip button is refused with 429 rather than being
    // fanned out to every co-member on each press.
    let mut accepted = 0;
    let mut refused_at = None;
    for i in 0..80 {
        let status = post_presence(
            &app,
            &token,
            &format!("skip-{i}"),
            json!({ "status": "online", "activities": [listening(&format!("Track {i}"))] }),
        )
        .await;
        if status.is_success() {
            accepted += 1;
        } else {
            assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "update {i}");
            refused_at.get_or_insert(i);
        }
    }
    assert_eq!(accepted, 60, "the per-minute presence budget");
    assert_eq!(refused_at, Some(60));

    let stored = app
        .state
        .user_presences
        .get(&listener)
        .map(|v| v.clone())
        .expect("presence stored");
    assert_eq!(
        stored["activities"][0]["details"], "Track 59",
        "a refused update does not overwrite the last accepted one"
    );
}
