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

fn stage_instance_to_json(s: &paracord_db::stage_instances::StageInstanceRow) -> Value {
    json!({
        "id": s.id.to_string(),
        "channel_id": s.channel_id.to_string(),
        "guild_id": s.guild_id.to_string(),
        "topic": s.topic,
        "privacy_level": s.privacy_level,
        "created_at": s.created_at.to_rfc3339(),
    })
}

async fn ensure_manage_channels(
    state: &AppState,
    guild_id: i64,
    user_id: i64,
) -> Result<(), ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, user_id).await?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let roles = paracord_db::roles::get_member_roles(&state.db, user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let perms =
        paracord_core::permissions::compute_permissions_from_roles(&roles, guild.owner_id, user_id);
    paracord_core::permissions::require_permission(perms, Permissions::MANAGE_CHANNELS)?;
    Ok(())
}

#[derive(Deserialize)]
pub struct CreateStageInstanceRequest {
    pub channel_id: String,
    pub topic: Option<String>,
    pub privacy_level: Option<i32>,
}

#[derive(Deserialize)]
pub struct UpdateStageInstanceRequest {
    pub topic: Option<String>,
    pub privacy_level: Option<i32>,
}

pub async fn get_stage_instance_for_channel(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if channel.channel_type != 13 {
        return Err(ApiError::BadRequest(
            "Channel is not a stage channel".into(),
        ));
    }

    let guild_id = channel.guild_id().ok_or(ApiError::BadRequest(
        "Stage channels must be in a guild".into(),
    ))?;

    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    let instance =
        paracord_db::stage_instances::get_stage_instance_by_channel(&state.db, channel_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::NotFound)?;

    Ok(Json(stage_instance_to_json(&instance)))
}

pub async fn create_stage_instance(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<CreateStageInstanceRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let channel_id: i64 = body
        .channel_id
        .parse()
        .map_err(|_| ApiError::BadRequest("invalid channel_id".into()))?;

    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    // channel_type 13 = Stage
    if channel.channel_type != 13 {
        return Err(ApiError::BadRequest(
            "Channel is not a stage channel".into(),
        ));
    }

    let guild_id = channel.guild_id().ok_or(ApiError::BadRequest(
        "Stage channels must be in a guild".into(),
    ))?;

    ensure_manage_channels(&state, guild_id, auth.user_id).await?;

    // Check if a stage instance already exists for this channel
    let existing =
        paracord_db::stage_instances::get_stage_instance_by_channel(&state.db, channel_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if existing.is_some() {
        return Err(ApiError::Conflict(
            "A stage instance already exists for this channel".into(),
        ));
    }

    let topic = body.topic.as_deref().unwrap_or("");
    let privacy_level = body.privacy_level.unwrap_or(2);
    if privacy_level != 1 && privacy_level != 2 {
        return Err(ApiError::BadRequest(
            "privacy_level must be 1 (PUBLIC) or 2 (GUILD_ONLY)".into(),
        ));
    }

    let id = paracord_util::snowflake::generate(1);
    let instance = paracord_db::stage_instances::create_stage_instance(
        &state.db,
        id,
        channel_id,
        guild_id,
        topic,
        privacy_level,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    state.event_bus.dispatch(
        "STAGE_INSTANCE_CREATE",
        stage_instance_to_json(&instance),
        Some(guild_id),
    );

    Ok((StatusCode::CREATED, Json(stage_instance_to_json(&instance))))
}

pub async fn update_stage_instance(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(stage_id): Path<i64>,
    Json(body): Json<UpdateStageInstanceRequest>,
) -> Result<Json<Value>, ApiError> {
    let instance = paracord_db::stage_instances::get_stage_instance(&state.db, stage_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    ensure_manage_channels(&state, instance.guild_id, auth.user_id).await?;

    if let Some(pl) = body.privacy_level {
        if pl != 1 && pl != 2 {
            return Err(ApiError::BadRequest(
                "privacy_level must be 1 (PUBLIC) or 2 (GUILD_ONLY)".into(),
            ));
        }
    }

    let updated = paracord_db::stage_instances::update_stage_instance(
        &state.db,
        stage_id,
        body.topic.as_deref(),
        body.privacy_level,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    state.event_bus.dispatch(
        "STAGE_INSTANCE_UPDATE",
        stage_instance_to_json(&updated),
        Some(instance.guild_id),
    );

    Ok(Json(stage_instance_to_json(&updated)))
}

pub async fn delete_stage_instance(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(stage_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let instance = paracord_db::stage_instances::get_stage_instance(&state.db, stage_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    ensure_manage_channels(&state, instance.guild_id, auth.user_id).await?;

    paracord_db::stage_instances::delete_stage_instance(&state.db, stage_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    state.event_bus.dispatch(
        "STAGE_INSTANCE_DELETE",
        json!({
            "id": instance.id.to_string(),
            "channel_id": instance.channel_id.to_string(),
            "guild_id": instance.guild_id.to_string(),
        }),
        Some(instance.guild_id),
    );

    Ok(StatusCode::NO_CONTENT)
}

pub async fn invite_speaker(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((stage_id, user_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    let instance = paracord_db::stage_instances::get_stage_instance(&state.db, stage_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    ensure_manage_channels(&state, instance.guild_id, auth.user_id).await?;

    // Set suppress=false for the target user (promote to speaker)
    paracord_db::voice_states::update_suppress(&state.db, user_id, Some(instance.guild_id), false)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let user = paracord_db::users::get_user_by_id(&state.db, user_id)
        .await
        .ok()
        .flatten();

    state.event_bus.dispatch(
        "VOICE_STATE_UPDATE",
        json!({
            "user_id": user_id.to_string(),
            "channel_id": instance.channel_id.to_string(),
            "guild_id": instance.guild_id.to_string(),
            "suppress": false,
            "username": user.as_ref().map(|u| u.username.as_str()),
            "avatar_hash": user.as_ref().and_then(|u| u.avatar_hash.as_deref()),
        }),
        Some(instance.guild_id),
    );

    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove_speaker(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((stage_id, user_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    let instance = paracord_db::stage_instances::get_stage_instance(&state.db, stage_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    ensure_manage_channels(&state, instance.guild_id, auth.user_id).await?;

    // Set suppress=true for the target user (move back to audience)
    paracord_db::voice_states::update_suppress(&state.db, user_id, Some(instance.guild_id), true)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let user = paracord_db::users::get_user_by_id(&state.db, user_id)
        .await
        .ok()
        .flatten();

    state.event_bus.dispatch(
        "VOICE_STATE_UPDATE",
        json!({
            "user_id": user_id.to_string(),
            "channel_id": instance.channel_id.to_string(),
            "guild_id": instance.guild_id.to_string(),
            "suppress": true,
            "username": user.as_ref().map(|u| u.username.as_str()),
            "avatar_hash": user.as_ref().and_then(|u| u.avatar_hash.as_deref()),
        }),
        Some(instance.guild_id),
    );

    Ok(StatusCode::NO_CONTENT)
}
