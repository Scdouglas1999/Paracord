use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use paracord_codec::crypto::{FrameDecryptor, KEY_SIZE};
use paracord_transport::control::SessionParticipant;
use tokio::time::interval;

use super::session::NativeMediaSession;
use paracord_transport::control::ControlMessage;
use paracord_transport::stream::{StreamId, TrackId};

/// Spawn a task that periodically checks audio levels and emits speaking change events.
pub fn spawn_speaking_detector(session: &mut NativeMediaSession, app: tauri::AppHandle) {
    let shutdown = session.shutdown.clone();
    let remote_audio = session.remote_audio.clone();

    let handle = tokio::spawn(async move {
        use tauri::Emitter;

        let mut tick = interval(Duration::from_millis(100));
        let mut prev_speaking: HashMap<u32, bool> = HashMap::new();

        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                _ = tick.tick() => {
                    let remote = remote_audio.lock().await;
                    let mut speakers: HashMap<String, f64> = HashMap::new();
                    let mut changed = false;

                    for (&ssrc, state) in remote.iter() {
                        let is_speaking = state.audio_level < 100;
                        let level = 1.0 - (state.audio_level as f64 / 127.0);

                        let was_speaking = prev_speaking.get(&ssrc).copied().unwrap_or(false);
                        if is_speaking != was_speaking {
                            changed = true;
                        }
                        prev_speaking.insert(ssrc, is_speaking);

                        if is_speaking {
                            speakers.insert(ssrc.to_string(), level);
                        }
                    }

                    if changed || !speakers.is_empty() {
                        let _ = app.emit("media_speaking_change", &speakers);
                    }
                }
            }
        }
    });

    session.speaking_task = Some(handle);
}

/// Emit a participant join event.
#[allow(dead_code)]
pub fn emit_participant_join(app: &tauri::AppHandle, user_id: &str) {
    use tauri::Emitter;
    let _ = app.emit("media_participant_join", user_id);
}

pub fn emit_participant_join_details(app: &tauri::AppHandle, participant: &SessionParticipant) {
    use tauri::Emitter;
    let _ = app.emit(
        "media_participant_join_details",
        serde_json::json!({
            "userId": participant.user_id.to_string(),
            "sessionId": participant.session_id,
            "videoCapabilities": participant.video_capabilities,
        }),
    );
}

/// Emit a participant leave event.
#[allow(dead_code)]
pub fn emit_participant_leave(app: &tauri::AppHandle, user_id: &str) {
    use tauri::Emitter;
    let _ = app.emit("media_participant_leave", user_id);
}

/// Emit a session error event.
#[allow(dead_code)]
pub fn emit_session_error(app: &tauri::AppHandle, error: &str) {
    use tauri::Emitter;
    let _ = app.emit("media_session_error", error);
}

/// Spawn a task that receives stream-control messages on QUIC bidi streams and
/// folds them into the local session stream registry.
pub fn spawn_control_recv_task(session: &mut NativeMediaSession, app: tauri::AppHandle) {
    let shutdown = session.shutdown.clone();
    let conn = session.connection.inner().clone();
    let stream_registry = session.stream_registry.clone();
    let session_participants = session.session_participants.clone();
    let frame_decryptor = session.frame_decryptor.clone();
    let frame_encryptor = session.frame_encryptor.clone();
    let track_sender_keys = session.track_sender_keys.clone();
    let audio_sender_state = session.audio_sender_state.clone();
    let current_key_epoch = session.current_key_epoch.clone();
    let local_user_id = session.local_user_id;
    let local_ssrc = session.local_ssrc;

    let handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                incoming = conn.accept_bi() => {
                    let (_send, mut recv) = match incoming {
                        Ok(streams) => streams,
                        Err(err) => {
                            tracing::debug!("control recv task stopping: {err}");
                            break;
                        }
                    };

                    let mut len_buf = [0u8; 4];
                    if recv.read_exact(&mut len_buf).await.is_err() {
                        continue;
                    }
                    let len = u32::from_be_bytes(len_buf) as usize;
                    if len == 0 || len > 256 * 1024 {
                        continue;
                    }

                    let mut msg_buf = vec![0u8; len];
                    if recv.read_exact(&mut msg_buf).await.is_err() {
                        continue;
                    }

                    let message = match serde_json::from_slice::<ControlMessage>(&msg_buf) {
                        Ok(message) => message,
                        Err(err) => {
                            tracing::debug!("discarding malformed control message: {err}");
                            continue;
                        }
                    };

                    handle_control_message(
                        message,
                        &stream_registry,
                        &session_participants,
                        &frame_encryptor,
                        &frame_decryptor,
                        &track_sender_keys,
                        &audio_sender_state,
                        &current_key_epoch,
                        local_user_id,
                        local_ssrc,
                        &app,
                    )
                    .await;
                }
            }
        }
    });

    session.control_recv_task = Some(handle);
}

