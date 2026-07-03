use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tauri::State;

use super::MediaState;
use paracord_transport::control::ControlMessage;
use paracord_transport::stream::{PublishedTrack, StreamId, TrackId, TrackSubscription};

#[derive(Serialize)]
pub struct VoiceSessionInfo {
    pub session_id: String,
    pub connected: bool,
}

#[derive(Serialize)]
pub struct FileTransferResult {
    pub transfer_id: String,
    pub attachment_id: Option<String>,
    pub url: Option<String>,
    pub success: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSubscriptionDiagnostics {
    pub stream_id: String,
    pub track_id: String,
    pub requested_layer: Option<u8>,
    pub active_layer: Option<u8>,
    pub viewport: Option<paracord_transport::stream::ViewportHint>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamDiagnostics {
    pub connected: bool,
    pub session_id: Option<String>,
    pub room_id: Option<String>,
    pub participant_count: usize,
    pub participants: Vec<SessionParticipantCapabilities>,
    pub published_tracks: Vec<PublishedTrack>,
    pub subscriptions: Vec<TrackSubscriptionDiagnostics>,
    pub capabilities: super::capabilities::MediaStreamCapabilities,
    pub active_publish_backends: ActivePublishBackendDiagnostics,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActivePublishBackendDiagnostics {
    pub camera: Option<ActiveVideoBackend>,
    pub screen: Option<ActiveVideoBackend>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveVideoBackend {
    pub codec: String,
    pub backend: String,
    pub hardware_accelerated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionParticipantCapabilities {
    pub user_id: String,
    pub session_id: String,
    pub video_capabilities: Vec<paracord_transport::stream::VideoCodecCapability>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedSenderKey {
    pub epoch: u8,
    pub raw_key: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedKeyRecipient {
    pub recipient_user_id: String,
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartNativeScreenShareRequest {
    pub source_id: Option<String>,
    pub max_frame_rate: Option<u32>,
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
    pub max_bitrate_bps: Option<u32>,
    pub content_hint: Option<String>,
    pub preferred_codec: Option<String>,
    pub capture_audio: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSubscriptionRequest {
    pub stream_id: String,
    pub track_id: String,
    pub requested_layer: Option<u8>,
    pub active_layer: Option<u8>,
    pub viewport_width: Option<u32>,
    pub viewport_height: Option<u32>,
}

// ── Voice session lifecycle ──────────────────────────────────────────────────

#[tauri::command]
pub async fn start_voice_session(
    endpoint: String,
    token: String,
    room_id: String,
    advertised_capabilities: Option<super::capabilities::MediaStreamCapabilities>,
    state: State<'_, MediaState>,
    app: tauri::AppHandle,
) -> Result<VoiceSessionInfo, String> {
    use super::session::NativeMediaSession;
    use super::{audio_pipeline, events};

    let mut session =
        NativeMediaSession::connect(&endpoint, &token, &room_id, advertised_capabilities).await?;
    let session_id = session.session_id.clone();

    // Spawn audio pipeline tasks
    audio_pipeline::spawn_audio_send_task(&mut session);
    audio_pipeline::spawn_datagram_recv_task(&mut session, app.clone());
    audio_pipeline::spawn_playout_task(&mut session);
    events::spawn_control_recv_task(&mut session, app.clone());

    // Spawn event tasks
    events::spawn_speaking_detector(&mut session, app.clone());

    session
        .send_control_message(&ControlMessage::SessionJoin {
            room_id: session.room_id.clone(),
            session_id: session.session_id.clone(),
            video_capabilities: session
                .stream_capabilities
                .video
                .iter()
                .map(|capability| capability.to_transport())
                .collect(),
        })
        .await?;

    // Store the session
    let mut guard = state.session.lock().await;
    *guard = Some(session);

    Ok(VoiceSessionInfo {
        session_id,
        connected: true,
    })
}

#[tauri::command]
pub async fn stop_voice_session(state: State<'_, MediaState>) -> Result<(), String> {
    super::screen_capture::stop_capture(state.inner()).await?;
    let mut guard = state.session.lock().await;
    if let Some(mut session) = guard.take() {
        let _ = session
            .send_control_message(&ControlMessage::SessionLeave {
                room_id: session.room_id.clone(),
                session_id: session.session_id.clone(),
            })
            .await;
        session.disconnect().await;
    }
    Ok(())
}

// ── Mute / deaf / device switching ──────────────────────────────────────────

#[tauri::command]
pub async fn voice_set_mute(muted: bool, state: State<'_, MediaState>) -> Result<(), String> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("no active session")?;
    session
        .muted
        .store(muted, std::sync::atomic::Ordering::SeqCst);

    // When muting, stop capture to save CPU; when unmuting, restart
    drop(guard);
    // Note: capture start/stop handled by the send task checking the muted flag
    Ok(())
}

#[tauri::command]
pub async fn voice_set_deaf(deafened: bool, state: State<'_, MediaState>) -> Result<(), String> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("no active session")?;
    session
        .deafened
        .store(deafened, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn voice_switch_input_device(
    device_id: String,
    state: State<'_, MediaState>,
) -> Result<(), String> {
    use paracord_codec::audio::capture::AudioCapture;

    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("no active session")?;

    // Stop existing capture
    if let Some(old) = session.audio_capture.take() {
        old.stop();
    }

    // Start capture on new device
    let index: usize = device_id
        .parse()
        .map_err(|_| "invalid device index".to_string())?;
    let (capture, rx) =
        AudioCapture::start_device(index).map_err(|e| format!("capture device: {e}"))?;
    session.audio_capture = Some(capture);
    session.pcm_rx = Some(rx);

    Ok(())
}

#[tauri::command]
pub async fn voice_switch_output_device(
    device_id: String,
    state: State<'_, MediaState>,
) -> Result<(), String> {
    use paracord_codec::audio::playback::AudioPlayback;

    let index: usize = device_id
        .parse()
        .map_err(|_| "invalid output device index".to_string())?;

    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("no active session")?;

    let replacement =
        AudioPlayback::start_device(index).map_err(|e| format!("output device: {e}"))?;

    {
        let mut remote = session.remote_audio.lock().await;
        for (ssrc, remote_state) in remote.iter_mut() {
            remote_state.playback_tx = replacement.add_source(*ssrc);
        }
    }

    {
        let mut playback = session.audio_playback.lock().await;
        playback.stop();
        *playback = replacement;
    }

    tracing::debug!(device_index = index, "switched audio output device");
    Ok(())
}

// ── Video commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn voice_enable_video(enabled: bool, state: State<'_, MediaState>) -> Result<(), String> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("no active session")?;
    super::video_pipeline::set_video_enabled(session, enabled).await
}

#[tauri::command]
pub async fn voice_start_screen_share(state: State<'_, MediaState>) -> Result<(), String> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("no active session")?;
    super::video_pipeline::start_screen_share(
        session,
        1280,
        720,
        30,
        None,
        Some("motion"),
        Some("vp9"),
    )
}

#[tauri::command]
pub async fn voice_stop_screen_share(state: State<'_, MediaState>) -> Result<(), String> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("no active session")?;
    super::video_pipeline::stop_screen_share(session);
    session.screen_audio_enabled.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn screen_share_list_sources(
) -> Result<Vec<super::screen_capture::ScreenShareSource>, String> {
    Ok(super::screen_capture::list_sources())
}

#[tauri::command]
pub async fn screen_share_source_thumbnail(
    source_id: String,
) -> Result<Option<super::screen_capture::ScreenShareThumbnail>, String> {
    super::screen_capture::capture_source_thumbnail(&source_id)
}

#[tauri::command]
pub async fn screen_share_start(
    request: StartNativeScreenShareRequest,
    state: State<'_, MediaState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    super::screen_capture::start_capture(
        state.inner(),
        app,
        super::screen_capture::StartScreenShareRequest {
            source_id: request.source_id,
            max_frame_rate: request.max_frame_rate.unwrap_or(30),
            max_width: request.max_width,
            max_height: request.max_height,
            max_bitrate_bps: request.max_bitrate_bps,
            content_hint: request.content_hint,
            preferred_codec: request.preferred_codec,
            capture_audio: request.capture_audio,
        },
    )
    .await
}

#[tauri::command]
pub async fn screen_share_stop(state: State<'_, MediaState>) -> Result<(), String> {
    super::screen_capture::stop_capture(state.inner()).await
}

/// Parse a binary frame payload: `[width:u32 LE][height:u32 LE][RGBA bytes…]`
fn parse_frame_payload<'a>(
    request: &'a tauri::ipc::Request<'a>,
) -> Result<(u32, u32, &'a [u8]), String> {
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => return Err("expected binary frame data".into()),
    };
    if body.len() < 8 {
        return Err("frame payload too short".into());
    }
    let width = u32::from_le_bytes(body[0..4].try_into().unwrap());
    let height = u32::from_le_bytes(body[4..8].try_into().unwrap());
    Ok((width, height, &body[8..]))
}

#[tauri::command]
pub async fn voice_push_video_frame(
    request: tauri::ipc::Request<'_>,
    state: State<'_, MediaState>,
) -> Result<(), String> {
    let (width, height, rgba) = parse_frame_payload(&request)?;
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("no active session")?;
    super::video_pipeline::encode_and_send_video_frame(
        session, width, height, rgba, false, false, None,
    )
}

#[tauri::command]
pub async fn voice_push_screen_frame(
    request: tauri::ipc::Request<'_>,
    state: State<'_, MediaState>,
) -> Result<(), String> {
    let (width, height, rgba) = parse_frame_payload(&request)?;
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("no active session")?;
    super::video_pipeline::encode_and_send_video_frame(
        session, width, height, rgba, true, false, None,
    )
}

#[tauri::command]
pub async fn voice_set_screen_audio_enabled(
    enabled: bool,
    state: State<'_, MediaState>,
) -> Result<(), String> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("no active session")?;
    session
        .screen_audio_enabled
        .store(enabled, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn voice_push_screen_audio_frame(
    samples: Vec<f32>,
    state: State<'_, MediaState>,
) -> Result<(), String> {
    if samples.is_empty() {
        return Ok(());
    }

    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("no active session")?;
    if !session.screen_audio_enabled.load(Ordering::SeqCst) {
        return Ok(());
    }

    let _ = session.screen_audio_tx.try_send(samples);
    Ok(())
}

#[tauri::command]
pub async fn media_register_stream_video_subscription(
    stream_id: String,
    track_id: String,
    ssrc: u32,
) -> Result<(), String> {
    #[cfg(feature = "vpx")]
    super::video_pipeline::register_stream_video_subscription(&stream_id, &track_id, ssrc)?;

    #[cfg(not(feature = "vpx"))]
    let _ = (stream_id, track_id, ssrc);

    Ok(())
}

#[tauri::command]
pub async fn media_unregister_stream_video_subscription(
    stream_id: String,
    track_id: String,
) -> Result<(), String> {
    #[cfg(feature = "vpx")]
    super::video_pipeline::unregister_stream_video_subscription(&stream_id, &track_id);

    #[cfg(not(feature = "vpx"))]
    let _ = (stream_id, track_id);

    Ok(())
}

#[tauri::command]
pub async fn media_pull_stream_video_frame(
    stream_id: String,
    track_id: String,
    after_sequence: Option<u64>,
) -> Result<Option<super::video_pipeline::PulledVideoFrameResponse>, String> {
    #[cfg(feature = "vpx")]
    {
        return Ok(
            super::video_pipeline::pull_latest_remote_stream_video_frame(
                &stream_id,
                &track_id,
                after_sequence,
            )
            .map(super::video_pipeline::encode_pulled_video_frame_response),
        );
    }

    #[cfg(not(feature = "vpx"))]
    {
        let _ = (stream_id, track_id, after_sequence);
        Ok(None)
    }
}

#[tauri::command]
pub async fn media_get_stream_capabilities(
    state: State<'_, MediaState>,
) -> Result<super::capabilities::MediaStreamCapabilities, String> {
    let guard = state.session.lock().await;
    if let Some(session) = guard.as_ref() {
        return Ok(session.stream_capabilities.clone());
    }
    Ok(super::capabilities::detect_media_stream_capabilities())
}

#[tauri::command]
pub async fn media_list_published_tracks(
    state: State<'_, MediaState>,
) -> Result<Vec<PublishedTrack>, String> {
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("no active session")?;
    let registry = session.stream_registry.lock().await;
    Ok(registry.published_tracks())
}

#[tauri::command]
pub async fn media_get_stream_diagnostics(
    state: State<'_, MediaState>,
) -> Result<StreamDiagnostics, String> {
    let guard = state.session.lock().await;
    if let Some(session) = guard.as_ref() {
        let registry = session.stream_registry.lock().await;
        let subscriptions = registry
            .subscriptions()
            .into_iter()
            .map(|subscription| TrackSubscriptionDiagnostics {
                stream_id: subscription.stream_id.0,
                track_id: subscription.track_id.0,
                requested_layer: subscription.requested_layer,
                active_layer: subscription.active_layer,
                viewport: subscription.viewport,
            })
            .collect::<Vec<_>>();
        let participant_count = session.session_participants.lock().await.len();
        let participants = session
            .session_participants
            .lock()
            .await
            .iter()
            .map(|(user_id, participant)| SessionParticipantCapabilities {
                user_id: user_id.to_string(),
                session_id: participant.session_id.clone(),
                video_capabilities: participant.video_capabilities.clone(),
            })
            .collect::<Vec<_>>();
        return Ok(StreamDiagnostics {
            connected: true,
            session_id: Some(session.session_id.clone()),
            room_id: Some(session.room_id.clone()),
            participant_count,
            participants,
            published_tracks: registry.published_tracks(),
            subscriptions,
            capabilities: session.stream_capabilities.clone(),
            active_publish_backends: {
                #[cfg(feature = "vpx")]
                {
                    ActivePublishBackendDiagnostics {
                        camera: session
                            .video_simulcast
                            .as_ref()
                            .map(|state| ActiveVideoBackend {
                                codec: format!("{:?}", state.codec).to_lowercase(),
                                backend: state.backend_name.to_string(),
                                hardware_accelerated: state.hardware_accelerated,
                            }),
                        screen: session
                            .screen_simulcast
                            .as_ref()
                            .map(|state| ActiveVideoBackend {
                                codec: format!("{:?}", state.codec).to_lowercase(),
                                backend: state.backend_name.to_string(),
                                hardware_accelerated: state.hardware_accelerated,
                            }),
                    }
                }
                #[cfg(not(feature = "vpx"))]
                {
                    ActivePublishBackendDiagnostics::default()
                }
            },
        });
    }

    Ok(StreamDiagnostics {
        connected: false,
        session_id: None,
        room_id: None,
        participant_count: 0,
        participants: Vec::new(),
        published_tracks: Vec::new(),
        subscriptions: Vec::new(),
        capabilities: super::capabilities::detect_media_stream_capabilities(),
        active_publish_backends: ActivePublishBackendDiagnostics::default(),
    })
}

#[tauri::command]
pub async fn media_list_session_participants(
    state: State<'_, MediaState>,
) -> Result<Vec<String>, String> {
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("no active session")?;
    let participants = session
        .session_participants
        .lock()
        .await
        .keys()
        .map(|user_id| user_id.to_string())
        .collect();
    Ok(participants)
}

#[tauri::command]
pub async fn media_list_session_participant_capabilities(
    state: State<'_, MediaState>,
) -> Result<Vec<SessionParticipantCapabilities>, String> {
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("no active session")?;
    let participants = session
        .session_participants
        .lock()
        .await
        .iter()
        .map(|(user_id, participant)| SessionParticipantCapabilities {
            user_id: user_id.to_string(),
            session_id: participant.session_id.clone(),
            video_capabilities: participant.video_capabilities.clone(),
        })
        .collect();
    Ok(participants)
}

#[tauri::command]
pub async fn media_export_audio_sender_key(
    state: State<'_, MediaState>,
) -> Result<ExportedSenderKey, String> {
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("no active session")?;
    let sender_state = session
        .audio_sender_state
        .lock()
        .map_err(|_| "audio sender state lock poisoned".to_string())?;
    Ok(ExportedSenderKey {
        epoch: sender_state.epoch,
        raw_key: sender_state.key.to_vec(),
    })
}

#[tauri::command]
pub async fn media_export_track_sender_key(
    stream_id: String,
    track_id: String,
    state: State<'_, MediaState>,
) -> Result<ExportedSenderKey, String> {
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("no active session")?;
    let sender_keys = session.track_sender_keys.lock().await;
    let sender_state = sender_keys
        .get(&(StreamId::new(stream_id), TrackId::new(track_id)))
        .copied()
        .ok_or("no sender key for track".to_string())?;
    Ok(ExportedSenderKey {
        epoch: sender_state.epoch,
        raw_key: sender_state.key.to_vec(),
    })
}

/// Parse `EncryptedKeyRecipient` entries (with string user ids) into the
/// `(i64, ciphertext)` pairs the transport control messages expect.
fn parse_encrypted_key_recipients(
    encrypted_keys: Vec<EncryptedKeyRecipient>,
) -> Result<Vec<(i64, Vec<u8>)>, String> {
    encrypted_keys
        .into_iter()
        .map(|entry| {
            let recipient_user_id = entry
                .recipient_user_id
                .parse::<i64>()
                .map_err(|_| "invalid recipient user id".to_string())?;
            Ok((recipient_user_id, entry.ciphertext))
        })
        .collect()
}

#[tauri::command]
pub async fn media_send_audio_key_announce(
    epoch: u8,
    encrypted_keys: Vec<EncryptedKeyRecipient>,
    state: State<'_, MediaState>,
) -> Result<(), String> {
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("no active session")?;
    let payload = parse_encrypted_key_recipients(encrypted_keys)?;
    session
        .send_control_message(&ControlMessage::KeyAnnounce {
            epoch,
            encrypted_keys: payload,
        })
        .await
}

#[tauri::command]
pub async fn media_send_track_key_announce(
    stream_id: String,
    track_id: String,
    codec: Option<String>,
    epoch: u8,
    encrypted_keys: Vec<EncryptedKeyRecipient>,
    state: State<'_, MediaState>,
) -> Result<(), String> {
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("no active session")?;
    let payload = parse_encrypted_key_recipients(encrypted_keys)?;
    let codec = match codec
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some("av1") => Some(paracord_transport::stream::VideoCodec::Av1),
        Some("h264") => Some(paracord_transport::stream::VideoCodec::H264),
        Some("vp9") => Some(paracord_transport::stream::VideoCodec::Vp9),
        Some(_) => None,
        None => None,
    };
    session
        .send_control_message(&ControlMessage::StreamKeyAnnounce {
            stream_id: StreamId::new(stream_id),
            track_id: TrackId::new(track_id),
            codec,
            epoch,
            encrypted_keys: payload,
        })
        .await
}

#[tauri::command]
pub async fn media_register_track_subscription(
    request: StreamSubscriptionRequest,
    state: State<'_, MediaState>,
) -> Result<(), String> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("no active session")?;
    let stream_id = StreamId::new(request.stream_id);
    let track_id = TrackId::new(request.track_id);
    let viewport = match (request.viewport_width, request.viewport_height) {
        (Some(width), Some(height)) => {
            Some(paracord_transport::stream::ViewportHint { width, height })
        }
        _ => None,
    };
    let subscription = TrackSubscription {
        stream_id: stream_id.clone(),
        track_id: track_id.clone(),
        requested_layer: request.requested_layer,
        active_layer: request.active_layer,
        viewport: viewport.clone(),
    };
    let estimated_bitrate_kbps = {
        let registry = session.stream_registry.lock().await;
        registry
            .get_published_track(&stream_id, &track_id)
            .and_then(|track| {
                let preferred_layer_id = request
                    .active_layer
                    .or(request.requested_layer)
                    .or_else(|| subscription.resolved_layer_id(&track));
                track
                    .layers
                    .iter()
                    .find(|layer| Some(layer.layer_id) == preferred_layer_id)
                    .or_else(|| track.layers.iter().find(|layer| layer.active))
                    .or_else(|| track.layers.last())
                    .and_then(|layer| layer.max_bitrate_kbps)
            })
            .unwrap_or(0)
    };
    {
        let mut registry = session.stream_registry.lock().await;
        registry.subscribe(subscription.clone());
    }
    session
        .send_control_message(&ControlMessage::SubscribeStream { subscription })
        .await?;
    session
        .send_control_message(&ControlMessage::ReceiverReport {
            stream_id,
            track_id,
            active_layer: request.active_layer.or(request.requested_layer),
            viewport,
            estimated_bitrate_kbps,
            packet_loss_ppm: 0,
        })
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn media_unregister_track_subscription(
    stream_id: String,
    track_id: String,
    state: State<'_, MediaState>,
) -> Result<(), String> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("no active session")?;
    let stream_id = StreamId::new(stream_id);
    let track_id = TrackId::new(track_id);
    {
        let mut registry = session.stream_registry.lock().await;
        registry.unsubscribe(&stream_id, &track_id);
    }
    super::video_pipeline::remove_remote_video_decoder(&stream_id.0, &track_id.0);
    session
        .send_control_message(&ControlMessage::UnsubscribeStream {
            stream_id,
            track_id,
        })
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn media_subscribe_audio(
    user_id: String,
    state: State<'_, MediaState>,
) -> Result<(), String> {
    let user_id = user_id
        .parse::<i64>()
        .map_err(|_| "invalid user id".to_string())?;
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("no active session")?;
    session
        .send_control_message(&ControlMessage::Subscribe {
            user_id,
            track_type: paracord_transport::control::TrackKind::Audio,
        })
        .await
}

#[tauri::command]
pub async fn media_unsubscribe_audio(
    user_id: String,
    state: State<'_, MediaState>,
) -> Result<(), String> {
    let user_id = user_id
        .parse::<i64>()
        .map_err(|_| "invalid user id".to_string())?;
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("no active session")?;
    session
        .send_control_message(&ControlMessage::Unsubscribe {
            user_id,
            track_type: paracord_transport::control::TrackKind::Audio,
        })
        .await
}

#[tauri::command]
pub async fn media_apply_audio_sender_key(
    sender_user_id: String,
    epoch: u8,
    raw_key: Vec<u8>,
    state: State<'_, MediaState>,
) -> Result<(), String> {
    use paracord_codec::crypto::KEY_SIZE;

    let key: [u8; KEY_SIZE] = raw_key
        .try_into()
        .map_err(|_| "audio sender key must be exactly 16 bytes".to_string())?;
    let sender_user_id = sender_user_id
        .parse::<i64>()
        .map_err(|_| "invalid sender user id".to_string())?;

    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("no active session")?;
    let sender_audio_ssrc =
        super::session::NativeMediaSession::derive_track_ssrc(sender_user_id, "audio");
    let mut decryptor = session
        .frame_decryptor
        .lock()
        .map_err(|_| "frame decryptor lock poisoned".to_string())?;
    decryptor.set_peer_key(sender_audio_ssrc, epoch, &key);
    Ok(())
}

#[tauri::command]
pub async fn media_apply_track_sender_key(
    stream_id: String,
    track_id: String,
    epoch: u8,
    raw_key: Vec<u8>,
    state: State<'_, MediaState>,
) -> Result<(), String> {
    use paracord_codec::crypto::KEY_SIZE;

    let key: [u8; KEY_SIZE] = raw_key
        .try_into()
        .map_err(|_| "track sender key must be exactly 16 bytes".to_string())?;

    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("no active session")?;
    let stream_id = StreamId::new(stream_id);
    let track_id = TrackId::new(track_id);
    let track = {
        let mut registry = session.stream_registry.lock().await;
        registry.store_delivered_track_key(&stream_id, &track_id, epoch, key);
        registry.get_published_track(&stream_id, &track_id)
    };

    if let Some(track) = track {
        let mut decryptor = session
            .frame_decryptor
            .lock()
            .map_err(|_| "frame decryptor lock poisoned".to_string())?;
        for layer in &track.layers {
            decryptor.set_peer_key(layer.ssrc, epoch, &key);
        }
    }

    Ok(())
}

// ── File transfer ───────────────────────────────────────────────────────────

/// Validate that a file path is within one of the allowed base directories
/// (app data dir or OS downloads dir). This prevents JS from reading/writing
/// arbitrary files on disk via the QUIC file transfer IPC commands.
fn validate_file_path(
    app: &tauri::AppHandle,
    raw_path: &str,
) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;

    // Build the list of allowed base directories (already canonicalized).
    let mut allowed_bases: Vec<std::path::PathBuf> = Vec::new();

    if let Ok(app_data) = app.path().app_data_dir() {
        // Ensure the app data dir exists for canonicalization
        let _ = std::fs::create_dir_all(&app_data);
        if let Ok(canonical) = app_data.canonicalize() {
            allowed_bases.push(canonical);
        }
    }

    if let Ok(download_dir) = app.path().download_dir() {
        if let Ok(canonical) = download_dir.canonicalize() {
            allowed_bases.push(canonical);
        }
    }

    if allowed_bases.is_empty() {
        return Err("could not resolve any allowed base directory".into());
    }

    validate_file_path_within_bases(raw_path, &allowed_bases)
}

/// Confine `raw_path` to one of `allowed_bases`, rejecting `..` traversal and
/// symlinks that would escape the base. `allowed_bases` must already be
/// canonicalized. Split out from [`validate_file_path`] so it can be unit-tested
/// without a live `tauri::AppHandle`.
fn validate_file_path_within_bases(
    raw_path: &str,
    allowed_bases: &[std::path::PathBuf],
) -> Result<std::path::PathBuf, String> {
    let requested = std::path::PathBuf::from(raw_path);

    // Reject obviously suspicious components before canonicalization
    for component in requested.components() {
        if let std::path::Component::ParentDir = component {
            return Err("file path must not contain '..' components".into());
        }
    }

    // For uploads, the file must already exist — canonicalize it (which fully
    // resolves any symlinks). For downloads, the parent directory must exist and
    // be within an allowed base.
    let canonical = if requested.exists() {
        requested
            .canonicalize()
            .map_err(|e| format!("failed to resolve file path: {e}"))?
    } else {
        // File doesn't exist yet (download target). Canonicalize the parent.
        let parent = requested
            .parent()
            .ok_or_else(|| "file path has no parent directory".to_string())?;
        if !parent.exists() {
            return Err(format!(
                "parent directory does not exist: {}",
                parent.display()
            ));
        }
        let canonical_parent = parent
            .canonicalize()
            .map_err(|e| format!("failed to resolve parent directory: {e}"))?;
        let file_name = requested
            .file_name()
            .ok_or_else(|| "file path has no file name".to_string())?;
        let final_path = canonical_parent.join(file_name);

        // Re-canonicalization guard: the parent is now symlink-free, but the
        // final component itself may be a symlink (possibly dangling, which is
        // why `exists()` above returned false). The OS would follow it on
        // write and escape the base, so reject any symlink at that component.
        if let Ok(metadata) = std::fs::symlink_metadata(&final_path) {
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "file path final component is a symlink: {}",
                    final_path.display()
                ));
            }
        }
        final_path
    };

    // Verify the canonical path is under one of the allowed bases
    let is_allowed = allowed_bases.iter().any(|base| canonical.starts_with(base));
    if !is_allowed {
        return Err(format!(
            "file path is outside the allowed directories (app data, downloads): {}",
            canonical.display()
        ));
    }

    Ok(canonical)
}

#[tauri::command]
pub async fn quic_upload_file(
    endpoint: String,
    token: String,
    transfer_id: String,
    file_path: String,
    app: tauri::AppHandle,
) -> Result<FileTransferResult, String> {
    let validated_path = validate_file_path(&app, &file_path)?;
    let path_str = validated_path
        .to_str()
        .ok_or_else(|| "file path contains invalid characters".to_string())?;
    super::file_transfer::upload_file(&endpoint, &token, &transfer_id, path_str, app).await
}

#[tauri::command]
pub async fn quic_download_file(
    endpoint: String,
    token: String,
    attachment_id: String,
    dest_path: String,
    app: tauri::AppHandle,
) -> Result<FileTransferResult, String> {
    let validated_path = validate_file_path(&app, &dest_path)?;
    let path_str = validated_path
        .to_str()
        .ok_or_else(|| "file path contains invalid characters".to_string())?;
    super::file_transfer::download_file(&endpoint, &token, &attachment_id, path_str, app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Create a fresh, canonicalized temp directory for a test. Canonicalizing
    /// matches how `validate_file_path` supplies its (already-canonical) bases.
    fn unique_dir(tag: &str) -> PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "paracord-vfp-{tag}-{}-{}-{}",
            std::process::id(),
            nanos,
            n
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn accepts_existing_file_within_base() {
        let base = unique_dir("existing");
        let file = base.join("inside.txt");
        std::fs::write(&file, b"hello").unwrap();

        let result =
            validate_file_path_within_bases(file.to_str().unwrap(), std::slice::from_ref(&base))
                .expect("existing file within base should be accepted");
        assert!(result.starts_with(&base));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn accepts_nonexistent_download_target_within_base() {
        let base = unique_dir("download");
        let target = base.join("newfile.bin");

        let result =
            validate_file_path_within_bases(target.to_str().unwrap(), std::slice::from_ref(&base))
                .expect("non-existent target inside base should be accepted");
        assert_eq!(result, target);
        assert!(result.starts_with(&base));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_parent_dir_component() {
        let base = unique_dir("dotdot");
        let raw = format!("{}/../escape.txt", base.display());

        let err = validate_file_path_within_bases(&raw, std::slice::from_ref(&base))
            .expect_err("'..' components must be rejected");
        assert!(err.contains(".."), "unexpected error: {err}");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_path_outside_base() {
        let base = unique_dir("base");
        let other = unique_dir("other");
        let secret = other.join("secret.txt");
        std::fs::write(&secret, b"secret").unwrap();

        let err =
            validate_file_path_within_bases(secret.to_str().unwrap(), std::slice::from_ref(&base))
                .expect_err("path outside all bases must be rejected");
        assert!(err.contains("outside"), "unexpected error: {err}");

        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&other);
    }

    /// The core regression test for the re-canonicalization fix: a dangling
    /// symlink placed inside the base directory whose target escapes the base.
    /// `exists()` returns false for a dangling symlink, so this exercises the
    /// download-target branch, where the parent is canonicalized but the final
    /// component is not — the symlink guard must catch it.
    #[cfg(unix)]
    #[test]
    fn rejects_dangling_symlink_final_component_escape() {
        use std::os::unix::fs::symlink;

        let base = unique_dir("symlink-dangling");
        let outside = unique_dir("symlink-outside");
        let escape_target = outside.join("does-not-exist.txt");
        let link = base.join("evil");
        symlink(&escape_target, &link).unwrap();

        let err =
            validate_file_path_within_bases(link.to_str().unwrap(), std::slice::from_ref(&base))
                .expect_err("dangling symlink escaping base must be rejected");
        assert!(err.contains("symlink"), "unexpected error: {err}");

        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// A symlink inside the base pointing to an existing file outside the base:
    /// `exists()` is true, so canonicalization resolves it outside the base and
    /// the `starts_with` check rejects it.
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_to_existing_file_outside_base() {
        use std::os::unix::fs::symlink;

        let base = unique_dir("symlink-existing");
        let outside = unique_dir("symlink-real");
        let real = outside.join("real.txt");
        std::fs::write(&real, b"data").unwrap();
        let link = base.join("evil2");
        symlink(&real, &link).unwrap();

        let err =
            validate_file_path_within_bases(link.to_str().unwrap(), std::slice::from_ref(&base))
                .expect_err("symlink to existing file outside base must be rejected");
        assert!(err.contains("outside"), "unexpected error: {err}");

        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
