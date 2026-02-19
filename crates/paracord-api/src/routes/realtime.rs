use axum::{
    extract::{Query, State},
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use chrono::Utc;
use futures_util::stream;
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::time::Duration;
use uuid::Uuid;

use crate::error::ApiError;
use crate::middleware::AuthUser;

#[derive(Deserialize)]
pub struct RealtimeEventsQuery {
    pub session_id: Option<String>,
    pub cursor: Option<u64>,
}

#[derive(Deserialize)]
pub struct RealtimeCommandRequest {
    pub command_id: String,
    #[serde(rename = "type")]
    pub command_type: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Deserialize)]
struct VoiceStateCommandPayload {
    guild_id: Option<String>,
    channel_id: Option<String>,
    self_mute: Option<bool>,
    self_deaf: Option<bool>,
}

#[derive(Deserialize)]
struct TypingStartCommandPayload {
    channel_id: String,
}

fn parse_i64_id(raw: Option<&str>) -> Option<i64> {
    raw.and_then(|v| v.parse::<i64>().ok())
}

async fn build_ready_payload(state: &AppState, user_id: i64, session_id: &str) -> Value {
    let user = paracord_db::users::get_user_by_id(&state.db, user_id)
        .await
        .ok()
        .flatten();
    let user_json = if let Some(u) = user {
        json!({
            "id": u.id.to_string(),
            "username": u.username,
            "discriminator": u.discriminator,
            "avatar_hash": u.avatar_hash,
            "display_name": u.display_name,
        })
    } else {
        json!({
            "id": user_id.to_string(),
        })
    };

    let guild_rows = paracord_db::guilds::get_user_guilds(&state.db, user_id)
        .await
        .unwrap_or_default();
    let mut guilds_json = Vec::with_capacity(guild_rows.len());
    for guild in guild_rows {
        let member_count = paracord_db::members::get_member_count(&state.db, guild.id)
            .await
            .unwrap_or(0);
        let voice_states = paracord_db::voice_states::get_guild_voice_states(&state.db, guild.id)
            .await
            .unwrap_or_default();
        let voice_states_json: Vec<Value> = voice_states
            .iter()
            .map(|vs| {
                json!({
                    "user_id": vs.user_id.to_string(),
                    "channel_id": vs.channel_id.to_string(),
                    "guild_id": vs.guild_id().map(|id| id.to_string()),
                    "session_id": &vs.session_id,
                    "self_mute": vs.self_mute,
                    "self_deaf": vs.self_deaf,
                    "self_stream": vs.self_stream,
                    "self_video": vs.self_video,
                    "suppress": vs.suppress,
                    "mute": false,
                    "deaf": false,
                    "username": &vs.username,
                    "avatar_hash": &vs.avatar_hash,
                })
            })
            .collect();

        guilds_json.push(json!({
            "id": guild.id.to_string(),
            "name": guild.name,
            "owner_id": guild.owner_id.to_string(),
            "icon_hash": guild.icon_hash,
            "member_count": member_count,
            "channels": [],
            "voice_states": voice_states_json,
            "presences": [],
            "lazy": true,
        }));
    }

    json!({
        "event_id": 1u64,
        "op": 0,
        "t": "READY",
        "s": 1u64,
        "d": {
            "user": user_json,
            "guilds": guilds_json,
            "session_id": session_id,
        }
    })
}

struct RealtimeStreamState {
    app_state: AppState,
    session_id: String,
    user_id: i64,
    sequence: u64,
    ready_payload: Option<String>,
    receiver: tokio::sync::broadcast::Receiver<paracord_core::events::ServerEvent>,
}

impl Drop for RealtimeStreamState {
    fn drop(&mut self) {
        self.app_state.event_bus.unregister_session(&self.session_id);
    }
}

pub async fn create_session(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let session_id = auth
        .session_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let guild_ids: Vec<i64> = paracord_db::guilds::get_user_guilds(&state.db, auth.user_id)
        .await
        .unwrap_or_default()
        .iter()
        .map(|g| g.id)
        .collect();
    Ok(Json(json!({
        "session_id": session_id,
        "cursor": 0,
        "user_id": auth.user_id.to_string(),
        "guild_ids": guild_ids.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
        "mode": "sse_http_v2",
    })))
}

