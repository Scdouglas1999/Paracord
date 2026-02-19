use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use paracord_core::AppState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio_util::io::ReaderStream;

use crate::error::ApiError;
use crate::middleware::AdminUser;
use crate::routes::security;

// ── Restart & Update ─────────────────────────────────────────────────

pub async fn restart_update(
    State(state): State<AppState>,
    admin: AdminUser,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    // This endpoint intentionally does not execute shell scripts or build steps.
    // Update automation must be performed out-of-process using signed release artifacts.
    security::log_security_event(
        &state,
        "admin.remote_update.denied",
        Some(admin.user_id),
        None,
        None,
        Some(&headers),
        Some(json!({ "reason": "endpoint_disabled_for_security" })),
    )
    .await;
    Err(ApiError::Forbidden)
}

// ── Stats ───────────────────────────────────────────────────────────────

pub async fn get_stats(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> Result<Json<Value>, ApiError> {
    let stats = paracord_core::admin::get_server_stats(&state.db).await?;
    Ok(Json(json!({
        "total_users": stats.total_users,
        "total_guilds": stats.total_guilds,
        "total_messages": stats.total_messages,
        "total_channels": stats.total_channels,
    })))
}

#[derive(Deserialize)]
pub struct SecurityEventsQuery {
    pub before: Option<i64>,
    pub limit: Option<i64>,
    pub action: Option<String>,
}

pub async fn list_security_events(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(params): Query<SecurityEventsQuery>,
) -> Result<Json<Value>, ApiError> {
    let limit = params.limit.unwrap_or(100).clamp(1, 500);
    let rows = paracord_db::security_events::list_events(
        &state.db,
        params.action.as_deref(),
        params.before,
        limit,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let payload: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            json!({
                "id": row.id.to_string(),
                "actor_user_id": row.actor_user_id.map(|id| id.to_string()),
                "action": row.action,
                "target_user_id": row.target_user_id.map(|id| id.to_string()),
                "session_id": row.session_id,
                "device_id": row.device_id,
                "user_agent": row.user_agent,
                "ip_address": row.ip_address,
                "details": row.details,
                "created_at": row.created_at.to_rfc3339(),
            })
        })
        .collect();

    Ok(Json(json!(payload)))
}

// ── Settings ────────────────────────────────────────────────────────────

