use std::sync::atomic::Ordering;
use std::time::Instant;

use bytes::{BufMut, BytesMut};
use tokio::time::{interval, Duration};

use paracord_codec::audio::opus::FRAME_SIZE;
use paracord_transport::protocol::{MediaHeader, TrackType, HEADER_SIZE};

use super::session::NativeMediaSession;

const VOICE_BITRATE_BPS: i32 = 96_000;
const STREAM_BITRATE_BPS: i32 = 192_000;

/// Spawn the audio send task: captures mic → noise suppress → Opus encode → encrypt → QUIC datagram.
pub fn spawn_audio_send_task(session: &mut NativeMediaSession) {
    let muted = session.muted.clone();
    let screen_audio_enabled = session.screen_audio_enabled.clone();
    let shutdown = session.shutdown.clone();
    let local_ssrc = session.local_ssrc;

    // Take ownership of the PCM receiver — it moves into the task
    let Some(mut pcm_rx) = session.pcm_rx.take() else {
        return;
    };
    let mut screen_audio_rx = session.screen_audio_rx.take();

    let conn_inner = session.connection.inner().clone();
    let current_key_epoch = session.current_key_epoch.clone();
    let frame_encryptor = session.frame_encryptor.clone();

    let handle = tokio::spawn(async move {
        // Per-task codec instances (avoids borrowing from session across await)
        let mut opus_encoder = match paracord_codec::audio::opus::OpusEncoder::new() {
            Ok(e) => e,
            Err(e) => {
                tracing::error!("audio send task: opus encoder init failed: {e}");
                return;
            }
        };
        let mut noise_suppressor = paracord_codec::audio::noise::NoiseSuppressor::new();
        let mut seq: u16 = 0;
        let mut timestamp: u32 = 0;
        let mut latest_screen_frame: Option<Vec<f32>> = None;
        let mut active_bitrate = VOICE_BITRATE_BPS;

        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                maybe_screen = async {
                    match screen_audio_rx.as_mut() {
                        Some(rx) => rx.recv().await,
                        None => std::future::pending::<Option<Vec<f32>>>().await,
                    }
                } => {
                    match maybe_screen {
                        Some(frame) => latest_screen_frame = Some(frame),
                        None => screen_audio_rx = None,
                    }
                }
                frame = pcm_rx.recv() => {
                    let Some(pcm) = frame else { break };

                    let include_screen_audio = screen_audio_enabled.load(Ordering::SeqCst);
                    let has_screen_audio = include_screen_audio && latest_screen_frame.is_some();
                    let mic_muted = muted.load(Ordering::SeqCst);
                    if mic_muted && !has_screen_audio {
                        continue;
                    }

                    // Use a higher Opus bitrate while screen audio is active.
                    let target_bitrate = if has_screen_audio {
                        STREAM_BITRATE_BPS
                    } else {
                        VOICE_BITRATE_BPS
                    };
                    if target_bitrate != active_bitrate {
                        if let Err(e) = opus_encoder.set_bitrate(target_bitrate) {
                            tracing::warn!("opus bitrate update failed: {e}");
                        } else {
                            active_bitrate = target_bitrate;
                        }
                    }

                    // Run mic through denoiser unless muted, then mix in screen audio if active.
                    let mut mixed = if mic_muted {
                        vec![0.0f32; FRAME_SIZE]
                    } else {
                        noise_suppressor.process_frame(&pcm)
                    };
                    if has_screen_audio {
                        if let Some(screen) = latest_screen_frame.as_deref() {
                            mix_audio_in_place(&mut mixed, screen);
                        }
                    }

                    // Compute audio level (RMS → dBov approximation)
                    let audio_level = compute_audio_level(&mixed);

                    // Opus encode
                    let opus_data = match opus_encoder.encode(&mixed) {
                        Ok(data) => data,
                        Err(e) => {
                            tracing::warn!("opus encode error: {e}");
                            continue;
                        }
                    };

                    // Build header
                    let mut header = MediaHeader::new(TrackType::Audio, local_ssrc);
                    header.sequence = seq;
                    header.timestamp = timestamp;
                    header.audio_level = audio_level;
                    let key_epoch = current_key_epoch.load(Ordering::SeqCst);
                    header.key_epoch = key_epoch;

                    // Serialize header for AAD
                    let mut header_buf = BytesMut::with_capacity(HEADER_SIZE);
                    header.encode(&mut header_buf);
                    let header_bytes: [u8; HEADER_SIZE] = header_buf[..HEADER_SIZE]
                        .try_into()
                        .expect("header is 16 bytes");

                    // Encrypt
                    let encrypted = {
                        let encryptor = match frame_encryptor.lock() {
                            Ok(encryptor) => encryptor,
                            Err(_) => {
                                tracing::warn!("audio send task: frame encryptor lock poisoned");
                                continue;
                            }
                        };
                        match encryptor.encrypt(
                            &header_bytes,
                            local_ssrc,
                            key_epoch,
                            seq,
                            &opus_data,
                        ) {
                            Ok(data) => data,
                            Err(e) => {
                                tracing::warn!("encrypt error: {e:?}");
                                continue;
                            }
                        }
                    };

                    // Build final datagram: header (with correct payload_length) + encrypted payload
                    header.payload_length = encrypted.len() as u16;
                    let mut buf = BytesMut::with_capacity(HEADER_SIZE + encrypted.len());
                    header.encode(&mut buf);
                    buf.put_slice(&encrypted);

                    if let Err(e) = conn_inner.send_datagram(buf.freeze()) {
                        tracing::warn!("datagram send error: {e}");
                        break;
                    }

                    seq = seq.wrapping_add(1);
                    timestamp = timestamp.wrapping_add(FRAME_SIZE as u32);
                }
            }
        }
    });

    session.audio_send_task = Some(handle);
}

