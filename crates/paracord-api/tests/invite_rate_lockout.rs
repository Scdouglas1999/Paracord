//! The invite miss lockout (setup-spec §6.2): twenty 404s from one source in
//! ten minutes shut the preview route to that source for ten minutes. The
//! limiter is process-wide and these requests all share one source, so this
//! file holds only this test.

mod common;

use axum::http::{Method, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json,
    TestAppOptions,
};
use serde_json::{json, Value};

#[tokio::test]
async fn twenty_misses_lock_the_source_out_even_for_a_real_code() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions {
        install_http_rate_limiter: true,
        ..Default::default()
    })
    .await?;
    let token =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "lockout", "LockoutPass123!")
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
        Some(json!({ "name": "Lockout", "icon": Value::Null })),
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
    let (_, invite) = send(
        Method::POST,
        format!("/api/v1/channels/{channel_id}/invites"),
        Some(json!({})),
    )
    .await?;
    let code = invite["code"].as_str().unwrap().to_string();

    // A hit between the misses does not reset the count.
    for n in 1..=19 {
        let (status, _) = send(Method::GET, format!("/api/v1/invites/miss{n:04}"), None).await?;
        assert_eq!(status, StatusCode::NOT_FOUND, "miss {n}");
        if n == 10 {
            let (status, _) = send(Method::GET, format!("/api/v1/invites/{code}"), None).await?;
            assert_eq!(status, StatusCode::OK);
        }
    }
    // The twentieth miss is still answered 404; it is what starts the lockout.
    let (status, _) = send(Method::GET, "/api/v1/invites/miss0020".into(), None).await?;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, body) = send(Method::GET, format!("/api/v1/invites/{code}"), None).await?;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["code"], "RATE_LIMITED");
    let retry = body["retry_after"].as_i64().unwrap();
    assert!((590..=600).contains(&retry), "retry_after {retry}");

    // Only the preview route is closed to that source.
    let (status, body) = send(Method::GET, "/api/v1/users/@me".into(), None).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    Ok(())
}
