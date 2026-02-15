use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::ApiError;
use crate::middleware::AuthUser;

fn first_forwarded_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|raw| raw.split(',').next())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
}

fn is_frontend_dev_proxy_host(host: &str) -> bool {
    host.rsplit_once(':')
        .map(|(_, port)| matches!(port, "1420" | "5173"))
        .unwrap_or(false)
}

fn resolve_livekit_client_url(headers: &HeaderMap, fallback: &str) -> String {
    let host = first_forwarded_value(headers, "x-forwarded-host")
        .or_else(|| first_forwarded_value(headers, "host"));
    let forwarded_proto = first_forwarded_value(headers, "x-forwarded-proto")
        .or_else(|| first_forwarded_value(headers, "x-forwarded-scheme"))
        .or_else(|| first_forwarded_value(headers, "x-forwarded-protocol"));

    if let Some(host) = host {
        // When requests are proxied through a frontend dev server (for example
        // localhost:1420/5173), the host points to Vite instead of the real
        // backend. Returning that host here can route LiveKit signaling through
        // the wrong proxy target and break voice. In that case, keep the server
        // configured fallback URL.
        if is_frontend_dev_proxy_host(&host) {
            return fallback.to_string();
        }

        let ws_scheme = if matches!(forwarded_proto.as_deref(), Some("https") | Some("wss")) {
            "wss"
        } else {
            "ws"
        };
        return format!("{ws_scheme}://{host}/livekit");
    }

    fallback.to_string()
}

#[derive(Deserialize)]
pub struct StartStreamRequest {
    pub title: Option<String>,
    pub quality_preset: Option<String>,
}

#[derive(Deserialize)]
pub struct LiveKitWebhookPayload {
    pub event: String,
    pub room: Option<LiveKitRoom>,
    pub participant: Option<LiveKitParticipant>,
}

#[derive(Deserialize)]
pub struct LiveKitRoom {
    pub name: String,
}

#[derive(Deserialize)]
pub struct LiveKitParticipant {
    pub identity: String,
}

