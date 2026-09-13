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

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
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
        // Read at answer time: a rotation may have republished the pin since
        // this process started, and a client that pins a stale hash is refused.
        .map(|native| native.cert_hash.get());

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

/// `GET /api/v1/voice/{channel_id}/media-stats`
///
/// Authenticated, side-effect free, and gated by the same `VIEW_CHANNEL` +
/// `CONNECT` permissions a join is: it reports who currently holds a live media
/// connection to this room and how much media each of them has actually moved.
///
/// This is the only surface that can answer "did the call carry audio". The
/// voice-state tables say a member *joined*; the bandwidth estimator's window
/// says how fast someone is sending *right now* and forgets it seconds later.
/// Neither survives as evidence that packets flowed, which is what an operator
/// diagnosing a silent call — and the browser-voice end-to-end test — needs.
///
/// Counters are cumulative for the life of one media connection, so a reconnect
/// restarts them; `session_id` says which call each row belongs to.
pub async fn channel_media_stats(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if channel.channel_type != 2 && channel.channel_type != 13 {
        return Err(ApiError::BadRequest("Not a voice channel".into()));
    }
    let guild_id = channel.guild_id().ok_or(ApiError::BadRequest(
        "Voice is only supported in guild channels".into(),
    ))?;
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let perms = paracord_core::permissions::compute_channel_permissions(
        &state.db,
        guild_id,
        channel_id,
        guild.owner_id,
        auth.user_id,
    )
    .await?;
    paracord_core::permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;
    paracord_core::permissions::require_permission(perms, Permissions::CONNECT)?;

    let room_id = format!("{guild_id}:{channel_id}");
    let participants: Vec<Value> = state
        .native_media
        .as_ref()
        .map(|native| native.relay_forwarder.room_media_stats(&room_id))
        .unwrap_or_default()
        .into_iter()
        .map(|stats| {
            json!({
                // Snowflakes cross the wire as strings, as everywhere else.
                "user_id": stats.user_id.to_string(),
                "session_id": stats.session_id,
                "transport": stats.transport,
                "datagrams_received": stats.datagrams_received,
                "bytes_received": stats.bytes_received,
                "audio_datagrams_received": stats.audio_datagrams_received,
                "video_datagrams_received": stats.video_datagrams_received,
                "stream_frames_received": stats.stream_frames_received,
                "datagrams_sent": stats.datagrams_sent,
                "bytes_sent": stats.bytes_sent,
                "stream_frames_sent": stats.stream_frames_sent,
            })
        })
        .collect();

    Ok(Json(json!({
        "transport": configured_transport(&state),
        "room_id": room_id,
        "connected_participants": participants.len(),
        "participants": participants,
    })))
}
