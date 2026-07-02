use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use tracing::{debug, info, warn};

/// Timeout for P2P hole punch attempts before falling back to relay.
const P2P_TIMEOUT: Duration = Duration::from_secs(3);

/// Status of a P2P connection attempt between two peers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum P2PStatus {
    /// Hole punch attempt is in progress.
    Attempting,
    /// Direct P2P connection established.
    Established,
    /// Hole punch failed; using relay instead.
    FailedUsingRelay,
}

/// Unique key for a peer pair (always ordered so (a,b) == (b,a)).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct PeerPair(i64, i64);

impl PeerPair {
    fn new(a: i64, b: i64) -> Self {
        if a < b {
            Self(a, b)
        } else {
            Self(b, a)
        }
    }
}

/// State of a P2P connection between two peers.
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct PeerConnection {
    status: P2PStatus,
    addr_a: Option<SocketAddr>,
    addr_b: Option<SocketAddr>,
}

/// Coordinates P2P connections between participants in the same room.
///
/// When two Tauri desktop clients are in the same room, the coordinator
/// exchanges their public addresses and monitors hole-punch success.
/// After a 3-second timeout, participants fall back to relay.
pub struct P2PCoordinator {
    /// Map of peer pairs to their connection state.
    connections: DashMap<PeerPair, PeerConnection>,
    /// Map of user_id -> their public address.
    peer_addresses: DashMap<i64, SocketAddr>,
}

impl P2PCoordinator {
    pub fn new() -> Self {
        Self {
            connections: DashMap::new(),
            peer_addresses: DashMap::new(),
        }
    }

    /// Register a peer's public address (learned from their QUIC connection).
    pub fn register_address(&self, user_id: i64, addr: SocketAddr) {
        info!(user_id, addr = %addr, "p2p: registered peer address");
        self.peer_addresses.insert(user_id, addr);
    }

    /// Remove a peer's address when they disconnect.
    pub fn remove_address(&self, user_id: i64) {
        self.peer_addresses.remove(&user_id);
        // Remove all connection state involving this user.
        self.connections
            .retain(|pair, _| pair.0 != user_id && pair.1 != user_id);
    }

    /// Get a peer's public address.
    pub fn get_address(&self, user_id: i64) -> Option<SocketAddr> {
        self.peer_addresses.get(&user_id).map(|r| *r)
    }

    /// Initiate a P2P connection attempt between two peers.
    /// Returns the other peer's address if available.
    pub fn initiate_p2p(&self, user_a: i64, user_b: i64) -> Option<SocketAddr> {
        let pair = PeerPair::new(user_a, user_b);

        let addr_a = self.peer_addresses.get(&user_a).map(|r| *r);
        let addr_b = self.peer_addresses.get(&user_b).map(|r| *r);

        self.connections.insert(
            pair,
            PeerConnection {
                status: P2PStatus::Attempting,
                addr_a,
                addr_b,
            },
        );

        debug!(
            user_a,
            user_b,
            addr_a = ?addr_a,
            addr_b = ?addr_b,
            "p2p: initiating hole punch"
        );

        // Return the other peer's address to the requester
        if user_a < user_b {
            addr_b
        } else {
            addr_a
        }
    }

    /// Mark a P2P connection as established.
    pub fn mark_established(&self, user_a: i64, user_b: i64) {
        let pair = PeerPair::new(user_a, user_b);
        if let Some(mut conn) = self.connections.get_mut(&pair) {
            conn.status = P2PStatus::Established;
            info!(user_a, user_b, "p2p: connection established");
        }
    }

    /// Mark a P2P connection as failed, falling back to relay.
    pub fn mark_failed(&self, user_a: i64, user_b: i64) {
        let pair = PeerPair::new(user_a, user_b);
        if let Some(mut conn) = self.connections.get_mut(&pair) {
            conn.status = P2PStatus::FailedUsingRelay;
            warn!(user_a, user_b, "p2p: hole punch failed, using relay");
        }
    }

