use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;

fn parse_datetime(value: &str) -> Result<DateTime<Utc>, ApiError> {
    let parsed = DateTime::parse_from_rfc3339(value)
        .map_err(|_| ApiError::BadRequest("send_at must be RFC3339".into()))?;
    Ok(parsed.with_timezone(&Utc))
}

fn parse_optional_i64(raw: Option<&str>, field: &str) -> Result<Option<i64>, ApiError> {
    raw.map(|v| {
        v.parse::<i64>()
            .map_err(|_| ApiError::BadRequest(format!("Invalid {field}")))
    })
    .transpose()
}

async fn compute_channel_permissions(
    state: &AppState,
    channel: &paracord_db::channels::ChannelRow,
    user_id: i64,
) -> Result<Permissions, ApiError> {
    if let Some(guild_id) = channel.guild_id() {
        paracord_core::permissions::ensure_guild_member(&state.db, guild_id, user_id).await?;
        let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::NotFound)?;
        return paracord_core::permissions::compute_channel_permissions(
            &state.db,
            guild_id,
            channel.id,
            guild.owner_id,
            user_id,
        )
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())));
    }

    if !paracord_db::dms::is_dm_recipient(&state.db, channel.id, user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    {
        return Err(ApiError::Forbidden);
    }

    Ok(Permissions::VIEW_CHANNEL | Permissions::SEND_MESSAGES)
}

fn features_to_json(row: &paracord_db::channel_features::ChannelFeatureSettingsRow) -> Value {
    let slowmode_exempt_role_ids =
        paracord_db::channels::parse_required_role_ids(&row.slowmode_exempt_role_ids)
            .into_iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>();

    json!({
        "channel_id": row.channel_id.to_string(),
        "disappearing_seconds": row.disappearing_seconds,
        "anonymous_posting_enabled": row.anonymous_posting_enabled,
        "slowmode_exempt_role_ids": slowmode_exempt_role_ids,
        "adaptive_slowmode_enabled": row.adaptive_slowmode_enabled,
        "adaptive_slowmode_window_seconds": row.adaptive_slowmode_window_seconds,
        "adaptive_slowmode_threshold": row.adaptive_slowmode_threshold,
        "adaptive_slowmode_step_seconds": row.adaptive_slowmode_step_seconds,
        "thread_rate_limit_per_user": row.thread_rate_limit_per_user,
    })
}

#[derive(Deserialize)]
pub struct ChannelFeatureSettingsPatch {
    pub disappearing_seconds: Option<i32>,
    pub anonymous_posting_enabled: Option<bool>,
    pub slowmode_exempt_role_ids: Option<Vec<String>>,
    pub adaptive_slowmode_enabled: Option<bool>,
    pub adaptive_slowmode_window_seconds: Option<i32>,
    pub adaptive_slowmode_threshold: Option<i32>,
    pub adaptive_slowmode_step_seconds: Option<i32>,
    pub thread_rate_limit_per_user: Option<i32>,
}

pub async fn get_channel_feature_settings(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let perms = compute_channel_permissions(&state, &channel, auth.user_id).await?;
    paracord_core::permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;

    let row = paracord_db::channel_features::get_or_default(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(features_to_json(&row)))
}

pub async fn update_channel_feature_settings(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<ChannelFeatureSettingsPatch>,
) -> Result<Json<Value>, ApiError> {
    if let Some(seconds) = body.disappearing_seconds {
        if !(0..=2_592_000).contains(&seconds) {
            return Err(ApiError::BadRequest(
                "disappearing_seconds must be between 0 and 2592000".into(),
            ));
        }
    }
    if let Some(seconds) = body.thread_rate_limit_per_user {
        if !(0..=21_600).contains(&seconds) {
            return Err(ApiError::BadRequest(
                "thread_rate_limit_per_user must be between 0 and 21600".into(),
            ));
        }
    }
    if let Some(seconds) = body.adaptive_slowmode_window_seconds {
        if !(5..=600).contains(&seconds) {
            return Err(ApiError::BadRequest(
                "adaptive_slowmode_window_seconds must be between 5 and 600".into(),
            ));
        }
    }
    if let Some(threshold) = body.adaptive_slowmode_threshold {
        if !(1..=500).contains(&threshold) {
            return Err(ApiError::BadRequest(
                "adaptive_slowmode_threshold must be between 1 and 500".into(),
            ));
        }
    }
    if let Some(step) = body.adaptive_slowmode_step_seconds {
        if !(1..=120).contains(&step) {
            return Err(ApiError::BadRequest(
                "adaptive_slowmode_step_seconds must be between 1 and 120".into(),
            ));
        }
    }

    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let perms = compute_channel_permissions(&state, &channel, auth.user_id).await?;
    paracord_core::permissions::require_permission(perms, Permissions::MANAGE_CHANNELS)?;

    let slowmode_exempt_role_ids = body
        .slowmode_exempt_role_ids
        .as_ref()
        .map(|raw| {
            raw.iter()
                .map(|v| {
                    v.parse::<i64>()
                        .map_err(|_| ApiError::BadRequest("Invalid role id".into()))
                })
                .collect::<Result<Vec<_>, _>>()
                .map(|ids| paracord_db::channels::serialize_required_role_ids(&ids))
        })
        .transpose()?;

    let updated = paracord_db::channel_features::upsert_for_channel(
        &state.db,
        channel_id,
        paracord_db::channel_features::ChannelFeaturePatch {
            disappearing_seconds: body.disappearing_seconds,
            anonymous_posting_enabled: body.anonymous_posting_enabled,
            slowmode_exempt_role_ids: slowmode_exempt_role_ids.as_deref(),
            adaptive_slowmode_enabled: body.adaptive_slowmode_enabled,
            adaptive_slowmode_window_seconds: body.adaptive_slowmode_window_seconds,
            adaptive_slowmode_threshold: body.adaptive_slowmode_threshold,
            adaptive_slowmode_step_seconds: body.adaptive_slowmode_step_seconds,
            thread_rate_limit_per_user: body.thread_rate_limit_per_user,
        },
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(features_to_json(&updated)))
}

