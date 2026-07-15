use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8};
use std::sync::Arc;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::random;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, Notify};
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration};

use super::audio_actor::AudioActor;
use super::capabilities::{detect_media_stream_capabilities, MediaStreamCapabilities};
use super::stream_registry::StreamRegistry;
use paracord_codec::audio::jitter::JitterBuffer;
use paracord_codec::audio::opus::OpusDecoder;
use paracord_codec::crypto::{FrameDecryptor, FrameEncryptor};
use paracord_transport::connection::MediaConnection;
use paracord_transport::control::ControlMessage;
use paracord_transport::endpoint::MediaEndpoint;
use paracord_transport::stream::{PublishedTrack, StreamId, TrackId, VideoCodecCapability};

const DNS_RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);
const QUIC_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const AUDIO_DEVICE_TIMEOUT: Duration = Duration::from_secs(10);

#[cfg(feature = "vpx")]
pub struct NativeSimulcastState {
    pub encoder: paracord_codec::video::encoder::SimulcastEncoder,
    pub input_width: u32,
    pub input_height: u32,
    pub layers: Vec<(
        paracord_codec::video::SimulcastLayer,
        paracord_codec::video::EncoderConfig,
    )>,
    pub codec: paracord_codec::video::VideoCodec,
    pub backend_name: &'static str,
    pub hardware_accelerated: bool,
    pub ssrcs: Vec<(u8, u32)>,
}

#[derive(Debug, Clone, Copy)]
pub struct SenderKeyState {
    pub epoch: u8,
    pub key: [u8; 16],
}

/// Per-remote-participant audio state.
#[allow(dead_code)]
pub struct RemoteAudioState {
    pub decoder: OpusDecoder,
    pub jitter_buffer: JitterBuffer<Vec<u8>>,
    pub playback_tx: mpsc::Sender<Vec<f32>>,
    pub audio_level: u8,
    /// Last time a datagram was inserted for this SSRC. Idle sources are reaped
    /// so a departed participant does not burn PLC decodes forever (AU9).
    pub last_packet: std::time::Instant,
    /// Set once a real (non-PLC) packet has been decoded. PLC is gated on this
    /// so a source that never actually played does not emit concealment noise.
    pub has_played: bool,
}

/// Active native media session connected to the relay via QUIC.
#[allow(dead_code)]
pub struct NativeMediaSession {
    // QUIC transport
    pub endpoint: MediaEndpoint,
    pub connection: MediaConnection,

    // Audio capture. The cpal-backed capture/playback streams live on the
    // audio actor's dedicated thread (see `AudioActor`); this session only ever
    // holds the actor handle and the PCM frame receiver it hands back.
    pub pcm_rx: Option<mpsc::Receiver<Vec<f32>>>,
    pub screen_audio_rx: Option<mpsc::Receiver<Vec<f32>>>,
    pub screen_audio_tx: mpsc::Sender<Vec<f32>>,
    pub screen_audio_enabled: Arc<AtomicBool>,

    // Audio capture/playback owner. Shared with the datagram receive task so it
    // can lazily register new remote SSRCs, while `voice_switch_output_device`
    // can swap the whole output device underneath it.
    pub audio_actor: Arc<AudioActor>,

    // Runtime noise-suppression toggle (contract AU13). The mic send task owns
    // the actual `NoiseSuppressor` and reads this flag each frame; default on.
    pub noise_suppression_enabled: Arc<AtomicBool>,

    // E2EE encryption/decryption
    pub frame_encryptor: Arc<std::sync::Mutex<FrameEncryptor>>,
    pub frame_decryptor: Arc<std::sync::Mutex<FrameDecryptor>>,
    pub current_key_epoch: Arc<AtomicU8>,
    pub audio_sender_state: Arc<std::sync::Mutex<SenderKeyState>>,

    // Remote participants
    pub remote_audio: Arc<tokio::sync::Mutex<HashMap<u32, RemoteAudioState>>>,

    // Local identity
    pub local_user_id: i64,
    pub room_id: String,
    pub local_ssrc: u32,
    pub session_id: String,

    // Mute/deaf controls
    pub muted: Arc<AtomicBool>,
    pub deafened: Arc<AtomicBool>,