async fn handle_control_message(
    message: ControlMessage,
    stream_registry: &std::sync::Arc<tokio::sync::Mutex<super::stream_registry::StreamRegistry>>,
    session_participants: &std::sync::Arc<
        tokio::sync::Mutex<
            std::collections::HashMap<i64, super::session::RemoteSessionParticipant>,
        >,
    >,
    frame_encryptor: &std::sync::Arc<std::sync::Mutex<paracord_codec::crypto::FrameEncryptor>>,
    frame_decryptor: &std::sync::Arc<std::sync::Mutex<FrameDecryptor>>,
    track_sender_keys: &std::sync::Arc<
        tokio::sync::Mutex<
            std::collections::HashMap<(StreamId, TrackId), super::session::SenderKeyState>,
        >,
    >,
    audio_sender_state: &std::sync::Arc<std::sync::Mutex<super::session::SenderKeyState>>,
    current_key_epoch: &std::sync::Arc<AtomicU8>,
    local_user_id: i64,
    local_ssrc: u32,
    app: &tauri::AppHandle,
) {
    match message {
        ControlMessage::SessionState { participants } => {
            let session_state =
                apply_session_state(app, local_user_id, session_participants, &participants).await;
            if session_state.membership_changed && !session_state.initial_sync {
                let _ = match rotate_audio_sender_key(
                    frame_encryptor,
                    audio_sender_state,
                    current_key_epoch,
                    local_ssrc,
                ) {
                    Ok(state) => state,
                    Err(err) => {
                        tracing::warn!(error = %err, "failed to rotate native audio sender key on session snapshot change");
                        current_audio_sender_state(audio_sender_state)
                    }
                };
                let _ = rotate_track_sender_keys(
                    stream_registry,
                    track_sender_keys,
                    frame_encryptor,
                    current_key_epoch,
                )
                .await
                .map_err(|err| {
                    tracing::warn!(error = %err, "failed to rotate native track sender keys on session snapshot change");
                });
            }
        }
        ControlMessage::SessionParticipantJoin { participant } => {
            if participant.user_id != local_user_id {
                let mut known = session_participants.lock().await;
                let inserted = !known.contains_key(&participant.user_id);
                known.insert(
                    participant.user_id,
                    super::session::RemoteSessionParticipant {
                        session_id: participant.session_id.clone(),
                        video_capabilities: participant.video_capabilities.clone(),
                    },
                );
                if inserted {
                    emit_participant_join(app, &participant.user_id.to_string());
                    emit_participant_join_details(app, &participant);
                }
                drop(known);
                let _ = match rotate_audio_sender_key(
                    frame_encryptor,
                    audio_sender_state,
                    current_key_epoch,
                    local_ssrc,
                ) {
                    Ok(state) => state,
                    Err(err) => {
                        tracing::warn!(error = %err, "failed to rotate native audio sender key on join");
                        current_audio_sender_state(audio_sender_state)
                    }
                };
                let _ = rotate_track_sender_keys(
                    stream_registry,
                    track_sender_keys,
                    frame_encryptor,
                    current_key_epoch,
                )
                .await
                .map_err(|err| {
                    tracing::warn!(error = %err, "failed to rotate native track sender keys on join");
                });
            }
        }
        ControlMessage::SessionParticipantLeave { user_id } => {
            if user_id != local_user_id {
                let mut known = session_participants.lock().await;
                if known.remove(&user_id).is_some() {
                    emit_participant_leave(app, &user_id.to_string());
                }
                drop(known);
                let _ = match rotate_audio_sender_key(
                    frame_encryptor,
                    audio_sender_state,
                    current_key_epoch,
                    local_ssrc,
                ) {
                    Ok(state) => state,
                    Err(err) => {
                        tracing::warn!(error = %err, "failed to rotate native audio sender key on leave");
                        current_audio_sender_state(audio_sender_state)
                    }
                };
                let _ = rotate_track_sender_keys(
                    stream_registry,
                    track_sender_keys,
                    frame_encryptor,
                    current_key_epoch,
                )
                .await
                .map_err(|err| {
                    tracing::warn!(error = %err, "failed to rotate native track sender keys on leave");
                });
            }
        }
        ControlMessage::TrackPublish { track } => {
            {
                let mut registry = stream_registry.lock().await;
                registry.publish_track(track.clone());
            }
            apply_delivered_track_key(
                stream_registry,
                frame_decryptor,
                &track.stream_id,
                &track.track_id,
            )
            .await;
            use tauri::Emitter;
            let _ = app.emit("media_track_publish", track);
        }
        ControlMessage::TrackUnpublish {
            stream_id,
            track_id,
        } => {
            let mut registry = stream_registry.lock().await;
            registry.unpublish_track(&stream_id, &track_id);
            use tauri::Emitter;
            let _ = app.emit(
                "media_track_unpublish",
                serde_json::json!({
                    "streamId": stream_id.0,
                    "trackId": track_id.0,
                }),
            );
        }
        ControlMessage::TrackLayers {
            stream_id,
            track_id,
            layers,
        } => {
            let maybe_track = {
                let mut registry = stream_registry.lock().await;
                if let Some(mut track) = registry.get_published_track(&stream_id, &track_id) {
                    track.layers = layers;
                    registry.publish_track(track.clone());
                    Some(track)
                } else {
                    None
                }
            };
            if let Some(track) = maybe_track {
                apply_delivered_track_key(stream_registry, frame_decryptor, &stream_id, &track_id)
                    .await;
                use tauri::Emitter;
                let _ = app.emit("media_track_publish", track);
            }
        }
        ControlMessage::SubscribeStream { subscription } => {
            let mut registry = stream_registry.lock().await;
            registry.subscribe(subscription);
        }
        ControlMessage::UnsubscribeStream {
            stream_id,
            track_id,
        } => {
            let mut registry = stream_registry.lock().await;
            registry.unsubscribe(&stream_id, &track_id);
        }
        ControlMessage::SubscriptionAck {
            stream_id,
            track_id,
            layer_id,
            active,
        } => {
            use tauri::Emitter;
            let _ = app.emit(
                "media_subscription_ack",
                serde_json::json!({
                    "streamId": stream_id.0,
                    "trackId": track_id.0,
                    "layerId": layer_id,
                    "active": active,
                }),
            );
        }
        ControlMessage::RequestKeyframe {
            stream_id,
            track_id,
            layer_id,
        } => {
            use tauri::Emitter;
            let _ = app.emit(
                "media_request_keyframe",
                serde_json::json!({
                    "streamId": stream_id.0,
                    "trackId": track_id.0,
                    "layerId": layer_id,
                }),
            );
        }
        ControlMessage::StreamKeyAnnounce {
            stream_id,
            track_id,
            epoch,
            ..
        } => {
            use tauri::Emitter;
            let _ = app.emit(
                "media_stream_key_announce",
                serde_json::json!({
                    "streamId": stream_id.0,
                    "trackId": track_id.0,
                    "epoch": epoch,
                }),
            );
        }
        ControlMessage::StreamKeyDeliver {
            stream_id,
            track_id,
            sender_user_id,
            epoch,
            ciphertext,
        } => {
            if let Ok(key) = track_key_from_ciphertext(&ciphertext) {
                {
                    let mut registry = stream_registry.lock().await;
                    registry.store_delivered_track_key(&stream_id, &track_id, epoch, key);
                }
                apply_delivered_track_key(stream_registry, frame_decryptor, &stream_id, &track_id)
                    .await;
            } else {
                tracing::debug!(
                    stream_id = stream_id.0,
                    track_id = track_id.0,
                    epoch,
                    key_len = ciphertext.len(),
                    "ignoring malformed stream key delivery"
                );
            }
            use tauri::Emitter;
            let _ = app.emit(
                "media_stream_key_deliver",
                serde_json::json!({
                    "streamId": stream_id.0,
                    "trackId": track_id.0,
                    "senderUserId": sender_user_id.to_string(),
                    "epoch": epoch,
                    "ciphertext": ciphertext,
                }),
            );
        }
        ControlMessage::KeyDeliver {
            sender_user_id,
            epoch,
            ciphertext,
        } => {
            if let Ok(key) = track_key_from_ciphertext(&ciphertext) {
                let sender_audio_ssrc =
                    super::session::NativeMediaSession::derive_track_ssrc(sender_user_id, "audio");
                if let Ok(mut decryptor) = frame_decryptor.lock() {
                    decryptor.set_peer_key(sender_audio_ssrc, epoch, &key);
                }
            }
            use tauri::Emitter;
            let _ = app.emit(
                "media_key_deliver",
                serde_json::json!({
                    "senderUserId": sender_user_id.to_string(),
                    "epoch": epoch,
                    "ciphertext": ciphertext,
                }),
            );
        }
        ControlMessage::RequestStreamKey {
            stream_id,
            track_id,
            recipient_user_id,
        } => {
            use tauri::Emitter;
            let _ = app.emit(
                "media_request_stream_key",
                serde_json::json!({
                    "streamId": stream_id.0,
                    "trackId": track_id.0,
                    "recipientUserId": recipient_user_id.to_string(),
                }),
            );
        }
        ControlMessage::ReceiverReport {
            stream_id,
            track_id,
            active_layer,
            estimated_bitrate_kbps,
            packet_loss_ppm,
            ..
        } => {
            tracing::debug!(
                stream_id = stream_id.0,
                track_id = track_id.0,
                ?active_layer,
                estimated_bitrate_kbps,
                packet_loss_ppm,
                "received receiver report"
            );
        }
        ControlMessage::SessionJoin { .. }
        | ControlMessage::SessionLeave { .. }
        | ControlMessage::Auth { .. }
        | ControlMessage::Subscribe { .. }
        | ControlMessage::Unsubscribe { .. }
        | ControlMessage::KeyAnnounce { .. }
        | ControlMessage::BandwidthFeedback { .. }
        | ControlMessage::Ping
        | ControlMessage::Pong
        | ControlMessage::FileTransferInit { .. }
        | ControlMessage::FileTransferAccept { .. }
        | ControlMessage::FileTransferReject { .. }
        | ControlMessage::FileDownloadRequest { .. }
        | ControlMessage::FileDownloadAccept { .. }
        | ControlMessage::FileTransferProgress { .. }
        | ControlMessage::FileTransferDone { .. }
        | ControlMessage::FileTransferError { .. }
        | ControlMessage::FileTransferCancel { .. } => {}
    }
}