#[derive(Deserialize)]
pub struct ScheduledMessageRequest {
    pub content: Option<String>,
    pub e2ee: Option<Value>,
    pub nonce: Option<String>,
    pub send_at: String,
    pub reference_message_id: Option<String>,
}

fn scheduled_message_to_json(row: &paracord_db::scheduled_messages::ScheduledMessageRow) -> Value {
    json!({
        "id": row.id.to_string(),
        "channel_id": row.channel_id.to_string(),
        "author_id": row.author_id.to_string(),
        "content": row.content,
        "e2ee": row.e2ee_payload.as_ref().and_then(|raw| serde_json::from_str::<Value>(raw).ok()),
        "nonce": row.nonce,
        "reference_message_id": row.reference_id.map(|id| id.to_string()),
        "send_at": row.send_at.to_rfc3339(),
        "status": row.status,
        "error": row.error,
        "delivered_message_id": row.delivered_message_id.map(|id| id.to_string()),
        "created_at": row.created_at.to_rfc3339(),
        "updated_at": row.updated_at.to_rfc3339(),
    })
}

pub async fn create_scheduled_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<ScheduledMessageRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let perms = compute_channel_permissions(&state, &channel, auth.user_id).await?;
    paracord_core::permissions::require_permission(perms, Permissions::SEND_MESSAGES)?;

    let send_at = parse_datetime(&body.send_at)?;
    let min_send_at = Utc::now() + chrono::Duration::seconds(5);
    if send_at < min_send_at {
        return Err(ApiError::BadRequest(
            "send_at must be at least 5 seconds in the future".into(),
        ));
    }

    let content = body.content.unwrap_or_default();
    let content_trimmed = content.trim();
    if content_trimmed.is_empty() && body.e2ee.is_none() {
        return Err(ApiError::BadRequest(
            "Scheduled message requires content or e2ee payload".into(),
        ));
    }
    if content_trimmed.len() > 2000 {
        return Err(ApiError::BadRequest(
            "content must be at most 2000 characters".into(),
        ));
    }

    let e2ee_payload = body
        .e2ee
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| ApiError::BadRequest("Invalid e2ee payload".into()))?;

    let reference_id =
        parse_optional_i64(body.reference_message_id.as_deref(), "reference_message_id")?;
    if let Some(ref_id) = reference_id {
        let referenced = paracord_db::messages::get_message(&state.db, ref_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::BadRequest(
                "referenced_message_id does not exist".into(),
            ))?;
        if referenced.channel_id != channel_id {
            return Err(ApiError::BadRequest(
                "referenced_message_id must belong to this channel".into(),
            ));
        }
    }
    let row = paracord_db::scheduled_messages::create_scheduled_message(
        &state.db,
        paracord_util::snowflake::generate(1),
        channel_id,
        auth.user_id,
        if content_trimmed.is_empty() {
            None
        } else {
            Some(content_trimmed)
        },
        e2ee_payload.as_deref(),
        body.nonce.as_deref(),
        reference_id,
        send_at,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok((StatusCode::CREATED, Json(scheduled_message_to_json(&row))))
}

pub async fn list_scheduled_messages(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let perms = compute_channel_permissions(&state, &channel, auth.user_id).await?;
    paracord_core::permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;

    let rows = paracord_db::scheduled_messages::list_for_author_in_channel(
        &state.db,
        channel_id,
        auth.user_id,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!(rows
        .iter()
        .map(scheduled_message_to_json)
        .collect::<Vec<_>>())))
}

