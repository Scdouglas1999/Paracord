//! Read-only transport facts for the guided voice connection check.
//!
//! The voice-join endpoints already return `media_endpoint`, `cert_hash` and
//! the rest of the native-media contract, but a client can only obtain them by
//! *joining* — which creates voice state, fires gateway events and puts the
//! account into a call. A diagnostic must never do that, so this route exposes
//! exactly the same configuration facts with no side effects: no voice state,
//! no room, no media token, no LiveKit API call.
//!
//! Nothing here is a reachability probe. The server cannot tell a client
//! whether *the client's* network can reach the media UDP port; only the client
//! attempting a real QUIC/WebTransport session can. This route reports what the
//! operator configured, and the client's connection check performs the actual
//! transport attempt against it.

use axum::{extract::State, http::HeaderMap, Json};
use paracord_core::AppState;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;

/// The voice transport an operator has actually brought up, as opposed to the
/// one they configured. `native_media_enabled` is reconciled at boot against
/// whether the QUIC endpoint really bound, so it is the truthful signal here.
fn configured_transport(state: &AppState) -> &'static str {
    if state.config.native_media_enabled && state.native_media.is_some() {
        "native"
    } else if state.config.livekit_available {
        "livekit"
    } else {
        "none"
    }
}

/// `GET /api/v1/voice/transport-diagnostics`
///
/// Authenticated, side-effect free. Returns the call transport this server is
/// running and, for the native path, the media endpoint plus the certificate
/// pin a browser needs for `serverCertificateHashes`.
pub async fn transport_diagnostics(
    State(state): State<AppState>,
    headers: HeaderMap,
    _auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let transport = configured_transport(&state);

    if transport != "native" {
        return Ok(Json(json!({
            "transport": transport,
            "voice_available": transport != "none",
            "media_endpoint": Value::Null,
            "media_endpoint_candidates": Vec::<String>::new(),
            "media_udp_port": Value::Null,
            "certificate_pin_sha256": Value::Null,
            // The media port only ever presents a certificate the server
            // generates for itself, so there is no CA path to advertise.
            "certificate_source": "none",
            "livekit_available": state.config.livekit_available,
            "e2ee_required": state.config.native_media_e2ee_required,
            "max_participants": state.config.native_media_max_participants,
        })));
    }

    let (media_endpoint, media_endpoint_candidates) =
        super::voice::native_media_endpoints(&headers, state.config.native_media_port);
    let certificate_pin_sha256 = state
        .native_media
        .as_ref()
        .map(|native| native.cert_hash.clone());

    Ok(Json(json!({
        "transport": "native",
        "voice_available": true,
        "media_endpoint": media_endpoint,
        "media_endpoint_candidates": media_endpoint_candidates,
        "media_udp_port": state.config.native_media_port,
        "certificate_pin_sha256": certificate_pin_sha256,
        // The native media endpoint always binds a certificate the server
        // generated for itself (see paracord-server's native media startup);
        // an operator's CA-issued TLS material terminates the *TCP* HTTPS
        // listener and is never presented on the QUIC media port.
        "certificate_source": "server-generated-self-signed",
        "livekit_available": state.config.livekit_available,
        "e2ee_required": state.config.native_media_e2ee_required,
        "max_participants": state.config.native_media_max_participants,
    })))
}
