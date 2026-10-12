//! The desktop app's control routes for "Paracord on this computer"
//! (docs/setup-spec.md §2.5, §9.1).
//!
//! Served only when `[host] enabled` (the desktop-host profile sets it). A
//! request is accepted when **all** of these hold, and refused with 401
//! `{ code: "host_auth" }` otherwise, without saying which one failed:
//!
//! - the TCP peer is a loopback address;
//! - no proxy header (`X-Forwarded-For`, `Forwarded`, `X-Real-IP`) is present,
//!   so a reverse proxy on the same machine cannot make a remote caller look
//!   like loopback;
//! - `Authorization: Host <token>` matches the contents of
//!   `[host] control_token_file` (rewritten at every start, 0600), compared in
//!   constant time.
//!
//! The token file is read on every request: it is the one source of truth, a
//! restart replaces it, and there is no copy in memory to leak or go stale.

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, FromRequestParts, State},
    http::{header, request::Parts, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use paracord_contracts::host::{BackupNowResponse, HostStatus, StorageKeyEscrowRequest};
use paracord_core::AppState;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::error::ApiError;
use crate::routes::host_status::{self, StatusError};

/// Why a request to `/host/*` was refused.
pub enum HostRejection {
    /// `[host] enabled` is false: these routes do not exist on this server.
    Disabled,
    /// Not loopback, proxied, or the token is missing or wrong.
    Auth,
    /// The token file cannot be read, so nobody can authenticate.
    TokenUnavailable,
}

impl IntoResponse for HostRejection {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            HostRejection::Disabled => (
                StatusCode::NOT_FOUND,
                "host_disabled",
                "This server is not run by the desktop app.",
            ),
            HostRejection::Auth => (
                StatusCode::UNAUTHORIZED,
                "host_auth",
                "Only the Paracord app on this computer can use this.",
            ),
            HostRejection::TokenUnavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "host_token_unavailable",
                "The control token could not be read.",
            ),
        };
        (status, Json(json!({ "code": code, "message": message }))).into_response()
    }
}

/// Extractor: a verified call from the desktop app on this machine.
pub struct HostControl;

const PROXY_HEADERS: [&str; 3] = ["x-forwarded-for", "forwarded", "x-real-ip"];

/// Constant-time equality for secrets of any length: compare SHA-256 digests.
fn secrets_equal(a: &str, b: &str) -> bool {
    let (a, b) = (Sha256::digest(a.as_bytes()), Sha256::digest(b.as_bytes()));
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

fn presented_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Host ")?.trim();
    (!token.is_empty()).then_some(token)
}

impl FromRequestParts<AppState> for HostControl {
    type Rejection = HostRejection;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if !state.config.host.enabled {
            return Err(HostRejection::Disabled);
        }
        let loopback = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(addr)| addr.ip().to_canonical().is_loopback())
            .unwrap_or(false);
        let proxied = PROXY_HEADERS
            .iter()
            .any(|name| parts.headers.contains_key(*name));
        if !loopback || proxied {
            return Err(HostRejection::Auth);
        }
        let Some(presented) = presented_token(&parts.headers) else {
            return Err(HostRejection::Auth);
        };
        let Some(path) = state.config.host.control_token_file.as_deref() else {
            tracing::error!("[host] enabled without control_token_file; refusing /host/* calls");
            return Err(HostRejection::TokenUnavailable);
        };
        let expected = match tokio::fs::read_to_string(path).await {
            Ok(contents) => contents.trim().to_string(),
            Err(err) => {
                tracing::error!("cannot read the host control token file {path}: {err}");
                return Err(HostRejection::TokenUnavailable);
            }
        };
        if expected.is_empty() || !secrets_equal(presented, &expected) {
            return Err(HostRejection::Auth);
        }
        Ok(HostControl)
    }
}

/// `GET /api/v1/host/status` → `HostStatus`.
pub async fn status(
    State(state): State<AppState>,
    _host: HostControl,
) -> Result<Json<HostStatus>, ApiError> {
    Ok(Json(host_status::collect(&state).await?))
}

/// `POST /api/v1/host/reachability/retry` → 202.
pub async fn retry_reachability(
    State(state): State<AppState>,
    _host: HostControl,
) -> Result<StatusCode, StatusError> {
    host_status::seams::request_reachability_retry(&state).await?;
    Ok(StatusCode::ACCEPTED)
}

/// `POST /api/v1/host/backup-now` → `BackupNowResponse`. Always includes
/// media: this is the backup before an update, and a restore must be whole.
pub async fn backup_now(
    State(state): State<AppState>,
    _host: HostControl,
) -> Result<Json<BackupNowResponse>, StatusError> {
    let name = host_status::run_backup(&state, true, state.config.max_backups).await?;
    Ok(Json(BackupNowResponse { name }))
}

/// `POST /api/v1/host/storage-key/escrow` → 204; 409 when already present.
pub async fn write_escrow(
    State(state): State<AppState>,
    _host: HostControl,
    Json(body): Json<StorageKeyEscrowRequest>,
) -> Result<StatusCode, StatusError> {
    host_status::store_escrow(&state, &body).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_compare_by_value_not_length_prefix() {
        assert!(secrets_equal("abc", "abc"));
        assert!(!secrets_equal("abc", "abd"));
        assert!(!secrets_equal("abc", "abcd"));
        assert!(!secrets_equal("", "abc"));
    }

    #[test]
    fn only_the_host_scheme_is_a_token() {
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Host t0ken".parse().unwrap());
        assert_eq!(presented_token(&headers), Some("t0ken"));
        headers.insert(header::AUTHORIZATION, "Bearer t0ken".parse().unwrap());
        assert_eq!(presented_token(&headers), None);
        headers.insert(header::AUTHORIZATION, "Host ".parse().unwrap());
        assert_eq!(presented_token(&headers), None);
    }
}
