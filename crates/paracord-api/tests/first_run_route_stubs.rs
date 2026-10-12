//! Every first-run setup route (docs/setup-spec.md §9.1) is registered, and
//! until its package builds it, it says so with 501 `{ code: "not_built" }`.
//!
//! Each owning package replaces its rows here with real tests (S2: credential
//! routes; S6: host and admin status routes). The branch never merges while a
//! row is left (`rg not_built`).

mod common;

use axum::http::{Method, StatusCode};
use common::{
    build_json_request, build_test_app, create_authenticated_user_token, dispatch_json,
    TestAppOptions,
};
use serde_json::json;

const NOT_BUILT: &[(&str, &str)] = &[
    ("POST", "/api/v1/auth/credential/params"),
    ("POST", "/api/v1/auth/credential/register"),
    ("POST", "/api/v1/auth/credential/login"),
    ("POST", "/api/v1/auth/credential/upgrade"),
    ("PUT", "/api/v1/users/@me/credential"),
    ("POST", "/api/v1/users/@me/credential/reset"),
    ("GET", "/api/v1/users/@me/key-backup"),
    ("POST", "/api/v1/users/@me/key-backup/recovery-confirmed"),
    ("POST", "/api/v1/setup/credential-claim"),
    ("GET", "/api/v1/host/status"),
    ("POST", "/api/v1/host/reachability/retry"),
    ("POST", "/api/v1/host/backup-now"),
    ("POST", "/api/v1/host/storage-key/escrow"),
    ("GET", "/api/v1/admin/host-status"),
    ("POST", "/api/v1/admin/reachability/retry"),
    ("POST", "/api/v1/admin/storage-key/escrow"),
    ("PATCH", "/api/v1/admin/backups"),
];

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

    // The existing backups listing still answers on the path PATCH now shares.
    let request = build_json_request(Method::GET, "/api/v1/admin/backups", None, Some(&token))?;
    let (status, payload) = dispatch_json(&app.app, request).await?;
    assert_ne!(status, StatusCode::NOT_IMPLEMENTED, "{payload}");
    assert_ne!(status, StatusCode::METHOD_NOT_ALLOWED, "{payload}");
    Ok(())
}
