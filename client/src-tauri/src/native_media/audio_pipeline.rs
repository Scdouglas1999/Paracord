use std::sync::atomic::Ordering;
use std::time::Instant;

use bytes::{BufMut, BytesMut};
use tokio::time::{interval, Duration};

use paracord_codec::audio::jitter::JitterBuffer;
use paracord_codec::audio::opus::{OpusDecoder, FRAME_SIZE};
use paracord_transport::protocol::{MediaHeader, TrackType, HEADER_SIZE};

use super::session::{NativeMediaSession, RemoteAudioState};

const VOICE_BITRATE_BPS: i32 = 96_000;
const STREAM_BITRATE_BPS: i32 = 192_000;

pub struct StreamRemoteAudioState {
    pub publisher_user_id: i64,
    pub decoder: OpusDecoder,
    pub jitter_buffer: JitterBuffer<Vec<u8>>,
}

fn stream_audio_publisher_for_ssrc(
    registry: &super::stream_registry::StreamRegistry,
    ssrc: u32,
) -> Option<i64> {
    for track in registry.published_tracks() {
        if track.track_id.0.as_str() != "screen-audio" {
            continue;
        }
        if track
            .layers
            .iter()
            .any(|layer| layer.ssrc == ssrc)
        {
            return Some(track.publisher_user_id);
        }
    }
    None
}

