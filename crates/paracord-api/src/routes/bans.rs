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

const MAX_BAN_REASON_LEN: usize = 512;

fn contains_dangerous_markup(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("<script")
        || lower.contains("javascript:")
        || lower.contains("onerror=")
        || lower.contains("onload=")
        || lower.contains("<iframe")
}

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

    let mut result: Vec<Value> = Vec::with_capacity(bans.len());
    for b in bans {
        let user = paracord_db::users::get_user_by_id(&state.db, b.user_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        let user_json = match user {
            Some(u) => json!({
                "id": u.id.to_string(),
                "username": u.username,
                "display_name": u.display_name,
                "discriminator": u.discriminator,
                "avatar_hash": u.avatar_hash,
                "flags": u.flags,
                "bot": paracord_core::is_bot(u.flags),
                "system": false,
            }),
            None => json!({
                "id": b.user_id.to_string(),
                "username": format!("Unknown#{}", b.user_id),
                "display_name": null,
                "discriminator": 0,
                "avatar_hash": null,
                "flags": 0,
                "bot": false,
                "system": false,
            }),
        };
        result.push(json!({
            "user_id": b.user_id.to_string(),
            "user": user_json,
            "guild_id": guild_id.to_string(),
            "reason": b.reason,
            "banned_by": b.banned_by.map(|id| id.to_string()),
            "created_at": b.created_at.to_rfc3339(),
        }));
    }

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
    if let Some(reason_text) = reason.as_deref() {
        // Measured on the raw value: `reason` is stored untrimmed below, so
        // checking `trim()` let a whitespace-padded reason of any size reach a
        // length-limited column. PostgreSQL only silently truncates a varchar
        // overflow when the excess is spaces — a padded newline or tab raises
        // 22001 and surfaces as a 500.
        if reason_text.len() > MAX_BAN_REASON_LEN {
            return Err(ApiError::BadRequest("Ban reason is too long".into()));
        }
        if contains_dangerous_markup(reason_text) {
            return Err(ApiError::BadRequest(
                "Ban reason contains unsafe markup".into(),
            ));
        }
    }
    paracord_core::admin::ban_member(
        &state.db,
        guild_id,
        auth.user_id,
        user_id,
        reason.as_deref(),
    )
    .await?;

    // Terminate any in-progress voice/video call the banned member is part of so
    // they stop eavesdropping on and injecting into the call, and cannot
    // reconnect against a stale voice state within their media token's lifetime.
    crate::routes::voice::evict_user_from_guild_media(&state, guild_id, user_id).await;

    // Evict the banned member's cached channel permissions so a stale cache hit
    // cannot keep granting access for the remainder of the cache TTL.
    paracord_core::permissions::invalidate_user(&state.permission_cache, user_id).await;

    state.event_bus.dispatch(
        "GUILD_BAN_ADD",
        json!({
            "guild_id": guild_id.to_string(),
            "user_id": user_id.to_string(),
        }),
        Some(guild_id),
    );

    state.member_index.remove_member(guild_id, user_id);
    state.event_bus.dispatch(
        "GUILD_MEMBER_REMOVE",
        json!({
            "guild_id": guild_id.to_string(),
            "user_id": user_id.to_string(),
        }),
        Some(guild_id),
    );

    if paracord_federation::is_enabled() {
        let fed_state = state.clone();
        tokio::spawn(async move {
            crate::routes::members::federation_forward_member_event(
                &fed_state,
                "m.member.leave",
                guild_id,
                user_id,
            )
            .await;
        });
    }

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

    mod_log::emit_mod_log(
        &state,
        guild_id,
        "Member Banned",
        "A member was banned from the server.",
        &[
            ("Actor", auth.user_id.to_string()),
            ("Target", user_id.to_string()),
            (
                "Reason",
                reason
                    .clone()
                    .unwrap_or_else(|| "No reason provided".to_string()),
            ),
        ],
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

    mod_log::emit_mod_log(
        &state,
        guild_id,
        "Member Unbanned",
        "A member was unbanned.",
        &[
            ("Actor", auth.user_id.to_string()),
            ("Target", user_id.to_string()),
        ],
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}
