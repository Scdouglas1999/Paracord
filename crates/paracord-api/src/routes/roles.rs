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
use crate::routes::mod_log;

fn validate_role_permission_assignment(
    guild_owner_id: i64,
    actor_user_id: i64,
    actor_perms: paracord_models::permissions::Permissions,
    requested_bits: i64,
) -> Result<(), ApiError> {
    let requested = paracord_models::permissions::Permissions::from_bits(requested_bits)
        .ok_or(ApiError::BadRequest("Invalid permissions bitset".into()))?;

    if actor_user_id != guild_owner_id {
        if requested.contains(paracord_models::permissions::Permissions::ADMINISTRATOR) {
            return Err(ApiError::Forbidden);
        }
        let disallowed = requested.bits() & !actor_perms.bits();
        if disallowed != 0 {
            return Err(ApiError::Forbidden);
        }
    }
    Ok(())
}

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

    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
    let user_roles = paracord_db::roles::get_member_roles(&state.db, auth.user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let perms = paracord_core::permissions::compute_permissions_from_roles(
        &user_roles,
        guild.owner_id,
        auth.user_id,
    );
    paracord_core::permissions::require_permission(
        perms,
        paracord_models::permissions::Permissions::MANAGE_ROLES,
    )?;
    validate_role_permission_assignment(guild.owner_id, auth.user_id, perms, body.permissions)?;

    let role_id = paracord_util::snowflake::generate(1);
    // create_role assigns the next position (MAX(position)+1 for the guild). A
    // non-owner manager must not create a role at or above their own top role,
    // so cap the new role below their highest position. If that would collide
    // with an existing role's position it is still strictly below the actor's
    // top role, preserving the hierarchy invariant enforced on edits/deletes.
    let created =
        paracord_db::roles::create_role(&state.db, role_id, guild_id, &body.name, body.permissions)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if auth.user_id != guild.owner_id {
        let actor_top_role_pos = user_roles.iter().map(|r| r.position).max().unwrap_or(0);
        if created.position >= actor_top_role_pos {
            paracord_db::roles::set_role_position(
                &state.db,
                role_id,
                (actor_top_role_pos - 1).max(0),
            )
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        }
    }
    let role = paracord_db::roles::update_role(
        &state.db,
        role_id,
        None,
        Some(body.color),
        Some(body.hoist),
        None,
        Some(body.mentionable),
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

    mod_log::emit_mod_log(
        &state,
        guild_id,
        "Role Created",
        "A new role was created.",
        &[
            ("Actor", auth.user_id.to_string()),
            ("Role", role.name.clone()),
            ("Role ID", role.id.to_string()),
        ],
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

    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
    let user_roles = paracord_db::roles::get_member_roles(&state.db, auth.user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let perms = paracord_core::permissions::compute_permissions_from_roles(
        &user_roles,
        guild.owner_id,
        auth.user_id,
    );
    paracord_core::permissions::require_permission(
        perms,
        paracord_models::permissions::Permissions::MANAGE_ROLES,
    )?;
    if let Some(requested_permissions) = body.permissions {
        validate_role_permission_assignment(
            guild.owner_id,
            auth.user_id,
            perms,
            requested_permissions,
        )?;
    }

    let target_role = paracord_db::roles::get_role(&state.db, role_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if target_role.guild_id() != guild_id {
        return Err(ApiError::NotFound);
    }
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

    // Invalidate permission cache when role permissions change
    paracord_core::permissions::invalidate_guild_members(
        &state.permission_cache,
        &state.member_index,
        guild_id,
    )
    .await;

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

    mod_log::emit_mod_log(
        &state,
        guild_id,
        "Role Updated",
        "A role was updated.",
        &[
            ("Actor", auth.user_id.to_string()),
            ("Role", updated.name.clone()),
            ("Role ID", updated.id.to_string()),
        ],
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
            "Cannot delete the default Member role".into(),
        ));
    }

    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
    let user_roles = paracord_db::roles::get_member_roles(&state.db, auth.user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let perms = paracord_core::permissions::compute_permissions_from_roles(
        &user_roles,
        guild.owner_id,
        auth.user_id,
    );
    paracord_core::permissions::require_permission(
        perms,
        paracord_models::permissions::Permissions::MANAGE_ROLES,
    )?;

    let target_role = paracord_db::roles::get_role(&state.db, role_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if target_role.guild_id() != guild_id {
        return Err(ApiError::NotFound);
    }
    if auth.user_id != guild.owner_id {
        let actor_top_role_pos = user_roles.iter().map(|r| r.position).max().unwrap_or(0);
        if target_role.position >= actor_top_role_pos {
            return Err(ApiError::Forbidden);
        }
    }

    paracord_db::roles::delete_role(&state.db, role_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // Invalidate permission cache when a role is deleted
    paracord_core::permissions::invalidate_guild_members(
        &state.permission_cache,
        &state.member_index,
        guild_id,
    )
    .await;

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

    mod_log::emit_mod_log(
        &state,
        guild_id,
        "Role Deleted",
        "A role was removed.",
        &[
            ("Actor", auth.user_id.to_string()),
            ("Role", target_role.name),
            ("Role ID", role_id.to_string()),
        ],
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}
