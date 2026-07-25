use axum::{
    extract::{Multipart, Path, State},
    http::StatusCode,
    Json,
};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;
use crate::routes::audit;

const MAX_EMOJI_NAME_LEN: usize = 32;
const MAX_EMOJI_IMAGE_SIZE: usize = 256 * 1024; // 256 KB

fn emoji_to_json(e: &paracord_db::emojis::EmojiRow) -> Value {
    json!({
        "id": e.id.to_string(),
        "guild_id": e.guild_id.to_string(),
        "name": e.name,
        "animated": e.animated,
        "creator_id": e.creator_id.map(|id| id.to_string()),
        "created_at": e.created_at.to_rfc3339(),
    })
}

async fn ensure_emoji_permission(
    state: &AppState,
    guild_id: i64,
    user_id: i64,
) -> Result<(), ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, user_id).await?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    // MANAGE_EMOJIS is a guild-scoped gate. This used to call
    // `compute_channel_permissions` with the *guild* id in the channel slot;
    // no channel has id == guild_id, so the call always errored and the handler
    // silently fell through to `compute_permissions_from_roles`, which cannot
    // apply the bot install-permission cap -- an installed bot with
    // `permissions=0` still passed if any of its guild roles carried the bit.
    // `compute_guild_permissions` is the correct primitive and applies the cap.
    let perms = paracord_core::permissions::compute_guild_permissions(
        &state.db,
        guild_id,
        guild.owner_id,
        user_id,
    )
    .await?;
    paracord_core::permissions::require_permission(perms, Permissions::MANAGE_EMOJIS)?;
    Ok(())
}

pub async fn list_guild_emojis(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    let emojis = paracord_db::emojis::get_guild_emojis(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let result: Vec<Value> = emojis.iter().map(emoji_to_json).collect();
    Ok(Json(json!(result)))
}

pub async fn create_emoji(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    ensure_emoji_permission(&state, guild_id, auth.user_id).await?;

    let mut name: Option<String> = None;
    let mut image_data: Option<Vec<u8>> = None;
    let mut content_type: Option<String> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?
    {
        let field_name = field.name().unwrap_or("").to_string();
        match field_name.as_str() {
            "name" => {
                let text = field
                    .text()
                    .await
                    .map_err(|e| ApiError::BadRequest(e.to_string()))?;
                name = Some(text);
            }
            "image" | "file" => {
                content_type = field.content_type().map(|s| s.to_string());
                let data = field
                    .bytes()
                    .await
                    .map_err(|e| ApiError::BadRequest(e.to_string()))?;
                image_data = Some(data.to_vec());
            }
            _ => {}
        }
    }

    let name = name.ok_or_else(|| ApiError::BadRequest("Missing emoji name".into()))?;
    let image_data =
        image_data.ok_or_else(|| ApiError::BadRequest("Missing emoji image".into()))?;

    if name.is_empty() || name.len() > MAX_EMOJI_NAME_LEN {
        return Err(ApiError::BadRequest(
            "Emoji name must be between 1 and 32 characters".into(),
        ));
    }

    if image_data.is_empty() {
        return Err(ApiError::BadRequest("Empty emoji image".into()));
    }

    if image_data.len() > MAX_EMOJI_IMAGE_SIZE {
        return Err(ApiError::BadRequest(
            "Emoji image must be under 256 KB".into(),
        ));
    }

    let content_type =
        content_type.ok_or_else(|| ApiError::BadRequest("Missing emoji content type".into()))?;

    let (animated, ext) = match content_type.as_str() {
        "image/png" => (false, "png"),
        "image/gif" => (true, "gif"),
        _ => {
            return Err(ApiError::BadRequest(
                "Only PNG and GIF emoji uploads are supported".into(),
            ))
        }
    };

    let is_valid_signature = if animated {
        image_data.starts_with(b"GIF87a") || image_data.starts_with(b"GIF89a")
    } else {
        image_data.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A])
    };
    if !is_valid_signature {
        return Err(ApiError::BadRequest(
            "Emoji file contents do not match the declared image type".into(),
        ));
    }

    // Store emoji image to disk
    let emoji_id = paracord_util::snowflake::generate(1);
    let storage_dir = std::path::Path::new(&state.config.storage_path).join("emojis");
    tokio::fs::create_dir_all(&storage_dir)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let file_path = storage_dir.join(format!("{}.{}", emoji_id, ext));
    tokio::fs::write(&file_path, &image_data)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let emoji = paracord_db::emojis::create_emoji(
        &state.db,
        emoji_id,
        guild_id,
        &name,
        auth.user_id,
        animated,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let emoji_json = emoji_to_json(&emoji);

    state.event_bus.dispatch(
        "GUILD_EMOJIS_UPDATE",
        json!({
            "guild_id": guild_id.to_string(),
            "emoji": emoji_json,
        }),
        Some(guild_id),
    );
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_EMOJI_CREATE,
        Some(emoji.id),
        None,
        Some(json!({
            "name": emoji.name,
            "animated": emoji.animated,
        })),
    )
    .await;

    Ok((StatusCode::CREATED, Json(emoji_json)))
}

