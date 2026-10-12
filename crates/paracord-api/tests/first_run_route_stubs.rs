//! Every first-run setup route (docs/setup-spec.md §9.1) is registered, and
//! until its package builds it, it says so with 501 `{ code: "not_built" }`.
//!
//! Each owning package replaces its rows here with real tests (S2: credential
//! routes). S6's host and admin status routes are tested in `host_control.rs`.
//! The branch never merges while a
//! row is left (`rg not_built`).

mod common;

use axum::http::{Method, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json,
    TestAppOptions,
};
use serde_json::json;

const NOT_BUILT: &[(&str, &str)] = &[];

#[tokio::test]
async fn first_run_routes_are_registered_and_say_they_are_not_built() -> anyhow::Result<()> {
    let app = build_test_app(TestAppOptions::default()).await?;
    let token =
        create_authenticated_user_token(&app.db, &app.jwt_secret, "stubs", "Correct-Horse-1")
            .await?;
    for (method, path) in NOT_BUILT {
        let method = Method::from_bytes(method.as_bytes())?;
        let body = (method != Method::GET).then(|| json!({}));
        let request = build_json_request(method.clone(), path, body, Some(&token))?;
        let (status, payload) = dispatch_json(&app.app, request).await?;
        assert_eq!(
            status,
            StatusCode::NOT_IMPLEMENTED,
            "{method} {path}: {payload}"
        );
        assert_eq!(payload["code"], "not_built", "{method} {path}: {payload}");
    }

    Ok(())
}