struct SessionStateUpdate {
    membership_changed: bool,
    initial_sync: bool,
}

async fn apply_session_state(
    app: &tauri::AppHandle,
    local_user_id: i64,
    session_participants: &std::sync::Arc<
        tokio::sync::Mutex<
            std::collections::HashMap<i64, super::session::RemoteSessionParticipant>,
        >,
    >,
    participants: &[SessionParticipant],
) -> SessionStateUpdate {
    let desired = participants
        .iter()
        .filter(|participant| participant.user_id != local_user_id)
        .map(|participant| {
            (
                participant.user_id,
                super::session::RemoteSessionParticipant {
                    session_id: participant.session_id.clone(),
                    video_capabilities: participant.video_capabilities.clone(),
                },
            )
        })
        .collect::<std::collections::HashMap<_, _>>();
    let mut known = session_participants.lock().await;
    let initial_sync = known.is_empty();
    let membership_changed = known.len() != desired.len()
        || desired.iter().any(|(user_id, participant)| {
            known
                .get(user_id)
                .map(|existing| {
                    existing.session_id != participant.session_id
                        || existing.video_capabilities != participant.video_capabilities
                })
                .unwrap_or(true)
        });

    for participant in participants {
        if participant.user_id == local_user_id {
            continue;
        }
        let should_emit_join = known
            .get(&participant.user_id)
            .map(|existing| {
                existing.session_id != participant.session_id
                    || existing.video_capabilities != participant.video_capabilities
            })
            .unwrap_or(true);
        if should_emit_join {
            emit_participant_join(app, &participant.user_id.to_string());
            emit_participant_join_details(app, participant);
        }
    }
    for user_id in known
        .keys()
        .filter(|user_id| !desired.contains_key(user_id))
        .copied()
        .collect::<Vec<_>>()
    {
        emit_participant_leave(app, &user_id.to_string());
    }
    *known = desired;
    SessionStateUpdate {
        membership_changed,
        initial_sync,
    }
}

