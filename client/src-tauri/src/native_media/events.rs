use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};

use paracord_codec::crypto::{FrameDecryptor, KEY_SIZE};
use paracord_transport::control::SessionParticipant;
use tokio::time::interval;

use super::session::NativeMediaSession;
use paracord_transport::control::ControlMessage;
use paracord_transport::stream::{StreamId, TrackId};

/// Audio levels run 0 (loudest) to [`AUDIO_LEVEL_SILENCE`] (silence); see
/// `audio_pipeline::compute_audio_level`. A speaker turns "on" only once clearly
/// loud (level below [`SPEAKING_LEVEL_ON`]) and stays "on" until clearly quiet
/// (level at/above [`SPEAKING_LEVEL_OFF`]). The gap between the two thresholds is
/// the hysteresis band that stops a level hovering near one threshold from
/// flickering the indicator on and off.
const SPEAKING_LEVEL_ON: u8 = 95;
const SPEAKING_LEVEL_OFF: u8 = 110;
/// Once speaking, keep the indicator lit for at least this long after the level
/// goes quiet, so brief gaps between words do not drop it.
const SPEAKING_HOLD: Duration = Duration::from_millis(300);
/// Maximum value of the audio-level scale (silence), used to normalize the
/// reported speaking intensity into `0.0..=1.0`.
const AUDIO_LEVEL_SILENCE: u8 = 127;

/// Per-speaker hysteresis state for the speaking detector. Debounces the raw
/// audio level into a stable speaking/not-speaking signal.
struct SpeakerHysteresis {
    speaking: bool,
    /// Last time the level was above the "on" loudness while speaking; the hold
    /// timer is measured from here so short quiet gaps do not drop the state.
    last_loud: Instant,
}

impl SpeakerHysteresis {
    fn new(now: Instant) -> Self {
        Self {
            speaking: false,
            last_loud: now,
        }
    }

    /// Fold one audio-level sample into the debounced state and return whether
    /// the speaker is currently considered speaking.
    fn update(&mut self, level: u8, now: Instant) -> bool {
        let is_loud = level < SPEAKING_LEVEL_ON;
        let is_quiet = level >= SPEAKING_LEVEL_OFF;
        if self.speaking {
            if is_loud {
                self.last_loud = now;
            }
            if is_quiet && now.duration_since(self.last_loud) >= SPEAKING_HOLD {
                self.speaking = false;
            }
        } else if is_loud {
            self.speaking = true;
            self.last_loud = now;
        }
        self.speaking
    }
}

