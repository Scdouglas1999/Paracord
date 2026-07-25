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
    cert_hash: String,
    room_id: String,
    advertised_capabilities: Option<super::capabilities::MediaStreamCapabilities>,
    state: State<'_, MediaState>,
    app: tauri::AppHandle,
) -> Result<VoiceSessionInfo, String> {
    use super::session::NativeMediaSession;
    use super::{audio_pipeline, events};

    // The renderer supplies both `endpoint` and `cert_hash`, so certificate
    // pinning is not a control here — a compromised renderer simply pins the
    // certificate of whatever host it wants us to dial. Gate on the *host*
    // against the user's explicitly trusted servers first, exactly as the
    // HTTP/SSE commands do with `ensure_native_fetch_target_is_trusted`.
    crate::ensure_native_media_endpoint_is_trusted(&endpoint)?;

    let mut session = NativeMediaSession::connect(
        &endpoint,
        &token,
        &cert_hash,
        &room_id,
        advertised_capabilities,
    )
    .await?;
    let session_id = session.session_id.clone();

    // Spawn audio pipeline tasks
    audio_pipeline::spawn_audio_send_task(&mut session);
    audio_pipeline::spawn_screen_audio_send_task(&mut session);
    audio_pipeline::spawn_datagram_recv_task(&mut session, app.clone());
    audio_pipeline::spawn_uni_stream_recv_task(&mut session, app.clone());
    audio_pipeline::spawn_playout_task(&mut session);
    events::spawn_control_recv_task(&mut session, app.clone());
    events::spawn_connection_monitor(&mut session, app.clone());

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

    // Store the session, disconnecting any session already in the slot first.
    // Overwriting it in place would leak its spawned tasks, QUIC connection, and
    // audio thread — `Option::replace` drops the old value only after the new one
    // is in place and does not run our async teardown. Take it out and shut it
    // down deterministically before installing the replacement.
    let mut guard = state.session.lock().await;
    if let Some(mut previous) = guard.take() {
        previous.disconnect().await;
    }
    *guard = Some(session);

    Ok(VoiceSessionInfo {
        session_id,
        connected: true,
    })
}

#[tauri::command]
pub async fn stop_voice_session(state: State<'_, MediaState>) -> Result<(), String> {
    super::screen_capture::stop_capture(state.inner()).await?;
    // Camera capture lives in MediaState (not the session), so it must be torn
    // down here too or the nokhwa worker keeps running against a dead session.
    super::camera_capture::stop_capture(state.inner()).await?;
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
    // Belt-and-suspenders: drop any process-wide remote-video state even if no
    // session was present (disconnect already clears it when one was).
    super::video_pipeline::clear_all_stream_video_state();
    Ok(())
}

/// A single enumerated audio device exposed to the renderer.
///
/// `index` is the cpal host enumeration index and is exactly what the
/// `voice_switch_{input,output}_device` commands consume. Host indices are
/// assigned by iterating the device list at enumeration time, so they can shift
/// when devices are added or removed. The renderer must therefore re-enumerate
/// (via `voice_list_*_devices`) and switch as a paired operation rather than
/// caching an index across device-topology changes.
#[derive(Serialize)]
pub struct AudioDeviceInfo {
    pub index: usize,
    pub name: String,
    pub is_default: bool,
}

#[tauri::command]
pub async fn voice_list_output_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    use paracord_codec::audio::playback::list_output_devices;

    let devices = list_output_devices().map_err(|e| format!("list output devices: {e}"))?;
    Ok(devices
        .into_iter()
        .map(|(index, name, is_default)| AudioDeviceInfo {
            index,
            name,
            is_default,
        })
        .collect())
}

#[tauri::command]
pub async fn voice_list_input_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    use paracord_codec::audio::capture::list_input_devices;

    let devices = list_input_devices().map_err(|e| format!("list input devices: {e}"))?;
    Ok(devices
        .into_iter()
        .map(|(index, name, is_default)| AudioDeviceInfo {
            index,
            name,
            is_default,
        })
        .collect())
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

