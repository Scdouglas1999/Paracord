use axum::{
    extract::{Multipart, Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;

const MAX_STICKER_NAME_LEN: usize = 64;
const MAX_STICKER_DESCRIPTION_LEN: usize = 200;
const MAX_STICKER_IMAGE_SIZE: usize = 1024 * 1024; // 1MB

fn sticker_to_json(sticker: &paracord_db::stickers::StickerRow) -> Value {
    json!({
        "id": sticker.id.to_string(),
        "guild_id": sticker.guild_id.to_string(),
        "name": sticker.name,
        "description": sticker.description,
        "format_type": sticker.format_type,
        "creator_id": sticker.creator_id.map(|id| id.to_string()),
        "image_url": sticker.asset_key.as_ref().map(|_| format!("/api/v1/guilds/{}/stickers/{}/image", sticker.guild_id, sticker.id)),
        "created_at": sticker.created_at.to_rfc3339(),
    })
}

async fn ensure_manage_stickers(
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
    paracord_core::permissions::require_permission(perms, Permissions::MANAGE_EMOJIS)?;
    Ok(())
}

pub async fn list_guild_stickers(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
    let stickers = paracord_db::stickers::list_stickers(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!(stickers
        .iter()
        .map(sticker_to_json)
        .collect::<Vec<_>>())))
}

pub async fn create_sticker(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    ensure_manage_stickers(&state, guild_id, auth.user_id).await?;

    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut image_data: Option<Vec<u8>> = None;
    let mut content_type: Option<String> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?
    {
        match field.name().unwrap_or("").trim() {
            "name" => {
                name = Some(
                    field
                        .text()
                        .await
                        .map_err(|e| ApiError::BadRequest(e.to_string()))?,
                );
            }
            "description" => {
                description = Some(
                    field
                        .text()
                        .await
                        .map_err(|e| ApiError::BadRequest(e.to_string()))?,
                );
            }
            "image" | "file" => {
                content_type = field.content_type().map(str::to_string);
                image_data = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|e| ApiError::BadRequest(e.to_string()))?
                        .to_vec(),
                );
            }
            _ => {}
        }
    }

    let name = name
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::BadRequest("Missing sticker name".into()))?;
    if name.len() > MAX_STICKER_NAME_LEN {
        return Err(ApiError::BadRequest(
            "Sticker name must be 1-64 characters".into(),
        ));
    }

    let description = description
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    if description
        .as_deref()
        .is_some_and(|v| v.len() > MAX_STICKER_DESCRIPTION_LEN)
    {
        return Err(ApiError::BadRequest(
            "Sticker description must be <= 200 characters".into(),
        ));
    }

    let image_data =
        image_data.ok_or_else(|| ApiError::BadRequest("Missing sticker image".into()))?;
    if image_data.is_empty() || image_data.len() > MAX_STICKER_IMAGE_SIZE {
        return Err(ApiError::BadRequest(
            "Sticker image must be between 1 byte and 1 MB".into(),
        ));
    }

    let content_type = content_type.unwrap_or_else(|| "application/octet-stream".to_string());
    let (format_type, ext, valid_signature) = match content_type.as_str() {
        "image/png" => (
            1_i16,
            "png",
            image_data.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
        ),
        "image/webp" => (
            1_i16,
            "webp",
            image_data.starts_with(b"RIFF")
                && image_data.len() >= 12
                && &image_data[8..12] == b"WEBP",
        ),
        "image/gif" => (
            2_i16,
            "gif",
            image_data.starts_with(b"GIF87a") || image_data.starts_with(b"GIF89a"),
        ),
        _ => {
            return Err(ApiError::BadRequest(
                "Only PNG, WEBP, and GIF sticker uploads are supported".into(),
            ))
        }
    };
    if !valid_signature {
        return Err(ApiError::BadRequest(
            "Sticker file contents do not match the declared image type".into(),
        ));
    }

    let sticker_id = paracord_util::snowflake::generate(1);
    let asset_key = format!("stickers/{guild_id}/{sticker_id}.{ext}");
    state
        .storage_backend
        .store(&asset_key, &image_data)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let sticker = paracord_db::stickers::create_sticker(
        &state.db,
        sticker_id,
        guild_id,
        &name,
        description.as_deref(),
        format_type,
        Some(asset_key.as_str()),
        Some(content_type.as_str()),
        Some(auth.user_id),
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let payload = sticker_to_json(&sticker);
    state.event_bus.dispatch(
        "GUILD_STICKERS_UPDATE",
        json!({
            "guild_id": guild_id.to_string(),
            "sticker": payload,
        }),
        Some(guild_id),
    );

    Ok((StatusCode::CREATED, Json(payload)))
}

pub async fn delete_sticker(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, sticker_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    ensure_manage_stickers(&state, guild_id, auth.user_id).await?;
    let sticker = paracord_db::stickers::get_sticker(&state.db, sticker_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if sticker.guild_id != guild_id {
        return Err(ApiError::NotFound);
    }
    if let Some(asset_key) = sticker.asset_key.as_deref() {
        let _ = state.storage_backend.delete(asset_key).await;
    }
    paracord_db::stickers::delete_sticker(&state.db, sticker_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    state.event_bus.dispatch(
        "GUILD_STICKERS_UPDATE",
        json!({
            "guild_id": guild_id.to_string(),
            "deleted_sticker_id": sticker_id.to_string(),
        }),
        Some(guild_id),
    );
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_sticker_image(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, sticker_id)): Path<(i64, i64)>,
) -> Result<axum::response::Response, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
    let sticker = paracord_db::stickers::get_sticker(&state.db, sticker_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if sticker.guild_id != guild_id {
        return Err(ApiError::NotFound);
    }
    let asset_key = sticker.asset_key.ok_or(ApiError::NotFound)?;
    let data = state
        .storage_backend
        .retrieve(&asset_key)
        .await
        .map_err(|_| ApiError::NotFound)?;
    let content_type = sticker
        .asset_content_type
        .unwrap_or_else(|| "application/octet-stream".to_string());
    use axum::http::header;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                axum::http::HeaderValue::from_str(&content_type).unwrap_or_else(|_| {
                    axum::http::HeaderValue::from_static("application/octet-stream")
                }),
            ),
            (
                header::CACHE_CONTROL,
                axum::http::HeaderValue::from_static("public, max-age=31536000, immutable"),
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                axum::http::HeaderValue::from_static("nosniff"),
            ),
        ],
        data,
    )
        .into_response())
}