/// Spawn a task that periodically checks audio levels and emits speaking change events.
pub fn spawn_speaking_detector(session: &mut NativeMediaSession, app: tauri::AppHandle) {
    let shutdown = session.shutdown.clone();
    let remote_audio = session.remote_audio.clone();

    let handle = tokio::spawn(async move {
        use tauri::Emitter;

        let mut tick = interval(Duration::from_millis(100));
        let mut hysteresis: HashMap<u32, SpeakerHysteresis> = HashMap::new();

        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                _ = tick.tick() => {
                    let remote = remote_audio.lock().await;
                    let mut speakers: HashMap<String, f64> = HashMap::new();
                    let mut changed = false;
                    let now = Instant::now();

                    for (&ssrc, state) in remote.iter() {
                        let entry = hysteresis
                            .entry(ssrc)
                            .or_insert_with(|| SpeakerHysteresis::new(now));
                        let was_speaking = entry.speaking;
                        let is_speaking = entry.update(state.audio_level, now);
                        if is_speaking != was_speaking {
                            changed = true;
                        }

                        if is_speaking {
                            let level =
                                1.0 - (state.audio_level as f64 / AUDIO_LEVEL_SILENCE as f64);
                            speakers.insert(ssrc.to_string(), level);
                        }
                    }

                    // Forget speakers that dropped out so their stale hysteresis
                    // state does not linger for the life of the session.
                    hysteresis.retain(|ssrc, _| remote.contains_key(ssrc));

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

/// Emit a keyframe request for a remote video track.
///
/// Used both when the relay asks us for a keyframe and when a local decoder
/// cannot decode a remote track and needs the sender to produce a fresh intra
/// frame. The frontend forwards this upstream.
pub fn emit_media_request_keyframe(
    app: &tauri::AppHandle,
    stream_id: &str,
    track_id: &str,
    layer_id: Option<u8>,
) {
    use tauri::Emitter;
    let _ = app.emit(
        "media_request_keyframe",
        serde_json::json!({
            "streamId": stream_id,
            "trackId": track_id,
            "layerId": layer_id,
        }),
    );
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
                        &conn,
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
    conn: &quinn::Connection,
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
            // Reconcile the local subscription set against the fresh snapshot:
            // any participant that dropped out must have their subscriptions torn
            // down so bandwidth is not spent on stale tracks.
            for user_id in &session_state.departed {
                handle_participant_departure(conn, stream_registry, *user_id).await;
            }
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
                // Tear down subscriptions and native decoders for the departed
                // participant so the relay stops forwarding their tracks and
                // libvpx state is released promptly instead of lingering.
                handle_participant_departure(conn, stream_registry, user_id).await;
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
            if active {
                // Mark the local subscription confirmed by recording the layer
                // the relay committed to forwarding.
                let mut registry = stream_registry.lock().await;
                if let Some(mut subscription) = registry
                    .subscriptions()
                    .into_iter()
                    .find(|sub| sub.stream_id == stream_id && sub.track_id == track_id)
                {
                    if layer_id.is_some() {
                        subscription.active_layer = layer_id;
                    }
                    registry.subscribe(subscription);
                    tracing::debug!(
                        stream_id = %stream_id.0,
                        track_id = %track_id.0,
                        ?layer_id,
                        "subscription confirmed by relay"
                    );
                } else {
                    tracing::debug!(
                        stream_id = %stream_id.0,
                        track_id = %track_id.0,
                        "subscription ack for a track we no longer track locally"
                    );
                }
            } else {
                // Unsubscribe ack: drop the local subscription and any decoder so
                // no stale state or libvpx context lingers.
                {
                    let mut registry = stream_registry.lock().await;
                    registry.unsubscribe(&stream_id, &track_id);
                }
                super::video_pipeline::remove_remote_video_decoder(&stream_id.0, &track_id.0);
                tracing::debug!(
                    stream_id = %stream_id.0,
                    track_id = %track_id.0,
                    "unsubscribe confirmed by relay; dropped local decoder"
                );
            }
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
            emit_media_request_keyframe(app, &stream_id.0, &track_id.0, layer_id);
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
    departed: Vec<i64>,
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
    let departed = known
        .keys()
        .filter(|user_id| !desired.contains_key(user_id))
        .copied()
        .collect::<Vec<_>>();
    for user_id in &departed {
        emit_participant_leave(app, &user_id.to_string());
    }
    *known = desired;
    SessionStateUpdate {
        membership_changed,
        initial_sync,
        departed,
    }
}

/// Build the `UnsubscribeStream` messages the client should send when `user_id`
/// leaves: one per track that participant published and we still hold a live
/// subscription for.
fn unsubscribe_messages_for_participant(
    registry: &super::stream_registry::StreamRegistry,
    user_id: i64,
) -> Vec<ControlMessage> {
    let subscribed: std::collections::HashSet<(StreamId, TrackId)> = registry
        .subscriptions()
        .into_iter()
        .map(|subscription| (subscription.stream_id, subscription.track_id))
        .collect();
    registry
        .published_tracks()
        .into_iter()
        .filter(|track| track.publisher_user_id == user_id)
        .filter(|track| subscribed.contains(&(track.stream_id.clone(), track.track_id.clone())))
        .map(|track| ControlMessage::UnsubscribeStream {
            stream_id: track.stream_id,
            track_id: track.track_id,
        })
        .collect()
}

/// Reconcile local state after a participant leaves the session: remove local
/// subscription entries, drop native decoders for every track they published,
/// and tell the relay to stop forwarding the tracks we were subscribed to.
async fn handle_participant_departure(
    conn: &quinn::Connection,
    stream_registry: &std::sync::Arc<tokio::sync::Mutex<super::stream_registry::StreamRegistry>>,
    user_id: i64,
) {
    let (published_tracks, unsubscribes) = {
        let registry = stream_registry.lock().await;
        let published_tracks: Vec<(String, String)> = registry
            .published_tracks()
            .into_iter()
            .filter(|track| track.publisher_user_id == user_id)
            .map(|track| (track.stream_id.0, track.track_id.0))
            .collect();
        let unsubscribes = unsubscribe_messages_for_participant(&registry, user_id);
        (published_tracks, unsubscribes)
    };

    if !unsubscribes.is_empty() {
        let mut registry = stream_registry.lock().await;
        for message in &unsubscribes {
            if let ControlMessage::UnsubscribeStream {
                stream_id,
                track_id,
            } = message
            {
                registry.unsubscribe(stream_id, track_id);
            }
        }
    }

    for (stream_id, track_id) in published_tracks {
        super::video_pipeline::remove_remote_video_decoder(&stream_id, &track_id);
    }

    for message in unsubscribes {
        if let Err(err) = send_control_over_connection(conn, &message).await {
            tracing::warn!(
                error = %err,
                "failed to send UnsubscribeStream for departed participant"
            );
        }
    }
}

/// Send a single control message over the session's QUIC connection using the
/// length-prefixed framing the relay expects.
async fn send_control_over_connection(
    conn: &quinn::Connection,
    message: &ControlMessage,
) -> Result<(), String> {
    let (mut send, _recv) = conn
        .open_bi()
        .await
        .map_err(|e| format!("open control stream: {e}"))?;
    let encoded = message
        .encode()
        .map_err(|e| format!("encode control message: {e}"))?;
    send.write_all(&encoded)
        .await
        .map_err(|e| format!("write control message: {e}"))?;
    send.finish()
        .map_err(|e| format!("finish control message: {e}"))?;
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use paracord_transport::control::TrackKind;
    use paracord_transport::stream::{
        PublishedLayer, PublishedTrack, TrackSubscription, VideoCodec,
    };

    fn video_track(publisher_user_id: i64, stream: &str, track: &str) -> PublishedTrack {
        PublishedTrack {
            stream_id: StreamId::new(stream),
            track_id: TrackId::new(track),
            publisher_user_id,
            kind: TrackKind::Video,
            codec: Some(VideoCodec::Vp9),
            layers: vec![PublishedLayer {
                layer_id: 0,
                ssrc: 42,
                width: Some(1280),
                height: Some(720),
                max_bitrate_kbps: Some(2500),
                active: true,
            }],
        }
    }

    fn subscription(stream: &str, track: &str) -> TrackSubscription {
        TrackSubscription {
            stream_id: StreamId::new(stream),
            track_id: TrackId::new(track),
            requested_layer: Some(0),
            active_layer: Some(0),
            viewport: None,
        }
    }

    #[test]
    fn participant_leave_enqueues_unsubscribe_for_registered_tracks() {
        let mut registry = super::super::stream_registry::StreamRegistry::default();

        // Departing participant 42 publishes a track we are subscribed to.
        registry.publish_track(video_track(42, "stream-a", "screen"));
        registry.subscribe(subscription("stream-a", "screen"));

        // A different participant's subscribed track must be left untouched.
        registry.publish_track(video_track(99, "stream-b", "camera"));
        registry.subscribe(subscription("stream-b", "camera"));

        let messages = unsubscribe_messages_for_participant(&registry, 42);
        assert_eq!(
            messages.len(),
            1,
            "exactly one unsubscribe for participant 42"
        );
        match &messages[0] {
            ControlMessage::UnsubscribeStream {
                stream_id,
                track_id,
            } => {
                assert_eq!(stream_id.0, "stream-a");
                assert_eq!(track_id.0, "screen");
            }
            other => panic!("expected UnsubscribeStream, got {other:?}"),
        }
    }

    #[test]
    fn participant_leave_ignores_published_tracks_without_subscription() {
        let mut registry = super::super::stream_registry::StreamRegistry::default();
        // Published but never subscribed: leaving must not emit an unsubscribe.
        registry.publish_track(video_track(42, "stream-a", "screen"));
        assert!(unsubscribe_messages_for_participant(&registry, 42).is_empty());
    }

    #[test]
    fn speaking_hysteresis_needs_loud_to_start_and_quiet_hold_to_stop() {
        let t0 = Instant::now();
        let mut h = SpeakerHysteresis::new(t0);

        // A level inside the hysteresis band never starts speaking.
        assert!(!h.update((SPEAKING_LEVEL_ON + SPEAKING_LEVEL_OFF) / 2, t0));
        // Clearly loud (below the "on" threshold) starts speaking.
        assert!(h.update(SPEAKING_LEVEL_ON - 1, t0));
        // A mid-band level holds the speaking state.
        assert!(h.update((SPEAKING_LEVEL_ON + SPEAKING_LEVEL_OFF) / 2, t0));
        // Quiet but still within the hold window keeps it lit.
        assert!(h.update(AUDIO_LEVEL_SILENCE, t0 + Duration::from_millis(50)));
        // Quiet past the hold window finally drops it.
        assert!(!h.update(
            AUDIO_LEVEL_SILENCE,
            t0 + SPEAKING_HOLD + Duration::from_millis(1)
        ));
    }

    #[test]
    fn speaking_hysteresis_hold_resets_when_loud_again() {
        let t0 = Instant::now();
        let mut h = SpeakerHysteresis::new(t0);

        assert!(h.update(SPEAKING_LEVEL_ON - 1, t0));
        // Quiet within the hold window, then loud again refreshes `last_loud`.
        assert!(h.update(AUDIO_LEVEL_SILENCE, t0 + Duration::from_millis(200)));
        assert!(h.update(SPEAKING_LEVEL_ON - 1, t0 + Duration::from_millis(250)));
        // The hold window is now measured from the refreshed instant, so a quiet
        // sample that would have exceeded the original hold still keeps speaking.
        assert!(h.update(AUDIO_LEVEL_SILENCE, t0 + Duration::from_millis(400)));
    }
}
