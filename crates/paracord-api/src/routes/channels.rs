use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use paracord_core::{AppState, MESSAGE_FLAG_DM_E2EE};
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;
use crate::routes::audit;

const MAX_CHANNEL_TOPIC_LEN: usize = 1_024;
const MAX_BULK_DELETE_REQUEST_IDS: usize = 500;
const MAX_POLL_QUESTION_LEN: usize = 300;
const MAX_POLL_OPTION_LEN: usize = 100;
const MAX_POLL_OPTIONS: usize = 10;
const MAX_POLL_DURATION_MINUTES: i64 = 60 * 24 * 14; // 14 days
const MAX_MESSAGE_NONCE_LEN: usize = 64;

fn contains_dangerous_markup(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("<script")
        || lower.contains("javascript:")
        || lower.contains("onerror=")
        || lower.contains("onload=")
        || lower.contains("<iframe")
}

#[derive(Deserialize)]
pub struct CreateChannelRequest {
    pub name: String,
    #[serde(default)]
    pub channel_type: i16,
    pub parent_id: Option<i64>,
    pub required_role_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct UpdateChannelRequest {
    pub name: Option<String>,
    pub topic: Option<String>,
    pub required_role_ids: Option<Vec<String>>,
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
pub struct DmE2eePayloadRequest {
    pub version: u8,
    pub nonce: String,
    pub ciphertext: String,
    pub header: Option<String>,
}

#[derive(Deserialize)]
pub struct SendMessageRequest {
    pub content: String,
    pub referenced_message_id: Option<String>,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    pub e2ee: Option<DmE2eePayloadRequest>,
    pub nonce: Option<String>,
}

#[derive(Deserialize)]
pub struct CreatePollOptionRequest {
    pub text: String,
    pub emoji: Option<String>,
}

#[derive(Deserialize)]
pub struct CreatePollRequest {
    pub question: String,
    pub options: Vec<CreatePollOptionRequest>,
    pub allow_multiselect: Option<bool>,
    pub expires_in_minutes: Option<i64>,
}

#[derive(Deserialize)]
pub struct EditMessageRequest {
    pub content: String,
    pub e2ee: Option<DmE2eePayloadRequest>,
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

pub fn channel_to_json(c: &paracord_db::channels::ChannelRow) -> Value {
    let required_role_ids: Vec<String> =
        paracord_db::channels::parse_required_role_ids(&c.required_role_ids)
            .into_iter()
            .map(|id| id.to_string())
            .collect();

    let thread_metadata: Option<Value> = c
        .thread_metadata
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());

    let applied_tags: Option<Value> = c
        .applied_tags
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());

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
        "required_role_ids": required_role_ids,
        "thread_metadata": thread_metadata,
        "owner_id": c.owner_id.map(|id| id.to_string()),
        "message_count": c.message_count,
        "applied_tags": applied_tags,
        "default_sort_order": c.default_sort_order,
        "created_at": c.created_at.to_rfc3339(),
    })
}

fn forum_tag_to_json(tag: &paracord_db::channels::ForumTagRow) -> Value {
    json!({
        "id": tag.id.to_string(),
        "channel_id": tag.channel_id.to_string(),
        "name": tag.name,
        "emoji": tag.emoji,
        "moderated": tag.moderated,
        "position": tag.position,
        "created_at": tag.created_at.to_rfc3339(),
    })
}

fn parse_role_id_strings(raw_role_ids: &[String]) -> Result<Vec<i64>, ApiError> {
    raw_role_ids
        .iter()
        .map(|raw| {
            raw.parse::<i64>()
                .map_err(|_| ApiError::BadRequest("Invalid role id".into()))
        })
        .collect()
}

async fn normalize_required_role_ids(
    state: &AppState,
    guild_id: i64,
    actor_id: i64,
    raw_role_ids: &[String],
) -> Result<String, ApiError> {
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let actor_roles = paracord_db::roles::get_member_roles(&state.db, actor_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let actor_perms = paracord_core::permissions::compute_permissions_from_roles(
        &actor_roles,
        guild.owner_id,
        actor_id,
    );
    if !paracord_core::permissions::is_server_admin(actor_perms) {
        return Err(ApiError::Forbidden);
    }

    let mut parsed_role_ids = parse_role_id_strings(raw_role_ids)?;
    parsed_role_ids.retain(|role_id| *role_id != guild_id);
    if parsed_role_ids.is_empty() {
        return Ok("[]".to_string());
    }

    let guild_roles = paracord_db::roles::get_guild_roles(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let guild_role_ids: std::collections::HashSet<i64> = guild_roles.iter().map(|r| r.id).collect();
    if parsed_role_ids
        .iter()
        .any(|role_id| !guild_role_ids.contains(role_id))
    {
        return Err(ApiError::BadRequest(
            "One or more required roles do not belong to this guild".into(),
        ));
    }

    Ok(paracord_db::channels::serialize_required_role_ids(
        &parsed_role_ids,
    ))
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
            "public_key": author.public_key,
            "flags": author.flags,
            "bot": paracord_core::is_bot(author.flags),
        })
    } else {
        json!({
            "id": author_id.to_string(),
            "username": "Unknown",
            "discriminator": 0,
            "avatar_hash": null,
            "public_key": null,
            "flags": 0,
            "bot": false,
        })
    }
}

