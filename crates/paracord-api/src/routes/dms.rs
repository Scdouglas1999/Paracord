use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use paracord_core::AppState;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;

#[derive(Debug, Deserialize)]
pub struct CreateDmRequest {
    pub recipient_id: String,
}

#[derive(Debug, Deserialize, Default)]
pub struct DmVoiceJoinQuery {
    pub fallback: Option<String>,
}

pub async fn list_dms(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    // Fetch regular DMs (type 1)
    let dms = paracord_db::dms::list_user_dm_channels(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // Fetch group DMs (type 3)
    let group_dms = paracord_db::dms::list_user_group_dm_channels(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let mut result: Vec<Value> = dms
        .iter()
        .map(|c| {
            json!({
                "id": c.id.to_string(),
                "type": c.channel_type,
                "channel_type": c.channel_type,
                "guild_id": null,
                "name": null,
                "last_message_id": c.last_message_id.map(|id| id.to_string()),
                "recipient": {
                    "id": c.recipient_id.to_string(),
                    "username": c.recipient_username,
                    "display_name": c.recipient_display_name,
                    "discriminator": c.recipient_discriminator,
                    "avatar_hash": c.recipient_avatar_hash,
                    "public_key": c.recipient_public_key,
                }
            })
        })
        .collect();

    // Append group DMs with their recipients loaded (one batch query).
    let group_ids: Vec<i64> = group_dms.iter().map(|g| g.id).collect();
    let recipients_by_channel =
        paracord_db::dms::list_group_dm_recipients_for_channels(&state.db, &group_ids)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    for g in &group_dms {
        let recipients = recipients_by_channel.get(&g.id);
        let recipients_json: Vec<Value> = recipients
            .map(|list| {
                list.iter()
                    .map(|r| {
                        json!({
                            "id": r.user_id.to_string(),
                            "username": r.username,
                            "display_name": r.display_name,
                            "discriminator": r.discriminator,
                            "avatar_hash": r.avatar_hash,
                            "public_key": r.public_key,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        result.push(json!({
            "id": g.id.to_string(),
            "type": g.channel_type,
            "channel_type": g.channel_type,
            "guild_id": null,
            "name": g.name,
            "owner_id": g.owner_id.map(|id| id.to_string()),
            "last_message_id": g.last_message_id.map(|id| id.to_string()),
            "recipients": recipients_json,
        }));
    }

    Ok(Json(json!(result)))
}

pub async fn create_dm(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<CreateDmRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let recipient_id: i64 = body
        .recipient_id
        .parse()
        .map_err(|_| ApiError::BadRequest("Invalid recipient_id".into()))?;

    if recipient_id == auth.user_id {
        return Err(ApiError::BadRequest(
            "Cannot create a DM channel with yourself".into(),
        ));
    }

    let blocked = paracord_db::relationships::is_blocked_either_direction(
        &state.db,
        auth.user_id,
        recipient_id,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if blocked {
        return Err(ApiError::Forbidden);
    }

    let are_friends =
        paracord_db::relationships::are_friends(&state.db, auth.user_id, recipient_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let share_guild = paracord_db::members::share_any_guild(&state.db, auth.user_id, recipient_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !are_friends && !share_guild {
        return Err(ApiError::Forbidden);
    }

    let recipient = paracord_db::users::get_user_by_id(&state.db, recipient_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let channel = if let Some(existing) =
        paracord_db::dms::find_dm_channel_between(&state.db, auth.user_id, recipient_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    {
        existing
    } else {
        let channel_id = paracord_util::snowflake::generate(1);
        paracord_db::dms::create_dm_channel(&state.db, channel_id, auth.user_id, recipient_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    };

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": channel.id.to_string(),
            "type": channel.channel_type,
            "channel_type": channel.channel_type,
            "guild_id": null,
            "name": null,
            "last_message_id": channel.last_message_id.map(|id| id.to_string()),
            "recipient": {
                "id": recipient.id.to_string(),
                "username": recipient.username,
                "display_name": recipient.display_name,
                "discriminator": recipient.discriminator,
                "avatar_hash": recipient.avatar_hash,
                "public_key": recipient.public_key,
            }
        })),
    ))
}

// ──────────────────────────────────────────────────────────────────────────────
// Group DM endpoints
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateGroupDmRequest {
    /// User IDs of the initial recipients (not including the caller).
    pub recipient_ids: Vec<String>,
    pub name: Option<String>,
}

/// POST /users/@me/channels — create a group DM with multiple recipients.
pub async fn create_group_dm(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<CreateGroupDmRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if body.recipient_ids.is_empty() {
        return Err(ApiError::BadRequest(
            "At least one recipient_id is required".into(),
        ));
    }
    if body.recipient_ids.len() > 9 {
        return Err(ApiError::BadRequest(
            "Group DMs may have at most 10 members (including you)".into(),
        ));
    }

    let mut recipient_ids: Vec<i64> = Vec::with_capacity(body.recipient_ids.len());
    for raw in &body.recipient_ids {
        let uid: i64 = raw
            .parse()
            .map_err(|_| ApiError::BadRequest(format!("Invalid recipient_id: {raw}")))?;
        if uid == auth.user_id {
            continue; // skip self
        }
        recipient_ids.push(uid);
    }
    recipient_ids.dedup();

    // Verify all recipients exist and that the caller is permitted to add each
    // of them: honor block-lists in either direction and require a friend or
    // shared-guild relationship, mirroring the 1:1 create_dm consent gate.
    for &uid in &recipient_ids {
        paracord_db::users::get_user_by_id(&state.db, uid)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::NotFound)?;

        let blocked =
            paracord_db::relationships::is_blocked_either_direction(&state.db, auth.user_id, uid)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        if blocked {
            return Err(ApiError::Forbidden);
        }

        let are_friends = paracord_db::relationships::are_friends(&state.db, auth.user_id, uid)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        let share_guild = paracord_db::members::share_any_guild(&state.db, auth.user_id, uid)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        if !are_friends && !share_guild {
            return Err(ApiError::Forbidden);
        }
    }

    let channel_id = paracord_util::snowflake::generate(1);
    let channel = paracord_db::dms::create_group_dm_channel(
        &state.db,
        channel_id,
        body.name.as_deref(),
        auth.user_id,
        &recipient_ids,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let recipients = paracord_db::dms::list_group_dm_recipients(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let recipients_json: Vec<Value> = recipients
        .iter()
        .map(|r| {
            json!({
                "id": r.user_id.to_string(),
                "username": r.username,
                "display_name": r.display_name,
                "discriminator": r.discriminator,
                "avatar_hash": r.avatar_hash,
                "public_key": r.public_key,
            })
        })
        .collect();

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": channel.id.to_string(),
            "type": channel.channel_type,
            "channel_type": channel.channel_type,
            "guild_id": null,
            "name": channel.name,
            "owner_id": channel.owner_id.map(|id| id.to_string()),
            "last_message_id": channel.last_message_id.map(|id| id.to_string()),
            "recipients": recipients_json,
        })),
    ))
}

/// PUT /channels/{channel_id}/recipients/{user_id} — add a recipient to a group DM.
pub async fn add_group_dm_recipient(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, user_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    // Only group DMs (type 3) may gain recipients — a 1:1 DM (type 1) must not be
    // mutated into a multi-party channel, mirroring remove_group_dm_recipient.
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if channel.channel_type != 3 {
        return Err(ApiError::BadRequest("Not a group DM channel".into()));
    }

    // Verify caller is a recipient
    let is_member = paracord_db::dms::is_dm_recipient(&state.db, channel_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !is_member {
        return Err(ApiError::Forbidden);
    }

    // Verify the target user exists
    paracord_db::users::get_user_by_id(&state.db, user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    // Honor block-lists and the friend/shared-guild consent gate, mirroring
    // create_dm — a blocking user must not be pullable into a group DM.
    let blocked =
        paracord_db::relationships::is_blocked_either_direction(&state.db, auth.user_id, user_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if blocked {
        return Err(ApiError::Forbidden);
    }

    let are_friends = paracord_db::relationships::are_friends(&state.db, auth.user_id, user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let share_guild = paracord_db::members::share_any_guild(&state.db, auth.user_id, user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !are_friends && !share_guild {
        return Err(ApiError::Forbidden);
    }

    // Count current members to enforce group size limit
    let current_members = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if current_members.len() >= 10 {
        return Err(ApiError::BadRequest(
            "Group DMs may have at most 10 members".into(),
        ));
    }

    paracord_db::dms::add_group_dm_recipient(&state.db, channel_id, user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /channels/{channel_id}/recipients/{user_id} — remove a recipient from a group DM.
pub async fn remove_group_dm_recipient(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((channel_id, user_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    // Only the channel owner or the user themselves can remove a recipient
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if channel.channel_type != 3 {
        return Err(ApiError::BadRequest("Not a group DM channel".into()));
    }

    let is_owner = channel.owner_id == Some(auth.user_id);
    let is_self = auth.user_id == user_id;
    if !is_owner && !is_self {
        return Err(ApiError::Forbidden);
    }

    let removed = paracord_db::dms::remove_group_dm_recipient(&state.db, channel_id, user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    if !removed {
        return Err(ApiError::NotFound);
    }

    Ok(StatusCode::NO_CONTENT)
}

/// GET /channels/{channel_id}/recipients — list recipients of a group DM.
pub async fn list_group_dm_recipients(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let is_member = paracord_db::dms::is_dm_recipient(&state.db, channel_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !is_member {
        return Err(ApiError::Forbidden);
    }

    let recipients = paracord_db::dms::list_group_dm_recipients(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let result: Vec<Value> = recipients
        .iter()
        .map(|r| {
            json!({
                "id": r.user_id.to_string(),
                "username": r.username,
                "display_name": r.display_name,
                "discriminator": r.discriminator,
                "avatar_hash": r.avatar_hash,
                "public_key": r.public_key,
            })
        })
        .collect();

    Ok(Json(json!(result)))
}

/// Join a voice call on a DM channel (type 1) or group DM channel (type 3).
/// Creates a temporary LiveKit room scoped to the DM channel.
pub async fn join_dm_voice(
    State(state): State<AppState>,
    auth: AuthUser,
    headers: HeaderMap,
    Path(channel_id): Path<i64>,
    Query(query): Query<DmVoiceJoinQuery>,
) -> Result<Json<Value>, ApiError> {
    if !state.config.livekit_available && !state.config.native_media_enabled {
        return Err(ApiError::ServiceUnavailable(
            "Voice is not available on this server".into(),
        ));
    }

    // Verify the channel exists and is a DM or group DM
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if channel.channel_type != 1 && channel.channel_type != 3 {
        return Err(ApiError::BadRequest("Not a DM channel".into()));
    }

    // Verify the user is a participant in this DM
    let is_recipient = paracord_db::dms::is_dm_recipient(&state.db, channel_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !is_recipient {
        return Err(ApiError::Forbidden);
    }

    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let recipient_ids = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // Native media path
    let requesting_livekit_fallback = query.fallback.as_deref() == Some("livekit");
    if state.config.native_media_enabled && !requesting_livekit_fallback {
        let session_id = uuid::Uuid::new_v4().to_string();
        let room_name = format!("0:{}", channel_id);
        paracord_db::voice_states::upsert_voice_state(
            &state.db,
            auth.user_id,
            None,
            channel_id,
            &session_id,
        )
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

        if let Some(native_media) = state.native_media.as_ref() {
            if let Err(err) = native_media.rooms.join_room(
                0,
                channel_id,
                paracord_relay::participant::MediaParticipant::new(
                    auth.user_id,
                    session_id.clone(),
                ),
            ) {
                let _ = paracord_db::voice_states::remove_voice_state_if_session(
                    &state.db,
                    auth.user_id,
                    None,
                    &session_id,
                )
                .await;
                return Err(match err {
                    paracord_relay::room::RoomError::RoomFull(_) => {
                        ApiError::BadRequest("Voice channel is full".into())
                    }
                    other => ApiError::Internal(anyhow::anyhow!(other.to_string())),
                });
            }
        }

        let (media_endpoint, media_endpoint_candidates) =
            super::voice::native_media_endpoints(&headers, state.config.native_media_port);

        let issued_at = chrono::Utc::now().timestamp();
        let media_claims = json!({
            "sub": auth.user_id,
            "sid": &session_id,
            "auth_sid": auth.session_id.as_deref(),
            "iat": issued_at,
            "exp": issued_at + 86400,
            "session_id": &session_id,
            "auth_session_id": auth.session_id.as_deref(),
            "room": &room_name,
        });
        let media_token = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
            &media_claims,
            &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
        )
        .unwrap_or_default();

        let cert_hash = state.native_media.as_ref().map(|nm| nm.cert_hash.clone());

        state.event_bus.dispatch_to_users(
            "VOICE_STATE_UPDATE",
            json!({
                "user_id": auth.user_id.to_string(),
                "channel_id": channel_id.to_string(),
                "guild_id": null,
                "session_id": &session_id,
                "self_mute": false,
                "self_deaf": false,
                "self_stream": false,
                "self_video": false,
                "suppress": false,
                "mute": false,
                "deaf": false,
                "username": &user.username,
                "display_name": &user.display_name,
                "avatar_hash": user.avatar_hash,
            }),
            recipient_ids,
        );

        return Ok(Json(json!({
            "native_media": true,
            "media_endpoint": media_endpoint,
            "media_endpoint_candidates": media_endpoint_candidates,
            "media_token": media_token,
            "cert_hash": cert_hash,
            "room_name": room_name,
            "session_id": session_id,
            "livekit_available": state.config.livekit_available,
        })));
    }

    if !state.config.livekit_available {
        return Err(ApiError::ServiceUnavailable(
            "LiveKit voice is not available on this server".into(),
        ));
    }

    let session_id = uuid::Uuid::new_v4().to_string();

    // Use guild_id=0 for DM voice rooms; room name scoped to DM channel
    let join_resp = state
        .voice
        .join_channel(
            channel_id,
            0, // no guild for DMs
            auth.user_id,
            &user.username,
            &session_id,
            true,
            paracord_media::AudioBitrate::default(),
        )
        .await
        .map_err(ApiError::Internal)?;

    // Dispatch voice state update to DM recipients only.
    state.event_bus.dispatch_to_users(
        "VOICE_STATE_UPDATE",
        json!({
            "user_id": auth.user_id.to_string(),
            "channel_id": channel_id.to_string(),
            "guild_id": null,
            "session_id": &session_id,
            "self_mute": false,
            "self_deaf": false,
            "self_stream": false,
            "self_video": false,
            "suppress": false,
            "mute": false,
            "deaf": false,
            "username": &user.username,
            "display_name": &user.display_name,
            "avatar_hash": user.avatar_hash,
        }),
        recipient_ids,
    );

    let url_candidates =
        super::voice::livekit_url_candidates_pub(&headers, &state.config.livekit_public_url);
    let livekit_url = url_candidates
        .first()
        .cloned()
        .unwrap_or_else(|| state.config.livekit_public_url.clone());

    Ok(Json(json!({
        "token": join_resp.token,
        "url": livekit_url,
        "url_candidates": url_candidates,
        "room_name": join_resp.room_name,
        "session_id": session_id,
    })))
}

/// Leave a DM voice call.
pub async fn leave_dm_voice(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    // Verify the channel exists and is a DM or group DM
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if channel.channel_type != 1 && channel.channel_type != 3 {
        return Err(ApiError::BadRequest("Not a DM channel".into()));
    }

    let is_recipient = paracord_db::dms::is_dm_recipient(&state.db, channel_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !is_recipient {
        return Err(ApiError::Forbidden);
    }
    let recipient_ids = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let active_dm_voice =
        paracord_db::voice_states::get_user_voice_session(&state.db, auth.user_id, None)
            .await
            .ok()
            .flatten();
    let left_active_native_voice = active_dm_voice
        .as_ref()
        .is_some_and(|state| state.channel_id == channel_id);
    if left_active_native_voice {
        let _ = paracord_db::voice_states::remove_voice_state(&state.db, auth.user_id, None).await;
    }

    if let Some(native_media) = state.native_media.as_ref() {
        let _ = native_media.rooms.leave_room(0, channel_id, auth.user_id);
    }

    let participants = state.voice.leave_room(channel_id, auth.user_id).await;
    let left_livekit_voice = participants.is_some();
    if let Some(current) = participants {
        if current.is_empty() {
            let voice = state.voice.clone();
            tokio::spawn(async move {
                let _ = voice.cleanup_room(channel_id).await;
            });
        }
    }

    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .ok()
        .flatten();
    if left_active_native_voice || left_livekit_voice {
        state.event_bus.dispatch_to_users(
            "VOICE_STATE_UPDATE",
            json!({
                "user_id": auth.user_id.to_string(),
                "channel_id": null,
                "guild_id": null,
                "self_mute": false,
                "self_deaf": false,
                "self_stream": false,
                "self_video": false,
                "suppress": false,
                "mute": false,
                "deaf": false,
                "username": user.as_ref().map(|u| u.username.as_str()),
                "display_name": user.as_ref().and_then(|u| u.display_name.as_deref()),
                "avatar_hash": user.as_ref().and_then(|u| u.avatar_hash.as_deref()),
            }),
            recipient_ids,
        );
    }

    Ok(StatusCode::NO_CONTENT)
}
