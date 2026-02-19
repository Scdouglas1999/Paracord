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

pub async fn list_members(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    let members = paracord_db::members::get_guild_members(&state.db, guild_id, 1000, None)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let mut result: Vec<Value> = Vec::with_capacity(members.len());
    for m in members {
        let roles = paracord_db::roles::get_member_roles(&state.db, m.user_id, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        let role_ids: Vec<String> = roles.iter().map(|r| r.id.to_string()).collect();
        result.push(json!({
            "user_id": m.user_id.to_string(),
            "guild_id": guild_id.to_string(),
            "nick": m.nick,
            "joined_at": m.joined_at.to_rfc3339(),
            "deaf": m.deaf,
            "mute": m.mute,
            "communication_disabled_until": m.communication_disabled_until.map(|v| v.to_rfc3339()),
            "roles": role_ids,
            "user": {
                "id": m.user_id.to_string(),
                "username": m.username,
                "discriminator": m.discriminator,
                "avatar_hash": m.user_avatar_hash,
            }
        }));
    }

    Ok(Json(json!(result)))
}

#[derive(Deserialize)]
pub struct UpdateMemberRequest {
    pub nick: Option<String>,
    pub roles: Option<Vec<String>>,
    pub communication_disabled_until: Option<String>,
}

pub async fn update_member(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, user_id)): Path<(i64, i64)>,
    Json(body): Json<UpdateMemberRequest>,
) -> Result<Json<Value>, ApiError> {
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let actor_roles = paracord_db::roles::get_member_roles(&state.db, auth.user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let actor_perms = paracord_core::permissions::compute_permissions_from_roles(
        &actor_roles,
        guild.owner_id,
        auth.user_id,
    );

    if body.nick.is_some() && auth.user_id != user_id {
        paracord_core::permissions::require_permission(
            actor_perms,
            paracord_models::permissions::Permissions::MANAGE_NICKNAMES,
        )?;
    }

    let updated = paracord_db::members::update_member(
        &state.db,
        user_id,
        guild_id,
        body.nick.as_deref(),
        None,
        None,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let mut role_ids: Vec<String> = paracord_db::roles::get_member_roles(&state.db, user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .iter()
        .map(|role| role.id.to_string())
        .collect();

    if let Some(raw_roles) = body.roles {
        if !paracord_core::permissions::is_server_admin(actor_perms) {
            return Err(ApiError::Forbidden("forbidden".into()));
        }

        let guild_roles = paracord_db::roles::get_guild_roles(&state.db, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        let role_by_id: std::collections::HashMap<i64, paracord_db::roles::RoleRow> = guild_roles
            .iter()
            .cloned()
            .map(|role| (role.id, role))
            .collect();
        let requested_role_ids: Vec<i64> = raw_roles
            .iter()
            .map(|r| {
                r.parse::<i64>()
                    .map_err(|_| ApiError::BadRequest("Invalid role id".into()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if requested_role_ids
            .iter()
            .any(|role_id| !role_by_id.contains_key(role_id))
        {
            return Err(ApiError::BadRequest(
                "One or more roles do not belong to this guild".into(),
            ));
        }

        let existing_roles = paracord_db::roles::get_member_roles(&state.db, user_id, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

        let mut requested_ids: std::collections::HashSet<i64> =
            requested_role_ids.iter().copied().collect();
        requested_ids.insert(guild_id); // Member role is always required
        let existing_ids: std::collections::HashSet<i64> =
            existing_roles.iter().map(|r| r.id).collect();

        if auth.user_id != guild.owner_id {
            let actor_top_role_pos = actor_roles.iter().map(|r| r.position).max().unwrap_or(0);
            for role_id in &requested_ids {
                if *role_id == guild_id {
                    continue;
                }
                let Some(role) = role_by_id.get(role_id) else {
                    continue;
                };
                if role.position >= actor_top_role_pos {
                    return Err(ApiError::Forbidden("forbidden".into()));
                }
            }
        }

        for role_id in requested_ids.difference(&existing_ids) {
            paracord_db::roles::add_member_role(&state.db, user_id, guild_id, *role_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        }
        for role_id in existing_ids.difference(&requested_ids) {
            if *role_id != guild_id {
                paracord_db::roles::remove_member_role(&state.db, user_id, guild_id, *role_id)
                    .await
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            }
        }

        role_ids = paracord_db::roles::get_member_roles(&state.db, user_id, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .iter()
            .map(|role| role.id.to_string())
            .collect();
    }

    let mut timed_out_until = updated.communication_disabled_until;
    if let Some(raw_until) = body.communication_disabled_until {
        let parsed = if raw_until.trim().is_empty() {
            None
        } else {
            Some(
                chrono::DateTime::parse_from_rfc3339(&raw_until)
                    .map_err(|_| ApiError::BadRequest("Invalid communication_disabled_until".into()))?
                    .with_timezone(&chrono::Utc),
            )
        };
        let member = paracord_db::members::set_member_timeout(&state.db, user_id, guild_id, parsed)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        timed_out_until = member.communication_disabled_until;
    }

    let member_json = json!({
        "guild_id": guild_id.to_string(),
        "user_id": updated.user_id.to_string(),
        "nick": updated.nick,
        "deaf": updated.deaf,
        "mute": updated.mute,
        "communication_disabled_until": timed_out_until.map(|v| v.to_rfc3339()),
        "joined_at": updated.joined_at.to_rfc3339(),
        "roles": role_ids.clone(),
    });

    state.event_bus.dispatch(
        "GUILD_MEMBER_UPDATE",
        json!({
            "guild_id": guild_id.to_string(),
            "user_id": user_id.to_string(),
            "nick": updated.nick,
            "communication_disabled_until": timed_out_until.map(|v| v.to_rfc3339()),
            "roles": role_ids.clone(),
        }),
        Some(guild_id),
    );
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_MEMBER_UPDATE,
        Some(user_id),
        None,
        Some(json!({
            "nick": updated.nick,
            "communication_disabled_until": timed_out_until.map(|v| v.to_rfc3339()),
            "roles": role_ids,
        })),
    )
    .await;

    Ok(Json(member_json))
}

pub async fn kick_member(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, user_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    paracord_core::admin::kick_member(&state.db, guild_id, auth.user_id, user_id).await?;
    state.member_index.remove(user_id).await;

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
        audit::ACTION_MEMBER_KICK,
        Some(user_id),
        None,
        None,
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn leave_guild(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    // Check that user is not the owner
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if guild.owner_id == auth.user_id {
        return Err(ApiError::BadRequest(
            "Cannot leave a guild you own. Transfer ownership or delete the guild.".into(),
        ));
    }

    paracord_db::members::remove_member(&state.db, auth.user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    state.member_index.remove(auth.user_id).await;

    state.event_bus.dispatch(
        "GUILD_MEMBER_REMOVE",
        json!({
            "guild_id": guild_id.to_string(),
            "user_id": auth.user_id.to_string(),
        }),
        Some(guild_id),
    );

    Ok(StatusCode::NO_CONTENT)
}
