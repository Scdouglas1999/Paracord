use super::session::NativeMediaSession;
use paracord_transport::protocol::MediaHeader;
use paracord_transport::stream::PublishedTrack;
use tauri::AppHandle;

#[cfg(feature = "vpx")]
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
#[cfg(feature = "vpx")]
use base64::Engine;
#[cfg(feature = "vpx")]
use bytes::{BufMut, BytesMut};
#[cfg(feature = "vpx")]
use paracord_codec::crypto::TAG_SIZE;
#[cfg(feature = "vpx")]
use paracord_codec::video::VideoCodec;
#[cfg(feature = "vpx")]
use paracord_transport::protocol::{TrackType, VideoFrameMetadata, HEADER_SIZE};
#[cfg(feature = "vpx")]
use paracord_transport::stream::VideoCodec as TransportVideoCodec;
#[cfg(feature = "vpx")]
use paracord_transport::stream::{StreamId, TrackId};
#[cfg(feature = "vpx")]
use std::collections::HashMap;
#[cfg(feature = "vpx")]
use std::sync::{atomic::Ordering, Mutex, OnceLock};
#[cfg(feature = "vpx")]
use std::time::{Duration, Instant};

#[cfg(feature = "vpx")]
const FALLBACK_MAX_DATAGRAM_SIZE: usize = 1200;
#[cfg(feature = "vpx")]
const VIDEO_REASSEMBLY_TTL: Duration = Duration::from_secs(3);
#[cfg(feature = "vpx")]
const SCREEN_ENCODER_EMPTY_OUTPUT_FALLBACK_THRESHOLD: u32 = 30;
#[cfg(feature = "vpx")]
const SCREEN_ENCODER_STARTUP_FALLBACK_TIMEOUT: Duration = Duration::from_millis(900);

#[cfg(feature = "vpx")]
struct VideoReassemblyState {
    fragment_count: u16,
    is_keyframe: bool,
    chunks: Vec<Option<Vec<u8>>>,
    received: usize,
    last_update: Instant,
}

#[cfg(feature = "vpx")]
struct VideoDispatchState {
    remote_track_latest_frames: HashMap<String, PulledVideoFramePayload>,
    remote_track_sequences: HashMap<String, u64>,
    remote_track_ssrcs: HashMap<String, u32>,
}

#[cfg(feature = "vpx")]
impl Default for VideoDispatchState {
    fn default() -> Self {
        Self {
            remote_track_latest_frames: HashMap::new(),
            remote_track_sequences: HashMap::new(),
            remote_track_ssrcs: HashMap::new(),
        }
    }
}

#[cfg(feature = "vpx")]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulledVideoFramePayload {
    pub sequence: u64,
    pub timestamp_us: u64,
    pub is_keyframe: bool,
    /// Source codec of the stream (`vp9` / `av1` / `h264`).
    pub codec: String,
    /// Wire format of `data`: `i420` when the frame was natively decoded, or
    /// the encoded codec label (`vp9` / `h264` / `av1`) when passed through for
    /// the frontend to decode.
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulledVideoFrameResponse {
    pub sequence: u64,
    pub timestamp_us: u64,
    pub is_keyframe: bool,
    pub codec: String,
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub data_base64: String,
}

#[cfg(feature = "vpx")]
fn video_reassembly_pool() -> &'static Mutex<HashMap<String, VideoReassemblyState>> {
    static POOL: OnceLock<Mutex<HashMap<String, VideoReassemblyState>>> = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(feature = "vpx")]
fn video_dispatch_state() -> &'static Mutex<VideoDispatchState> {
    static STATE: OnceLock<Mutex<VideoDispatchState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(VideoDispatchState::default()))
}

/// Per-remote-track native decoders, keyed by `make_track_key(stream, track)`.
///
/// Kept in a dedicated `Mutex` separate from [`video_dispatch_state`] so decode
/// work (which runs on the datagram receive task) never holds the frame-store
/// lock and never needs the async session lock. The lock is only ever held for
/// synchronous decode calls — never across an `.await`.
#[cfg(feature = "vpx")]
#[allow(clippy::type_complexity)]
fn video_decoder_pool(
) -> &'static Mutex<HashMap<String, Box<dyn paracord_codec::video::decoder::VideoDecoder>>> {
    static POOL: OnceLock<
        Mutex<HashMap<String, Box<dyn paracord_codec::video::decoder::VideoDecoder>>>,
    > = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Remove and drop the native decoder for a remote track. Dropping a
/// `Vp9Decoder` calls `vpx_codec_destroy`, releasing libvpx state. Idempotent:
/// safe to call for a track that never had a decoder.
#[cfg(feature = "vpx")]
pub fn remove_remote_video_decoder(stream_id: &str, track_id: &str) {
    let key = make_track_key(stream_id, track_id);
    if let Ok(mut pool) = video_decoder_pool().lock() {
        pool.remove(&key);
    }
}

#[cfg(not(feature = "vpx"))]
pub fn remove_remote_video_decoder(_stream_id: &str, _track_id: &str) {}

#[cfg(feature = "vpx")]
fn reset_local_screen_dispatch_state() {
    let _ = video_dispatch_state();
}

#[cfg(feature = "vpx")]
pub fn register_stream_video_subscription(
    stream_id: &str,
    track_id: &str,
    ssrc: u32,
) -> Result<(), String> {
    let key = make_track_key(stream_id, track_id);
    let mut state = video_dispatch_state()
        .lock()
        .map_err(|_| "video dispatch state lock poisoned".to_string())?;
    state.remote_track_ssrcs.insert(key.clone(), ssrc);
    Ok(())
}

#[cfg(feature = "vpx")]
pub fn unregister_stream_video_subscription(stream_id: &str, track_id: &str) {
    let key = make_track_key(stream_id, track_id);
    if let Ok(mut state) = video_dispatch_state().lock() {
        state.remote_track_latest_frames.remove(&key);
        state.remote_track_sequences.remove(&key);
        state.remote_track_ssrcs.remove(&key);
    }
    remove_remote_video_decoder(stream_id, track_id);
}

#[cfg(feature = "vpx")]
pub fn pull_latest_remote_stream_video_frame(
    stream_id: &str,
    track_id: &str,
    after_sequence: Option<u64>,
) -> Option<PulledVideoFramePayload> {
    let key = make_track_key(stream_id, track_id);
    let state = video_dispatch_state().lock().ok()?;
    let frame = state.remote_track_latest_frames.get(&key)?.clone();
    if after_sequence.is_some_and(|last| frame.sequence <= last) {
        return None;
    }
    Some(frame)
}

#[cfg(feature = "vpx")]
pub fn encode_pulled_video_frame_response(
    frame: PulledVideoFramePayload,
) -> PulledVideoFrameResponse {
    PulledVideoFrameResponse {
        sequence: frame.sequence,
        timestamp_us: frame.timestamp_us,
        is_keyframe: frame.is_keyframe,
        codec: frame.codec,
        format: frame.format,
        width: frame.width,
        height: frame.height,
        data_base64: BASE64_STANDARD.encode(frame.data),
    }
}

#[cfg(feature = "vpx")]
fn make_track_key(stream_id: &str, track_id: &str) -> String {
    format!("{stream_id}:{track_id}")
}

#[cfg(feature = "vpx")]
pub(super) fn codec_label(codec: VideoCodec) -> &'static str {
    match codec {
        VideoCodec::Vp9 => "vp9",
        VideoCodec::Av1 => "av1",
        VideoCodec::H264 => "h264",
    }
}

#[cfg(feature = "vpx")]
fn transport_codec_to_native(codec: TransportVideoCodec) -> VideoCodec {
    match codec {
        TransportVideoCodec::Vp9 => VideoCodec::Vp9,
        TransportVideoCodec::Av1 => VideoCodec::Av1,
        TransportVideoCodec::H264 => VideoCodec::H264,
    }
}

