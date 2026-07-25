use super::*;

/// Matches the `reactions.emoji_name` column. The whole path segment is stored
/// verbatim (a custom emoji arrives as `name:snowflake`), and nothing bounded
/// it, so an over-long segment stored fine on SQLite and 500ed on PostgreSQL.
const MAX_REACTION_EMOJI_LEN: usize = 64;

pub async fn add_reaction(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, message_id, emoji)): Path<(i64, i64, String)>,
) -> Result<StatusCode, ApiError> {
    if emoji.chars().count() > MAX_REACTION_EMOJI_LEN {
        return Err(ApiError::BadRequest("emoji is too long".into()));
    }
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(
        &state,
        &channel,
        auth.user_id,
        &[
            Permissions::VIEW_CHANNEL,
            Permissions::READ_MESSAGE_HISTORY,
            Permissions::ADD_REACTIONS,
        ],
    )
    .await?;

    let message = paracord_db::messages::get_message(&state.db, message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if message.channel_id != channel_id {
        return Err(ApiError::NotFound);
    }

    paracord_db::reactions::add_reaction(&state.db, message_id, auth.user_id, &emoji, None)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let emoji_for_federation = emoji.clone();
    let guild_id = channel.guild_id();
    let reaction_payload = json!({
        "user_id": auth.user_id.to_string(),
        "channel_id": channel_id.to_string(),
        "message_id": message_id.to_string(),
        "emoji": emoji,
    });

    dispatch_channel_event(&state, &channel, "MESSAGE_REACTION_ADD", reaction_payload).await;

    if let Some(gid) = guild_id {
        if paracord_federation::is_enabled() {
            let fed_state = state.clone();
            let fed_author = auth.user_id;
            let fed_content = json!({
                "guild_id": gid.to_string(),
                "channel_id": channel_id.to_string(),
                "message_id": message_id.to_string(),
                "emoji": emoji,
            });
            let fed_ts = chrono::Utc::now().timestamp_millis();
            tokio::spawn(async move {
                federation_forward_generic(
                    &fed_state,
                    "m.reaction.add",
                    channel_id,
                    gid,
                    fed_author,
                    &fed_content,
                    fed_ts,
                    Some(format!("{}:{}", message_id, emoji_for_federation)),
                )
                .await;
            });
        }
    }

    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove_reaction(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, message_id, emoji)): Path<(i64, i64, String)>,
) -> Result<StatusCode, ApiError> {
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

    let message = paracord_db::messages::get_message(&state.db, message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if message.channel_id != channel_id {
        return Err(ApiError::NotFound);
    }

    paracord_db::reactions::remove_reaction(&state.db, message_id, auth.user_id, &emoji)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let emoji_for_federation = emoji.clone();
    let guild_id = channel.guild_id();
    let reaction_payload = json!({
        "user_id": auth.user_id.to_string(),
        "channel_id": channel_id.to_string(),
        "message_id": message_id.to_string(),
        "emoji": emoji,
    });

    dispatch_channel_event(
        &state,
        &channel,
        "MESSAGE_REACTION_REMOVE",
        reaction_payload,
    )
    .await;

    if let Some(gid) = guild_id {
        if paracord_federation::is_enabled() {
            let fed_state = state.clone();
            let fed_author = auth.user_id;
            let fed_content = json!({
                "guild_id": gid.to_string(),
                "channel_id": channel_id.to_string(),
                "message_id": message_id.to_string(),
                "emoji": emoji,
            });
            let fed_ts = chrono::Utc::now().timestamp_millis();
            tokio::spawn(async move {
                federation_forward_generic(
                    &fed_state,
                    "m.reaction.remove",
                    channel_id,
                    gid,
                    fed_author,
                    &fed_content,
                    fed_ts,
                    Some(format!("{}:{}", message_id, emoji_for_federation)),
                )
                .await;
            });
        }
    }

    Ok(StatusCode::NO_CONTENT)
}
