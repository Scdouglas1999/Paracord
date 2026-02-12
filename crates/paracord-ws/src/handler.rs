use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use paracord_core::AppState;
use paracord_models::gateway::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::OnceLock;
use tokio::time::{Duration, Instant};

use crate::session::Session;

const HEARTBEAT_INTERVAL_MS: u64 = 41250;
const HEARTBEAT_TIMEOUT_MS: u64 = 90000;
const SESSION_TTL_SECONDS: i64 = 3600;

#[derive(Clone)]
struct CachedSession {
    user_id: i64,
    guild_ids: Vec<i64>,
    sequence: u64,
    updated_at: i64,
}

static SESSION_CACHE: OnceLock<tokio::sync::RwLock<HashMap<String, CachedSession>>> =
    OnceLock::new();

fn session_cache() -> &'static tokio::sync::RwLock<HashMap<String, CachedSession>> {
    SESSION_CACHE.get_or_init(|| tokio::sync::RwLock::new(HashMap::new()))
}

pub async fn handle_connection(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();

    // Send HELLO
    let hello = json!({
        "op": OP_HELLO,
        "d": { "heartbeat_interval": HEARTBEAT_INTERVAL_MS }
    });
    if sender
        .send(Message::Text(hello.to_string().into()))
        .await
        .is_err()
    {
        return;
    }

    // Wait for IDENTIFY (timeout 30s)
    let identify_timeout = Duration::from_secs(30);
    let (session, resumed) = match tokio::time::timeout(
        identify_timeout,
        wait_for_identify_or_resume(&mut receiver, &state),
    )
    .await
    {
        Ok(Some(result)) => result,
        _ => {
            let _ = sender
                .send(Message::Text(
                    json!({"op": OP_INVALID_SESSION, "d": false})
                        .to_string()
                        .into(),
                ))
                .await;
            return;
        }
    };

    if resumed {
        let resumed_payload = json!({
            "op": OP_DISPATCH,
            "t": EVENT_RESUMED,
            "s": session.sequence,
            "d": { "session_id": &session.session_id }
        });
        if sender
            .send(Message::Text(resumed_payload.to_string().into()))
            .await
            .is_err()
        {
            return;
        }
    } else {
        // Fresh IDENTIFY (not a resume) — the client just loaded, so any
        // voice state in the DB from a prior session is stale.  Clean it
        // up *before* building the READY payload so other clients don't
        // see ghost entries.
        if let Ok(stale) =
            paracord_db::voice_states::get_all_user_voice_states(&state.db, session.user_id).await
        {
            for vs in &stale {
                // Only clean up if they're not actually in the LiveKit room
                // (safety check in case of race with a concurrent join).
                if !state
                    .voice
                    .is_participant_in_livekit_room(vs.channel_id, vs.guild_id(), session.user_id)
                    .await
                {
                    let _ = paracord_db::voice_states::remove_voice_state(
                        &state.db,
                        session.user_id,
                        vs.guild_id(),
                    )
                    .await;
                    let _ = state.voice.leave_room(vs.channel_id, session.user_id).await;
                }
            }
        }

        // Send READY with full user data
        let user = paracord_db::users::get_user_by_id(&state.db, session.user_id)
            .await
            .ok()
            .flatten();

        let user_json = if let Some(u) = &user {
            json!({
                "id": u.id.to_string(),
                "username": u.username,
                "discriminator": u.discriminator,
                "avatar_hash": u.avatar_hash,
                "display_name": u.display_name,
            })
        } else {
            json!({"id": session.user_id.to_string()})
        };

        // Snapshot of currently online users for building presence lists
        let online_snapshot = state.online_users.read().await.clone();

        // Fetch guild data for READY
        let mut guilds_json = Vec::new();
        for &gid in &session.guild_ids {
            let guild = paracord_db::guilds::get_guild(&state.db, gid)
                .await
                .ok()
                .flatten();
            let channels = paracord_db::channels::get_guild_channels(&state.db, gid)
                .await
                .unwrap_or_default();

            let channels_json: Vec<Value> = channels
                .iter()
                .map(|c| {
                    json!({
                        "id": c.id.to_string(),
                        "name": c.name,
                        "channel_type": c.channel_type,
                        "position": c.position,
                        "guild_id": c.guild_id().map(|id| id.to_string()),
                        "parent_id": c.parent_id.map(|id| id.to_string()),
                    })
                })
                .collect();

            let voice_states = paracord_db::voice_states::get_guild_voice_states(&state.db, gid)
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
                        "username": &vs.username,
                        "avatar_hash": &vs.avatar_hash,
                    })
                })
                .collect();

            // Build initial presences: guild members who are currently online
            let guild_members = paracord_db::members::get_guild_members(&state.db, gid, 10000, None)
                .await
                .unwrap_or_default();
            let presences_json: Vec<Value> = guild_members
                .iter()
                .filter(|m| online_snapshot.contains(&m.user_id))
                .map(|m| {
                    json!({
                        "user_id": m.user_id.to_string(),
                        "status": "online",
                    })
                })
                .collect();

            if let Some(g) = guild {
                guilds_json.push(json!({
                    "id": g.id.to_string(),
                    "name": g.name,
                    "owner_id": g.owner_id.to_string(),
                    "channels": channels_json,
                    "voice_states": voice_states_json,
                    "presences": presences_json,
                }));
            }
        }

        let ready = json!({
            "op": OP_DISPATCH,
            "t": EVENT_READY,
            "s": session.sequence.max(1),
            "d": {
                "user": user_json,
                "guilds": guilds_json,
                "session_id": &session.session_id,
            }
        });
        if sender
            .send(Message::Text(ready.to_string().into()))
            .await
            .is_err()
        {
            return;
        }
    }

    // Save user_id before session is moved into run_session
    let session_user_id = session.user_id;

    // Track this user as online
    state.online_users.write().await.insert(session_user_id);

    // Publish presence update for this user coming online
    state.event_bus.dispatch(
        EVENT_PRESENCE_UPDATE,
        json!({
            "user_id": session_user_id.to_string(),
            "status": "online",
        }),
        None,
    );

    run_session(sender, receiver, session, state.clone()).await;

    // Voice cleanup: when the gateway WebSocket drops, don't remove voice
    // state immediately — the user may still be connected to LiveKit (their
    // media/WebRTC connection is independent of the gateway WS).  Wait a
    // grace period, then check LiveKit as ground truth before clearing.
    if let Ok(states) =
        paracord_db::voice_states::get_all_user_voice_states(&state.db, session_user_id).await
    {
        if !states.is_empty() {
            let state_clone = state.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(8)).await;

                let dc_user = paracord_db::users::get_user_by_id(&state_clone.db, session_user_id)
                    .await
                    .ok()
                    .flatten();

                // Re-fetch current voice states — they may have been cleared
                // by another code path (e.g. explicit leave) during the wait.
                let current_states = paracord_db::voice_states::get_all_user_voice_states(
                    &state_clone.db,
                    session_user_id,
                )
                .await
                .unwrap_or_default();

                for voice_state in current_states {
                    // Check LiveKit ground truth: is the user actually still
                    // connected to the media room?  If yes, keep the state.
                    if state_clone
                        .voice
                        .is_participant_in_livekit_room(
                            voice_state.channel_id,
                            voice_state.guild_id(),
                            session_user_id,
                        )
                        .await
                    {
                        tracing::debug!(
                            "Gateway disconnect grace period: user {} still in LiveKit room for channel {}, keeping voice state",
                            session_user_id, voice_state.channel_id
                        );
                        continue;
                    }

                    tracing::info!(
                        "Gateway disconnect grace period: user {} not in LiveKit room for channel {}, cleaning up",
                        session_user_id, voice_state.channel_id
                    );

                    let _ = paracord_db::voice_states::remove_voice_state(
                        &state_clone.db,
                        session_user_id,
                        voice_state.guild_id(),
                    )
                    .await;
                    if let Some(participants) = state_clone
                        .voice
                        .leave_room(voice_state.channel_id, session_user_id)
                        .await
                    {
                        if participants.is_empty() {
                            let _ = state_clone.voice.cleanup_room(voice_state.channel_id).await;
                        }
                    }
                    state_clone.event_bus.dispatch(
                        EVENT_VOICE_STATE_UPDATE,
                        json!({
                            "user_id": session_user_id.to_string(),
                            "channel_id": Value::Null,
                            "guild_id": voice_state.guild_id().map(|id| id.to_string()),
                            "self_mute": false,
                            "self_deaf": false,
                            "username": dc_user.as_ref().map(|u| u.username.as_str()),
                            "avatar_hash": dc_user.as_ref().and_then(|u| u.avatar_hash.as_deref()),
                        }),
                        voice_state.guild_id(),
                    );
                }
            });
        }
    }

    // Remove user from online tracking
    state.online_users.write().await.remove(&session_user_id);

    // Publish presence offline on disconnect
    state.event_bus.dispatch(
        EVENT_PRESENCE_UPDATE,
        json!({
            "user_id": session_user_id.to_string(),
            "status": "offline",
        }),
        None,
    );
}