/// Pick the highest-preference codec that every remote participant can decode.
///
/// This must use `try_lock` rather than `blocking_lock`: it is reachable from
/// async `#[tauri::command]` handlers (e.g. `voice_push_video_frame`) running on
/// tokio worker threads, where `blocking_lock` panics. If the participant table
/// is momentarily contended (a join/leave is being applied on the control task),
/// we cannot verify remote support for this frame, so we keep the caller-supplied
/// `fallback` (the current codec) and re-evaluate on the next frame.
#[cfg(feature = "vpx")]
fn choose_best_publish_codec(session: &NativeMediaSession, fallback: VideoCodec) -> VideoCodec {
    let local_encoders = session
        .stream_capabilities
        .video
        .iter()
        .filter(|capability| capability.encode)
        .map(|capability| transport_codec_to_native(capability.codec))
        .collect::<Vec<_>>();
    if local_encoders.is_empty() {
        return fallback;
    }

    let Ok(participants_guard) = session.session_participants.try_lock() else {
        return fallback;
    };
    let participants = participants_guard.values().cloned().collect::<Vec<_>>();
    drop(participants_guard);

    let preference = [VideoCodec::Av1, VideoCodec::H264, VideoCodec::Vp9];
    for codec in preference {
        if !local_encoders.contains(&codec) {
            continue;
        }
        let transport_codec = codec_to_transport(codec);
        let all_support = participants.iter().all(|participant| {
            participant.video_capabilities.is_empty()
                || participant
                    .video_capabilities
                    .iter()
                    .any(|capability| capability.decode && capability.codec == transport_codec)
        });
        if all_support {
            return codec;
        }
    }

    preference
        .into_iter()
        .find(|codec| local_encoders.contains(codec))
        .unwrap_or(fallback)
}

/// Signals whether a decoded frame was delivered to the pull store or the
/// remote sender should be asked for a keyframe.
#[cfg(feature = "vpx")]
enum VideoDecodeOutcome {
    /// Frame(s) were stored (or intentionally dropped); no action required.
    Delivered,
    /// The decoder could not use this frame and needs a keyframe to recover.
    KeyframeRequired,
}

/// Store the latest frame for a remote track into the pull store, assigning a
/// monotonically increasing per-track sequence.
#[cfg(feature = "vpx")]
#[allow(clippy::too_many_arguments)]
fn store_pulled_video_frame(
    track_key: &str,
    timestamp_us: u64,
    is_keyframe: bool,
    codec: &str,
    format: &str,
    width: u32,
    height: u32,
    data: Vec<u8>,
) {
    let mut state = match video_dispatch_state().lock() {
        Ok(state) => state,
        Err(_) => return,
    };

    let next_sequence = state
        .remote_track_sequences
        .get(track_key)
        .copied()
        .unwrap_or(0)
        .wrapping_add(1);
    state
        .remote_track_sequences
        .insert(track_key.to_string(), next_sequence);
    state.remote_track_latest_frames.insert(
        track_key.to_string(),
        PulledVideoFramePayload {
            sequence: next_sequence,
            timestamp_us,
            is_keyframe,
            codec: codec.to_string(),
            format: format.to_string(),
            width,
            height,
            data,
        },
    );
}

/// Route a reassembled remote video frame through its per-track native decoder.
///
/// VP9 frames are decoded to raw I420 and stored for the pull mechanism. Codecs
/// with no native decoder backend (AV1/H.264 today) are passed through encoded
/// so the frontend can decode them. Returns [`VideoDecodeOutcome::KeyframeRequired`]
/// when the caller should emit a keyframe request for this stream/track.
///
/// The decoder-pool lock is held only for the synchronous decode; decoded planes
/// are copied out before the lock is released and the frame store is touched.
#[cfg(feature = "vpx")]
fn decode_and_store_remote_video_frame(
    track_key: &str,
    timestamp_us: u64,
    encoded: paracord_codec::video::EncodedFrame,
) -> VideoDecodeOutcome {
    use paracord_codec::video::decoder::{create_decoder, VideoDecoder};
    use paracord_codec::video::{DecodedFrame, DecoderConfig, EncodedFrame, VideoError};

    enum Work {
        Passthrough,
        Decoded(Vec<DecodedFrame>),
        NeedKeyframe,
        Drop,
    }

    // Decode one frame and classify the result. `needs_keyframe()` is checked
    // after every decode so a decoder still waiting for an intra frame requests
    // one even if the current call did not error.
    fn run_decode(decoder: &mut dyn VideoDecoder, encoded: &EncodedFrame) -> Work {
        match decoder.decode(encoded) {
            Ok(frames) if !decoder.needs_keyframe() => Work::Decoded(frames),
            Ok(_) => Work::NeedKeyframe,
            Err(VideoError::KeyframeRequired | VideoError::DecodeFailed(_)) => Work::NeedKeyframe,
            Err(_) => Work::Drop,
        }
    }

    let source_codec = codec_label(encoded.codec);

    // The pool lock is held only for the synchronous decode below; no `.await`
    // occurs while it is held, and the frame store is a separate lock touched
    // only after this scope ends.
    let work = {
        let mut pool = match video_decoder_pool().lock() {
            Ok(pool) => pool,
            Err(_) => return VideoDecodeOutcome::Delivered,
        };
        if let Some(decoder) = pool.get_mut(track_key) {
            run_decode(decoder.as_mut(), &encoded)
        } else {
            match create_decoder(encoded.codec, DecoderConfig::default()) {
                Ok(mut decoder) => {
                    let work = run_decode(decoder.as_mut(), &encoded);
                    pool.insert(track_key.to_string(), decoder);
                    work
                }
                // No native decoder for this codec: fall back to encoded passthrough.
                Err(_) => Work::Passthrough,
            }
        }
    };

    match work {
        Work::Passthrough => {
            store_pulled_video_frame(
                track_key,
                timestamp_us,
                encoded.is_keyframe,
                source_codec,
                source_codec,
                encoded.width,
                encoded.height,
                encoded.data,
            );
            VideoDecodeOutcome::Delivered
        }
        Work::Decoded(frames) => {
            for frame in frames {
                store_pulled_video_frame(
                    track_key,
                    timestamp_us,
                    encoded.is_keyframe,
                    source_codec,
                    "i420",
                    frame.width,
                    frame.height,
                    frame.data,
                );
            }
            VideoDecodeOutcome::Delivered
        }
        Work::NeedKeyframe => VideoDecodeOutcome::KeyframeRequired,
        Work::Drop => VideoDecodeOutcome::Delivered,
    }
}

#[cfg(feature = "vpx")]
fn resolve_video_track_key(ssrc: u32) -> Option<String> {
    let state = video_dispatch_state().lock().ok()?;
    state
        .remote_track_ssrcs
        .iter()
        .find_map(|(track_key, mapped_ssrc)| (*mapped_ssrc == ssrc).then(|| track_key.clone()))
}

/// Enable or disable the camera video encoder.
pub async fn set_video_enabled(
    session: &mut NativeMediaSession,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(feature = "vpx")]
    {
        if enabled {
            session.video_encoder = None;
            session.video_simulcast = None;
            session.video_layer_ssrcs = build_track_layer_ssrcs(session.local_user_id, "video");
            session.video_seq = 0;
            session.video_timestamp = 0;
            session.video_pts = 0;
            session.video_force_keyframe = true;
            publish_camera_track(session).await?;
        } else {
            unpublish_camera_track(session).await?;
            session.video_encoder = None;
            session.video_simulcast = None;
            session.video_layer_ssrcs.clear();
            session.video_seq = 0;
            session.video_timestamp = 0;
            session.video_pts = 0;
            session.video_force_keyframe = true;
        }
        Ok(())
    }

    #[cfg(not(feature = "vpx"))]
    {
        let _ = (session, enabled);
        Err("video encoding requires the 'vpx' feature".into())
    }
}

#[cfg(feature = "vpx")]
fn build_camera_simulcast_configs(
    target_width: u32,
    target_height: u32,
    target_fps: u32,
) -> Vec<(
    paracord_codec::video::SimulcastLayer,
    paracord_codec::video::EncoderConfig,
)> {
    build_screen_simulcast_configs(
        target_width,
        target_height,
        target_fps,
        1_500,
        paracord_codec::video::VideoContentHint::Motion,
    )
}

#[cfg(feature = "vpx")]
fn create_camera_simulcast_encoder(
    session: &mut NativeMediaSession,
    input_width: u32,
    input_height: u32,
    codec: VideoCodec,
    layers: &[(
        paracord_codec::video::SimulcastLayer,
        paracord_codec::video::EncoderConfig,
    )],
) -> Result<super::session::NativeSimulcastState, String> {
    use paracord_codec::video::encoder::{create_encoder, SimulcastEncoder};

    SimulcastEncoder::new_with_configs(
        input_width,
        input_height,
        paracord_codec::video::PixelFormat::I420,
        layers,
        |cfg| create_encoder(codec, cfg),
    )
    .map(|encoder| super::session::NativeSimulcastState {
        backend_name: encoder.backend_name(),
        hardware_accelerated: encoder.is_hardware_accelerated(),
        encoder,
        input_width,
        input_height,
        layers: layers.to_vec(),
        codec,
        ssrcs: session.video_layer_ssrcs.clone(),
    })
    .map_err(|err| format!("camera simulcast init: {err}"))
}

