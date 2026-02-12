use axum::{
    extract::{Path, Query, State},
    Json,
};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;

#[derive(Deserialize)]
pub struct AuditLogQuery {
    pub user_id: Option<i64>,
    pub action_type: Option<i16>,
    pub before: Option<i64>,
    pub limit: Option<i64>,
}

pub async fn get_audit_logs(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Query(params): Query<AuditLogQuery>,
) -> Result<Json<Value>, ApiError> {
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
    paracord_core::permissions::require_permission(perms, Permissions::VIEW_AUDIT_LOG)?;

    let limit = params.limit.unwrap_or(50).min(100);

    let entries = paracord_db::audit_log::get_guild_entries(
        &state.db,
        guild_id,
        params.action_type,
        params.user_id,
        params.before,
        limit,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let audit_log_entries: Vec<Value> = entries
        .iter()
        .map(|e| {
            json!({
                "id": e.id.to_string(),
                "guild_id": e.guild_id().to_string(),
                "user_id": e.user_id.to_string(),
                "action_type": e.action_type,
                "target_id": e.target_id.map(|id| id.to_string()),
                "reason": e.reason,
                "changes": e.changes,
                "created_at": e.created_at.to_rfc3339(),
            })
        })
        .collect();

    Ok(Json(json!({
        "audit_log_entries": audit_log_entries,
    })))
}