/// Set the playback gain for a remote audio source (contract AU4).
///
/// Identify the source by `user_id` (applies to both that participant's voice
/// and screen-audio tracks) or by raw `ssrc`. Gain is clamped to `0.0..=2.0`.
#[tauri::command]
pub async fn voice_set_source_volume(
    user_id: Option<String>,
    ssrc: Option<u32>,
    gain: f32,
    state: State<'_, MediaState>,
) -> Result<(), String> {
    use super::session::NativeMediaSession;

    let gain = gain.clamp(0.0, 2.0);
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("no active session")?;

    if let Some(ssrc) = ssrc {
        session.audio_actor.set_source_gain(ssrc, gain);
    }
    if let Some(user_id) = user_id {
        let uid: i64 = user_id.parse().map_err(|_| "invalid user id".to_string())?;
        // A participant contributes a voice SSRC and a screen-audio SSRC; the
        // volume control targets both.
        session
            .audio_actor
            .set_source_gain(NativeMediaSession::derive_track_ssrc(uid, "audio"), gain);
        session.audio_actor.set_source_gain(
            NativeMediaSession::derive_track_ssrc(uid, "screen:audio"),
            gain,
        );
    }
    Ok(())
}

/// Toggle microphone noise suppression at runtime (contract AU13; default on).
#[tauri::command]
pub async fn voice_set_noise_suppression(
    enabled: bool,
    state: State<'_, MediaState>,
) -> Result<(), String> {
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("no active session")?;
    session
        .noise_suppression_enabled
        .store(enabled, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn voice_switch_input_device(
    device_id: String,
    state: State<'_, MediaState>,
) -> Result<(), String> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("no active session")?;

    // Start capture on the new device (the actor stops and drops the previous
    // capture stream on its own thread).
    let index: usize = device_id
        .parse()
        .map_err(|_| "invalid device index".to_string())?;
    let rx = session.audio_actor.start_capture(Some(index)).await?;
    session.pcm_rx = Some(rx);

    Ok(())
}

#[tauri::command]
pub async fn voice_switch_output_device(
    device_id: String,
    state: State<'_, MediaState>,
) -> Result<(), String> {
    let index: usize = device_id
        .parse()
        .map_err(|_| "invalid output device index".to_string())?;

    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("no active session")?;

    // Snapshot the live remote SSRCs so the actor can re-attach them to the new
    // output device. The actor builds the replacement device before tearing
    // down the current one and falls back to the system default on a stale
    // index, so a failed switch never leaves the user with no audio output.
    // Both voice (mono) and screen-audio (stereo) sources must be rebuilt, else
    // stream audio would go permanently silent after an output switch (C4/AU4).
    let voice_ssrcs: Vec<u32> = {
        let remote = session.remote_audio.lock().await;
        remote.keys().copied().collect()
    };
    let stream_ssrcs: Vec<u32> = {
        let stream = session.stream_remote_audio.lock().await;
        stream.keys().copied().collect()
    };
    let switched = session
        .audio_actor
        .switch_output_device(index, voice_ssrcs, stream_ssrcs)
        .await?;

    let mut voice_senders = switched.voice;
    let mut stream_senders = switched.stream;
    {
        let mut remote = session.remote_audio.lock().await;
        for (ssrc, remote_state) in remote.iter_mut() {
            if let Some(tx) = voice_senders.remove(ssrc) {
                remote_state.playback_tx = tx;
            }
        }
    }
    {
        let mut stream = session.stream_remote_audio.lock().await;
        for (ssrc, stream_state) in stream.iter_mut() {
            if let Some(tx) = stream_senders.remove(ssrc) {
                stream_state.playback_tx = tx;
            }
        }
    }

    tracing::debug!(device_index = index, "switched audio output device");
    Ok(())
}

// ── Video commands ──────────────────────────────────────────────────────────

/// Enable/disable the local camera. Enabling starts native capture (nokhwa) +
/// the camera encode pipeline; disabling stops capture and unpublishes the
/// track. There is no JS getUserMedia / raw-frame path anymore (contract CAM4):
/// device selection is native (`camera_list_devices`).
#[tauri::command]
pub async fn voice_enable_video(
    enabled: bool,
    device_id: Option<String>,
    quality: Option<String>,
    state: State<'_, MediaState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if enabled {
        let request =
            super::camera_capture::StartCameraRequest::from_quality(device_id, quality.as_deref());
        super::camera_capture::start_capture(state.inner(), app, request).await
    } else {
        super::camera_capture::stop_capture(state.inner()).await
    }
}