fn poll_to_json(poll: &paracord_db::polls::PollWithOptions) -> Value {
    let options: Vec<Value> = poll
        .options
        .iter()
        .map(|opt| {
            json!({
                "id": opt.id.to_string(),
                "text": opt.text,
                "emoji": opt.emoji,
                "position": opt.position,
                "vote_count": opt.vote_count,
                "voted": opt.voted,
            })
        })
        .collect();

    json!({
        "id": poll.poll.id.to_string(),
        "message_id": poll.poll.message_id.to_string(),
        "channel_id": poll.poll.channel_id.to_string(),
        "question": poll.poll.question,
        "allow_multiselect": poll.poll.allow_multiselect,
        "expires_at": poll.poll.expires_at.map(|t| t.to_rfc3339()),
        "created_at": poll.poll.created_at.to_rfc3339(),
        "options": options,
        "total_votes": poll.total_votes,
    })
}

async fn message_to_json(
    state: &AppState,
    msg: &paracord_db::messages::MessageRow,
    viewer_id: i64,
) -> Value {
    let is_dm_e2ee = (msg.flags & MESSAGE_FLAG_DM_E2EE) != 0;
    let e2ee_payload = if is_dm_e2ee {
        msg.nonce
            .as_ref()
            .zip(msg.content.as_ref())
            .map(|(nonce, ciphertext)| {
                let version = if msg.e2ee_header.is_some() { 2 } else { 1 };
                let mut payload = json!({
                    "version": version,
                    "nonce": nonce,
                    "ciphertext": ciphertext,
                });
                if let Some(header) = &msg.e2ee_header {
                    payload["header"] = json!(header);
                }
                payload
            })
    } else {
        None
    };
    let content = if is_dm_e2ee {
        Value::Null
    } else {
        json!(msg.content)
    };

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

    let poll_json = paracord_db::polls::get_message_poll(&state.db, msg.id, viewer_id)
        .await
        .ok()
        .flatten()
        .map(|poll| poll_to_json(&poll));

    json!({
        "id": msg.id.to_string(),
        "channel_id": msg.channel_id.to_string(),
        "author": author,
        "content": content,
        "e2ee": e2ee_payload,
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
        "poll": poll_json,
    })
}

