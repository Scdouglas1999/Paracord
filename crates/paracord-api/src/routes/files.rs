use axum::{
    extract::{Multipart, Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    Json,
};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;

pub async fn upload_file(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path(channel_id): Path<i64>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    // F9: Early rejection if Content-Length exceeds max upload size
    if let Some(content_length) = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
    {
        if content_length > state.config.max_upload_size {
            return Err(ApiError::BadRequest("File too large".into()));
        }
    }
    // Verify channel exists and caller can send attachments.
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if let Some(guild_id) = channel.guild_id() {
        paracord_core::permissions::ensure_guild_member(&state.db, guild_id, _auth.user_id).await?;
        let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::NotFound)?;
        let perms = paracord_core::permissions::compute_channel_permissions(
            &state.db,
            guild_id,
            channel_id,
            guild.owner_id,
            _auth.user_id,
        )
        .await?;
        paracord_core::permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;
        paracord_core::permissions::require_permission(perms, Permissions::ATTACH_FILES)?;
    } else if !paracord_db::dms::is_dm_recipient(&state.db, channel_id, _auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    {
        return Err(ApiError::Forbidden("forbidden".into()));
    }

    let field = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?
        .ok_or_else(|| ApiError::BadRequest("No file provided".into()))?;

    let raw_filename = field
        .file_name()
        .unwrap_or("upload")
        .to_string();
    let filename = paracord_util::filename::sanitize_filename(&raw_filename);
    let content_type = field
        .content_type()
        .map(|s| s.to_string());
    let data = field
        .bytes()
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    if data.is_empty() {
        return Err(ApiError::BadRequest("Empty file".into()));
    }

    // F9: Check against config limit before casting
    if data.len() as u64 > state.config.max_upload_size {
        return Err(ApiError::BadRequest("File too large".into()));
    }

    // F9: Safe conversion — no silent overflow for files > 2GB
    let size: i32 = data
        .len()
        .try_into()
        .map_err(|_| ApiError::BadRequest("File too large".into()))?;

    // Store file to disk
    let attachment_id = paracord_util::snowflake::generate(1);
    let ext = std::path::Path::new(&filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let stored_name = format!("{}.{}", attachment_id, ext);
    let storage_dir = std::path::Path::new(&state.config.storage_path).join("attachments");

    tokio::fs::create_dir_all(&storage_dir)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let file_path = storage_dir.join(&stored_name);
    tokio::fs::write(&file_path, &data)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let url = format!("/api/v1/attachments/{}", attachment_id);

    let attachment = paracord_db::attachments::create_attachment(
        &state.db,
        attachment_id,
        None, // pending attachment; linked during message creation
        &filename,
        content_type.as_deref(),
        size,
        &url,
        None,
        None,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": attachment.id.to_string(),
            "filename": attachment.filename,
            "size": attachment.size,
            "content_type": attachment.content_type,
            "url": attachment.url,
        })),
    ))
}

pub async fn download_file(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    let attachment = paracord_db::attachments::get_attachment(&state.db, id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let message_id = attachment.message_id.ok_or(ApiError::NotFound)?;
    let message = paracord_db::messages::get_message(&state.db, message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let channel = paracord_db::channels::get_channel(&state.db, message.channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if let Some(guild_id) = channel.guild_id() {
        paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
        let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::NotFound)?;
        let perms = paracord_core::permissions::compute_channel_permissions(
            &state.db,
            guild_id,
            channel.id,
            guild.owner_id,
            auth.user_id,
        )
        .await?;
        paracord_core::permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;
        paracord_core::permissions::require_permission(perms, Permissions::READ_MESSAGE_HISTORY)?;
    } else if !paracord_db::dms::is_dm_recipient(&state.db, channel.id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    {
        return Err(ApiError::Forbidden("forbidden".into()));
    }

    let ext = std::path::Path::new(&attachment.filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let file_path = std::path::Path::new(&state.config.storage_path)
        .join("attachments")
        .join(format!("{}.{}", attachment.id, ext));
    let data = tokio::fs::read(file_path)
        .await
        .map_err(|_| ApiError::NotFound)?;
    let content_type = attachment
        .content_type
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_string());

    let safe_filename = paracord_util::filename::sanitize_filename(&attachment.filename);
    let disposition = format!("inline; filename=\"{}\"", safe_filename);
    Ok((
        [
            (header::CONTENT_TYPE, HeaderValue::from_str(&content_type).unwrap_or(HeaderValue::from_static("application/octet-stream"))),
            (header::CONTENT_DISPOSITION, HeaderValue::from_str(&disposition).unwrap_or(HeaderValue::from_static("inline"))),
        ],
        data,
    ))
}

pub async fn delete_file(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let attachment = paracord_db::attachments::get_attachment(&state.db, id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if let Some(message_id) = attachment.message_id {
        // F8: Check author OR MANAGE_MESSAGES permission
        let message = paracord_db::messages::get_message(&state.db, message_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::NotFound)?;
        if message.author_id != _auth.user_id {
            // Not the author — check for MANAGE_MESSAGES on the channel
            let channel = paracord_db::channels::get_channel(&state.db, message.channel_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                .ok_or(ApiError::NotFound)?;
            if let Some(guild_id) = channel.guild_id() {
                let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
                    .await
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                    .ok_or(ApiError::NotFound)?;
                let perms = paracord_core::permissions::compute_channel_permissions(
                    &state.db,
                    guild_id,
                    channel.id,
                    guild.owner_id,
                    _auth.user_id,
                )
                .await?;
                paracord_core::permissions::require_permission(perms, Permissions::MANAGE_MESSAGES)?;
            } else {
                // DM — only the message author can delete their attachments
                return Err(ApiError::Forbidden("forbidden".into()));
            }
        }
    } else {
        // F8: Unlinked attachment (message_id is NULL) — only allow deletion
        // if it was recently created (within 1 hour, based on snowflake timestamp)
        let created_ms = paracord_util::snowflake::timestamp_millis(attachment.id);
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time went backwards")
            .as_millis() as u64;
        let one_hour_ms: u64 = 3_600_000;
        if now_ms.saturating_sub(created_ms) > one_hour_ms {
            // Stale unlinked attachment — deny unless admin
            return Err(ApiError::Forbidden("forbidden".into()));
        }
    }

    paracord_db::attachments::delete_attachment(&state.db, id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let ext = std::path::Path::new(&attachment.filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let file_path = std::path::Path::new(&state.config.storage_path)
        .join("attachments")
        .join(format!("{}.{}", attachment.id, ext));
    let _ = tokio::fs::remove_file(file_path).await;

    Ok(StatusCode::NO_CONTENT)
}
