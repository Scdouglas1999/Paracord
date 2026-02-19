use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use paracord_core::AppState;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;

#[derive(Deserialize)]
pub struct VoiceStateUpdateRequest {
    pub guild_id: Option<String>,
    pub channel_id: Option<String>,
    pub self_mute: Option<bool>,
    pub self_deaf: Option<bool>,
}

#[derive(Deserialize)]
pub struct VoiceRecoverRequest {
    pub channel_id: i64,
}

pub async fn join_voice_v2(
    state: State<AppState>,
    auth: AuthUser,
    headers: HeaderMap,
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    super::voice::join_voice(state, auth, headers, Path(channel_id)).await
}

pub async fn leave_voice_v2(
    state: State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<axum::http::StatusCode, ApiError> {
    super::voice::leave_voice(state, auth, Path(channel_id)).await
}

pub async fn recover_voice_v2(
    state: State<AppState>,
    auth: AuthUser,
    headers: HeaderMap,
    Json(req): Json<VoiceRecoverRequest>,
) -> Result<Json<Value>, ApiError> {
    super::voice::join_voice(state, auth, headers, Path(req.channel_id)).await
}

pub async fn update_voice_state_v2(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<VoiceStateUpdateRequest>,
) -> Result<Json<Value>, ApiError> {
    let body = super::realtime::RealtimeCommandRequest {
        command_id: format!("voice_state_{}", chrono::Utc::now().timestamp_millis()),
        command_type: "voice_state_update".to_string(),
        payload: json!({
            "guild_id": req.guild_id,
            "channel_id": req.channel_id,
            "self_mute": req.self_mute.unwrap_or(false),
            "self_deaf": req.self_deaf.unwrap_or(false),
        }),
    };
    super::realtime::post_command(State(state), auth, Json(body)).await
}
