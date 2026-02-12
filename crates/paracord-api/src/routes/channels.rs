use axum::{
    extract::{Path, Query, State},
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

#[derive(Deserialize)]
pub struct CreateChannelRequest {
    pub name: String,
    #[serde(default)]
    pub channel_type: i16,
    pub parent_id: Option<i64>,
}

#[derive(Deserialize)]
pub struct UpdateChannelRequest {
    pub name: Option<String>,
    pub topic: Option<String>,
}

#[derive(Deserialize)]
pub struct MessageQuery {
    pub before: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Deserialize)]
pub struct MessageSearchQuery {
    pub q: String,
    pub limit: Option<i64>,
}

#[derive(Deserialize)]
pub struct SendMessageRequest {
    pub content: String,
    pub referenced_message_id: Option<String>,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
}

#[derive(Deserialize)]
pub struct EditMessageRequest {
    pub content: String,
}

#[derive(Deserialize)]
pub struct BulkDeleteMessagesRequest {
    pub message_ids: Vec<String>,
}

#[derive(Deserialize)]
pub struct UpdateReadStateRequest {
    pub last_message_id: Option<String>,
}

#[derive(Deserialize)]
pub struct UpsertChannelOverwriteRequest {
    pub target_type: i16,
    pub allow_perms: i64,
    pub deny_perms: i64,
}

fn channel_to_json(c: &paracord_db::channels::ChannelRow) -> Value {
    json!({
        "id": c.id.to_string(),
        "guild_id": c.guild_id().map(|id| id.to_string()),
        "name": c.name,
        "topic": c.topic,
        "type": c.channel_type,
        "channel_type": c.channel_type,
        "position": c.position,
        "parent_id": c.parent_id.map(|id| id.to_string()),
        "nsfw": c.nsfw,
        "rate_limit_per_user": c.rate_limit_per_user,
        "last_message_id": c.last_message_id.map(|id| id.to_string()),
    })
}

async fn ensure_channel_permissions(
    state: &AppState,
    channel: &paracord_db::channels::ChannelRow,
    user_id: i64,
    required: &[Permissions],
) -> Result<(), ApiError> {
    if let Some(guild_id) = channel.guild_id() {
        paracord_core::permissions::ensure_guild_member(&state.db, guild_id, user_id).await?;
        let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::NotFound)?;
        let perms = paracord_core::permissions::compute_channel_permissions(
            &state.db,
            guild_id,
            channel.id,
            guild.owner_id,
            user_id,
        )
        .await?;
        for req in required {
            paracord_core::permissions::require_permission(perms, *req)?;
        }
    } else if !paracord_db::dms::is_dm_recipient(&state.db, channel.id, user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    {
        return Err(ApiError::Forbidden);
    }
    Ok(())
}

async fn author_to_json(state: &AppState, author_id: i64) -> Value {
    if let Some(author) = paracord_db::users::get_user_by_id(&state.db, author_id)
        .await
        .ok()
        .flatten()
    {
        json!({
            "id": author.id.to_string(),
            "username": author.username,
            "discriminator": author.discriminator,
            "avatar_hash": author.avatar_hash,
        })
    } else {
        json!({
            "id": author_id.to_string(),
            "username": "Unknown",
            "discriminator": 0,
            "avatar_hash": null,
        })
    }
}