/// Spawn the datagram receive task: QUIC datagram → parse header → decrypt → dispatch audio/video.
pub fn spawn_datagram_recv_task(session: &mut NativeMediaSession, app: tauri::AppHandle) {
    let shutdown = session.shutdown.clone();
    let remote_audio = session.remote_audio.clone();
    let deafened = session.deafened.clone();
    let conn_inner = session.connection.inner().clone();
    let frame_decryptor = session.frame_decryptor.clone();

    let handle = tokio::spawn(async move {
        let start_time = Instant::now();

        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                result = conn_inner.read_datagram() => {
                    let data = match result {
                        Ok(data) => data,
                        Err(_) => break,
                    };

                    if data.len() < HEADER_SIZE {
                        continue;
                    }

                    let mut cursor = &data[..];
                    let header = match MediaHeader::decode(&mut cursor) {
                        Ok(h) => h,
                        Err(_) => continue,
                    };

                    let payload = &data[HEADER_SIZE..];

                    // Decrypt
                    let header_bytes: [u8; HEADER_SIZE] = data[..HEADER_SIZE]
                        .try_into()
                        .expect("header is 16 bytes");

                    let decrypted = {
                        let decryptor = match frame_decryptor.lock() {
                            Ok(decryptor) => decryptor,
                            Err(_) => continue,
                        };
                        match decryptor.decrypt(
                            &header_bytes,
                            header.ssrc,
                            header.key_epoch,
                            header.sequence,
                            payload,
                        ) {
                            Ok(data) => data,
                            Err(_) => continue,
                        }
                    };

                    match header.track_type {
                        TrackType::Audio => {
                            if deafened.load(Ordering::SeqCst) {
                                continue;
                            }
                            let arrival_ms = start_time.elapsed().as_millis() as u64;
                            let mut remote = remote_audio.lock().await;
                            if let Some(state) = remote.get_mut(&header.ssrc) {
                                state.jitter_buffer.insert(
                                    header.sequence,
                                    header.timestamp,
                                    decrypted,
                                    arrival_ms,
                                );
                                state.audio_level = header.audio_level;
                            }
                            // New SSRCs are registered when add_playback_source
                            // is called from the playout/session setup code.
                        }
                        TrackType::Video => {
                            super::video_pipeline::handle_video_datagram(
                                &header,
                                &decrypted,
                                &app,
                            );
                        }
                    }
                }
            }
        }
    });

    session.datagram_recv_task = Some(handle);
}

/// Spawn the playout task: 20ms timer → pull from jitter buffers → Opus decode → send to playback mixer.
pub fn spawn_playout_task(session: &mut NativeMediaSession) {
    let shutdown = session.shutdown.clone();
    let deafened = session.deafened.clone();
    let remote_audio = session.remote_audio.clone();

    let handle = tokio::spawn(async move {
        let mut tick = interval(Duration::from_millis(20));

        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                _ = tick.tick() => {
                    if deafened.load(Ordering::SeqCst) {
                        continue;
                    }

                    let mut remote = remote_audio.lock().await;
                    for (_ssrc, state) in remote.iter_mut() {
                        let pcm = match state.jitter_buffer.pull() {
                            Some(opus_bytes) => {
                                match state.decoder.decode(&opus_bytes) {
                                    Ok(samples) => samples,
                                    Err(_) => state.decoder.decode_plc().unwrap_or_default(),
                                }
                            }
                            None => {
                                state.decoder.decode_plc().unwrap_or_default()
                            }
                        };

                        if !pcm.is_empty() {
                            let _ = state.playback_tx.try_send(pcm);
                        }
                    }
                }
            }
        }
    });

    session.playout_task = Some(handle);
}

/// Compute audio level from PCM samples.
/// Returns 0 (loudest) to 127 (silence) in dBov-like scale.
fn compute_audio_level(pcm: &[f32]) -> u8 {
    if pcm.is_empty() {
        return 127;
    }
    let rms: f32 = (pcm.iter().map(|s| s * s).sum::<f32>() / pcm.len() as f32).sqrt();
    if rms < 1e-10 {
        return 127;
    }
    let db = 20.0 * rms.log10();
    (-db).clamp(0.0, 127.0) as u8
}

/// Mix a secondary stream into the primary mono frame in-place.
/// If `overlay` is stereo interleaved, it is downmixed to mono first.
fn mix_audio_in_place(primary: &mut [f32], overlay: &[f32]) {
    if overlay.is_empty() || primary.is_empty() {
        return;
    }

    let overlay_mono: Vec<f32> = if overlay.len() == primary.len() * 2 {
        let mut mono = Vec::with_capacity(primary.len());
        for i in 0..primary.len() {
            let left = overlay[i * 2];
            let right = overlay[i * 2 + 1];
            mono.push((left + right) * 0.5);
        }
        mono
    } else if overlay.len() == primary.len() {
        overlay.to_vec()
    } else {
        // Fallback for mismatched frame lengths: trim or zero-pad overlay.
        let mut mono = vec![0.0f32; primary.len()];
        let n = overlay.len().min(primary.len());
        mono[..n].copy_from_slice(&overlay[..n]);
        mono
    };

    for (dst, src) in primary.iter_mut().zip(overlay_mono.iter()) {
        // Keep headroom and clamp to valid PCM range.
        let mixed = (*dst * 0.75) + (*src * 0.75);
        *dst = mixed.clamp(-1.0, 1.0);
    }
}
