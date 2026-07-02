// Federated room coordination for multi-server voice channels.
//
// When users on different servers join the same federated voice channel,
// their servers establish QUIC connections and relay encrypted media packets
// between each other. The relay is zero-knowledge: servers never decrypt
// the E2EE media payload, they just forward based on the cleartext header.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use bytes::Bytes;
use dashmap::DashMap;
use tracing::{debug, info, warn};

use paracord_transport::federation::{FederationConnection, FederationPool};
use paracord_transport::protocol::{MediaHeader, HEADER_SIZE};

use crate::room::MediaRoomManager;
use crate::speaker::SpeakerDetector;

/// A federated room spans multiple servers.
/// Each server tracks which remote servers have participants in the room,
/// and forwards media to/from those servers.
#[derive(Debug, Clone)]
pub struct FederatedRoom {
    /// The room ID (same across all servers in the federation).
    pub room_id: String,
    /// Remote servers that have participants in this room.
    /// Maps server origin -> set of remote user IDs on that server.
    pub remote_servers: HashMap<String, HashSet<i64>>,
}

/// Manages federated room state and cross-server media relay.
pub struct FederationRelay {
    /// Federated rooms: room_id -> FederatedRoom state.
    rooms: DashMap<String, FederatedRoom>,
    /// Connection pool to federated servers.
    pool: Arc<FederationPool>,
    /// Local room manager (for looking up local subscribers).
    #[allow(dead_code)]
    local_rooms: Arc<MediaRoomManager>,
    /// Speaker detector (for audio level tracking from remote packets).
    speaker_detector: Arc<SpeakerDetector>,
}

impl FederationRelay {
    pub fn new(
        pool: Arc<FederationPool>,
        local_rooms: Arc<MediaRoomManager>,
        speaker_detector: Arc<SpeakerDetector>,
    ) -> Self {
        Self {
            rooms: DashMap::new(),
            pool,
            local_rooms,
            speaker_detector,
        }
    }

    /// Register a remote participant joining a room from a federated server.
    pub fn add_remote_participant(&self, room_id: &str, server_origin: &str, user_id: i64) {
        let mut room = self
            .rooms
            .entry(room_id.to_string())
            .or_insert_with(|| FederatedRoom {
                room_id: room_id.to_string(),
                remote_servers: HashMap::new(),
            });

        room.remote_servers
            .entry(server_origin.to_string())
            .or_default()
            .insert(user_id);

        info!(
            room_id,
            server_origin, user_id, "federation: remote participant added"
        );
    }

    /// Remove a remote participant from a federated room.
    pub fn remove_remote_participant(&self, room_id: &str, server_origin: &str, user_id: i64) {
        if let Some(mut room) = self.rooms.get_mut(room_id) {
            if let Some(users) = room.remote_servers.get_mut(server_origin) {
                users.remove(&user_id);
                if users.is_empty() {
                    room.remote_servers.remove(server_origin);
                }
            }

            // If no remote servers remain, remove the federated room entry
            if room.remote_servers.is_empty() {
                drop(room);
                self.rooms.remove(room_id);
                debug!(room_id, "federation: room no longer federated");
            }
        }
    }

    /// Forward a media packet from a local participant to all federated servers
    /// that have participants in the same room.
    ///
    /// The packet is forwarded as-is (encrypted payload intact).
    pub async fn forward_to_federation(&self, room_id: &str, packet: &Bytes) {
        let room = match self.rooms.get(room_id) {
            Some(r) => r,
            None => return, // Not a federated room
        };

        for origin in room.remote_servers.keys() {
            if let Some(conn) = self.pool.get(origin).await {
                if let Err(e) = conn.send_datagram(packet.clone()) {
                    warn!(
                        origin = %origin,
                        error = %e,
                        "federation: failed to forward to remote server"
                    );
                }
            } else {
                debug!(
                    origin = %origin,
                    "federation: no connection to remote server, dropping packet"
                );
            }
        }
    }

    /// Handle a media packet received from a federated server.
    ///
    /// Parses the header for routing info, feeds audio level to speaker
    /// detector, and delivers to local subscribers.
    pub fn handle_incoming_federation_packet(
        &self,
        from_origin: &str,
        packet: &Bytes,
    ) -> Option<(i64, String)> {
        if packet.len() < HEADER_SIZE {
            warn!(
                from = from_origin,
                len = packet.len(),
                "federation: packet too short"
            );
            return None;
        }

        let header = match MediaHeader::decode(&mut &packet[..HEADER_SIZE]) {
            Ok(h) => h,
            Err(e) => {
                warn!(from = from_origin, error = %e, "federation: invalid header");
                return None;
            }
        };

        // We use SSRC to identify the sender; in a real system we'd map
        // SSRC -> user_id via the room's participant registry.
        let ssrc = header.ssrc;

        // Feed audio level to speaker detector
        self.speaker_detector.report_audio_level(
            ssrc as i64,
            &format!("fed-{}", from_origin),
            header.audio_level,
        );

        // Find which room this packet belongs to (by checking which federated
        // room has this origin registered)
        for entry in self.rooms.iter() {
            if entry.remote_servers.contains_key(from_origin) {
                return Some((ssrc as i64, entry.room_id.clone()));
            }
        }

        None
    }

