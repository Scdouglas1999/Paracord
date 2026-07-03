use super::*;

pub async fn get_pins(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
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

    let messages = paracord_db::messages::get_pinned_messages(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let pinned = messages_to_json(&state, &messages, auth.user_id).await;

    Ok(Json(json!(pinned)))
}

pub async fn pin_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, message_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(
        &state,
        &channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::MANAGE_MESSAGES],
    )
    .await?;

    // A per-channel pin cap surfaces as DbError::LimitReached, which the
    // From<DbError> impl maps to 409 Conflict.
    let pinned = paracord_db::messages::pin_message(&state.db, message_id, channel_id)
        .await
        .map_err(ApiError::from)?;
    if !pinned {
        return Err(ApiError::NotFound);
    }

    let pins_payload = json!({ "channel_id": channel_id.to_string() });
    dispatch_channel_event(&state, &channel, "CHANNEL_PINS_UPDATE", pins_payload).await;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn unpin_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, message_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(
        &state,
        &channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::MANAGE_MESSAGES],
    )
    .await?;

    let unpinned = paracord_db::messages::unpin_message(&state.db, message_id, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !unpinned {
        return Err(ApiError::NotFound);
    }

    let pins_payload = json!({ "channel_id": channel_id.to_string() });
    dispatch_channel_event(&state, &channel, "CHANNEL_PINS_UPDATE", pins_payload).await;

    Ok(StatusCode::NO_CONTENT)
}