async fn wait_for_identify_or_resume(
    receiver: &mut (impl StreamExt<Item = Result<Message, axum::Error>> + Unpin),
    state: &AppState,
) -> Option<(Session, bool)> {
    while let Some(Ok(msg)) = receiver.next().await {
        if let Message::Text(text) = msg {
            if let Ok(payload) = serde_json::from_str::<Value>(&text) {
                if let Some(d) = payload.get("d") {
                    if let Some(token) = d.get("token").and_then(|v| v.as_str()) {
                        let claims =
                            paracord_core::auth::validate_token(token, &state.config.jwt_secret)
                                .ok()?;
                        let op = payload.get("op").and_then(|v| v.as_u64())?;
                        if op == OP_IDENTIFY as u64 {
                            let guild_ids =
                                paracord_db::guilds::get_user_guilds(&state.db, claims.sub)
                                    .await
                                    .unwrap_or_default()
                                    .iter()
                                    .map(|g| g.id)
                                    .collect();
                            return Some((Session::new(claims.sub, guild_ids), false));
                        }
                        if op == OP_RESUME as u64 {
                            let requested_session_id =
                                d.get("session_id").and_then(|v| v.as_str())?.to_string();
                            let requested_seq = d.get("seq").and_then(|v| v.as_u64()).unwrap_or(0);
                            let now = chrono::Utc::now().timestamp();
                            let mut cache = session_cache().write().await;
                            cache
                                .retain(|_, cached| now - cached.updated_at <= SESSION_TTL_SECONDS);
                            if let Some(cached) = cache.get(&requested_session_id) {
                                if cached.user_id == claims.sub {
                                    let mut resumed =
                                        Session::new(cached.user_id, cached.guild_ids.clone());
                                    resumed.session_id = requested_session_id;
                                    resumed.sequence = cached.sequence.max(requested_seq);
                                    return Some((resumed, true));
                                }
                            }
                            return None;
                        }
                    }
                }
            }
        }
    }
    None
}

