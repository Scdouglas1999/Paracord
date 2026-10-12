//! One password: credential sign-up, sign-in, upgrade, change, reset, the key
//! backup and the credential claim (docs/setup-spec.md §3, §9.1).
//!
//! Route stubs registered by S0 so every later package compiles against the
//! real route table. Each answers 501 `{ code: "not_built" }` until S2 builds
//! it; the branch never merges with one left (`rg not_built`).

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

fn not_built(route: &'static str) -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "code": "not_built",
            "message": format!("{route} is not built yet."),
        })),
    )
        .into_response()
}

/// `POST /api/v1/auth/credential/params` — public (auth bucket).
pub async fn params() -> Response {
    not_built("POST /api/v1/auth/credential/params")
}

/// `POST /api/v1/auth/credential/register` — public (auth bucket, invite gate).
pub async fn register() -> Response {
    not_built("POST /api/v1/auth/credential/register")
}

/// `POST /api/v1/auth/credential/login` — public (auth bucket, auth guard).
pub async fn login() -> Response {
    not_built("POST /api/v1/auth/credential/login")
}

/// `POST /api/v1/auth/credential/upgrade` — session.
pub async fn upgrade() -> Response {
    not_built("POST /api/v1/auth/credential/upgrade")
}

/// `PUT /api/v1/users/@me/credential` — session (+MFA when on).
pub async fn change() -> Response {
    not_built("PUT /api/v1/users/@me/credential")
}

/// `POST /api/v1/users/@me/credential/reset` — session from a key sign-in.
pub async fn reset() -> Response {
    not_built("POST /api/v1/users/@me/credential/reset")
}

/// `GET /api/v1/users/@me/key-backup` — session.
pub async fn get_key_backup() -> Response {
    not_built("GET /api/v1/users/@me/key-backup")
}

/// `POST /api/v1/users/@me/key-backup/recovery-confirmed` — session.
pub async fn recovery_confirmed() -> Response {
    not_built("POST /api/v1/users/@me/key-backup/recovery-confirmed")
}

/// `POST /api/v1/setup/credential-claim` — public, claim token.
pub async fn claim() -> Response {
    not_built("POST /api/v1/setup/credential-claim")
}
