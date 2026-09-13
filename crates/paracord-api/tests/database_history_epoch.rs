mod common;

use axum::{
    body::to_bytes,
    http::{header, HeaderMap, Method, StatusCode},
    Router,
};
use common::{build_json_request, build_test_app, create_authenticated_user_token, TestAppOptions};
use serde_json::{json, Value};
use tower::ServiceExt;

const HEADER: &str = "x-paracord-history-epoch";

async fn request(
    app: &Router,
    token: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
    epochs: &[&str],
) -> (StatusCode, HeaderMap, Value) {
    let mut request = build_json_request(method, path, body, Some(token)).unwrap();
    for epoch in epochs {
        request.headers_mut().append(HEADER, epoch.parse().unwrap());
    }
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    (
        status,
        headers,
        serde_json::from_slice(&body).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn authenticated_metadata_matches_the_database_and_missing_header_remains_compatible() {
    let f = build_test_app(TestAppOptions::default()).await.unwrap();
    let token = create_authenticated_user_token(&f.db, &f.jwt_secret, "history", "History123!")
        .await
        .unwrap();
    let stored = paracord_db::server_settings::get_database_history_epoch(&f.db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored, f.state.database_history_epoch);
    for supplied in [vec![], vec![stored.as_str()]] {
        let (status, headers, _) = request(
            &f.app,
            &token,
            Method::GET,
            "/api/v1/users/@me",
            None,
            &supplied,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[HEADER], stored);
    }
    let (status, headers, _) = request(
        &f.app,
        &token,
        Method::POST,
        "/api/v1/guilds",
        Some(json!({"name":"Older client"})),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(headers[HEADER], stored);
}

#[tokio::test]
async fn a_known_stale_epoch_stops_mutations_and_is_never_adopted_from_the_request() {
    let f = build_test_app(TestAppOptions::default()).await.unwrap();
    let token =
        create_authenticated_user_token(&f.db, &f.jwt_secret, "stalehistory", "History123!")
            .await
            .unwrap();
    let stale = uuid::Uuid::new_v4().to_string();
    let (status, headers, body) = request(
        &f.app,
        &token,
        Method::POST,
        "/api/v1/guilds",
        Some(json!({"name":"Must not exist"})),
        &[&stale],
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "HISTORY_CHANGED");
    assert_eq!(headers[HEADER], f.state.database_history_epoch);
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM spaces")
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(
        paracord_db::server_settings::get_database_history_epoch(&f.db)
            .await
            .unwrap()
            .unwrap(),
        f.state.database_history_epoch
    );
    let (status, _, _) = request(
        &f.app,
        &token,
        Method::POST,
        "/api/v1/guilds",
        Some(json!({"name":"Current client"})),
        &[&f.state.database_history_epoch],
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
}

#[tokio::test]
async fn malformed_and_duplicate_epoch_headers_fail_before_the_handler() {
    let f = build_test_app(TestAppOptions::default()).await.unwrap();
    let token = create_authenticated_user_token(&f.db, &f.jwt_secret, "badheader", "History123!")
        .await
        .unwrap();
    let upper = f.state.database_history_epoch.to_ascii_uppercase();
    for supplied in [
        vec!["invalid"],
        vec!["00000000-0000-0000-0000-000000000000"],
        vec![upper.as_str()],
        vec![
            f.state.database_history_epoch.as_str(),
            f.state.database_history_epoch.as_str(),
        ],
    ] {
        let (status, headers, _) = request(
            &f.app,
            &token,
            Method::POST,
            "/api/v1/guilds",
            Some(json!({"name":"Rejected"})),
            &supplied,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(headers[HEADER], f.state.database_history_epoch);
    }
}

#[tokio::test]
async fn an_offline_history_replacement_changes_new_instances_and_keeps_old_responses_identifiable()
{
    let f = build_test_app(TestAppOptions::default()).await.unwrap();
    let token =
        create_authenticated_user_token(&f.db, &f.jwt_secret, "restoreepoch", "History123!")
            .await
            .unwrap();
    let original = f.state.database_history_epoch.clone();
    let mut tx = f.db.begin().await.unwrap();
    let restored = paracord_db::server_settings::rotate_database_history_epoch(&mut tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut restored_state = f.state.clone();
    restored_state.database_history_epoch =
        paracord_db::server_settings::get_or_create_database_history_epoch(&f.db)
            .await
            .unwrap();
    let restored_router = paracord_api::build_router(&restored_state).with_state(restored_state);
    let (status, headers, _) = request(
        &restored_router,
        &token,
        Method::POST,
        "/api/v1/guilds",
        Some(json!({"name":"Old queued operation"})),
        &[&original],
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(headers[HEADER], restored);
    // The instance identity is fixed at startup. This simulates the metadata on
    // a reply sent by the old instance before it shut down and delayed in transit.
    let (_, old_headers, _) =
        request(&f.app, &token, Method::GET, "/api/v1/users/@me", None, &[]).await;
    assert_eq!(old_headers[HEADER], original);
}

#[tokio::test]
async fn cors_allows_and_exposes_the_epoch_header() {
    let f = build_test_app(TestAppOptions::default()).await.unwrap();
    let token = create_authenticated_user_token(&f.db, &f.jwt_secret, "corshistory", "History123!")
        .await
        .unwrap();
    let mut preflight =
        build_json_request(Method::OPTIONS, "/api/v1/users/@me", None, None).unwrap();
    preflight
        .headers_mut()
        .insert(header::ORIGIN, "http://localhost:1420".parse().unwrap());
    preflight.headers_mut().insert(
        header::ACCESS_CONTROL_REQUEST_METHOD,
        "GET".parse().unwrap(),
    );
    preflight.headers_mut().insert(
        header::ACCESS_CONTROL_REQUEST_HEADERS,
        HEADER.parse().unwrap(),
    );
    let response = f.app.clone().oneshot(preflight).await.unwrap();
    assert!(response.status().is_success());
    assert!(response.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS]
        .to_str()
        .unwrap()
        .contains(HEADER));
    let mut req = build_json_request(Method::GET, "/api/v1/users/@me", None, Some(&token)).unwrap();
    req.headers_mut()
        .insert(header::ORIGIN, "http://localhost:1420".parse().unwrap());
    let response = f.app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers()[header::ACCESS_CONTROL_EXPOSE_HEADERS]
        .to_str()
        .unwrap()
        .contains(HEADER));
    assert_eq!(response.headers()[HEADER], f.state.database_history_epoch);
}
