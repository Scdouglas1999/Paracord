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
