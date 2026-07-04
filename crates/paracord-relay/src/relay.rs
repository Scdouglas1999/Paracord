use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use bytes::Bytes;
use dashmap::DashMap;
use tokio::sync::{mpsc, Mutex, Notify};
use tokio::time::MissedTickBehavior;
use tracing::{debug, info, warn};

use paracord_transport::control::{ControlMessage, SessionParticipant, TrackKind};
use paracord_transport::protocol::{MediaHeader, HEADER_SIZE};
use paracord_transport::stream::{PublishedTrack, StreamId, TrackId, VideoCodecCapability};

use crate::bandwidth::BandwidthEstimator;
use crate::room::MediaRoomManager;
use crate::speaker::SpeakerDetector;

/// Maximum sustained media packets per second a single sender may forward.
///
/// The relay clones every accepted datagram to every subscriber, so an
/// unthrottled sender amplifies proportionally to the room size. This ceiling
/// caps a single authenticated participant's ingress. It is a per-sender rate
/// across all of that sender's tracks (audio + simulcast video). A busy sender
/// carrying stereo Opus at 50 pps plus several simulcast video layers stays
/// comfortably under this; sustained traffic above it is abusive.
const MAX_SENDER_PACKETS_PER_SECOND: f64 = 1500.0;

/// Burst allowance for the sender rate limiter, expressed in packets.
///
/// The token bucket is allowed to accumulate up to this many tokens so brief,
/// legitimate bursts (e.g. a video keyframe fragmented across many datagrams)
/// are not dropped, while the long-run average is still bounded by
/// [`MAX_SENDER_PACKETS_PER_SECOND`].
const SENDER_RATE_BURST_PACKETS: f64 = 3000.0;

/// Interval between QUIC path-stat samples for one connection.
const BANDWIDTH_SAMPLE_INTERVAL: Duration = Duration::from_secs(2);

/// Force a `BandwidthFeedback` at least this often even if the estimate is stable.
const BANDWIDTH_FEEDBACK_MAX_INTERVAL: Duration = Duration::from_secs(30);

/// Minimum relative change (10%) before emitting an out-of-band feedback update.
const BANDWIDTH_FEEDBACK_CHANGE_RATIO: f64 = 0.10;

/// Receiver reports above this loss rate may trigger a server-side layer downgrade.
const HIGH_PACKET_LOSS_PPM: u32 = 50_000;