async fn message_to_json(
    state: &AppState,
    msg: &paracord_db::messages::MessageRow,
    viewer_id: i64,
) -> Value {
    let author = author_to_json(state, msg.author_id).await;
    let attachments = paracord_db::attachments::get_message_attachments(&state.db, msg.id)
        .await
        .unwrap_or_default();
    let attachment_json: Vec<Value> = attachments
        .iter()
        .map(|a| {
            json!({
                "id": a.id.to_string(),
                "filename": a.filename,
                "size": a.size,
                "content_type": a.content_type,
                "url": a.url,
                "width": a.width,
                "height": a.height,
            })
        })
        .collect();

    let reactions = paracord_db::reactions::get_message_reactions(&state.db, msg.id)
        .await
        .unwrap_or_default();
    let mut reaction_json = Vec::with_capacity(reactions.len());
    for reaction in reactions {
        let me = paracord_db::reactions::get_reaction_users(
            &state.db,
            msg.id,
            &reaction.emoji_name,
            1000,
        )
        .await
        .map(|users| users.contains(&viewer_id))
        .unwrap_or(false);
        reaction_json.push(json!({
            "emoji": reaction.emoji_name,
            "count": reaction.count,
            "me": me,
        }));
    }

    json!({
        "id": msg.id.to_string(),
        "channel_id": msg.channel_id.to_string(),
        "author": author,
        "content": msg.content,
        "pinned": msg.pinned,
        "type": msg.message_type,
        "message_type": msg.message_type,
        "timestamp": msg.created_at.to_rfc3339(),
        "created_at": msg.created_at.to_rfc3339(),
        "edited_timestamp": msg.edited_at.map(|t| t.to_rfc3339()),
        "edited_at": msg.edited_at.map(|t| t.to_rfc3339()),
        "reference_id": msg.reference_id.map(|id| id.to_string()),
        "attachments": attachment_json,
        "reactions": reaction_json,
    })
}

pub async fn create_channel(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<CreateChannelRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let channel_id = paracord_util::snowflake::generate(1);

    let channel = paracord_core::channel::create_channel(
        &state.db,
        guild_id,
        auth.user_id,
        channel_id,
        &body.name,
        body.channel_type,
        body.parent_id,
    )
    .await?;

    let channel_json = channel_to_json(&channel);

    state
        .event_bus
        .dispatch("CHANNEL_CREATE", channel_json.clone(), Some(guild_id));
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_CHANNEL_CREATE,
        Some(channel.id),
        None,
        Some(json!({ "name": channel.name, "type": channel.channel_type })),
    )
    .await;

    Ok((StatusCode::CREATED, Json(channel_json)))
}

pub async fn get_channel(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    ensure_channel_permissions(&state, &channel, auth.user_id, &[Permissions::VIEW_CHANNEL]).await?;

    Ok(Json(channel_to_json(&channel)))
}

pub async fn update_channel(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<UpdateChannelRequest>,
) -> Result<Json<Value>, ApiError> {
    let updated = paracord_core::channel::update_channel(
        &state.db,
        channel_id,
        auth.user_id,
        body.name.as_deref(),
        body.topic.as_deref(),
    )
    .await?;

    let channel_json = channel_to_json(&updated);

    state.event_bus.dispatch(
        "CHANNEL_UPDATE",
        channel_json.clone(),
        updated.guild_id(),
    );
    if let Some(guild_id) = updated.guild_id() {
        audit::log_action(
            &state,
            guild_id,
            auth.user_id,
            audit::ACTION_CHANNEL_UPDATE,
            Some(updated.id),
            None,
            Some(json!({ "name": updated.name, "topic": updated.topic })),
        )
        .await;
    }

    Ok(Json(channel_json))
}