fn rotate_audio_sender_key(
    frame_encryptor: &std::sync::Arc<std::sync::Mutex<paracord_codec::crypto::FrameEncryptor>>,
    audio_sender_state: &std::sync::Arc<std::sync::Mutex<super::session::SenderKeyState>>,
    current_key_epoch: &std::sync::Arc<AtomicU8>,
    local_ssrc: u32,
) -> Result<super::session::SenderKeyState, String> {
    use rand::random;

    let current = current_key_epoch.load(Ordering::SeqCst);
    let next_epoch = {
        let candidate = current.wrapping_add(1);
        if candidate == 0 {
            1
        } else {
            candidate
        }
    };
    let next_key = random::<[u8; KEY_SIZE]>();

    {
        let mut encryptor = frame_encryptor
            .lock()
            .map_err(|_| "frame encryptor lock poisoned".to_string())?;
        encryptor.set_peer_key(local_ssrc, next_epoch, &next_key);
    }
    {
        let mut state = audio_sender_state
            .lock()
            .map_err(|_| "audio sender state lock poisoned".to_string())?;
        *state = super::session::SenderKeyState {
            epoch: next_epoch,
            key: next_key,
        };
    }
    current_key_epoch.store(next_epoch, Ordering::SeqCst);

    Ok(super::session::SenderKeyState {
        epoch: next_epoch,
        key: next_key,
    })
}