pub async fn delete_scheduled_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, scheduled_message_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let perms = compute_channel_permissions(&state, &channel, auth.user_id).await?;
    paracord_core::permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;

    let scheduled =
        paracord_db::scheduled_messages::get_scheduled_message(&state.db, scheduled_message_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::NotFound)?;
    if scheduled.channel_id != channel_id {
        return Err(ApiError::NotFound);
    }

    let can_manage = perms.contains(Permissions::MANAGE_MESSAGES)
        || perms.contains(Permissions::MANAGE_CHANNELS)
        || perms.contains(Permissions::MANAGE_GUILD);
    if scheduled.author_id != auth.user_id && !can_manage {
        return Err(ApiError::Forbidden);
    }

    let cancelled =
        paracord_db::scheduled_messages::cancel_scheduled_message(&state.db, scheduled_message_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if cancelled.is_none() {
        return Err(ApiError::Conflict(
            "Scheduled message can no longer be cancelled".into(),
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_scheduled_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, scheduled_message_id)): Path<(i64, i64)>,
    Json(body): Json<ScheduledMessageRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let perms = compute_channel_permissions(&state, &channel, auth.user_id).await?;
    paracord_core::permissions::require_permission(perms, Permissions::SEND_MESSAGES)?;

    let send_at = parse_datetime(&body.send_at)?;
    let min_send_at = Utc::now() + chrono::Duration::seconds(5);
    if send_at < min_send_at {
        return Err(ApiError::BadRequest(
            "send_at must be at least 5 seconds in the future".into(),
        ));
    }

    let content = body.content.unwrap_or_default();
    let content_trimmed = content.trim();
    if content_trimmed.is_empty() && body.e2ee.is_none() {
        return Err(ApiError::BadRequest(
            "Scheduled message requires content or e2ee payload".into(),
        ));
    }
    if content_trimmed.len() > 2000 {
        return Err(ApiError::BadRequest(
            "content must be at most 2000 characters".into(),
        ));
    }

    let e2ee_payload = body
        .e2ee
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| ApiError::BadRequest("Invalid e2ee payload".into()))?;

    let scheduled =
        paracord_db::scheduled_messages::get_scheduled_message(&state.db, scheduled_message_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::NotFound)?;
    if scheduled.channel_id != channel_id {
        return Err(ApiError::NotFound);
    }

    let can_manage = perms.contains(Permissions::MANAGE_MESSAGES)
        || perms.contains(Permissions::MANAGE_CHANNELS)
        || perms.contains(Permissions::MANAGE_GUILD);
    if scheduled.author_id != auth.user_id && !can_manage {
        return Err(ApiError::Forbidden);
    }

    let updated = paracord_db::scheduled_messages::update_scheduled_message(
        &state.db,
        scheduled_message_id,
        if content_trimmed.is_empty() {
            None
        } else {
            Some(content_trimmed)
        },
        e2ee_payload.as_deref(),
        body.nonce.as_deref(),
        send_at,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    .ok_or_else(|| ApiError::Conflict("Scheduled message can no longer be edited".into()))?;

    Ok((StatusCode::OK, Json(scheduled_message_to_json(&updated))))
}

pub async fn deanonymize_message(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, message_id)): Path<(i64, i64)>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let perms = compute_channel_permissions(&state, &channel, auth.user_id).await?;
    paracord_core::permissions::require_permission(perms, Permissions::MANAGE_MESSAGES)?;

    let row = paracord_db::anonymous_messages::get_anonymous_message(&state.db, message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if row.channel_id != channel_id {
        return Err(ApiError::NotFound);
    }

    let user = paracord_db::users::get_user_by_id(&state.db, row.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(json!({
        "message_id": row.message_id.to_string(),
        "channel_id": row.channel_id.to_string(),
        "user_id": row.user_id.to_string(),
        "alias": row.alias,
        "user": user.map(|u| json!({
            "id": u.id.to_string(),
            "username": u.username,
            "discriminator": u.discriminator,
            "avatar_hash": u.avatar_hash,
        })),
    })))
}

/// Cap on the envelopes one publish may carry.
///
/// The array was unbounded and every element cost a `SELECT` *and* an UPSERT —
/// a write — on a pooled connection, reachable by any participant in the DM. A
/// group DM is hard-capped at ten members (`add_group_dm_recipient`), so a real
/// rotation publishes at most nine envelopes; 32 leaves room for multi-device
/// recipients without letting a 2 MiB body become tens of thousands of writes.
const MAX_SENDER_KEY_ENVELOPES: usize = 32;

