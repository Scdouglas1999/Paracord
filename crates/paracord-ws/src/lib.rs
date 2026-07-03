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
    run_session, test_insert_cached_session, test_push_buffered_event, wait_for_identify_or_resume,
};
#[doc(hidden)]
pub use session::Session;

use axum::{
    extract::{ws::WebSocketUpgrade, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use paracord_core::AppState;
use std::collections::{BTreeSet, HashMap};

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

async fn ws_upgrade(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if !is_origin_allowed(&headers, &state) {
        return StatusCode::FORBIDDEN.into_response();
    }

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
            handler::handle_connection(socket, state, compress, stream_context)
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