fn current_audio_sender_state(
    audio_sender_state: &std::sync::Arc<std::sync::Mutex<super::session::SenderKeyState>>,
) -> super::session::SenderKeyState {
    audio_sender_state
        .lock()
        .map(|state| *state)
        .unwrap_or(super::session::SenderKeyState {
            epoch: 1,
            key: [0u8; KEY_SIZE],
        })
}

async fn rotate_track_sender_keys(
    stream_registry: &std::sync::Arc<tokio::sync::Mutex<super::stream_registry::StreamRegistry>>,
    track_sender_keys: &std::sync::Arc<
        tokio::sync::Mutex<
            std::collections::HashMap<(StreamId, TrackId), super::session::SenderKeyState>,
        >,
    >,
    frame_encryptor: &std::sync::Arc<std::sync::Mutex<paracord_codec::crypto::FrameEncryptor>>,
    current_key_epoch: &std::sync::Arc<AtomicU8>,
) -> Result<(), String> {
    use rand::random;

    let epoch = current_key_epoch.load(Ordering::SeqCst);
    let track_keys = {
        let sender_keys = track_sender_keys.lock().await;
        sender_keys.keys().cloned().collect::<Vec<_>>()
    };
    if track_keys.is_empty() {
        return Ok(());
    }

    let tracks = {
        let registry = stream_registry.lock().await;
        track_keys
            .iter()
            .filter_map(|(stream_id, track_id)| {
                registry
                    .get_published_track(stream_id, track_id)
                    .map(|track| ((stream_id.clone(), track_id.clone()), track))
            })
            .collect::<std::collections::HashMap<_, _>>()
    };

    let mut sender_keys = track_sender_keys.lock().await;
    let mut encryptor = frame_encryptor
        .lock()
        .map_err(|_| "frame encryptor lock poisoned".to_string())?;
    for track_key in track_keys {
        let Some(track) = tracks.get(&track_key) else {
            continue;
        };
        let next_key = random::<[u8; KEY_SIZE]>();
        sender_keys.insert(
            track_key.clone(),
            super::session::SenderKeyState {
                epoch,
                key: next_key,
            },
        );
        for layer in &track.layers {
            encryptor.set_peer_key(layer.ssrc, epoch, &next_key);
        }
    }

    Ok(())
}

fn track_key_from_ciphertext(ciphertext: &[u8]) -> Result<[u8; KEY_SIZE], ()> {
    if ciphertext.len() != KEY_SIZE {
        return Err(());
    }
    let mut key = [0u8; KEY_SIZE];
    key.copy_from_slice(ciphertext);
    Ok(key)
}

async fn apply_delivered_track_key(
    stream_registry: &std::sync::Arc<tokio::sync::Mutex<super::stream_registry::StreamRegistry>>,
    frame_decryptor: &std::sync::Arc<std::sync::Mutex<FrameDecryptor>>,
    stream_id: &StreamId,
    track_id: &TrackId,
) {
    let (track, epochs) = {
        let registry = stream_registry.lock().await;
        let Some(track) = registry.get_published_track(stream_id, track_id) else {
            return;
        };
        let epochs = registry.delivered_track_keys_for_track(stream_id, track_id);
        (track, epochs)
    };

    if epochs.is_empty() {
        return;
    }

    let Ok(mut decryptor) = frame_decryptor.lock() else {
        tracing::warn!("failed to lock frame decryptor while applying delivered track key");
        return;
    };

    for layer in &track.layers {
        for (epoch, key) in &epochs {
            decryptor.set_peer_key(layer.ssrc, *epoch, key);
        }
    }
}