pub async fn create_channel(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
    Json(body): Json<CreateChannelRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let channel_id = paracord_util::snowflake::generate(1);
    let required_role_ids = match body.required_role_ids.as_deref() {
        Some(raw_role_ids) => {
            Some(normalize_required_role_ids(&state, guild_id, auth.user_id, raw_role_ids).await?)
        }
        None => None,
    };

    let channel = paracord_core::channel::create_channel(
        &state.db,
        guild_id,
        auth.user_id,
        channel_id,
        &body.name,
        body.channel_type,
        body.parent_id,
        required_role_ids.as_deref(),
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

    ensure_channel_permissions(&state, &channel, auth.user_id, &[Permissions::VIEW_CHANNEL])
        .await?;

    Ok(Json(channel_to_json(&channel)))
}

pub async fn update_channel(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<UpdateChannelRequest>,
) -> Result<Json<Value>, ApiError> {
    if let Some(topic) = body.topic.as_deref() {
        if topic.trim().len() > MAX_CHANNEL_TOPIC_LEN {
            return Err(ApiError::BadRequest("topic is too long".into()));
        }
        if contains_dangerous_markup(topic) {
            return Err(ApiError::BadRequest("topic contains unsafe markup".into()));
        }
    }

    let guild_id = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .and_then(|c| c.guild_id())
        .ok_or(ApiError::NotFound)?;
    let required_role_ids = match body.required_role_ids.as_deref() {
        Some(raw_role_ids) => {
            Some(normalize_required_role_ids(&state, guild_id, auth.user_id, raw_role_ids).await?)
        }
        None => None,
    };

    let updated = paracord_core::channel::update_channel(
        &state.db,
        channel_id,
        auth.user_id,
        body.name.as_deref(),
        body.topic.as_deref(),
        required_role_ids.as_deref(),
    )
    .await?;

    let channel_json = channel_to_json(&updated);

    state
        .event_bus
        .dispatch("CHANNEL_UPDATE", channel_json.clone(), updated.guild_id());
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
    let messages = paracord_db::messages::get_channel_messages(
        &state.db,
        channel_id,
        params.before,
        None,
        limit,
    )
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
    if body.message_ids.len() > MAX_BULK_DELETE_REQUEST_IDS {
        return Err(ApiError::BadRequest(
            "Too many message_ids in one request".into(),
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
    let deleted = paracord_db::messages::bulk_delete_messages(&state.db, channel_id, &ids)
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
        state
            .event_bus
            .dispatch_to_users("MESSAGE_DELETE_BULK", bulk_payload, recipient_ids);
    } else {
        state
            .event_bus
            .dispatch("MESSAGE_DELETE_BULK", bulk_payload, guild_id);
    }
    Ok(Json(json!({ "deleted": deleted })))
}

pub async fn send_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<SendMessageRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let nonce = body
        .nonce
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(candidate) = nonce.as_ref() {
        if candidate.len() > MAX_MESSAGE_NONCE_LEN {
            return Err(ApiError::BadRequest("Message nonce must be 1-64 characters".into()));
        }
    }

    if body.content.trim().is_empty() && body.attachment_ids.is_empty() && body.e2ee.is_none() {
        return Err(ApiError::BadRequest(
            "Message must include content or attachments".into(),
        ));
    }
    if body.e2ee.is_none()
        && !body.content.trim().is_empty()
        && contains_dangerous_markup(&body.content)
    {
        return Err(ApiError::BadRequest(
            "Message contains unsafe markup".into(),
        ));
    }
    if body.e2ee.is_none() && !body.content.trim().is_empty() {
        paracord_util::validation::validate_message_content(&body.content).map_err(|_| {
            ApiError::BadRequest("Message content must be 1-2000 characters".into())
        })?;
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

    let mut attachments = Vec::with_capacity(body.attachment_ids.len());
    let now = chrono::Utc::now();
    for attachment_id in &body.attachment_ids {
        let id = attachment_id
            .parse::<i64>()
            .map_err(|_| ApiError::BadRequest("Invalid attachment ID".into()))?;
        let attachment = paracord_db::attachments::get_attachment(&state.db, id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::BadRequest("Attachment does not exist".into()))?;
        if attachment.uploader_id != Some(auth.user_id) {
            return Err(ApiError::Forbidden);
        }
        if attachment.upload_channel_id != Some(channel_id) {
            return Err(ApiError::BadRequest(
                "Attachment was uploaded for a different channel".into(),
            ));
        }
        if attachment
            .upload_expires_at
            .is_some_and(|expires_at| expires_at <= now)
        {
            return Err(ApiError::BadRequest(
                "Attachment upload has expired; re-upload the file".into(),
            ));
        }
        attachments.push(attachment);
    }

    let msg_id = paracord_util::snowflake::generate(1);

    let dm_e2ee = body
        .e2ee
        .map(|payload| paracord_core::message::DmE2eePayload {
            version: payload.version,
            nonce: payload.nonce,
            ciphertext: payload.ciphertext,
            header: payload.header,
        });

    let msg = paracord_core::message::create_message_with_options(
        &state.db,
        msg_id,
        channel_id,
        auth.user_id,
        &body.content,
        paracord_core::message::CreateMessageOptions {
            message_type: 0,
            reference_id: referenced_message_id,
            allow_empty_content: !body.attachment_ids.is_empty(),
            dm_e2ee,
            nonce,
        },
    )
    .await?;
    let created_new = msg.id == msg_id;
    for attachment in &attachments {
        if attachment.message_id == Some(msg.id) {
            continue;
        }
        if attachment.message_id.is_some() {
            return Err(ApiError::BadRequest("Attachment is already linked".into()));
        }
        let attached = paracord_db::attachments::attach_to_message(
            &state.db,
            attachment.id,
            msg.id,
            auth.user_id,
            channel_id,
            now.clone(),
        )
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        if !attached {
            let current_attachment =
                paracord_db::attachments::get_attachment(&state.db, attachment.id)
                    .await
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            if current_attachment
                .as_ref()
                .is_some_and(|current| current.message_id == Some(msg.id))
            {
                continue;
            }
            return Err(ApiError::BadRequest(
                "Attachment is missing or already linked".into(),
            ));
        }
    }

    // Increment thread message count if the channel is a thread
    if created_new && channel.channel_type == 6 {
        let _ = paracord_db::channels::increment_thread_message_count(&state.db, channel_id).await;
    }

    let guild_id = channel.guild_id();
    let msg_json = message_to_json(&state, &msg, auth.user_id).await;

    if created_new {
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

        // Federation: forward message to peer servers (non-blocking)
        if let Some(gid) = guild_id {
            if paracord_federation::is_enabled() {
                let fed_state = state.clone();
                let fed_content = json!(body.content);
                let fed_msg_id = msg.id;
                let fed_author = auth.user_id;
                let fed_ts = msg.created_at.timestamp_millis();
                tokio::spawn(async move {
                    federation_forward_message(
                        &fed_state,
                        fed_msg_id,
                        channel_id,
                        gid,
                        fed_author,
                        &fed_content,
                        fed_ts,
                    )
                    .await;
                });
            }
        }
    }

    Ok((
        if created_new {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(msg_json),
    ))
}

pub async fn create_poll(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<CreatePollRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let question = body.question.trim();
    if question.is_empty() || question.len() > MAX_POLL_QUESTION_LEN {
        return Err(ApiError::BadRequest(
            "Poll question must be between 1 and 300 characters".into(),
        ));
    }
    if contains_dangerous_markup(question) {
        return Err(ApiError::BadRequest(
            "Poll question contains unsafe markup".into(),
        ));
    }
    if body.options.len() < 2 || body.options.len() > MAX_POLL_OPTIONS {
        return Err(ApiError::BadRequest(
            "Polls must include between 2 and 10 options".into(),
        ));
    }

    let mut options = Vec::with_capacity(body.options.len());
    for option in &body.options {
        let text = option.text.trim();
        if text.is_empty() || text.len() > MAX_POLL_OPTION_LEN {
            return Err(ApiError::BadRequest(
                "Poll options must be between 1 and 100 characters".into(),
            ));
        }
        if contains_dangerous_markup(text) {
            return Err(ApiError::BadRequest(
                "Poll options contain unsafe markup".into(),
            ));
        }
        options.push(paracord_db::polls::CreatePollOption {
            text: text.to_string(),
            emoji: option.emoji.clone(),
        });
    }

    let expires_at = match body.expires_in_minutes {
        Some(minutes) => {
            if !(1..=MAX_POLL_DURATION_MINUTES).contains(&minutes) {
                return Err(ApiError::BadRequest(
                    "Poll duration must be between 1 minute and 14 days".into(),
                ));
            }
            Some(chrono::Utc::now() + chrono::Duration::minutes(minutes))
        }
        None => None,
    };

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

    let message_id = paracord_util::snowflake::generate(1);
    let msg = paracord_core::message::create_message_with_type(
        &state.db,
        message_id,
        channel_id,
        auth.user_id,
        question,
        20,
        None,
    )
    .await?;

    let poll_id = paracord_util::snowflake::generate(1);
    paracord_db::polls::create_poll(
        &state.db,
        poll_id,
        msg.id,
        channel_id,
        question,
        &options,
        body.allow_multiselect.unwrap_or(false),
        expires_at,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let guild_id = channel.guild_id();
    let msg_json = message_to_json(&state, &msg, auth.user_id).await;

    if guild_id.is_none() {
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

pub async fn get_poll(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, poll_id)): Path<(i64, i64)>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(&state, &channel, auth.user_id, &[Permissions::VIEW_CHANNEL])
        .await?;

    let poll = paracord_db::polls::get_poll(&state.db, poll_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if poll.poll.channel_id != channel_id {
        return Err(ApiError::NotFound);
    }

    Ok(Json(poll_to_json(&poll)))
}

pub async fn add_poll_vote(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, poll_id, option_id)): Path<(i64, i64, i64)>,
) -> Result<Json<Value>, ApiError> {
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

    let poll = paracord_db::polls::get_poll(&state.db, poll_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if poll.poll.channel_id != channel_id {
        return Err(ApiError::NotFound);
    }
    if poll
        .poll
        .expires_at
        .is_some_and(|expires_at| expires_at <= chrono::Utc::now())
    {
        return Err(ApiError::BadRequest("Poll voting has expired".into()));
    }
    if !poll.options.iter().any(|opt| opt.id == option_id) {
        return Err(ApiError::BadRequest("Invalid poll option".into()));
    }

    paracord_db::polls::add_vote(&state.db, poll_id, option_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let updated = paracord_db::polls::get_poll(&state.db, poll_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let poll_json = poll_to_json(&updated);

    let event_payload = json!({
        "channel_id": channel_id.to_string(),
        "poll_id": poll_id.to_string(),
        "option_id": option_id.to_string(),
        "user_id": auth.user_id.to_string(),
        "poll": poll_json,
    });
    let guild_id = channel.guild_id();
    if guild_id.is_none() {
        let recipient_ids = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
            .await
            .unwrap_or_default();
        state
            .event_bus
            .dispatch_to_users("POLL_VOTE_ADD", event_payload, recipient_ids);
    } else {
        state
            .event_bus
            .dispatch("POLL_VOTE_ADD", event_payload, guild_id);
    }

    Ok(Json(poll_to_json(&updated)))
}

pub async fn remove_poll_vote(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, poll_id, option_id)): Path<(i64, i64, i64)>,
) -> Result<Json<Value>, ApiError> {
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

    let poll = paracord_db::polls::get_poll(&state.db, poll_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if poll.poll.channel_id != channel_id {
        return Err(ApiError::NotFound);
    }
    if !poll.options.iter().any(|opt| opt.id == option_id) {
        return Err(ApiError::BadRequest("Invalid poll option".into()));
    }

    paracord_db::polls::remove_vote(&state.db, poll_id, option_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let updated = paracord_db::polls::get_poll(&state.db, poll_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let poll_json = poll_to_json(&updated);

    let event_payload = json!({
        "channel_id": channel_id.to_string(),
        "poll_id": poll_id.to_string(),
        "option_id": option_id.to_string(),
        "user_id": auth.user_id.to_string(),
        "poll": poll_json,
    });
    let guild_id = channel.guild_id();
    if guild_id.is_none() {
        let recipient_ids = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
            .await
            .unwrap_or_default();
        state
            .event_bus
            .dispatch_to_users("POLL_VOTE_REMOVE", event_payload, recipient_ids);
    } else {
        state
            .event_bus
            .dispatch("POLL_VOTE_REMOVE", event_payload, guild_id);
    }

    Ok(Json(poll_to_json(&updated)))
}

pub async fn edit_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, message_id)): Path<(i64, i64)>,
    Json(body): Json<EditMessageRequest>,
) -> Result<Json<Value>, ApiError> {
    if body.e2ee.is_none() {
        paracord_util::validation::validate_message_content(&body.content).map_err(|_| {
            ApiError::BadRequest("Message content must be 1-2000 characters".into())
        })?;
    }
    if body.e2ee.is_none() && contains_dangerous_markup(&body.content) {
        return Err(ApiError::BadRequest(
            "Message contains unsafe markup".into(),
        ));
    }
    let dm_e2ee = body
        .e2ee
        .map(|payload| paracord_core::message::DmE2eePayload {
            version: payload.version,
            nonce: payload.nonce,
            ciphertext: payload.ciphertext,
            header: payload.header,
        });
    let updated = paracord_core::message::edit_message_with_options(
        &state.db,
        channel_id,
        message_id,
        auth.user_id,
        &body.content,
        dm_e2ee,
    )
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

    if let Some(gid) = guild_id {
        if paracord_federation::is_enabled() {
            let fed_state = state.clone();
            let fed_author = auth.user_id;
            let fed_content = json!({
                "guild_id": gid.to_string(),
                "channel_id": channel_id.to_string(),
                "message_id": message_id.to_string(),
                "body": body.content,
            });
            let fed_ts = chrono::Utc::now().timestamp_millis();
            tokio::spawn(async move {
                federation_forward_generic(
                    &fed_state,
                    "m.message.edit",
                    channel_id,
                    gid,
                    fed_author,
                    &fed_content,
                    fed_ts,
                    Some(message_id.to_string()),
                )
                .await;
            });
        }
    }

    Ok(Json(msg_json))
}

pub async fn delete_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, message_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    paracord_core::message::delete_message(&state.db, message_id, channel_id, auth.user_id).await?;

    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .ok()
        .flatten();
    let guild_id = channel.and_then(|c| c.guild_id());

    let delete_payload =
        json!({"id": message_id.to_string(), "channel_id": channel_id.to_string()});
    if guild_id.is_none() {
        let recipient_ids = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
            .await
            .unwrap_or_default();
        state
            .event_bus
            .dispatch_to_users("MESSAGE_DELETE", delete_payload, recipient_ids);
    } else {
        state
            .event_bus
            .dispatch("MESSAGE_DELETE", delete_payload, guild_id);
    }

    if let Some(gid) = guild_id {
        if paracord_federation::is_enabled() {
            let fed_state = state.clone();
            let fed_author = auth.user_id;
            let fed_content = json!({
                "guild_id": gid.to_string(),
                "channel_id": channel_id.to_string(),
                "message_id": message_id.to_string(),
            });
            let fed_ts = chrono::Utc::now().timestamp_millis();
            tokio::spawn(async move {
                federation_forward_generic(
                    &fed_state,
                    "m.message.delete",
                    channel_id,
                    gid,
                    fed_author,
                    &fed_content,
                    fed_ts,
                    Some(message_id.to_string()),
                )
                .await;
            });
        }
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

    let pinned = paracord_db::messages::pin_message(&state.db, message_id, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !pinned {
        return Err(ApiError::NotFound);
    }

    let guild_id = channel.guild_id();
    let pins_payload = json!({ "channel_id": channel_id.to_string() });

    if guild_id.is_none() {
        let recipient_ids = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
            .await
            .unwrap_or_default();
        state
            .event_bus
            .dispatch_to_users("CHANNEL_PINS_UPDATE", pins_payload, recipient_ids);
    } else {
        state
            .event_bus
            .dispatch("CHANNEL_PINS_UPDATE", pins_payload, guild_id);
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

    let unpinned = paracord_db::messages::unpin_message(&state.db, message_id, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !unpinned {
        return Err(ApiError::NotFound);
    }

    let guild_id = channel.guild_id();
    let pins_payload = json!({ "channel_id": channel_id.to_string() });

    if guild_id.is_none() {
        let recipient_ids = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
            .await
            .unwrap_or_default();
        state
            .event_bus
            .dispatch_to_users("CHANNEL_PINS_UPDATE", pins_payload, recipient_ids);
    } else {
        state
            .event_bus
            .dispatch("CHANNEL_PINS_UPDATE", pins_payload, guild_id);
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
        state
            .event_bus
            .dispatch_to_users("TYPING_START", typing_payload, recipient_ids);
    } else {
        state
            .event_bus
            .dispatch("TYPING_START", typing_payload, guild_id);
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
    let read_state = paracord_db::read_states::update_read_state(
        &state.db,
        auth.user_id,
        channel_id,
        last_message_id,
    )
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
    // Invalidate permission cache when channel overwrites change
    paracord_core::permissions::invalidate_channel(&state.permission_cache, channel_id).await;
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
    // Invalidate permission cache when channel overwrites are removed
    paracord_core::permissions::invalidate_channel(&state.permission_cache, channel_id).await;
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

    let emoji_for_federation = emoji.clone();
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
        state
            .event_bus
            .dispatch_to_users("MESSAGE_REACTION_ADD", reaction_payload, recipient_ids);
    } else {
        state
            .event_bus
            .dispatch("MESSAGE_REACTION_ADD", reaction_payload, guild_id);
    }

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

    if guild_id.is_none() {
        let recipient_ids = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
            .await
            .unwrap_or_default();
        state.event_bus.dispatch_to_users(
            "MESSAGE_REACTION_REMOVE",
            reaction_payload,
            recipient_ids,
        );
    } else {
        state
            .event_bus
            .dispatch("MESSAGE_REACTION_REMOVE", reaction_payload, guild_id);
    }

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

// ============ Thread endpoints ============

#[derive(Deserialize)]
pub struct CreateThreadRequest {
    pub name: String,
    pub message_id: Option<String>,
    pub auto_archive_duration: Option<i64>,
}

#[derive(Deserialize)]
pub struct UpdateThreadRequest {
    pub name: Option<String>,
    pub archived: Option<bool>,
    pub locked: Option<bool>,
}

#[derive(Deserialize)]
pub struct ForumPostQuery {
    pub sort_order: Option<i32>,
    pub include_archived: Option<bool>,
}

#[derive(Deserialize)]
pub struct CreateForumPostRequest {
    pub name: String,
    pub content: Option<String>,
    pub applied_tag_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct CreateForumTagRequest {
    pub name: String,
    pub emoji: Option<String>,
    pub moderated: Option<bool>,
}

#[derive(Deserialize)]
pub struct UpdateForumSortOrderRequest {
    pub sort_order: i32,
}

pub async fn create_thread(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<CreateThreadRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if body.name.trim().is_empty() || body.name.len() > 100 {
        return Err(ApiError::BadRequest(
            "Thread name must be 1-100 characters".into(),
        ));
    }
    if contains_dangerous_markup(&body.name) {
        return Err(ApiError::BadRequest(
            "Thread name contains unsafe markup".into(),
        ));
    }

    let parent_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    // Threads can only be created in text or announcement channels
    if parent_channel.channel_type != 0 && parent_channel.channel_type != 5 {
        return Err(ApiError::BadRequest(
            "Threads can only be created in text or announcement channels".into(),
        ));
    }

    ensure_channel_permissions(
        &state,
        &parent_channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::SEND_MESSAGES],
    )
    .await?;

    let guild_id = parent_channel
        .guild_id()
        .ok_or(ApiError::BadRequest("Cannot create threads in DMs".into()))?;

    let auto_archive_duration = body.auto_archive_duration.unwrap_or(1440);
    let starter_message_id = match body.message_id.as_deref() {
        Some(raw_message_id) => {
            let parsed_message_id = raw_message_id
                .parse::<i64>()
                .map_err(|_| ApiError::BadRequest("Invalid message_id".into()))?;
            let starter_message = paracord_db::messages::get_message(&state.db, parsed_message_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                .ok_or(ApiError::BadRequest("Starter message not found".into()))?;
            if starter_message.channel_id != channel_id {
                return Err(ApiError::BadRequest(
                    "Starter message must belong to the parent channel".into(),
                ));
            }
            Some(parsed_message_id)
        }
        None => None,
    };

    let thread_id = paracord_util::snowflake::generate(1);
    let thread = paracord_db::channels::create_thread(
        &state.db,
        thread_id,
        guild_id,
        channel_id,
        body.name.trim(),
        auth.user_id,
        auto_archive_duration,
        starter_message_id,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let thread_json = channel_to_json(&thread);

    state
        .event_bus
        .dispatch("THREAD_CREATE", thread_json.clone(), Some(guild_id));

    Ok((StatusCode::CREATED, Json(thread_json)))
}

pub async fn get_threads(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let parent_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    ensure_channel_permissions(
        &state,
        &parent_channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL],
    )
    .await?;

    let threads = paracord_db::channels::get_channel_threads(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let result: Vec<Value> = threads.iter().map(channel_to_json).collect();
    Ok(Json(json!(result)))
}

pub async fn get_archived_threads(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let parent_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    ensure_channel_permissions(
        &state,
        &parent_channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL],
    )
    .await?;

    let threads = paracord_db::channels::get_archived_threads(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let result: Vec<Value> = threads.iter().map(channel_to_json).collect();
    Ok(Json(json!(result)))
}

pub async fn update_thread(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, thread_id)): Path<(i64, i64)>,
    Json(body): Json<UpdateThreadRequest>,
) -> Result<Json<Value>, ApiError> {
    if let Some(ref name) = body.name {
        if name.trim().is_empty() || name.len() > 100 {
            return Err(ApiError::BadRequest(
                "Thread name must be 1-100 characters".into(),
            ));
        }
        if contains_dangerous_markup(name) {
            return Err(ApiError::BadRequest(
                "Thread name contains unsafe markup".into(),
            ));
        }
    }

    let thread = paracord_db::channels::get_channel(&state.db, thread_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if thread.channel_type != 6 {
        return Err(ApiError::BadRequest("Channel is not a thread".into()));
    }
    if thread.parent_id != Some(channel_id) {
        return Err(ApiError::NotFound);
    }

    let parent_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let is_thread_owner = thread.owner_id == Some(auth.user_id);

    if (body.archived.is_some() || body.locked.is_some()) && !is_thread_owner {
        ensure_channel_permissions(
            &state,
            &parent_channel,
            auth.user_id,
            &[Permissions::MANAGE_CHANNELS],
        )
        .await?;
    }

    if body.name.is_some() && !is_thread_owner {
        ensure_channel_permissions(
            &state,
            &parent_channel,
            auth.user_id,
            &[Permissions::MANAGE_CHANNELS],
        )
        .await?;
    }

    let updated = paracord_db::channels::update_thread(
        &state.db,
        thread_id,
        body.name.as_deref(),
        body.archived,
        body.locked,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let thread_json = channel_to_json(&updated);
    let guild_id = updated.guild_id();

    state
        .event_bus
        .dispatch("THREAD_UPDATE", thread_json.clone(), guild_id);

    Ok(Json(thread_json))
}

pub async fn delete_thread(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, thread_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    let thread = paracord_db::channels::get_channel(&state.db, thread_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if thread.channel_type != 6 {
        return Err(ApiError::BadRequest("Channel is not a thread".into()));
    }
    if thread.parent_id != Some(channel_id) {
        return Err(ApiError::NotFound);
    }

    let parent_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    ensure_channel_permissions(
        &state,
        &parent_channel,
        auth.user_id,
        &[Permissions::MANAGE_CHANNELS],
    )
    .await?;

    let guild_id = thread.guild_id();

    paracord_db::channels::delete_channel(&state.db, thread_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    state.event_bus.dispatch(
        "THREAD_DELETE",
        json!({
            "id": thread_id.to_string(),
            "guild_id": guild_id.map(|id| id.to_string()),
            "parent_id": channel_id.to_string(),
        }),
        guild_id,
    );

    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_forum_posts(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(query): Query<ForumPostQuery>,
) -> Result<Json<Value>, ApiError> {
    let forum_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if forum_channel.channel_type != 7 {
        return Err(ApiError::BadRequest("Channel is not a forum".into()));
    }

    ensure_channel_permissions(
        &state,
        &forum_channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL],
    )
    .await?;

    let sort_order = query
        .sort_order
        .unwrap_or(forum_channel.default_sort_order.unwrap_or(0));
    let include_archived = query.include_archived.unwrap_or(false);

    let posts =
        paracord_db::channels::get_forum_posts(&state.db, channel_id, sort_order, include_archived)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let tags = paracord_db::channels::get_forum_tags(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(json!({
        "posts": posts.iter().map(channel_to_json).collect::<Vec<Value>>(),
        "tags": tags.iter().map(forum_tag_to_json).collect::<Vec<Value>>(),
        "sort_order": sort_order,
    })))
}

pub async fn create_forum_post(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<CreateForumPostRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let name = body.name.trim();
    if name.is_empty() || name.len() > 100 {
        return Err(ApiError::BadRequest(
            "Post title must be 1-100 characters".into(),
        ));
    }
    if contains_dangerous_markup(name) {
        return Err(ApiError::BadRequest(
            "Post title contains unsafe markup".into(),
        ));
    }

    let forum_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if forum_channel.channel_type != 7 {
        return Err(ApiError::BadRequest("Channel is not a forum".into()));
    }

    ensure_channel_permissions(
        &state,
        &forum_channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::SEND_MESSAGES],
    )
    .await?;

    let guild_id = forum_channel.guild_id().ok_or(ApiError::BadRequest(
        "Cannot create forum posts in DMs".into(),
    ))?;

    let applied_tags = match body.applied_tag_ids {
        Some(tags) => {
            let parsed = parse_role_id_strings(&tags)?
                .into_iter()
                .map(|id| id.to_string())
                .collect::<Vec<String>>();
            Some(
                serde_json::to_string(&parsed)
                    .map_err(|_| ApiError::BadRequest("Invalid applied_tag_ids".into()))?,
            )
        }
        None => None,
    };

    let post_id = paracord_util::snowflake::generate(1);
    let post = paracord_db::channels::create_forum_post(
        &state.db,
        post_id,
        guild_id,
        channel_id,
        name,
        auth.user_id,
        applied_tags.as_deref(),
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    if let Some(content) = body
        .content
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let message_id = paracord_util::snowflake::generate(1);
        let _ = paracord_db::messages::create_message(
            &state.db,
            message_id,
            post.id,
            auth.user_id,
            content,
            0,
            None,
        )
        .await;
        let _ = paracord_db::channels::increment_thread_message_count(&state.db, post.id).await;
    }

    let post_json = channel_to_json(&post);
    state
        .event_bus
        .dispatch("THREAD_CREATE", post_json.clone(), Some(guild_id));

    Ok((StatusCode::CREATED, Json(post_json)))
}

pub async fn create_forum_tag(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<CreateForumTagRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let name = body.name.trim();
    if name.is_empty() || name.len() > 30 {
        return Err(ApiError::BadRequest(
            "Tag name must be 1-30 characters".into(),
        ));
    }
    if contains_dangerous_markup(name) {
        return Err(ApiError::BadRequest(
            "Tag name contains unsafe markup".into(),
        ));
    }

    let forum_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if forum_channel.channel_type != 7 {
        return Err(ApiError::BadRequest("Channel is not a forum".into()));
    }

    ensure_channel_permissions(
        &state,
        &forum_channel,
        auth.user_id,
        &[Permissions::MANAGE_CHANNELS],
    )
    .await?;

    let tag = paracord_db::channels::create_forum_tag(
        &state.db,
        paracord_util::snowflake::generate(1),
        channel_id,
        name,
        body.emoji.as_deref(),
        body.moderated.unwrap_or(false),
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok((StatusCode::CREATED, Json(forum_tag_to_json(&tag))))
}

pub async fn list_forum_tags(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let forum_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if forum_channel.channel_type != 7 {
        return Err(ApiError::BadRequest("Channel is not a forum".into()));
    }
    ensure_channel_permissions(
        &state,
        &forum_channel,
        auth.user_id,
        &[Permissions::VIEW_CHANNEL],
    )
    .await?;

    let tags = paracord_db::channels::get_forum_tags(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!(tags
        .iter()
        .map(forum_tag_to_json)
        .collect::<Vec<Value>>())))
}

pub async fn delete_forum_tag(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, tag_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    let forum_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if forum_channel.channel_type != 7 {
        return Err(ApiError::BadRequest("Channel is not a forum".into()));
    }
    ensure_channel_permissions(
        &state,
        &forum_channel,
        auth.user_id,
        &[Permissions::MANAGE_CHANNELS],
    )
    .await?;

    let deleted = paracord_db::channels::delete_forum_tag(&state.db, tag_id, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !deleted {
        return Err(ApiError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_forum_sort_order(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<UpdateForumSortOrderRequest>,
) -> Result<StatusCode, ApiError> {
    if body.sort_order != 0 && body.sort_order != 1 {
        return Err(ApiError::BadRequest("sort_order must be 0 or 1".into()));
    }

    let forum_channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if forum_channel.channel_type != 7 {
        return Err(ApiError::BadRequest("Channel is not a forum".into()));
    }
    ensure_channel_permissions(
        &state,
        &forum_channel,
        auth.user_id,
        &[Permissions::MANAGE_CHANNELS],
    )
    .await?;

    paracord_db::channels::update_forum_sort_order(&state.db, channel_id, body.sort_order)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(StatusCode::NO_CONTENT)
}

// ── Federation message forwarding ────────────────────────────────────────────

/// Build a FederationService from environment variables (same pattern as the
/// federation routes use) and forward a message envelope to all trusted peers.
///
/// This function is designed to be called inside `tokio::spawn` so it never
/// returns errors -- all failures are logged.
async fn federation_forward_message(
    state: &AppState,
    message_id: i64,
    channel_id: i64,
    guild_id: i64,
    author_id: i64,
    content: &Value,
    timestamp_ms: i64,
) {
    // Look up the author's username for the federated identity
    let username = match paracord_db::users::get_user_by_id(&state.db, author_id).await {
        Ok(Some(user)) => user.username,
        Ok(None) => {
            tracing::warn!(
                "federation: cannot forward message {message_id}: author {author_id} not found"
            );
            return;
        }
        Err(e) => {
            tracing::error!("federation: db error looking up author {author_id}: {e}");
            return;
        }
    };

    // Build the federation service from env vars (matches pattern in routes/federation.rs)
    let service = crate::routes::federation::build_federation_service();
    if !service.is_enabled() {
        return;
    }
    let channel_meta = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .ok()
        .flatten();
    let guild_meta = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .ok()
        .flatten();
    let outbound = crate::routes::federation::resolve_outbound_context(
        state,
        &service,
        guild_id,
        Some(channel_id),
    )
    .await;

    let envelope = if outbound.uses_remote_mapping {
        let mut message_content = serde_json::json!({
            "body": content,
            "msgtype": "m.text",
            "guild_id": outbound.payload_guild_id,
            "channel_id": outbound
                .payload_channel_id
                .clone()
                .unwrap_or_else(|| channel_id.to_string()),
            "message_id": message_id.to_string(),
        });
        if let Some(name) = channel_meta
            .as_ref()
            .and_then(|channel| channel.name.as_deref())
        {
            message_content["channel_name"] = Value::String(name.to_string());
        }
        if let Some(kind) = channel_meta.as_ref().map(|channel| channel.channel_type) {
            message_content["channel_type"] = Value::Number(serde_json::Number::from(kind));
        }
        if let Some(name) = guild_meta.as_ref().map(|guild| guild.name.as_str()) {
            message_content["guild_name"] = Value::String(name.to_string());
        }
        match service.build_custom_envelope(
            "m.message",
            outbound.room_id.clone(),
            &username,
            &message_content,
            timestamp_ms,
            None,
            Some(&message_id.to_string()),
        ) {
            Ok(env) => env,
            Err(e) => {
                tracing::warn!(
                    "federation: failed to build mapped envelope for message {message_id}: {e}"
                );
                return;
            }
        }
    } else {
        match service.build_message_envelope(
            message_id,
            channel_id,
            guild_id,
            &username,
            content,
            channel_meta
                .as_ref()
                .and_then(|channel| channel.name.as_deref()),
            channel_meta.as_ref().map(|channel| channel.channel_type),
            guild_meta.as_ref().map(|guild| guild.name.as_str()),
            timestamp_ms,
        ) {
            Ok(env) => env,
            Err(e) => {
                tracing::warn!(
                    "federation: failed to build envelope for message {message_id}: {e}"
                );
                return;
            }
        }
    };

    // Also persist the event locally for federation event history
    if let Err(e) = service.persist_event(&state.db, &envelope).await {
        tracing::warn!(
            "federation: failed to persist outbound event {}: {e}",
            envelope.event_id
        );
    }

    service
        .forward_envelope_to_peers(&state.db, &envelope)
        .await;
}

/// Forward a generic federation event envelope to all trusted peers.
async fn federation_forward_generic(
    state: &AppState,
    event_type: &str,
    channel_id: i64,
    guild_id: i64,
    author_id: i64,
    content: &Value,
    timestamp_ms: i64,
    event_stable_id: Option<String>,
) {
    let username = match paracord_db::users::get_user_by_id(&state.db, author_id).await {
        Ok(Some(user)) => user.username,
        _ => return,
    };

    let service = crate::routes::federation::build_federation_service();
    if !service.is_enabled() {
        return;
    }

    let outbound = crate::routes::federation::resolve_outbound_context(
        state,
        &service,
        guild_id,
        Some(channel_id),
    )
    .await;

    let room_id = outbound.room_id.clone();
    let mut content_json = content.clone();
    if content_json
        .get("guild_id")
        .and_then(|v| v.as_str())
        .is_none()
    {
        content_json["guild_id"] = Value::String(outbound.payload_guild_id.clone());
    }
    if content_json
        .get("channel_id")
        .and_then(|v| v.as_str())
        .is_none()
    {
        content_json["channel_id"] = Value::String(
            outbound
                .payload_channel_id
                .clone()
                .unwrap_or_else(|| channel_id.to_string()),
        );
    }

    let envelope = match service.build_custom_envelope(
        event_type,
        room_id,
        &username,
        &content_json,
        timestamp_ms,
        None,
        event_stable_id.as_deref(),
    ) {
        Ok(env) => env,
        Err(_) => return,
    };

    let _ = service.persist_event(&state.db, &envelope).await;
    service
        .forward_envelope_to_peers(&state.db, &envelope)
        .await;
}