    // Task management
    pub shutdown: Arc<Notify>,
    pub audio_send_task: Option<JoinHandle<()>>,
    pub datagram_recv_task: Option<JoinHandle<()>>,
    /// Accepts loss-resilient keyframe frames delivered on QUIC unidirectional
    /// streams (the datagram-fragment path only carries delta frames now).
    pub uni_stream_recv_task: Option<JoinHandle<()>>,
    pub playout_task: Option<JoinHandle<()>>,
    pub speaking_task: Option<JoinHandle<()>>,
    pub control_recv_task: Option<JoinHandle<()>>,

    // Video encoders (optional, behind feature gate)
    #[cfg(feature = "vpx")]
    pub video_encoder: Option<Box<dyn paracord_codec::video::encoder::VideoEncoder>>,
    #[cfg(feature = "vpx")]
    pub video_simulcast: Option<NativeSimulcastState>,
    #[cfg(feature = "vpx")]
    pub screen_encoder: Option<Box<dyn paracord_codec::video::encoder::VideoEncoder>>,
    #[cfg(feature = "vpx")]
    pub screen_simulcast: Option<NativeSimulcastState>,
    #[cfg(feature = "vpx")]
    pub screen_encoder_config: Option<paracord_codec::video::EncoderConfig>,
    #[cfg(feature = "vpx")]
    pub screen_encoder_codec: Option<paracord_codec::video::VideoCodec>,
    // Camera-encoder configuration mirroring the screen fields above. The camera
    // path is split into the same begin/run/finish phases (see
    // `video_pipeline::{begin,run,finish}_camera_frame`), so it needs the same
    // per-stream config/codec/generation snapshot state that lets the heavy
    // encode run with the session lock released.
    #[cfg(feature = "vpx")]
    pub video_encoder_config: Option<paracord_codec::video::EncoderConfig>,
    #[cfg(feature = "vpx")]
    pub video_encoder_codec: Option<paracord_codec::video::VideoCodec>,
    /// Reusable buffer for RGBA→I420 conversion before VP9 encoding.
    #[cfg(feature = "vpx")]
    pub i420_convert_buf: Vec<u8>,

    pub video_send_task: Option<JoinHandle<()>>,
    pub screen_send_task: Option<JoinHandle<()>>,