/// Start screen share encoder with an explicit capture configuration.
pub fn start_screen_share(
    session: &mut NativeMediaSession,
    width: u32,
    height: u32,
    fps: u32,
    max_bitrate_bps: Option<u32>,
    content_hint: Option<&str>,
    preferred_codec: Option<&str>,
) -> Result<(), String> {
    #[cfg(feature = "vpx")]
    {
        use paracord_codec::video::{EncoderConfig, PixelFormat, VideoContentHint};

        let codec = match preferred_codec {
            Some(label) => super::capabilities::video_codec_from_label(label)
                .map(transport_codec_to_native)
                .ok_or_else(|| format!("unsupported preferred video codec: {label}"))?,
            None => choose_best_publish_codec(session, default_screen_codec()),
        };

        // Portal/window captures report arbitrary sizes (often odd); I420
        // requires even dimensions. The frame path crops to even the same way,
        // so seed the config with the cropped size rather than rejecting.
        let width = width & !1;
        let height = height & !1;
        if width == 0 || height == 0 {
            return Err(format!(
                "screen encoder config: capture too small: {width}x{height}"
            ));
        }

        let config = EncoderConfig {
            width,
            height,
            fps: fps.max(1),
            bitrate_kbps: (max_bitrate_bps.unwrap_or(25_000_000) / 1000).max(1),
            pixel_format: PixelFormat::I420,
            keyframe_interval: fps.max(1),
            content_hint: match content_hint {
                Some("detail") => VideoContentHint::Detail,
                Some("film") => VideoContentHint::Film,
                Some("motion") => VideoContentHint::Motion,
                _ => VideoContentHint::Default,
            },
        };
        config
            .validate()
            .map_err(|e| format!("screen encoder config: {e}"))?;

        session.screen_encoder = None;
        session.screen_simulcast = None;
        session.screen_encoder_config = Some(config);
        session.screen_encoder_codec = Some(codec);
        session.screen_layer_ssrcs = build_track_layer_ssrcs(session.local_user_id, "screen");
        session.screen_seq = 0;
        session.screen_timestamp = 0;
        session.screen_pts = 0;
        session.screen_force_keyframe = true;
        session.screen_empty_output_streak = 0;
        session.screen_runtime_fallback_attempted = false;
        session.screen_encoder_started_at = None;
        reset_local_screen_dispatch_state();
        Ok(())
    }

    #[cfg(not(feature = "vpx"))]
    {
        let _ = (
            session,
            width,
            height,
            fps,
            max_bitrate_bps,
            content_hint,
            preferred_codec,
        );
        Err("screen share encoding requires the 'vpx' feature".into())
    }
}

/// Stop screen share encoder.
pub fn stop_screen_share(session: &mut NativeMediaSession) {
    #[cfg(feature = "vpx")]
    {
        session.screen_encoder = None;
        session.screen_simulcast = None;
        session.screen_encoder_config = None;
        session.screen_encoder_codec = None;
        session.screen_layer_ssrcs.clear();
        session.screen_seq = 0;
        session.screen_timestamp = 0;
        session.screen_pts = 0;
        session.screen_force_keyframe = true;
        session.screen_empty_output_streak = 0;
        session.screen_runtime_fallback_attempted = false;
        session.screen_encoder_started_at = None;
        reset_local_screen_dispatch_state();
    }

    #[cfg(not(feature = "vpx"))]
    let _ = session;
}

#[cfg(feature = "vpx")]
fn default_screen_codec() -> paracord_codec::video::VideoCodec {
    #[cfg(target_os = "windows")]
    {
        paracord_codec::video::VideoCodec::H264
    }

    #[cfg(not(target_os = "windows"))]
    {
        paracord_codec::video::VideoCodec::Vp9
    }
}

/// Ordered list of codecs to try when `current_codec` fails at runtime, most
/// preferred first. Each list excludes `current_codec` itself; VP9 has no
/// further fallback because it is the universal baseline.
#[cfg(feature = "vpx")]
fn runtime_fallback_preference(current_codec: VideoCodec) -> Vec<VideoCodec> {
    match current_codec {
        VideoCodec::Av1 => vec![VideoCodec::H264, VideoCodec::Vp9],
        VideoCodec::H264 => vec![VideoCodec::Vp9],
        VideoCodec::Vp9 => vec![],
    }
}

#[cfg(feature = "vpx")]
fn select_runtime_fallback_codec(
    session: &NativeMediaSession,
    current_codec: VideoCodec,
) -> Option<VideoCodec> {
    let local_encoders = session
        .stream_capabilities
        .video
        .iter()
        .filter(|capability| capability.encode)
        .map(|capability| transport_codec_to_native(capability.codec))
        .collect::<std::collections::HashSet<_>>();

    runtime_fallback_preference(current_codec)
        .into_iter()
        .find(|codec| local_encoders.contains(codec))
}

#[cfg(feature = "vpx")]
fn build_track_layer_ssrcs(user_id: i64, kind: &str) -> Vec<(u8, u32)> {
    use paracord_codec::video::SimulcastLayer;

    [
        (SimulcastLayer::Low, 0u8),
        (SimulcastLayer::Medium, 1u8),
        (SimulcastLayer::High, 2u8),
    ]
    .into_iter()
    .map(|(layer, layer_id)| {
        let ssrc = if layer == SimulcastLayer::High {
            NativeMediaSession::derive_track_ssrc(user_id, kind)
        } else {
            NativeMediaSession::derive_track_layer_ssrc(user_id, kind, layer_id)
        };
        (layer_id, ssrc)
    })
    .collect()
}

#[cfg(feature = "vpx")]
fn build_screen_simulcast_configs(
    target_width: u32,
    target_height: u32,
    target_fps: u32,
    target_bitrate_kbps: u32,
    content_hint: paracord_codec::video::VideoContentHint,
) -> Vec<(
    paracord_codec::video::SimulcastLayer,
    paracord_codec::video::EncoderConfig,
)> {
    use paracord_codec::video::{EncoderConfig, PixelFormat, SimulcastLayer};

    let mut layers = Vec::new();
    let layer_targets = [
        (SimulcastLayer::Low, 320u32, 180u32, 15u32, 300u32),
        (SimulcastLayer::Medium, 640u32, 360u32, 30u32, 1_000u32),
        (
            SimulcastLayer::High,
            target_width,
            target_height,
            target_fps,
            target_bitrate_kbps,
        ),
    ];

    for (layer, max_width, max_height, max_fps, suggested_bitrate) in layer_targets {
        let (mut width, mut height) =
            fit_encode_dimensions(target_width, target_height, max_width, max_height);
        if width == 0 || height == 0 {
            continue;
        }
        if width % 2 != 0 {
            width = width.saturating_sub(1);
        }
        if height % 2 != 0 {
            height = height.saturating_sub(1);
        }
        width = width.max(2);
        height = height.max(2);
        let fps = target_fps.min(max_fps).max(1);
        let bitrate_kbps = match layer {
            SimulcastLayer::High => target_bitrate_kbps.max(1),
            SimulcastLayer::Medium => suggested_bitrate.min(target_bitrate_kbps).max(1),
            SimulcastLayer::Low => suggested_bitrate.min(target_bitrate_kbps).max(1),
        };
        let config = EncoderConfig {
            width,
            height,
            fps,
            bitrate_kbps,
            pixel_format: PixelFormat::I420,
            keyframe_interval: fps,
            content_hint,
        };
        if layers.last().is_some_and(
            |(_, prev): &(
                paracord_codec::video::SimulcastLayer,
                paracord_codec::video::EncoderConfig,
            )| {
                prev.width == config.width
                    && prev.height == config.height
                    && prev.fps == config.fps
                    && prev.bitrate_kbps == config.bitrate_kbps
            },
        ) {
            continue;
        }
        layers.push((layer, config));
    }

    if layers.is_empty() {
        layers.push((
            SimulcastLayer::High,
            EncoderConfig {
                width: target_width.max(2),
                height: target_height.max(2),
                fps: target_fps.max(1),
                bitrate_kbps: target_bitrate_kbps.max(1),
                pixel_format: PixelFormat::I420,
                keyframe_interval: target_fps.max(1),
                content_hint,
            },
        ));
    }

    layers
}

