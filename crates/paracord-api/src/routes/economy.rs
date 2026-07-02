use std::sync::OnceLock;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;

const DEFAULT_LEADERBOARD_LIMIT: i64 = 20;
const MAX_LEADERBOARD_LIMIT: i64 = 100;
const MESSAGE_XP_MIN: i64 = 15;
const MESSAGE_XP_MAX: i64 = 25;

static XP_COOLDOWN_SECONDS: OnceLock<i64> = OnceLock::new();

fn xp_cooldown_seconds() -> i64 {
    *XP_COOLDOWN_SECONDS.get_or_init(|| {
        std::env::var("PARACORD_XP_COOLDOWN_SECONDS")
            .ok()
            .and_then(|raw| raw.trim().parse::<i64>().ok())
            .unwrap_or(45)
            .max(0)
    })
}

fn message_xp_amount(content: &str) -> i64 {
    let length_bonus = (content.trim().chars().count() as i64 / 80).clamp(0, 10);
    (MESSAGE_XP_MIN + length_bonus).clamp(MESSAGE_XP_MIN, MESSAGE_XP_MAX)
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

pub(crate) async fn award_message_xp(
    state: &AppState,
    guild_id: i64,
    user_id: i64,
    content: &str,
) -> Result<(), ApiError> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    let now = Utc::now();
    let cooldown_seconds = xp_cooldown_seconds();
    if cooldown_seconds > 0 {
        let existing = paracord_db::economy::get_user_xp(&state.db, user_id, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        if let Some(row) = existing {
            let elapsed = now.signed_duration_since(row.last_xp_at).num_seconds();
            if elapsed < cooldown_seconds {
                return Ok(());
            }
        }
    }

    let xp_awarded = message_xp_amount(trimmed);
    let (xp_row, leveled_up) =
        paracord_db::economy::add_xp(&state.db, user_id, guild_id, xp_awarded)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let streak = paracord_db::economy::upsert_user_activity_streak(
        &state.db,
        user_id,
        guild_id,
        now.date_naive(),
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let eligible_roles =
        paracord_db::economy::list_eligible_level_roles(&state.db, guild_id, xp_row.level)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    for mapping in eligible_roles {
        let _ = paracord_db::roles::add_member_role(&state.db, user_id, guild_id, mapping.role_id)
            .await;
    }

    let mut newly_awarded: Vec<String> = Vec::new();
    let achievement_rules: [(&str, bool); 7] = [
        ("first-message", xp_row.xp > 0),
        ("level-5", xp_row.level >= 5),
        ("level-10", xp_row.level >= 10),
        ("level-25", xp_row.level >= 25),
        ("streak-7", streak.streak_days >= 7),
        ("streak-30", streak.streak_days >= 30),
        ("streak-100", streak.streak_days >= 100),
    ];
    for (key, reached) in achievement_rules {
        if !reached {
            continue;
        }
        let granted =
            paracord_db::economy::grant_achievement_if_missing(&state.db, user_id, guild_id, key)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        if granted {
            newly_awarded.push(key.to_string());
        }
    }

    state.event_bus.dispatch(
        "GUILD_MEMBER_XP_UPDATE",
        json!({
            "guild_id": guild_id.to_string(),
            "user_id": user_id.to_string(),
            "xp": xp_row.xp,
            "level": xp_row.level,
            "xp_awarded": xp_awarded,
            "leveled_up": leveled_up,
            "streak_days": streak.streak_days,
            "longest_streak_days": streak.longest_streak_days,
            "new_achievements": newly_awarded,
        }),
        Some(guild_id),
    );

    Ok(())
}

#[derive(Deserialize)]
pub struct LeaderboardQuery {
    pub limit: Option<i64>,
}

pub async fn get_leaderboard(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Query(query): Query<LeaderboardQuery>,
) -> Result<Json<Value>, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    let limit = query
        .limit
        .unwrap_or(DEFAULT_LEADERBOARD_LIMIT)
        .clamp(1, MAX_LEADERBOARD_LIMIT);

    let rows = paracord_db::economy::get_leaderboard(&state.db, guild_id, limit)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let mut entries = Vec::with_capacity(rows.len());
    for (index, row) in rows.iter().enumerate() {
        let user = match paracord_db::users::get_user_by_id(&state.db, row.user_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        {
            Some(user) => user,
            None => continue,
        };
        let streak_days =
            paracord_db::economy::get_user_activity_streak(&state.db, row.user_id, guild_id)
                .await
                .ok()
                .flatten()
                .map(|value| value.streak_days)
                .unwrap_or(0);

        entries.push(json!({
            "rank": index + 1,
            "user": {
                "id": user.id.to_string(),
                "username": user.username,
                "discriminator": user.discriminator,
                "avatar": user.avatar_hash,
            },
            "xp": row.xp,
            "level": row.level,
            "streak_days": streak_days,
            "last_xp_at": row.last_xp_at.to_rfc3339(),
        }));
    }

    Ok(Json(json!({
        "guild_id": guild_id.to_string(),
        "entries": entries,
        "limit": limit,
    })))
}

pub async fn get_my_progress(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    let xp_row = paracord_db::economy::get_user_xp(&state.db, auth.user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let streak = paracord_db::economy::get_user_activity_streak(&state.db, auth.user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let achievements =
        paracord_db::economy::list_user_achievements(&state.db, auth.user_id, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let rank = paracord_db::economy::get_user_rank(&state.db, auth.user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let (xp, level, last_xp_at) = match xp_row {
        Some(row) => (row.xp, row.level, Some(row.last_xp_at.to_rfc3339())),
        None => (0_i64, 0_i32, None),
    };

    let current_level_floor = (level as i64).pow(2) * 100;
    let next_level_at = ((level + 1) as i64).pow(2) * 100;

    Ok(Json(json!({
        "guild_id": guild_id.to_string(),
        "user_id": auth.user_id.to_string(),
        "xp": xp,
        "level": level,
        "rank": rank,
        "last_xp_at": last_xp_at,
        "progress": {
            "current_level_floor": current_level_floor,
            "next_level_at": next_level_at,
            "xp_into_level": (xp - current_level_floor).max(0),
            "xp_required_this_level": (next_level_at - current_level_floor).max(1),
        },
        "streak": {
            "days": streak.as_ref().map(|value| value.streak_days).unwrap_or(0),
            "longest_days": streak
                .as_ref()
                .map(|value| value.longest_streak_days)
                .unwrap_or(0),
            "last_active_date": streak
                .as_ref()
                .map(|value| value.last_active_date.to_string()),
        },
        "achievements": achievements
            .iter()
            .map(|entry| json!({
                "key": entry.achievement_key,
                "awarded_at": entry.awarded_at.to_rfc3339(),
            }))
            .collect::<Vec<_>>(),
    })))
}

pub async fn list_level_roles(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    let mappings = paracord_db::economy::list_level_roles(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(json!({
        "guild_id": guild_id.to_string(),
        "mappings": mappings.iter().map(|entry| json!({
            "level": entry.level,
            "role_id": entry.role_id.to_string(),
            "created_at": entry.created_at.to_rfc3339(),
        })).collect::<Vec<_>>()
    })))
}

#[derive(Deserialize)]
pub struct LevelRoleMappingInput {
    pub level: i32,
    pub role_id: String,
}

#[derive(Deserialize)]
pub struct UpdateLevelRolesRequest {
    pub mappings: Vec<LevelRoleMappingInput>,
}

pub async fn update_level_roles(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<UpdateLevelRolesRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    ensure_manage_guild(&state, guild_id, auth.user_id).await?;

    if body.mappings.len() > 200 {
        return Err(ApiError::BadRequest(
            "Too many mappings; maximum is 200".to_string(),
        ));
    }

    let mut parsed_mappings: Vec<(i32, i64)> = Vec::with_capacity(body.mappings.len());
    for mapping in &body.mappings {
        if mapping.level < 0 {
            return Err(ApiError::BadRequest(
                "level must be non-negative".to_string(),
            ));
        }
        let role_id = mapping
            .role_id
            .parse::<i64>()
            .map_err(|_| ApiError::BadRequest("Invalid role_id".to_string()))?;
        let role = paracord_db::roles::get_role(&state.db, role_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or_else(|| ApiError::BadRequest("Unknown role_id".to_string()))?;
        if role.space_id != guild_id {
            return Err(ApiError::BadRequest(
                "role_id must belong to this guild".to_string(),
            ));
        }
        parsed_mappings.push((mapping.level, role_id));
    }

    paracord_db::economy::replace_level_roles(&state.db, guild_id, &parsed_mappings)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let mappings = paracord_db::economy::list_level_roles(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok((
        StatusCode::OK,
        Json(json!({
            "guild_id": guild_id.to_string(),
            "mappings": mappings.iter().map(|entry| json!({
                "level": entry.level,
                "role_id": entry.role_id.to_string(),
                "created_at": entry.created_at.to_rfc3339(),
            })).collect::<Vec<_>>()
        })),
    ))
}