pub async fn get_settings(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> Result<Json<Value>, ApiError> {
    let settings = state.runtime.read().await;
    Ok(Json(json!({
        "registration_enabled": settings.registration_enabled.to_string(),
        "server_name": settings.server_name,
        "server_description": settings.server_description,
        "max_guilds_per_user": settings.max_guilds_per_user.to_string(),
        "max_members_per_guild": settings.max_members_per_guild.to_string(),
    })))
}

const ALLOWED_SETTINGS: &[&str] = &[
    "registration_enabled",
    "server_name",
    "server_description",
    "max_guilds_per_user",
    "max_members_per_guild",
];

const MAX_STRING_SETTING_LEN: usize = 256;

fn validate_setting(key: &str, value: &str) -> Result<(), String> {
    match key {
        "registration_enabled" => {
            if value != "true" && value != "false" {
                return Err(format!("{key}: must be \"true\" or \"false\""));
            }
        }
        "server_name" => {
            let trimmed = value.trim();
            if trimmed.is_empty() || trimmed.len() > MAX_STRING_SETTING_LEN {
                return Err(format!(
                    "{key}: must be 1-{MAX_STRING_SETTING_LEN} characters"
                ));
            }
        }
        "server_description" => {
            if value.len() > MAX_STRING_SETTING_LEN {
                return Err(format!(
                    "{key}: must be at most {MAX_STRING_SETTING_LEN} characters"
                ));
            }
        }
        "max_guilds_per_user" | "max_members_per_guild" => {
            let n: u32 = value
                .parse()
                .map_err(|_| format!("{key}: must be a positive integer"))?;
            if n == 0 || n > 100_000 {
                return Err(format!("{key}: must be between 1 and 100000"));
            }
        }
        _ => {}
    }
    Ok(())
}

pub async fn update_settings(
    State(state): State<AppState>,
    admin: AdminUser,
    headers: HeaderMap,
    Json(body): Json<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    for key in body.keys() {
        if !ALLOWED_SETTINGS.contains(&key.as_str()) {
            return Err(ApiError::BadRequest(format!("unknown setting: \"{key}\"")));
        }
    }

    for (key, value) in &body {
        validate_setting(key, value).map_err(ApiError::BadRequest)?;
    }

    let sanitized: HashMap<String, String> = body
        .into_iter()
        .map(|(key, value)| {
            let value = match key.as_str() {
                "server_name" | "server_description" => value.trim().to_string(),
                _ => value,
            };
            (key, value)
        })
        .collect();

    // Write each setting to DB
    for (key, value) in &sanitized {
        paracord_db::server_settings::set_setting(&state.db, key, value)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    }

    // Update in-memory runtime settings
    let mut settings = state.runtime.write().await;
    for (key, value) in &sanitized {
        match key.as_str() {
            "registration_enabled" => {
                settings.registration_enabled = value == "true";
            }
            "server_name" => {
                settings.server_name = value.clone();
            }
            "server_description" => {
                settings.server_description = value.clone();
            }
            "max_guilds_per_user" => {
                if let Ok(v) = value.parse() {
                    settings.max_guilds_per_user = v;
                }
            }
            "max_members_per_guild" => {
                if let Ok(v) = value.parse() {
                    settings.max_members_per_guild = v;
                }
            }
            _ => {}
        }
    }

    let changed_keys: Vec<&str> = sanitized.keys().map(String::as_str).collect();
    security::log_security_event(
        &state,
        "admin.settings.update",
        Some(admin.user_id),
        None,
        None,
        Some(&headers),
        Some(json!({ "keys": changed_keys })),
    )
    .await;

    Ok(Json(json!({
        "registration_enabled": settings.registration_enabled.to_string(),
        "server_name": settings.server_name,
        "server_description": settings.server_description,
        "max_guilds_per_user": settings.max_guilds_per_user.to_string(),
        "max_members_per_guild": settings.max_members_per_guild.to_string(),
    })))
}

// ── Users ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct PaginationParams {
    pub offset: Option<i64>,
    pub limit: Option<i64>,
}

pub async fn list_users(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(params): Query<PaginationParams>,
) -> Result<Json<Value>, ApiError> {
    let offset = params.offset.unwrap_or(0);
    let limit = params.limit.unwrap_or(50).min(100);

    let users = paracord_db::users::list_users_paginated(&state.db, offset, limit)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let total = paracord_db::users::count_users(&state.db)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let user_list: Vec<Value> = users
        .into_iter()
        .map(|u| {
            json!({
                "id": u.id.to_string(),
                "username": u.username,
                "discriminator": u.discriminator,
                "email": u.email,
                "display_name": u.display_name,
                "avatar_hash": u.avatar_hash,
                "flags": u.flags,
                "created_at": u.created_at.to_rfc3339(),
            })
        })
        .collect();

    Ok(Json(json!({
        "users": user_list,
        "total": total,
        "offset": offset,
        "limit": limit,
    })))
}

#[derive(Deserialize)]
pub struct UpdateUserRequest {
    pub flags: Option<i32>,
}

