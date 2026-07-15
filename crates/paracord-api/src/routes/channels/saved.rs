use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{ensure_channel_permissions, messages_to_json};
use crate::error::ApiError;
use crate::middleware::AuthUser;

#[derive(Deserialize)]
pub struct SavedMessagesQuery {
    pub limit: Option<i64>,
}

pub async fn list_saved_messages(
    State(state): State<AppState>,
    auth: AuthUser,
    Query(query): Query<SavedMessagesQuery>,
) -> Result<Json<Value>, ApiError> {
    let rows = paracord_db::saved_messages::list_saved_messages(
        &state.db,
        auth.user_id,
        query.limit.unwrap_or(50).clamp(1, 100),
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let mut visible = Vec::with_capacity(rows.len());
    for row in rows {
        let Some(message) = paracord_db::messages::get_message(&state.db, row.message_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        else {
            continue;
        };
        let Some(channel) = paracord_db::channels::get_channel(&state.db, message.channel_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        else {
            continue;
        };
        if ensure_channel_permissions(
            &state,
            &channel,
            auth.user_id,
            &[Permissions::VIEW_CHANNEL, Permissions::READ_MESSAGE_HISTORY],
        )
        .await
        .is_err()
        {
            continue;
        }
        visible.push((row, message, channel));
    }

    let messages: Vec<_> = visible
        .iter()
        .map(|(_, message, _)| message.clone())
        .collect();
    let message_json = messages_to_json(&state, &messages, auth.user_id).await;
    let items: Vec<Value> = visible
        .into_iter()
        .zip(message_json)
        .map(|((saved, _, channel), message)| {
            json!({
                "message": message,
                "saved_at": saved.saved_at.to_rfc3339(),
                "channel": {
                    "id": channel.id.to_string(),
                    "name": channel.name,
                    "guild_id": channel.guild_id().map(|id| id.to_string()),
                }
            })
        })
        .collect();
    let total = paracord_db::saved_messages::count_saved_messages(&state.db, auth.user_id)
        .await
        .unwrap_or(items.len() as i64);

    Ok(Json(json!({ "items": items, "total": total })))
}

pub async fn save_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(message_id): Path<i64>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let message = paracord_db::messages::get_message(&state.db, message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let channel = paracord_db::channels::get_channel(&state.db, message.channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(
        &state,
        &channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::READ_MESSAGE_HISTORY],
    )
    .await?;

    let saved = paracord_db::saved_messages::save_message(&state.db, auth.user_id, message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "message_id": saved.message_id.to_string(),
            "saved_at": saved.saved_at.to_rfc3339(),
        })),
    ))
}

pub async fn remove_saved_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(message_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    paracord_db::saved_messages::remove_saved_message(&state.db, auth.user_id, message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(StatusCode::NO_CONTENT)
}