#[cfg(feature = "vpx")]
fn create_screen_simulcast_encoder(
    session: &mut NativeMediaSession,
    input_width: u32,
    input_height: u32,
    layers: &[(
        paracord_codec::video::SimulcastLayer,
        paracord_codec::video::EncoderConfig,
    )],
) -> Result<super::session::NativeSimulcastState, String> {
    use paracord_codec::video::encoder::{create_encoder, SimulcastEncoder};
    use paracord_codec::video::VideoCodec;

    fn build_with_codec(
        codec: VideoCodec,
        input_width: u32,
        input_height: u32,
        layers: &[(
            paracord_codec::video::SimulcastLayer,
            paracord_codec::video::EncoderConfig,
        )],
    ) -> Result<SimulcastEncoder, paracord_codec::video::VideoError> {
        SimulcastEncoder::new_with_configs(
            input_width,
            input_height,
            paracord_codec::video::PixelFormat::I420,
            layers,
            |cfg| create_encoder(codec, cfg),
        )
    }

    let preferred = session
        .screen_encoder_codec
        .unwrap_or_else(default_screen_codec);
    let (codec, encoder) = match build_with_codec(preferred, input_width, input_height, layers) {
        Ok(encoder) => (preferred, encoder),
        Err(primary_err) if preferred != VideoCodec::Vp9 => {
            let fallback = VideoCodec::Vp9;
            let encoder = build_with_codec(fallback, input_width, input_height, layers)
                .map_err(|fallback_err| {
                    format!(
                        "screen simulcast init failed for {preferred:?}: {primary_err}; fallback vp9 failed: {fallback_err}"
                    )
                })?;
            tracing::warn!(
                ?preferred,
                "falling back to VP9 screen simulcast encoder backend after preferred codec init failed"
            );
            (fallback, encoder)
        }
        Err(err) => return Err(format!("screen simulcast init: {err}")),
    };
    session.screen_encoder_codec = Some(codec);
    Ok(super::session::NativeSimulcastState {
        backend_name: encoder.backend_name(),
        hardware_accelerated: encoder.is_hardware_accelerated(),
        encoder,
        input_width,
        input_height,
        layers: layers.to_vec(),
        codec,
        ssrcs: session.screen_layer_ssrcs.clone(),
    })
}

#[cfg(feature = "vpx")]
fn maybe_fallback_screen_encoder_after_empty_output(
    session: &mut NativeMediaSession,
    encode_input: &[u8],
    pts: i64,
) -> Result<Vec<paracord_codec::video::EncodedFrame>, String> {
    let Some(current_codec) = session
        .screen_simulcast
        .as_ref()
        .map(|encoder| encoder.codec)
        .or_else(|| {
            session
                .screen_encoder
                .as_ref()
                .map(|encoder| encoder.codec())
        })
    else {
        return Ok(Vec::new());
    };

    let Some(fallback_codec) = select_runtime_fallback_codec(session, current_codec) else {
        return Ok(Vec::new());
    };

    session.screen_empty_output_streak = session.screen_empty_output_streak.saturating_add(1);
    let startup_timed_out = session
        .screen_encoder_started_at
        .is_some_and(|started_at| started_at.elapsed() >= SCREEN_ENCODER_STARTUP_FALLBACK_TIMEOUT);
    if session.screen_runtime_fallback_attempted
        || (!startup_timed_out
            && session.screen_empty_output_streak < SCREEN_ENCODER_EMPTY_OUTPUT_FALLBACK_THRESHOLD)
    {
        return Ok(Vec::new());
    }

    let config = session
        .screen_encoder_config
        .clone()
        .ok_or("screen encoder config missing during runtime fallback".to_string())?;
    tracing::warn!(
        ?current_codec,
        ?fallback_codec,
        streak = session.screen_empty_output_streak,
        "screen encoder produced no output for too many input frames; falling back to alternate codec"
    );

    let (input_width, input_height) = session
        .screen_simulcast
        .as_ref()
        .map(|state| (state.input_width, state.input_height))
        .unwrap_or((config.width, config.height));
    let simulcast_layers = build_screen_simulcast_configs(
        config.width,
        config.height,
        config.fps,
        config.bitrate_kbps,
        config.content_hint,
    );
    session.screen_encoder_codec = Some(fallback_codec);
    let mut fallback =
        create_screen_simulcast_encoder(session, input_width, input_height, &simulcast_layers)?;
    let encoded_frames = fallback
        .encoder
        .encode(pts, encode_input, true)
        .map_err(|err| format!("runtime screen encoder fallback encode: {err}"))?;
    session.screen_simulcast = Some(fallback);
    session.screen_encoder = None;
    session.screen_encoder_codec = Some(fallback_codec);
    session.screen_force_keyframe = false;
    session.screen_empty_output_streak = 0;
    session.screen_runtime_fallback_attempted = true;
    session.screen_encoder_started_at = Some(Instant::now());

    Ok(encoded_frames)
}