pub async fn stream_events(
    State(state): State<AppState>,
    auth: AuthUser,
    Query(query): Query<RealtimeEventsQuery>,
) -> Result<Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let session_id = query
        .session_id
        .filter(|sid| !sid.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let guild_ids: Vec<i64> = paracord_db::guilds::get_user_guilds(&state.db, auth.user_id)
        .await
        .unwrap_or_default()
        .iter()
        .map(|g| g.id)
        .collect();
    let receiver = state
        .event_bus
        .register_session(session_id.clone(), auth.user_id, &guild_ids);
    let start_sequence = query.cursor.unwrap_or(0);
    let ready_payload = build_ready_payload(&state, auth.user_id, &session_id)
        .await
        .to_string();
    let stream_state = RealtimeStreamState {
        app_state: state,
        session_id,
        user_id: auth.user_id,
        sequence: start_sequence,
        ready_payload: Some(ready_payload),
        receiver,
    };

    let event_stream = stream::unfold(stream_state, |mut st| async move {
        if let Some(payload) = st.ready_payload.take() {
            let event = Event::default().event("gateway").id("1").data(payload);
            return Some((Ok(event), st));
        }

        loop {
            match st.receiver.recv().await {
                Ok(event) => {
                    if event.event_type == "GUILD_MEMBER_ADD" {
                        if let Some(uid) = event.payload.get("user_id").and_then(|v| v.as_str()) {
                            if uid == st.user_id.to_string() {
                                if let Some(gid) = event
                                    .payload
                                    .get("guild_id")
                                    .and_then(|v| v.as_str())
                                    .and_then(|s| s.parse::<i64>().ok())
                                {
                                    st.app_state.event_bus.add_session_guild(&st.session_id, gid);
                                }
                            }
                        }
                    } else if event.event_type == "GUILD_MEMBER_REMOVE"
                        || event.event_type == "GUILD_BAN_ADD"
                    {
                        if let Some(uid) = event.payload.get("user_id").and_then(|v| v.as_str()) {
                            if uid == st.user_id.to_string() {
                                if let Some(gid) = event
                                    .payload
                                    .get("guild_id")
                                    .and_then(|v| v.as_str())
                                    .and_then(|s| s.parse::<i64>().ok())
                                {
                                    st.app_state
                                        .event_bus
                                        .remove_session_guild(&st.session_id, gid);
                                }
                            }
                        }
                    } else if event.event_type == "GUILD_DELETE" {
                        if let Some(gid) = event
                            .payload
                            .get("id")
                            .or_else(|| event.payload.get("guild_id"))
                            .and_then(|v| v.as_str())
                            .and_then(|s| s.parse::<i64>().ok())
                        {
                            st.app_state
                                .event_bus
                                .remove_session_guild(&st.session_id, gid);
                        }
                    }
                    st.sequence = st.sequence.saturating_add(1);
                    let event_data = if let Some(serialized) = event.serialized_payload {
                        format!(
                            r#"{{"event_id":{},"op":0,"t":"{}","s":{},"d":{}}}"#,
                            st.sequence, event.event_type, st.sequence, serialized
                        )
                    } else {
                        json!({
                            "event_id": st.sequence,
                            "op": 0,
                            "t": event.event_type,
                            "s": st.sequence,
                            "d": *event.payload,
                        })
                        .to_string()
                    };
                    let sse_event = Event::default()
                        .event("gateway")
                        .id(st.sequence.to_string())
                        .data(event_data);
                    return Some((Ok(sse_event), st));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    st.sequence = st.sequence.saturating_add(1);
                    let reconnect = json!({
                        "event_id": st.sequence,
                        "op": 7,
                        "d": {
                            "reason": "lagged",
                            "skipped": skipped,
                        }
                    })
                    .to_string();
                    let sse_event = Event::default()
                        .event("gateway")
                        .id(st.sequence.to_string())
                        .data(reconnect);
                    return Some((Ok(sse_event), st));
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    return None;
                }
            }
        }
    });

    Ok(Sse::new(event_stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

pub async fn post_command(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<RealtimeCommandRequest>,
) -> Result<Json<Value>, ApiError> {
    if req.command_id.trim().is_empty() {
        return Err(ApiError::BadRequest("command_id is required".into()));
    }

    match req.command_type.as_str() {
        "presence_update" => {
            let status = req
                .payload
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("online");
            let activities = req
                .payload
                .get("activities")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let custom_status = req
                .payload
                .get("custom_status")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let presence_payload = json!({
                "user_id": auth.user_id.to_string(),
                "status": status,
                "custom_status": custom_status,
                "activities": activities,
            });
            state
                .user_presences
                .write()
                .await
                .insert(auth.user_id, presence_payload.clone());

            let mut recipients: std::collections::HashSet<i64> = std::collections::HashSet::new();
            recipients.insert(auth.user_id);
            if let Ok(guilds) = paracord_db::guilds::get_user_guilds(&state.db, auth.user_id).await {
                for guild in guilds {
                    if let Ok(member_ids) =
                        paracord_db::members::get_guild_member_user_ids(&state.db, guild.id).await
                    {
                        recipients.extend(member_ids);
                    }
                }
            }
            if let Ok(friend_ids) =
                paracord_db::relationships::get_friend_user_ids(&state.db, auth.user_id).await
            {
                recipients.extend(friend_ids);
            }
            state.event_bus.dispatch_to_users(
                "PRESENCE_UPDATE",
                presence_payload,
                recipients.into_iter().collect(),
            );
        }
        "voice_state_update" => {
            let payload: VoiceStateCommandPayload = serde_json::from_value(req.payload.clone())
                .map_err(|e| ApiError::BadRequest(format!("invalid voice_state_update payload: {e}")))?;
            let requested_guild_id = parse_i64_id(payload.guild_id.as_deref());
            let channel_id = parse_i64_id(payload.channel_id.as_deref());
            let self_mute = payload.self_mute.unwrap_or(false);
            let self_deaf = payload.self_deaf.unwrap_or(false);

            if let Some(channel_id) = channel_id {
                let channel = paracord_db::channels::get_channel(&state.db, channel_id)
                    .await
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                    .ok_or(ApiError::NotFound)?;
                if channel.channel_type != 2 {
                    return Err(ApiError::BadRequest("Not a voice channel".into()));
                }
                let guild_id = channel.guild_id().ok_or(ApiError::BadRequest(
                    "Voice is only supported in guild channels".into(),
                ))?;
                if requested_guild_id.is_some() && requested_guild_id != Some(guild_id) {
                    return Err(ApiError::BadRequest("guild_id/channel_id mismatch".into()));
                }
                paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id)
                    .await?;
                let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
                    .await
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                    .ok_or(ApiError::NotFound)?;
                let perms = paracord_core::permissions::compute_channel_permissions(
                    &state.db,
                    guild_id,
                    channel_id,
                    guild.owner_id,
                    auth.user_id,
                )
                .await?;
                if !perms.contains(Permissions::VIEW_CHANNEL) || !perms.contains(Permissions::CONNECT)
                {
                    return Err(ApiError::Forbidden);
                }

                let session_id = auth
                    .session_id
                    .clone()
                    .unwrap_or_else(|| Uuid::new_v4().to_string());
                let _ = paracord_db::voice_states::upsert_voice_state(
                    &state.db,
                    auth.user_id,
                    Some(guild_id),
                    channel_id,
                    &session_id,
                )
                .await;
                state
                    .voice
                    .update_self_mute(channel_id, auth.user_id, self_mute)
                    .await;
                state
                    .voice
                    .update_self_deaf(channel_id, auth.user_id, self_deaf)
                    .await;

                let current_self_stream = state
                    .voice
                    .get_participant_stream_state(channel_id, auth.user_id)
                    .await;
                let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
                    .await
                    .ok()
                    .flatten();
                state.event_bus.dispatch(
                    "VOICE_STATE_UPDATE",
                    json!({
                        "user_id": auth.user_id.to_string(),
                        "channel_id": channel_id.to_string(),
                        "guild_id": Some(guild_id.to_string()),
                        "self_mute": self_mute,
                        "self_deaf": self_deaf,
                        "self_stream": current_self_stream,
                        "self_video": false,
                        "suppress": false,
                        "mute": false,
                        "deaf": false,
                        "username": user.as_ref().map(|u| u.username.as_str()),
                        "avatar_hash": user.as_ref().and_then(|u| u.avatar_hash.as_deref()),
                    }),
                    Some(guild_id),
                );
            } else {
                let existing = paracord_db::voice_states::get_user_voice_state(
                    &state.db,
                    auth.user_id,
                    requested_guild_id,
                )
                .await
                .ok()
                .flatten();
                if let Some(existing_state) = existing {
                    let _ = paracord_db::voice_states::remove_voice_state(
                        &state.db,
                        auth.user_id,
                        existing_state.guild_id(),
                    )
                    .await;
                    let _ = state
                        .voice
                        .leave_room(existing_state.channel_id, auth.user_id)
                        .await;
                    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
                        .await
                        .ok()
                        .flatten();
                    state.event_bus.dispatch(
                        "VOICE_STATE_UPDATE",
                        json!({
                            "user_id": auth.user_id.to_string(),
                            "channel_id": Value::Null,
                            "guild_id": existing_state.guild_id().map(|id| id.to_string()),
                            "self_mute": self_mute,
                            "self_deaf": self_deaf,
                            "self_stream": false,
                            "self_video": false,
                            "suppress": false,
                            "mute": false,
                            "deaf": false,
                            "username": user.as_ref().map(|u| u.username.as_str()),
                            "avatar_hash": user.as_ref().and_then(|u| u.avatar_hash.as_deref()),
                        }),
                        existing_state.guild_id(),
                    );
                }
            }
        }
        "typing_start" => {
            let payload: TypingStartCommandPayload = serde_json::from_value(req.payload.clone())
                .map_err(|e| ApiError::BadRequest(format!("invalid typing_start payload: {e}")))?;
            let channel_id = payload
                .channel_id
                .parse::<i64>()
                .map_err(|_| ApiError::BadRequest("invalid channel_id".into()))?;
            let channel = paracord_db::channels::get_channel(&state.db, channel_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                .ok_or(ApiError::NotFound)?;
            let guild_id = channel.guild_id();

            let allowed = if let Some(gid) = guild_id {
                let member_ok =
                    paracord_core::permissions::ensure_guild_member(&state.db, gid, auth.user_id)
                        .await
                        .is_ok();
                if !member_ok {
                    false
                } else {
                    let guild = paracord_db::guilds::get_guild(&state.db, gid)
                        .await
                        .ok()
                        .flatten();
                    if let Some(guild) = guild {
                        let perms = paracord_core::permissions::compute_channel_permissions(
                            &state.db,
                            gid,
                            channel_id,
                            guild.owner_id,
                            auth.user_id,
                        )
                        .await
                        .ok();
                        if let Some(perms) = perms {
                            perms.contains(Permissions::VIEW_CHANNEL)
                                && perms.contains(Permissions::SEND_MESSAGES)
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                }
            } else {
                paracord_db::dms::is_dm_recipient(&state.db, channel_id, auth.user_id)
                    .await
                    .unwrap_or(false)
            };
            if !allowed {
                return Err(ApiError::Forbidden);
            }

            let typing_payload = json!({
                "channel_id": channel_id.to_string(),
                "user_id": auth.user_id.to_string(),
                "timestamp": Utc::now().timestamp(),
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
        }
        _ => {
            return Err(ApiError::BadRequest("Unsupported command type".into()));
        }
    }

    Ok(Json(json!({
        "ok": true,
        "command_id": req.command_id,
        "accepted_at": Utc::now().timestamp_millis(),
    })))
}
