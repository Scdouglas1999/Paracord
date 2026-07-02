use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU8};
use std::sync::Arc;
#[cfg(feature = "vpx")]
use std::time::Instant;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::random;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, Notify};
use tokio::task::JoinHandle;

use super::capabilities::{detect_media_stream_capabilities, MediaStreamCapabilities};
use super::stream_registry::StreamRegistry;
use paracord_codec::audio::capture::AudioCapture;
use paracord_codec::audio::jitter::JitterBuffer;
use paracord_codec::audio::noise::NoiseSuppressor;
use paracord_codec::audio::opus::{OpusDecoder, OpusEncoder};
use paracord_codec::audio::playback::AudioPlayback;
use paracord_codec::crypto::{FrameDecryptor, FrameEncryptor};
use paracord_transport::connection::MediaConnection;
use paracord_transport::control::ControlMessage;
use paracord_transport::endpoint::MediaEndpoint;
use paracord_transport::stream::{PublishedTrack, StreamId, TrackId, VideoCodecCapability};

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
}

/// Active native media session connected to the relay via QUIC.
#[allow(dead_code)]
pub struct NativeMediaSession {
    // QUIC transport
    pub endpoint: MediaEndpoint,
    pub connection: MediaConnection,

    // Audio capture
    pub audio_capture: Option<AudioCapture>,
    pub pcm_rx: Option<mpsc::Receiver<Vec<f32>>>,
    pub screen_audio_rx: Option<mpsc::Receiver<Vec<f32>>>,
    pub screen_audio_tx: mpsc::Sender<Vec<f32>>,
    pub screen_audio_enabled: Arc<AtomicBool>,

    // Audio playback. Shared behind a mutex so the datagram receive task can
    // lazily register new remote SSRCs while `voice_switch_output_device` can
    // swap the whole engine underneath it.
    pub audio_playback: Arc<tokio::sync::Mutex<AudioPlayback>>,

    // Opus codec
    pub opus_encoder: OpusEncoder,

    // Noise suppression
    pub noise_suppressor: NoiseSuppressor,

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
    #[cfg(feature = "vpx")]
    pub video_decoders: HashMap<u32, Box<dyn paracord_codec::video::decoder::VideoDecoder>>,
    /// Reusable buffer for RGBA→I420 conversion before VP9 encoding.
    #[cfg(feature = "vpx")]
    pub i420_convert_buf: Vec<u8>,

    pub video_send_task: Option<JoinHandle<()>>,
    pub screen_send_task: Option<JoinHandle<()>>,

    pub video_ssrc: u32,
    pub screen_ssrc: u32,
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
    #[cfg(feature = "vpx")]
    pub video_force_keyframe: bool,
    #[cfg(feature = "vpx")]
    pub screen_force_keyframe: bool,
    #[cfg(feature = "vpx")]
    pub screen_empty_output_streak: u32,
    #[cfg(feature = "vpx")]
    pub screen_runtime_fallback_attempted: bool,
    #[cfg(feature = "vpx")]
    pub screen_encoder_started_at: Option<Instant>,
}

// SAFETY: NativeMediaSession is always accessed through a tokio::Mutex<Option<..>>
// which guarantees exclusive access. The !Send/!Sync inner types (cpal::Stream via
// AudioPlayback/AudioCapture, audiopus raw pointers in OpusEncoder/OpusDecoder,
// nnnoiseless DenoiseState) all hold independent per-instance state that is safe
// to move between threads.
unsafe impl Send for NativeMediaSession {}
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

    async fn resolve_endpoint_addr(endpoint_addr: &str) -> Result<SocketAddr, String> {
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
        let remote_addr = Self::resolve_endpoint_addr(endpoint_addr).await?;

        // Connect and authenticate
        let connecting = endpoint
            .connect(remote_addr, "paracord")
            .map_err(|e| format!("QUIC connect: {e}"))?;
        let quinn_conn = connecting
            .await
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

        // Set up audio components
        let opus_encoder = OpusEncoder::new().map_err(|e| format!("opus encoder: {e}"))?;
        let noise_suppressor = NoiseSuppressor::new();
        let audio_playback = AudioPlayback::start().map_err(|e| format!("audio playback: {e}"))?;

        // Start audio capture
        let (audio_capture, pcm_rx) =
            AudioCapture::start().map_err(|e| format!("audio capture: {e}"))?;
        let (screen_audio_tx, screen_audio_rx) = mpsc::channel::<Vec<f32>>(64);

        // Deterministic SSRCs avoid the need for a separate native
        // subscribe/signaling protocol just to map tracks to users.
        let local_ssrc = Self::derive_track_ssrc(local_user_id, "audio");
        let video_ssrc = Self::derive_track_ssrc(local_user_id, "video");
        let screen_ssrc = Self::derive_track_ssrc(local_user_id, "screen");

        // E2EE key setup
        let key_epoch = 1u8;
        let audio_sender_key = random::<[u8; 16]>();
        let mut frame_encryptor = FrameEncryptor::new();
        frame_encryptor.set_peer_key(local_ssrc, key_epoch, &audio_sender_key);
        let frame_decryptor = FrameDecryptor::new();

        Ok(Self {
            endpoint,
            connection,
            audio_capture: Some(audio_capture),
            pcm_rx: Some(pcm_rx),
            screen_audio_rx: Some(screen_audio_rx),
            screen_audio_tx,
            screen_audio_enabled: Arc::new(AtomicBool::new(false)),
            audio_playback: Arc::new(tokio::sync::Mutex::new(audio_playback)),
            opus_encoder,
            noise_suppressor,
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
            video_decoders: HashMap::new(),
            #[cfg(feature = "vpx")]
            i420_convert_buf: Vec::new(),
            video_send_task: None,
            screen_send_task: None,
            video_ssrc,
            screen_ssrc,
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
            #[cfg(feature = "vpx")]
            video_force_keyframe: true,
            #[cfg(feature = "vpx")]
            screen_force_keyframe: true,
            #[cfg(feature = "vpx")]
            screen_empty_output_streak: 0,
            #[cfg(feature = "vpx")]
            screen_runtime_fallback_attempted: false,
            #[cfg(feature = "vpx")]
            screen_encoder_started_at: None,
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

        // Stop audio capture
        if let Some(capture) = self.audio_capture.take() {
            capture.stop();
        }

        // Stop audio playback
        self.audio_playback.lock().await.stop();

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