#[derive(Deserialize)]
pub struct UpdateEmojiRequest {
    pub name: String,
}

pub async fn update_emoji(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, emoji_id)): Path<(i64, i64)>,
    Json(body): Json<UpdateEmojiRequest>,
) -> Result<Json<Value>, ApiError> {
    ensure_emoji_permission(&state, guild_id, auth.user_id).await?;

    if body.name.is_empty() || body.name.len() > MAX_EMOJI_NAME_LEN {
        return Err(ApiError::BadRequest(
            "Emoji name must be between 1 and 32 characters".into(),
        ));
    }

    // Verify emoji belongs to guild
    let existing = paracord_db::emojis::get_emoji(&state.db, emoji_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if existing.guild_id != guild_id {
        return Err(ApiError::NotFound);
    }

    let updated = paracord_db::emojis::update_emoji(&state.db, emoji_id, &body.name)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let emoji_json = emoji_to_json(&updated);

    state.event_bus.dispatch(
        "GUILD_EMOJIS_UPDATE",
        json!({
            "guild_id": guild_id.to_string(),
            "emoji": emoji_json,
        }),
        Some(guild_id),
    );
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_EMOJI_UPDATE,
        Some(updated.id),
        None,
        Some(json!({
            "name": updated.name,
        })),
    )
    .await;

    Ok(Json(emoji_json))
}

pub async fn delete_emoji(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, emoji_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    ensure_emoji_permission(&state, guild_id, auth.user_id).await?;

    // Verify emoji belongs to guild
    let existing = paracord_db::emojis::get_emoji(&state.db, emoji_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if existing.guild_id != guild_id {
        return Err(ApiError::NotFound);
    }

    paracord_db::emojis::delete_emoji(&state.db, emoji_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // Clean up file
    let ext = if existing.animated { "gif" } else { "png" };
    let file_path = std::path::Path::new(&state.config.storage_path)
        .join("emojis")
        .join(format!("{}.{}", emoji_id, ext));
    let _ = tokio::fs::remove_file(file_path).await;

    state.event_bus.dispatch(
        "GUILD_EMOJIS_UPDATE",
        json!({
            "guild_id": guild_id.to_string(),
            "deleted_emoji_id": emoji_id.to_string(),
        }),
        Some(guild_id),
    );
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_EMOJI_DELETE,
        Some(emoji_id),
        None,
        Some(json!({
            "name": existing.name,
            "animated": existing.animated,
        })),
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_emoji_image(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, emoji_id)): Path<(i64, i64)>,
) -> Result<axum::response::Response, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    let emoji = paracord_db::emojis::get_emoji(&state.db, emoji_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if emoji.guild_id != guild_id {
        return Err(ApiError::NotFound);
    }

    let ext = if emoji.animated { "gif" } else { "png" };
    let file_path = std::path::Path::new(&state.config.storage_path)
        .join("emojis")
        .join(format!("{}.{}", emoji_id, ext));

    let data = tokio::fs::read(&file_path)
        .await
        .map_err(|_| ApiError::NotFound)?;

    let content_type = if emoji.animated {
        "image/gif"
    } else {
        "image/png"
    };

    use axum::http::header;
    use axum::response::IntoResponse;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                axum::http::HeaderValue::from_static(content_type),
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
