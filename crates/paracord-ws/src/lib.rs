#![allow(
    clippy::if_same_then_else,
    clippy::question_mark,
    clippy::too_many_arguments,
    clippy::unnecessary_map_or,
    clippy::useless_conversion
)]

mod compression;
mod handler;
mod session;

// Internal seams re-exported for the crate's integration tests (see `tests/`).
// These are `#[doc(hidden)]` and not part of the supported public API.
#[doc(hidden)]
pub use compression::WsCompressor;
#[doc(hidden)]
pub use handler::{
    run_session, test_acquire_preauth_slot, test_acquire_user_connection_slot,
    test_buffered_event_count, test_drain_event_buffer, test_event_buffer_is_disconnected,
    test_insert_cached_session, test_max_connections_per_user, test_max_preauth_per_ip,
    test_push_buffered_event, test_release_event_buffer, test_release_preauth_slot,
    wait_for_identify_or_resume,
};
#[doc(hidden)]
pub use session::Session;

use axum::{
    extract::{ws::WebSocketUpgrade, ConnectInfo, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use paracord_core::AppState;
use std::collections::{BTreeSet, HashMap};
use std::net::SocketAddr;

pub fn gateway_router() -> Router<AppState> {
    Router::new().route("/gateway", get(ws_upgrade))
}

fn normalize_origin(origin: &str) -> String {
    origin.trim().trim_end_matches('/').to_ascii_lowercase()
}

fn default_allowed_origins() -> BTreeSet<String> {
    [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "http://localhost:1420",
        "http://127.0.0.1:1420",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]
    .into_iter()
    .map(normalize_origin)
    .collect()
}

fn build_allowed_origins(state: &AppState) -> BTreeSet<String> {
    let mut allowed = default_allowed_origins();

    if let Some(public_url) = state.config.public_url.as_deref() {
        if !public_url.trim().is_empty() {
            allowed.insert(normalize_origin(public_url));
        }
    }

    if let Ok(raw) = std::env::var("PARACORD_WS_ALLOWED_ORIGINS")
        .or_else(|_| std::env::var("PARACORD_CORS_ALLOWED_ORIGINS"))
    {
        for origin in raw.split(',').map(str::trim).filter(|v| !v.is_empty()) {
            allowed.insert(normalize_origin(origin));
        }
    }

    allowed
}

/// Internal seam exposed for the crate's integration tests. Delegates to the
/// private `is_origin_allowed` so tests can exercise Origin accept/reject without
/// standing up a full HTTP upgrade. Not part of the supported public API.
#[doc(hidden)]
pub fn test_is_origin_allowed(headers: &HeaderMap, state: &AppState) -> bool {
    is_origin_allowed(headers, state)
}

fn is_origin_allowed(headers: &HeaderMap, state: &AppState) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        // Native clients and non-browser callers typically omit Origin.
        return true;
    };

    let normalized = normalize_origin(origin);
    let allowed = build_allowed_origins(state);
    if allowed.contains("*") {
        tracing::warn!(
            "PARACORD_WS_ALLOWED_ORIGINS/CORS contains '*'; wildcard is not permitted for websocket origin checks"
        );
    }
    if allowed.contains(&normalized) {
        return true;
    }

    // Safe default for public self-hosting: allow browser same-origin WS
    // upgrades even when PARACORD_WS_ALLOWED_ORIGINS isn't configured yet.
    // This still blocks cross-origin origins because host:port must match.
    if let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) {
        let origin_no_scheme = origin
            .trim()
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .split('/')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        return origin_no_scheme == host.trim().to_ascii_lowercase();
    }

    false
}

/// Resolve the client IP used to bound concurrent unauthenticated handshakes.
///
/// Mirrors the HTTP layer's trust model: the socket peer address is used by
/// default, and `X-Forwarded-For` is only honored when `PARACORD_TRUST_PROXY` is
/// enabled and the peer is in `PARACORD_TRUSTED_PROXY_IPS`, so a client can't spoof
/// its bucket by sending a forwarded header directly.
fn client_ip(headers: &HeaderMap, connect_info: Option<SocketAddr>) -> Option<String> {
    let peer_ip = connect_info.map(|addr| addr.ip().to_string());
    let forwarded_for = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok());
    paracord_util::client_ip::resolve_client_ip_from_env(peer_ip.as_deref(), forwarded_for)
        .map(|ip| paracord_util::client_ip::normalize_for_rate_limit(&ip))
}

/// Optional peer-address extractor. Yields the client `SocketAddr` when the app
/// was served with `into_make_service_with_connect_info` (production) and `None`
/// otherwise (e.g. tests that drive the router directly). Used instead of
/// `Option<ConnectInfo<SocketAddr>>` because axum 0.8's `Option<T>` extractor
/// requires `OptionalFromRequestParts`, which `ConnectInfo` does not implement.
struct OptionalConnectInfo(Option<SocketAddr>);

impl<S: Send + Sync> axum::extract::FromRequestParts<S> for OptionalConnectInfo {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _state: &S,
    ) -> Result<Self, Self::Rejection> {
        Ok(OptionalConnectInfo(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|ci| ci.0),
        ))
    }
}

async fn ws_upgrade(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    connect_info: OptionalConnectInfo,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if !is_origin_allowed(&headers, &state) {
        return StatusCode::FORBIDDEN.into_response();
    }

    let peer_ip = client_ip(&headers, connect_info.0);

    let compress = params
        .get("compress")
        .map(|v| v == "zlib-stream")
        .unwrap_or(false);

    // Opt-in persistent zlib-stream context. Existing clients inflate each frame
    // standalone and would misdecode a streamed window, so this stays off unless
    // the client explicitly negotiates `zlib_context=stream`.
    let stream_context = compress
        && params
            .get("zlib_context")
            .map(|v| v == "stream")
            .unwrap_or(false);

    ws.max_message_size(32 * 1024)
        .max_frame_size(32 * 1024)
        .on_upgrade(move |socket| {
            handler::handle_connection(socket, state, compress, stream_context, peer_ip)
        })
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::default_allowed_origins;

    #[test]
    fn default_origins_include_tauri_https_origin() {
        let allowed = default_allowed_origins();
        assert!(allowed.contains("https://tauri.localhost"));
    }
}