pub async fn delete_channel(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let channel =
        paracord_core::channel::delete_channel(&state.db, channel_id, auth.user_id).await?;

    state.event_bus.dispatch(
        "CHANNEL_DELETE",
        json!({"id": channel_id.to_string(), "guild_id": channel.guild_id().map(|id| id.to_string())}),
        channel.guild_id(),
    );
    if let Some(guild_id) = channel.guild_id() {
        audit::log_action(
            &state,
            guild_id,
            auth.user_id,
            audit::ACTION_CHANNEL_DELETE,
            Some(channel_id),
            None,
            None,
        )
        .await;
    }

    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_messages(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(params): Query<MessageQuery>,
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

    let limit = params.limit.unwrap_or(50).min(100);
    let messages =
        paracord_db::messages::get_channel_messages(&state.db, channel_id, params.before, None, limit)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let mut result = Vec::new();
    for msg in &messages {
        result.push(message_to_json(&state, msg, auth.user_id).await);
    }

    Ok(Json(json!(result)))
}

pub async fn search_messages(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(params): Query<MessageSearchQuery>,
) -> Result<Json<Value>, ApiError> {
    if params.q.trim().is_empty() {
        return Err(ApiError::BadRequest("Query must not be empty".into()));
    }
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

    let limit = params.limit.unwrap_or(20).min(100);
    let messages = paracord_db::messages::search_messages(&state.db, channel_id, &params.q, limit)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let mut result = Vec::with_capacity(messages.len());
    for msg in &messages {
        result.push(message_to_json(&state, msg, auth.user_id).await);
    }
    Ok(Json(json!(result)))
}

pub async fn bulk_delete_messages(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<BulkDeleteMessagesRequest>,
) -> Result<Json<Value>, ApiError> {
    if body.message_ids.is_empty() {
        return Err(ApiError::BadRequest(
            "message_ids must contain at least one message".into(),
        ));
    }
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

    let mut ids = Vec::with_capacity(body.message_ids.len());
    for raw in &body.message_ids {
        ids.push(
            raw.parse::<i64>()
                .map_err(|_| ApiError::BadRequest("Invalid message ID".into()))?,
        );
    }
    let deleted = paracord_db::messages::bulk_delete_messages(&state.db, &ids)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let guild_id = channel.guild_id();
    let bulk_payload = json!({
        "channel_id": channel_id.to_string(),
        "ids": body.message_ids,
    });
    if guild_id.is_none() {
        let recipient_ids = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
            .await
            .unwrap_or_default();
        state.event_bus.dispatch_to_users("MESSAGE_DELETE_BULK", bulk_payload, recipient_ids);
    } else {
        state.event_bus.dispatch("MESSAGE_DELETE_BULK", bulk_payload, guild_id);
    }
    Ok(Json(json!({ "deleted": deleted })))
}

pub async fn send_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<SendMessageRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if body.content.trim().is_empty() && body.attachment_ids.is_empty() {
        return Err(ApiError::BadRequest(
            "Message must include content or attachments".into(),
        ));
    }

    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(
        &state,
        &channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::SEND_MESSAGES],
    )
    .await?;

    let referenced_message_id = match body.referenced_message_id.as_deref() {
        Some(id) => Some(
            id.parse::<i64>()
                .map_err(|_| ApiError::BadRequest("Invalid referenced_message_id".into()))?,
        ),
        None => None,
    };

    let mut attachment_ids = Vec::with_capacity(body.attachment_ids.len());
    for attachment_id in &body.attachment_ids {
        let id = attachment_id
            .parse::<i64>()
            .map_err(|_| ApiError::BadRequest("Invalid attachment ID".into()))?;
        let attachment = paracord_db::attachments::get_attachment(&state.db, id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::BadRequest("Attachment does not exist".into()))?;
        if attachment.message_id.is_some() {
            return Err(ApiError::BadRequest(
                "Attachment is already linked".into(),
            ));
        }
        attachment_ids.push(id);
    }

    let msg_id = paracord_util::snowflake::generate(1);

    let msg = paracord_core::message::create_message(
        &state.db,
        msg_id,
        channel_id,
        auth.user_id,
        &body.content,
        referenced_message_id,
    )
    .await?;
    for id in &attachment_ids {
        let attached = paracord_db::attachments::attach_to_message(&state.db, *id, msg.id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        if !attached {
            return Err(ApiError::BadRequest(
                "Attachment is missing or already linked".into(),
            ));
        }
    }

    let guild_id = channel.guild_id();
    let msg_json = message_to_json(&state, &msg, auth.user_id).await;

    if guild_id.is_none() {
        // DM channel: deliver only to participants, not all connected users
        let recipient_ids = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
            .await
            .unwrap_or_default();
        state
            .event_bus
            .dispatch_to_users("MESSAGE_CREATE", msg_json.clone(), recipient_ids);
    } else {
        state
            .event_bus
            .dispatch("MESSAGE_CREATE", msg_json.clone(), guild_id);
    }

    Ok((StatusCode::CREATED, Json(msg_json)))
}

