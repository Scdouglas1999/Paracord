mod common;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use base64::Engine as _;
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json, TestApp,
    TestAppOptions,
};
use serde_json::Value;

const PATH: &str = "/api/v1/voice/transport-diagnostics";

async fn account(app: &TestApp, name: &str) -> String {
    create_authenticated_user_token(&app.db, &app.jwt_secret, name, "Diagnostics123!")
        .await
        .unwrap()
}

async fn diagnostics(app: &TestApp, token: &str) -> (StatusCode, Value) {
    dispatch_json(
        &app.app,
        build_json_request(Method::GET, PATH, None, Some(token)).unwrap(),
    )
    .await
    .unwrap()
}

/// Same request, but with a `Host` so the endpoint is derived the way a real
/// browser request derives it.
async fn diagnostics_with_host(app: &TestApp, token: &str, host: &str) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(Method::GET)
        .uri(PATH)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::HOST, host)
        .body(Body::empty())
        .unwrap();
    dispatch_json(&app.app, request).await.unwrap()
}

#[tokio::test]
async fn transport_diagnostics_requires_authentication() {
    let app = build_test_app(TestAppOptions::default()).await.unwrap();
    let (status, _) = dispatch_json(
        &app.app,
        build_json_request(Method::GET, PATH, None, None).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn native_media_reports_its_endpoint_certificate_and_udp_port() {
    let app = build_test_app(TestAppOptions {
        native_media_enabled: true,
        native_media_port: 8443,
        native_media_e2ee_required: true,
        native_media_max_participants: 42,
        ..Default::default()
    })
    .await
    .unwrap();
    let token = account(&app, "diagnative").await;

    let (status, body) = diagnostics_with_host(&app, &token, "chat.example.com:8443").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["transport"], "native");
    assert_eq!(body["voice_available"], true);
    assert_eq!(
        body["media_endpoint"],
        "https://chat.example.com:8443/media"
    );
    assert_eq!(body["media_udp_port"], 8443);
    assert_eq!(body["certificate_source"], "server-generated-self-signed");
    assert_eq!(body["e2ee_required"], true);
    assert_eq!(body["max_participants"], 42);

    // The fingerprint a browser pins must be a base64 SHA-256 digest, or the
    // client's certificate step has nothing usable to offer.
    let pin = body["certificate_pin_sha256"]
        .as_str()
        .expect("native media must publish a certificate fingerprint");
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(pin)
        .expect("fingerprint must be base64");
    assert_eq!(decoded.len(), 32, "fingerprint must be a SHA-256 digest");

    let candidates = body["media_endpoint_candidates"].as_array().unwrap();
    assert!(
        candidates
            .iter()
            .any(|entry| entry == "https://chat.example.com:8443/media"),
        "the primary endpoint must appear among the candidates: {body}"
    );
}

#[tokio::test]
async fn a_relocated_media_port_is_reported_verbatim() {
    let app = build_test_app(TestAppOptions {
        native_media_enabled: true,
        native_media_port: 18191,
        ..Default::default()
    })
    .await
    .unwrap();
    let token = account(&app, "diagport").await;

    let (status, body) = diagnostics_with_host(&app, &token, "chat.example.com").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["media_udp_port"], 18191);
    assert_eq!(
        body["media_endpoint"],
        "https://chat.example.com:18191/media"
    );
}

#[tokio::test]
async fn a_livekit_server_reports_livekit_and_no_quic_endpoint() {
    let app = build_test_app(TestAppOptions {
        native_media_enabled: false,
        livekit_available: true,
        ..Default::default()
    })
    .await
    .unwrap();
    let token = account(&app, "diaglivekit").await;

    let (status, body) = diagnostics(&app, &token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["transport"], "livekit");
    assert_eq!(body["voice_available"], true);
    assert_eq!(body["media_endpoint"], Value::Null);
    assert_eq!(body["certificate_pin_sha256"], Value::Null);
    assert_eq!(body["certificate_source"], "none");
    assert_eq!(body["livekit_available"], true);
}

