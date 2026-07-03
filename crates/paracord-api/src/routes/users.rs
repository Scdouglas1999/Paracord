use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use paracord_core::AppState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::OnceLock;
use std::time::Instant;
use url::Url;

use crate::error::ApiError;
use crate::middleware::AuthUser;
use crate::routes::security;

const MAX_DISPLAY_NAME_LEN: usize = 64;
const MAX_BIO_LEN: usize = 512;
const MAX_CUSTOM_STATUS_LEN: usize = 128;
const MAX_CUSTOM_CSS_LEN: usize = 10 * 1024;
const MAX_PROFILE_PRONOUNS_LEN: usize = 64;
const MAX_PROFILE_LINKED_ACCOUNTS: usize = 8;
const MAX_PROFILE_LINKED_LABEL_LEN: usize = 64;
const MAX_PROFILE_LINKED_URL_LEN: usize = 256;
const TRACE_ID_HEADER: &str = "x-paracord-trace-id";
static SETTINGS_ROUTE_STAGE_TRACE: OnceLock<bool> = OnceLock::new();
static SETTINGS_ROUTE_SLOW_MS: OnceLock<u64> = OnceLock::new();

fn settings_route_stage_trace_enabled() -> bool {
    *SETTINGS_ROUTE_STAGE_TRACE.get_or_init(|| {
        std::env::var("PARACORD_HTTP_STAGE_TRACE")
            .ok()
            .map(|raw| {
                matches!(
                    raw.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
            .unwrap_or(false)
    })
}

fn settings_route_slow_ms() -> u64 {
    *SETTINGS_ROUTE_SLOW_MS.get_or_init(|| {
        std::env::var("PARACORD_HTTP_SLOW_MS")
            .ok()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(500)
    })
}

fn contains_dangerous_markup(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("<script")
        || lower.contains("javascript:")
        || lower.contains("onerror=")
        || lower.contains("onload=")
        || lower.contains("<iframe")
}

fn sanitize_custom_css(value: &str) -> Result<Option<String>, ApiError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > MAX_CUSTOM_CSS_LEN {
        return Err(ApiError::BadRequest("custom_css exceeds 10KB".into()));
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("@import")
        || lower.contains("@font-face")
        || lower.contains("url(")
        || lower.contains("expression(")
        || lower.contains("javascript:")
    {
        return Err(ApiError::BadRequest(
            "custom_css contains disallowed directives".into(),
        ));
    }
    Ok(Some(trimmed.to_string()))
}

fn profile_pronouns_from_notifications(
    notifications: Option<&serde_json::Value>,
) -> Option<String> {
    notifications
        .and_then(|n| n.get("profilePronouns"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(MAX_PROFILE_PRONOUNS_LEN).collect())
}

fn profile_linked_accounts_from_notifications(
    notifications: Option<&serde_json::Value>,
) -> Vec<Value> {
    let Some(accounts) = notifications
        .and_then(|n| n.get("profileLinkedAccounts"))
        .and_then(|v| v.as_array())
    else {
        return Vec::new();
    };

    accounts
        .iter()
        .filter_map(|entry| {
            let label = entry
                .get("label")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            let url = entry
                .get("url")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())?;

            let url = safe_profile_linked_account_url(url)?;

            Some(json!({
                "label": label.chars().take(MAX_PROFILE_LINKED_LABEL_LEN).collect::<String>(),
                "url": url,
            }))
        })
        .take(MAX_PROFILE_LINKED_ACCOUNTS)
        .collect()
}

fn safe_profile_linked_account_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_PROFILE_LINKED_URL_LEN {
        return None;
    }
    let parsed = Url::parse(trimmed).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    let normalized = parsed.to_string();
    if normalized.len() > MAX_PROFILE_LINKED_URL_LEN {
        return None;
    }
    Some(normalized)
}

fn profile_extras_from_settings(
    settings: Option<&paracord_db::users::UserSettingsRow>,
) -> (Option<String>, Vec<Value>) {
    let notifications = settings.map(|s| &s.notifications);
    (
        profile_pronouns_from_notifications(notifications),
        profile_linked_accounts_from_notifications(notifications),
    )
}

pub async fn get_me(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let settings = paracord_db::users::get_user_settings(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let (pronouns, linked_accounts) = profile_extras_from_settings(settings.as_ref());

    Ok(Json(json!({
        "id": user.id.to_string(),
        "username": user.username,
        "discriminator": user.discriminator,
        "email": user.email,
        "display_name": user.display_name,
        "avatar_hash": user.avatar_hash,
        "banner_hash": user.banner_hash,
        "bio": user.bio,
        "flags": user.flags,
        "bot": paracord_core::is_bot(user.flags),
        "system": false,
        "pronouns": pronouns,
        "linked_accounts": linked_accounts,
        "created_at": user.created_at.to_rfc3339(),
        "email_verified": user.email_verified,
    })))
}

#[derive(Deserialize)]
pub struct UpdateMeRequest {
    pub display_name: Option<String>,
    pub bio: Option<String>,
    pub avatar_hash: Option<String>,
}

pub async fn update_me(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<UpdateMeRequest>,
) -> Result<Json<Value>, ApiError> {
    if let Some(display_name) = body.display_name.as_deref() {
        let trimmed = display_name.trim();
        if trimmed.len() > MAX_DISPLAY_NAME_LEN {
            return Err(ApiError::BadRequest("display_name is too long".into()));
        }
        if contains_dangerous_markup(trimmed) {
            return Err(ApiError::BadRequest(
                "display_name contains unsafe markup".into(),
            ));
        }
    }
    if let Some(bio) = body.bio.as_deref() {
        let trimmed = bio.trim();
        if trimmed.len() > MAX_BIO_LEN {
            return Err(ApiError::BadRequest("bio is too long".into()));
        }
        if contains_dangerous_markup(trimmed) {
            return Err(ApiError::BadRequest("bio contains unsafe markup".into()));
        }
    }

    let updated = paracord_core::user::update_profile(
        &state.db,
        auth.user_id,
        body.display_name.as_deref(),
        body.bio.as_deref(),
        body.avatar_hash.as_deref(),
    )
    .await?;

    Ok(Json(json!({
        "id": updated.id.to_string(),
        "username": updated.username,
        "discriminator": updated.discriminator,
        "email": updated.email,
        "display_name": updated.display_name,
        "avatar_hash": updated.avatar_hash,
        "banner_hash": updated.banner_hash,
        "bio": updated.bio,
        "flags": updated.flags,
        "bot": paracord_core::is_bot(updated.flags),
        "system": false,
        "created_at": updated.created_at.to_rfc3339(),
    })))
}

pub async fn get_settings(
    State(state): State<AppState>,
    auth: AuthUser,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let route_started = Instant::now();
    let trace_id = headers
        .get(TRACE_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("-");
    let db_started = Instant::now();
    let settings = paracord_db::users::get_user_settings(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let db_ms = db_started.elapsed().as_millis() as u64;
    let total_ms = route_started.elapsed().as_millis() as u64;
    let slow_threshold_ms = settings_route_slow_ms();
    if settings_route_stage_trace_enabled() || total_ms >= slow_threshold_ms {
        if total_ms >= slow_threshold_ms {
            tracing::warn!(
                target: "perf",
                trace_id,
                route = "GET /api/v1/users/@me/settings",
                user_id = auth.user_id,
                total_ms,
                db_ms,
                has_settings = settings.is_some(),
                "user_settings_get_timing"
            );
        } else {
            tracing::info!(
                target: "perf",
                trace_id,
                route = "GET /api/v1/users/@me/settings",
                user_id = auth.user_id,
                total_ms,
                db_ms,
                has_settings = settings.is_some(),
                "user_settings_get_timing"
            );
        }
    }

    if let Some(s) = settings {
        Ok(Json(json!({
            "user_id": s.user_id.to_string(),
            "theme": s.theme,
            "locale": s.locale,
            "message_display_compact": s.message_display == "compact",
            "custom_css": s.custom_css,
            "status": "online",
            "custom_status": null,
            "crypto_auth_enabled": s.crypto_auth_enabled,
            "notifications": s.notifications,
            "keybinds": s.keybinds,
        })))
    } else {
        Ok(Json(json!({
            "user_id": auth.user_id.to_string(),
            "theme": "dark",
            "locale": "en-US",
            "message_display_compact": false,
            "custom_css": null,
            "status": "online",
            "custom_status": null,
            "crypto_auth_enabled": false,
            "notifications": {},
            "keybinds": {},
        })))
    }
}

#[derive(Deserialize)]
pub struct UpdateSettingsRequest {
    pub theme: Option<String>,
    pub locale: Option<String>,
    pub message_display_compact: Option<bool>,
    pub custom_css: Option<String>,
    pub status: Option<String>,
    pub custom_status: Option<String>,
    pub crypto_auth_enabled: Option<bool>,
    pub notifications: Option<serde_json::Value>,
    pub keybinds: Option<serde_json::Value>,
}

pub async fn update_settings(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: AuthUser,
    headers: HeaderMap,
    Json(body): Json<UpdateSettingsRequest>,
) -> Result<Json<Value>, ApiError> {
    let peer_ip = addr.ip().to_string();
    let route_started = Instant::now();
    let trace_id = headers
        .get(TRACE_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("-");

    let load_existing_started = Instant::now();
    let existing = paracord_db::users::get_user_settings(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let load_existing_ms = load_existing_started.elapsed().as_millis() as u64;

    let theme = body
        .theme
        .as_deref()
        .or_else(|| existing.as_ref().map(|s| s.theme.as_str()))
        .unwrap_or("dark");
    let locale = body
        .locale
        .as_deref()
        .or_else(|| existing.as_ref().map(|s| s.locale.as_str()))
        .unwrap_or("en-US");
    let message_display = if let Some(is_compact) = body.message_display_compact {
        if is_compact {
            "compact"
        } else {
            "cozy"
        }
    } else if let Some(existing_settings) = existing.as_ref() {
        if existing_settings.message_display == "compact" {
            "compact"
        } else {
            "cozy"
        }
    } else {
        "cozy"
    };

    if let Some(status) = body.custom_status.as_deref() {
        if status.trim().len() > MAX_CUSTOM_STATUS_LEN {
            return Err(ApiError::BadRequest("custom_status is too long".into()));
        }
        if contains_dangerous_markup(status) {
            return Err(ApiError::BadRequest(
                "custom_status contains unsafe markup".into(),
            ));
        }
    }

    let custom_css = if let Some(css) = body.custom_css.as_deref() {
        sanitize_custom_css(css)?
    } else {
        existing.as_ref().and_then(|s| s.custom_css.clone())
    };

    let upsert_started = Instant::now();
    let settings = paracord_db::users::upsert_user_settings(
        &state.db,
        auth.user_id,
        theme,
        locale,
        message_display,
        custom_css.as_deref(),
        body.crypto_auth_enabled,
        body.notifications.as_ref(),
        body.keybinds.as_ref(),
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let upsert_ms = upsert_started.elapsed().as_millis() as u64;

    if let Some(enabled) = body.crypto_auth_enabled {
        security::log_security_event(
            &state,
            "user.settings.crypto_auth.update",
            Some(auth.user_id),
            Some(auth.user_id),
            auth.session_id.as_deref(),
            Some(&headers),
            Some(peer_ip.as_str()),
            Some(json!({ "crypto_auth_enabled": enabled })),
        )
        .await;
    }

    let total_ms = route_started.elapsed().as_millis() as u64;
    let slow_threshold_ms = settings_route_slow_ms();
    if settings_route_stage_trace_enabled() || total_ms >= slow_threshold_ms {
        if total_ms >= slow_threshold_ms {
            tracing::warn!(
                target: "perf",
                trace_id,
                route = "PATCH /api/v1/users/@me/settings",
                user_id = auth.user_id,
                total_ms,
                load_existing_ms,
                upsert_ms,
                "user_settings_patch_timing"
            );
        } else {
            tracing::info!(
                target: "perf",
                trace_id,
                route = "PATCH /api/v1/users/@me/settings",
                user_id = auth.user_id,
                total_ms,
                load_existing_ms,
                upsert_ms,
                "user_settings_patch_timing"
            );
        }
    }

    Ok(Json(json!({
        "user_id": settings.user_id.to_string(),
        "theme": settings.theme,
        "locale": settings.locale,
        "message_display_compact": settings.message_display == "compact",
        "custom_css": settings.custom_css,
        "status": body.status.unwrap_or_else(|| "online".to_string()),
        "custom_status": body.custom_status,
        "crypto_auth_enabled": settings.crypto_auth_enabled,
        "notifications": settings.notifications,
        "keybinds": settings.keybinds,
    })))
}

pub async fn get_read_states(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let rows = paracord_db::read_states::get_user_read_states(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let result: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "channel_id": row.channel_id.to_string(),
                "last_message_id": row.last_message_id.to_string(),
                "mention_count": row.mention_count,
            })
        })
        .collect();
    Ok(Json(json!(result)))
}

pub async fn export_my_data(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let settings = paracord_db::users::get_user_settings(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let guilds = paracord_db::guilds::get_user_guilds(&state.db, auth.user_id.into())
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let dms = paracord_db::dms::list_user_dm_channels(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let relationships = paracord_db::relationships::get_relationships(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let read_states = paracord_db::read_states::get_user_read_states(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let sessions =
        paracord_db::sessions::list_user_sessions(&state.db, auth.user_id, chrono::Utc::now())
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let messages =
        paracord_db::messages::list_messages_for_user_export(&state.db, auth.user_id, 200_000)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let message_ids = messages.iter().map(|msg| msg.id).collect::<Vec<_>>();
    let attachments =
        paracord_db::attachments::get_attachments_for_message_ids(&state.db, &message_ids, 100_000)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let signed_prekey = paracord_db::prekeys::get_signed_prekey(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let one_time_prekeys = paracord_db::prekeys::list_one_time_prekeys(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let mut memberships = Vec::new();
    for guild in &guilds {
        let member = paracord_db::members::get_member(&state.db, auth.user_id, guild.id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        let role_rows = paracord_db::roles::get_member_roles(&state.db, auth.user_id, guild.id)
            .await
            .unwrap_or_default();
        memberships.push(json!({
            "guild_id": guild.id.to_string(),
            "nick": member.as_ref().and_then(|m| m.nick.clone()),
            "joined_at": member.map(|m| m.joined_at.to_rfc3339()),
            "role_ids": role_rows.into_iter().map(|role| role.id.to_string()).collect::<Vec<_>>(),
        }));
    }
    let user_public_key = user.public_key.clone();

    Ok(Json(json!({
        "exported_at": chrono::Utc::now().to_rfc3339(),
        "user": {
            "id": user.id.to_string(),
            "username": user.username,
            "discriminator": user.discriminator,
            "email": user.email,
            "display_name": user.display_name,
            "avatar_hash": user.avatar_hash,
            "banner_hash": user.banner_hash,
            "bio": user.bio,
            "flags": user.flags,
            "created_at": user.created_at.to_rfc3339(),
            "public_key": user_public_key.clone(),
            "email_verified": user.email_verified,
        },
        "settings": settings.map(|s| json!({
            "theme": s.theme,
            "locale": s.locale,
            "message_display": s.message_display,
            "custom_css": s.custom_css,
            "crypto_auth_enabled": s.crypto_auth_enabled,
            "notifications": s.notifications,
            "keybinds": s.keybinds,
            "updated_at": s.updated_at.to_rfc3339(),
        })),
        "guilds": guilds.into_iter().map(|g| json!({
            "id": g.id.to_string(),
            "name": g.name,
            "description": g.description,
            "icon_hash": g.icon_hash,
            "owner_id": g.owner_id.to_string(),
            "created_at": g.created_at.to_rfc3339(),
        })).collect::<Vec<Value>>(),
        "guild_memberships": memberships,
        "dms": dms.into_iter().map(|dm| json!({
            "channel_id": dm.id.to_string(),
            "recipient_id": dm.recipient_id.to_string(),
            "recipient_username": dm.recipient_username,
            "recipient_discriminator": dm.recipient_discriminator,
            "last_message_id": dm.last_message_id.map(|id| id.to_string()),
        })).collect::<Vec<Value>>(),
        "relationships": relationships.into_iter().map(|rel| json!({
            "target_id": rel.target_id.to_string(),
            "type": rel.rel_type,
            "created_at": rel.created_at.to_rfc3339(),
            "target_username": rel.target_username,
            "target_discriminator": rel.target_discriminator,
        })).collect::<Vec<Value>>(),
        "read_states": read_states.into_iter().map(|row| json!({
            "channel_id": row.channel_id.to_string(),
            "last_message_id": row.last_message_id.to_string(),
            "mention_count": row.mention_count,
        })).collect::<Vec<Value>>(),
        "sessions": sessions.into_iter().map(|session| json!({
            "id": session.id,
            "device_id": session.device_id,
            "user_agent": session.user_agent,
            "ip_address": session.ip_address,
            "issued_at": session.issued_at.to_rfc3339(),
            "last_seen_at": session.last_seen_at.to_rfc3339(),
            "expires_at": session.expires_at.to_rfc3339(),
        })).collect::<Vec<Value>>(),
        "messages": messages.into_iter().map(|msg| json!({
            "id": msg.id.to_string(),
            "channel_id": msg.channel_id.to_string(),
            "author_id": msg.author_id.to_string(),
            "content": msg.content,
            "type": msg.message_type,
            "flags": msg.flags,
            "reference_id": msg.reference_id.map(|id| id.to_string()),
            "pinned": msg.pinned,
            "e2ee_header": msg.e2ee_header,
            "created_at": msg.created_at.to_rfc3339(),
            "edited_at": msg.edited_at.map(|dt| dt.to_rfc3339()),
        })).collect::<Vec<Value>>(),
        "attachments": attachments.into_iter().map(|attachment| json!({
            "id": attachment.id.to_string(),
            "message_id": attachment.message_id.map(|id| id.to_string()),
            "filename": attachment.filename,
            "content_type": attachment.content_type,
            "size": attachment.size,
            "url": attachment.url,
            "width": attachment.width,
            "height": attachment.height,
            "content_hash": attachment.content_hash,
            "uploaded_at": attachment.upload_created_at.to_rfc3339(),
        })).collect::<Vec<Value>>(),
        "encryption_keys": {
            "public_key": user_public_key,
            "signed_prekey": signed_prekey.map(|row| json!({
                "id": row.id.to_string(),
                "public_key": row.public_key,
                "signature": row.signature,
                "created_at": row.created_at,
            })),
            "one_time_prekeys": one_time_prekeys.into_iter().map(|row| json!({
                "id": row.id.to_string(),
                "public_key": row.public_key,
                "created_at": row.created_at,
            })).collect::<Vec<Value>>(),
        },
    })))
}

pub async fn get_user_profile(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(user_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let user = paracord_db::users::get_user_by_id(&state.db, user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    // If the target has blocked the caller, do not leak profile extras
    // (bio, pronouns, linked accounts, roles, mutual guilds/friends). Return a
    // minimal identity card only.
    if user_id != auth.user_id {
        let target_block =
            paracord_db::relationships::get_relationship(&state.db, user_id, auth.user_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        if target_block.map(|r| r.rel_type) == Some(2) {
            return Ok(Json(json!({
                "user": {
                    "id": user.id.to_string(),
                    "username": user.username,
                    "discriminator": user.discriminator,
                    "display_name": user.display_name,
                    "avatar_hash": user.avatar_hash,
                    "banner_hash": null,
                    "bio": null,
                    "flags": user.flags,
                    "bot": paracord_core::is_bot(user.flags),
                    "system": false,
                    "pronouns": null,
                    "linked_accounts": [],
                    "created_at": user.created_at.to_rfc3339(),
                },
                "roles": [],
                "mutual_guilds": [],
                "mutual_friends": [],
                "created_at": user.created_at.to_rfc3339(),
            })));
        }
    }

    let target_settings = paracord_db::users::get_user_settings(&state.db, user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let (pronouns, linked_accounts) = profile_extras_from_settings(target_settings.as_ref());

    let mutual_guilds = paracord_db::users::get_mutual_guilds(&state.db, auth.user_id, user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let mutual_friends = paracord_db::users::get_mutual_friends(&state.db, auth.user_id, user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // Get roles from the first mutual guild (if any) for context
    let roles: Vec<Value> = if let Some(first_guild) = mutual_guilds.first() {
        let role_rows = paracord_db::roles::get_member_roles(&state.db, user_id, first_guild.id)
            .await
            .unwrap_or_default();
        role_rows
            .iter()
            .map(|r| {
                json!({
                    "id": r.id.to_string(),
                    "guild_id": r.space_id.to_string(),
                    "name": r.name,
                    "color": r.color,
                    "hoist": r.hoist,
                    "position": r.position,
                    "permissions": r.permissions.to_string(),
                    "mentionable": r.mentionable,
                    "created_at": r.created_at.to_rfc3339(),
                })
            })
            .collect()
    } else {
        vec![]
    };

    Ok(Json(json!({
        "user": {
            "id": user.id.to_string(),
            "username": user.username,
            "discriminator": user.discriminator,
            "display_name": user.display_name,
            "avatar_hash": user.avatar_hash,
            "banner_hash": user.banner_hash,
            "bio": user.bio,
            "flags": user.flags,
            "bot": paracord_core::is_bot(user.flags),
            "system": false,
            "pronouns": pronouns,
            "linked_accounts": linked_accounts,
            "created_at": user.created_at.to_rfc3339(),
        },
        "roles": roles,
        "mutual_guilds": mutual_guilds.iter().map(|g| json!({
            "id": g.id.to_string(),
            "name": g.name,
            "icon_url": g.icon_hash,
        })).collect::<Vec<Value>>(),
        "mutual_friends": mutual_friends.iter().map(|f| json!({
            "id": f.id.to_string(),
            "username": f.username,
            "discriminator": f.discriminator,
            "avatar_hash": f.avatar_hash,
        })).collect::<Vec<Value>>(),
        "created_at": user.created_at.to_rfc3339(),
    })))
}

pub async fn delete_me(
    State(state): State<AppState>,
    auth: AuthUser,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let confirmation = headers
        .get("x-confirm-delete")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .unwrap_or_default();
    if confirmation != "DELETE" {
        return Err(ApiError::BadRequest(
            "Missing confirmation header x-confirm-delete: DELETE".into(),
        ));
    }

    let now = chrono::Utc::now();
    let _ = paracord_db::sessions::revoke_all_user_sessions_except(
        &state.db,
        auth.user_id,
        auth.session_id.as_deref(),
        "account_deleted",
        now,
    )
    .await;

    paracord_core::admin::admin_delete_user(&state.db, auth.user_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

pub async fn change_password(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: AuthUser,
    headers: HeaderMap,
    Json(body): Json<ChangePasswordRequest>,
) -> Result<StatusCode, ApiError> {
    let peer_ip = addr.ip().to_string();
    if body.current_password == body.new_password {
        return Err(ApiError::BadRequest(
            "new_password must differ from current_password".into(),
        ));
    }
    paracord_util::validation::validate_password(&body.new_password).map_err(|_| {
        ApiError::BadRequest("Password must be between 10 and 128 characters".into())
    })?;

    let user = paracord_db::users::get_user_auth_by_id(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if user.password_hash.trim().is_empty() {
        return Err(ApiError::Forbidden);
    }

    let valid = paracord_core::auth::verify_password(&body.current_password, &user.password_hash)
        .unwrap_or(false);
    if !valid {
        return Err(ApiError::Unauthorized);
    }

    let new_hash = paracord_core::auth::hash_password(&body.new_password)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    paracord_db::users::update_user_password_hash(&state.db, auth.user_id, &new_hash)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let now = chrono::Utc::now();
    let _ = paracord_db::sessions::revoke_all_user_sessions_except(
        &state.db,
        auth.user_id,
        auth.session_id.as_deref(),
        "password_changed",
        now,
    )
    .await;

    security::log_security_event(
        &state,
        "auth.password.change",
        Some(auth.user_id),
        Some(auth.user_id),
        auth.session_id.as_deref(),
        Some(&headers),
        Some(peer_ip.as_str()),
        Some(json!({ "revoked_other_sessions": true })),
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ChangeEmailRequest {
    pub current_password: String,
    pub new_email: String,
}

pub async fn change_email(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: AuthUser,
    headers: HeaderMap,
    Json(body): Json<ChangeEmailRequest>,
) -> Result<StatusCode, ApiError> {
    let peer_ip = addr.ip().to_string();
    let normalized_email = body.new_email.trim().to_ascii_lowercase();
    paracord_util::validation::validate_email(&normalized_email)
        .map_err(|_| ApiError::BadRequest("Invalid email address".into()))?;

    let user = paracord_db::users::get_user_auth_by_id(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if user.password_hash.trim().is_empty() {
        return Err(ApiError::Forbidden);
    }

    let valid = paracord_core::auth::verify_password(&body.current_password, &user.password_hash)
        .unwrap_or(false);
    if !valid {
        return Err(ApiError::Unauthorized);
    }

    if user.email.eq_ignore_ascii_case(&normalized_email) {
        return Ok(StatusCode::NO_CONTENT);
    }

    if let Some(existing) = paracord_db::users::get_user_by_email(&state.db, &normalized_email)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    {
        if existing.id != auth.user_id {
            return Err(ApiError::Conflict("Unable to update email".into()));
        }
    }

    // Changing the email invalidates any prior verification: the new address has
    // not been proven to belong to this account, so email_verified is reset.
    let updated = paracord_db::users::update_user_email_unverified(
        &state.db,
        auth.user_id,
        &normalized_email,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // Invalidate any outstanding verification tokens issued for the old address,
    // then kick off a fresh verification email when the server requires it.
    let _ = paracord_db::users::delete_email_verification_tokens_for_user(&state.db, auth.user_id)
        .await;
    if state.config.require_email_verification {
        crate::routes::auth::dispatch_email_verification(
            &state,
            auth.user_id,
            &updated.username,
            &normalized_email,
            &headers,
            None,
        )
        .await;
    }

    let now = chrono::Utc::now();
    let _ = paracord_db::sessions::revoke_all_user_sessions_except(
        &state.db,
        auth.user_id,
        auth.session_id.as_deref(),
        "email_changed",
        now,
    )
    .await;

    security::log_security_event(
        &state,
        "auth.email.change",
        Some(auth.user_id),
        Some(auth.user_id),
        auth.session_id.as_deref(),
        Some(&headers),
        Some(peer_ip.as_str()),
        Some(json!({ "revoked_other_sessions": true })),
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

// ── Identity Portability ───────────────────────────────────────────────────

fn parse_signing_key() -> Option<ed25519_dalek::SigningKey> {
    let raw = std::env::var("PARACORD_FEDERATION_SIGNING_KEY_HEX").ok()?;
    paracord_federation::signing::signing_key_from_hex(&raw).ok()
}

fn get_server_name() -> String {
    std::env::var("PARACORD_SERVER_NAME").unwrap_or_else(|_| "localhost".to_string())
}

#[derive(Deserialize)]
pub struct ExportIdentityQuery {
    pub include_messages: Option<bool>,
}

pub async fn export_identity(
    State(state): State<AppState>,
    auth: AuthUser,
    Query(query): Query<ExportIdentityQuery>,
) -> Result<Json<Value>, ApiError> {
    let signing_key = parse_signing_key().ok_or_else(|| {
        ApiError::ServiceUnavailable(
            "identity export requires federation signing key to be configured".to_string(),
        )
    })?;
    let server_name = get_server_name();
    let include_messages = query.include_messages.unwrap_or(false);

    let bundle = paracord_core::identity::export_identity(
        &state.db,
        auth.user_id,
        include_messages,
        &server_name,
        &signing_key,
    )
    .await?;

    let json_value =
        serde_json::to_value(&bundle).map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;
    Ok(Json(json_value))
}

pub async fn import_identity(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(bundle): Json<paracord_core::identity::IdentityBundle>,
) -> Result<Json<Value>, ApiError> {
    // Look up the origin server's public key to verify the bundle signature.
    // First check known federation server keys, then fall back to the local server key.
    let server_name = get_server_name();
    let public_key_hex = if bundle.origin_server == server_name {
        // Bundle is from this server - use our own public key
        parse_signing_key()
            .map(|k| paracord_federation::hex_encode(&k.verifying_key().to_bytes()))
            .ok_or_else(|| {
                ApiError::ServiceUnavailable(
                    "identity import requires federation signing key to be configured".to_string(),
                )
            })?
    } else {
        // Bundle is from another server - look up their public key
        let fed_enabled = std::env::var("PARACORD_FEDERATION_ENABLED")
            .ok()
            .and_then(|v| v.parse::<bool>().ok())
            .unwrap_or(false);
        if !fed_enabled {
            return Err(ApiError::BadRequest(
                "cannot verify bundle from remote server: federation is disabled".to_string(),
            ));
        }
        let server =
            paracord_db::federation::get_federated_server(&state.db, &bundle.origin_server)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                .ok_or_else(|| {
                    ApiError::BadRequest(format!(
                        "no known federated server '{}'",
                        bundle.origin_server
                    ))
                })?;
        server.public_key_hex.ok_or_else(|| {
            ApiError::BadRequest(format!(
                "no known public key for origin server '{}'",
                bundle.origin_server
            ))
        })?
    };

    // Verify the bundle signature
    paracord_core::identity::verify_identity_bundle(&bundle, &public_key_hex)?;

    // Bind the bundle's subject to the authenticated importer. The signature only
    // proves origin; without this an account could import another account's
    // same-server bundle (settings/prekeys) into its own record. Enforced here at
    // the API boundary (before any writes) and again inside import_identity.
    paracord_core::identity::verify_subject_binding(&state.db, &bundle, auth.user_id).await?;

    // Import the bundle
    let result = paracord_core::identity::import_identity(&state.db, &bundle, auth.user_id).await?;

    let json_value =
        serde_json::to_value(&result).map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;
    Ok(Json(json_value))
}
