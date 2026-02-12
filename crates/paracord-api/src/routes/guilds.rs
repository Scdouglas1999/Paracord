use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use paracord_core::AppState;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;
use crate::routes::audit;

#[derive(Deserialize)]
pub struct CreateGuildRequest {
    pub name: String,
    pub icon: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateGuildRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
}

#[derive(Deserialize)]
pub struct TransferOwnershipRequest {
    pub new_owner_id: String,
}

pub async fn create_guild(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<CreateGuildRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if body.name.len() < 2 || body.name.len() > 100 {
        return Err(ApiError::BadRequest(
            "Guild name must be between 2 and 100 characters".into(),
        ));
    }

    let guild_id = paracord_util::snowflake::generate(1);

    let guild = paracord_core::guild::create_guild_full(
        &state.db,
        guild_id,
        &body.name,
        auth.user_id,
        body.icon.as_deref(),
    )
    .await?;

    let guild_json = json!({
        "id": guild.id.to_string(),
        "name": guild.name,
        "description": guild.description,
        "icon_hash": guild.icon_hash,
        "owner_id": guild.owner_id.to_string(),
        "member_count": 1,
        "created_at": guild.created_at.to_rfc3339(),
    });

    state
        .event_bus
        .dispatch("GUILD_CREATE", guild_json.clone(), Some(guild_id));

    Ok((StatusCode::CREATED, Json(guild_json)))
}

pub async fn list_guilds(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let guilds = paracord_db::guilds::get_user_guilds(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let result: Vec<Value> = guilds
        .iter()
        .map(|g| {
            json!({
                "id": g.id.to_string(),
                "name": g.name,
                "description": g.description,
                "icon_hash": g.icon_hash,
                "owner_id": g.owner_id.to_string(),
                "created_at": g.created_at.to_rfc3339(),
            })
        })
        .collect();

    Ok(Json(json!(result)))
}

pub async fn get_guild(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let member_count = paracord_db::members::get_member_count(&state.db, guild_id)
        .await
        .unwrap_or(0);

    Ok(Json(json!({
        "id": guild.id.to_string(),
        "name": guild.name,
        "description": guild.description,
        "icon_hash": guild.icon_hash,
        "owner_id": guild.owner_id.to_string(),
        "member_count": member_count,
        "created_at": guild.created_at.to_rfc3339(),
    })))
}

pub async fn update_guild(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<UpdateGuildRequest>,
) -> Result<Json<Value>, ApiError> {
    let updated = paracord_core::guild::update_guild(
        &state.db,
        guild_id,
        auth.user_id,
        body.name.as_deref(),
        body.description.as_deref(),
        body.icon.as_deref(),
    )
    .await?;

    let guild_json = json!({
        "id": updated.id.to_string(),
        "name": updated.name,
        "description": updated.description,
        "icon_hash": updated.icon_hash,
        "owner_id": updated.owner_id.to_string(),
        "created_at": updated.created_at.to_rfc3339(),
    });

    state
        .event_bus
        .dispatch("GUILD_UPDATE", guild_json.clone(), Some(guild_id));
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_GUILD_UPDATE,
        Some(guild_id),
        None,
        Some(json!({
            "name": updated.name,
            "description": updated.description,
        })),
    )
    .await;

    Ok(Json(guild_json))
}

pub async fn delete_guild(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    paracord_core::guild::delete_guild(&state.db, guild_id, auth.user_id).await?;

    state.event_bus.dispatch(
        "GUILD_DELETE",
        json!({"id": guild_id.to_string()}),
        Some(guild_id),
    );
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_GUILD_UPDATE,
        Some(guild_id),
        Some("guild deleted"),
        None,
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn transfer_ownership(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<TransferOwnershipRequest>,
) -> Result<Json<Value>, ApiError> {
    let new_owner_id = body
        .new_owner_id
        .parse::<i64>()
        .map_err(|_| ApiError::BadRequest("Invalid new_owner_id".into()))?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if guild.owner_id != auth.user_id {
        return Err(ApiError::Forbidden);
    }
    let is_member = paracord_db::members::get_member(&state.db, new_owner_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .is_some();
    if !is_member {
        return Err(ApiError::BadRequest(
            "New owner must be a guild member".into(),
        ));
    }
    let updated = paracord_db::guilds::transfer_ownership(&state.db, guild_id, new_owner_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let payload = json!({
        "id": updated.id.to_string(),
        "owner_id": updated.owner_id.to_string(),
    });
    state
        .event_bus
        .dispatch("GUILD_UPDATE", payload.clone(), Some(guild_id));
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_GUILD_UPDATE,
        Some(new_owner_id),
        Some("ownership transferred"),
        Some(json!({ "new_owner_id": new_owner_id.to_string() })),
    )
    .await;
    Ok(Json(payload))
}

pub async fn get_channels(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    let channels = paracord_db::channels::get_guild_channels(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let result: Vec<Value> = channels
        .iter()
        .map(|c| {
            json!({
                "id": c.id.to_string(),
                "guild_id": c.guild_id().map(|id| id.to_string()),
                "name": c.name,
                "topic": c.topic,
                "type": c.channel_type,
                "channel_type": c.channel_type,
                "position": c.position,
                "parent_id": c.parent_id.map(|id| id.to_string()),
                "nsfw": c.nsfw,
                "rate_limit_per_user": c.rate_limit_per_user,
                "last_message_id": c.last_message_id.map(|id| id.to_string()),
            })
        })
        .collect();

    Ok(Json(json!(result)))
}
