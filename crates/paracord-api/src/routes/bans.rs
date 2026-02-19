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

pub async fn list_bans(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    // Verify user has BAN_MEMBERS permission
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let roles = paracord_db::roles::get_member_roles(&state.db, auth.user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let perms = paracord_core::permissions::compute_permissions_from_roles(
        &roles,
        guild.owner_id,
        auth.user_id,
    );
    paracord_core::permissions::require_permission(
        perms,
        paracord_models::permissions::Permissions::BAN_MEMBERS,
    )?;

    let bans = paracord_db::bans::get_guild_bans(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let result: Vec<Value> = bans
        .iter()
        .map(|b| {
            json!({
                "user_id": b.user_id.to_string(),
                "guild_id": guild_id.to_string(),
                "reason": b.reason,
                "banned_by": b.banned_by.map(|id| id.to_string()),
                "created_at": b.created_at.to_rfc3339(),
            })
        })
        .collect();

    Ok(Json(json!(result)))
}

#[derive(Deserialize)]
pub struct BanRequest {
    pub reason: Option<String>,
}

pub async fn ban_member(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, user_id)): Path<(i64, i64)>,
    body: Option<Json<BanRequest>>,
) -> Result<StatusCode, ApiError> {
    let reason = body.and_then(|b| b.0.reason);
    paracord_core::admin::ban_member(&state.db, guild_id, auth.user_id, user_id, reason.as_deref())
        .await?;
    state.member_index.remove(user_id).await;

    state.event_bus.dispatch(
        "GUILD_BAN_ADD",
        json!({
            "guild_id": guild_id.to_string(),
            "user_id": user_id.to_string(),
        }),
        Some(guild_id),
    );

    state.event_bus.dispatch(
        "GUILD_MEMBER_REMOVE",
        json!({
            "guild_id": guild_id.to_string(),
            "user_id": user_id.to_string(),
        }),
        Some(guild_id),
    );
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_MEMBER_BAN_ADD,
        Some(user_id),
        reason.as_deref(),
        None,
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn unban_member(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, user_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    paracord_core::admin::unban_member(&state.db, guild_id, auth.user_id, user_id).await?;

    state.event_bus.dispatch(
        "GUILD_BAN_REMOVE",
        json!({
            "guild_id": guild_id.to_string(),
            "user_id": user_id.to_string(),
        }),
        Some(guild_id),
    );
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_MEMBER_BAN_REMOVE,
        Some(user_id),
        None,
        None,
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}