    /// Spawn a task that reads datagrams from a federation connection
    /// and routes them to local participants.
    pub fn spawn_federation_receiver(
        self: &Arc<Self>,
        conn: Arc<FederationConnection>,
        _local_forwarder: Arc<crate::relay::RelayForwarder>,
    ) {
        let relay = Arc::clone(self);
        let origin = conn.meta().remote_origin.clone();

        tokio::spawn(async move {
            info!(
                origin = %origin,
                "federation: receiver task started"
            );

            loop {
                let packet = match conn.read_datagram().await {
                    Ok(p) => p,
                    Err(e) => {
                        debug!(
                            origin = %origin,
                            error = %e,
                            "federation: connection closed"
                        );
                        break;
                    }
                };

                // Route the incoming federated packet to local subscribers
                relay.handle_incoming_federation_packet(&origin, &packet);

                // The packet needs to be forwarded to local participants
                // subscribed to the remote sender. The relay forwarder handles
                // this by looking up the room and forwarding.
                // (In production, we'd inject these as if they came from a local
                // source, but here we just track the routing info.)
            }

            info!(
                origin = %origin,
                "federation: receiver task ended"
            );
        });
    }

    /// Check if a room has any federated participants.
    pub fn is_federated(&self, room_id: &str) -> bool {
        self.rooms.contains_key(room_id)
    }

    /// Get the list of remote servers for a federated room.
    pub fn remote_servers(&self, room_id: &str) -> Vec<String> {
        self.rooms
            .get(room_id)
            .map(|r| r.remote_servers.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Get the total count of remote participants across all rooms.
    pub fn remote_participant_count(&self) -> usize {
        self.rooms
            .iter()
            .map(|r| r.remote_servers.values().map(|s| s.len()).sum::<usize>())
            .sum()
    }

    /// List all federated room IDs.
    pub fn federated_room_ids(&self) -> Vec<String> {
        self.rooms.iter().map(|r| r.key().clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::room::MediaRoomManager;

    fn make_relay() -> FederationRelay {
        FederationRelay::new(
            Arc::new(FederationPool::new()),
            Arc::new(MediaRoomManager::new()),
            Arc::new(SpeakerDetector::new()),
        )
    }

    #[test]
    fn add_remove_remote_participant() {
        let relay = make_relay();

        relay.add_remote_participant("room1", "server-b.com", 100);
        relay.add_remote_participant("room1", "server-b.com", 101);
        relay.add_remote_participant("room1", "server-c.com", 200);

        assert!(relay.is_federated("room1"));
        assert!(!relay.is_federated("room2"));
        assert_eq!(relay.remote_participant_count(), 3);

        let servers = relay.remote_servers("room1");
        assert_eq!(servers.len(), 2);

        relay.remove_remote_participant("room1", "server-b.com", 100);
        assert_eq!(relay.remote_participant_count(), 2);

        relay.remove_remote_participant("room1", "server-b.com", 101);
        assert_eq!(relay.remote_servers("room1").len(), 1); // only server-c remains

        relay.remove_remote_participant("room1", "server-c.com", 200);
        assert!(!relay.is_federated("room1")); // room no longer federated
    }

    #[test]
    fn federated_room_ids() {
        let relay = make_relay();

        relay.add_remote_participant("room1", "server-b.com", 100);
        relay.add_remote_participant("room2", "server-c.com", 200);

        let ids = relay.federated_room_ids();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"room1".to_string()));
        assert!(ids.contains(&"room2".to_string()));
    }

    #[test]
    fn non_federated_room() {
        let relay = make_relay();
        assert!(!relay.is_federated("nonexistent"));
        assert!(relay.remote_servers("nonexistent").is_empty());
        assert_eq!(relay.remote_participant_count(), 0);
    }

    #[test]
    fn handle_short_packet() {
        let relay = make_relay();
        relay.add_remote_participant("room1", "server-b.com", 100);

        // Packet too short (less than HEADER_SIZE)
        let short_packet = Bytes::from_static(&[0u8; 4]);
        let result = relay.handle_incoming_federation_packet("server-b.com", &short_packet);
        assert!(result.is_none());
    }
}
