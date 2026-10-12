//! The invite preview bucket (setup-spec §6.2): 30 previews a minute per
//! source. The limiter is process-wide and these requests all share one
//! source, so this file holds only the bucket test; the miss lockout has its
//! own file (and process).

mod common;

use axum::http::{Method, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json,
    TestAppOptions,
};
use serde_json::{json, Value};

#[tokio::test]
async fn the_thirty_first_preview_in_a_minute_is_refused() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions {
        install_http_rate_limiter: true,
        ..Default::default()
    })
    .await?;
    let token =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "bucket", "BucketPass123!")
            .await?;
    let send = |method: Method, path: String, body: Option<Value>| {
        let token = token.clone();
        let router = app.app.clone();
        async move {
            dispatch_json(
                &router,
                build_json_request(method, &path, body, Some(&token))?,
            )
            .await
        }
    };

    let (_, guild) = send(
        Method::POST,
        "/api/v1/guilds".into(),
        Some(json!({ "name": "Bucket", "icon": Value::Null })),
    )
    .await?;
    let guild_id = guild["id"].as_str().unwrap().to_string();
    let (_, channel) = send(
        Method::POST,
        format!("/api/v1/guilds/{guild_id}/channels"),
        Some(json!({ "name": "general", "channel_type": 0, "parent_id": Value::Null, "required_role_ids": Value::Null })),
    )
    .await?;
    let channel_id = channel["id"].as_str().unwrap().to_string();
    let (status, invite) = send(
        Method::POST,
        format!("/api/v1/channels/{channel_id}/invites"),
        Some(json!({})),
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "{invite}");
    let code = invite["code"].as_str().unwrap().to_string();

    for n in 1..=30 {
        let (status, body) = send(Method::GET, format!("/api/v1/invites/{code}"), None).await?;
        assert_eq!(status, StatusCode::OK, "preview {n}: {body}");
    }
    let (status, body) = send(Method::GET, format!("/api/v1/invites/{code}"), None).await?;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["code"], "RATE_LIMITED");
    assert!(body["retry_after"].as_i64().unwrap() >= 1);

    // The bucket is the preview route's own: other routes are not held back by it.
    let (status, body) = send(Method::GET, "/api/v1/users/@me".into(), None).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    Ok(())
}