    pub video_ssrc: u32,
    pub screen_ssrc: u32,
    pub screen_audio_ssrc: u32,
    #[cfg(feature = "vpx")]
    pub video_layer_ssrcs: Vec<(u8, u32)>,
    #[cfg(feature = "vpx")]
    pub screen_layer_ssrcs: Vec<(u8, u32)>,
    pub video_seq: u16,
    pub screen_seq: u16,
    pub video_timestamp: u32,
    pub screen_timestamp: u32,
    pub video_pts: i64,
    pub screen_pts: i64,
    pub stream_registry: Arc<tokio::sync::Mutex<StreamRegistry>>,
    pub session_participants: Arc<tokio::sync::Mutex<HashMap<i64, RemoteSessionParticipant>>>,
    pub track_sender_keys: Arc<tokio::sync::Mutex<HashMap<(StreamId, TrackId), SenderKeyState>>>,
    pub stream_capabilities: MediaStreamCapabilities,
    pub published_video_track: Option<PublishedTrack>,
    pub published_screen_track: Option<PublishedTrack>,
    pub published_screen_audio_track: Option<PublishedTrack>,
    pub screen_audio_send_task: Option<JoinHandle<()>>,
    pub connection_monitor_task: Option<JoinHandle<()>>,
    pub stream_remote_audio:
        Arc<tokio::sync::Mutex<HashMap<u32, super::audio_pipeline::StreamRemoteAudioState>>>,
    /// Shared with the control-receive task so an incoming
    /// `ControlMessage::RequestKeyframe` from the relay (new subscriber, or a
    /// viewer that lost fragments) forces the next encoded frame to be intra.
    pub video_force_keyframe: Arc<AtomicBool>,
    pub screen_force_keyframe: Arc<AtomicBool>,
    /// Most recent relay bandwidth estimate for this connection, in kbps
    /// (0 = no feedback yet). Written by the control-receive task on
    /// `ControlMessage::BandwidthFeedback`, read per frame by the screen
    /// encode path to retarget the encoder under congestion.
    pub screen_bitrate_feedback_kbps: Arc<AtomicU32>,
    /// Bitrate currently programmed into the screen encoder, in kbps
    /// (0 = the preset target). Only touched under the session lock.
    #[cfg(feature = "vpx")]
    pub screen_applied_bitrate_kbps: u32,
    /// Monotonic guard bumped on every screen encoder (re)init, `start_screen_share`,
    /// and `stop_screen_share`. A frame job snapshots this under the session lock
    /// before releasing it for the (unlocked) encode; if the session's counter has
    /// advanced by the time the job finishes, the encoder it carried is orphaned
    /// (the stream was stopped or reconfigured mid-frame) and its results are
    /// dropped instead of written back.
    #[cfg(feature = "vpx")]
    pub screen_encoder_generation: u64,
    /// Wall-clock capture time of the first screen frame of the current share,
    /// used as the zero point for the on-the-wire microsecond PTS (L2). `None`
    /// until the first frame; reset on every `start_screen_share`/`stop`.
    #[cfg(feature = "vpx")]
    pub screen_capture_base_time: Option<std::time::SystemTime>,
    /// Last microsecond PTS emitted for the screen track, so the wire timestamp
    /// stays monotonic even if a capture backend reports a non-monotonic clock.
    #[cfg(feature = "vpx")]
    pub screen_last_timestamp_us: u64,
    /// Bitrate currently programmed into the camera encoder, in kbps
    /// (0 = the preset target). Only touched under the session lock.
    #[cfg(feature = "vpx")]
    pub video_applied_bitrate_kbps: u32,
    /// Monotonic guard bumped on every camera encoder (re)init and
    /// start/stop_camera_share; a camera frame job that outlives a
    /// reconfigure is orphaned. Mirrors `screen_encoder_generation`.
    #[cfg(feature = "vpx")]
    pub video_encoder_generation: u64,
    /// Wall-clock capture time of the first camera frame of the current
    /// capture, the zero point for the on-the-wire microsecond PTS (L2).
    #[cfg(feature = "vpx")]
    pub video_capture_base_time: Option<std::time::SystemTime>,
    /// Last microsecond PTS emitted for the camera track (kept monotonic).
    #[cfg(feature = "vpx")]
    pub video_last_timestamp_us: u64,
}

// SAFETY: `NativeMediaSession` is `Send` automatically now that the cpal
// audio streams live on the `AudioActor`'s dedicated thread rather than inside
// this struct — the drop-on-wrong-thread hazard (macOS CoreAudio) is gone.
//
// It is not automatically `Sync`, because a few owned codec-state fields are
// `Send` but not `Sync`: the boxed `dyn VideoEncoder` trait objects (the trait
// is `: Send` only) and the audiopus-backed `OpusEncoder`. The session is only
// ever reached through the `tokio::Mutex<Option<NativeMediaSession>>` that owns
// it, so any `&NativeMediaSession` a command handler holds across an `.await` is
// still covered by the mutex's exclusive access — no two threads touch this
// codec state concurrently. Remote-participant `OpusDecoder`s already sit behind
// their own `tokio::Mutex` (`remote_audio`). This asserts that shared-reference
// access to the struct is sound under that exclusivity.
unsafe impl Sync for NativeMediaSession {}

impl NativeMediaSession {
    pub fn derive_track_ssrc(user_id: i64, kind: &str) -> u32 {
        let mut hasher = Sha256::new();
        hasher.update(b"paracord-native-ssrc-v1:");
        hasher.update(kind.as_bytes());
        hasher.update(b":");
        hasher.update(user_id.to_string().as_bytes());
        let digest = hasher.finalize();
        let mut ssrc = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
        if ssrc == 0 {
            ssrc = 1;
        }
        ssrc
    }

    #[cfg(feature = "vpx")]
    pub fn derive_track_layer_ssrc(user_id: i64, kind: &str, layer_id: u8) -> u32 {
        Self::derive_track_ssrc(user_id, &format!("{kind}:layer:{layer_id}"))
    }