static RELAY_VIDEO_FORWARD_DEBUG_COUNT: AtomicU32 = AtomicU32::new(0);

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
    /// framing) and raw media packets.
    Bridged {
        outbound_tx: mpsc::UnboundedSender<Bytes>,
        inbound_rx: Arc<Mutex<mpsc::UnboundedReceiver<Bytes>>>,
        control_conn: Option<quinn::Connection>,
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
            } => Self::Bridged {
                outbound_tx: outbound_tx.clone(),
                inbound_rx: Arc::clone(inbound_rx),
                control_conn: control_conn.clone(),
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
        outbound_tx: mpsc::UnboundedSender<Bytes>,
        inbound_rx: mpsc::UnboundedReceiver<Bytes>,
        control_conn: Option<quinn::Connection>,
    ) -> Self {
        Self {
            user_id,
            room_id,
            transport: MediaTransport::Bridged {
                outbound_tx,
                inbound_rx: Arc::new(Mutex::new(inbound_rx)),
                control_conn,
            },
        }
    }

    /// Send a datagram to this connection.
    pub fn send_datagram(&self, data: Bytes) -> Result<(), quinn::SendDatagramError> {
        match &self.transport {
            MediaTransport::Quic(conn) => conn.send_datagram(data),
            MediaTransport::Bridged { outbound_tx, .. } => outbound_tx.send(data).map_err(|_| {
                quinn::SendDatagramError::ConnectionLost(quinn::ConnectionError::LocallyClosed)
            }),
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
    /// Per-connection QUIC bandwidth estimates driving adaptation feedback.
    bandwidth_estimator: BandwidthEstimator,
    /// Notify signal for shutdown.
    shutdown: Notify,
}

#[derive(Clone, Debug)]
struct ActiveSessionInfo {
    room_id: String,
    session_id: String,
    video_capabilities: Vec<VideoCodecCapability>,
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
            bandwidth_estimator: BandwidthEstimator::new(),
            shutdown: Notify::new(),
        }
    }

    /// Register a new participant connection for relay forwarding.
    pub fn add_connection(&self, handle: ConnectionHandle) {
        let user_id = handle.user_id;
        let room_id = handle.room_id.clone();
        info!(user_id, room_id = %room_id, "relay: participant connected");
        self.connections.insert(user_id, handle);
    }

    /// Remove a participant's connection.
    pub fn remove_connection(&self, user_id: i64) {
        if self.connections.remove(&user_id).is_some() {
            info!(user_id, "relay: participant disconnected");
        }
    }

    /// Spawn the forwarding loop for a single participant.
    /// This task reads datagrams from the participant and forwards them
    /// to all subscribed recipients.
    pub fn spawn_forwarding_task(self: &Arc<Self>, handle: ConnectionHandle) {
        let forwarder = Arc::clone(self);
        let user_id = handle.user_id;
        let room_id = handle.room_id.clone();

        forwarder.spawn_bandwidth_task(handle.clone());

        tokio::spawn(async move {
            info!(user_id, room_id = %room_id, "relay: forwarding task started");

            loop {
                let datagram = tokio::select! {
                    result = handle.read_datagram() => {
                        match result {
                            Ok(data) => data,
                            Err(e) => {
                                debug!(user_id, error = %e, "relay: connection closed");
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

                // Feed audio level to speaker detector
                forwarder.speaker_detector.report_audio_level(
                    user_id,
                    &room_id,
                    header.audio_level,
                );

                // Look up the sender's room and find subscribers
                forwarder.forward_to_subscribers(user_id, &room_id, &header, &datagram);
            }

            // Clean up on disconnect
            let had_active_session = forwarder.active_sessions.remove(&user_id).is_some();
            forwarder.sender_rate_limiter.forget(user_id);
            forwarder.bandwidth_estimator.remove_user(user_id);
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
            info!(user_id, room_id = %room_id, "relay: forwarding task ended");
        });
    }

    /// Periodically sample QUIC path stats and emit `BandwidthFeedback` to the
    /// participant. Runs on its own task so the datagram fan-out loop is never
    /// blocked or delayed by congestion estimation.
    fn spawn_bandwidth_task(self: &Arc<Self>, handle: ConnectionHandle) {
        let forwarder = Arc::clone(self);
        let user_id = handle.user_id;

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

                let Some(conn) = handle.quinn_connection() else {
                    continue;
                };

                forwarder
                    .bandwidth_estimator
                    .update_from_connection(user_id, conn);
                let available_kbps = forwarder.bandwidth_estimator.available_kbps(user_id);

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
        });
    }

    /// Spawn the control-stream loop for a single participant.
    pub fn spawn_control_task(self: &Arc<Self>, handle: ConnectionHandle) {
        let forwarder = Arc::clone(self);
        let user_id = handle.user_id;
        let room_id = handle.room_id.clone();

        tokio::spawn(async move {
            info!(user_id, room_id = %room_id, "relay: control task started");

            loop {
                let (_send, mut recv) = tokio::select! {
                    result = handle.accept_bi() => {
                        match result {
                            Ok(streams) => streams,
                            Err(err) => {
                                debug!(user_id, error = %err, "relay: control task stopping");
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

            info!(user_id, room_id = %room_id, "relay: control task ended");
        });
    }

    /// Forward a complete packet (header + encrypted payload) to all subscribers.
    fn forward_to_subscribers(
        &self,
        sender_id: i64,
        room_id: &str,
        header: &MediaHeader,
        packet: &Bytes,
    ) {
        let room = match self.room_manager.get_room(room_id) {
            Some(r) => r,
            None => return,
        };
        let published_track = resolve_published_track_for_ssrc(&room, sender_id, header.ssrc);
        let video_debug_index = if matches!(
            header.track_type,
            paracord_transport::protocol::TrackType::Video
        ) {
            Some(RELAY_VIDEO_FORWARD_DEBUG_COUNT.fetch_add(1, Ordering::Relaxed))
        } else {
            None
        };

        // Find all participants subscribed to this sender
        let mut forward_count = 0u32;
        for participant in room.participants.values() {
            if !should_relay_packet_to(participant, sender_id, header, published_track.as_ref()) {
                continue;
            }

            // Look up the recipient's connection handle
            if let Some(recipient_conn) = self.connections.get(&participant.user_id) {
                if let Err(e) = recipient_conn.send_datagram(packet.clone()) {
                    debug!(
                        sender = sender_id,
                        recipient = participant.user_id,
                        error = %e,
                        "relay: failed to forward datagram"
                    );
                }
                forward_count += 1;
            }
        }

        if forward_count > 0 {
            debug!(
                sender = sender_id,
                recipients = forward_count,
                "relay: forwarded datagram"
            );
        }
        if let Some(debug_index) = video_debug_index {
            if debug_index < 48 {
                warn!(
                    sender = sender_id,
                    room_id = %room_id,
                    ssrc = header.ssrc,
                    seq = header.sequence,
                    layer = header.simulcast_layer,
                    epoch = header.key_epoch,
                    has_track = published_track.is_some(),
                    recipients = forward_count,
                    "relay-video-debug: routed video datagram"
                );
            }
        }
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
                if let Some(track) =
                    self.resolve_any_published_track(room_id, &stream_id, &track_id)
                {
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
            }
            ControlMessage::ReceiverReport {
                stream_id,
                track_id,
                active_layer,
                viewport,
                estimated_bitrate_kbps,
                packet_loss_ppm,
            } => {
                let track = self.resolve_any_published_track(room_id, &stream_id, &track_id);
                let path_kbps = self.bandwidth_estimator.available_kbps(user_id);
                let budget_kbps =
                    receiver_budget_kbps(estimated_bitrate_kbps, packet_loss_ppm, path_kbps);
                let congestion_layer = track
                    .as_ref()
                    .and_then(|t| suggest_layer_for_budget(t, budget_kbps));
                let effective_active_layer = match active_layer {
                    Some(layer) if packet_loss_ppm < HIGH_PACKET_LOSS_PPM => Some(layer),
                    _ => active_layer.or(congestion_layer),
                };

                let subscription_changed = match self.room_manager.update_track_subscription(
                    room_id,
                    user_id,
                    &stream_id,
                    &track_id,
                    effective_active_layer,
                    viewport.clone(),
                ) {
                    Ok(updated) => {
                        updated
                            && effective_active_layer.is_some()
                            && effective_active_layer != active_layer
                    }
                    Err(err) => {
                        warn!(
                            user_id,
                            room_id = %room_id,
                            error = %err,
                            "relay: failed to update track subscription from receiver report"
                        );
                        false
                    }
                };

                if subscription_changed {
                    self.send_control_to_user(
                        user_id,
                        &ControlMessage::SubscriptionAck {
                            stream_id: stream_id.clone(),
                            track_id: track_id.clone(),
                            layer_id: effective_active_layer,
                            active: true,
                        },
                    )
                    .await;
                }

                if let Some(track) = track {
                    self.send_control_to_user(
                        track.publisher_user_id,
                        &ControlMessage::ReceiverReport {
                            stream_id,
                            track_id,
                            active_layer: effective_active_layer,
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
                for (recipient_user_id, ciphertext) in encrypted_keys {
                    if let Err(err) = self.room_manager.store_track_key(
                        room_id,
                        user_id,
                        &stream_id,
                        &track_id,
                        epoch,
                        recipient_user_id,
                        ciphertext.clone(),
                    ) {
                        warn!(
                            user_id,
                            recipient_user_id,
                            room_id = %room_id,
                            error = %err,
                            "relay: failed to store published track key"
                        );
                    }
                    self.send_control_to_user(
                        recipient_user_id,
                        &ControlMessage::StreamKeyDeliver {
                            stream_id: stream_id.clone(),
                            track_id: track_id.clone(),
                            sender_user_id: user_id,
                            epoch,
                            ciphertext,
                        },
                    )
                    .await;
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
                for (recipient_user_id, ciphertext) in encrypted_keys {
                    self.send_control_to_user(
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

/// Merge the viewer's receive estimate with the relay's QUIC path budget and
/// discount for observed packet loss.
fn receiver_budget_kbps(
    estimated_bitrate_kbps: u32,
    packet_loss_ppm: u32,
    path_available_kbps: u32,
) -> u32 {
    let mut budget = estimated_bitrate_kbps.min(path_available_kbps);
    if packet_loss_ppm > 0 {
        let loss = (packet_loss_ppm as f64 / 1_000_000.0).clamp(0.0, 0.9);
        budget = ((budget as f64) * (1.0 - loss)).max(100.0) as u32;
    }
    budget
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
    fn receiver_budget_respects_path_and_loss() {
        assert_eq!(receiver_budget_kbps(5000, 0, 3000), 3000);
        let lossy = receiver_budget_kbps(5000, 100_000, 5000);
        assert!(lossy < 5000);
        assert!(lossy >= 100);
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
}