pub async fn edit_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, message_id)): Path<(i64, i64)>,
    Json(body): Json<EditMessageRequest>,
) -> Result<Json<Value>, ApiError> {
    let updated =
        paracord_core::message::edit_message(&state.db, message_id, auth.user_id, &body.content)
            .await?;

    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .ok()
        .flatten();
    let guild_id = channel.and_then(|c| c.guild_id());

    let msg_json = message_to_json(&state, &updated, auth.user_id).await;

    if guild_id.is_none() {
        let recipient_ids = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
            .await
            .unwrap_or_default();
        state
            .event_bus
            .dispatch_to_users("MESSAGE_UPDATE", msg_json.clone(), recipient_ids);
    } else {
        state
            .event_bus
            .dispatch("MESSAGE_UPDATE", msg_json.clone(), guild_id);
    }

    Ok(Json(msg_json))
}

pub async fn delete_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, message_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    paracord_core::message::delete_message(&state.db, message_id, channel_id, auth.user_id)
        .await?;

    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .ok()
        .flatten();
    let guild_id = channel.and_then(|c| c.guild_id());

    let delete_payload = json!({"id": message_id.to_string(), "channel_id": channel_id.to_string()});
    if guild_id.is_none() {
        let recipient_ids = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
            .await
            .unwrap_or_default();
        state
            .event_bus
            .dispatch_to_users("MESSAGE_DELETE", delete_payload, recipient_ids);
    } else {
        state.event_bus.dispatch("MESSAGE_DELETE", delete_payload, guild_id);
    }

    Ok(StatusCode::NO_CONTENT)
}

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

    let mut pinned = Vec::with_capacity(messages.len());
    for msg in &messages {
        pinned.push(message_to_json(&state, msg, auth.user_id).await);
    }

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

    paracord_db::messages::pin_message(&state.db, message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let guild_id = channel.guild_id();
    let pins_payload = json!({ "channel_id": channel_id.to_string() });

    if guild_id.is_none() {
        let recipient_ids = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
            .await
            .unwrap_or_default();
        state.event_bus.dispatch_to_users("CHANNEL_PINS_UPDATE", pins_payload, recipient_ids);
    } else {
        state.event_bus.dispatch("CHANNEL_PINS_UPDATE", pins_payload, guild_id);
    }

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

    paracord_db::messages::unpin_message(&state.db, message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let guild_id = channel.guild_id();
    let pins_payload = json!({ "channel_id": channel_id.to_string() });

    if guild_id.is_none() {
        let recipient_ids = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
            .await
            .unwrap_or_default();
        state.event_bus.dispatch_to_users("CHANNEL_PINS_UPDATE", pins_payload, recipient_ids);
    } else {
        state.event_bus.dispatch("CHANNEL_PINS_UPDATE", pins_payload, guild_id);
    }

    Ok(StatusCode::NO_CONTENT)
}

pub async fn typing(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .ok()
        .flatten()
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(
        &state,
        &channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::SEND_MESSAGES],
    )
    .await?;
    let guild_id = channel.guild_id();
    let typing_payload = json!({
        "channel_id": channel_id.to_string(),
        "user_id": auth.user_id.to_string(),
        "timestamp": chrono::Utc::now().timestamp(),
    });

    if guild_id.is_none() {
        let recipient_ids = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
            .await
            .unwrap_or_default();
        state.event_bus.dispatch_to_users("TYPING_START", typing_payload, recipient_ids);
    } else {
        state.event_bus.dispatch("TYPING_START", typing_payload, guild_id);
    }

    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_read_state(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<UpdateReadStateRequest>,
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
    let last_message_id = match body.last_message_id {
        Some(raw) => raw
            .parse::<i64>()
            .map_err(|_| ApiError::BadRequest("Invalid last_message_id".into()))?,
        None => channel.last_message_id.unwrap_or(0),
    };
    let read_state =
        paracord_db::read_states::update_read_state(&state.db, auth.user_id, channel_id, last_message_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!({
        "channel_id": read_state.channel_id.to_string(),
        "last_message_id": read_state.last_message_id.to_string(),
        "mention_count": read_state.mention_count,
    })))
}

