use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;

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
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if channel.channel_type != 2 {
        return Err(ApiError::BadRequest("Not a voice channel".into()));
    }

    let guild_id = channel.guild_id.ok_or(ApiError::BadRequest(
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

    let session_id = uuid::Uuid::new_v4().to_string();

    let join_resp = state.voice.join_channel(
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
        channel.guild_id,
        channel_id,
        &session_id,
    )
    .await;

    state.event_bus.dispatch(
        "VOICE_STATE_UPDATE",
        json!({
            "user_id": auth.user_id.to_string(),
            "channel_id": channel_id.to_string(),
            "guild_id": channel.guild_id.map(|id| id.to_string()),
            "session_id": &session_id,
        }),
        channel.guild_id,
    );

    Ok(Json(json!({
        "token": join_resp.token,
        "url": state.config.livekit_public_url,
        "room_name": join_resp.room_name,
        "session_id": session_id,
    })))
}

pub async fn start_stream(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    body: Option<Json<StartStreamRequest>>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if channel.channel_type != 2 {
        return Err(ApiError::BadRequest("Not a voice channel".into()));
    }

    let guild_id = channel.guild_id.ok_or(ApiError::BadRequest(
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

    let stream_resp = state.voice.start_stream(
        channel_id,
        guild_id,
        auth.user_id,
        &user.username,
        stream_title,
    )
    .await
    .map_err(ApiError::Internal)?;

    Ok(Json(json!({
        "token": stream_resp.token,
        "url": state.config.livekit_public_url,
        "room_name": stream_resp.room_name,
        "quality_preset": requested_quality,
    })))
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

    let guild_id = channel.guild_id;
    let _ = paracord_db::voice_states::remove_voice_state(&state.db, auth.user_id, guild_id).await;
    let participants = state.voice.leave_room(channel_id, auth.user_id).await;
    if let Some(current) = participants {
        if current.is_empty() {
            let _ = state.voice.cleanup_room(channel_id).await;
        }
    }
    state.event_bus.dispatch(
        "VOICE_STATE_UPDATE",
        json!({
            "user_id": auth.user_id.to_string(),
            "channel_id": null,
            "guild_id": guild_id.map(|id| id.to_string()),
            "self_mute": false,
            "self_deaf": false,
        }),
        guild_id,
    );
    Ok(StatusCode::NO_CONTENT)
}

pub async fn livekit_webhook(
    State(state): State<AppState>,
    Json(payload): Json<LiveKitWebhookPayload>,
) -> Result<StatusCode, ApiError> {
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

    let _ = paracord_db::voice_states::remove_voice_state(&state.db, user_id, guild_id).await;
    let participants = state.voice.leave_room(channel_id, user_id).await;
    if let Some(current) = participants {
        if current.is_empty() {
            let _ = state.voice.cleanup_room(channel_id).await;
        }
    }
    state.event_bus.dispatch(
        "VOICE_STATE_UPDATE",
        json!({
            "user_id": user_id.to_string(),
            "channel_id": null,
            "guild_id": guild_id.map(|id| id.to_string()),
            "self_mute": false,
            "self_deaf": false,
        }),
        guild_id,
    );
    Ok(StatusCode::NO_CONTENT)
}