/// Encode an RGBA frame and send it over QUIC.
pub fn encode_and_send_video_frame(
    session: &mut NativeMediaSession,
    width: u32,
    height: u32,
    rgba_data: &[u8],
    is_screen: bool,
    input_is_bgra: bool,
    _loopback_app: Option<&AppHandle>,
) -> Result<(), String> {
    #[cfg(feature = "vpx")]
    {
        use paracord_codec::video::{
            bgra_to_i420, downscale_i420, rgba_to_i420, EncoderConfig, PixelFormat,
        };

        let mut frame_width = width;
        let mut frame_height = height;
        let rgba_storage = if frame_width % 2 != 0 || frame_height % 2 != 0 {
            let normalized_width = frame_width - (frame_width % 2);
            let normalized_height = frame_height - (frame_height % 2);
            if normalized_width == 0 || normalized_height == 0 {
                return Err(format!(
                    "video frame has unsupported dimensions: {frame_width}x{frame_height}"
                ));
            }

            let row_bytes = (normalized_width * 4) as usize;
            let src_stride = (frame_width * 4) as usize;
            let mut cropped =
                Vec::with_capacity((normalized_width * normalized_height * 4) as usize);
            for row in 0..normalized_height as usize {
                let start = row * src_stride;
                let end = start + row_bytes;
                cropped.extend_from_slice(&rgba_data[start..end]);
            }

            frame_width = normalized_width;
            frame_height = normalized_height;
            Some(cropped)
        } else {
            None
        };
        let rgba_data = rgba_storage.as_deref().unwrap_or(rgba_data);

        let mut encode_width = frame_width;
        let mut encode_height = frame_height;
        if is_screen {
            let screen_config = session
                .screen_encoder_config
                .clone()
                .ok_or("screen encoder not active")?;
            let requested_codec = choose_best_publish_codec(
                session,
                session
                    .screen_encoder_codec
                    .unwrap_or_else(default_screen_codec),
            );
            session.screen_encoder_codec = Some(requested_codec);
            (encode_width, encode_height) = fit_encode_dimensions(
                frame_width,
                frame_height,
                screen_config.width,
                screen_config.height,
            );
            (encode_width, encode_height) =
                align_dimensions_for_codec(requested_codec, encode_width, encode_height);
            let desired_config =
                if screen_config.width != encode_width || screen_config.height != encode_height {
                    let updated_config = EncoderConfig {
                        width: encode_width,
                        height: encode_height,
                        ..screen_config
                    };
                    updated_config
                        .validate()
                        .map_err(|e| format!("screen encoder config: {e}"))?;
                    updated_config
                } else {
                    screen_config
                };
            let desired_layers = build_screen_simulcast_configs(
                desired_config.width,
                desired_config.height,
                desired_config.fps,
                desired_config.bitrate_kbps,
                desired_config.content_hint,
            );
            let needs_reinit = session
                .screen_simulcast
                .as_ref()
                .map(|encoder| {
                    encoder.input_width != frame_width
                        || encoder.input_height != frame_height
                        || encoder.codec
                            != session
                                .screen_encoder_codec
                                .unwrap_or_else(default_screen_codec)
                        || encoder.layers != desired_layers
                })
                .unwrap_or(true);

            if needs_reinit {
                let encoder = create_screen_simulcast_encoder(
                    session,
                    frame_width,
                    frame_height,
                    &desired_layers,
                )?;
                tracing::info!(
                    codec = ?encoder.codec,
                    backend = encoder.backend_name,
                    hardware = encoder.hardware_accelerated,
                    input_width = encoder.input_width,
                    input_height = encoder.input_height,
                    "configured native screen simulcast encoder"
                );
                session.screen_simulcast = Some(encoder);
                session.screen_encoder = None;
                session.screen_encoder_config = Some(desired_config);
                session.screen_seq = 0;
                session.screen_timestamp = 0;
                session.screen_force_keyframe = true;
                session.screen_encoder_started_at = Some(Instant::now());
            }

            sync_published_video_track_metadata(session, true);
        } else {
            let desired_layers = build_camera_simulcast_configs(frame_width, frame_height, 30);
            let desired_codec = choose_best_publish_codec(
                session,
                session
                    .video_simulcast
                    .as_ref()
                    .map(|encoder| encoder.codec)
                    .unwrap_or(VideoCodec::Vp9),
            );
            let needs_reinit = session
                .video_simulcast
                .as_ref()
                .map(|encoder| {
                    encoder.input_width != frame_width
                        || encoder.input_height != frame_height
                        || encoder.layers != desired_layers
                        || encoder.codec != desired_codec
                })
                .unwrap_or(true);
            if needs_reinit {
                let encoder = create_camera_simulcast_encoder(
                    session,
                    frame_width,
                    frame_height,
                    desired_codec,
                    &desired_layers,
                )?;
                tracing::info!(
                    codec = ?encoder.codec,
                    backend = encoder.backend_name,
                    hardware = encoder.hardware_accelerated,
                    input_width = encoder.input_width,
                    input_height = encoder.input_height,
                    "configured native camera simulcast encoder"
                );
                session.video_simulcast = Some(encoder);
                session.video_encoder = None;
                session.video_seq = 0;
                session.video_timestamp = 0;
                session.video_force_keyframe = true;
            }
        }

        let expected_rgba_size = PixelFormat::Rgba.frame_size(frame_width, frame_height);
        if rgba_data.len() != expected_rgba_size {
            return Err(format!(
                "video frame size mismatch: expected {expected_rgba_size} bytes, got {}",
                rgba_data.len()
            ));
        }

        let i420_size = PixelFormat::I420.frame_size(frame_width, frame_height);
        let i420_buf = &mut session.i420_convert_buf;
        i420_buf.resize(i420_size, 0u8);
        if input_is_bgra {
            bgra_to_i420(rgba_data, frame_width, frame_height, i420_buf);
        } else {
            rgba_to_i420(rgba_data, frame_width, frame_height, i420_buf);
        }

        let scaled_i420;
        let encode_input =
            if !is_screen && (encode_width != frame_width || encode_height != frame_height) {
                scaled_i420 = downscale_i420(
                    i420_buf,
                    frame_width,
                    frame_height,
                    encode_width,
                    encode_height,
                );
                scaled_i420.as_slice()
            } else {
                i420_buf.as_slice()
            };

        let (mut encoded_frames, fps) = if is_screen {
            let pts = session.screen_pts;
            session.screen_pts = session.screen_pts.wrapping_add(1);
            let force_keyframe = session.screen_force_keyframe;
            session.screen_force_keyframe = false;

            let (encoded_frames, fps) = {
                let encoder = session
                    .screen_simulcast
                    .as_mut()
                    .ok_or("screen encoder not active")?;
                let fps = encoder
                    .layers
                    .last()
                    .map(|(_, config)| config.fps.max(1))
                    .unwrap_or(30);
                let encoded_frames = encoder
                    .encoder
                    .encode(pts, encode_input, force_keyframe)
                    .map_err(|e| format!("video encode: {e}"))?;
                (encoded_frames, fps)
            };

            let encoded_frames = if encoded_frames.is_empty() {
                let fallback_input = encode_input.to_vec();
                maybe_fallback_screen_encoder_after_empty_output(
                    session,
                    fallback_input.as_slice(),
                    pts,
                )?
            } else {
                session.screen_empty_output_streak = 0;
                encoded_frames
            };

            (encoded_frames, fps)
        } else {
            let pts = session.video_pts;
            session.video_pts = session.video_pts.wrapping_add(1);
            let force_keyframe = session.video_force_keyframe;
            session.video_force_keyframe = false;
            let (encoded_frames, fps) = {
                let encoder = session
                    .video_simulcast
                    .as_mut()
                    .ok_or("video encoder not active")?;
                let fps = encoder
                    .layers
                    .last()
                    .map(|(_, config)| config.fps.max(1))
                    .unwrap_or(30);
                let encoded_frames = encoder
                    .encoder
                    .encode(pts, encode_input, force_keyframe)
                    .map_err(|e| format!("video encode: {e}"))?;
                (encoded_frames, fps)
            };
            (encoded_frames, fps)
        };

        if !is_screen {
            sync_published_video_track_metadata(session, false);
        }

        let timestamp_step = (90_000u32 / fps).max(1);
        let max_datagram_size = session
            .connection
            .max_datagram_size()
            .unwrap_or(FALLBACK_MAX_DATAGRAM_SIZE);
        let max_fragment_payload = max_datagram_size
            .saturating_sub(HEADER_SIZE + TAG_SIZE + 128)
            .max(256);
        let local_stream_id = local_video_stream_id(session, is_screen);
        let local_track_id = local_video_track_id(is_screen);

        let can_send_screen_frames = !is_screen || session.published_screen_track.is_some();
        let frame_timestamp = if is_screen {
            session.screen_timestamp
        } else {
            session.video_timestamp
        };
        for frame in encoded_frames.drain(..) {
            let frame_timestamp_us = (frame.pts.max(0) as u64 * 1_000_000) / fps as u64;
            let frame_data = frame.data.clone();
            let frame_pts = frame.pts;
            let frame_is_keyframe = frame.is_keyframe;
            if !can_send_screen_frames {
                continue;
            }
            let layer_id = frame.layer.map(|layer| layer as u8).unwrap_or(0);
            let ssrc = if is_screen {
                session
                    .screen_layer_ssrcs
                    .iter()
                    .find_map(|(mapped_layer_id, ssrc)| {
                        (*mapped_layer_id == layer_id).then_some(*ssrc)
                    })
                    .unwrap_or(session.screen_ssrc)
            } else {
                session
                    .video_layer_ssrcs
                    .iter()
                    .find_map(|(mapped_layer_id, ssrc)| {
                        (*mapped_layer_id == layer_id).then_some(*ssrc)
                    })
                    .unwrap_or(session.video_ssrc)
            };
            send_encoded_video_frame(
                &session.connection,
                &session.frame_encryptor,
                session.current_key_epoch.load(Ordering::SeqCst),
                ssrc,
                if is_screen {
                    &mut session.screen_seq
                } else {
                    &mut session.video_seq
                },
                frame_timestamp,
                max_fragment_payload,
                layer_id,
                frame.codec,
                frame_is_keyframe,
                &local_stream_id,
                &local_track_id,
                frame_pts.max(0) as u64,
                frame_timestamp_us,
                &frame_data,
            )?;
        }
        if is_screen {
            session.screen_timestamp = session.screen_timestamp.wrapping_add(timestamp_step);
        } else {
            session.video_timestamp = session.video_timestamp.wrapping_add(timestamp_step);
        }

        Ok(())
    }

    #[cfg(not(feature = "vpx"))]
    {
        let _ = (session, width, height, rgba_data, is_screen, input_is_bgra);
        Err("video encoding requires the 'vpx' feature".into())
    }
}

#[cfg(feature = "vpx")]
fn fit_encode_dimensions(
    src_width: u32,
    src_height: u32,
    max_width: u32,
    max_height: u32,
) -> (u32, u32) {
    if src_width == 0 || src_height == 0 || max_width == 0 || max_height == 0 {
        return (src_width, src_height);
    }

    if src_width <= max_width && src_height <= max_height {
        return (src_width, src_height);
    }

    let width_limited =
        (max_width as u64 * src_height as u64) <= (max_height as u64 * src_width as u64);
    let (mut fitted_width, mut fitted_height) = if width_limited {
        let fitted_height = ((src_height as u64 * max_width as u64) / src_width as u64) as u32;
        (max_width, fitted_height)
    } else {
        let fitted_width = ((src_width as u64 * max_height as u64) / src_height as u64) as u32;
        (fitted_width, max_height)
    };

    fitted_width = fitted_width.clamp(2, max_width);
    fitted_height = fitted_height.clamp(2, max_height);

    if fitted_width % 2 != 0 {
        fitted_width = fitted_width.saturating_sub(1);
    }
    if fitted_height % 2 != 0 {
        fitted_height = fitted_height.saturating_sub(1);
    }

    (fitted_width.max(2), fitted_height.max(2))
}