pub async fn update_user(
    State(state): State<AppState>,
    admin: AdminUser,
    headers: HeaderMap,
    Path(user_id): Path<i64>,
    Json(body): Json<UpdateUserRequest>,
) -> Result<Json<Value>, ApiError> {
    if let Some(flags) = body.flags {
        // Prevent admin from removing their own admin flag
        if user_id == admin.user_id && !paracord_core::is_admin(flags) {
            return Err(ApiError::BadRequest(
                "Cannot remove your own admin status".into(),
            ));
        }

        let updated = paracord_db::users::update_user_flags(&state.db, user_id, flags)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

        security::log_security_event(
            &state,
            "admin.user.flags.update",
            Some(admin.user_id),
            Some(user_id),
            None,
            Some(&headers),
            Some(json!({ "flags": flags })),
        )
        .await;

        return Ok(Json(json!({
            "id": updated.id.to_string(),
            "username": updated.username,
            "discriminator": updated.discriminator,
            "email": updated.email,
            "display_name": updated.display_name,
            "avatar_hash": updated.avatar_hash,
            "flags": updated.flags,
            "created_at": updated.created_at.to_rfc3339(),
        })));
    }

    Err(ApiError::BadRequest("No updates provided".into()))
}

pub async fn delete_user(
    State(state): State<AppState>,
    admin: AdminUser,
    headers: HeaderMap,
    Path(user_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    if user_id == admin.user_id {
        return Err(ApiError::BadRequest("Cannot delete yourself".into()));
    }

    paracord_core::admin::admin_delete_user(&state.db, user_id).await?;
    security::log_security_event(
        &state,
        "admin.user.delete",
        Some(admin.user_id),
        Some(user_id),
        None,
        Some(&headers),
        None,
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

// ── Guilds ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct UpdateGuildRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
}

pub async fn list_guilds(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> Result<Json<Value>, ApiError> {
    let guilds = paracord_db::guilds::list_all_guilds(&state.db)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let guild_list: Vec<Value> = guilds
        .into_iter()
        .map(|g| {
            json!({
                "id": g.id.to_string(),
                "name": g.name,
                "description": g.description,
                "icon_hash": g.icon_hash,
                "owner_id": g.owner_id.to_string(),
                "created_at": g.created_at.to_rfc3339(),
            })
        })
        .collect();

    Ok(Json(json!({ "guilds": guild_list })))
}

pub async fn update_guild(
    State(state): State<AppState>,
    admin: AdminUser,
    headers: HeaderMap,
    Path(guild_id): Path<i64>,
    Json(body): Json<UpdateGuildRequest>,
) -> Result<Json<Value>, ApiError> {
    let updated = paracord_core::admin::admin_update_guild(
        &state.db,
        guild_id,
        body.name.as_deref(),
        body.description.as_deref(),
        body.icon.as_deref(),
    )
    .await?;

    let guild_json = json!({
        "id": updated.id.to_string(),
        "name": updated.name,
        "description": updated.description,
        "icon_hash": updated.icon_hash,
        "owner_id": updated.owner_id.to_string(),
        "created_at": updated.created_at.to_rfc3339(),
    });

    state
        .event_bus
        .dispatch("GUILD_UPDATE", guild_json.clone(), Some(guild_id));

    security::log_security_event(
        &state,
        "admin.guild.update",
        Some(admin.user_id),
        None,
        None,
        Some(&headers),
        Some(json!({ "guild_id": guild_id.to_string() })),
    )
    .await;

    Ok(Json(guild_json))
}

pub async fn delete_guild(
    State(state): State<AppState>,
    admin: AdminUser,
    headers: HeaderMap,
    Path(guild_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    paracord_core::admin::admin_delete_guild(&state.db, guild_id).await?;

    state.member_index.remove_guild(guild_id);
    state.event_bus.dispatch(
        "GUILD_DELETE",
        json!({"id": guild_id.to_string()}),
        Some(guild_id),
    );

    security::log_security_event(
        &state,
        "admin.guild.delete",
        Some(admin.user_id),
        None,
        None,
        Some(&headers),
        Some(json!({ "guild_id": guild_id.to_string() })),
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

// ── Backups ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateBackupRequest {
    pub include_media: Option<bool>,
}

pub async fn create_backup(
    State(state): State<AppState>,
    admin: AdminUser,
    headers: HeaderMap,
    Json(body): Json<Option<CreateBackupRequest>>,
) -> Result<Json<Value>, ApiError> {
    let include_media = body.and_then(|b| b.include_media).unwrap_or(true);

    let filename = paracord_core::backup::create_backup(
        &state.config.database_url,
        &state.config.backup_dir,
        &state.config.storage_path,
        &state.config.media_storage_path,
        include_media,
    )
    .await?;

    security::log_security_event(
        &state,
        "admin.backup.create",
        Some(admin.user_id),
        None,
        None,
        Some(&headers),
        Some(json!({ "filename": &filename, "include_media": include_media })),
    )
    .await;

    Ok(Json(json!({ "filename": filename })))
}

pub async fn list_backups(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> Result<Json<Value>, ApiError> {
    let backups = paracord_core::backup::list_backups(&state.config.backup_dir).await?;

    let list: Vec<Value> = backups
        .into_iter()
        .map(|b| {
            json!({
                "name": b.name,
                "size_bytes": b.size_bytes,
                "created_at": b.created_at,
            })
        })
        .collect();

    Ok(Json(json!({ "backups": list })))
}

#[derive(Deserialize)]
pub struct RestoreBackupRequest {
    pub name: String,
}

pub async fn restore_backup(
    State(state): State<AppState>,
    admin: AdminUser,
    headers: HeaderMap,
    Json(body): Json<RestoreBackupRequest>,
) -> Result<Json<Value>, ApiError> {
    // Validate the name to prevent path traversal
    if body.name.contains("..") || body.name.contains('/') || body.name.contains('\\') {
        return Err(ApiError::BadRequest("Invalid backup name".into()));
    }

    paracord_core::backup::restore_backup(
        &body.name,
        &state.config.backup_dir,
        &state.config.database_url,
        &state.config.storage_path,
        &state.config.media_storage_path,
    )
    .await?;

    security::log_security_event(
        &state,
        "admin.backup.restore",
        Some(admin.user_id),
        None,
        None,
        Some(&headers),
        Some(json!({ "filename": &body.name })),
    )
    .await;

    Ok(Json(json!({
        "message": "Backup restored. Server restart recommended.",
        "filename": body.name,
    })))
}

pub async fn download_backup(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(name): Path<String>,
) -> Result<axum::response::Response<Body>, ApiError> {
    // Validate the name to prevent path traversal
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err(ApiError::BadRequest("Invalid backup name".into()));
    }
    if !name.ends_with(".tar.gz") {
        return Err(ApiError::BadRequest("Invalid backup filename".into()));
    }

    let path = paracord_core::backup::backup_file_path(&state.config.backup_dir, &name);
    if !path.exists() {
        return Err(ApiError::NotFound);
    }

    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("Failed to open backup: {e}")))?;
    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    Ok(axum::response::Response::builder()
        .header("content-type", "application/gzip")
        .header(
            "content-disposition",
            format!("attachment; filename=\"{name}\""),
        )
        .body(body)
        .unwrap())
}

pub async fn delete_backup(
    State(state): State<AppState>,
    admin: AdminUser,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<StatusCode, ApiError> {
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err(ApiError::BadRequest("Invalid backup name".into()));
    }
    if !name.ends_with(".tar.gz") {
        return Err(ApiError::BadRequest("Invalid backup filename".into()));
    }

    let path = paracord_core::backup::backup_file_path(&state.config.backup_dir, &name);
    if !path.exists() {
        return Err(ApiError::NotFound);
    }

    tokio::fs::remove_file(&path)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("Failed to delete backup: {e}")))?;

    security::log_security_event(
        &state,
        "admin.backup.delete",
        Some(admin.user_id),
        None,
        None,
        Some(&headers),
        Some(json!({ "filename": &name })),
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::validate_setting;

    #[test]
    fn validate_setting_rejects_unknown_bool_value() {
        assert!(validate_setting("registration_enabled", "maybe").is_err());
    }

    #[test]
    fn validate_setting_rejects_zero_limits() {
        assert!(validate_setting("max_members_per_guild", "0").is_err());
    }

    #[test]
    fn validate_setting_accepts_valid_numeric_limits() {
        assert!(validate_setting("max_guilds_per_user", "100").is_ok());
    }
}
