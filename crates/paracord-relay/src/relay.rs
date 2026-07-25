use std::collections::{HashMap, VecDeque};
use std::sync::{
    atomic::{AtomicU32, AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use bytes::Bytes;
use dashmap::DashMap;
use tokio::sync::{mpsc, Mutex, Notify};
use tokio::task::AbortHandle;
use tokio::time::MissedTickBehavior;
use tracing::{debug, error, info, warn};

use paracord_transport::control::{ControlMessage, SessionParticipant, TrackKind};
use paracord_transport::protocol::{
    MediaHeader, VideoFrameMetadata, HEADER_SIZE, MAX_STREAM_FRAME_SIZE,
};
use paracord_transport::stream::{
    PublishedTrack, StreamId, TrackId, VideoCodecCapability, ViewportHint,
};

use crate::bandwidth::{BandwidthEstimator, DownlinkEstimator};
use crate::room::MediaRoomManager;
use crate::speaker::SpeakerDetector;

/// Maximum sustained media packets per second a single sender may forward.
///
/// The relay clones every accepted datagram to every subscriber, so an
/// unthrottled sender amplifies proportionally to the room size. This ceiling
/// caps a single authenticated participant's ingress. It is a per-sender rate
/// across all of that sender's tracks (audio + simulcast video).
///
/// Sizing: video frames are fragmented into ~1200-byte datagrams, so the
/// highest client screen-share preset (100 Mbps "Movie 4K") sustains ~10.4k
/// packets/s, plus audio and simulcast overhead. The ceiling must clear the
/// largest legitimate preset with headroom — a limit below it silently drops
/// fragments, and because frame reassembly is all-or-nothing, that destroys
/// entire frames and stalls the stream rather than degrading it.
const MAX_SENDER_PACKETS_PER_SECOND: f64 = 13_000.0;

/// Burst allowance for the sender rate limiter, expressed in packets.
///
/// The token bucket is allowed to accumulate up to this many tokens so brief,
/// legitimate bursts (e.g. a multi-megabyte keyframe fragmented across
/// thousands of datagrams) are not dropped, while the long-run average is
/// still bounded by [`MAX_SENDER_PACKETS_PER_SECOND`].
const SENDER_RATE_BURST_PACKETS: f64 = 26_000.0;

/// Sustained control-message rate one authenticated participant may drive.
///
/// The datagram token bucket above covers only media. Control messages are the
/// expensive ones: `ReceiverReport` and `SubscribeStream` mutate room state and
/// bump the routing generation (invalidating cached fan-out plans and forcing a
/// rebuild), `StreamKeyAnnounce` fans a message out to every named recipient,
/// and each arrives on its own QUIC bidi stream. Legitimate clients send a
/// handful per second (receiver reports are on a ~2s cadence, subscription
/// churn is user-driven), so this is generous.
const MAX_CONTROL_MESSAGES_PER_SECOND: f64 = 50.0;

/// Burst allowance for the control-message limiter. Sized to absorb a join
/// storm: session state, initial subscriptions and key announces for a full
/// 50-participant room arrive back to back.
const CONTROL_RATE_BURST_MESSAGES: f64 = 300.0;

/// Largest `encrypted_keys` vector accepted on a single `StreamKeyAnnounce` /
/// `KeyAnnounce`.
///
/// Each entry causes a control message to be delivered to the named recipient,
/// so an uncapped vector is an amplification primitive: one 256 KB control
/// message could inject thousands of `KeyDeliver` messages. A room holds at most
/// `MAX_PARTICIPANTS` (50) members, so a legitimate announce never names more
/// recipients than that; the cap leaves headroom for a client that includes
/// itself or re-announces during churn.
const MAX_KEY_ANNOUNCE_RECIPIENTS: usize = 64;

/// Largest `layers` vector accepted on a `TrackPublish` / `TrackLayers`.
///
/// The simulcast ladder is three rungs. Every layer a receiver accepts installs
/// an `Aes128Gcm` instance and (for audio) an Opus decoder plus jitter buffer,
/// so an unbounded vector from the wire is a memory-amplification primitive
/// against every subscriber in the room, not just the relay.
const MAX_TRACK_LAYERS: usize = 8;

/// Maximum keyframe uni streams the relay will read from one publisher at once.
///
/// Each in-flight read buffers up to [`MAX_STREAM_FRAME_SIZE`] (16 MiB) before
/// anything is forwarded, and QUIC lets a peer open many concurrent uni streams,
/// so the effective per-connection buffering ceiling is this many times 16 MiB.
/// Keyframes are deliberately exempt from the datagram rate limiter, which makes
/// this the only bound on that path. A publisher legitimately has one keyframe
/// stream per simulcast layer in flight, so four leaves room for a full ladder
/// plus one straggler; beyond that the accept loop simply waits.
const MAX_CONCURRENT_UNI_STREAM_READS: usize = 4;

/// Interval between QUIC path-stat samples for one connection.
const BANDWIDTH_SAMPLE_INTERVAL: Duration = Duration::from_secs(2);

/// Force a `BandwidthFeedback` at least this often even if the estimate is stable.
const BANDWIDTH_FEEDBACK_MAX_INTERVAL: Duration = Duration::from_secs(30);

/// Minimum relative change (10%) before emitting an out-of-band feedback update.
const BANDWIDTH_FEEDBACK_CHANGE_RATIO: f64 = 0.10;

/// Fraction of a viewer's egress estimate a layer's ladder bitrate must fit
/// under to be selected (spec §4.2): highest layer with bitrate ≤ 85% of egress.
const LAYER_BUDGET_PERCENT: u32 = 85;

/// Windowed downlink loss ratio above which the relay downswitches a viewer's
/// layer immediately (spec §4.2: "immediate downswitch on loss >2%").
const DOWNSWITCH_LOSS_RATIO: f64 = 0.02;

/// A candidate upswitch only fires after the viewer's egress estimate has held
/// at least this fraction (125%) of the *target* layer's bitrate (spec §4.2).
const UPSWITCH_HEADROOM_PERCENT: u64 = 125;

/// How long the ≥125% headroom must persist before an upswitch executes (spec §4.2).
const UPSWITCH_HOLD: Duration = Duration::from_secs(5);

/// Minimum interval between forwarded keyframe requests for one `(stream, track)`.
///
/// Viewers re-request an IDR on every gap they see; a single lossy viewer can
/// otherwise pump the shared publisher for a keyframe many times a second,
/// tanking the encoder's average bitrate for everyone. Coalescing bursts to at
/// most one request per this interval protects the whole stream.
const KEYFRAME_REQUEST_MIN_INTERVAL: Duration = Duration::from_millis(500);

static RELAY_VIDEO_FORWARD_DEBUG_COUNT: AtomicU32 = AtomicU32::new(0);

/// Maximum concurrent in-flight keyframe uni streams the relay keeps open toward
/// a single bridged (WebTransport) viewer.
///
/// A raw-QUIC viewer culls stale keyframe streams itself (a superseded keyframe
/// is dropped by the receiver's frame_id high-water). A bridged viewer's browser
/// does the same on the receive side, but on a slow downlink the relay must not
/// let opened-but-unflushed keyframe streams pile up. Capping in-flight streams
/// at this many and aborting the OLDEST when a newer keyframe arrives mirrors that
/// stale-stream culling at the egress: the freshest keyframes win, and a stalled
/// browser never makes the relay buffer an unbounded backlog of old keyframes.
const MAX_BRIDGED_KEYFRAME_STREAMS: usize = 2;

/// Track a freshly opened keyframe uni-stream task for a bridged viewer, evicting
/// (aborting) the oldest in-flight stream once more than `cap` are outstanding.
///
/// Aborting a still-writing stream task drops its `SendStream`, which resets the
/// stream so the browser discards that now-stale keyframe — the egress mirror of
/// the receiver-side stale-stream culling. Aborting an already-finished task is a
/// harmless no-op, so the queue is simply bounded at `cap`.
fn enqueue_inflight_stream(queue: &mut VecDeque<AbortHandle>, handle: AbortHandle, cap: usize) {
    queue.push_back(handle);
    while queue.len() > cap {
        if let Some(oldest) = queue.pop_front() {
            oldest.abort();
        }
    }
}

/// Precomputed fan-out plan for one `(sender_id, ssrc)` at a fixed room+
/// connection generation. Rebuilt lazily only when either generation changes,
/// so the forwarding hot path is one map read plus N `send_datagram` calls
/// instead of a full room clone per datagram.
struct CachedRecipients {
    /// Room routing generation this snapshot was computed at.
    room_generation: u64,
    /// Connection-set generation this snapshot was computed at.
    conn_generation: u64,
    /// The published track this ssrc resolves to, retained for diagnostics.
    published_track: Option<PublishedTrack>,
    /// Resolved recipient connection handles to fan the datagram out to.
    recipients: Vec<ConnectionHandle>,
}

/// Per-sender token-bucket packet-rate limiter keyed by `user_id`.
///
/// Each sender accrues tokens at [`MAX_SENDER_PACKETS_PER_SECOND`] up to a cap
/// of [`SENDER_RATE_BURST_PACKETS`]; forwarding a packet consumes one token.
/// When the bucket is empty the packet is dropped before fan-out.
struct SenderRateLimiter {
    refill_per_second: f64,
    burst: f64,
    buckets: DashMap<i64, TokenBucket>,
}

#[derive(Clone, Copy)]
struct TokenBucket {
    tokens: f64,
    last_refill: Instant,
}

impl SenderRateLimiter {
    fn new(refill_per_second: f64, burst: f64) -> Self {
        Self {
            refill_per_second,
            burst,
            buckets: DashMap::new(),
        }
    }

    /// Attempt to consume one token for `user_id` at real time `now`.
    /// Returns `true` if the packet may be forwarded, `false` if it must be dropped.
    fn try_acquire_at(&self, user_id: i64, now: Instant) -> bool {
        let mut entry = self.buckets.entry(user_id).or_insert(TokenBucket {
            tokens: self.burst,
            last_refill: now,
        });
        let elapsed = now
            .saturating_duration_since(entry.last_refill)
            .as_secs_f64();
        entry.tokens = (entry.tokens + elapsed * self.refill_per_second).min(self.burst);
        entry.last_refill = now;
        if entry.tokens >= 1.0 {
            entry.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// Attempt to consume one token for `user_id` at the current instant.
    fn try_acquire(&self, user_id: i64) -> bool {
        self.try_acquire_at(user_id, Instant::now())
    }

    /// Forget a sender's bucket once they disconnect.
    fn forget(&self, user_id: i64) {
        self.buckets.remove(&user_id);
    }
}

/// Validate that a raw datagram's length is exactly the header plus the
/// header-declared payload length. Malformed or oversized packets that fail
/// this check are dropped before any fan-out.
fn datagram_length_is_consistent(datagram_len: usize, header: &MediaHeader) -> bool {
    datagram_len == HEADER_SIZE + header.payload_length as usize
}

/// Transport abstraction for relay connections.
/// Raw QUIC is used for Tauri desktop and federation; channel-bridged
/// connections are used for WebTransport browser clients.
enum MediaTransport {
    /// Raw QUIC (Tauri desktop, federation).
    Quic(quinn::Connection),
    /// Channel-bridged (WebTransport browser clients).
    /// The bridge task translates between HTTP/3 datagrams (with QSID
    /// framing) and raw media packets. Keyframe uni streams, by contrast, are
    /// forwarded byte-for-byte over `control_conn` (the WebTransport connection,
    /// which under h3-quinn is a plain uni-capable quinn connection).
    Bridged {
        outbound_tx: mpsc::Sender<Bytes>,
        inbound_rx: Arc<Mutex<mpsc::Receiver<Bytes>>>,
        control_conn: Option<quinn::Connection>,
        /// In-flight keyframe uni-stream tasks toward this viewer, keyed by SSRC
        /// (i.e. per track+layer), each queue oldest-first and bounded at
        /// [`MAX_BRIDGED_KEYFRAME_STREAMS`]. Keying per SSRC (not per connection)
        /// keeps the stale-stream cull WITHIN a track: a fresh keyframe on one
        /// track never aborts an undrained, non-superseded keyframe of a
        /// different track a viewer is watching simultaneously.
        keyframe_streams: Arc<Mutex<HashMap<u32, VecDeque<AbortHandle>>>>,
    },
}

impl Clone for MediaTransport {
    fn clone(&self) -> Self {
        match self {
            Self::Quic(conn) => Self::Quic(conn.clone()),
            Self::Bridged {
                outbound_tx,
                inbound_rx,
                control_conn,
                keyframe_streams,
            } => Self::Bridged {
                outbound_tx: outbound_tx.clone(),
                inbound_rx: Arc::clone(inbound_rx),
                control_conn: control_conn.clone(),
                keyframe_streams: Arc::clone(keyframe_streams),
            },
        }
    }
}

/// Handle to a connected participant's QUIC connection for datagram forwarding.
#[derive(Clone)]
pub struct ConnectionHandle {
    pub user_id: i64,
    pub room_id: String,
    transport: MediaTransport,
}

impl ConnectionHandle {
    /// Create a handle wrapping a raw QUIC connection.
    pub fn new(user_id: i64, room_id: String, conn: quinn::Connection) -> Self {
        Self {
            user_id,
            room_id,
            transport: MediaTransport::Quic(conn),
        }
    }

    /// Create a handle wrapping a channel-bridged WebTransport connection.
    pub fn new_bridged(
        user_id: i64,
        room_id: String,
        outbound_tx: mpsc::Sender<Bytes>,
        inbound_rx: mpsc::Receiver<Bytes>,
        control_conn: Option<quinn::Connection>,
    ) -> Self {
        Self {
            user_id,
            room_id,
            transport: MediaTransport::Bridged {
                outbound_tx,
                inbound_rx: Arc::new(Mutex::new(inbound_rx)),
                control_conn,
                keyframe_streams: Arc::new(Mutex::new(HashMap::new())),
            },
        }
    }

    /// Send a datagram to this connection.
    pub fn send_datagram(&self, data: Bytes) -> Result<(), quinn::SendDatagramError> {
        match &self.transport {
            MediaTransport::Quic(conn) => conn.send_datagram(data),
            // Bounded, unreliable: an over-full bridge drops the datagram (as
            // quinn does when its own datagram buffer overflows) rather than
            // blocking the fan-out hot path; only a closed channel is fatal.
            MediaTransport::Bridged { outbound_tx, .. } => match outbound_tx.try_send(data) {
                Ok(()) => Ok(()),
                Err(mpsc::error::TrySendError::Full(_)) => Ok(()),
                Err(mpsc::error::TrySendError::Closed(_)) => Err(
                    quinn::SendDatagramError::ConnectionLost(quinn::ConnectionError::LocallyClosed),
                ),
            },
        }
    }

    /// Read a datagram from this connection.
    pub async fn read_datagram(&self) -> Result<Bytes, quinn::ConnectionError> {
        match &self.transport {
            MediaTransport::Quic(conn) => conn.read_datagram().await,
            MediaTransport::Bridged { inbound_rx, .. } => {
                let mut rx = inbound_rx.lock().await;
                rx.recv().await.ok_or(quinn::ConnectionError::LocallyClosed)
            }
        }
    }

    /// Check if the connection is still alive.
    pub fn is_alive(&self) -> bool {
        match &self.transport {
            MediaTransport::Quic(conn) => conn.close_reason().is_none(),
            MediaTransport::Bridged { outbound_tx, .. } => !outbound_tx.is_closed(),
        }
    }

    /// Best-effort transport close reason for diagnostics.
    pub fn close_reason(&self) -> Option<String> {
        match &self.transport {
            MediaTransport::Quic(conn) => conn.close_reason().map(|reason| reason.to_string()),
            MediaTransport::Bridged {
                outbound_tx,
                control_conn,
                ..
            } => control_conn
                .as_ref()
                .and_then(|conn| conn.close_reason().map(|reason| reason.to_string()))
                .or_else(|| {
                    if outbound_tx.is_closed() {
                        Some("WebTransport bridge channel closed".to_string())
                    } else {
                        None
                    }
                }),
        }
    }

    /// Forcibly tear down the underlying transport.
    ///
    /// Used to evict a participant mid-call (e.g. after a kick/ban). Closing the
    /// QUIC connection makes the participant's forwarding-task `read_datagram`
    /// return an error so the task stops reading (and injecting) media; for a
    /// bridged WebTransport client the control connection is closed, which tears
    /// down the session. Best-effort and idempotent.
    pub fn close(&self, reason: &str) {
        match &self.transport {
            MediaTransport::Quic(conn) => {
                conn.close(quinn::VarInt::from_u32(1), reason.as_bytes());
            }
            MediaTransport::Bridged { control_conn, .. } => {
                // Closing the control connection tears down the bridged
                // WebTransport session; the bridge task then observes closure
                // and stops forwarding on the outbound channel.
                if let Some(conn) = control_conn {
                    conn.close(quinn::VarInt::from_u32(1), reason.as_bytes());
                }
            }
        }
    }

    /// QUIC connection used for transport statistics (raw or bridged control path).
    pub fn quinn_connection(&self) -> Option<&quinn::Connection> {
        match &self.transport {
            MediaTransport::Quic(conn) => Some(conn),
            MediaTransport::Bridged { control_conn, .. } => control_conn.as_ref(),
        }
    }

    /// Accept a bidirectional control stream from the remote peer.
    pub async fn accept_bi(&self) -> Result<(quinn::SendStream, quinn::RecvStream), String> {
        match &self.transport {
            MediaTransport::Quic(conn) => conn.accept_bi().await.map_err(|e| e.to_string()),
            MediaTransport::Bridged { control_conn, .. } => control_conn
                .as_ref()
                .ok_or_else(|| "bridged transport is missing a control connection".to_string())?
                .accept_bi()
                .await
                .map_err(|e| e.to_string()),
        }
    }

    /// Whether this connection carries the loss-resilient uni-stream keyframe
    /// path. Raw QUIC connections always do; a bridged WebTransport connection
    /// does whenever it has a control connection — under h3-quinn that connection
    /// is a plain uni-capable quinn connection, so keyframe uni streams bridge
    /// byte-for-byte in both directions (contract S5).
    pub fn supports_media_uni_streams(&self) -> bool {
        match &self.transport {
            MediaTransport::Quic(_) => true,
            MediaTransport::Bridged { control_conn, .. } => control_conn.is_some(),
        }
    }

    /// Accept the next incoming unidirectional stream (one whole keyframe).
    ///
    /// For a bridged viewer this accepts a WebTransport uni stream the browser
    /// opened; the relay then reads it to FIN and fans the identical bytes out
    /// exactly as it does a native QUIC uni stream (browser→relay direction).
    pub async fn accept_uni(&self) -> Result<quinn::RecvStream, String> {
        match &self.transport {
            MediaTransport::Quic(conn) => conn.accept_uni().await.map_err(|e| e.to_string()),
            MediaTransport::Bridged { control_conn, .. } => control_conn
                .as_ref()
                .ok_or_else(|| "bridged transport is missing a control connection".to_string())?
                .accept_uni()
                .await
                .map_err(|e| e.to_string()),
        }
    }

    /// Forward one whole (already-encrypted) frame to this connection on a fresh
    /// unidirectional stream. The stream's FIN delimits the single message.
    ///
    /// The raw-QUIC path opens, writes, and finishes inline. The bridged path
    /// spawns the open+write+finish as a task and tracks it — keyed by `ssrc`
    /// (track+layer) — so a newer keyframe of the SAME track can abort the OLDEST
    /// in-flight stream once more than [`MAX_BRIDGED_KEYFRAME_STREAMS`] are
    /// outstanding for that ssrc, bounding egress backlog toward a slow browser
    /// downlink (the egress mirror of stale-stream culling) without one track's
    /// keyframe evicting another track's still-undrained keyframe. It therefore
    /// returns as soon as the stream is enqueued, not once delivered.
    pub async fn send_stream_frame(&self, ssrc: u32, msg: Bytes) -> Result<(), String> {
        match &self.transport {
            MediaTransport::Quic(conn) => {
                let mut send = conn.open_uni().await.map_err(|e| e.to_string())?;
                send.write_all(&msg).await.map_err(|e| e.to_string())?;
                send.finish().map_err(|e| e.to_string())?;
                Ok(())
            }
            MediaTransport::Bridged {
                control_conn,
                keyframe_streams,
                ..
            } => {
                let conn = control_conn
                    .as_ref()
                    .ok_or_else(|| "bridged transport is missing a control connection".to_string())?
                    .clone();
                let task = tokio::spawn(async move {
                    if let Ok(mut send) = conn.open_uni().await {
                        if send.write_all(&msg).await.is_ok() {
                            let _ = send.finish();
                            // Keep the task (and its SendStream) alive until the peer
                            // drains the stream, so a slow bridged downlink counts this
                            // keyframe as in-flight and a newer keyframe can abort the
                            // oldest still-undrained one (egress stale-stream culling).
                            let _ = send.stopped().await;
                        }
                    }
                });
                let mut streams = keyframe_streams.lock().await;
                let queue = streams.entry(ssrc).or_default();
                enqueue_inflight_stream(queue, task.abort_handle(), MAX_BRIDGED_KEYFRAME_STREAMS);
                Ok(())
            }
        }
    }

    /// Send a single control message on a fresh bidirectional stream.
    pub async fn send_control(&self, message: &ControlMessage) -> Result<(), String> {
        match &self.transport {
            MediaTransport::Quic(conn) => {
                let (mut send, _recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
                let encoded = message.encode().map_err(|e| e.to_string())?;
                send.write_all(&encoded).await.map_err(|e| e.to_string())?;
                send.finish().map_err(|e| e.to_string())?;
                Ok(())
            }
            MediaTransport::Bridged { control_conn, .. } => {
                let conn = control_conn.as_ref().ok_or_else(|| {
                    "bridged transport is missing a control connection".to_string()
                })?;
                let (mut send, _recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
                let encoded = message.encode().map_err(|e| e.to_string())?;
                send.write_all(&encoded).await.map_err(|e| e.to_string())?;
                send.finish().map_err(|e| e.to_string())?;
                Ok(())
            }
        }
    }
}

/// The relay forwarder manages connections and forwards media packets between
/// participants in the same room based on their subscriptions.
///
/// It never inspects or decrypts the encrypted payload -- it only reads the
/// cleartext 16-byte MediaHeader to determine routing and audio level.
pub struct RelayForwarder {
    /// Map of user_id -> ConnectionHandle for active connections.
    connections: DashMap<i64, ConnectionHandle>,
    /// Room manager for subscription lookups.
    room_manager: Arc<MediaRoomManager>,
    /// Currently announced active media sessions keyed by user id.
    active_sessions: DashMap<i64, ActiveSessionInfo>,
    /// Speaker detector for audio level tracking.
    speaker_detector: Arc<SpeakerDetector>,
    /// Per-sender packet-rate limiter guarding the forwarding hot path.
    sender_rate_limiter: SenderRateLimiter,
    /// Per-sender control-message rate limiter. The datagram bucket above does
    /// not cover the control channel, which is where the state-mutating and
    /// fan-out-amplifying messages live.
    control_rate_limiter: SenderRateLimiter,
    /// Publisher-ingress bandwidth estimates driving uplink adaptation feedback.
    bandwidth_estimator: BandwidthEstimator,
    /// Per-viewer downlink (relay→viewer egress) estimates driving simulcast
    /// layer selection (spec §4.2).
    downlink_estimator: DownlinkEstimator,
    /// Per-`(viewer, stream, track)` relay-driven layer selection state,
    /// including any keyframe-gated pending switch (spec §4.2).
    layer_selection: DashMap<(i64, StreamId, TrackId), LayerSelectionState>,
    /// Precomputed per-`(sender_id, ssrc)` fan-out plans for the hot path.
    recipient_cache: DashMap<(i64, u32), Arc<CachedRecipients>>,
    /// Generation bumped whenever the connection set changes, invalidating
    /// every cached recipient snapshot (which holds connection handles).
    conn_generation: AtomicU64,
    /// Last time a keyframe request was forwarded upstream, keyed by
    /// `(publisher_user_id, stream, track)` so entries can be pruned when the
    /// publisher disconnects (an abrupt drop never sends `TrackUnpublish`).
    keyframe_throttle: DashMap<(i64, StreamId, TrackId), Instant>,
    /// Viewers already flagged for the unreachable "keyframe recipient has no
    /// uni-stream path" bridge state, keyed by `(viewer_user_id, ssrc)` so the
    /// error-level diagnostic fires once per viewer/stream instead of on every
    /// keyframe. With bridge parity live this should never populate; it exists
    /// solely to make a genuine defect loud without flooding the log.
    keyframe_bridge_skip_warned: DashMap<(i64, u32), ()>,
    /// Notify signal for shutdown.
    shutdown: Notify,
}

#[derive(Clone, Debug)]
struct ActiveSessionInfo {
    room_id: String,
    session_id: String,
    video_capabilities: Vec<VideoCodecCapability>,
}

/// Relay-driven per-viewer, per-track simulcast layer selection state (spec §4.2).
///
/// `current_layer` is the layer the relay is actively forwarding to this viewer;
/// it mirrors the subscription's `active_layer` and gates both datagram deltas
/// and uni-stream keyframes. A switch is staged in `pending_layer` and does not
/// take effect until that layer's next keyframe arrives, at which point the relay
/// forwards the old layer's frames up to the boundary and then atomically flips
/// `current_layer` (see [`RelayForwarder::commit_pending_switches`]). This keeps a
/// switch from starting a viewer mid-GOP on an undecodable delta.
#[derive(Clone, Copy, Debug)]
struct LayerSelectionState {
    /// Layer currently forwarded to this viewer.
    current_layer: u8,
    /// Target layer a switch is staged toward; forwarding stays on
    /// `current_layer` until this layer's keyframe arrives.
    pending_layer: Option<u8>,
    /// Instant the ≥125% upswitch headroom first held continuously (reset on any
    /// dip), gating the 5s upswitch hold.
    headroom_since: Option<Instant>,
}

impl LayerSelectionState {
    fn new(current_layer: u8) -> Self {
        Self {
            current_layer,
            pending_layer: None,
            headroom_since: None,
        }
    }
}

impl RelayForwarder {
    pub fn new(
        room_manager: Arc<MediaRoomManager>,
        speaker_detector: Arc<SpeakerDetector>,
    ) -> Self {
        Self {
            connections: DashMap::new(),
            room_manager,
            active_sessions: DashMap::new(),
            speaker_detector,
            sender_rate_limiter: SenderRateLimiter::new(
                MAX_SENDER_PACKETS_PER_SECOND,
                SENDER_RATE_BURST_PACKETS,
            ),
            control_rate_limiter: SenderRateLimiter::new(
                MAX_CONTROL_MESSAGES_PER_SECOND,
                CONTROL_RATE_BURST_MESSAGES,
            ),
            bandwidth_estimator: BandwidthEstimator::new(),
            downlink_estimator: DownlinkEstimator::new(),
            layer_selection: DashMap::new(),
            recipient_cache: DashMap::new(),
            conn_generation: AtomicU64::new(0),
            keyframe_throttle: DashMap::new(),
            keyframe_bridge_skip_warned: DashMap::new(),
            shutdown: Notify::new(),
        }
    }

    /// Register a new participant connection for relay forwarding.
    pub fn add_connection(&self, handle: ConnectionHandle) {
        let user_id = handle.user_id;
        let room_id = handle.room_id.clone();
        info!(user_id, room_id = %room_id, "relay: participant connected");
        self.connections.insert(user_id, handle);
        self.invalidate_connection_cache();
    }

    /// Remove a participant's connection.
    pub fn remove_connection(&self, user_id: i64) {
        if self.connections.remove(&user_id).is_some() {
            info!(user_id, "relay: participant disconnected");
        }
        self.forget_sender_cache(user_id);
        self.forget_keyframe_state(user_id);
        self.sender_rate_limiter.forget(user_id);
        self.control_rate_limiter.forget(user_id);
        self.invalidate_connection_cache();
    }

    /// Bump the connection generation so every cached recipient snapshot
    /// (which holds now-stale connection handles) is rebuilt on next use.
    fn invalidate_connection_cache(&self) {
        self.conn_generation.fetch_add(1, Ordering::Release);
    }

    /// Drop cached fan-out plans keyed by a departed sender to bound cache size.
    fn forget_sender_cache(&self, user_id: i64) {
        self.recipient_cache
            .retain(|(sender, _), _| *sender != user_id);
    }

    /// Drop keyframe throttle + bridge-skip-warning state tied to a departed user
    /// (as publisher and as viewer respectively) so neither map grows unbounded
    /// across churning streams, mirroring `forget_sender_cache`.
    fn forget_keyframe_state(&self, user_id: i64) {
        self.keyframe_throttle
            .retain(|(publisher, _, _), _| *publisher != user_id);
        self.keyframe_bridge_skip_warned
            .retain(|(viewer, _), _| *viewer != user_id);
        // Layer-selection state is keyed by viewer; drop this user's entries so
        // the map never grows unbounded across churning subscriptions.
        self.layer_selection
            .retain(|(viewer, _, _), _| *viewer != user_id);
    }

    /// Forcibly evict a participant's live media connection.
    ///
    /// Invoked from moderation paths (kick/ban/leave). Removing the connection
    /// from the fan-out map immediately stops the user from *receiving* any
    /// other participant's media, closing the transport stops their forwarding
    /// task so they can no longer *inject* media, and the per-sender relay state
    /// is cleared. Safe to call for a user with no live connection (no-op).
    pub fn disconnect_user(&self, user_id: i64) {
        if let Some((_, handle)) = self.connections.remove(&user_id) {
            handle.close("evicted");
            info!(user_id, "relay: participant force-disconnected");
        }
        self.active_sessions.remove(&user_id);
        self.sender_rate_limiter.forget(user_id);
        self.bandwidth_estimator.remove_user(user_id);
        self.downlink_estimator.remove_user(user_id);
        self.forget_sender_cache(user_id);
        self.forget_keyframe_state(user_id);
        self.invalidate_connection_cache();
    }

    /// Spawn the forwarding loop for a single participant.
    /// This task reads datagrams from the participant and forwards them
    /// to all subscribed recipients.
    pub fn spawn_forwarding_task(self: &Arc<Self>, handle: ConnectionHandle) {
        let forwarder = Arc::clone(self);
        let user_id = handle.user_id;
        let room_id = handle.room_id.clone();

        forwarder.spawn_bandwidth_task(handle.clone());
        forwarder.spawn_uni_stream_task(handle.clone());

        tokio::spawn(async move {
            info!(user_id, room_id = %room_id, "relay: forwarding task started");

            let mut disconnect_reason: Option<String> = None;

            loop {
                let datagram = tokio::select! {
                    result = handle.read_datagram() => {
                        match result {
                            Ok(data) => data,
                            Err(e) => {
                                let reason = handle.close_reason();
                                debug!(
                                    user_id,
                                    error = %e,
                                    close_reason = reason.as_deref(),
                                    "relay: connection closed"
                                );
                                disconnect_reason =
                                    Some(reason.unwrap_or_else(|| e.to_string()));
                                break;
                            }
                        }
                    }
                    _ = forwarder.shutdown.notified() => {
                        debug!(user_id, "relay: shutdown signal received");
                        break;
                    }
                };

                if datagram.len() < HEADER_SIZE {
                    warn!(
                        user_id,
                        len = datagram.len(),
                        "relay: datagram too short, dropping"
                    );
                    continue;
                }

                // Parse the header (read-only, we never modify it)
                let header = match MediaHeader::decode(&mut &datagram[..HEADER_SIZE]) {
                    Ok(h) => h,
                    Err(e) => {
                        warn!(user_id, error = %e, "relay: invalid header, dropping");
                        continue;
                    }
                };

                // Drop packets whose wire length disagrees with the header-declared
                // payload length before any further processing or fan-out.
                if !datagram_length_is_consistent(datagram.len(), &header) {
                    warn!(
                        user_id,
                        len = datagram.len(),
                        payload_length = header.payload_length,
                        "relay: datagram length inconsistent with header, dropping"
                    );
                    continue;
                }

                // Throttle abusive senders before amplifying the packet to every
                // subscriber. Excess packets are dropped, not queued.
                if !forwarder.sender_rate_limiter.try_acquire(user_id) {
                    debug!(
                        user_id,
                        "relay: sender rate limit exceeded, dropping datagram"
                    );
                    continue;
                }

                // Feed publisher-ingress goodput + per-SSRC loss to the uplink
                // bandwidth estimator (all accepted track types count).
                forwarder.bandwidth_estimator.record_ingress(
                    user_id,
                    header.ssrc,
                    header.sequence,
                    datagram.len() as u32,
                );

                // Speaker detection is audio-only: video floods the level
                // window at thousands of packets per second and would skew it.
                if matches!(
                    header.track_type,
                    paracord_transport::protocol::TrackType::Audio
                ) {
                    forwarder.speaker_detector.report_audio_level(
                        user_id,
                        &room_id,
                        header.audio_level,
                    );
                }

                // Look up the sender's room and find subscribers
                forwarder.forward_to_subscribers(user_id, &room_id, &header, &datagram);
            }

            // Clean up on disconnect
            let had_active_session = forwarder.active_sessions.remove(&user_id).is_some();
            forwarder.sender_rate_limiter.forget(user_id);
            forwarder.bandwidth_estimator.remove_user(user_id);
            forwarder.downlink_estimator.remove_user(user_id);
            forwarder.remove_connection(user_id);
            if had_active_session {
                forwarder
                    .broadcast_control_in_room(
                        &room_id,
                        Some(user_id),
                        &ControlMessage::SessionParticipantLeave { user_id },
                    )
                    .await;
            }
            info!(
                user_id,
                room_id = %room_id,
                disconnect_reason = disconnect_reason.as_deref(),
                "relay: forwarding task ended"
            );
        });
    }

    /// Periodically derive an uplink `BandwidthFeedback` from measured
    /// publisher ingress (goodput + per-SSRC loss) and emit it to the
    /// participant. Runs on its own task so the datagram fan-out loop is never
    /// blocked or delayed by estimation.
    fn spawn_bandwidth_task(self: &Arc<Self>, handle: ConnectionHandle) {
        let forwarder = Arc::clone(self);
        let user_id = handle.user_id;
        let room_id = handle.room_id.clone();

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(BANDWIDTH_SAMPLE_INTERVAL);
            interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            let mut last_sent_kbps = 0u32;
            let mut last_feedback_at = Instant::now();

            loop {
                tokio::select! {
                    _ = interval.tick() => {}
                    _ = forwarder.shutdown.notified() => break,
                }

                if !handle.is_alive() {
                    break;
                }

                // Sample the relay→viewer downlink (cwnd/RTT BDP + windowed loss)
                // and re-evaluate this viewer's simulcast layer selection (spec
                // §4.2). Bridged viewers sample their WebTransport control
                // connection, so the selection is identical for both transports.
                if let Some(conn) = handle.quinn_connection() {
                    forwarder
                        .downlink_estimator
                        .record_from_connection(user_id, conn);
                }
                forwarder.run_layer_selection(user_id, &room_id).await;

                // Uplink feedback derives from measured publisher ingress at the
                // relay (goodput + per-SSRC loss), not the relay's send-side
                // window toward this connection.
                let available_kbps = forwarder.bandwidth_estimator.compute_feedback(user_id);

                let materially_changed = last_sent_kbps == 0 || {
                    let delta = available_kbps.abs_diff(last_sent_kbps) as f64;
                    let baseline = last_sent_kbps.max(1) as f64;
                    delta / baseline >= BANDWIDTH_FEEDBACK_CHANGE_RATIO
                };
                let stale = last_feedback_at.elapsed() >= BANDWIDTH_FEEDBACK_MAX_INTERVAL;

                if materially_changed || stale {
                    forwarder
                        .send_control_to_user(
                            user_id,
                            &ControlMessage::BandwidthFeedback { available_kbps },
                        )
                        .await;
                    last_sent_kbps = available_kbps;
                    last_feedback_at = Instant::now();
                }
            }

            forwarder.bandwidth_estimator.remove_user(user_id);
            forwarder.downlink_estimator.remove_user(user_id);
        });
    }

    /// Spawn the unidirectional-stream forwarding loop for a single participant.
    ///
    /// Keyframes (and any frame too large to survive datagram fragmentation)
    /// arrive on their own QUIC unidirectional streams — reliable and ordered —
    /// instead of fire-and-forget datagrams. This task accepts each such stream,
    /// routes it on its cleartext [`MediaHeader`] exactly as the datagram hot path
    /// does (SPEAK gate + subscription filtering + recipient snapshot), and
    /// re-emits the identical still-encrypted bytes to every subscriber on a fresh
    /// uni stream. The relay never decrypts the payload.
    ///
    /// Both raw QUIC and bridged WebTransport connections carry this path: a
    /// bridged publisher's browser opens WebTransport uni streams that arrive here
    /// as plain quinn uni streams (contract S5). It is a no-op only for a bridged
    /// handle with no control connection (which cannot exist in production).
    fn spawn_uni_stream_task(self: &Arc<Self>, handle: ConnectionHandle) {
        if !handle.supports_media_uni_streams() {
            return;
        }
        let forwarder = Arc::clone(self);
        let user_id = handle.user_id;
        let room_id = handle.room_id.clone();

        tokio::spawn(async move {
            debug!(user_id, room_id = %room_id, "relay: uni-stream task started");
            // Bound how much this one publisher can have buffered in flight.
            // `read_to_end(MAX_STREAM_FRAME_SIZE)` caps a *single* stream at
            // 16 MiB, but a connection may open hundreds of concurrent uni
            // streams and the keyframe path is deliberately exempt from the
            // datagram rate limiter — so without this the ceiling was
            // 16 MiB x the peer's concurrent-uni-stream limit per connection.
            // The permit is held for the whole read+forward, so a peer that
            // opens more concurrent streams simply waits.
            let inflight = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_UNI_STREAM_READS));
            loop {
                let mut recv = tokio::select! {
                    result = handle.accept_uni() => match result {
                        Ok(recv) => recv,
                        Err(err) => {
                            debug!(user_id, error = %err, "relay: uni-stream task stopping");
                            break;
                        }
                    },
                    _ = forwarder.shutdown.notified() => break,
                };

                let Ok(permit) = Arc::clone(&inflight).acquire_owned().await else {
                    break;
                };

                // One whole frame per stream, read to FIN with a hard size cap.
                // Read + forward on a per-stream task so a large or slow keyframe
                // never blocks accepting the next (newer) one — a viewer can then
                // cull the stale one it is still draining.
                let task_forwarder = Arc::clone(&forwarder);
                let task_room_id = room_id.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let body = match recv.read_to_end(MAX_STREAM_FRAME_SIZE).await {
                        Ok(body) => body,
                        Err(err) => {
                            debug!(user_id, error = %err, "relay: keyframe uni-stream read failed");
                            return;
                        }
                    };
                    if body.len() < HEADER_SIZE {
                        return;
                    }
                    let header = match MediaHeader::decode(&mut &body[..HEADER_SIZE]) {
                        Ok(header) => header,
                        Err(err) => {
                            debug!(user_id, error = %err, "relay: invalid keyframe uni-stream header");
                            return;
                        }
                    };
                    task_forwarder
                        .forward_stream_frame_to_subscribers(user_id, &task_room_id, &header, body)
                        .await;
                });
            }
        });
    }

    /// Forward one whole (already-encrypted) frame received on a uni stream to
    /// every subscriber, on a fresh uni stream each, without decrypting it.
    ///
    /// Reuses the exact recipient snapshot (SPEAK gate + subscription filter +
    /// self/deafen rules) the datagram fan-out uses, so a stream keyframe reaches
    /// precisely the viewers a delta datagram for the same SSRC would.
    async fn forward_stream_frame_to_subscribers(
        &self,
        sender_id: i64,
        room_id: &str,
        header: &MediaHeader,
        body: Vec<u8>,
    ) {
        // Keyframe bytes no longer ride datagrams, so feed them to the publisher
        // ingress estimator here to keep uplink bandwidth feedback accurate.
        // Keyframes are infrequent and naturally bounded by the connection's
        // concurrent-uni-stream limit, so they are deliberately not run through
        // the per-packet datagram rate limiter (which would risk dropping the
        // very keyframe this path exists to deliver reliably). The keyframe-aware
        // path counts the bytes for goodput but keeps the reliably-delivered (and
        // usually late-recorded) keyframe from biasing the per-SSRC loss estimate.
        self.bandwidth_estimator.record_ingress_keyframe(
            sender_id,
            header.ssrc,
            header.sequence,
            body.len() as u32,
        );

        // Keyframe-boundary layer switching (spec §4.2): a uni-stream keyframe is
        // the switch point for any viewer whose pending target is this frame's
        // layer. Commit those viewers BEFORE the recipient snapshot so the
        // (generation-invalidated) snapshot rebuilds to include them — this
        // keyframe then reaches them as the first frame of their new layer.
        if body.len() > HEADER_SIZE {
            if let Ok(metadata) = VideoFrameMetadata::decode(&mut &body[HEADER_SIZE..]) {
                if metadata.is_keyframe {
                    self.commit_pending_switches(
                        room_id,
                        &metadata.stream_id,
                        &metadata.track_id,
                        metadata.layer_id,
                    );
                }
            }
        }

        let snapshot = self.recipient_snapshot(sender_id, room_id, header);
        if snapshot.recipients.is_empty() {
            return;
        }

        let msg = Bytes::from(body);
        for recipient in &snapshot.recipients {
            if !recipient.supports_media_uni_streams() {
                // Both raw-QUIC and bridged WebTransport viewers now carry the
                // keyframe uni-stream path, so reaching here means a recipient with
                // no uni-stream transport survived the fan-out — an unreachable
                // bridge state (a bridged handle with no control connection). It is
                // a defect, not an expected downgrade, so log it loudly at error
                // level (once per viewer/SSRC) instead of silently skipping.
                if self
                    .keyframe_bridge_skip_warned
                    .insert((recipient.user_id, header.ssrc), ())
                    .is_none()
                {
                    error!(
                        sender = sender_id,
                        recipient = recipient.user_id,
                        room_id = %room_id,
                        ssrc = header.ssrc,
                        "relay: unreachable bridge state — keyframe recipient has no \
                         media uni-stream path (bridged handle without a control \
                         connection); its video cannot receive keyframes"
                    );
                }
                continue;
            }
            let recipient = recipient.clone();
            let msg = msg.clone();
            let ssrc = header.ssrc;
            tokio::spawn(async move {
                if let Err(err) = recipient.send_stream_frame(ssrc, msg).await {
                    debug!(
                        recipient = recipient.user_id,
                        error = %err,
                        "relay: failed to forward keyframe uni stream"
                    );
                }
            });
        }
    }

    /// Spawn the control-stream loop for a single participant.
    pub fn spawn_control_task(self: &Arc<Self>, handle: ConnectionHandle) {
        let forwarder = Arc::clone(self);
        let user_id = handle.user_id;
        let room_id = handle.room_id.clone();

        tokio::spawn(async move {
            info!(user_id, room_id = %room_id, "relay: control task started");

            let mut disconnect_reason: Option<String> = None;

            loop {
                let (_send, mut recv) = tokio::select! {
                    result = handle.accept_bi() => {
                        match result {
                            Ok(streams) => streams,
                            Err(err) => {
                                let reason = handle.close_reason();
                                debug!(
                                    user_id,
                                    error = %err,
                                    close_reason = reason.as_deref(),
                                    "relay: control task stopping"
                                );
                                disconnect_reason =
                                    Some(reason.unwrap_or_else(|| err.to_string()));
                                break;
                            }
                        }
                    }
                    _ = forwarder.shutdown.notified() => {
                        debug!(user_id, "relay: control shutdown signal received");
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

                // Throttle the control channel before parsing or acting on the
                // message. `ReceiverReport`/`SubscribeStream` mutate room state
                // and invalidate routing caches; `StreamKeyAnnounce` fans out to
                // named recipients. None of that was rate limited — the token
                // bucket on the datagram path covers media only.
                if !forwarder.control_rate_limiter.try_acquire(user_id) {
                    debug!(
                        user_id,
                        room_id = %room_id,
                        "relay: control message rate limit exceeded, dropping"
                    );
                    continue;
                }

                let message = match serde_json::from_slice::<ControlMessage>(&msg_buf) {
                    Ok(message) => message,
                    Err(err) => {
                        debug!(user_id, error = %err, "relay: discarding malformed control message");
                        continue;
                    }
                };

                forwarder
                    .handle_control_message(user_id, &room_id, message)
                    .await;
            }

            info!(
                user_id,
                room_id = %room_id,
                disconnect_reason = disconnect_reason.as_deref(),
                "relay: control task ended"
            );
        });
    }

    /// Forward a complete packet (header + encrypted payload) to all subscribers.
    ///
    /// Hot path: resolve the precomputed `(sender_id, ssrc)` fan-out plan from
    /// the recipient cache (a single concurrent-map read, rebuilt only when the
    /// room or connection generation changes) and issue one `send_datagram` per
    /// recipient. It never clones the room per datagram.
    fn forward_to_subscribers(
        &self,
        sender_id: i64,
        room_id: &str,
        header: &MediaHeader,
        packet: &Bytes,
    ) {
        let snapshot = self.recipient_snapshot(sender_id, room_id, header);

        for recipient in &snapshot.recipients {
            if let Err(e) = recipient.send_datagram(packet.clone()) {
                debug!(
                    sender = sender_id,
                    recipient = recipient.user_id,
                    error = %e,
                    "relay: failed to forward datagram"
                );
            }
        }

        if matches!(
            header.track_type,
            paracord_transport::protocol::TrackType::Video
        ) {
            let debug_index = RELAY_VIDEO_FORWARD_DEBUG_COUNT.fetch_add(1, Ordering::Relaxed);
            if debug_index < 48 {
                warn!(
                    sender = sender_id,
                    room_id = %room_id,
                    ssrc = header.ssrc,
                    seq = header.sequence,
                    layer = header.simulcast_layer,
                    epoch = header.key_epoch,
                    has_track = snapshot.published_track.is_some(),
                    recipients = snapshot.recipients.len(),
                    "relay-video-debug: routed video datagram"
                );
            }
        }
    }

    /// Resolve (from cache, or rebuild) the fan-out plan for `(sender_id, ssrc)`.
    fn recipient_snapshot(
        &self,
        sender_id: i64,
        room_id: &str,
        header: &MediaHeader,
    ) -> Arc<CachedRecipients> {
        // Per-room, not server-wide: one peer spamming ReceiverReport must not
        // invalidate the fan-out plan for every sender in every other call.
        let room_generation = self.room_manager.generation(room_id);
        let conn_generation = self.conn_generation.load(Ordering::Acquire);
        let key = (sender_id, header.ssrc);

        if let Some(entry) = self.recipient_cache.get(&key) {
            if entry.room_generation == room_generation && entry.conn_generation == conn_generation
            {
                return Arc::clone(entry.value());
            }
        }

        let snapshot = Arc::new(self.build_recipient_snapshot(
            sender_id,
            room_id,
            header,
            room_generation,
            conn_generation,
        ));
        self.recipient_cache.insert(key, Arc::clone(&snapshot));
        snapshot
    }

    /// Build a fresh fan-out plan for `(sender_id, ssrc)` from current room and
    /// connection state. This is the cold path, run only on a cache miss or
    /// after a generation change for this room.
    ///
    /// It reads the room in place (`with_room`) rather than taking
    /// `get_room`'s deep clone of every participant, published track,
    /// subscription and stored key ciphertext: a peer that can bump the routing
    /// generation from the control channel would otherwise turn every media
    /// packet into a whole-room clone.
    fn build_recipient_snapshot(
        &self,
        sender_id: i64,
        room_id: &str,
        header: &MediaHeader,
        room_generation: u64,
        conn_generation: u64,
    ) -> CachedRecipients {
        let empty = || CachedRecipients {
            room_generation,
            conn_generation,
            published_track: None,
            recipients: Vec::new(),
        };

        // The closure holds a read guard on the room map; it only touches
        // `self.connections` (a different map) and never awaits.
        let built = self.room_manager.with_room(room_id, |room| {
            // SPEAK gate: a participant who joined without publish rights
            // (SPEAK denied) is a listen-only subscriber. Drop their media
            // before fan-out rather than trusting the client not to transmit —
            // this closes the raw audio path that
            // `MediaParticipant::publish_track` does not cover.
            if room
                .participants
                .get(&sender_id)
                .is_some_and(|p| !p.can_publish)
            {
                return empty();
            }

            let published_track = resolve_published_track_for_ssrc(room, sender_id, header.ssrc);
            let recipients = room
                .participants
                .values()
                .filter(|participant| {
                    should_relay_packet_to(participant, sender_id, header, published_track.as_ref())
                })
                .filter_map(|participant| {
                    self.connections
                        .get(&participant.user_id)
                        .map(|entry| entry.clone())
                })
                .collect();

            CachedRecipients {
                room_generation,
                conn_generation,
                published_track,
                recipients,
            }
        });

        built.unwrap_or_else(empty)
    }

    /// Compute the set of recipients a packet from `sender_id` in `room_id`
    /// would be forwarded to, applying the same decision as the fan-out hot path
    /// without touching any connection. Used by routing tests to assert
    /// subscription, self-echo, deafen, and cross-room-isolation behaviour.
    #[cfg(test)]
    fn compute_forward_recipients(
        &self,
        sender_id: i64,
        room_id: &str,
        header: &MediaHeader,
    ) -> Vec<i64> {
        let Some(room) = self.room_manager.get_room(room_id) else {
            return Vec::new();
        };
        // Mirror the SPEAK gate applied by `forward_to_subscribers`: a sender
        // lacking publish rights transmits to no one.
        if room
            .participants
            .get(&sender_id)
            .is_some_and(|p| !p.can_publish)
        {
            return Vec::new();
        }
        let published_track = resolve_published_track_for_ssrc(&room, sender_id, header.ssrc);
        let mut recipients: Vec<i64> = room
            .participants
            .values()
            .filter(|participant| {
                should_relay_packet_to(participant, sender_id, header, published_track.as_ref())
            })
            .map(|participant| participant.user_id)
            .collect();
        recipients.sort_unstable();
        recipients
    }

    /// Signal shutdown to all forwarding tasks.
    pub fn shutdown(&self) {
        self.shutdown.notify_waiters();
    }

    /// Get the number of active connections.
    pub fn connection_count(&self) -> usize {
        self.connections.len()
    }

    async fn handle_control_message(&self, user_id: i64, room_id: &str, message: ControlMessage) {
        match message {
            ControlMessage::SessionJoin {
                room_id: requested_room_id,
                session_id,
                video_capabilities,
            } => {
                if requested_room_id != room_id {
                    warn!(
                        user_id,
                        room_id = %room_id,
                        requested_room_id = %requested_room_id,
                        "relay: ignoring mismatched session join room"
                    );
                    return;
                }
                self.active_sessions.insert(
                    user_id,
                    ActiveSessionInfo {
                        room_id: room_id.to_string(),
                        session_id: session_id.clone(),
                        video_capabilities: video_capabilities.clone(),
                    },
                );
                let _ = self.room_manager.update_participant_session_metadata(
                    room_id,
                    user_id,
                    session_id.clone(),
                    video_capabilities.clone(),
                );

                let participants = self
                    .active_sessions
                    .iter()
                    .filter_map(|entry| {
                        let active_session = entry.value();
                        if active_session.room_id == room_id {
                            Some(SessionParticipant {
                                user_id: *entry.key(),
                                session_id: active_session.session_id.clone(),
                                video_capabilities: active_session.video_capabilities.clone(),
                            })
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>();

                self.send_control_to_user(user_id, &ControlMessage::SessionState { participants })
                    .await;
                if let Some(handle) = self.connections.get(&user_id).map(|entry| entry.clone()) {
                    self.send_initial_track_state(&handle).await;
                }

                self.broadcast_control_in_room(
                    room_id,
                    Some(user_id),
                    &ControlMessage::SessionParticipantJoin {
                        participant: SessionParticipant {
                            user_id,
                            session_id,
                            video_capabilities,
                        },
                    },
                )
                .await;
            }
            ControlMessage::SessionLeave {
                room_id: requested_room_id,
                ..
            } => {
                let active_room_id = self
                    .active_sessions
                    .remove(&user_id)
                    .map(|(_, active_session)| active_session.room_id);
                let room_to_broadcast = active_room_id.as_deref().unwrap_or(room_id);
                if requested_room_id != room_to_broadcast {
                    debug!(
                        user_id,
                        room_id = %room_to_broadcast,
                        requested_room_id = %requested_room_id,
                        "relay: session leave room id differs from active room"
                    );
                }
                self.broadcast_control_in_room(
                    room_to_broadcast,
                    Some(user_id),
                    &ControlMessage::SessionParticipantLeave { user_id },
                )
                .await;
            }
            ControlMessage::TrackPublish { track } => {
                // `layers` arrives verbatim from the publisher and is
                // re-broadcast to every subscriber, each of which installs an
                // AES-GCM instance (and, for audio, an Opus decoder + jitter
                // buffer) per layer. Cap it at the relay so the announcement
                // cannot be used to amplify against the whole room.
                if track.layers.len() > MAX_TRACK_LAYERS {
                    warn!(
                        user_id,
                        room_id = %room_id,
                        layers = track.layers.len(),
                        "relay: rejecting track publish with an implausible layer count"
                    );
                    return;
                }
                if let Err(err) = self
                    .room_manager
                    .publish_track(room_id, user_id, track.clone())
                {
                    warn!(user_id, room_id = %room_id, error = %err, "relay: failed to publish track");
                    return;
                }
                self.broadcast_control_in_room(
                    room_id,
                    Some(user_id),
                    &ControlMessage::TrackPublish { track },
                )
                .await;
            }
            ControlMessage::TrackUnpublish {
                stream_id,
                track_id,
            } => {
                if let Err(err) = self
                    .room_manager
                    .unpublish_track(room_id, user_id, &stream_id, &track_id)
                {
                    warn!(user_id, room_id = %room_id, error = %err, "relay: failed to unpublish track");
                    return;
                }
                self.keyframe_throttle
                    .remove(&(user_id, stream_id.clone(), track_id.clone()));
                self.broadcast_control_in_room(
                    room_id,
                    Some(user_id),
                    &ControlMessage::TrackUnpublish {
                        stream_id,
                        track_id,
                    },
                )
                .await;
            }
            ControlMessage::TrackLayers {
                stream_id,
                track_id,
                layers,
            } => {
                // Same cap as TrackPublish: this replaces a track's layer list
                // and is re-broadcast to every subscriber.
                if layers.len() > MAX_TRACK_LAYERS {
                    warn!(
                        user_id,
                        room_id = %room_id,
                        layers = layers.len(),
                        "relay: rejecting track layer update with an implausible layer count"
                    );
                    return;
                }
                if let Some(mut track) =
                    self.resolve_published_track(room_id, user_id, &stream_id, &track_id)
                {
                    track.layers = layers.clone();
                    if let Err(err) = self.room_manager.publish_track(room_id, user_id, track) {
                        warn!(user_id, room_id = %room_id, error = %err, "relay: failed to refresh track layers");
                        return;
                    }
                }
                self.broadcast_control_in_room(
                    room_id,
                    Some(user_id),
                    &ControlMessage::TrackLayers {
                        stream_id,
                        track_id,
                        layers,
                    },
                )
                .await;
            }
            ControlMessage::SubscribeStream { subscription } => {
                if let Err(err) =
                    self.room_manager
                        .subscribe_track(room_id, user_id, subscription.clone())
                {
                    warn!(user_id, room_id = %room_id, error = %err, "relay: failed to register track subscription");
                    return;
                }
                let resolved_track = self.resolve_any_published_track(
                    room_id,
                    &subscription.stream_id,
                    &subscription.track_id,
                );
                self.send_control_to_user(
                    user_id,
                    &ControlMessage::SubscriptionAck {
                        stream_id: subscription.stream_id.clone(),
                        track_id: subscription.track_id.clone(),
                        layer_id: resolved_ack_layer(resolved_track.as_ref(), &subscription),
                        active: true,
                    },
                )
                .await;
                if let Some(track) = resolved_track {
                    if let Some((epoch, ciphertext)) = self.latest_track_key_delivery(
                        room_id,
                        &track,
                        &subscription.stream_id,
                        &subscription.track_id,
                        user_id,
                    ) {
                        self.send_control_to_user(
                            user_id,
                            &ControlMessage::StreamKeyDeliver {
                                stream_id: subscription.stream_id.clone(),
                                track_id: subscription.track_id.clone(),
                                sender_user_id: track.publisher_user_id,
                                epoch,
                                ciphertext,
                            },
                        )
                        .await;
                    } else {
                        self.send_control_to_user(
                            track.publisher_user_id,
                            &ControlMessage::RequestStreamKey {
                                stream_id: subscription.stream_id.clone(),
                                track_id: subscription.track_id.clone(),
                                recipient_user_id: user_id,
                            },
                        )
                        .await;
                    }
                    self.send_control_to_user(
                        track.publisher_user_id,
                        &ControlMessage::RequestKeyframe {
                            stream_id: subscription.stream_id,
                            track_id: subscription.track_id,
                            layer_id: subscription.requested_layer,
                        },
                    )
                    .await;
                }
            }
            ControlMessage::UnsubscribeStream {
                stream_id,
                track_id,
            } => {
                if let Err(err) = self
                    .room_manager
                    .unsubscribe_track(room_id, user_id, &stream_id, &track_id)
                {
                    warn!(user_id, room_id = %room_id, error = %err, "relay: failed to unregister track subscription");
                    return;
                }
                // Drop any relay-driven layer-selection state for this viewer/track.
                self.layer_selection
                    .remove(&(user_id, stream_id.clone(), track_id.clone()));
                self.send_control_to_user(
                    user_id,
                    &ControlMessage::SubscriptionAck {
                        stream_id,
                        track_id,
                        layer_id: None,
                        active: false,
                    },
                )
                .await;
            }
            ControlMessage::RequestKeyframe {
                stream_id,
                track_id,
                layer_id,
            } => {
                // Resolve the publisher first: with no live publisher there is
                // nothing to request and nothing to throttle (recording a throttle
                // entry here would orphan it — the track never sends TrackUnpublish).
                let Some(track) = self.resolve_any_published_track(room_id, &stream_id, &track_id)
                else {
                    return;
                };
                // Coalesce keyframe-request storms: a single lossy viewer can
                // otherwise pump the publisher for an IDR many times a second,
                // collapsing the shared stream's average bitrate for everyone.
                if !self.allow_keyframe_request(
                    track.publisher_user_id,
                    &stream_id,
                    &track_id,
                    Instant::now(),
                ) {
                    debug!(
                        user_id,
                        room_id = %room_id,
                        stream_id = %stream_id.0,
                        track_id = %track_id.0,
                        "relay: coalescing keyframe request (throttled)"
                    );
                    return;
                }
                self.send_control_to_user(
                    track.publisher_user_id,
                    &ControlMessage::RequestKeyframe {
                        stream_id,
                        track_id,
                        layer_id,
                    },
                )
                .await;
            }
            ControlMessage::ReceiverReport {
                stream_id,
                track_id,
                active_layer,
                viewport,
                estimated_bitrate_kbps,
                packet_loss_ppm,
            } => {
                // Layer selection is relay-driven from the relay's own per-viewer
                // downlink estimate (spec §4.2), so the viewer's reported active
                // layer is no longer applied to forwarding. The report still
                // carries the viewport hint (which re-caps the relay's selection)
                // and is forwarded to the publisher for its top-layer adaptation.
                if let Err(err) = self.room_manager.update_subscription_viewport(
                    room_id,
                    user_id,
                    &stream_id,
                    &track_id,
                    viewport.clone(),
                ) {
                    warn!(
                        user_id,
                        room_id = %room_id,
                        error = %err,
                        "relay: failed to update subscription viewport from receiver report"
                    );
                }
                // A fresh viewport can change the layer cap; re-evaluate this
                // viewer's selection now rather than waiting for the next sample.
                self.run_layer_selection(user_id, room_id).await;

                if let Some(track) =
                    self.resolve_any_published_track(room_id, &stream_id, &track_id)
                {
                    self.send_control_to_user(
                        track.publisher_user_id,
                        &ControlMessage::ReceiverReport {
                            stream_id,
                            track_id,
                            active_layer,
                            viewport,
                            estimated_bitrate_kbps,
                            packet_loss_ppm,
                        },
                    )
                    .await;
                }
            }
            ControlMessage::StreamKeyAnnounce {
                stream_id,
                track_id,
                codec,
                epoch,
                encrypted_keys,
            } => {
                // `encrypted_keys` is a client-supplied vector of arbitrary
                // recipient ids. Bound its length (each entry is a control
                // message the relay emits on the caller's behalf) and scope
                // every delivery to this room, so an announce cannot be used to
                // fan out at users in other calls.
                if encrypted_keys.len() > MAX_KEY_ANNOUNCE_RECIPIENTS {
                    warn!(
                        user_id,
                        room_id = %room_id,
                        recipients = encrypted_keys.len(),
                        "relay: rejecting oversized StreamKeyAnnounce recipient list"
                    );
                    return;
                }
                for (recipient_user_id, ciphertext) in encrypted_keys {
                    let delivered = self
                        .send_control_to_user_in_room(
                            room_id,
                            recipient_user_id,
                            &ControlMessage::StreamKeyDeliver {
                                stream_id: stream_id.clone(),
                                track_id: track_id.clone(),
                                sender_user_id: user_id,
                                epoch,
                                ciphertext: ciphertext.clone(),
                            },
                        )
                        .await;
                    if !delivered {
                        continue;
                    }
                    if let Err(err) = self.room_manager.store_track_key(
                        room_id,
                        user_id,
                        &stream_id,
                        &track_id,
                        epoch,
                        recipient_user_id,
                        ciphertext,
                    ) {
                        warn!(
                            user_id,
                            recipient_user_id,
                            room_id = %room_id,
                            error = %err,
                            "relay: failed to store published track key"
                        );
                    }
                }
                if let Some(track) =
                    self.resolve_any_published_track(room_id, &stream_id, &track_id)
                {
                    self.broadcast_control_in_room(
                        room_id,
                        Some(user_id),
                        &ControlMessage::TrackPublish {
                            track: PublishedTrack { codec, ..track },
                        },
                    )
                    .await;
                }
            }
            ControlMessage::KeyAnnounce {
                epoch,
                encrypted_keys,
            } => {
                // Same reasoning as StreamKeyAnnounce above: bounded length,
                // room-scoped recipients.
                if encrypted_keys.len() > MAX_KEY_ANNOUNCE_RECIPIENTS {
                    warn!(
                        user_id,
                        room_id = %room_id,
                        recipients = encrypted_keys.len(),
                        "relay: rejecting oversized KeyAnnounce recipient list"
                    );
                    return;
                }
                for (recipient_user_id, ciphertext) in encrypted_keys {
                    self.send_control_to_user_in_room(
                        room_id,
                        recipient_user_id,
                        &ControlMessage::KeyDeliver {
                            sender_user_id: user_id,
                            epoch,
                            ciphertext,
                        },
                    )
                    .await;
                }
            }
            ControlMessage::Subscribe {
                user_id: target_user_id,
                track_type,
            } => {
                // Audio fan-out is gated by the participant-level subscription
                // set; video is negotiated per-track via SubscribeStream.
                if matches!(track_type, TrackKind::Audio) {
                    if let Err(err) =
                        self.room_manager
                            .subscribe_participant(room_id, user_id, target_user_id)
                    {
                        warn!(user_id, target_user_id, room_id = %room_id, error = %err, "relay: failed to register audio subscription");
                    }
                }
            }
            ControlMessage::Unsubscribe {
                user_id: target_user_id,
                track_type,
            } => {
                if matches!(track_type, TrackKind::Audio) {
                    if let Err(err) =
                        self.room_manager
                            .unsubscribe_participant(room_id, user_id, target_user_id)
                    {
                        warn!(user_id, target_user_id, room_id = %room_id, error = %err, "relay: failed to unregister audio subscription");
                    }
                }
            }
            ControlMessage::SessionState { .. }
            | ControlMessage::SessionParticipantJoin { .. }
            | ControlMessage::SessionParticipantLeave { .. }
            | ControlMessage::Auth { .. }
            | ControlMessage::SubscriptionAck { .. }
            | ControlMessage::KeyDeliver { .. }
            | ControlMessage::StreamKeyDeliver { .. }
            | ControlMessage::RequestStreamKey { .. }
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

    async fn broadcast_control_in_room(
        &self,
        room_id: &str,
        exclude_user_id: Option<i64>,
        message: &ControlMessage,
    ) {
        let Some(room) = self.room_manager.get_room(room_id) else {
            return;
        };

        for participant in room.participants.values() {
            if exclude_user_id.is_some_and(|excluded| excluded == participant.user_id) {
                continue;
            }
            self.send_control_to_user(participant.user_id, message)
                .await;
        }
    }

    pub async fn send_initial_track_state(&self, handle: &ConnectionHandle) {
        let Some(room) = self.room_manager.get_room(&handle.room_id) else {
            return;
        };

        for participant in room.participants.values() {
            for track in participant.published_tracks.values() {
                if let Err(err) = handle
                    .send_control(&ControlMessage::TrackPublish {
                        track: track.clone(),
                    })
                    .await
                {
                    debug!(
                        recipient = handle.user_id,
                        publisher = participant.user_id,
                        error = %err,
                        "relay: failed to send initial published track state"
                    );
                }
                if let Some((epoch, ciphertext)) = self.latest_track_key_delivery(
                    &handle.room_id,
                    track,
                    &track.stream_id,
                    &track.track_id,
                    handle.user_id,
                ) {
                    if let Err(err) = handle
                        .send_control(&ControlMessage::StreamKeyDeliver {
                            stream_id: track.stream_id.clone(),
                            track_id: track.track_id.clone(),
                            sender_user_id: participant.user_id,
                            epoch,
                            ciphertext,
                        })
                        .await
                    {
                        debug!(
                            recipient = handle.user_id,
                            publisher = participant.user_id,
                            error = %err,
                            "relay: failed to send initial track key state"
                        );
                    }
                } else if let Some(publisher_handle) = self
                    .connections
                    .get(&participant.user_id)
                    .map(|entry| entry.clone())
                {
                    if let Err(err) = publisher_handle
                        .send_control(&ControlMessage::RequestStreamKey {
                            stream_id: track.stream_id.clone(),
                            track_id: track.track_id.clone(),
                            recipient_user_id: handle.user_id,
                        })
                        .await
                    {
                        debug!(
                            recipient = handle.user_id,
                            publisher = participant.user_id,
                            error = %err,
                            "relay: failed to request initial track key state"
                        );
                    }
                }
            }
        }
    }

    async fn send_control_to_user(&self, user_id: i64, message: &ControlMessage) {
        let Some(handle) = self.connections.get(&user_id).map(|entry| entry.clone()) else {
            return;
        };
        if let Err(err) = handle.send_control(message).await {
            debug!(recipient = user_id, error = %err, "relay: failed to send control message");
        }
    }

    /// Send a control message to `user_id` **only if that user is a participant
    /// of `room_id`**.
    ///
    /// [`send_control_to_user`] resolves against the global connection map with
    /// no room scoping. That is correct for recipients the relay itself derived
    /// from room state, but not for a recipient id a client put in a message:
    /// `StreamKeyAnnounce`/`KeyAnnounce` carry a caller-supplied
    /// `recipient_user_id`, so without this check a participant in any room
    /// could inject `KeyDeliver`/`StreamKeyDeliver` at arbitrary users in every
    /// other call on the server.
    async fn send_control_to_user_in_room(
        &self,
        room_id: &str,
        user_id: i64,
        message: &ControlMessage,
    ) -> bool {
        let in_room = self
            .room_manager
            .with_room(room_id, |room| room.participants.contains_key(&user_id))
            .unwrap_or(false);
        if !in_room {
            debug!(
                recipient = user_id,
                room_id = %room_id,
                "relay: refusing to deliver control message to a non-member"
            );
            return false;
        }
        self.send_control_to_user(user_id, message).await;
        true
    }

    /// Rate-gate keyframe-request forwarding for one `(stream, track)`.
    ///
    /// Returns `true` (and records `now`) when a request may be forwarded
    /// upstream; `false` when a prior request within
    /// [`KEYFRAME_REQUEST_MIN_INTERVAL`] should coalesce this one.
    fn allow_keyframe_request(
        &self,
        publisher_user_id: i64,
        stream_id: &StreamId,
        track_id: &TrackId,
        now: Instant,
    ) -> bool {
        let key = (publisher_user_id, stream_id.clone(), track_id.clone());
        if let Some(last) = self.keyframe_throttle.get(&key) {
            if now.saturating_duration_since(*last.value()) < KEYFRAME_REQUEST_MIN_INTERVAL {
                return false;
            }
        }
        self.keyframe_throttle.insert(key, now);
        true
    }

    fn resolve_published_track(
        &self,
        room_id: &str,
        publisher_user_id: i64,
        stream_id: &StreamId,
        track_id: &TrackId,
    ) -> Option<PublishedTrack> {
        let room = self.room_manager.get_room(room_id)?;
        room.participants
            .get(&publisher_user_id)?
            .published_tracks
            .get(&(stream_id.clone(), track_id.clone()))
            .cloned()
    }

    fn resolve_any_published_track(
        &self,
        room_id: &str,
        stream_id: &StreamId,
        track_id: &TrackId,
    ) -> Option<PublishedTrack> {
        let room = self.room_manager.get_room(room_id)?;
        room.participants.values().find_map(|participant| {
            participant
                .published_tracks
                .get(&(stream_id.clone(), track_id.clone()))
                .cloned()
        })
    }

    fn latest_track_key_delivery(
        &self,
        room_id: &str,
        track: &PublishedTrack,
        stream_id: &StreamId,
        track_id: &TrackId,
        recipient_user_id: i64,
    ) -> Option<(u8, Vec<u8>)> {
        if let Ok(Some(delivery)) = self.room_manager.latest_track_key_for_recipient(
            room_id,
            track.publisher_user_id,
            stream_id,
            track_id,
            recipient_user_id,
        ) {
            return Some(delivery);
        }

        let _ = (room_id, track, recipient_user_id);
        None
    }

    /// Re-evaluate a viewer's simulcast layer selection across every video track
    /// they subscribe to (spec §4.2). Driven from the per-connection bandwidth
    /// task (after a fresh downlink sample) and on receiver reports.
    ///
    /// Selection defers until the relay has at least one real downlink sample for
    /// the viewer, so a freshly connected viewer is never downswitched off the
    /// pre-measurement default before it has been measured.
    async fn run_layer_selection(&self, viewer_id: i64, room_id: &str) {
        if !self.downlink_estimator.is_sampled(viewer_id) {
            return;
        }
        let Some(room) = self.room_manager.get_room(room_id) else {
            return;
        };
        let Some(participant) = room.participants.get(&viewer_id) else {
            return;
        };
        // Snapshot each video subscription (stream/track/viewport/active layer)
        // so the room clone is not borrowed across the control-send awaits below.
        let subscriptions: Vec<(StreamId, TrackId, Option<ViewportHint>, Option<u8>)> = participant
            .track_subscriptions
            .values()
            .map(|subscription| {
                (
                    subscription.stream_id.clone(),
                    subscription.track_id.clone(),
                    subscription.viewport.clone(),
                    subscription.active_layer,
                )
            })
            .collect();

        let egress_kbps = self.downlink_estimator.estimate_kbps(viewer_id);
        let loss = self.downlink_estimator.windowed_loss(viewer_id);
        let now = Instant::now();

        for (stream_id, track_id, viewport, active_layer) in subscriptions {
            let Some(track) = find_published_track_in_room(&room, &stream_id, &track_id) else {
                continue;
            };
            // A single-layer track (VP9 floor or a collapsed ladder) offers
            // nothing to select between.
            if distinct_layer_count(&track) < 2 {
                continue;
            }
            self.evaluate_layer_selection(
                viewer_id,
                &track,
                &stream_id,
                &track_id,
                viewport.as_ref(),
                active_layer,
                egress_kbps,
                loss,
                now,
            )
            .await;
        }
    }

    /// Evaluate one `(viewer, track)` pair: stage a keyframe-gated layer switch
    /// when the budget/viewport/hysteresis policy (spec §4.2) picks a different
    /// layer, requesting a keyframe on the target layer (throttled) so the switch
    /// can land at its next keyframe boundary.
    #[allow(clippy::too_many_arguments)]
    async fn evaluate_layer_selection(
        &self,
        viewer_id: i64,
        track: &PublishedTrack,
        stream_id: &StreamId,
        track_id: &TrackId,
        viewport: Option<&ViewportHint>,
        active_layer: Option<u8>,
        egress_kbps: u32,
        loss: f64,
        now: Instant,
    ) {
        let key = (viewer_id, stream_id.clone(), track_id.clone());
        let target = {
            let mut entry = self.layer_selection.entry(key.clone()).or_insert_with(|| {
                LayerSelectionState::new(active_layer.unwrap_or_else(|| lowest_layer_id(track)))
            });
            // Keep the forwarded layer in sync with the subscription's committed
            // active layer (e.g. set by the initial subscribe).
            if let Some(active) = active_layer {
                entry.current_layer = active;
            }
            compute_target_layer(track, &mut entry, egress_kbps, loss, viewport, now)
        };

        let Some(target) = target else {
            // No switch wanted: drop any stale pending target so a later keyframe
            // on that layer does not spuriously commit it.
            if let Some(mut entry) = self.layer_selection.get_mut(&key) {
                entry.pending_layer = None;
            }
            return;
        };

        // Stage the switch; the actual flip happens when the target layer's next
        // keyframe arrives (`commit_pending_switches`).
        if let Some(mut entry) = self.layer_selection.get_mut(&key) {
            entry.pending_layer = Some(target);
        }
        // Request a keyframe on the TARGET layer, throttled per (publisher,
        // stream, track) so a churn of switches cannot pump the publisher.
        if self.allow_keyframe_request(track.publisher_user_id, stream_id, track_id, now) {
            self.send_control_to_user(
                track.publisher_user_id,
                &ControlMessage::RequestKeyframe {
                    stream_id: stream_id.clone(),
                    track_id: track_id.clone(),
                    layer_id: Some(target),
                },
            )
            .await;
        }
    }

    /// Commit every viewer whose pending switch targets `layer_id` of
    /// `(stream, track)` at that layer's keyframe boundary (spec §4.2): flip the
    /// subscription's forwarded layer (bumping the routing generation) and clear
    /// the pending state. Returns whether any viewer was committed.
    fn commit_pending_switches(
        &self,
        room_id: &str,
        stream_id: &StreamId,
        track_id: &TrackId,
        layer_id: u8,
    ) -> bool {
        // Collect first so no DashMap shard guard is held across the room mutation.
        let viewers: Vec<i64> = self
            .layer_selection
            .iter()
            .filter(|entry| {
                let (_, entry_stream, entry_track) = entry.key();
                entry_stream == stream_id
                    && entry_track == track_id
                    && entry.value().pending_layer == Some(layer_id)
            })
            .map(|entry| entry.key().0)
            .collect();

        let mut committed = false;
        for viewer in viewers {
            match self
                .room_manager
                .set_subscription_active_layer(room_id, viewer, stream_id, track_id, layer_id)
            {
                Ok(true) => {
                    if let Some(mut entry) =
                        self.layer_selection
                            .get_mut(&(viewer, stream_id.clone(), track_id.clone()))
                    {
                        entry.current_layer = layer_id;
                        entry.pending_layer = None;
                        entry.headroom_since = None;
                    }
                    committed = true;
                }
                Ok(false) => {}
                Err(err) => debug!(
                    viewer,
                    room_id = %room_id,
                    error = %err,
                    "relay: failed to commit layer switch"
                ),
            }
        }
        committed
    }
}

/// Resolve the simulcast layer id to report back in a [`ControlMessage::SubscriptionAck`].
///
/// When the target track is currently published, the relay resolves the layer
/// it will actually forward (honoring viewport / requested-layer hints);
/// otherwise it echoes the viewer's requested layer so the client still learns
/// its subscription intent was accepted.
fn resolved_ack_layer(
    track: Option<&PublishedTrack>,
    subscription: &paracord_transport::stream::TrackSubscription,
) -> Option<u8> {
    track
        .and_then(|track| subscription.resolved_layer_id(track))
        .or(subscription.active_layer)
        .or(subscription.requested_layer)
}

fn resolve_published_track_for_ssrc(
    room: &crate::room::MediaRoom,
    sender_id: i64,
    ssrc: u32,
) -> Option<PublishedTrack> {
    room.participants
        .get(&sender_id)?
        .published_tracks
        .values()
        .find(|track| track.layers.iter().any(|layer| layer.ssrc == ssrc))
        .cloned()
}

/// Full relay-forwarding decision for one candidate recipient.
///
/// Layers the room-wide invariants on top of the per-subscription
/// [`should_forward_to_participant`] check:
/// - a sender never receives their own audio echoed back;
/// - a deafened participant receives no media at all;
/// - everything else is gated by the participant's subscriptions.
///
/// Cross-room isolation is enforced by the caller: fan-out only iterates the
/// participants of the sender's own room, so a packet can never reach a
/// participant in a different room.
fn should_relay_packet_to(
    participant: &crate::participant::MediaParticipant,
    sender_id: i64,
    header: &MediaHeader,
    published_track: Option<&PublishedTrack>,
) -> bool {
    // Never echo a sender's own audio back to themselves.
    if participant.user_id == sender_id
        && matches!(
            header.track_type,
            paracord_transport::protocol::TrackType::Audio
        )
    {
        return false;
    }
    // Deafened participants receive no media.
    if participant.deafened {
        return false;
    }
    should_forward_to_participant(participant, sender_id, header, published_track)
}

fn should_forward_to_participant(
    participant: &crate::participant::MediaParticipant,
    sender_id: i64,
    header: &MediaHeader,
    published_track: Option<&PublishedTrack>,
) -> bool {
    if let Some(track) = published_track {
        return participant
            .track_subscriptions
            .values()
            .any(|subscription| subscription.matches_layer_ssrc(track, header.ssrc));
    }

    match header.track_type {
        paracord_transport::protocol::TrackType::Audio => {
            participant.subscriptions.contains(&sender_id)
        }
        paracord_transport::protocol::TrackType::Video => false,
    }
}

/// Pick the highest published simulcast layer that fits within `budget_kbps`.
fn suggest_layer_for_budget(track: &PublishedTrack, budget_kbps: u32) -> Option<u8> {
    if track.layers.is_empty() {
        return None;
    }

    let mut layers = track.layers.clone();
    layers.sort_by_key(|layer| layer.layer_id);
    layers
        .iter()
        .rev()
        .find(|layer| layer.max_bitrate_kbps.unwrap_or(u32::MAX) <= budget_kbps)
        .or_else(|| layers.first())
        .map(|layer| layer.layer_id)
}

// ── Relay-driven per-viewer layer selection helpers (spec §4.2) ──────────────

/// Distinct published layer ids on a track (deduped), ascending.
fn distinct_layer_ids(track: &PublishedTrack) -> Vec<u8> {
    let mut ids: Vec<u8> = track.layers.iter().map(|layer| layer.layer_id).collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// Number of distinct layers a track publishes.
fn distinct_layer_count(track: &PublishedTrack) -> usize {
    distinct_layer_ids(track).len()
}

/// Lowest published layer id (the safe floor for an unmeasured viewer).
fn lowest_layer_id(track: &PublishedTrack) -> u8 {
    distinct_layer_ids(track).first().copied().unwrap_or(0)
}

/// Ladder bitrate (kbps) of a specific layer, if it publishes one.
fn layer_bitrate_kbps(track: &PublishedTrack, layer_id: u8) -> Option<u32> {
    track
        .layers
        .iter()
        .find(|layer| layer.layer_id == layer_id)
        .and_then(|layer| layer.max_bitrate_kbps)
}

/// The next-higher (or next-lower) published layer id relative to `current`,
/// clamped to the ends of the ladder.
fn next_layer_up(layer_ids: &[u8], current: u8) -> u8 {
    match layer_ids.iter().position(|&id| id == current) {
        Some(idx) if idx + 1 < layer_ids.len() => layer_ids[idx + 1],
        _ => current,
    }
}

fn next_layer_down(layer_ids: &[u8], current: u8) -> u8 {
    match layer_ids.iter().position(|&id| id == current) {
        Some(idx) if idx > 0 => layer_ids[idx - 1],
        _ => current,
    }
}

/// Viewport → maximum layer cap (spec §4.2/I4): px tile height ≤400 ⇒ L, ≤800 ⇒
/// M, else H, mapped onto the track's published layers (ascending, clamped so a
/// track with fewer than three rungs still resolves).
fn viewport_layer_cap(track: &PublishedTrack, viewport: Option<&ViewportHint>) -> Option<u8> {
    let viewport = viewport?;
    let layer_ids = distinct_layer_ids(track);
    if layer_ids.is_empty() {
        return None;
    }
    let tier = if viewport.height <= 400 {
        0
    } else if viewport.height <= 800 {
        1
    } else {
        2
    };
    Some(layer_ids[tier.min(layer_ids.len() - 1)])
}

/// The relay's per-viewer layer decision (spec §4.2): returns the layer a switch
/// should be staged toward, or `None` to stay on `state.current_layer`.
///
/// - Budget: the highest layer whose ladder bitrate ≤ 85% of the egress estimate.
/// - Cap: the viewport hint (a small tile never receives H).
/// - Downswitch is immediate on windowed loss >2%, an estimate below the current
///   layer's bitrate, or the budget/viewport desired level dropping below current.
/// - Upswitch fires only after the estimate has held ≥125% of the target rung's
///   bitrate for 5s (`state.headroom_since` tracks the streak).
fn compute_target_layer(
    track: &PublishedTrack,
    state: &mut LayerSelectionState,
    egress_kbps: u32,
    loss: f64,
    viewport: Option<&ViewportHint>,
    now: Instant,
) -> Option<u8> {
    let layer_ids = distinct_layer_ids(track);
    if layer_ids.is_empty() {
        return None;
    }
    let lowest = layer_ids[0];
    let highest = *layer_ids.last().unwrap();
    let current = state.current_layer;

    // Budget layer capped by the viewport hint.
    let budget_kbps = (u64::from(egress_kbps) * u64::from(LAYER_BUDGET_PERCENT) / 100) as u32;
    let budget_layer = suggest_layer_for_budget(track, budget_kbps).unwrap_or(lowest);
    let cap = viewport_layer_cap(track, viewport).unwrap_or(highest);
    let desired = budget_layer.min(cap);

    let current_bitrate = layer_bitrate_kbps(track, current).unwrap_or(0);
    let loss_high = loss > DOWNSWITCH_LOSS_RATIO;
    let estimate_below_current = current_bitrate > 0 && egress_kbps < current_bitrate;

    // Immediate downswitch.
    if loss_high || estimate_below_current || desired < current {
        state.headroom_since = None;
        let mut target = desired.min(current);
        // A pure loss spike with no budget drop still steps down one rung.
        if loss_high && target >= current {
            target = next_layer_down(&layer_ids, current);
        }
        return (target != current).then_some(target);
    }

    // Upswitch candidate: only toward a higher desired level, gated by the 5s
    // ≥125%-headroom hold over the target rung's bitrate.
    if desired > current {
        let target = next_layer_up(&layer_ids, current);
        let target_bitrate = u64::from(layer_bitrate_kbps(track, target).unwrap_or(u32::MAX));
        let has_headroom =
            u64::from(egress_kbps) * 100 >= target_bitrate * UPSWITCH_HEADROOM_PERCENT;
        if has_headroom {
            let since = *state.headroom_since.get_or_insert(now);
            if now.saturating_duration_since(since) >= UPSWITCH_HOLD {
                return Some(target);
            }
        } else {
            state.headroom_since = None;
        }
        return None;
    }

    // Steady state at the desired level.
    state.headroom_since = None;
    None
}

/// Resolve a published track by identity within an already-snapshotted room.
fn find_published_track_in_room(
    room: &crate::room::MediaRoom,
    stream_id: &StreamId,
    track_id: &TrackId,
) -> Option<PublishedTrack> {
    room.participants.values().find_map(|participant| {
        participant
            .published_tracks
            .get(&(stream_id.clone(), track_id.clone()))
            .cloned()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use paracord_transport::control::TrackKind;
    use paracord_transport::stream::{
        PublishedLayer, StreamId, TrackId, TrackSubscription, VideoCodec,
    };

    #[test]
    fn connection_handle_creation() {
        // We can't easily test with real quinn connections in unit tests,
        // but we can verify the struct construction.
        let mgr = MediaRoomManager::new();
        let forwarder = RelayForwarder::new(Arc::new(mgr), Arc::new(SpeakerDetector::new()));
        assert_eq!(forwarder.connection_count(), 0);
    }

    #[test]
    fn disconnect_user_clears_relay_state_and_is_idempotent() {
        let mgr = MediaRoomManager::new();
        let forwarder = RelayForwarder::new(Arc::new(mgr), Arc::new(SpeakerDetector::new()));
        let user_id = 77;

        // Seed per-sender relay bookkeeping as if the user had been actively
        // forwarding media on a live connection.
        forwarder.active_sessions.insert(
            user_id,
            ActiveSessionInfo {
                room_id: "1:100".to_string(),
                session_id: "sess".to_string(),
                video_capabilities: vec![],
            },
        );
        assert!(forwarder.sender_rate_limiter.try_acquire(user_id));

        // Evicting the user tears down the relay-side state so they can no
        // longer be routed to or from.
        forwarder.disconnect_user(user_id);
        assert!(!forwarder.active_sessions.contains_key(&user_id));

        // Calling it again for a user with no live connection is a safe no-op.
        forwarder.disconnect_user(user_id);
        assert_eq!(forwarder.connection_count(), 0);
    }

    #[test]
    fn suggest_layer_for_budget_picks_highest_fitting_layer() {
        let track = PublishedTrack {
            stream_id: StreamId::new("stream-1"),
            track_id: TrackId::new("cam"),
            publisher_user_id: 1,
            kind: TrackKind::Video,
            codec: Some(VideoCodec::Vp9),
            layers: vec![
                PublishedLayer {
                    layer_id: 0,
                    ssrc: 10,
                    width: Some(640),
                    height: Some(360),
                    max_bitrate_kbps: Some(500),
                    active: true,
                },
                PublishedLayer {
                    layer_id: 1,
                    ssrc: 11,
                    width: Some(1280),
                    height: Some(720),
                    max_bitrate_kbps: Some(1500),
                    active: true,
                },
                PublishedLayer {
                    layer_id: 2,
                    ssrc: 12,
                    width: Some(1920),
                    height: Some(1080),
                    max_bitrate_kbps: Some(4000),
                    active: true,
                },
            ],
        };

        assert_eq!(suggest_layer_for_budget(&track, 4000), Some(2));
        assert_eq!(suggest_layer_for_budget(&track, 1500), Some(1));
        assert_eq!(suggest_layer_for_budget(&track, 400), Some(0));
    }

    #[test]
    fn published_video_requires_explicit_track_subscription() {
        let mut participant = crate::participant::MediaParticipant::new(2, "sess-2".to_string());
        participant.subscribe(1);

        let track = PublishedTrack {
            stream_id: StreamId::new("stream-1"),
            track_id: TrackId::new("screen"),
            publisher_user_id: 1,
            kind: TrackKind::Video,
            codec: Some(VideoCodec::H264),
            layers: vec![PublishedLayer {
                layer_id: 0,
                ssrc: 99,
                width: Some(1280),
                height: Some(720),
                max_bitrate_kbps: Some(2500),
                active: true,
            }],
        };
        let header = MediaHeader {
            version: 1,
            track_type: paracord_transport::protocol::TrackType::Video,
            simulcast_layer: 0,
            sequence: 1,
            timestamp: 123,
            ssrc: 99,
            audio_level: 127,
            key_epoch: 1,
            payload_length: 0,
            codec: 3,
        };

        assert!(!should_forward_to_participant(
            &participant,
            1,
            &header,
            Some(&track)
        ));

        participant.subscribe_track(TrackSubscription {
            stream_id: track.stream_id.clone(),
            track_id: track.track_id.clone(),
            requested_layer: Some(0),
            active_layer: Some(0),
            viewport: None,
        });

        assert!(should_forward_to_participant(
            &participant,
            1,
            &header,
            Some(&track)
        ));
    }

    #[test]
    fn rate_limiter_drops_packets_beyond_ceiling() {
        use std::time::Duration;

        // Small deterministic bucket: 10 pps, burst of 5 tokens.
        let limiter = SenderRateLimiter::new(10.0, 5.0);
        let user_id = 42;
        let start = Instant::now();

        // The first 5 packets (the full burst) are accepted at t=0.
        let mut accepted = 0;
        for _ in 0..20 {
            if limiter.try_acquire_at(user_id, start) {
                accepted += 1;
            }
        }
        assert_eq!(accepted, 5, "burst should cap accepted packets");

        // No tokens remain until time advances.
        assert!(!limiter.try_acquire_at(user_id, start));

        // After 1 second at 10 pps, ~10 more tokens have refilled (capped at burst=5).
        let later = start + Duration::from_secs(1);
        let mut refilled = 0;
        for _ in 0..20 {
            if limiter.try_acquire_at(user_id, later) {
                refilled += 1;
            }
        }
        assert_eq!(refilled, 5, "refill is capped at the burst allowance");
    }

    #[test]
    fn rate_limiter_is_per_sender() {
        let limiter = SenderRateLimiter::new(1.0, 1.0);
        let now = Instant::now();

        // Each distinct sender gets its own independent bucket.
        assert!(limiter.try_acquire_at(1, now));
        assert!(limiter.try_acquire_at(2, now));
        // But a second immediate packet from the same sender is dropped.
        assert!(!limiter.try_acquire_at(1, now));
        assert!(!limiter.try_acquire_at(2, now));
    }

    #[test]
    fn rate_limiter_forget_resets_sender() {
        let limiter = SenderRateLimiter::new(1.0, 1.0);
        let now = Instant::now();

        assert!(limiter.try_acquire_at(7, now));
        assert!(!limiter.try_acquire_at(7, now));
        limiter.forget(7);
        // A reconnecting sender starts with a fresh full burst.
        assert!(limiter.try_acquire_at(7, now));
    }

    #[test]
    fn datagram_length_validation_rejects_inconsistent_payload_length() {
        let mut header = MediaHeader {
            version: 1,
            track_type: paracord_transport::protocol::TrackType::Audio,
            simulcast_layer: 0,
            sequence: 1,
            timestamp: 123,
            ssrc: 55,
            audio_level: 100,
            key_epoch: 1,
            payload_length: 8,
            codec: 0,
        };

        // Exactly HEADER_SIZE + payload_length is accepted.
        assert!(datagram_length_is_consistent(HEADER_SIZE + 8, &header));

        // A datagram claiming more payload than it carries is rejected.
        assert!(!datagram_length_is_consistent(HEADER_SIZE + 4, &header));
        // A datagram carrying more bytes than declared is rejected (padding/amplification).
        assert!(!datagram_length_is_consistent(HEADER_SIZE + 16, &header));
        // A header-only datagram with a nonzero payload_length is rejected.
        assert!(!datagram_length_is_consistent(HEADER_SIZE, &header));

        // A zero-payload packet must be exactly HEADER_SIZE.
        header.payload_length = 0;
        assert!(datagram_length_is_consistent(HEADER_SIZE, &header));
        assert!(!datagram_length_is_consistent(HEADER_SIZE + 1, &header));
    }

    #[test]
    fn audio_still_uses_participant_subscription_fallback() {
        let mut participant = crate::participant::MediaParticipant::new(2, "sess-2".to_string());
        participant.subscribe(1);

        let header = MediaHeader {
            version: 1,
            track_type: paracord_transport::protocol::TrackType::Audio,
            simulcast_layer: 0,
            sequence: 1,
            timestamp: 123,
            ssrc: 55,
            audio_level: 100,
            key_epoch: 1,
            payload_length: 0,
            codec: 0,
        };

        assert!(should_forward_to_participant(
            &participant,
            1,
            &header,
            None
        ));
    }

    fn audio_header(ssrc: u32) -> MediaHeader {
        MediaHeader {
            version: 1,
            track_type: paracord_transport::protocol::TrackType::Audio,
            simulcast_layer: 0,
            sequence: 1,
            timestamp: 123,
            ssrc,
            audio_level: 100,
            key_epoch: 1,
            payload_length: 0,
            codec: 0,
        }
    }

    #[test]
    fn audio_forwarded_only_to_subscribed_senders() {
        // Viewer 3 subscribes to speaker A (1) but not speaker B (2).
        let mut viewer = crate::participant::MediaParticipant::new(3, "sess-3".to_string());
        viewer.subscribe(1);

        // A's audio is forwarded; B's audio is dropped.
        assert!(should_forward_to_participant(
            &viewer,
            1,
            &audio_header(11),
            None
        ));
        assert!(!should_forward_to_participant(
            &viewer,
            2,
            &audio_header(22),
            None
        ));
    }

    #[test]
    fn subscribe_participant_toggles_audio_forwarding() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(
            1,
            100,
            crate::participant::MediaParticipant::new(1, "s1".into()),
        )
        .unwrap();
        mgr.join_room(
            1,
            100,
            crate::participant::MediaParticipant::new(2, "s2".into()),
        )
        .unwrap();
        let room_id = mgr.get_or_create_room(1, 100);

        // Join auto-subscribes; a client can then drop a specific speaker's audio.
        mgr.unsubscribe_participant(&room_id, 2, 1).unwrap();
        let room = mgr.get_room(&room_id).unwrap();
        let viewer = room.participants.get(&2).unwrap();
        assert!(!should_forward_to_participant(
            viewer,
            1,
            &audio_header(11),
            None
        ));

        // Re-subscribing restores forwarding.
        mgr.subscribe_participant(&room_id, 2, 1).unwrap();
        let room = mgr.get_room(&room_id).unwrap();
        let viewer = room.participants.get(&2).unwrap();
        assert!(should_forward_to_participant(
            viewer,
            1,
            &audio_header(11),
            None
        ));
    }

    #[test]
    fn subscription_ack_layer_prefers_resolved_then_requested() {
        let track = PublishedTrack {
            stream_id: StreamId::new("stream-1"),
            track_id: TrackId::new("screen"),
            publisher_user_id: 1,
            kind: TrackKind::Video,
            codec: Some(VideoCodec::H264),
            layers: vec![
                PublishedLayer {
                    layer_id: 0,
                    ssrc: 100,
                    width: Some(640),
                    height: Some(360),
                    max_bitrate_kbps: Some(800),
                    active: true,
                },
                PublishedLayer {
                    layer_id: 1,
                    ssrc: 101,
                    width: Some(1280),
                    height: Some(720),
                    max_bitrate_kbps: Some(2500),
                    active: true,
                },
            ],
        };
        let subscription = TrackSubscription {
            stream_id: track.stream_id.clone(),
            track_id: track.track_id.clone(),
            requested_layer: Some(1),
            active_layer: None,
            viewport: None,
        };

        // With the track published, the relay reports the layer it will forward.
        assert_eq!(resolved_ack_layer(Some(&track), &subscription), Some(1));
        // Without a resolved track, it echoes the viewer's requested layer.
        assert_eq!(resolved_ack_layer(None, &subscription), Some(1));
    }

    #[test]
    fn deafened_participant_receives_no_media() {
        // A deafened viewer subscribed to a speaker still must not be forwarded to.
        let mut viewer = crate::participant::MediaParticipant::new(3, "sess-3".to_string());
        viewer.subscribe(1);
        assert!(should_relay_packet_to(&viewer, 1, &audio_header(11), None));

        viewer.deafened = true;
        assert!(!should_relay_packet_to(&viewer, 1, &audio_header(11), None));
    }

    #[test]
    fn sender_audio_is_not_echoed_to_self() {
        // A speaker subscribed to their own id (as join auto-subscription does)
        // must never receive their own audio back.
        let mut speaker = crate::participant::MediaParticipant::new(1, "sess-1".to_string());
        speaker.subscribe(1);
        assert!(!should_relay_packet_to(
            &speaker,
            1,
            &audio_header(11),
            None
        ));

        // But another subscribed participant still receives that audio.
        let mut viewer = crate::participant::MediaParticipant::new(2, "sess-2".to_string());
        viewer.subscribe(1);
        assert!(should_relay_packet_to(&viewer, 1, &audio_header(11), None));
    }

    #[test]
    fn media_never_crosses_room_boundaries() {
        let mgr = MediaRoomManager::new();
        // Room A (guild 1, channel 100): sender 1 and viewer 2.
        mgr.join_room(
            1,
            100,
            crate::participant::MediaParticipant::new(1, "a1".into()),
        )
        .unwrap();
        mgr.join_room(
            1,
            100,
            crate::participant::MediaParticipant::new(2, "a2".into()),
        )
        .unwrap();
        // Room B (guild 1, channel 200): user 3.
        mgr.join_room(
            1,
            200,
            crate::participant::MediaParticipant::new(3, "b3".into()),
        )
        .unwrap();

        let room_a = mgr.get_or_create_room(1, 100);
        let room_b = mgr.get_or_create_room(1, 200);
        let forwarder = RelayForwarder::new(Arc::new(mgr), Arc::new(SpeakerDetector::new()));

        // Sender 1's audio in room A reaches viewer 2 but never room-B user 3.
        let recipients = forwarder.compute_forward_recipients(1, &room_a, &audio_header(11));
        assert_eq!(recipients, vec![2]);
        assert!(!recipients.contains(&3));

        // A sender that is not a member of room B produces no recipients there.
        let cross = forwarder.compute_forward_recipients(1, &room_b, &audio_header(11));
        assert!(cross.is_empty());
    }

    #[test]
    fn listen_only_sender_media_is_dropped_before_fanout() {
        let mgr = MediaRoomManager::new();
        // Sender 1 joined without publish rights (SPEAK denied); viewer 2 may speak.
        mgr.join_room(
            1,
            100,
            crate::participant::MediaParticipant::new(1, "s1".into()).with_can_publish(false),
        )
        .unwrap();
        mgr.join_room(
            1,
            100,
            crate::participant::MediaParticipant::new(2, "s2".into()),
        )
        .unwrap();

        let room_id = mgr.get_or_create_room(1, 100);
        let forwarder = RelayForwarder::new(Arc::new(mgr), Arc::new(SpeakerDetector::new()));

        // A listen-only sender reaches no one, even though viewer 2 is subscribed.
        let recipients = forwarder.compute_forward_recipients(1, &room_id, &audio_header(11));
        assert!(recipients.is_empty());

        // A sender that may publish still fans out to subscribed peers.
        let allowed = forwarder.compute_forward_recipients(2, &room_id, &audio_header(22));
        assert_eq!(allowed, vec![1]);
    }

    #[tokio::test]
    async fn session_join_with_mismatched_room_is_rejected() {
        let mgr = MediaRoomManager::new();
        let forwarder = RelayForwarder::new(Arc::new(mgr), Arc::new(SpeakerDetector::new()));

        // The control task is bound to "room-a"; a join claiming "room-b" must
        // be dropped without registering an active session.
        forwarder
            .handle_control_message(
                42,
                "room-a",
                ControlMessage::SessionJoin {
                    room_id: "room-b".to_string(),
                    session_id: "sess".to_string(),
                    video_capabilities: vec![],
                },
            )
            .await;

        assert!(forwarder.active_sessions.is_empty());
    }

    /// `encrypted_keys` is a client-supplied `(recipient_user_id, ciphertext)`
    /// list with no length bound, and `send_control_to_user` resolves against
    /// the GLOBAL connection map. One 256 KB control message could therefore
    /// inject `StreamKeyDeliver` at thousands of users across every other call
    /// on the server. The announce must be rejected outright when oversized, and
    /// nothing may be stored for it.
    #[tokio::test]
    async fn oversized_stream_key_announce_is_rejected_wholesale() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(
            1,
            100,
            crate::participant::MediaParticipant::new(1, "s1".into()),
        )
        .unwrap();
        let room_id = mgr.get_or_create_room(1, 100);
        let mgr = Arc::new(mgr);
        let forwarder = RelayForwarder::new(Arc::clone(&mgr), Arc::new(SpeakerDetector::new()));

        let stream_id = StreamId::new("stream-1");
        let track_id = TrackId::new("screen");
        let encrypted_keys: Vec<(i64, Vec<u8>)> = (0..(MAX_KEY_ANNOUNCE_RECIPIENTS as i64 + 1))
            .map(|uid| (uid + 1_000, vec![0u8; 16]))
            .collect();

        forwarder
            .handle_control_message(
                1,
                &room_id,
                ControlMessage::StreamKeyAnnounce {
                    stream_id: stream_id.clone(),
                    track_id: track_id.clone(),
                    codec: None,
                    epoch: 1,
                    encrypted_keys,
                },
            )
            .await;

        // No key was stored for any of the named recipients.
        for uid in 1_000..1_000 + MAX_KEY_ANNOUNCE_RECIPIENTS as i64 + 1 {
            assert!(
                mgr.latest_track_key_for_recipient(&room_id, 1, &stream_id, &track_id, uid)
                    .unwrap()
                    .is_none(),
                "recipient {uid} must not have received a key from a rejected announce"
            );
        }
    }

    /// A recipient named in an announce must be a member of the announcing
    /// participant's room. Without the scoping, `recipient_user_id` reached the
    /// global connection map and could target users in unrelated calls.
    #[tokio::test]
    async fn key_announce_recipients_outside_the_room_are_not_stored() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(
            1,
            100,
            crate::participant::MediaParticipant::new(1, "s1".into()),
        )
        .unwrap();
        mgr.join_room(
            1,
            100,
            crate::participant::MediaParticipant::new(2, "s2".into()),
        )
        .unwrap();
        // User 3 is in a completely different room.
        mgr.join_room(
            9,
            900,
            crate::participant::MediaParticipant::new(3, "s3".into()),
        )
        .unwrap();

        let room_id = mgr.get_or_create_room(1, 100);
        let mgr = Arc::new(mgr);
        let forwarder = RelayForwarder::new(Arc::clone(&mgr), Arc::new(SpeakerDetector::new()));

        let stream_id = StreamId::new("stream-1");
        let track_id = TrackId::new("screen");
        forwarder
            .handle_control_message(
                1,
                &room_id,
                ControlMessage::StreamKeyAnnounce {
                    stream_id: stream_id.clone(),
                    track_id: track_id.clone(),
                    codec: None,
                    epoch: 1,
                    encrypted_keys: vec![(2, vec![0xAA; 16]), (3, vec![0xBB; 16])],
                },
            )
            .await;

        // The in-room recipient is served.
        assert!(mgr
            .latest_track_key_for_recipient(&room_id, 1, &stream_id, &track_id, 2)
            .unwrap()
            .is_some());
        // The cross-room recipient is not.
        assert!(
            mgr.latest_track_key_for_recipient(&room_id, 1, &stream_id, &track_id, 3)
                .unwrap()
                .is_none(),
            "a user outside the announcing participant's room must not be targeted"
        );
    }

    /// Track announcements are re-broadcast to the whole room, and every layer a
    /// subscriber accepts costs it an AES-GCM instance (plus, for audio, an Opus
    /// decoder and jitter buffer). The layer list must be capped at the relay.
    #[tokio::test]
    async fn track_publish_with_absurd_layer_count_is_rejected() {
        use paracord_transport::control::TrackKind;
        use paracord_transport::stream::{PublishedLayer, VideoCodec as WireVideoCodec};

        let mgr = MediaRoomManager::new();
        mgr.join_room(
            1,
            100,
            crate::participant::MediaParticipant::new(1, "s1".into()),
        )
        .unwrap();
        let room_id = mgr.get_or_create_room(1, 100);
        let mgr = Arc::new(mgr);
        let forwarder = RelayForwarder::new(Arc::clone(&mgr), Arc::new(SpeakerDetector::new()));

        let layers: Vec<PublishedLayer> = (0..(MAX_TRACK_LAYERS as u32 + 1))
            .map(|i| PublishedLayer {
                layer_id: 0,
                ssrc: 5_000 + i,
                width: Some(320),
                height: Some(180),
                max_bitrate_kbps: Some(150),
                active: true,
            })
            .collect();

        forwarder
            .handle_control_message(
                1,
                &room_id,
                ControlMessage::TrackPublish {
                    track: PublishedTrack {
                        stream_id: StreamId::new("stream-1"),
                        track_id: TrackId::new("screen"),
                        publisher_user_id: 1,
                        kind: TrackKind::Video,
                        codec: Some(WireVideoCodec::Vp9),
                        layers,
                    },
                },
            )
            .await;

        let published = mgr
            .with_room(&room_id, |room| {
                room.participants
                    .get(&1)
                    .map(|p| p.published_tracks.len())
                    .unwrap_or(0)
            })
            .unwrap();
        assert_eq!(
            published, 0,
            "the oversized announcement must not be stored"
        );
    }

    /// The control channel had no rate limit at all — the token bucket on the
    /// datagram path covers media only, while the state-mutating and
    /// fan-out-amplifying messages all arrive here.
    #[test]
    fn control_messages_are_rate_limited_per_sender() {
        let limiter =
            SenderRateLimiter::new(MAX_CONTROL_MESSAGES_PER_SECOND, CONTROL_RATE_BURST_MESSAGES);
        let now = Instant::now();
        let user = 42i64;

        let mut allowed = 0;
        for _ in 0..(CONTROL_RATE_BURST_MESSAGES as usize * 2) {
            if limiter.try_acquire_at(user, now) {
                allowed += 1;
            }
        }
        assert_eq!(allowed, CONTROL_RATE_BURST_MESSAGES as usize);
        assert!(!limiter.try_acquire_at(user, now));

        // A different sender has its own bucket.
        assert!(limiter.try_acquire_at(user + 1, now));
    }

    #[test]
    fn keyframe_requests_are_coalesced_per_stream_track() {
        let forwarder = RelayForwarder::new(
            Arc::new(MediaRoomManager::new()),
            Arc::new(SpeakerDetector::new()),
        );
        let publisher = 1234i64;
        let stream = StreamId::new("stream-1");
        let track = TrackId::new("screen");
        let other = TrackId::new("cam");
        let start = Instant::now();

        // The first request for a (stream, track) is forwarded; an immediate
        // burst behind it coalesces into nothing.
        assert!(forwarder.allow_keyframe_request(publisher, &stream, &track, start));
        assert!(!forwarder.allow_keyframe_request(publisher, &stream, &track, start));
        assert!(!forwarder.allow_keyframe_request(
            publisher,
            &stream,
            &track,
            start + Duration::from_millis(100)
        ));

        // A different track on the same stream is throttled independently.
        assert!(forwarder.allow_keyframe_request(publisher, &stream, &other, start));

        // Once the interval elapses, a fresh request is forwarded again.
        assert!(forwarder.allow_keyframe_request(
            publisher,
            &stream,
            &track,
            start + KEYFRAME_REQUEST_MIN_INTERVAL + Duration::from_millis(1)
        ));

        // The publisher disconnecting prunes its throttle entries so they do not
        // leak when no TrackUnpublish arrives.
        forwarder.forget_keyframe_state(publisher);
        assert!(forwarder.keyframe_throttle.is_empty());
    }

    #[test]
    fn recipient_cache_reuses_and_invalidates_on_room_change() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(
            1,
            100,
            crate::participant::MediaParticipant::new(1, "s1".into()),
        )
        .unwrap();
        mgr.join_room(
            1,
            100,
            crate::participant::MediaParticipant::new(2, "s2".into()),
        )
        .unwrap();
        mgr.join_room(
            1,
            100,
            crate::participant::MediaParticipant::new(3, "s3".into()),
        )
        .unwrap();
        let room_id = mgr.get_or_create_room(1, 100);
        let mgr = Arc::new(mgr);
        let forwarder = RelayForwarder::new(Arc::clone(&mgr), Arc::new(SpeakerDetector::new()));

        // Bridged handles need no quinn connection, so the fan-out plan can be
        // resolved entirely in-process.
        for uid in [1, 2, 3] {
            let (tx, _out_rx) = mpsc::channel::<Bytes>(8);
            let (_in_tx, rx) = mpsc::channel::<Bytes>(8);
            forwarder.add_connection(ConnectionHandle::new_bridged(
                uid,
                room_id.clone(),
                tx,
                rx,
                None,
            ));
        }

        let header = audio_header(11);

        let first = forwarder.recipient_snapshot(1, &room_id, &header);
        let mut ids: Vec<i64> = first.recipients.iter().map(|h| h.user_id).collect();
        ids.sort_unstable();
        assert_eq!(ids, vec![2, 3], "sender's own audio is never echoed back");

        // Unchanged room + connection state returns the very same cached plan.
        let second = forwarder.recipient_snapshot(1, &room_id, &header);
        assert!(
            Arc::ptr_eq(&first, &second),
            "unchanged state must hit the cache"
        );

        // A room mutation (viewer 2 drops sender 1's audio) invalidates it.
        mgr.unsubscribe_participant(&room_id, 2, 1).unwrap();
        let third = forwarder.recipient_snapshot(1, &room_id, &header);
        assert!(
            !Arc::ptr_eq(&first, &third),
            "a room mutation must rebuild the plan"
        );
        let ids: Vec<i64> = third.recipients.iter().map(|h| h.user_id).collect();
        assert_eq!(ids, vec![3], "the unsubscribed viewer no longer receives");
    }

    fn video_header(ssrc: u32) -> MediaHeader {
        MediaHeader {
            version: 1,
            track_type: paracord_transport::protocol::TrackType::Video,
            simulcast_layer: 0,
            sequence: 1,
            timestamp: 123,
            ssrc,
            audio_level: 127,
            key_epoch: 1,
            payload_length: 0,
            codec: VideoCodec::Vp9.header_id(),
        }
    }

    #[test]
    fn keyframe_stream_forwards_only_to_subscribers() {
        // The uni-stream keyframe path fans out through the very same recipient
        // snapshot the datagram path uses, so a keyframe reaches precisely the
        // viewers subscribed to the track (by layer ssrc) and no one else.
        let mgr = MediaRoomManager::new();
        for uid in [1, 2, 3, 4] {
            mgr.join_room(
                1,
                100,
                crate::participant::MediaParticipant::new(uid, format!("s{uid}")),
            )
            .unwrap();
        }
        let room_id = mgr.get_or_create_room(1, 100);
        let stream_id = StreamId::new("stream-1");
        let track_id = TrackId::new("screen");
        let track = PublishedTrack {
            stream_id: stream_id.clone(),
            track_id: track_id.clone(),
            publisher_user_id: 1,
            kind: TrackKind::Video,
            codec: Some(VideoCodec::Vp9),
            layers: vec![PublishedLayer {
                layer_id: 0,
                ssrc: 500,
                width: Some(1280),
                height: Some(720),
                max_bitrate_kbps: Some(2500),
                active: true,
            }],
        };
        mgr.publish_track(&room_id, 1, track).unwrap();
        for uid in [2, 3] {
            mgr.subscribe_track(
                &room_id,
                uid,
                TrackSubscription {
                    stream_id: stream_id.clone(),
                    track_id: track_id.clone(),
                    requested_layer: Some(0),
                    active_layer: Some(0),
                    viewport: None,
                },
            )
            .unwrap();
        }

        let mgr = Arc::new(mgr);
        let forwarder = RelayForwarder::new(Arc::clone(&mgr), Arc::new(SpeakerDetector::new()));
        for uid in [1, 2, 3, 4] {
            let (tx, _out_rx) = mpsc::channel::<Bytes>(8);
            let (_in_tx, rx) = mpsc::channel::<Bytes>(8);
            forwarder.add_connection(ConnectionHandle::new_bridged(
                uid,
                room_id.clone(),
                tx,
                rx,
                None,
            ));
        }

        let snapshot = forwarder.recipient_snapshot(1, &room_id, &video_header(500));
        let mut ids: Vec<i64> = snapshot.recipients.iter().map(|h| h.user_id).collect();
        ids.sort_unstable();
        assert_eq!(
            ids,
            vec![2, 3],
            "the keyframe reaches exactly the two subscribed viewers"
        );
        assert!(
            snapshot.published_track.is_some(),
            "the published video track resolves from its layer ssrc"
        );

        // Unsubscribing removes a viewer from the keyframe fan-out.
        mgr.unsubscribe_track(&room_id, 3, &stream_id, &track_id)
            .unwrap();
        let snapshot = forwarder.recipient_snapshot(1, &room_id, &video_header(500));
        let ids: Vec<i64> = snapshot.recipients.iter().map(|h| h.user_id).collect();
        assert_eq!(
            ids,
            vec![2],
            "an unsubscribed viewer no longer receives the keyframe stream"
        );
    }

    /// The in-flight keyframe-stream queue caps outstanding streams and aborts the
    /// OLDEST once the cap is exceeded (the egress mirror of stale-stream culling).
    #[tokio::test]
    async fn enqueue_inflight_stream_aborts_oldest_beyond_cap() {
        let mut queue: VecDeque<AbortHandle> = VecDeque::new();

        // Three tasks that never complete on their own; with a cap of 2 the first
        // is evicted and aborted, leaving exactly the two newest alive.
        let h1 = tokio::spawn(std::future::pending::<()>());
        let a2 = tokio::spawn(std::future::pending::<()>());
        let a3 = tokio::spawn(std::future::pending::<()>());
        let (a2_handle, a3_handle) = (a2.abort_handle(), a3.abort_handle());

        enqueue_inflight_stream(&mut queue, h1.abort_handle(), 2);
        enqueue_inflight_stream(&mut queue, a2_handle.clone(), 2);
        enqueue_inflight_stream(&mut queue, a3_handle.clone(), 2);

        assert_eq!(queue.len(), 2, "queue is bounded at the cap");
        assert!(
            h1.await.unwrap_err().is_cancelled(),
            "the oldest in-flight stream is aborted when the cap is exceeded"
        );
        assert!(!a2_handle.is_finished(), "the newer streams stay in flight");
        assert!(
            !a3_handle.is_finished(),
            "the newest stream stays in flight"
        );

        a2_handle.abort();
        a3_handle.abort();
    }

    /// Establish a raw QUIC loopback pair, returning `(server_conn, client_conn)`.
    async fn quinn_pair() -> (quinn::Connection, quinn::Connection) {
        use paracord_transport::endpoint::{
            certificate_hash, generate_self_signed_cert, MediaEndpoint,
        };
        let tls = generate_self_signed_cert().unwrap();
        let cert_hash = certificate_hash(&tls.cert_chain[0]);
        let server = MediaEndpoint::bind("127.0.0.1:0".parse().unwrap(), tls).unwrap();
        let server_addr = server.local_addr().unwrap();
        let client = MediaEndpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();
        let client_connecting = client
            .connect_pinned(server_addr, "localhost", &cert_hash)
            .unwrap();
        let server_incoming = server.accept().await.expect("server should accept");
        let server_conn = server_incoming.accept().unwrap().await.unwrap();
        let client_conn = client_connecting.await.unwrap();
        std::mem::forget(server);
        std::mem::forget(client);
        (server_conn, client_conn)
    }

    #[tokio::test]
    async fn bridged_uni_support_requires_a_control_connection() {
        let (server_conn, _client_conn) = quinn_pair().await;

        // A bridged handle WITHOUT a control connection cannot carry uni streams:
        // this is the unreachable state the retired skip-warning now flags.
        let (tx, _out) = mpsc::channel::<Bytes>(8);
        let (_in, rx) = mpsc::channel::<Bytes>(8);
        let no_control = ConnectionHandle::new_bridged(9, "1:100".into(), tx, rx, None);
        assert!(!no_control.supports_media_uni_streams());
        assert!(no_control.accept_uni().await.is_err());
        assert!(no_control
            .send_stream_frame(0, Bytes::from_static(b"x"))
            .await
            .is_err());

        // With a control connection it carries the same uni-stream path as raw QUIC.
        let (tx, _out) = mpsc::channel::<Bytes>(8);
        let (_in, rx) = mpsc::channel::<Bytes>(8);
        let bridged = ConnectionHandle::new_bridged(9, "1:100".into(), tx, rx, Some(server_conn));
        assert!(bridged.supports_media_uni_streams());
    }

    /// A keyframe uni stream fans out to a MIXED subscriber set — one raw-QUIC and
    /// one bridged WebTransport viewer — reaching both byte-for-byte identically.
    #[tokio::test]
    async fn mixed_quic_and_bridged_subscribers_receive_identical_keyframe() {
        let mgr = MediaRoomManager::new();
        for uid in [1, 2, 3] {
            mgr.join_room(
                1,
                100,
                crate::participant::MediaParticipant::new(uid, format!("s{uid}")),
            )
            .unwrap();
        }
        let room_id = mgr.get_or_create_room(1, 100);
        let stream_id = StreamId::new("stream-1");
        let track_id = TrackId::new("screen");
        let track = PublishedTrack {
            stream_id: stream_id.clone(),
            track_id: track_id.clone(),
            publisher_user_id: 1,
            kind: TrackKind::Video,
            codec: Some(VideoCodec::Vp9),
            layers: vec![PublishedLayer {
                layer_id: 0,
                ssrc: 500,
                width: Some(1280),
                height: Some(720),
                max_bitrate_kbps: Some(2500),
                active: true,
            }],
        };
        mgr.publish_track(&room_id, 1, track).unwrap();
        for uid in [2, 3] {
            mgr.subscribe_track(
                &room_id,
                uid,
                TrackSubscription {
                    stream_id: stream_id.clone(),
                    track_id: track_id.clone(),
                    requested_layer: Some(0),
                    active_layer: Some(0),
                    viewport: None,
                },
            )
            .unwrap();
        }

        let mgr = Arc::new(mgr);
        let forwarder = RelayForwarder::new(Arc::clone(&mgr), Arc::new(SpeakerDetector::new()));

        // Viewer 2 is a raw-QUIC subscriber; viewer 3 is a bridged WebTransport
        // subscriber whose control connection carries its uni streams.
        let (quic_server, quic_client) = quinn_pair().await;
        let (bridged_server, bridged_client) = quinn_pair().await;
        forwarder.add_connection(ConnectionHandle::new(2, room_id.clone(), quic_server));
        let (tx, _out) = mpsc::channel::<Bytes>(8);
        let (_in, rx) = mpsc::channel::<Bytes>(8);
        forwarder.add_connection(ConnectionHandle::new_bridged(
            3,
            room_id.clone(),
            tx,
            rx,
            Some(bridged_server),
        ));

        // One whole-frame keyframe message: cleartext header (routed on ssrc 500)
        // plus an opaque tail the relay forwards without ever decrypting it.
        let mut body = video_header(500).to_bytes().to_vec();
        body.extend_from_slice(b"opaque-encrypted-keyframe-payload");

        forwarder
            .forward_stream_frame_to_subscribers(1, &room_id, &video_header(500), body.clone())
            .await;

        // Both viewers receive the identical bytes on a fresh uni stream.
        let read_one = |conn: quinn::Connection| async move {
            let mut recv = tokio::time::timeout(Duration::from_secs(5), conn.accept_uni())
                .await
                .expect("uni stream should arrive")
                .expect("accept_uni ok");
            recv.read_to_end(MAX_STREAM_FRAME_SIZE)
                .await
                .expect("read to FIN")
        };
        let got_quic = read_one(quic_client).await;
        let got_bridged = read_one(bridged_client).await;
        assert_eq!(got_quic, body, "raw-QUIC viewer receives identical bytes");
        assert_eq!(
            got_bridged, body,
            "bridged WebTransport viewer receives identical bytes"
        );
    }

    // ── Relay-driven per-viewer layer selection (spec §4.2) ─────────────────

    /// A three-rung screen ladder: L 800 / M 3500 / H 8000 kbps, ssrcs 10/11/12.
    fn three_layer_track(publisher: i64) -> PublishedTrack {
        PublishedTrack {
            stream_id: StreamId::new("stream-1"),
            track_id: TrackId::new("screen"),
            publisher_user_id: publisher,
            kind: TrackKind::Video,
            codec: Some(VideoCodec::Vp9),
            layers: vec![
                PublishedLayer {
                    layer_id: 0,
                    ssrc: 10,
                    width: Some(640),
                    height: Some(360),
                    max_bitrate_kbps: Some(800),
                    active: true,
                },
                PublishedLayer {
                    layer_id: 1,
                    ssrc: 11,
                    width: Some(1280),
                    height: Some(720),
                    max_bitrate_kbps: Some(3500),
                    active: true,
                },
                PublishedLayer {
                    layer_id: 2,
                    ssrc: 12,
                    width: Some(1920),
                    height: Some(1080),
                    max_bitrate_kbps: Some(8000),
                    active: true,
                },
            ],
        }
    }

    /// One whole-frame uni-stream keyframe message on a given layer.
    fn keyframe_body(track: &PublishedTrack, layer_id: u8) -> Vec<u8> {
        use paracord_transport::protocol::MediaStreamFrame;
        let ssrc = track
            .layers
            .iter()
            .find(|layer| layer.layer_id == layer_id)
            .unwrap()
            .ssrc;
        let metadata = VideoFrameMetadata {
            stream_id: track.stream_id.clone(),
            track_id: track.track_id.clone(),
            frame_id: 1,
            layer_id,
            codec: VideoCodec::Vp9,
            timestamp_us: 0,
            is_keyframe: true,
            fragment_index: 0,
            fragment_count: 1,
        };
        MediaStreamFrame {
            header: video_header(ssrc),
            metadata,
            payload: Bytes::from_static(b"keyframe-ciphertext"),
        }
        .encode()
        .unwrap()
        .to_vec()
    }

    #[test]
    fn viewport_layer_cap_maps_height_to_tier() {
        let track = three_layer_track(1);
        let cap = |h: u32| {
            viewport_layer_cap(
                &track,
                Some(&ViewportHint {
                    width: 1280,
                    height: h,
                }),
            )
        };
        // ≤400 ⇒ L, ≤800 ⇒ M, else ⇒ H (spec §4.2/I4).
        assert_eq!(cap(360), Some(0));
        assert_eq!(cap(400), Some(0));
        assert_eq!(cap(720), Some(1));
        assert_eq!(cap(800), Some(1));
        assert_eq!(cap(1080), Some(2));
        // No hint ⇒ no cap.
        assert_eq!(viewport_layer_cap(&track, None), None);
    }

    #[test]
    fn compute_target_layer_budget_downswitch_is_immediate() {
        let track = three_layer_track(1);
        // Sitting on H, but 85% of a 2 Mbps estimate (1700 kbps) only fits L.
        let mut state = LayerSelectionState::new(2);
        let target = compute_target_layer(&track, &mut state, 2000, 0.0, None, Instant::now());
        assert_eq!(
            target,
            Some(0),
            "a budget below the current layer downswitches now"
        );
    }

    #[test]
    fn compute_target_layer_viewport_caps_below_budget() {
        let track = three_layer_track(1);
        // Plenty of budget for H, but a ≤400px tile caps at L.
        let mut state = LayerSelectionState::new(2);
        let vp = ViewportHint {
            width: 640,
            height: 360,
        };
        let target =
            compute_target_layer(&track, &mut state, 20_000, 0.0, Some(&vp), Instant::now());
        assert_eq!(target, Some(0), "a small tile never receives H");
    }

    #[test]
    fn compute_target_layer_loss_steps_down_even_with_budget() {
        let track = three_layer_track(1);
        // On M with ample budget, but >2% loss forces an immediate one-rung drop.
        let mut state = LayerSelectionState::new(1);
        let target = compute_target_layer(&track, &mut state, 20_000, 0.03, None, Instant::now());
        assert_eq!(target, Some(0), "loss >2% downswitches immediately");
    }

    #[test]
    fn compute_target_layer_estimate_below_current_downswitches() {
        let track = three_layer_track(1);
        // On H (8 Mbps rung) with a 5 Mbps estimate < current layer bitrate.
        let mut state = LayerSelectionState::new(2);
        let target = compute_target_layer(&track, &mut state, 5000, 0.0, None, Instant::now());
        assert_eq!(
            target,
            Some(1),
            "an estimate below the current layer downswitches"
        );
    }

    #[test]
    fn compute_target_layer_upswitch_requires_5s_headroom() {
        let track = three_layer_track(1);
        let mut state = LayerSelectionState::new(0);
        let start = Instant::now();
        // Ample headroom for M, but the first evaluation only starts the 5s clock.
        assert_eq!(
            compute_target_layer(&track, &mut state, 20_000, 0.0, None, start),
            None,
            "an upswitch does not fire before the 5s headroom hold"
        );
        assert!(state.headroom_since.is_some());
        // After 5s of sustained headroom the upswitch steps up one rung.
        let later = start + UPSWITCH_HOLD + Duration::from_millis(1);
        assert_eq!(
            compute_target_layer(&track, &mut state, 20_000, 0.0, None, later),
            Some(1),
            "an upswitch fires after 5s of ≥125% headroom"
        );
    }

    #[test]
    fn compute_target_layer_upswitch_resets_on_headroom_dip() {
        let track = three_layer_track(1);
        let mut state = LayerSelectionState::new(0);
        let start = Instant::now();
        // Start the streak.
        compute_target_layer(&track, &mut state, 20_000, 0.0, None, start);
        assert!(state.headroom_since.is_some());
        // A dip below 125% headroom over M (3500*1.25 = 4375) resets the clock —
        // but 4000 kbps still fits M at 85% budget (3400 ≥ ... no: 85% of 4000 =
        // 3400 < 3500, so desired stays L), keeping us in an upswitch-candidate-free
        // state that clears the streak.
        compute_target_layer(
            &track,
            &mut state,
            4000,
            0.0,
            None,
            start + Duration::from_secs(1),
        );
        assert!(
            state.headroom_since.is_none(),
            "a headroom dip clears the upswitch streak"
        );
    }

    fn add_bridged(forwarder: &RelayForwarder, uid: i64, room_id: &str) {
        let (tx, _out_rx) = mpsc::channel::<Bytes>(8);
        let (_in_tx, rx) = mpsc::channel::<Bytes>(8);
        forwarder.add_connection(ConnectionHandle::new_bridged(
            uid,
            room_id.to_string(),
            tx,
            rx,
            None,
        ));
    }

    #[tokio::test]
    async fn keyframe_commit_flips_forwarded_layer_at_boundary() {
        let mgr = MediaRoomManager::new();
        for uid in [1, 2] {
            mgr.join_room(
                1,
                100,
                crate::participant::MediaParticipant::new(uid, format!("s{uid}")),
            )
            .unwrap();
        }
        let room_id = mgr.get_or_create_room(1, 100);
        let track = three_layer_track(1);
        let (stream_id, track_id) = (track.stream_id.clone(), track.track_id.clone());
        mgr.publish_track(&room_id, 1, track.clone()).unwrap();
        // Viewer 2 starts pinned to H (ssrc 12).
        mgr.subscribe_track(
            &room_id,
            2,
            TrackSubscription {
                stream_id: stream_id.clone(),
                track_id: track_id.clone(),
                requested_layer: Some(2),
                active_layer: Some(2),
                viewport: None,
            },
        )
        .unwrap();

        let mgr = Arc::new(mgr);
        let forwarder = RelayForwarder::new(Arc::clone(&mgr), Arc::new(SpeakerDetector::new()));
        add_bridged(&forwarder, 1, &room_id);
        add_bridged(&forwarder, 2, &room_id);

        // Stage a pending downswitch to L (as the selection pass would).
        forwarder.layer_selection.insert(
            (2, stream_id.clone(), track_id.clone()),
            LayerSelectionState {
                current_layer: 2,
                pending_layer: Some(0),
                headroom_since: None,
            },
        );

        // Before the keyframe, viewer 2 still receives only H (ssrc 12).
        let before = forwarder.recipient_snapshot(1, &room_id, &video_header(12));
        assert_eq!(
            before
                .recipients
                .iter()
                .map(|h| h.user_id)
                .collect::<Vec<_>>(),
            vec![2]
        );
        let before_low = forwarder.recipient_snapshot(1, &room_id, &video_header(10));
        assert!(
            before_low.recipients.is_empty(),
            "L not forwarded before the switch"
        );

        // The L keyframe arrives: the pending switch commits at its boundary.
        let body = keyframe_body(&track, 0);
        forwarder
            .forward_stream_frame_to_subscribers(1, &room_id, &video_header(10), body)
            .await;

        // Selection state and subscription both flipped to L; forwarding follows.
        let state = *forwarder
            .layer_selection
            .get(&(2, stream_id.clone(), track_id.clone()))
            .unwrap();
        assert_eq!(state.current_layer, 0);
        assert_eq!(state.pending_layer, None);
        let after_low = forwarder.recipient_snapshot(1, &room_id, &video_header(10));
        assert_eq!(
            after_low
                .recipients
                .iter()
                .map(|h| h.user_id)
                .collect::<Vec<_>>(),
            vec![2]
        );
        let after_high = forwarder.recipient_snapshot(1, &room_id, &video_header(12));
        assert!(
            after_high.recipients.is_empty(),
            "H no longer forwarded after the switch"
        );
    }

    #[tokio::test]
    async fn three_viewers_on_different_budgets_receive_different_layers() {
        let mgr = MediaRoomManager::new();
        for uid in [1, 2, 3, 4] {
            mgr.join_room(
                1,
                100,
                crate::participant::MediaParticipant::new(uid, format!("s{uid}")),
            )
            .unwrap();
        }
        let room_id = mgr.get_or_create_room(1, 100);
        let track = three_layer_track(1);
        let (stream_id, track_id) = (track.stream_id.clone(), track.track_id.clone());
        mgr.publish_track(&room_id, 1, track.clone()).unwrap();
        // All three viewers start pinned to H; each downswitches per its budget.
        for uid in [2, 3, 4] {
            mgr.subscribe_track(
                &room_id,
                uid,
                TrackSubscription {
                    stream_id: stream_id.clone(),
                    track_id: track_id.clone(),
                    requested_layer: Some(2),
                    active_layer: Some(2),
                    viewport: None,
                },
            )
            .unwrap();
        }

        let mgr = Arc::new(mgr);
        let forwarder = RelayForwarder::new(Arc::clone(&mgr), Arc::new(SpeakerDetector::new()));
        for uid in [1, 2, 3, 4] {
            add_bridged(&forwarder, uid, &room_id);
        }

        // Distinct downlink budgets via cwnd/RTT (kbps = cwnd*8*1000 / rtt_us):
        // viewer 2 ≈ 1.5 Mbps (→L), viewer 3 ≈ 5 Mbps (→M), viewer 4 ≈ 15 Mbps (→H).
        let now = Instant::now();
        let rtt = Duration::from_millis(20);
        forwarder
            .downlink_estimator
            .record_sample_at(2, 3_750, rtt, 1000, 0, now);
        forwarder
            .downlink_estimator
            .record_sample_at(3, 12_500, rtt, 1000, 0, now);
        forwarder
            .downlink_estimator
            .record_sample_at(4, 37_500, rtt, 1000, 0, now);

        // Run the relay's selection for each viewer; it stages keyframe-gated
        // switches (viewer 4 already at its target stages nothing).
        for uid in [2, 3, 4] {
            forwarder.run_layer_selection(uid, &room_id).await;
        }
        assert_eq!(
            forwarder
                .layer_selection
                .get(&(2, stream_id.clone(), track_id.clone()))
                .unwrap()
                .pending_layer,
            Some(0)
        );
        assert_eq!(
            forwarder
                .layer_selection
                .get(&(3, stream_id.clone(), track_id.clone()))
                .unwrap()
                .pending_layer,
            Some(1)
        );

        // The next keyframe on each staged layer commits that viewer's switch.
        forwarder
            .forward_stream_frame_to_subscribers(
                1,
                &room_id,
                &video_header(10),
                keyframe_body(&track, 0),
            )
            .await;
        forwarder
            .forward_stream_frame_to_subscribers(
                1,
                &room_id,
                &video_header(11),
                keyframe_body(&track, 1),
            )
            .await;

        // One publisher, three viewers, three different layers: each layer's ssrc
        // fans out to exactly the viewer selected onto it.
        let recipients = |ssrc: u32| {
            let mut ids: Vec<i64> = forwarder
                .recipient_snapshot(1, &room_id, &video_header(ssrc))
                .recipients
                .iter()
                .map(|h| h.user_id)
                .collect();
            ids.sort_unstable();
            ids
        };
        assert_eq!(recipients(10), vec![2], "L (ssrc 10) → the 1.5 Mbps viewer");
        assert_eq!(recipients(11), vec![3], "M (ssrc 11) → the 5 Mbps viewer");
        assert_eq!(recipients(12), vec![4], "H (ssrc 12) → the 15 Mbps viewer");
    }
}
