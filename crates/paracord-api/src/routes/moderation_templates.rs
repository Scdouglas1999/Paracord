use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::{Duration, Utc};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;
use crate::routes::{audit, mod_log};

const ACTION_WARN: i16 = 1;
const ACTION_TIMED_MUTE: i16 = 2;
const ACTION_KICK: i16 = 3;
const ACTION_BAN: i16 = 4;

fn template_to_json(row: &paracord_db::moderation_templates::ModerationTemplateRow) -> Value {
    json!({
        "id": row.id.to_string(),
        "guild_id": row.guild_id.to_string(),
        "name": row.name,
        "action_type": row.action_type,
        "duration_minutes": row.duration_minutes,
        "reason_template": row.reason_template,
        "dm_template": row.dm_template,
        "created_by": row.created_by.to_string(),
        "created_at": row.created_at.to_rfc3339(),
        "updated_at": row.updated_at.to_rfc3339(),
    })
}

fn render_template(template: Option<&str>, target: &str, moderator: &str, reason: &str) -> String {
    template
        .unwrap_or(reason)
        .replace("{target}", target)
        .replace("{moderator}", moderator)
        .replace("{reason}", reason)
}

async fn ensure_manage_guild(
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
    paracord_core::permissions::require_permission(perms, Permissions::MANAGE_GUILD)?;
    Ok(())
}

#[derive(Deserialize)]
pub struct CreateModerationTemplateRequest {
    pub name: String,
    pub action_type: i16,
    pub duration_minutes: Option<i32>,
    pub reason_template: Option<String>,
    pub dm_template: Option<String>,
}

pub async fn create_template(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<CreateModerationTemplateRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    ensure_manage_guild(&state, guild_id, auth.user_id).await?;
    let name = body.name.trim();
    if name.is_empty() || name.len() > 100 {
        return Err(ApiError::BadRequest(
            "name must be between 1 and 100 characters".into(),
        ));
    }
    if !matches!(
        body.action_type,
        ACTION_WARN | ACTION_TIMED_MUTE | ACTION_KICK | ACTION_BAN
    ) {
        return Err(ApiError::BadRequest("invalid action_type".into()));
    }
    if body.action_type == ACTION_TIMED_MUTE {
        let minutes = body.duration_minutes.unwrap_or(10);
        if !(1..=43_200).contains(&minutes) {
            return Err(ApiError::BadRequest(
                "duration_minutes must be between 1 and 43200".into(),
            ));
        }
    }

    let template = paracord_db::moderation_templates::create_template(
        &state.db,
        paracord_util::snowflake::generate(1),
        guild_id,
        name,
        body.action_type,
        body.duration_minutes,
        body.reason_template.as_deref(),
        body.dm_template.as_deref(),
        auth.user_id,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok((StatusCode::CREATED, Json(template_to_json(&template))))
}

pub async fn list_templates(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    ensure_manage_guild(&state, guild_id, auth.user_id).await?;
    let rows = paracord_db::moderation_templates::list_templates(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!(rows
        .iter()
        .map(template_to_json)
        .collect::<Vec<_>>())))
}

