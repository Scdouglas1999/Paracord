//! Instance status and hosting controls for admins (docs/setup-spec.md §4.7,
//! §5.5, §8.5, §9.1): the same `HostStatus` the desktop app reads, for
//! headless installs and Admin › Settings.
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

/// `GET /api/v1/admin/host-status` — admin → `HostStatus`.
pub async fn get_host_status() -> Response {
    not_built("GET /api/v1/admin/host-status")
}

/// `POST /api/v1/admin/reachability/retry` — admin → 202.
pub async fn retry_reachability() -> Response {
    not_built("POST /api/v1/admin/reachability/retry")
}

/// `POST /api/v1/admin/storage-key/escrow` — owner → 204.
pub async fn write_escrow() -> Response {
    not_built("POST /api/v1/admin/storage-key/escrow")
}

/// `PATCH /api/v1/admin/backups` — admin, `UpdateBackupsRequest` → 204.
pub async fn update_backups() -> Response {
    not_built("PATCH /api/v1/admin/backups")
}
