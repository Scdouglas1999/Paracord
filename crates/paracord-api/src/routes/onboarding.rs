use axum::{
    extract::{Path, State},
    Json,
};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;

const MAX_WELCOME_TITLE_LEN: usize = 120;
const MAX_WELCOME_BODY_LEN: usize = 2_000;
const MAX_RULES_TEXT_LEN: usize = 8_000;
const MAX_ROLE_PROMPT_LEN: usize = 240;
const MAX_ROLE_OPTIONS: usize = 50;

fn trim_opt(value: Option<&str>) -> Option<String> {
    value.map(str::trim).and_then(|v| {
        if v.is_empty() {
            None
        } else {
            Some(v.to_string())
        }
    })
}

fn settings_to_json(
    guild_id: i64,
    settings: Option<&paracord_db::onboarding::GuildOnboardingSettingsRow>,
    role_options: &[paracord_db::onboarding::GuildOnboardingRoleOptionRow],
) -> Value {
    let (
        welcome_title,
        welcome_body,
        rules_text,
        role_prompt,
        progressive_channel_min_messages,
        updated_at,
    ) = if let Some(settings) = settings {
        (
            settings.welcome_title.clone(),
            settings.welcome_body.clone(),
            settings.rules_text.clone(),
            settings.role_prompt.clone(),
            settings.progressive_channel_min_messages,
            Some(settings.updated_at.to_rfc3339()),
        )
    } else {
        (None, None, None, None, 0, None)
    };
    json!({
        "guild_id": guild_id.to_string(),
        "welcome_title": welcome_title,
        "welcome_body": welcome_body,
        "rules_text": rules_text,
        "role_prompt": role_prompt,
        "progressive_channel_min_messages": progressive_channel_min_messages,
        "updated_at": updated_at,
        "role_options": role_options.iter().map(|row| json!({
            "id": row.id.to_string(),
            "role_id": row.role_id.to_string(),
            "label": row.label,
            "description": row.description,
            "position": row.position,
        })).collect::<Vec<_>>(),
    })
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
pub struct UpsertRoleOptionRequest {
    pub role_id: String,
    pub label: Option<String>,
    pub description: Option<String>,
    pub position: Option<i32>,
}

#[derive(Deserialize)]
pub struct UpdateOnboardingSettingsRequest {
    pub welcome_title: Option<String>,
    pub welcome_body: Option<String>,
    pub rules_text: Option<String>,
    pub role_prompt: Option<String>,
    pub progressive_channel_min_messages: Option<i32>,
    pub role_options: Option<Vec<UpsertRoleOptionRequest>>,
}

pub async fn get_guild_onboarding(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
    let settings = paracord_db::onboarding::get_guild_onboarding_settings(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let role_options =
        paracord_db::onboarding::list_guild_onboarding_role_options(&state.db, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(settings_to_json(
        guild_id,
        settings.as_ref(),
        &role_options,
    )))
}

pub async fn update_guild_onboarding(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<UpdateOnboardingSettingsRequest>,
) -> Result<Json<Value>, ApiError> {
    ensure_manage_guild(&state, guild_id, auth.user_id).await?;

    let welcome_title = trim_opt(body.welcome_title.as_deref());
    let welcome_body = trim_opt(body.welcome_body.as_deref());
    let rules_text = trim_opt(body.rules_text.as_deref());
    let role_prompt = trim_opt(body.role_prompt.as_deref());
    if welcome_title
        .as_deref()
        .is_some_and(|value| value.len() > MAX_WELCOME_TITLE_LEN)
    {
        return Err(ApiError::BadRequest(format!(
            "welcome_title must be <= {} characters",
            MAX_WELCOME_TITLE_LEN
        )));
    }
    if welcome_body
        .as_deref()
        .is_some_and(|value| value.len() > MAX_WELCOME_BODY_LEN)
    {
        return Err(ApiError::BadRequest(format!(
            "welcome_body must be <= {} characters",
            MAX_WELCOME_BODY_LEN
        )));
    }
    if rules_text
        .as_deref()
        .is_some_and(|value| value.len() > MAX_RULES_TEXT_LEN)
    {
        return Err(ApiError::BadRequest(format!(
            "rules_text must be <= {} characters",
            MAX_RULES_TEXT_LEN
        )));
    }
    if role_prompt
        .as_deref()
        .is_some_and(|value| value.len() > MAX_ROLE_PROMPT_LEN)
    {
        return Err(ApiError::BadRequest(format!(
            "role_prompt must be <= {} characters",
            MAX_ROLE_PROMPT_LEN
        )));
    }
    let progressive = body.progressive_channel_min_messages.unwrap_or(0);
    if !(0..=1_000_000).contains(&progressive) {
        return Err(ApiError::BadRequest(
            "progressive_channel_min_messages must be between 0 and 1000000".into(),
        ));
    }

    let settings = paracord_db::onboarding::upsert_guild_onboarding_settings(
        &state.db,
        guild_id,
        welcome_title.as_deref(),
        welcome_body.as_deref(),
        rules_text.as_deref(),
        role_prompt.as_deref(),
        progressive,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    if let Some(role_options) = body.role_options {
        if role_options.len() > MAX_ROLE_OPTIONS {
            return Err(ApiError::BadRequest(format!(
                "role_options must contain at most {} entries",
                MAX_ROLE_OPTIONS
            )));
        }
        let mut rows: Vec<(i64, i64, Option<String>, Option<String>, i32)> =
            Vec::with_capacity(role_options.len());
        for (idx, option) in role_options.into_iter().enumerate() {
            let role_id = option
                .role_id
                .parse::<i64>()
                .map_err(|_| ApiError::BadRequest("Invalid role_id".into()))?;
            let role = paracord_db::roles::get_role(&state.db, role_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                .ok_or_else(|| ApiError::BadRequest("role_id does not exist".into()))?;
            if role.space_id != guild_id {
                return Err(ApiError::BadRequest(
                    "all onboarding role options must belong to the target guild".into(),
                ));
            }
            rows.push((
                paracord_util::snowflake::generate(1),
                role_id,
                trim_opt(option.label.as_deref()),
                trim_opt(option.description.as_deref()),
                option.position.unwrap_or(idx as i32),
            ));
        }
        paracord_db::onboarding::replace_guild_onboarding_role_options(&state.db, guild_id, &rows)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    }

    let updated_role_options =
        paracord_db::onboarding::list_guild_onboarding_role_options(&state.db, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(settings_to_json(
        guild_id,
        Some(&settings),
        &updated_role_options,
    )))
}

#[derive(Deserialize)]
pub struct UpdateMyOnboardingStateRequest {
    pub accepted_rules: bool,
    pub selected_role_ids: Option<Vec<String>>,
    pub completed: Option<bool>,
}

pub async fn get_my_onboarding_state(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
    let settings = paracord_db::onboarding::get_guild_onboarding_settings(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let role_options =
        paracord_db::onboarding::list_guild_onboarding_role_options(&state.db, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let state_row =
        paracord_db::onboarding::get_member_onboarding_state(&state.db, guild_id, auth.user_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let selected_role_ids: Vec<String> = state_row
        .as_ref()
        .and_then(|row| {
            serde_json::from_str::<Vec<i64>>(&row.selected_role_ids)
                .ok()
                .map(|ids| ids.into_iter().map(|id| id.to_string()).collect::<Vec<_>>())
        })
        .unwrap_or_default();
    Ok(Json(json!({
        "settings": settings_to_json(guild_id, settings.as_ref(), &role_options),
        "member_state": {
            "guild_id": guild_id.to_string(),
            "user_id": auth.user_id.to_string(),
            "accepted_rules": state_row.as_ref().map(|row| row.accepted_rules).unwrap_or(false),
            "selected_role_ids": selected_role_ids,
            "completed_at": state_row.and_then(|row| row.completed_at.map(|v| v.to_rfc3339())),
        }
    })))
}

pub async fn update_my_onboarding_state(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<UpdateMyOnboardingStateRequest>,
) -> Result<Json<Value>, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
    let settings = paracord_db::onboarding::get_guild_onboarding_settings(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let role_options =
        paracord_db::onboarding::list_guild_onboarding_role_options(&state.db, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let allowed_roles = role_options
        .iter()
        .map(|row| row.role_id)
        .collect::<std::collections::HashSet<_>>();

    let selected_role_ids = body
        .selected_role_ids
        .unwrap_or_default()
        .into_iter()
        .map(|raw| {
            raw.parse::<i64>()
                .map_err(|_| ApiError::BadRequest("Invalid selected_role_ids entry".into()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if !allowed_roles.is_empty()
        && selected_role_ids
            .iter()
            .any(|id| !allowed_roles.contains(id))
    {
        return Err(ApiError::BadRequest(
            "selected_role_ids must be a subset of configured onboarding role options".into(),
        ));
    }

    let completed = body.completed.unwrap_or(body.accepted_rules);
    if completed
        && settings
            .as_ref()
            .and_then(|s| s.rules_text.as_ref())
            .is_some()
        && !body.accepted_rules
    {
        return Err(ApiError::BadRequest(
            "rules must be accepted before completing onboarding".into(),
        ));
    }

    let existing =
        paracord_db::onboarding::get_member_onboarding_state(&state.db, guild_id, auth.user_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let previous_ids = existing
        .as_ref()
        .and_then(|row| serde_json::from_str::<Vec<i64>>(&row.selected_role_ids).ok())
        .unwrap_or_default();
    let previous_set = previous_ids
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let selected_set = selected_role_ids
        .iter()
        .copied()
        .collect::<std::collections::HashSet<_>>();

    for role_id in previous_set.difference(&selected_set) {
        let _ = paracord_db::roles::remove_member_role(&state.db, auth.user_id, guild_id, *role_id)
            .await;
    }
    for role_id in selected_set.difference(&previous_set) {
        paracord_db::roles::add_member_role(&state.db, auth.user_id, guild_id, *role_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    }

    paracord_core::permissions::invalidate_user(&state.permission_cache, auth.user_id).await;

    let selected_json = serde_json::to_string(&selected_role_ids)
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("failed to serialize selected roles")))?;
    let updated = paracord_db::onboarding::upsert_member_onboarding_state(
        &state.db,
        guild_id,
        auth.user_id,
        body.accepted_rules,
        &selected_json,
        completed,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(json!({
        "guild_id": updated.guild_id.to_string(),
        "user_id": updated.user_id.to_string(),
        "accepted_rules": updated.accepted_rules,
        "selected_role_ids": selected_role_ids.into_iter().map(|id| id.to_string()).collect::<Vec<_>>(),
        "completed_at": updated.completed_at.map(|v| v.to_rfc3339()),
        "updated_at": updated.updated_at.to_rfc3339(),
    })))
}