pub async fn delete_template(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, template_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    ensure_manage_guild(&state, guild_id, auth.user_id).await?;
    let template = paracord_db::moderation_templates::get_template(&state.db, template_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if template.guild_id != guild_id {
        return Err(ApiError::NotFound);
    }
    paracord_db::moderation_templates::delete_template(&state.db, template_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ApplyModerationTemplateRequest {
    pub target_user_id: String,
    pub reason: Option<String>,
    pub dm_message: Option<String>,
}

pub async fn apply_template(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, template_id)): Path<(i64, i64)>,
    Json(body): Json<ApplyModerationTemplateRequest>,
) -> Result<Json<Value>, ApiError> {
    ensure_manage_guild(&state, guild_id, auth.user_id).await?;

    let target_user_id = body
        .target_user_id
        .parse::<i64>()
        .map_err(|_| ApiError::BadRequest("Invalid target_user_id".into()))?;
    let template = paracord_db::moderation_templates::get_template(&state.db, template_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if template.guild_id != guild_id {
        return Err(ApiError::NotFound);
    }

    let target_user = paracord_db::users::get_user_by_id(&state.db, target_user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let actor_user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let default_reason = template
        .reason_template
        .as_deref()
        .unwrap_or("Moderation action applied");
    let reason = body.reason.as_deref().unwrap_or(default_reason);
    let rendered_reason = render_template(
        Some(reason),
        &target_user.username,
        &actor_user.username,
        reason,
    );
    let rendered_dm = body
        .dm_message
        .as_deref()
        .map(str::to_string)
        .unwrap_or_else(|| {
            render_template(
                template.dm_template.as_deref(),
                &target_user.username,
                &actor_user.username,
                &rendered_reason,
            )
        });

    let mut action_result = json!({
        "action_type": template.action_type,
        "template_id": template.id.to_string(),
        "target_user_id": target_user_id.to_string(),
        "reason": rendered_reason,
    });

    match template.action_type {
        ACTION_WARN => {
            action_result["status"] = json!("warned");
        }
        ACTION_TIMED_MUTE => {
            let duration_minutes = template.duration_minutes.unwrap_or(10).max(1);
            let until = Utc::now() + Duration::minutes(duration_minutes as i64);
            paracord_db::members::set_member_timeout(
                &state.db,
                target_user_id,
                guild_id,
                Some(until),
            )
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            action_result["status"] = json!("muted");
            action_result["until"] = json!(until.to_rfc3339());
        }
        ACTION_KICK => {
            paracord_db::members::remove_member(&state.db, target_user_id, guild_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            state.member_index.remove_member(guild_id, target_user_id);
            state.event_bus.dispatch(
                "GUILD_MEMBER_REMOVE",
                json!({
                    "guild_id": guild_id.to_string(),
                    "user_id": target_user_id.to_string(),
                    "reason": rendered_reason,
                }),
                Some(guild_id),
            );
            action_result["status"] = json!("kicked");
        }
        ACTION_BAN => {
            paracord_db::bans::create_ban(
                &state.db,
                target_user_id,
                guild_id,
                Some(&rendered_reason),
                auth.user_id,
            )
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            let _ = paracord_db::members::remove_member(&state.db, target_user_id, guild_id).await;
            state.member_index.remove_member(guild_id, target_user_id);
            state.event_bus.dispatch(
                "GUILD_BAN_ADD",
                json!({
                    "guild_id": guild_id.to_string(),
                    "user_id": target_user_id.to_string(),
                    "reason": rendered_reason,
                }),
                Some(guild_id),
            );
            action_result["status"] = json!("banned");
        }
        _ => return Err(ApiError::BadRequest("Unsupported template action".into())),
    }

    state.event_bus.dispatch_to_users(
        "MOD_ACTION_NOTICE",
        json!({
            "guild_id": guild_id.to_string(),
            "target_user_id": target_user_id.to_string(),
            "action_type": template.action_type,
            "message": rendered_dm,
            "reason": rendered_reason,
            "actor_user_id": auth.user_id.to_string(),
        }),
        vec![target_user_id],
    );

    mod_log::emit_mod_log(
        &state,
        guild_id,
        "Moderation Template Applied",
        &format!(
            "{} applied template \"{}\"",
            actor_user.username, template.name
        ),
        &[
            ("Target", target_user.username.clone()),
            (
                "Action",
                action_result["status"]
                    .as_str()
                    .unwrap_or("applied")
                    .to_string(),
            ),
            ("Reason", rendered_reason.clone()),
        ],
    )
    .await;

    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_MEMBER_UPDATE,
        Some(target_user_id),
        Some(&rendered_reason),
        Some(json!({
            "template_id": template.id.to_string(),
            "template_name": template.name,
            "action_type": template.action_type,
        })),
    )
    .await;

    Ok(Json(action_result))
}