pub async fn join_voice(
    State(state): State<AppState>,
    auth: AuthUser,
    headers: HeaderMap,
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    if !state.config.livekit_available {
        return Err(ApiError::ServiceUnavailable(
            "Voice chat is not available — LiveKit server binary not found. Place livekit-server next to the Paracord server executable.".into(),
        ));
    }

    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if channel.channel_type != 2 {
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

    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    // If the user was tracked in any other voice room, remove that stale
    // in-memory membership before joining the new channel.
    if let Ok(existing_states) =
        paracord_db::voice_states::get_all_user_voice_states(&state.db, auth.user_id).await
    {
        for existing in existing_states {
            if existing.channel_id == channel_id {
                continue;
            }
            if let Some(current) = state
                .voice
                .leave_room(existing.channel_id, auth.user_id)
                .await
            {
                if current.is_empty() {
                    let _ = state.voice.cleanup_room(existing.channel_id).await;
                }
            }
        }
    }

    let session_id = uuid::Uuid::new_v4().to_string();

    let join_resp = state
        .voice
        .join_channel(
            channel_id,
            guild_id,
            auth.user_id,
            &user.username,
            &session_id,
            true, // can_speak
            paracord_media::AudioBitrate::default(),
        )
        .await
        .map_err(ApiError::Internal)?;

    let _ = paracord_db::voice_states::upsert_voice_state(
        &state.db,
        auth.user_id,
        channel.guild_id(),
        channel_id,
        &session_id,
    )
    .await;

    state.event_bus.dispatch(
        "VOICE_STATE_UPDATE",
        json!({
            "user_id": auth.user_id.to_string(),
            "channel_id": channel_id.to_string(),
            "guild_id": channel.guild_id().map(|id| id.to_string()),
            "session_id": &session_id,
            "self_mute": false,
            "self_deaf": false,
            "self_stream": false,
            "self_video": false,
            "suppress": false,
            "mute": false,
            "deaf": false,
            "username": &user.username,
            "avatar_hash": user.avatar_hash,
        }),
        channel.guild_id(),
    );

    let livekit_url = resolve_livekit_client_url(&headers, &state.config.livekit_public_url);
    tracing::info!(
        "Voice join: user={}, channel={}, livekit_url={}, host_header={:?}",
        auth.user_id,
        channel_id,
        livekit_url,
        headers.get("host").and_then(|v| v.to_str().ok()),
    );

    Ok(Json(json!({
        "token": join_resp.token,
        "url": livekit_url,
        "room_name": join_resp.room_name,
        "session_id": session_id,
    })))
}

pub async fn start_stream(
    State(state): State<AppState>,
    auth: AuthUser,
    headers: HeaderMap,
    Path(channel_id): Path<i64>,
    body: Option<Json<StartStreamRequest>>,
) -> Result<Json<Value>, ApiError> {
    if !state.config.livekit_available {
        return Err(ApiError::ServiceUnavailable(
            "Streaming is not available — LiveKit server binary not found.".into(),
        ));
    }

    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if channel.channel_type != 2 {
        return Err(ApiError::BadRequest("Not a voice channel".into()));
    }

    let guild_id = channel.guild_id().ok_or(ApiError::BadRequest(
        "Streaming is only supported in guild channels".into(),
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
    paracord_core::permissions::require_permission(perms, Permissions::STREAM)?;

    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let requested_quality = body
        .as_ref()
        .and_then(|b| b.quality_preset.clone())
        .unwrap_or_else(|| "1080p60".to_string());
    if paracord_media::ScreenCaptureConfig::from_preset(&requested_quality).is_none() {
        return Err(ApiError::BadRequest("Invalid quality_preset".into()));
    }
    let stream_title = body.as_ref().and_then(|b| b.title.as_deref());

    let stream_resp = state
        .voice
        .start_stream(
            channel_id,
            guild_id,
            auth.user_id,
            &user.username,
            stream_title,
        )
        .await
        .map_err(ApiError::Internal)?;

    // Persist stream state in DB and notify all guild members.
    let _ = paracord_db::voice_states::update_voice_state(
        &state.db,
        auth.user_id,
        Some(guild_id),
        false,
        false,
        true,
        false,
    )
    .await;

    state.event_bus.dispatch(
        "VOICE_STATE_UPDATE",
        json!({
            "user_id": auth.user_id.to_string(),
            "channel_id": channel_id.to_string(),
            "guild_id": Some(guild_id.to_string()),
            "self_mute": false,
            "self_deaf": false,
            "self_stream": true,
            "self_video": false,
            "suppress": false,
            "mute": false,
            "deaf": false,
            "username": &user.username,
            "avatar_hash": user.avatar_hash,
        }),
        Some(guild_id),
    );

    let livekit_url = resolve_livekit_client_url(&headers, &state.config.livekit_public_url);

    Ok(Json(json!({
        "token": stream_resp.token,
        "url": livekit_url,
        "room_name": stream_resp.room_name,
        "quality_preset": requested_quality,
    })))
}

pub async fn stop_stream(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if channel.channel_type != 2 {
        return Err(ApiError::BadRequest("Not a voice channel".into()));
    }

    let guild_id = channel.guild_id();

    // Clear stream state in the voice manager.
    state.voice.stop_stream(channel_id, auth.user_id).await;

    // Update DB voice state.
    if let Some(gid) = guild_id {
        let _ = paracord_db::voice_states::update_voice_state(
            &state.db,
            auth.user_id,
            Some(gid),
            false,
            false,
            false,
            false,
        )
        .await;
    }

    // Notify all guild members that the stream ended.
    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .ok()
        .flatten();
    state.event_bus.dispatch(
        "VOICE_STATE_UPDATE",
        json!({
            "user_id": auth.user_id.to_string(),
            "channel_id": channel_id.to_string(),
            "guild_id": guild_id.map(|id| id.to_string()),
            "self_mute": false,
            "self_deaf": false,
            "self_stream": false,
            "self_video": false,
            "suppress": false,
            "mute": false,
            "deaf": false,
            "username": user.as_ref().map(|u| u.username.as_str()),
            "avatar_hash": user.as_ref().and_then(|u| u.avatar_hash.as_deref()),
        }),
        guild_id,
    );

    Ok(StatusCode::NO_CONTENT)
}

pub async fn leave_voice(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if channel.channel_type != 2 {
        return Err(ApiError::BadRequest("Not a voice channel".into()));
    }

    let guild_id = channel.guild_id();
    let _ = paracord_db::voice_states::remove_voice_state(&state.db, auth.user_id, guild_id).await;
    let _participants = state.voice.leave_room(channel_id, auth.user_id).await;
    // Don't eagerly delete the LiveKit room when the last participant leaves.
    // Rapid leave→rejoin cycles cause a race between the delete_room API call
    // and the subsequent create_room, leading to "could not establish pc
    // connection" errors because LiveKit is still tearing down WebRTC resources
    // from the old room.  Instead, let LiveKit's empty_timeout (300s) handle
    // cleanup.  The active_livekit_rooms entry persists so the next join
    // reuses the existing room without needing to re-create it.

    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .ok()
        .flatten();
    state.event_bus.dispatch(
        "VOICE_STATE_UPDATE",
        json!({
            "user_id": auth.user_id.to_string(),
            "channel_id": null,
            "guild_id": guild_id.map(|id| id.to_string()),
            "self_mute": false,
            "self_deaf": false,
            "self_stream": false,
            "self_video": false,
            "suppress": false,
            "mute": false,
            "deaf": false,
            "username": user.as_ref().map(|u| u.username.as_str()),
            "avatar_hash": user.as_ref().and_then(|u| u.avatar_hash.as_deref()),
        }),
        guild_id,
    );
    Ok(StatusCode::NO_CONTENT)
}

/// Verify a LiveKit webhook JWT token.
///
/// LiveKit signs webhooks with an `Authorization: <jwt>` header. The JWT is
/// HS256-signed using the API secret, the `iss` claim must match the API key,
/// and the `sha256` claim must match the hex-encoded SHA-256 hash of the
/// request body.
fn verify_livekit_webhook(
    auth_header: &str,
    body: &[u8],
    api_key: &str,
    api_secret: &str,
) -> Result<(), ApiError> {
    use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};

    #[derive(Deserialize)]
    struct WebhookClaims {
        #[allow(dead_code)]
        iss: Option<String>,
        sha256: Option<String>,
    }

    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&[api_key]);
    validation.set_required_spec_claims(&["iss"]);

    let token_data = decode::<WebhookClaims>(
        auth_header,
        &DecodingKey::from_secret(api_secret.as_bytes()),
        &validation,
    )
    .map_err(|e| {
        tracing::warn!("LiveKit webhook JWT verification failed: {}", e);
        ApiError::Unauthorized
    })?;

    // Verify the body hash
    if let Some(expected_hash) = &token_data.claims.sha256 {
        let mut hasher = Sha256::new();
        hasher.update(body);
        let digest = hasher.finalize();
        let actual_hash = digest
            .iter()
            .fold(String::with_capacity(64), |mut s, b| {
                use std::fmt::Write;
                let _ = write!(s, "{:02x}", b);
                s
            });
        if actual_hash != *expected_hash {
            tracing::warn!(
                "LiveKit webhook body hash mismatch: expected={}, actual={}",
                expected_hash,
                actual_hash
            );
            return Err(ApiError::Unauthorized);
        }
    }

    Ok(())
}

pub async fn livekit_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    // Verify the webhook signature
    let auth_header = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;

    verify_livekit_webhook(
        auth_header,
        &body,
        &state.config.livekit_api_key,
        &state.config.livekit_api_secret,
    )?;

    let payload: LiveKitWebhookPayload =
        serde_json::from_slice(&body).map_err(|e| ApiError::BadRequest(e.to_string()))?;

    if payload.event != "participant_left" {
        return Ok(StatusCode::NO_CONTENT);
    }
    let room_name = if let Some(room) = payload.room {
        room.name
    } else {
        return Ok(StatusCode::NO_CONTENT);
    };
    let user_id = if let Some(participant) = payload.participant {
        participant.identity.parse::<i64>().ok()
    } else {
        None
    };
    let Some(user_id) = user_id else {
        return Ok(StatusCode::NO_CONTENT);
    };

    let parts: Vec<&str> = room_name.split('_').collect();
    if parts.len() < 4 {
        return Ok(StatusCode::NO_CONTENT);
    }
    let guild_id = parts[1].parse::<i64>().ok();
    let channel_id = parts[3].parse::<i64>().ok();
    let Some(channel_id) = channel_id else {
        return Ok(StatusCode::NO_CONTENT);
    };

    // Grace period: LiveKit fires participant_left during transient reconnects.
    // Wait 5 seconds before acting — if the participant has re-joined by then,
    // skip the removal so their icon stays in the sidebar.
    tracing::debug!(
        "LiveKit participant_left for user {} in channel {}, starting 5s grace period",
        user_id,
        channel_id
    );
    let state_clone = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;

        // Check if the participant actually reconnected to the LiveKit room.
        // Query LiveKit directly — this is the ground truth for connection status.
        if state_clone
            .voice
            .is_participant_in_livekit_room(channel_id, guild_id, user_id)
            .await
        {
            tracing::debug!(
                "LiveKit participant_left grace period expired: user {} still in LiveKit room for channel {}, skipping removal",
                user_id, channel_id
            );
            return;
        }

        tracing::info!(
            "LiveKit participant_left confirmed: removing user {} from channel {}",
            user_id,
            channel_id
        );

        let _ =
            paracord_db::voice_states::remove_voice_state(&state_clone.db, user_id, guild_id).await;
        let participants = state_clone.voice.leave_room(channel_id, user_id).await;
        if let Some(current) = participants {
            if current.is_empty() {
                let _ = state_clone.voice.cleanup_room(channel_id).await;
            }
        }

        let user = paracord_db::users::get_user_by_id(&state_clone.db, user_id)
            .await
            .ok()
            .flatten();
        state_clone.event_bus.dispatch(
            "VOICE_STATE_UPDATE",
            json!({
                "user_id": user_id.to_string(),
                "channel_id": null,
                "guild_id": guild_id.map(|id| id.to_string()),
                "self_mute": false,
                "self_deaf": false,
                "self_stream": false,
                "self_video": false,
                "suppress": false,
                "mute": false,
                "deaf": false,
                "username": user.as_ref().map(|u| u.username.as_str()),
                "avatar_hash": user.as_ref().and_then(|u| u.avatar_hash.as_deref()),
            }),
            guild_id,
        );
    });

    Ok(StatusCode::NO_CONTENT)
}
