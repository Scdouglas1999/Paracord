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
use crate::routes::audit;

fn role_to_json(r: &paracord_db::roles::RoleRow) -> Value {
    json!({
        "id": r.id.to_string(),
        "guild_id": r.guild_id().to_string(),
        "name": r.name,
        "color": r.color,
        "hoist": r.hoist,
        "position": r.position,
        "permissions": r.permissions,
        "managed": r.managed,
        "mentionable": r.mentionable,
        "created_at": r.created_at.to_rfc3339(),
    })
}

pub async fn list_roles(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    let roles = paracord_db::roles::get_guild_roles(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let result: Vec<Value> = roles.iter().map(role_to_json).collect();
    Ok(Json(json!(result)))
}

#[derive(Deserialize)]
pub struct CreateRoleRequest {
    pub name: String,
    #[serde(default)]
    pub permissions: i64,
    #[serde(default)]
    pub color: i32,
    #[serde(default)]
    pub hoist: bool,
    #[serde(default)]
    pub mentionable: bool,
}

pub async fn create_role(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<CreateRoleRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let user_roles = paracord_db::roles::get_member_roles(&state.db, auth.user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let perms = paracord_core::permissions::compute_permissions_from_roles(
        &user_roles,
        guild.owner_id,
        auth.user_id,
    );
    paracord_core::permissions::require_permission(perms, Permissions::MANAGE_ROLES)?;

    let role_id = paracord_util::snowflake::generate(1);
    let role = paracord_db::roles::create_role(
        &state.db,
        role_id,
        guild_id,
        &body.name,
        body.permissions,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let role_json = role_to_json(&role);

    state.event_bus.dispatch(
        "GUILD_ROLE_CREATE",
        json!({"guild_id": guild_id.to_string(), "role": &role_json}),
        Some(guild_id),
    );
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_ROLE_CREATE,
        Some(role_id),
        None,
        Some(json!({ "name": body.name })),
    )
    .await;

    Ok((StatusCode::CREATED, Json(role_json)))
}

#[derive(Deserialize)]
pub struct UpdateRoleRequest {
    pub name: Option<String>,
    pub permissions: Option<i64>,
    pub color: Option<i32>,
    pub hoist: Option<bool>,
    pub mentionable: Option<bool>,
}

pub async fn update_role(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, role_id)): Path<(i64, i64)>,
    Json(body): Json<UpdateRoleRequest>,
) -> Result<Json<Value>, ApiError> {
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let user_roles = paracord_db::roles::get_member_roles(&state.db, auth.user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let perms = paracord_core::permissions::compute_permissions_from_roles(
        &user_roles,
        guild.owner_id,
        auth.user_id,
    );
    paracord_core::permissions::require_permission(perms, Permissions::MANAGE_ROLES)?;

    let target_role = paracord_db::roles::get_role(&state.db, role_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if auth.user_id != guild.owner_id {
        let actor_top_role_pos = user_roles.iter().map(|r| r.position).max().unwrap_or(0);
        if target_role.position >= actor_top_role_pos {
            return Err(ApiError::Forbidden);
        }
    }

    let updated = paracord_db::roles::update_role(
        &state.db,
        role_id,
        body.name.as_deref(),
        body.color,
        body.hoist,
        body.permissions,
        body.mentionable,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let role_json = role_to_json(&updated);

    state.event_bus.dispatch(
        "GUILD_ROLE_UPDATE",
        json!({"guild_id": guild_id.to_string(), "role": &role_json}),
        Some(guild_id),
    );
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_ROLE_UPDATE,
        Some(role_id),
        None,
        Some(json!({
            "name": updated.name,
            "permissions": updated.permissions,
        })),
    )
    .await;

    Ok(Json(role_json))
}

pub async fn delete_role(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, role_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if role_id == guild_id {
        return Err(ApiError::BadRequest(
            "Cannot delete the @everyone role".into(),
        ));
    }

    let user_roles = paracord_db::roles::get_member_roles(&state.db, auth.user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let perms = paracord_core::permissions::compute_permissions_from_roles(
        &user_roles,
        guild.owner_id,
        auth.user_id,
    );
    paracord_core::permissions::require_permission(perms, Permissions::MANAGE_ROLES)?;

    let target_role = paracord_db::roles::get_role(&state.db, role_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if auth.user_id != guild.owner_id {
        let actor_top_role_pos = user_roles.iter().map(|r| r.position).max().unwrap_or(0);
        if target_role.position >= actor_top_role_pos {
            return Err(ApiError::Forbidden);
        }
    }

    paracord_db::roles::delete_role(&state.db, role_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    state.event_bus.dispatch(
        "GUILD_ROLE_DELETE",
        json!({
            "guild_id": guild_id.to_string(),
            "role_id": role_id.to_string(),
        }),
        Some(guild_id),
    );
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_ROLE_DELETE,
        Some(role_id),
        None,
        None,
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}
