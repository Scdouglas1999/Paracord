//! Per-space and per-channel notification settings.
//!
//! The only notification control before this was one global blob on
//! `user_settings`, so a member of a busy space could not quiet a single noisy
//! channel without leaving the space outright.
//!
//! Settings resolve channel -> space -> default, which is what makes the two
//! useful cases expressible: mute one channel in a space you otherwise follow,
//! and follow one channel in a space you muted.
//!
//! Every route is scoped to the calling user — these are *their* preferences,
//! not moderation — so the only authorization required is that they can see the
//! scope at all. Writing a setting for a space you are not in, or a channel you
//! cannot view, is rejected: it would otherwise be a membership oracle and would
//! leave rows keyed to scopes the user has no business naming.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;
use paracord_db::notification_settings as ns;

/// Longest a timed mute may run. Matches the timeout ceiling used elsewhere;
/// past this, "muted indefinitely" is the honest setting.
const MAX_MUTE_SECONDS: i64 = 60 * 60 * 24 * 28;

#[derive(Deserialize)]
pub struct UpdateNotificationSettings {
    /// 0 = all messages, 1 = only mentions, 2 = nothing. Omitted keeps `all`.
    pub level: Option<i16>,
    pub muted: Option<bool>,
    /// Seconds from now that the mute should lapse. Omitted (with `muted`)
    /// means indefinitely.
    pub mute_duration_seconds: Option<i64>,
    pub suppress_everyone: Option<bool>,
}

struct Parsed {
    level: i16,
    muted: bool,
    muted_until: Option<DateTime<Utc>>,
    suppress_everyone: bool,
}

fn parse(body: &UpdateNotificationSettings) -> Result<Parsed, ApiError> {
    let level = body.level.unwrap_or(ns::LEVEL_ALL);
    if !ns::is_valid_level(level) {
        return Err(ApiError::BadRequest(
            "level must be 0 (all), 1 (mentions) or 2 (nothing)".into(),
        ));
    }
    let muted = body.muted.unwrap_or(false);
    let muted_until = match body.mute_duration_seconds {
        Some(seconds) => {
            if !muted {
                return Err(ApiError::BadRequest(
                    "mute_duration_seconds requires muted to be true".into(),
                ));
            }
            if seconds <= 0 || seconds > MAX_MUTE_SECONDS {
                return Err(ApiError::BadRequest(format!(
                    "mute_duration_seconds must be between 1 and {MAX_MUTE_SECONDS}"
                )));
            }
            Some(Utc::now() + chrono::Duration::seconds(seconds))
        }
        None => None,
    };
    Ok(Parsed {
        level,
        muted,
        muted_until,
        suppress_everyone: body.suppress_everyone.unwrap_or(false),
    })
}

fn to_json(scope: &str, row: &ns::NotificationSettingRow) -> Value {
    json!({
        scope: row.scope_id.to_string(),
        "level": row.level,
        "muted": row.muted,
        "muted_until": row.muted_until.map(|v| v.to_rfc3339()),
        // Resolved for the caller so a client never has to re-derive whether a
        // timed mute has already lapsed.
        "muted_now": row.is_muted_at(Utc::now()),
        "suppress_everyone": row.suppress_everyone,
    })
}

/// Every override the caller holds, both scopes, in one payload.
///
/// Clients need all of it up front to render the space and channel lists, so
/// this is one request rather than one per scope.
pub async fn list_my_notification_settings(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let spaces = ns::list_space_settings(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let channels = ns::list_channel_settings(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!({
        "spaces": spaces.iter().map(|r| to_json("space_id", r)).collect::<Vec<_>>(),
        "channels": channels.iter().map(|r| to_json("channel_id", r)).collect::<Vec<_>>(),
    })))
}

/// Confirm the caller is a member of `guild_id`.
async fn ensure_member(state: &AppState, guild_id: i64, user_id: i64) -> Result<(), ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, user_id)
        .await
        .map_err(ApiError::from)
}

pub async fn put_space_notification_settings(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<UpdateNotificationSettings>,
) -> Result<Json<Value>, ApiError> {
    ensure_member(&state, guild_id, auth.user_id).await?;
    let parsed = parse(&body)?;
    ns::set_space_settings(
        &state.db,
        auth.user_id,
        guild_id,
        parsed.level,
        parsed.muted,
        parsed.muted_until,
        parsed.suppress_everyone,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let row = ns::get_space_settings(&state.db, auth.user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(to_json("space_id", &row)))
}

pub async fn delete_space_notification_settings(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    ns::clear_space_settings(&state.db, auth.user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(StatusCode::NO_CONTENT)
}

/// The caller must be able to see the channel before pinning a preference to
/// it.
///
/// `compute_channel_permissions` resolves a thread's gate from its parent, so a
/// preference on a thread is governed by the channel it lives in — the same
/// rule the rest of the API applies.
async fn ensure_channel_visible(
    state: &AppState,
    channel_id: i64,
    user_id: i64,
) -> Result<(), ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    match channel.guild_id() {
        Some(guild_id) => {
            let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                .ok_or(ApiError::NotFound)?;
            let perms = paracord_core::permissions::compute_channel_permissions(
                &state.db,
                guild_id,
                channel_id,
                guild.owner_id,
                user_id,
            )
            .await?;
            if !perms.contains(Permissions::VIEW_CHANNEL) {
                return Err(ApiError::Forbidden);
            }
        }
        None => {
            // A DM has no guild to check membership against; the caller must be
            // one of its recipients.
            let member = paracord_db::dms::is_dm_recipient(&state.db, channel_id, user_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            if !member {
                return Err(ApiError::Forbidden);
            }
        }
    }
    Ok(())
}

pub async fn put_channel_notification_settings(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<UpdateNotificationSettings>,
) -> Result<Json<Value>, ApiError> {
    ensure_channel_visible(&state, channel_id, auth.user_id).await?;
    let parsed = parse(&body)?;
    ns::set_channel_settings(
        &state.db,
        auth.user_id,
        channel_id,
        parsed.level,
        parsed.muted,
        parsed.muted_until,
        parsed.suppress_everyone,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let row = ns::get_channel_settings(&state.db, auth.user_id, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(to_json("channel_id", &row)))
}

pub async fn delete_channel_notification_settings(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    ns::clear_channel_settings(&state.db, auth.user_id, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(StatusCode::NO_CONTENT)
}
