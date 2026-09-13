//! An optional capability a deployment never configured answers 503 by design.
//!
//! That answer is the operator's own settled configuration, not a fault, and it
//! used to be written to the log as two ERROR lines per request — the only ERROR
//! lines a healthy server produced. The 503 stays on the wire exactly as it was;
//! what changes is that the response is *marked* as the expected answer so
//! request logging can record it beside the 4xx it behaves like.

mod common;

use axum::{
    body::to_bytes,
    http::{Method, StatusCode},
    response::IntoResponse,
    Router,
};
use common::{build_json_request, build_test_app, create_authenticated_user_token, TestAppOptions};
use paracord_api::error::{ApiError, ExpectedResponse};
use serde_json::{json, Value};
use tower::ServiceExt;

async fn send(
    app: &Router,
    method: Method,
    path: &str,
    body: Option<Value>,
    token: &str,
) -> anyhow::Result<(StatusCode, bool, Value)> {
    let request = build_json_request(method, path, body, Some(token))?;
    let response = app.clone().oneshot(request).await?;
    let status = response.status();
    let expected = response.extensions().get::<ExpectedResponse>().is_some();
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    let payload = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    Ok((status, expected, payload))
}

#[tokio::test]
async fn unconfigured_summary_answers_an_expected_503_without_changing_the_wire_contract(
) -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions {
        ai_provider: None,
        ..Default::default()
    })
    .await?;
    let token =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "summary", "Sup3rStr0ng!Pass")
            .await?;

    let (status, _, guild) = send(
        &app.app,
        Method::POST,
        "/api/v1/guilds",
        Some(json!({ "name": "Expected 503" })),
        &token,
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "guild create: {guild}");
    let guild_id = guild["id"].as_str().unwrap().to_string();

    let (status, _, channels) = send(
        &app.app,
        Method::GET,
        &format!("/api/v1/guilds/{guild_id}/channels"),
        None,
        &token,
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "channels: {channels}");
    let channel_id = channels
        .as_array()
        .unwrap()
        .iter()
        .find(|channel| channel["channel_type"].as_i64() == Some(0))
        .expect("the first space has a text room")["id"]
        .as_str()
        .unwrap()
        .to_string();

    let (status, _, message) = send(
        &app.app,
        Method::POST,
        &format!("/api/v1/channels/{channel_id}/messages"),
        Some(json!({ "content": "something worth summarizing" })),
        &token,
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "message: {message}");

    let (status, expected, body) = send(
        &app.app,
        Method::GET,
        &format!("/api/v1/channels/{channel_id}/summary"),
        None,
        &token,
    )
    .await?;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["code"], "SERVICE_UNAVAILABLE", "wire contract: {body}");
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("not configured"),
        "message: {body}"
    );
    assert!(
        expected,
        "the marker must survive every layer between the handler and the trace layer"
    );

    // A refusal the caller earned is not the deployment's settled state.
    let (status, expected, _) = send(
        &app.app,
        Method::GET,
        "/api/v1/channels/1/summary",
        None,
        &token,
    )
    .await?;
    assert!(status.is_client_error(), "unknown channel: {status}");
    assert!(!expected);

    Ok(())
}

#[test]
fn only_the_unconfigured_variant_is_marked_expected() {
    let configured = ApiError::ServiceUnavailable("the relay is down".into()).into_response();
    assert_eq!(configured.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(configured.extensions().get::<ExpectedResponse>().is_none());

    let unconfigured = ApiError::NotConfigured("Tenor API key not configured".into());
    // The two answers are indistinguishable on the wire, deliberately.
    assert_eq!(
        unconfigured.to_string(),
        "service unavailable: Tenor API key not configured"
    );
    let response = unconfigured.into_response();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(response.extensions().get::<ExpectedResponse>().is_some());
}