async fn run_session(
    mut sender: impl SinkExt<Message> + Unpin,
    mut receiver: impl StreamExt<Item = Result<Message, axum::Error>> + Unpin,
    mut session: Session,
    state: AppState,
) {
    let mut event_rx = state.event_bus.subscribe();
    let mut last_heartbeat = Instant::now();
    let heartbeat_timeout = Duration::from_millis(HEARTBEAT_TIMEOUT_MS);

    loop {
        tokio::select! {
            msg = receiver.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(payload) = serde_json::from_str::<Value>(&text) {
                            handle_client_message(&payload, &mut sender, &mut session, &state).await;
                            if payload.get("op").and_then(|v| v.as_u64()) == Some(OP_HEARTBEAT as u64) {
                                last_heartbeat = Instant::now();
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
            event = event_rx.recv() => {
                if let Ok(event) = event {
                    if session.should_receive_event(event.guild_id, event.target_user_ids.as_deref()) {
                        // Dynamically add guild when this user joins a new guild
                        if event.event_type == "GUILD_MEMBER_ADD" {
                            if let Some(uid) = event.payload.get("user_id").and_then(|v| v.as_str()) {
                                if uid == session.user_id.to_string() {
                                    if let Some(gid) = event.payload.get("guild_id")
                                        .and_then(|v| v.as_str())
                                        .and_then(|s| s.parse::<i64>().ok())
                                    {
                                        session.add_guild(gid);
                                    }
                                }
                            }
                        }
                        let seq = session.next_sequence();
                        let dispatch = json!({
                            "op": OP_DISPATCH,
                            "t": event.event_type,
                            "s": seq,
                            "d": event.payload,
                        });
                        if sender.send(Message::Text(dispatch.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(5)) => {
                if last_heartbeat.elapsed() > heartbeat_timeout {
                    tracing::info!("Client {} heartbeat timeout", session.user_id);
                    break;
                }
            }
        }
    }

    tracing::info!("Client {} disconnected", session.user_id);
    let now = chrono::Utc::now().timestamp();
    let mut cache = session_cache().write().await;
    cache.insert(
        session.session_id.clone(),
        CachedSession {
            user_id: session.user_id,
            guild_ids: session.guild_ids.clone(),
            sequence: session.sequence,
            updated_at: now,
        },
    );
}

async fn handle_client_message(
    payload: &Value,
    sender: &mut (impl SinkExt<Message> + Unpin),
    session: &mut Session,
    state: &AppState,
) {
    let op = payload.get("op").and_then(|v| v.as_u64()).unwrap_or(255) as u8;

    match op {
        OP_HEARTBEAT => {
            let ack = json!({"op": OP_HEARTBEAT_ACK});
            let _ = sender.send(Message::Text(ack.to_string().into())).await;
        }
        OP_PRESENCE_UPDATE => {
            if let Some(d) = payload.get("d") {
                let status = d.get("status").and_then(|v| v.as_str()).unwrap_or("online");
                let custom_status = d.get("custom_status").and_then(|v| v.as_str());

                state.event_bus.dispatch(
                    EVENT_PRESENCE_UPDATE,
                    json!({
                        "user_id": session.user_id.to_string(),
                        "status": status,
                        "custom_status": custom_status,
                    }),
                    None,
                );
            }
        }
        OP_TYPING_START => {
            if let Some(d) = payload.get("d") {
                if let Some(channel_id_str) = d.get("channel_id").and_then(|v| v.as_str()) {
                    let channel = if let Ok(cid) = channel_id_str.parse::<i64>() {
                        paracord_db::channels::get_channel(&state.db, cid)
                            .await
                            .ok()
                            .flatten()
                    } else {
                        None
                    };
                    let guild_id = channel.as_ref().and_then(|c| c.guild_id());

                    let typing_payload = json!({
                        "channel_id": channel_id_str,
                        "user_id": session.user_id.to_string(),
                        "timestamp": chrono::Utc::now().timestamp(),
                    });

                    if guild_id.is_none() {
                        if let Ok(cid) = channel_id_str.parse::<i64>() {
                            let recipient_ids =
                                paracord_db::dms::get_dm_recipient_ids(&state.db, cid)
                                    .await
                                    .unwrap_or_default();
                            state.event_bus.dispatch_to_users(
                                EVENT_TYPING_START,
                                typing_payload,
                                recipient_ids,
                            );
                        }
                    } else {
                        state
                            .event_bus
                            .dispatch(EVENT_TYPING_START, typing_payload, guild_id);
                    }
                }
            }
        }
        OP_VOICE_STATE_UPDATE => {
            if let Some(d) = payload.get("d") {
                let self_mute = d
                    .get("self_mute")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let self_deaf = d
                    .get("self_deaf")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                let requested_guild_id = d
                    .get("guild_id")
                    .and_then(|v| v.as_str())
                    .and_then(|raw| raw.parse::<i64>().ok());

                let vs_user = paracord_db::users::get_user_by_id(&state.db, session.user_id)
                    .await
                    .ok()
                    .flatten();

                if d.get("channel_id").is_some() && d.get("channel_id").unwrap().is_null() {
                    // Explicit leave
                    let existing = paracord_db::voice_states::get_user_voice_state(
                        &state.db,
                        session.user_id,
                        requested_guild_id,
                    )
                    .await
                    .ok()
                    .flatten();
                    if let Some(existing_state) = existing {
                        let _ = paracord_db::voice_states::remove_voice_state(
                            &state.db,
                            session.user_id,
                            existing_state.guild_id(),
                        )
                        .await;
                        if let Some(participants) = state
                            .voice
                            .leave_room(existing_state.channel_id, session.user_id)
                            .await
                        {
                            if participants.is_empty() {
                                let _ = state.voice.cleanup_room(existing_state.channel_id).await;
                            }
                        }
                        state.event_bus.dispatch(
                            EVENT_VOICE_STATE_UPDATE,
                            json!({
                                "user_id": session.user_id.to_string(),
                                "channel_id": Value::Null,
                                "guild_id": existing_state.guild_id().map(|id| id.to_string()),
                                "self_mute": self_mute,
                                "self_deaf": self_deaf,
                                "username": vs_user.as_ref().map(|u| u.username.as_str()),
                                "avatar_hash": vs_user.as_ref().and_then(|u| u.avatar_hash.as_deref()),
                            }),
                            existing_state.guild_id(),
                        );
                    }
                } else if let Some(channel_id_str) = d.get("channel_id").and_then(|v| v.as_str()) {
                    if let Ok(channel_id) = channel_id_str.parse::<i64>() {
                        let channel = paracord_db::channels::get_channel(&state.db, channel_id)
                            .await
                            .ok()
                            .flatten();
                        let guild_id = channel.and_then(|c| c.guild_id());
                        let _ = paracord_db::voice_states::upsert_voice_state(
                            &state.db,
                            session.user_id,
                            guild_id,
                            channel_id,
                            &session.session_id,
                        )
                        .await;
                        state
                            .voice
                            .update_self_mute(channel_id, session.user_id, self_mute)
                            .await;
                        state
                            .voice
                            .update_self_deaf(channel_id, session.user_id, self_deaf)
                            .await;

                        state.event_bus.dispatch(
                            EVENT_VOICE_STATE_UPDATE,
                            json!({
                                "user_id": session.user_id.to_string(),
                                "channel_id": channel_id_str,
                                "guild_id": guild_id.map(|id| id.to_string()),
                                "self_mute": self_mute,
                                "self_deaf": self_deaf,
                                "username": vs_user.as_ref().map(|u| u.username.as_str()),
                                "avatar_hash": vs_user.as_ref().and_then(|u| u.avatar_hash.as_deref()),
                            }),
                            guild_id,
                        );
                    }
                }
            }
        }
        _ => {
            tracing::debug!("Unknown opcode {} from client {}", op, session.user_id);
        }
    }
}