#[tokio::test]
async fn a_server_without_calls_says_so_instead_of_advertising_an_endpoint() {
    let app = build_test_app(TestAppOptions {
        native_media_enabled: false,
        livekit_available: false,
        ..Default::default()
    })
    .await
    .unwrap();
    let token = account(&app, "diagnone").await;

    let (status, body) = diagnostics(&app, &token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["transport"], "none");
    assert_eq!(body["voice_available"], false);
    assert_eq!(body["media_endpoint"], Value::Null);
    assert_eq!(
        body["media_endpoint_candidates"].as_array().unwrap().len(),
        0
    );
}

#[tokio::test]
async fn reading_transport_diagnostics_never_creates_voice_state() {
    let app = build_test_app(TestAppOptions {
        native_media_enabled: true,
        ..Default::default()
    })
    .await
    .unwrap();
    let token = account(&app, "diagnoside").await;
    let (status, me) = dispatch_json(
        &app.app,
        build_json_request(Method::GET, "/api/v1/users/@me", None, Some(&token)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(status, StatusCode::OK, "{me}");
    let user_id: i64 = me["id"].as_str().unwrap().parse().unwrap();

    for _ in 0..3 {
        let (status, body) = diagnostics(&app, &token).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    let states = paracord_db::voice_states::get_all_user_voice_states(&app.db, user_id)
        .await
        .unwrap();
    assert!(
        states.is_empty(),
        "a diagnostic read must not put the account into a call: {states:?}"
    );
}

// ── Browser capture permissions ─────────────────────────────────────────

/// A browser only reaches `getUserMedia` if the document that loaded it is
/// permitted to. The header used to send `camera=(), microphone=()`, which
/// disables capture for every browser client of a Paracord-served page — voice
/// could open its transport and then capture nothing. `(self)` grants the
/// capture APIs to this origin and to no embedder; `geolocation` stays denied
/// because the product never asks for it.
#[tokio::test]
async fn served_pages_may_capture_camera_microphone_and_screen_for_this_origin_only() {
    use tower::ServiceExt as _;

    let app = build_test_app(TestAppOptions::default()).await.unwrap();
    let token = account(&app, "permpolicy").await;

    for path in ["/api/v1/voice/transport-diagnostics", "/health"] {
        let request = Request::builder()
            .method(Method::GET)
            .uri(path)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let response = app.app.clone().oneshot(request).await.unwrap();
        let policy = response
            .headers()
            .get("permissions-policy")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_else(|| panic!("{path} must carry a Permissions-Policy"));
        assert_eq!(
            policy, "camera=(self), microphone=(self), display-capture=(self), geolocation=()",
            "{path}"
        );
    }
}

// ── Relay media counters ────────────────────────────────────────────────

const CALL_PASSWORD: &str = "MediaStats123!";

/// Create a guild with one voice channel, returning `(guild_id, channel_id)`.
async fn guild_with_voice_channel(app: &TestApp, token: &str) -> (String, String) {
    let (status, guild) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            "/api/v1/guilds",
            Some(serde_json::json!({ "name": "Media Stats Guild" })),
            Some(token),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(status, StatusCode::CREATED, "{guild}");
    let guild_id = guild["id"].as_str().unwrap().to_string();

    let (status, channel) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(serde_json::json!({ "name": "lounge", "channel_type": 2 })),
            Some(token),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(status, StatusCode::CREATED, "{channel}");
    (guild_id, channel["id"].as_str().unwrap().to_string())
}

async fn media_stats(app: &TestApp, token: &str, channel_id: &str) -> (StatusCode, Value) {
    dispatch_json(
        &app.app,
        build_json_request(
            Method::GET,
            &format!("/api/v1/voice/{channel_id}/media-stats"),
            None,
            Some(token),
        )
        .unwrap(),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn media_stats_requires_authentication_and_membership() {
    let app = build_test_app(TestAppOptions {
        native_media_enabled: true,
        ..Default::default()
    })
    .await
    .unwrap();
    let owner = account(&app, "statsowner").await;
    let (_guild_id, channel_id) = guild_with_voice_channel(&app, &owner).await;

    let (status, _) = dispatch_json(
        &app.app,
        build_json_request(
            Method::GET,
            &format!("/api/v1/voice/{channel_id}/media-stats"),
            None,
            None,
        )
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // A signed-in account that is not in this guild learns nothing about the
    // call: the counters name who is speaking in a room they cannot see.
    let outsider =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "statsoutsider", CALL_PASSWORD)
            .await
            .unwrap();
    let (status, body) = media_stats(&app, &outsider, &channel_id).await;
    assert!(
        status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND,
        "an outsider must be refused, got {status}: {body}"
    );
}

#[tokio::test]
async fn media_stats_reports_an_empty_room_and_refuses_a_text_channel() {
    let app = build_test_app(TestAppOptions {
        native_media_enabled: true,
        ..Default::default()
    })
    .await
    .unwrap();
    let owner = account(&app, "statsempty").await;
    let (guild_id, channel_id) = guild_with_voice_channel(&app, &owner).await;

    let (status, body) = media_stats(&app, &owner, &channel_id).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["transport"], "native");
    assert_eq!(body["room_id"], format!("{guild_id}:{channel_id}"));
    assert_eq!(body["connected_participants"], 0);
    assert_eq!(body["participants"].as_array().unwrap().len(), 0);

    // A text channel has no media room; asking for its counters is a mistake,
    // not an empty answer.
    let (status, text_channel) = dispatch_json(
        &app.app,
        build_json_request(
            Method::POST,
            &format!("/api/v1/guilds/{guild_id}/channels"),
            Some(serde_json::json!({ "name": "general", "channel_type": 0 })),
            Some(&owner),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(status, StatusCode::CREATED, "{text_channel}");
    let (status, body) = media_stats(&app, &owner, text_channel["id"].as_str().unwrap()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}

/// The counters come from the live relay, so an in-process connection registered
/// against the same `RelayForwarder` the route reads must show up — with the
/// media it actually moved, not with what the voice-state table claims.
#[tokio::test]
async fn media_stats_reports_a_live_connection_and_the_media_it_moved() {
    use bytes::Bytes;
    use paracord_relay::relay::ConnectionHandle;
    use paracord_transport::protocol::{MediaHeader, TrackType};

    let app = build_test_app(TestAppOptions {
        native_media_enabled: true,
        ..Default::default()
    })
    .await
    .unwrap();
    let owner = account(&app, "statslive").await;
    let owner_id = paracord_core::auth::validate_token(&owner, &app.jwt_secret)
        .unwrap()
        .sub;
    let (guild_id, channel_id) = guild_with_voice_channel(&app, &owner).await;
    let room_id = format!("{guild_id}:{channel_id}");

    let native = app.state.native_media.as_ref().expect("native media");
    let (outbound_tx, _outbound_rx) = tokio::sync::mpsc::channel::<Bytes>(8);
    let (_inbound_tx, inbound_rx) = tokio::sync::mpsc::channel::<Bytes>(8);
    let handle = ConnectionHandle::new_bridged(
        owner_id,
        room_id.clone(),
        "live-session".to_string(),
        outbound_tx,
        inbound_rx,
        None,
    );
    native.relay_forwarder.add_connection(handle.clone());

    let (status, body) = media_stats(&app, &owner, &channel_id).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["connected_participants"], 1);
    let row = &body["participants"][0];
    assert_eq!(row["user_id"], owner_id.to_string());
    assert_eq!(row["session_id"], "live-session");
    assert_eq!(row["transport"], "webtransport");
    assert_eq!(row["datagrams_sent"], 0);

    // Anything the relay hands this connection is counted, so a caller can tell
    // "joined and silent" from "joined and receiving".
    let header = MediaHeader {
        version: 1,
        track_type: TrackType::Audio,
        simulcast_layer: 0,
        sequence: 1,
        timestamp: 1,
        ssrc: 7,
        audio_level: 10,
        key_epoch: 1,
        payload_length: 4,
        codec: 0,
    };
    let mut packet = header.to_bytes().to_vec();
    packet.extend_from_slice(b"opus");
    let packet_len = packet.len() as u64;
    handle.send_datagram(Bytes::from(packet)).unwrap();

    let (status, body) = media_stats(&app, &owner, &channel_id).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["participants"][0]["datagrams_sent"], 1);
    assert_eq!(body["participants"][0]["bytes_sent"], packet_len);

    // A closed connection is retired from the room read.
    native.relay_forwarder.remove_connection(owner_id);
    let (status, body) = media_stats(&app, &owner, &channel_id).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["connected_participants"], 0);
}