pub async fn list_channel_overwrites(
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
        &[Permissions::VIEW_CHANNEL, Permissions::MANAGE_CHANNELS],
    )
    .await?;
    let overwrites = paracord_db::channel_overwrites::get_channel_overwrites(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let result: Vec<Value> = overwrites
        .iter()
        .map(|o| {
            json!({
                "channel_id": o.channel_id.to_string(),
                "target_id": o.target_id.to_string(),
                "target_type": o.target_type,
                "allow_perms": o.allow_perms,
                "deny_perms": o.deny_perms,
            })
        })
        .collect();
    Ok(Json(json!(result)))
}

pub async fn upsert_channel_overwrite(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, target_id)): Path<(i64, i64)>,
    Json(body): Json<UpsertChannelOverwriteRequest>,
) -> Result<StatusCode, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(
        &state,
        &channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::MANAGE_CHANNELS],
    )
    .await?;
    if body.target_type != paracord_core::permissions::OVERWRITE_TARGET_ROLE
        && body.target_type != paracord_core::permissions::OVERWRITE_TARGET_MEMBER
    {
        return Err(ApiError::BadRequest("Invalid overwrite target type".into()));
    }
    paracord_db::channel_overwrites::upsert_channel_overwrite(
        &state.db,
        channel_id,
        target_id,
        body.target_type,
        body.allow_perms,
        body.deny_perms,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    state.event_bus.dispatch(
        "CHANNEL_UPDATE",
        json!({ "id": channel_id.to_string() }),
        channel.guild_id(),
    );
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_channel_overwrite(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, target_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(
        &state,
        &channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::MANAGE_CHANNELS],
    )
    .await?;
    paracord_db::channel_overwrites::delete_channel_overwrite(&state.db, channel_id, target_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    state.event_bus.dispatch(
        "CHANNEL_UPDATE",
        json!({ "id": channel_id.to_string() }),
        channel.guild_id(),
    );
    Ok(StatusCode::NO_CONTENT)
}

pub async fn add_reaction(
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

    paracord_db::reactions::add_reaction(&state.db, message_id, auth.user_id, &emoji, None)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let guild_id = channel.guild_id();
    let reaction_payload = json!({
        "user_id": auth.user_id.to_string(),
        "channel_id": channel_id.to_string(),
        "message_id": message_id.to_string(),
        "emoji": emoji,
    });

    if guild_id.is_none() {
        let recipient_ids = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
            .await
            .unwrap_or_default();
        state.event_bus.dispatch_to_users("MESSAGE_REACTION_ADD", reaction_payload, recipient_ids);
    } else {
        state.event_bus.dispatch("MESSAGE_REACTION_ADD", reaction_payload, guild_id);
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

    paracord_db::reactions::remove_reaction(&state.db, message_id, auth.user_id, &emoji)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let guild_id = channel.guild_id();
    let reaction_payload = json!({
        "user_id": auth.user_id.to_string(),
        "channel_id": channel_id.to_string(),
        "message_id": message_id.to_string(),
        "emoji": emoji,
    });

    if guild_id.is_none() {
        let recipient_ids = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
            .await
            .unwrap_or_default();
        state.event_bus.dispatch_to_users("MESSAGE_REACTION_REMOVE", reaction_payload, recipient_ids);
    } else {
        state.event_bus.dispatch("MESSAGE_REACTION_REMOVE", reaction_payload, guild_id);
    }

    Ok(StatusCode::NO_CONTENT)
}
