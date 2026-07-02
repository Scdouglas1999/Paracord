use std::sync::Arc;

use bytes::Bytes;
use dashmap::DashMap;
use tokio::sync::{mpsc, Mutex, Notify};
use tracing::{debug, info, warn};

use paracord_transport::control::{ControlMessage, SessionParticipant};
use paracord_transport::protocol::{MediaHeader, HEADER_SIZE};
use paracord_transport::stream::{PublishedTrack, StreamId, TrackId, VideoCodecCapability};

use crate::room::MediaRoomManager;
use crate::speaker::SpeakerDetector;

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

        // Find all participants subscribed to this sender
        let mut forward_count = 0u32;
        for participant in room.participants.values() {
            if participant.user_id == sender_id
                && matches!(
                    header.track_type,
                    paracord_transport::protocol::TrackType::Audio
                )
            {
                continue;
            }
            if participant.deafened {
                continue;
            }
            if !should_forward_to_participant(
                participant,
                sender_id,
                header,
                published_track.as_ref(),
            ) {
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
                if let Some(track) = self.resolve_any_published_track(
                    room_id,
                    &subscription.stream_id,
                    &subscription.track_id,
                ) {
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
                }
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
                if let Err(err) = self.room_manager.update_track_subscription(
                    room_id,
                    user_id,
                    &stream_id,
                    &track_id,
                    active_layer,
                    viewport.clone(),
                ) {
                    warn!(
                        user_id,
                        room_id = %room_id,
                        error = %err,
                        "relay: failed to update track subscription from receiver report"
                    );
                }
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
            ControlMessage::SessionState { .. }
            | ControlMessage::SessionParticipantJoin { .. }
            | ControlMessage::SessionParticipantLeave { .. }
            | ControlMessage::Auth { .. }
            | ControlMessage::Subscribe { .. }
            | ControlMessage::Unsubscribe { .. }
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
}