/// Spawn the audio send task: captures mic → noise suppress → Opus encode → encrypt → QUIC datagram.
pub fn spawn_audio_send_task(session: &mut NativeMediaSession) {
    let muted = session.muted.clone();
    let shutdown = session.shutdown.clone();
    let local_ssrc = session.local_ssrc;

    // Take ownership of the PCM receiver — it moves into the task
    let Some(mut pcm_rx) = session.pcm_rx.take() else {
        return;
    };

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

        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                frame = pcm_rx.recv() => {
                    let Some(pcm) = frame else { break };

                    let mic_muted = muted.load(Ordering::SeqCst);
                    if mic_muted {
                        continue;
                    }

                    if let Err(e) = opus_encoder.set_bitrate(VOICE_BITRATE_BPS) {
                        tracing::warn!("opus bitrate update failed: {e}");
                    }

                    let mixed = noise_suppressor.process_frame(&pcm);

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
                        let mut encryptor = match frame_encryptor.lock() {
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

/// Spawn the screen-audio send task on a dedicated SSRC (separate from voice).
pub fn spawn_screen_audio_send_task(session: &mut NativeMediaSession) {
    let screen_audio_enabled = session.screen_audio_enabled.clone();
    let shutdown = session.shutdown.clone();
    let screen_audio_ssrc = session.screen_audio_ssrc;
    let stream_id = format!("stream:{}:screen", session.session_id);
    let track_id = "screen-audio".to_string();
    let Some(mut screen_audio_rx) = session.screen_audio_rx.take() else {
        return;
    };

    let conn_inner = session.connection.inner().clone();
    let frame_encryptor = session.frame_encryptor.clone();
    let track_sender_keys = session.track_sender_keys.clone();

    let handle = tokio::spawn(async move {
        let mut opus_encoder = match paracord_codec::audio::opus::OpusEncoder::new() {
            Ok(e) => e,
            Err(e) => {
                tracing::error!("screen audio send task: opus encoder init failed: {e}");
                return;
            }
        };
        let _ = opus_encoder.set_bitrate(STREAM_BITRATE_BPS);
        let mut seq: u16 = 0;
        let mut timestamp: u32 = 0;

        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                frame = screen_audio_rx.recv() => {
                    let Some(pcm) = frame else { break };
                    if !screen_audio_enabled.load(Ordering::SeqCst) {
                        continue;
                    }

                    let key_epoch = {
                        let sender_keys = track_sender_keys.lock().await;
                        sender_keys
                            .get(&(
                                paracord_transport::stream::StreamId::new(stream_id.clone()),
                                paracord_transport::stream::TrackId::new(track_id.clone()),
                            ))
                            .map(|state| state.epoch)
                            .unwrap_or(1)
                    };

                    let opus_data = match opus_encoder.encode(&pcm) {
                        Ok(data) => data,
                        Err(e) => {
                            tracing::warn!("screen audio opus encode error: {e}");
                            continue;
                        }
                    };

                    let mut header = MediaHeader::new(TrackType::Audio, screen_audio_ssrc);
                    header.sequence = seq;
                    header.timestamp = timestamp;
                    header.audio_level = compute_audio_level(&pcm);
                    header.key_epoch = key_epoch;

                    let mut header_buf = BytesMut::with_capacity(HEADER_SIZE);
                    header.encode(&mut header_buf);
                    let header_bytes: [u8; HEADER_SIZE] = header_buf[..HEADER_SIZE]
                        .try_into()
                        .expect("header is 16 bytes");

                    let encrypted = {
                        let mut encryptor = match frame_encryptor.lock() {
                            Ok(encryptor) => encryptor,
                            Err(_) => continue,
                        };
                        match encryptor.encrypt(
                            &header_bytes,
                            screen_audio_ssrc,
                            key_epoch,
                            seq,
                            &opus_data,
                        ) {
                            Ok(data) => data,
                            Err(e) => {
                                tracing::warn!("screen audio encrypt error: {e:?}");
                                continue;
                            }
                        }
                    };

                    header.payload_length = encrypted.len() as u16;
                    let mut buf = BytesMut::with_capacity(HEADER_SIZE + encrypted.len());
                    header.encode(&mut buf);
                    buf.put_slice(&encrypted);

                    if conn_inner.send_datagram(buf.freeze()).is_err() {
                        break;
                    }

                    seq = seq.wrapping_add(1);
                    timestamp = timestamp.wrapping_add(FRAME_SIZE as u32);
                }
            }
        }
    });

    session.screen_audio_send_task = Some(handle);
}

/// Spawn the datagram receive task: QUIC datagram → parse header → decrypt → dispatch audio/video.
pub fn spawn_datagram_recv_task(session: &mut NativeMediaSession, app: tauri::AppHandle) {
    let shutdown = session.shutdown.clone();
    let remote_audio = session.remote_audio.clone();
    let stream_remote_audio = session.stream_remote_audio.clone();
    let stream_registry = session.stream_registry.clone();
    let audio_actor = session.audio_actor.clone();
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
                        let mut decryptor = match frame_decryptor.lock() {
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
                            let stream_publisher = {
                                let registry = stream_registry.lock().await;
                                stream_audio_publisher_for_ssrc(&registry, header.ssrc)
                            };

                            if let Some(publisher_user_id) = stream_publisher {
                                let mut stream_audio = stream_remote_audio.lock().await;
                                if let Some(state) = stream_audio.get_mut(&header.ssrc) {
                                    state.jitter_buffer.insert(
                                        header.sequence,
                                        header.timestamp,
                                        decrypted,
                                        arrival_ms,
                                    );
                                    continue;
                                }
                                drop(stream_audio);

                                let decoder = match OpusDecoder::new() {
                                    Ok(decoder) => decoder,
                                    Err(e) => {
                                        tracing::warn!(
                                            ssrc = header.ssrc,
                                            "failed to init stream audio decoder: {e}"
                                        );
                                        continue;
                                    }
                                };
                                let mut state = StreamRemoteAudioState {
                                    publisher_user_id,
                                    decoder,
                                    jitter_buffer: JitterBuffer::new(),
                                };
                                state.jitter_buffer.insert(
                                    header.sequence,
                                    header.timestamp,
                                    decrypted,
                                    arrival_ms,
                                );
                                stream_remote_audio
                                    .lock()
                                    .await
                                    .insert(header.ssrc, state);
                                continue;
                            }

                            // Fast path: SSRC already has decode/playout state.
                            {
                                let mut remote = remote_audio.lock().await;
                                if let Some(state) = remote.get_mut(&header.ssrc) {
                                    state.jitter_buffer.insert(
                                        header.sequence,
                                        header.timestamp,
                                        decrypted,
                                        arrival_ms,
                                    );
                                    state.audio_level = header.audio_level;
                                    continue;
                                }
                            }

                            // Slow path: first datagram from a new remote SSRC.
                            // Lazily build its decoder + playout source. The
                            // `remote_audio` guard is intentionally not held
                            // across the `audio_actor` await because `OpusDecoder`
                            // is not `Sync` and would make the task future
                            // non-`Send`.
                            let decoder = match OpusDecoder::new() {
                                Ok(decoder) => decoder,
                                Err(e) => {
                                    tracing::warn!(
                                        ssrc = header.ssrc,
                                        "failed to init opus decoder for remote audio: {e}"
                                    );
                                    continue;
                                }
                            };
                            let playback_tx = match audio_actor
                                .add_playback_source(header.ssrc)
                                .await
                            {
                                Some(tx) => tx,
                                None => {
                                    tracing::warn!(
                                        ssrc = header.ssrc,
                                        "audio playback unavailable; dropping remote audio source"
                                    );
                                    continue;
                                }
                            };
                            let mut state = RemoteAudioState {
                                decoder,
                                jitter_buffer: JitterBuffer::new(),
                                playback_tx,
                                audio_level: header.audio_level,
                            };
                            state.jitter_buffer.insert(
                                header.sequence,
                                header.timestamp,
                                decrypted,
                                arrival_ms,
                            );
                            remote_audio.lock().await.insert(header.ssrc, state);
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
pub fn spawn_playout_task(session: &mut NativeMediaSession, app: tauri::AppHandle) {
    let shutdown = session.shutdown.clone();
    let deafened = session.deafened.clone();
    let remote_audio = session.remote_audio.clone();
    let stream_remote_audio = session.stream_remote_audio.clone();

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
                    drop(remote);

                    let mut stream_audio = stream_remote_audio.lock().await;
                    for (_ssrc, state) in stream_audio.iter_mut() {
                        let pcm = match state.jitter_buffer.pull() {
                            Some(opus_bytes) => {
                                match state.decoder.decode(&opus_bytes) {
                                    Ok(samples) => samples,
                                    Err(_) => state.decoder.decode_plc().unwrap_or_default(),
                                }
                            }
                            None => state.decoder.decode_plc().unwrap_or_default(),
                        };
                        if pcm.is_empty() {
                            continue;
                        }
                        use tauri::Emitter;
                        let _ = app.emit(
                            "media_stream_audio_pcm",
                            serde_json::json!({
                                "userId": state.publisher_user_id.to_string(),
                                "samples": pcm,
                            }),
                        );
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
#[cfg(test)]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_audio_level_reports_silence_as_max() {
        assert_eq!(compute_audio_level(&[]), 127);
        assert_eq!(compute_audio_level(&[0.0; FRAME_SIZE]), 127);
    }

    #[test]
    fn compute_audio_level_full_scale_is_zero() {
        assert_eq!(compute_audio_level(&[1.0; FRAME_SIZE]), 0);
    }

    #[test]
    fn compute_audio_level_is_quieter_for_lower_amplitude() {
        // Level is a dBov-like scale where larger == quieter.
        let loud = compute_audio_level(&[0.5; FRAME_SIZE]);
        let quiet = compute_audio_level(&[0.05; FRAME_SIZE]);
        assert!(quiet > loud, "expected quiet ({quiet}) > loud ({loud})");
    }

    #[test]
    fn mix_audio_in_place_sums_matching_mono_frames() {
        let mut primary = [0.4f32, -0.4, 0.2, 0.0];
        mix_audio_in_place(&mut primary, &[0.4, -0.4, 0.2, 0.0]);
        // Each output is (a * 0.75) + (b * 0.75) with a == b, clamped to [-1, 1].
        assert!((primary[0] - 0.6).abs() < 1e-6);
        assert!((primary[1] - (-0.6)).abs() < 1e-6);
        assert!((primary[2] - 0.3).abs() < 1e-6);
        assert!((primary[3] - 0.0).abs() < 1e-6);
    }

    #[test]
    fn mix_audio_in_place_downmixes_stereo_overlay() {
        let mut primary = [0.0f32, 0.0];
        // Interleaved L/R: (1.0, 0.0) and (0.0, 1.0) -> mono 0.5, 0.5.
        mix_audio_in_place(&mut primary, &[1.0, 0.0, 0.0, 1.0]);
        assert!((primary[0] - 0.375).abs() < 1e-6);
        assert!((primary[1] - 0.375).abs() < 1e-6);
    }

    #[test]
    fn mix_audio_in_place_clamps_to_pcm_range() {
        let mut primary = [1.0f32];
        mix_audio_in_place(&mut primary, &[1.0]);
        assert_eq!(primary[0], 1.0);
    }

    #[test]
    fn mix_audio_in_place_ignores_empty_overlay() {
        let mut primary = [0.3f32, -0.2];
        mix_audio_in_place(&mut primary, &[]);
        assert_eq!(primary, [0.3, -0.2]);
    }

    #[test]
    fn mix_audio_in_place_zero_pads_short_overlay() {
        let mut primary = [0.4f32, 0.4];
        // Overlay shorter than primary and not a stereo multiple: pad with zeros.
        mix_audio_in_place(&mut primary, &[0.4]);
        assert!((primary[0] - 0.6).abs() < 1e-6);
        // Second sample mixes against a zero-padded overlay value.
        assert!((primary[1] - 0.3).abs() < 1e-6);
    }

    /// End-to-end loopback over the exact wire path a datagram travels: Opus
    /// encode → frame encrypt → serialized datagram → parse header → frame
    /// decrypt → Opus decode. Exercises the header-as-AAD contract and the
    /// per-SSRC/epoch key routing that the send/recv tasks rely on.
    #[test]
    fn audio_frame_round_trips_encode_encrypt_datagram_decrypt_decode() {
        use paracord_codec::audio::opus::OpusEncoder;
        use paracord_codec::crypto::{FrameDecryptor, FrameEncryptor, KEY_SIZE};

        const SSRC: u32 = 0x1234_5678;
        const EPOCH: u8 = 7;
        let key = [0x5au8; KEY_SIZE];

        // A non-trivial 20ms mono frame so Opus produces real payload bytes.
        let pcm: Vec<f32> = (0..FRAME_SIZE)
            .map(|n| (n as f32 * 0.05).sin() * 0.5)
            .collect();

        let mut encoder = OpusEncoder::new().expect("opus encoder");
        let opus_data = encoder.encode(&pcm).expect("opus encode");
        assert!(!opus_data.is_empty(), "opus must produce a payload");

        let mut encryptor = FrameEncryptor::new();
        encryptor.set_peer_key(SSRC, EPOCH, &key);

        let seq: u16 = 42;
        let mut header = MediaHeader::new(TrackType::Audio, SSRC);
        header.sequence = seq;
        header.timestamp = 960;
        header.audio_level = compute_audio_level(&pcm);
        header.key_epoch = EPOCH;

        let mut header_buf = BytesMut::with_capacity(HEADER_SIZE);
        header.encode(&mut header_buf);
        let header_bytes: [u8; HEADER_SIZE] = header_buf[..HEADER_SIZE]
            .try_into()
            .expect("16-byte header");

        let encrypted = encryptor
            .encrypt(&header_bytes, SSRC, EPOCH, seq, &opus_data)
            .expect("frame encrypt");

        // The 16-byte header is AES-GCM additional-authenticated data, so the
        // header on the wire must be byte-identical to the one bound at encrypt
        // time. Datagram framing slices at `HEADER_SIZE` and ignores the
        // `payload_length` field, so the header is emitted verbatim here.
        let mut datagram = BytesMut::with_capacity(HEADER_SIZE + encrypted.len());
        datagram.put_slice(&header_bytes);
        datagram.put_slice(&encrypted);
        let datagram = datagram.freeze();

        // Receive side: parse the header back off the wire.
        assert!(datagram.len() >= HEADER_SIZE);
        let mut cursor = &datagram[..];
        let recv_header = MediaHeader::decode(&mut cursor).expect("decode header");
        assert_eq!(recv_header.ssrc, SSRC);
        assert_eq!(recv_header.key_epoch, EPOCH);
        assert_eq!(recv_header.sequence, seq);
        let recv_header_bytes: [u8; HEADER_SIZE] =
            datagram[..HEADER_SIZE].try_into().expect("16-byte header");
        let payload = &datagram[HEADER_SIZE..];

        let mut decryptor = FrameDecryptor::new();
        // A datagram whose epoch has no key must fail rather than silently decode.
        decryptor.set_peer_key(SSRC, EPOCH.wrapping_add(1), &key);
        assert!(
            decryptor
                .decrypt(
                    &recv_header_bytes,
                    recv_header.ssrc,
                    recv_header.key_epoch,
                    recv_header.sequence,
                    payload,
                )
                .is_err(),
            "decrypt must fail without the matching epoch key"
        );

        // Install the correct epoch key and recover the Opus payload.
        decryptor.set_peer_key(SSRC, EPOCH, &key);
        let decrypted = decryptor
            .decrypt(
                &recv_header_bytes,
                recv_header.ssrc,
                recv_header.key_epoch,
                recv_header.sequence,
                payload,
            )
            .expect("frame decrypt");
        assert_eq!(
            decrypted, opus_data,
            "decrypted payload must match encoder output"
        );

        let mut decoder = OpusDecoder::new().expect("opus decoder");
        let out_pcm = decoder.decode(&decrypted).expect("opus decode");
        assert_eq!(
            out_pcm.len(),
            FRAME_SIZE,
            "one 20ms frame must decode back to a full mono frame"
        );
    }
}