/// Enumerate available capture cameras for native device selection (CAM1).
#[tauri::command]
pub async fn camera_list_devices(
    app: tauri::AppHandle,
) -> Result<Vec<super::camera_capture::CameraDevice>, String> {
    super::camera_capture::ensure_camera_consent(&app).await?;
    super::camera_capture::list_devices()
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
    app: tauri::AppHandle,
) -> Result<Vec<super::screen_capture::ScreenShareSource>, String> {
    super::screen_capture::ensure_screen_capture_consent(&app).await?;
    Ok(super::screen_capture::list_sources())
}

#[tauri::command]
pub async fn screen_share_source_thumbnail(
    source_id: String,
    app: tauri::AppHandle,
) -> Result<Option<super::screen_capture::ScreenShareThumbnail>, String> {
    super::screen_capture::ensure_screen_capture_consent(&app).await?;
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

#[tauri::command]
pub async fn voice_set_screen_audio_enabled(
    enabled: bool,
    state: State<'_, MediaState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let (should_announce, screen_audio_tx) = {
        let mut guard = state.session.lock().await;
        let session = guard.as_mut().ok_or("no active session")?;
        session
            .screen_audio_enabled
            .store(enabled, Ordering::SeqCst);
        let announce = enabled
            && session.published_screen_track.is_some()
            && session.published_screen_audio_track.is_none();
        (announce, session.screen_audio_tx.clone())
    };

    // Contract C4/AU3: on loopback-capture platforms (Windows/Linux) the native
    // system-audio capture feeds the session's screen_audio_tx directly — no JS
    // round-trip. macOS captures integrated audio inside the screen-capture path
    // instead, so it is not started here. Fail loudly if capture cannot start
    // (e.g. consent denied, no echo-free routing) rather than silently streaming
    // no audio. Run off the async executor and OUTSIDE the session lock: capture
    // start blocks on a native consent dialog.
    #[cfg(not(target_os = "macos"))]
    {
        if enabled {
            tokio::task::spawn_blocking(move || {
                crate::audio_capture::start_system_audio_capture_into(screen_audio_tx)
            })
            .await
            .map_err(|e| format!("system audio capture start task failed: {e}"))??;
        } else {
            let _ = crate::audio_capture::stop_system_audio_capture();
        }
    }
    #[cfg(target_os = "macos")]
    let _ = screen_audio_tx;

    if should_announce {
        super::screen_capture::announce_screen_audio_track_public(&state, &app).await?;
    } else if !enabled {
        let mut guard = state.session.lock().await;
        if let Some(session) = guard.as_mut() {
            if let Some(track) = session.published_screen_audio_track.take() {
                super::video_pipeline::clear_track_sender_key(session, &track).await;
                {
                    let mut registry = session.stream_registry.lock().await;
                    registry.unpublish_track(&track.stream_id, &track.track_id);
                }
                let _ = session
                    .send_control_message(
                        &paracord_transport::control::ControlMessage::TrackUnpublish {
                            stream_id: track.stream_id.clone(),
                            track_id: track.track_id.clone(),
                        },
                    )
                    .await;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn media_register_stream_video_subscription(
    stream_id: String,
    track_id: String,
    ssrc: u32,
    prefer_encoded: Option<bool>,
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    super::video_pipeline::native_diag(
        Some(&app),
        &format!(
            "register video push subscription: track={stream_id}:{track_id} ssrc={ssrc} \
             prefer_encoded={prefer_encoded:?} channel={}",
            channel.id()
        ),
    );
    #[cfg(feature = "vpx")]
    super::video_pipeline::register_stream_video_subscription(
        &stream_id,
        &track_id,
        ssrc,
        prefer_encoded.unwrap_or(false),
        channel,
    )?;

    #[cfg(not(feature = "vpx"))]
    let _ = (stream_id, track_id, ssrc, prefer_encoded, channel);

    Ok(())
}

/// Encode one real keyframe with the local encoder for `codec` (binary IPC
/// response) so the webview can functionally verify its WebCodecs decoder.
/// Empty body = no local encoder for that codec, i.e. the claim cannot be
/// verified here.
#[tauri::command]
pub async fn media_generate_decode_probe(codec: String) -> Result<tauri::ipc::Response, String> {
    // ffmpeg-backed probes spawn a subprocess (~100-300ms); keep them off the
    // async worker threads.
    let bytes = tokio::task::spawn_blocking(move || {
        super::capabilities::generate_decode_probe_frame(&codec)
    })
    .await
    .map_err(|err| format!("decode probe task failed: {err}"))?;
    Ok(tauri::ipc::Response::new(bytes.unwrap_or_default()))
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

/// Route a keyframe request for `stream_id`:`track_id` (contract C2 / N3). If the
/// track is one of our own published tracks, flip the matching encoder's
/// force-keyframe flag directly; otherwise ask the publisher via the relay.
async fn route_keyframe_request(
    session: &super::session::NativeMediaSession,
    stream_id: String,
    track_id: String,
) -> Result<(), String> {
    let local = match track_id.as_str() {
        "screen" => session
            .published_screen_track
            .as_ref()
            .is_some_and(|track| track.stream_id.0 == stream_id),
        "camera" => session
            .published_video_track
            .as_ref()
            .is_some_and(|track| track.stream_id.0 == stream_id),
        _ => false,
    };
    if local {
        match track_id.as_str() {
            "screen" => session.screen_force_keyframe.store(true, Ordering::SeqCst),
            "camera" => session.video_force_keyframe.store(true, Ordering::SeqCst),
            _ => {}
        }
        return Ok(());
    }
    session
        .send_control_message(&ControlMessage::RequestKeyframe {
            stream_id: StreamId::new(stream_id),
            track_id: TrackId::new(track_id),
            layer_id: None,
        })
        .await
}

#[tauri::command]
pub async fn media_request_keyframe(
    stream_id: String,
    track_id: String,
    state: State<'_, MediaState>,
) -> Result<(), String> {
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("no active session")?;
    route_keyframe_request(session, stream_id, track_id).await
}

#[tauri::command]
pub async fn media_set_stream_visibility(
    stream_id: String,
    track_id: String,
    visible: bool,
    state: State<'_, MediaState>,
) -> Result<(), String> {
    // Toggle native visibility first (no session lock needed — it touches the
    // process-wide dispatch state), then request a keyframe if the resume found
    // the stored frame stale/delta/missing.
    let need_keyframe =
        super::video_pipeline::set_stream_video_visibility(&stream_id, &track_id, visible);
    if need_keyframe {
        let guard = state.session.lock().await;
        if let Some(session) = guard.as_ref() {
            route_keyframe_request(session, stream_id, track_id).await?;
        }
    }
    Ok(())
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
                                codec: super::video_pipeline::codec_label(state.codec).to_string(),
                                backend: state.backend_name.to_string(),
                                hardware_accelerated: state.hardware_accelerated,
                            }),
                        screen: session
                            .screen_simulcast
                            .as_ref()
                            .map(|state| ActiveVideoBackend {
                                codec: super::video_pipeline::codec_label(state.codec).to_string(),
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
    let codec = codec
        .as_deref()
        .and_then(super::capabilities::video_codec_from_label);
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
    // Record the viewport for the native-decode downscale (N6): raw I420 frames
    // are shrunk to this tile size before crossing IPC.
    super::video_pipeline::set_stream_video_viewport(
        &stream_id.0,
        &track_id.0,
        request.viewport_width.unwrap_or(0),
        request.viewport_height.unwrap_or(0),
    );
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
    cert_hash: String,
    transfer_id: String,
    file_path: String,
    app: tauri::AppHandle,
) -> Result<FileTransferResult, String> {
    // Same trust gate as `start_voice_session`: the caller chooses both the
    // endpoint and the certificate pin, so the pin proves nothing on its own.
    crate::ensure_native_media_endpoint_is_trusted(&endpoint)?;
    let validated_path = validate_file_path(&app, &file_path)?;
    let path_str = validated_path
        .to_str()
        .ok_or_else(|| "file path contains invalid characters".to_string())?;
    super::file_transfer::upload_file(&endpoint, &token, &cert_hash, &transfer_id, path_str, app)
        .await
}

#[tauri::command]
pub async fn quic_download_file(
    endpoint: String,
    token: String,
    cert_hash: String,
    attachment_id: String,
    dest_path: String,
    app: tauri::AppHandle,
) -> Result<FileTransferResult, String> {
    // Same trust gate as `start_voice_session`: the caller chooses both the
    // endpoint and the certificate pin, so the pin proves nothing on its own.
    crate::ensure_native_media_endpoint_is_trusted(&endpoint)?;
    let validated_path = validate_file_path(&app, &dest_path)?;
    let path_str = validated_path
        .to_str()
        .ok_or_else(|| "file path contains invalid characters".to_string())?;
    super::file_transfer::download_file(
        &endpoint,
        &token,
        &cert_hash,
        &attachment_id,
        path_str,
        app,
    )
    .await
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
