//! The desktop app's control routes for "Paracord on this computer"
//! (docs/setup-spec.md §2.5, §9.1): loopback peers carrying
//! `Authorization: Host <token>` only, served when `[host] enabled`.
//!
//! Route stubs registered by S0. Each answers 501 `{ code: "not_built" }`
//! until S6 builds it; the branch never merges with one left (`rg not_built`).

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

/// `GET /api/v1/host/status` → `HostStatus`.
pub async fn status() -> Response {
    not_built("GET /api/v1/host/status")
}

/// `POST /api/v1/host/reachability/retry` → 202.
pub async fn retry_reachability() -> Response {
    not_built("POST /api/v1/host/reachability/retry")
}

/// `POST /api/v1/host/backup-now` → `BackupNowResponse`.
pub async fn backup_now() -> Response {
    not_built("POST /api/v1/host/backup-now")
}

/// `POST /api/v1/host/storage-key/escrow` → 204; 409 when already present.
pub async fn write_escrow() -> Response {
    not_built("POST /api/v1/host/storage-key/escrow")
}