    fn parse_token_claims(token: &str) -> Result<MediaTokenClaims, String> {
        let mut parts = token.split('.');
        let _header = parts.next().ok_or("token missing header")?;
        let payload = parts.next().ok_or("token missing payload")?;
        let decoded = URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(|e| format!("token payload decode failed: {e}"))?;
        serde_json::from_slice::<MediaTokenClaims>(&decoded)
            .map_err(|e| format!("token claims parse failed: {e}"))
    }

    pub async fn resolve_endpoint_addr(endpoint_addr: &str) -> Result<SocketAddr, String> {
        if let Ok(addr) = endpoint_addr.parse::<SocketAddr>() {
            return Ok(addr);
        }

        if let Ok(url) = url::Url::parse(endpoint_addr) {
            let host = url
                .host_str()
                .ok_or_else(|| format!("endpoint URL missing host: {endpoint_addr}"))?;
            let port = url
                .port_or_known_default()
                .ok_or_else(|| format!("endpoint URL missing port: {endpoint_addr}"))?;

            if let Ok(ip) = host.parse::<IpAddr>() {
                return Ok(SocketAddr::new(ip, port));
            }

            let mut resolved = tokio::net::lookup_host((host, port))
                .await
                .map_err(|e| format!("dns lookup failed for {host}:{port}: {e}"))?;
            if let Some(addr) = resolved.next() {
                return Ok(addr);
            }
            return Err(format!(
                "dns lookup returned no addresses for {host}:{port}"
            ));
        }

        Err(format!("bad endpoint addr: {endpoint_addr}"))
    }