#[derive(Deserialize)]
pub struct GroupSenderKeysPostRequest {
    pub epoch: i32,
    pub envelopes: Vec<GroupSenderKeyEnvelope>,
}

#[derive(Deserialize)]
pub struct GroupSenderKeyEnvelope {
    pub recipient_id: String,
    pub ciphertext: String,
    pub header: Option<String>,
}

#[derive(Deserialize)]
pub struct GroupSenderKeysQuery {
    pub since_epoch: Option<i32>,
}

#[derive(Deserialize)]
pub struct GroupSenderKeyAckRequest {
    pub sender_id: Option<String>,
    pub up_to_epoch: Option<i32>,
}

pub async fn post_group_sender_keys(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<GroupSenderKeysPostRequest>,
) -> Result<StatusCode, ApiError> {
    if body.epoch < 0 {
        return Err(ApiError::BadRequest("epoch must be >= 0".into()));
    }
    if body.envelopes.is_empty() {
        return Err(ApiError::BadRequest("envelopes cannot be empty".into()));
    }
    // Bounded before any database work, so an over-long array never gets to
    // spend pool connections on its own validation.
    if body.envelopes.len() > MAX_SENDER_KEY_ENVELOPES {
        return Err(ApiError::BadRequest(format!(
            "at most {MAX_SENDER_KEY_ENVELOPES} envelopes may be published at once"
        )));
    }

    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if channel.guild_id().is_some() {
        return Err(ApiError::BadRequest(
            "group sender keys are currently supported for DM channels".into(),
        ));
    }
    // One read for the whole recipient set instead of one `is_dm_recipient` per
    // envelope; membership is then an in-memory test.
    let recipients = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !recipients.contains(&auth.user_id) {
        return Err(ApiError::Forbidden);
    }

    // Deduplicate by recipient. `upsert_sender_key` conflicts on
    // (channel, sender, recipient, epoch), so a repeated recipient only ever
    // left the last envelope stored — keeping the last one preserves that while
    // collapsing the repeats into a single write.
    let mut targets: Vec<(i64, &GroupSenderKeyEnvelope)> = Vec::with_capacity(body.envelopes.len());
    for envelope in &body.envelopes {
        let recipient_id = envelope
            .recipient_id
            .parse::<i64>()
            .map_err(|_| ApiError::BadRequest("Invalid recipient_id".into()))?;
        if recipient_id == auth.user_id {
            continue;
        }
        if !recipients.contains(&recipient_id) {
            return Err(ApiError::BadRequest(
                "recipient must be a member of the DM channel".into(),
            ));
        }
        match targets.iter_mut().find(|(id, _)| *id == recipient_id) {
            Some(slot) => slot.1 = envelope,
            None => targets.push((recipient_id, envelope)),
        }
    }

    for (recipient_id, envelope) in targets {
        paracord_db::group_e2ee::upsert_sender_key(
            &state.db,
            paracord_util::snowflake::generate(1),
            channel_id,
            auth.user_id,
            recipient_id,
            body.epoch,
            &envelope.ciphertext,
            envelope.header.as_deref(),
        )
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    }

    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_group_sender_keys(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(query): Query<GroupSenderKeysQuery>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if channel.guild_id().is_some() {
        return Err(ApiError::BadRequest(
            "group sender keys are currently supported for DM channels".into(),
        ));
    }
    if !paracord_db::dms::is_dm_recipient(&state.db, channel_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    {
        return Err(ApiError::Forbidden);
    }

    let rows = paracord_db::group_e2ee::list_pending_for_recipient(
        &state.db,
        channel_id,
        auth.user_id,
        query.since_epoch,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(json!({
        "sender_keys": rows.into_iter().map(|row| json!({
            "id": row.id.to_string(),
            "channel_id": row.channel_id.to_string(),
            "sender_id": row.sender_id.to_string(),
            "recipient_id": row.recipient_id.to_string(),
            "epoch": row.epoch,
            "ciphertext": row.ciphertext,
            "header": row.header,
            "created_at": row.created_at.to_rfc3339(),
        })).collect::<Vec<_>>(),
    })))
}

pub async fn ack_group_sender_keys(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<GroupSenderKeyAckRequest>,
) -> Result<Json<Value>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if channel.guild_id().is_some() {
        return Err(ApiError::BadRequest(
            "group sender keys are currently supported for DM channels".into(),
        ));
    }
    if !paracord_db::dms::is_dm_recipient(&state.db, channel_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    {
        return Err(ApiError::Forbidden);
    }

    let sender_id = parse_optional_i64(body.sender_id.as_deref(), "sender_id")?;
    let updated = paracord_db::group_e2ee::acknowledge_sender_keys(
        &state.db,
        channel_id,
        auth.user_id,
        sender_id,
        body.up_to_epoch,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(json!({ "acknowledged": updated })))
}