    /// Get the P2P status between two peers.
    pub fn get_status(&self, user_a: i64, user_b: i64) -> Option<P2PStatus> {
        let pair = PeerPair::new(user_a, user_b);
        self.connections.get(&pair).map(|c| c.status)
    }

    /// Spawn a timeout task for a P2P connection attempt.
    /// If the connection is still in "Attempting" state after the timeout,
    /// it's marked as failed.
    pub fn spawn_timeout(self: &Arc<Self>, user_a: i64, user_b: i64) {
        let coordinator = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(P2P_TIMEOUT).await;
            let pair = PeerPair::new(user_a, user_b);
            if let Some(mut conn) = coordinator.connections.get_mut(&pair) {
                if conn.status == P2PStatus::Attempting {
                    conn.status = P2PStatus::FailedUsingRelay;
                    warn!(
                        user_a,
                        user_b,
                        "p2p: timeout after {}s, falling back to relay",
                        P2P_TIMEOUT.as_secs()
                    );
                }
            }
        });
    }

    /// Get all peer addresses for participants in a room (for exchanging endpoints).
    pub fn get_room_peer_addresses(&self, user_ids: &[i64]) -> HashMap<i64, SocketAddr> {
        let mut result = HashMap::new();
        for &uid in user_ids {
            if let Some(addr) = self.peer_addresses.get(&uid) {
                result.insert(uid, *addr);
            }
        }
        result
    }
}

impl Default for P2PCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_and_get_address() {
        let coord = P2PCoordinator::new();
        let addr: SocketAddr = "1.2.3.4:5000".parse().unwrap();
        coord.register_address(1, addr);
        assert_eq!(coord.get_address(1), Some(addr));
        assert_eq!(coord.get_address(2), None);
    }

    #[test]
    fn initiate_p2p_returns_other_addr() {
        let coord = P2PCoordinator::new();
        let addr_a: SocketAddr = "1.2.3.4:5000".parse().unwrap();
        let addr_b: SocketAddr = "5.6.7.8:6000".parse().unwrap();
        coord.register_address(1, addr_a);
        coord.register_address(2, addr_b);

        let result = coord.initiate_p2p(1, 2);
        assert_eq!(result, Some(addr_b));
        assert_eq!(coord.get_status(1, 2), Some(P2PStatus::Attempting));
    }

    #[test]
    fn peer_pair_symmetry() {
        let pair1 = PeerPair::new(1, 2);
        let pair2 = PeerPair::new(2, 1);
        assert_eq!(pair1, pair2);
    }

    #[test]
    fn mark_established() {
        let coord = P2PCoordinator::new();
        coord.initiate_p2p(1, 2);
        coord.mark_established(1, 2);
        assert_eq!(coord.get_status(1, 2), Some(P2PStatus::Established));
    }

    #[test]
    fn mark_failed() {
        let coord = P2PCoordinator::new();
        coord.initiate_p2p(1, 2);
        coord.mark_failed(2, 1); // reversed order should still work
        assert_eq!(coord.get_status(1, 2), Some(P2PStatus::FailedUsingRelay));
    }

    #[test]
    fn remove_address_cleans_up() {
        let coord = P2PCoordinator::new();
        let addr: SocketAddr = "1.2.3.4:5000".parse().unwrap();
        coord.register_address(1, addr);
        coord.initiate_p2p(1, 2);

        coord.remove_address(1);
        assert_eq!(coord.get_address(1), None);
        assert_eq!(coord.get_status(1, 2), None);
    }

    #[test]
    fn get_room_peer_addresses() {
        let coord = P2PCoordinator::new();
        let addr1: SocketAddr = "1.2.3.4:5000".parse().unwrap();
        let addr2: SocketAddr = "5.6.7.8:6000".parse().unwrap();
        coord.register_address(1, addr1);
        coord.register_address(2, addr2);

        let addrs = coord.get_room_peer_addresses(&[1, 2, 3]);
        assert_eq!(addrs.len(), 2);
        assert_eq!(addrs[&1], addr1);
        assert_eq!(addrs[&2], addr2);
    }
}