#[cfg(feature = "vpx")]
fn align_dimensions_for_codec(codec: VideoCodec, width: u32, height: u32) -> (u32, u32) {
    let alignment = match codec {
        VideoCodec::H264 => 16,
        VideoCodec::Av1 | VideoCodec::Vp9 => 2,
    };

    let mut aligned_width = width.max(alignment);
    let mut aligned_height = height.max(alignment);

    let width_remainder = aligned_width % alignment;
    if width_remainder != 0 {
        aligned_width = aligned_width.saturating_sub(width_remainder);
    }

    let height_remainder = aligned_height % alignment;
    if height_remainder != 0 {
        aligned_height = aligned_height.saturating_sub(height_remainder);
    }

    (aligned_width.max(alignment), aligned_height.max(alignment))
}

/// Handle an incoming video datagram: reassemble fragments, natively decode
/// (VP9) into I420 or pass encoded frames through, store the result for the
/// pull mechanism, and request a keyframe from the sender when the decoder
/// cannot make progress.
pub fn handle_video_datagram(
    header: &MediaHeader,
    decrypted_payload: &[u8],
    app: &tauri::AppHandle,
) {
    #[cfg(feature = "vpx")]
    {
        use paracord_codec::video::EncodedFrame;

        let Some((metadata, encoded_bytes)) = reassemble_video_payload(header, decrypted_payload)
        else {
            return;
        };

        let timestamp_us = metadata.timestamp_us;
        let codec = transport_codec_to_codec(metadata.codec);
        let encoded = EncodedFrame {
            data: encoded_bytes,
            codec,
            pts: metadata.frame_id as i64,
            is_keyframe: metadata.is_keyframe,
            layer: None,
            width: 0,
            height: 0,
        };
        // The reassembled metadata always carries the stream/track identity, so
        // it is authoritative for keying. The SSRC map is only a fallback for
        // datagrams whose metadata could not be recovered.
        let track_key = Some(make_track_key(&metadata.stream_id.0, &metadata.track_id.0))
            .or_else(|| resolve_video_track_key(header.ssrc));
        if let Some(track_key) = track_key {
            match decode_and_store_remote_video_frame(&track_key, timestamp_us, encoded) {
                VideoDecodeOutcome::Delivered => {}
                VideoDecodeOutcome::KeyframeRequired => {
                    super::events::emit_media_request_keyframe(
                        app,
                        &metadata.stream_id.0,
                        &metadata.track_id.0,
                        Some(header.simulcast_layer),
                    );
                }
            }
        }
    }

    #[cfg(not(feature = "vpx"))]
    {
        let _ = (header, decrypted_payload, app);
    }
}

#[cfg(feature = "vpx")]
fn send_encoded_video_frame(
    connection: &paracord_transport::connection::MediaConnection,
    frame_encryptor: &std::sync::Arc<std::sync::Mutex<paracord_codec::crypto::FrameEncryptor>>,
    key_epoch: u8,
    ssrc: u32,
    seq: &mut u16,
    frame_timestamp: u32,
    max_fragment_payload: usize,
    simulcast_layer: u8,
    codec: VideoCodec,
    is_keyframe: bool,
    stream_id: &StreamId,
    track_id: &TrackId,
    frame_id: u64,
    frame_timestamp_us: u64,
    frame_data: &[u8],
) -> Result<(), String> {
    if frame_data.is_empty() {
        return Ok(());
    }

    let fragment_count = frame_data.len().div_ceil(max_fragment_payload);
    let fragment_count_u16 =
        u16::try_from(fragment_count).map_err(|_| "video frame requires too many fragments")?;

    for (fragment_index, fragment) in frame_data.chunks(max_fragment_payload).enumerate() {
        let fragment_index_u16 =
            u16::try_from(fragment_index).map_err(|_| "video fragment index overflow")?;

        let metadata = VideoFrameMetadata {
            stream_id: stream_id.clone(),
            track_id: track_id.clone(),
            frame_id,
            layer_id: simulcast_layer,
            codec: codec_to_transport(codec),
            timestamp_us: frame_timestamp_us,
            is_keyframe,
            fragment_index: fragment_index_u16,
            fragment_count: fragment_count_u16,
        };
        let mut plaintext = Vec::with_capacity(128 + fragment.len());
        let mut metadata_buf = BytesMut::new();
        metadata
            .encode(&mut metadata_buf)
            .map_err(|e| format!("video metadata encode: {e}"))?;
        plaintext.extend_from_slice(&metadata_buf);
        plaintext.extend_from_slice(fragment);

        let mut header = MediaHeader::new(TrackType::Video, ssrc);
        header.sequence = *seq;
        header.timestamp = frame_timestamp;
        header.key_epoch = key_epoch;
        header.simulcast_layer = simulcast_layer;
        header.codec = codec.header_id();

        let mut header_buf = BytesMut::with_capacity(HEADER_SIZE);
        header.encode(&mut header_buf);
        let header_bytes: [u8; HEADER_SIZE] = header_buf[..HEADER_SIZE]
            .try_into()
            .expect("header is 16 bytes");

        let encrypted = {
            let mut encryptor = frame_encryptor
                .lock()
                .map_err(|_| "video frame encryptor lock poisoned".to_string())?;
            encryptor
                .encrypt(&header_bytes, ssrc, key_epoch, *seq, &plaintext)
                .map_err(|e| format!("video encrypt: {e:?}"))?
        };

        header.payload_length = encrypted.len() as u16;

        let mut buf = BytesMut::with_capacity(HEADER_SIZE + encrypted.len());
        header.encode(&mut buf);
        buf.put_slice(&encrypted);

        connection
            .send_datagram(buf.freeze())
            .map_err(|e| format!("video datagram send: {e}"))?;

        *seq = seq.wrapping_add(1);
    }

    Ok(())
}

#[cfg(feature = "vpx")]
fn reassemble_video_payload(
    header: &MediaHeader,
    decrypted_payload: &[u8],
) -> Option<(VideoFrameMetadata, Vec<u8>)> {
    let (metadata, chunk) = decode_video_fragment_payload(header, decrypted_payload)?;

    if metadata.fragment_count == 1 {
        return Some((metadata, chunk));
    }

    let key = format!(
        "{}:{}:{}",
        metadata.stream_id.0, metadata.track_id.0, metadata.frame_id
    );
    let now = Instant::now();
    let mut pool = video_reassembly_pool().lock().ok()?;
    pool.retain(|_, state| now.duration_since(state.last_update) <= VIDEO_REASSEMBLY_TTL);

    let state = pool
        .entry(key.clone())
        .or_insert_with(|| VideoReassemblyState {
            fragment_count: metadata.fragment_count,
            is_keyframe: metadata.is_keyframe,
            chunks: vec![None; metadata.fragment_count as usize],
            received: 0,
            last_update: now,
        });

    if state.fragment_count != metadata.fragment_count {
        *state = VideoReassemblyState {
            fragment_count: metadata.fragment_count,
            is_keyframe: metadata.is_keyframe,
            chunks: vec![None; metadata.fragment_count as usize],
            received: 0,
            last_update: now,
        };
    } else {
        state.is_keyframe = metadata.is_keyframe;
        state.last_update = now;
    }

    let slot = &mut state.chunks[metadata.fragment_index as usize];
    if slot.is_none() {
        *slot = Some(chunk);
        state.received += 1;
    }

    if state.received != state.fragment_count as usize {
        return None;
    }

    let state = pool.remove(&key)?;
    let total_len: usize = state
        .chunks
        .iter()
        .filter_map(|chunk| chunk.as_ref())
        .map(Vec::len)
        .sum();
    let mut frame = Vec::with_capacity(total_len);
    for chunk in state.chunks {
        frame.extend_from_slice(chunk.as_deref()?);
    }
    Some((metadata, frame))
}