    /// Connect to a QUIC media relay and set up codec pipelines.
    pub async fn connect(
        endpoint_addr: &str,
        token: &str,
        cert_hash: &str,
        room_id: &str,
        advertised_capabilities: Option<MediaStreamCapabilities>,
    ) -> Result<Self, String> {
        use paracord_transport::connection::ConnectionMode;

        // Create a client-only QUIC endpoint
        let bind_addr: std::net::SocketAddr = "0.0.0.0:0"
            .parse()
            .map_err(|e| format!("bad bind addr: {e}"))?;
        let endpoint =
            MediaEndpoint::client(bind_addr).map_err(|e| format!("endpoint create: {e}"))?;

        // Parse remote address
        let remote_addr = timeout(
            DNS_RESOLVE_TIMEOUT,
            Self::resolve_endpoint_addr(endpoint_addr),
        )
        .await
        .map_err(|_| {
            format!(
                "dns lookup timed out after {}s for {endpoint_addr}",
                DNS_RESOLVE_TIMEOUT.as_secs()
            )
        })??;

        // Connect and authenticate
        let connecting = endpoint
            .connect_pinned(remote_addr, "paracord", cert_hash)
            .map_err(|e| format!("QUIC connect: {e}"))?;
        let quinn_conn = timeout(QUIC_HANDSHAKE_TIMEOUT, connecting)
            .await
            .map_err(|_| {
                format!(
                    "QUIC handshake timed out after {}s for {remote_addr}",
                    QUIC_HANDSHAKE_TIMEOUT.as_secs()
                )
            })?
            .map_err(|e| format!("QUIC handshake: {e}"))?;
        let connection =
            MediaConnection::connect_and_auth(quinn_conn, token, ConnectionMode::Relay)
                .await
                .map_err(|e| format!("auth: {e}"))?;

        let claims = Self::parse_token_claims(token)?;
        let local_user_id = claims.sub;
        let resolved_room_id = if !room_id.trim().is_empty() {
            room_id.trim().to_string()
        } else {
            claims
                .room
                .clone()
                .ok_or("token missing room claim".to_string())?
        };
        let session_id = claims
            .sid
            .clone()
            .unwrap_or_else(|| format!("native-{}", resolved_room_id));

        // The cpal streams are owned by a dedicated thread; create it, start
        // playback, then start capture (which hands back the PCM receiver).
        let audio_actor = Arc::new(AudioActor::spawn());
        timeout(AUDIO_DEVICE_TIMEOUT, audio_actor.start_playback(None))
            .await
            .map_err(|_| {
                format!(
                    "audio playback device init timed out after {}s",
                    AUDIO_DEVICE_TIMEOUT.as_secs()
                )
            })??;
        let pcm_rx = timeout(AUDIO_DEVICE_TIMEOUT, audio_actor.start_capture(None))
            .await
            .map_err(|_| {
                format!(
                    "audio capture device init timed out after {}s",
                    AUDIO_DEVICE_TIMEOUT.as_secs()
                )
            })??;
        let (screen_audio_tx, screen_audio_rx) = mpsc::channel::<Vec<f32>>(64);

        // Deterministic SSRCs avoid the need for a separate native
        // subscribe/signaling protocol just to map tracks to users.
        let local_ssrc = Self::derive_track_ssrc(local_user_id, "audio");
        let video_ssrc = Self::derive_track_ssrc(local_user_id, "video");
        let screen_ssrc = Self::derive_track_ssrc(local_user_id, "screen");
        let screen_audio_ssrc = Self::derive_track_ssrc(local_user_id, "screen:audio");

        // E2EE key setup
        let key_epoch = 1u8;
        let audio_sender_key = random::<[u8; 16]>();
        let mut frame_encryptor = FrameEncryptor::new();
        frame_encryptor.set_peer_key(local_ssrc, key_epoch, &audio_sender_key);
        let frame_decryptor = FrameDecryptor::new();

        Ok(Self {
            endpoint,
            connection,
            pcm_rx: Some(pcm_rx),
            screen_audio_rx: Some(screen_audio_rx),
            screen_audio_tx,
            screen_audio_enabled: Arc::new(AtomicBool::new(false)),
            audio_actor,
            noise_suppression_enabled: Arc::new(AtomicBool::new(true)),
            frame_encryptor: Arc::new(std::sync::Mutex::new(frame_encryptor)),
            frame_decryptor: Arc::new(std::sync::Mutex::new(frame_decryptor)),
            current_key_epoch: Arc::new(AtomicU8::new(key_epoch)),
            audio_sender_state: Arc::new(std::sync::Mutex::new(SenderKeyState {
                epoch: key_epoch,
                key: audio_sender_key,
            })),
            remote_audio: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            local_user_id,
            room_id: resolved_room_id,
            local_ssrc,
            session_id,
            muted: Arc::new(AtomicBool::new(false)),
            deafened: Arc::new(AtomicBool::new(false)),
            shutdown: Arc::new(Notify::new()),
            audio_send_task: None,
            datagram_recv_task: None,
            uni_stream_recv_task: None,
            playout_task: None,
            speaking_task: None,
            control_recv_task: None,
            #[cfg(feature = "vpx")]
            video_encoder: None,
            #[cfg(feature = "vpx")]
            video_simulcast: None,
            #[cfg(feature = "vpx")]
            screen_encoder: None,
            #[cfg(feature = "vpx")]
            screen_simulcast: None,
            #[cfg(feature = "vpx")]
            screen_encoder_config: None,
            #[cfg(feature = "vpx")]
            screen_encoder_codec: None,
            #[cfg(feature = "vpx")]
            video_encoder_config: None,
            #[cfg(feature = "vpx")]
            video_encoder_codec: None,
            #[cfg(feature = "vpx")]
            i420_convert_buf: Vec::new(),
            video_send_task: None,
            screen_send_task: None,
            video_ssrc,
            screen_ssrc,
            screen_audio_ssrc,
            #[cfg(feature = "vpx")]
            video_layer_ssrcs: Vec::new(),
            #[cfg(feature = "vpx")]
            screen_layer_ssrcs: Vec::new(),
            video_seq: 0,
            screen_seq: 0,
            video_timestamp: 0,
            screen_timestamp: 0,
            video_pts: 0,
            screen_pts: 0,
            stream_registry: Arc::new(tokio::sync::Mutex::new(StreamRegistry::default())),
            session_participants: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            track_sender_keys: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            stream_capabilities: advertised_capabilities
                .unwrap_or_else(detect_media_stream_capabilities),
            published_video_track: None,
            published_screen_track: None,
            published_screen_audio_track: None,
            screen_audio_send_task: None,
            connection_monitor_task: None,
            stream_remote_audio: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            video_force_keyframe: Arc::new(AtomicBool::new(true)),
            screen_force_keyframe: Arc::new(AtomicBool::new(true)),
            screen_bitrate_feedback_kbps: Arc::new(AtomicU32::new(0)),
            #[cfg(feature = "vpx")]
            screen_applied_bitrate_kbps: 0,
            #[cfg(feature = "vpx")]
            screen_encoder_generation: 0,
            #[cfg(feature = "vpx")]
            screen_capture_base_time: None,
            #[cfg(feature = "vpx")]
            screen_last_timestamp_us: 0,
            #[cfg(feature = "vpx")]
            video_applied_bitrate_kbps: 0,
            #[cfg(feature = "vpx")]
            video_encoder_generation: 0,
            #[cfg(feature = "vpx")]
            video_capture_base_time: None,
            #[cfg(feature = "vpx")]
            video_last_timestamp_us: 0,
        })
    }

    /// Shut down the session, abort all tasks, and close the QUIC connection.
    pub async fn disconnect(&mut self) {
        // Signal all tasks to stop
        self.shutdown.notify_waiters();

        // Abort spawned tasks
        if let Some(h) = self.audio_send_task.take() {
            h.abort();
        }
        if let Some(h) = self.datagram_recv_task.take() {
            h.abort();
        }
        if let Some(h) = self.uni_stream_recv_task.take() {
            h.abort();
        }
        if let Some(h) = self.playout_task.take() {
            h.abort();
        }
        if let Some(h) = self.speaking_task.take() {
            h.abort();
        }
        if let Some(h) = self.control_recv_task.take() {
            h.abort();
        }
        if let Some(h) = self.video_send_task.take() {
            h.abort();
        }
        if let Some(h) = self.screen_send_task.take() {
            h.abort();
        }
        if let Some(h) = self.screen_audio_send_task.take() {
            h.abort();
        }
        if let Some(h) = self.connection_monitor_task.take() {
            h.abort();
        }

        // Stop capture and silence playback. The cpal streams are fully torn
        // down on the actor thread when the last `AudioActor` handle drops.
        self.audio_actor.stop_capture();
        self.audio_actor.stop_playback();

        // Drop all process-wide remote-video state (decode workers, decoders,
        // reassembly buffers, latest-frame store) so nothing replays into the
        // next session under the deterministic track keys.
        super::video_pipeline::clear_all_stream_video_state();

        // Close QUIC connection
        self.connection.close("session ended");
    }

    pub async fn send_control_message(&self, message: &ControlMessage) -> Result<(), String> {
        let (mut send, _recv) = self
            .connection
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
}

/// Drop backstop: if a session is dropped without an explicit
/// [`NativeMediaSession::disconnect`] (e.g. it is overwritten in the state slot,
/// or a panic unwinds the command handler), the spawned tasks would otherwise
/// leak — a raw `JoinHandle` does NOT abort its task when dropped. Notify the
/// shutdown waiters, abort every task handle, and close the QUIC connection.
/// Idempotent with `disconnect`, which `take()`s the handles first (so the
/// aborts here become no-ops after a clean disconnect).
impl Drop for NativeMediaSession {
    fn drop(&mut self) {
        self.shutdown.notify_waiters();
        for handle in [
            self.audio_send_task.take(),
            self.datagram_recv_task.take(),
            self.uni_stream_recv_task.take(),
            self.playout_task.take(),
            self.speaking_task.take(),
            self.control_recv_task.take(),
            self.video_send_task.take(),
            self.screen_send_task.take(),
            self.screen_audio_send_task.take(),
            self.connection_monitor_task.take(),
        ]
        .into_iter()
        .flatten()
        {
            handle.abort();
        }
        self.audio_actor.stop_capture();
        self.audio_actor.stop_playback();
        super::video_pipeline::clear_all_stream_video_state();
        self.connection.close("session dropped");
    }
}

#[derive(Debug, Deserialize)]
struct MediaTokenClaims {
    sub: i64,
    #[allow(dead_code)]
    exp: Option<usize>,
    #[allow(dead_code)]
    iat: Option<usize>,
    sid: Option<String>,
    room: Option<String>,
}
#[derive(Debug, Clone)]
pub struct RemoteSessionParticipant {
    pub session_id: String,
    pub video_capabilities: Vec<VideoCodecCapability>,
}