#[cfg(feature = "vpx")]
fn decode_video_fragment_payload(
    header: &MediaHeader,
    decrypted_payload: &[u8],
) -> Option<(VideoFrameMetadata, Vec<u8>)> {
    let mut cursor = decrypted_payload;
    if let Ok(metadata) = VideoFrameMetadata::decode(&mut cursor) {
        if metadata.fragment_count == 0 || metadata.fragment_index >= metadata.fragment_count {
            return None;
        }
        return Some((metadata, cursor.to_vec()));
    }
    let _ = header;
    None
}

#[cfg(feature = "vpx")]
fn local_video_stream_id(session: &NativeMediaSession, is_screen: bool) -> StreamId {
    if is_screen {
        if let Some(track) = session.published_screen_track.as_ref() {
            return track.stream_id.clone();
        }
        return StreamId::new(format!("stream:{}:screen", session.session_id));
    }
    if let Some(track) = session.published_video_track.as_ref() {
        return track.stream_id.clone();
    }
    StreamId::new(format!("stream:{}:camera", session.session_id))
}

#[cfg(feature = "vpx")]
fn local_video_track_id(is_screen: bool) -> TrackId {
    if is_screen {
        TrackId::new("screen")
    } else {
        TrackId::new("camera")
    }
}

#[cfg(feature = "vpx")]
fn sync_published_video_track_metadata(session: &mut NativeMediaSession, is_screen: bool) {
    let updated_track = if is_screen {
        match super::screen_capture::build_screen_track(session) {
            Ok(track) => track,
            Err(_) => return,
        }
    } else {
        match build_camera_track(session) {
            Ok(track) => track,
            Err(_) => return,
        }
    };

    let current_track = if is_screen {
        session.published_screen_track.as_ref()
    } else {
        session.published_video_track.as_ref()
    };
    let Some(current_track) = current_track else {
        return;
    };
    if current_track == &updated_track {
        return;
    }
    let layers_only_update = current_track.stream_id == updated_track.stream_id
        && current_track.track_id == updated_track.track_id
        && current_track.publisher_user_id == updated_track.publisher_user_id
        && current_track.kind == updated_track.kind
        && current_track.codec == updated_track.codec;

    if is_screen {
        session.published_screen_track = Some(updated_track.clone());
    } else {
        session.published_video_track = Some(updated_track.clone());
    }

    let registry = session.stream_registry.clone();
    let conn = session.connection.inner().clone();
    tokio::spawn(async move {
        {
            let mut registry = registry.lock().await;
            registry.publish_track(updated_track.clone());
        }
        let message = if layers_only_update {
            paracord_transport::control::ControlMessage::TrackLayers {
                stream_id: updated_track.stream_id.clone(),
                track_id: updated_track.track_id.clone(),
                layers: updated_track.layers.clone(),
            }
        } else {
            paracord_transport::control::ControlMessage::TrackPublish {
                track: updated_track,
            }
        };
        let _ = send_control_message(&conn, &message).await;
    });
}

#[cfg(feature = "vpx")]
async fn send_control_message(
    conn: &quinn::Connection,
    message: &paracord_transport::control::ControlMessage,
) -> Result<(), String> {
    let (mut send, _recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
    let encoded = message.encode().map_err(|e| e.to_string())?;
    send.write_all(&encoded).await.map_err(|e| e.to_string())?;
    send.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(feature = "vpx")]
fn codec_to_transport(codec: VideoCodec) -> TransportVideoCodec {
    match codec {
        VideoCodec::Vp9 => TransportVideoCodec::Vp9,
        VideoCodec::Av1 => TransportVideoCodec::Av1,
        VideoCodec::H264 => TransportVideoCodec::H264,
    }
}

#[cfg(feature = "vpx")]
fn transport_codec_to_codec(codec: TransportVideoCodec) -> VideoCodec {
    match codec {
        TransportVideoCodec::Vp9 => VideoCodec::Vp9,
        TransportVideoCodec::Av1 => VideoCodec::Av1,
        TransportVideoCodec::H264 => VideoCodec::H264,
    }
}

#[cfg(feature = "vpx")]
async fn publish_camera_track(session: &mut NativeMediaSession) -> Result<(), String> {
    let track = build_camera_track(session)?;
    ensure_track_sender_key(session, &track).await?;
    {
        let mut registry = session.stream_registry.lock().await;
        registry.publish_track(track.clone());
    }
    session.published_video_track = Some(track.clone());
    session
        .send_control_message(&paracord_transport::control::ControlMessage::TrackPublish { track })
        .await?;
    Ok(())
}

#[cfg(feature = "vpx")]
async fn unpublish_camera_track(session: &mut NativeMediaSession) -> Result<(), String> {
    let Some(track) = session.published_video_track.take() else {
        return Ok(());
    };
    clear_track_sender_key(session, &track).await;
    {
        let mut registry = session.stream_registry.lock().await;
        registry.unpublish_track(&track.stream_id, &track.track_id);
    }
    session
        .send_control_message(
            &paracord_transport::control::ControlMessage::TrackUnpublish {
                stream_id: track.stream_id,
                track_id: track.track_id,
            },
        )
        .await?;
    Ok(())
}

#[cfg(feature = "vpx")]
fn build_camera_track(
    session: &NativeMediaSession,
) -> Result<paracord_transport::stream::PublishedTrack, String> {
    let (codec, layers) = if let Some(simulcast) = session.video_simulcast.as_ref() {
        let active_layer_id = simulcast
            .layers
            .last()
            .map(|(layer, _)| *layer as u8)
            .unwrap_or(0);
        let layers = simulcast
            .layers
            .iter()
            .map(|(layer, layer_config)| {
                let layer_id = *layer as u8;
                let width = u16::try_from(layer_config.width)
                    .map_err(|_| format!("camera track width too large: {}", layer_config.width))?;
                let height = u16::try_from(layer_config.height).map_err(|_| {
                    format!("camera track height too large: {}", layer_config.height)
                })?;
                let ssrc = simulcast
                    .ssrcs
                    .iter()
                    .find_map(|(mapped_layer_id, ssrc)| {
                        (*mapped_layer_id == layer_id).then_some(*ssrc)
                    })
                    .unwrap_or(session.video_ssrc);
                Ok(paracord_transport::stream::PublishedLayer {
                    layer_id,
                    ssrc,
                    width: Some(width),
                    height: Some(height),
                    max_bitrate_kbps: Some(layer_config.bitrate_kbps),
                    active: layer_id == active_layer_id,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        (codec_to_transport(simulcast.codec), layers)
    } else {
        let encoder = session
            .video_encoder
            .as_ref()
            .ok_or("video encoder not active while publishing camera track")?;
        let config = encoder.config();
        let width = u16::try_from(config.width)
            .map_err(|_| format!("camera track width too large: {}", config.width))?;
        let height = u16::try_from(config.height)
            .map_err(|_| format!("camera track height too large: {}", config.height))?;
        (
            codec_to_transport(encoder.codec()),
            vec![paracord_transport::stream::PublishedLayer {
                layer_id: 0,
                ssrc: session.video_ssrc,
                width: Some(width),
                height: Some(height),
                max_bitrate_kbps: Some(config.bitrate_kbps),
                active: true,
            }],
        )
    };
    Ok(paracord_transport::stream::PublishedTrack {
        stream_id: StreamId::new(format!("stream:{}:camera", session.session_id)),
        track_id: TrackId::new("camera"),
        publisher_user_id: session.local_user_id,
        kind: paracord_transport::control::TrackKind::Video,
        codec: Some(codec),
        layers,
    })
}

#[cfg(feature = "vpx")]
pub async fn ensure_track_sender_key(
    session: &mut NativeMediaSession,
    track: &PublishedTrack,
) -> Result<(), String> {
    use rand::RngCore;

    let key = {
        let mut sender_keys = session.track_sender_keys.lock().await;
        sender_keys
            .entry((track.stream_id.clone(), track.track_id.clone()))
            .or_insert_with(|| {
                let mut key = [0u8; 16];
                rand::thread_rng().fill_bytes(&mut key);
                super::session::SenderKeyState {
                    epoch: session.current_key_epoch.load(Ordering::SeqCst),
                    key,
                }
            })
            .to_owned()
    };

    {
        let mut encryptor = session
            .frame_encryptor
            .lock()
            .map_err(|_| "frame encryptor lock poisoned".to_string())?;
        for layer in &track.layers {
            encryptor.set_peer_key(layer.ssrc, key.epoch, &key.key);
        }
    }
    // Register our own key with the local decryptor too: self-view subscribes
    // to our own stream, which the server loops back encrypted with this key.
    let mut decryptor = session
        .frame_decryptor
        .lock()
        .map_err(|_| "frame decryptor lock poisoned".to_string())?;
    for layer in &track.layers {
        decryptor.set_peer_key(layer.ssrc, key.epoch, &key.key);
    }
    Ok(())
}

#[cfg(feature = "vpx")]
pub async fn clear_track_sender_key(session: &mut NativeMediaSession, track: &PublishedTrack) {
    let removed = {
        let mut sender_keys = session.track_sender_keys.lock().await;
        sender_keys.remove(&(track.stream_id.clone(), track.track_id.clone()))
    };
    if let Ok(mut encryptor) = session.frame_encryptor.lock() {
        let epoch = removed
            .map(|state| state.epoch)
            .unwrap_or(session.current_key_epoch.load(Ordering::SeqCst));
        for layer in &track.layers {
            encryptor.remove_peer_key(layer.ssrc, epoch);
        }
    }
}

#[cfg(not(feature = "vpx"))]
pub async fn ensure_track_sender_key(
    _session: &mut NativeMediaSession,
    _track: &PublishedTrack,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(feature = "vpx"))]
pub async fn clear_track_sender_key(_session: &mut NativeMediaSession, _track: &PublishedTrack) {}

#[cfg(all(test, feature = "vpx"))]
mod tests {
    use super::*;

    #[test]
    fn decodes_new_video_metadata_payload() {
        let metadata = VideoFrameMetadata {
            stream_id: StreamId::new("stream:1:screen"),
            track_id: TrackId::new("screen"),
            frame_id: 42,
            layer_id: 1,
            codec: TransportVideoCodec::H264,
            timestamp_us: 123_456,
            is_keyframe: true,
            fragment_index: 0,
            fragment_count: 1,
        };
        let mut payload = BytesMut::new();
        metadata.encode(&mut payload).unwrap();
        payload.extend_from_slice(&[1, 2, 3, 4]);

        let header = MediaHeader {
            version: 1,
            track_type: TrackType::Video,
            simulcast_layer: 1,
            sequence: 7,
            timestamp: 90_000,
            ssrc: 99,
            audio_level: 127,
            key_epoch: 0,
            payload_length: payload.len() as u16,
            codec: TransportVideoCodec::H264.header_id(),
        };

        let decoded = decode_video_fragment_payload(&header, &payload).unwrap();
        assert_eq!(decoded.0.stream_id.0, "stream:1:screen");
        assert_eq!(decoded.0.track_id.0, "screen");
        assert_eq!(decoded.0.frame_id, 42);
        assert_eq!(decoded.0.codec, TransportVideoCodec::H264);
        assert_eq!(decoded.1, vec![1, 2, 3, 4]);
    }

    #[test]
    fn rejects_legacy_video_fragment_payload() {
        let header = MediaHeader {
            version: 1,
            track_type: TrackType::Video,
            simulcast_layer: 0,
            sequence: 11,
            timestamp: 1234,
            ssrc: 55,
            audio_level: 127,
            key_epoch: 0,
            payload_length: 9,
            codec: TransportVideoCodec::Vp9.header_id(),
        };
        let payload = vec![0x01, 0, 0, 0, 1, 9, 8, 7, 6];
        assert!(decode_video_fragment_payload(&header, &payload).is_none());
    }

    #[test]
    fn runtime_fallback_preference_is_ordered_per_source_codec() {
        assert_eq!(
            runtime_fallback_preference(VideoCodec::Av1),
            vec![VideoCodec::H264, VideoCodec::Vp9]
        );
        assert_eq!(
            runtime_fallback_preference(VideoCodec::H264),
            vec![VideoCodec::Vp9]
        );
        assert_eq!(runtime_fallback_preference(VideoCodec::Vp9), Vec::new());
    }

    #[test]
    fn runtime_fallback_preference_never_includes_current_codec() {
        for current in [VideoCodec::Av1, VideoCodec::H264, VideoCodec::Vp9] {
            assert!(
                !runtime_fallback_preference(current).contains(&current),
                "fallback list for {current:?} must not contain itself"
            );
        }
    }

    #[test]
    fn decodes_vp9_keyframe_datagram_into_i420_frame() {
        use paracord_codec::video::encoder::create_encoder;
        use paracord_codec::video::{EncoderConfig, PixelFormat, VideoContentHint};

        let width = 320u32;
        let height = 240u32;

        // Encode a real VP9 keyframe so libvpx produces a valid bitstream.
        let mut encoder = create_encoder(
            VideoCodec::Vp9,
            EncoderConfig {
                width,
                height,
                fps: 30,
                bitrate_kbps: 500,
                pixel_format: PixelFormat::I420,
                keyframe_interval: 0,
                content_hint: VideoContentHint::Default,
            },
        )
        .expect("vp9 encoder");

        let y_size = (width * height) as usize;
        let uv_size = ((width / 2) * (height / 2)) as usize;
        let mut i420 = vec![128u8; y_size + 2 * uv_size];
        for (i, px) in i420.iter_mut().take(y_size).enumerate() {
            *px = (i % 256) as u8;
        }
        let keyframe = encoder
            .encode(0, &i420, true)
            .expect("encode keyframe")
            .into_iter()
            .find(|frame| frame.is_keyframe)
            .expect("encoder emits a keyframe when forced");

        // Wrap the encoded keyframe in a single-fragment video datagram payload.
        let metadata = VideoFrameMetadata {
            stream_id: StreamId::new("stream:decode-test:camera"),
            track_id: TrackId::new("camera"),
            frame_id: 3,
            layer_id: 0,
            codec: TransportVideoCodec::Vp9,
            timestamp_us: 4_242,
            is_keyframe: true,
            fragment_index: 0,
            fragment_count: 1,
        };
        let mut payload = BytesMut::new();
        metadata.encode(&mut payload).unwrap();
        payload.extend_from_slice(&keyframe.data);

        let header = MediaHeader {
            version: 1,
            track_type: TrackType::Video,
            simulcast_layer: 0,
            sequence: 1,
            timestamp: 90_000,
            ssrc: 4321,
            audio_level: 127,
            key_epoch: 0,
            payload_length: payload.len() as u16,
            codec: TransportVideoCodec::Vp9.header_id(),
        };

        // Reassembly + native decode should yield an I420 frame in the pull store.
        let (decoded_metadata, encoded_bytes) =
            reassemble_video_payload(&header, &payload).expect("single fragment reassembles");
        let track_key = make_track_key(&decoded_metadata.stream_id.0, &decoded_metadata.track_id.0);
        let encoded = paracord_codec::video::EncodedFrame {
            data: encoded_bytes,
            codec: VideoCodec::Vp9,
            pts: decoded_metadata.frame_id as i64,
            is_keyframe: decoded_metadata.is_keyframe,
            layer: None,
            width: 0,
            height: 0,
        };
        let outcome =
            decode_and_store_remote_video_frame(&track_key, decoded_metadata.timestamp_us, encoded);
        assert!(matches!(outcome, VideoDecodeOutcome::Delivered));

        let stored = pull_latest_remote_stream_video_frame(
            &decoded_metadata.stream_id.0,
            &decoded_metadata.track_id.0,
            None,
        )
        .expect("decoded frame stored for pull");
        assert_eq!(stored.format, "i420");
        assert_eq!(stored.codec, "vp9");
        assert_eq!(stored.width, width);
        assert_eq!(stored.height, height);
        assert_eq!(
            stored.data.len(),
            PixelFormat::I420.frame_size(width, height)
        );

        let response = encode_pulled_video_frame_response(stored);
        assert_eq!(response.format, "i420");
        assert_eq!(response.width, width);
        assert_eq!(response.height, height);

        // Tear down: dropping the decoder must release its libvpx state and the
        // pull store must forget the track.
        unregister_stream_video_subscription(
            &decoded_metadata.stream_id.0,
            &decoded_metadata.track_id.0,
        );
        assert!(pull_latest_remote_stream_video_frame(
            &decoded_metadata.stream_id.0,
            &decoded_metadata.track_id.0,
            None,
        )
        .is_none());
    }
}
