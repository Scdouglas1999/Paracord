// Server-to-server QUIC connection with Ed25519 authenticated handshake.
//
// When two federated Paracord servers need to relay media for a cross-server
// voice channel, they establish an authenticated QUIC connection. The handshake
// uses Ed25519 signing (same key infrastructure as `paracord-federation`) to
// prove server identity, then media datagrams are relayed over the connection.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use quinn::Connection;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tracing::{debug, error, info};

use crate::endpoint::MediaEndpoint;

/// Maximum age of a federation handshake challenge before it's rejected (30 seconds).
const CHALLENGE_MAX_AGE_SECS: u64 = 30;

/// Federation handshake message sent by the initiating server.
#[derive(Debug, Serialize, Deserialize)]
pub struct FederationHello {
    /// The server's origin (e.g. "chat.example.com").
    pub origin: String,
    /// Ed25519 public key (hex-encoded, 64 chars).
    pub public_key: String,
    /// Timestamp (unix seconds) for freshness.
    pub timestamp: u64,
    /// Signature of `origin || timestamp` proving ownership of the private key.
    pub signature: String,
}

/// Federation handshake response from the accepting server.
#[derive(Debug, Serialize, Deserialize)]
pub struct FederationAccept {
    /// The accepting server's origin.
    pub origin: String,
    /// Ed25519 public key (hex-encoded).
    pub public_key: String,
    /// Timestamp.
    pub timestamp: u64,
    /// Signature of `origin || timestamp || initiator_origin`.
    pub signature: String,
}

/// Metadata for an authenticated federation connection.
#[derive(Debug, Clone)]
pub struct FederationMeta {
    /// The remote server's origin.
    pub remote_origin: String,
    /// The remote server's Ed25519 public key (hex).
    pub remote_public_key: String,
    /// When the connection was established.
    pub connected_at: u64,
}

/// An authenticated server-to-server QUIC connection.
pub struct FederationConnection {
    conn: Connection,
    meta: FederationMeta,
}

#[derive(Debug, thiserror::Error)]
pub enum FederationError {
    #[error("connection error: {0}")]
    Connection(#[from] quinn::ConnectionError),
    #[error("write error: {0}")]
    Write(#[from] quinn::WriteError),
    #[error("read error: {0}")]
    Read(#[from] quinn::ReadExactError),
    #[error("invalid handshake: {0}")]
    InvalidHandshake(String),
    #[error("signature verification failed")]
    SignatureVerificationFailed,
    #[error("handshake timestamp expired")]
    TimestampExpired,
    #[error("unknown remote server: {0}")]
    UnknownServer(String),
    #[error("send datagram error: {0}")]
    SendDatagram(#[from] quinn::SendDatagramError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

impl FederationConnection {
    /// Send a datagram to the federated server.
    pub fn send_datagram(&self, data: Bytes) -> Result<(), FederationError> {
        self.conn.send_datagram(data)?;
        Ok(())
    }

    /// Receive a datagram from the federated server.
    pub async fn read_datagram(&self) -> Result<Bytes, FederationError> {
        Ok(self.conn.read_datagram().await?)
    }

    /// Get federation metadata.
    pub fn meta(&self) -> &FederationMeta {
        &self.meta
    }

    /// Get the remote address.
    pub fn remote_address(&self) -> SocketAddr {
        self.conn.remote_address()
    }

    /// Current RTT.
    pub fn rtt(&self) -> Duration {
        self.conn.rtt()
    }

    /// Close the connection.
    pub fn close(&self) {
        self.conn
            .close(quinn::VarInt::from_u32(0), b"federation_close");
    }

    /// Check if still alive.
    pub fn is_alive(&self) -> bool {
        self.conn.close_reason().is_none()
    }
}

/// Initiate a federation connection to a remote server.
///
/// The initiating server opens a QUIC connection, then performs an Ed25519
/// handshake to prove its identity and verify the remote server.
pub async fn initiate_federation(
    endpoint: &MediaEndpoint,
    remote_addr: SocketAddr,
    local_origin: &str,
    signing_key: &SigningKey,
    expected_remote_key: &str,
) -> Result<FederationConnection, FederationError> {
    let connecting = endpoint
        .connect(remote_addr, "federation")
        .map_err(|e| FederationError::InvalidHandshake(e.to_string()))?;

    let conn = connecting.await?;

    info!(
        remote = %remote_addr,
        origin = local_origin,
        "federation: QUIC connection established, starting handshake"
    );

    // Open bidirectional stream for handshake
    let (mut send, mut recv) = conn.open_bi().await?;

    // Build and send FederationHello
    let timestamp = now_secs();
    let payload_to_sign = format!("{}{}", local_origin, timestamp);
    let signature = hex_encode(&signing_key.sign(payload_to_sign.as_bytes()).to_bytes());

    let hello = FederationHello {
        origin: local_origin.to_string(),
        public_key: hex_encode(&signing_key.verifying_key().to_bytes()),
        timestamp,
        signature,
    };

    let hello_bytes = serde_json::to_vec(&hello)?;
    let len = (hello_bytes.len() as u32).to_be_bytes();
    send.write_all(&len).await?;
    send.write_all(&hello_bytes).await?;

    // Read FederationAccept
    let mut len_buf = [0u8; 4];
    recv.read_exact(&mut len_buf)
        .await
        .map_err(FederationError::Read)?;
    let msg_len = u32::from_be_bytes(len_buf) as usize;

    let mut msg_buf = vec![0u8; msg_len];
    recv.read_exact(&mut msg_buf)
        .await
        .map_err(FederationError::Read)?;

    let accept: FederationAccept = serde_json::from_slice(&msg_buf)?;

    // Verify the accept message
    verify_accept(&accept, local_origin, expected_remote_key)?;

    info!(
        remote_origin = %accept.origin,
        remote_addr = %remote_addr,
        "federation: handshake complete"
    );

    Ok(FederationConnection {
        conn,
        meta: FederationMeta {
            remote_origin: accept.origin,
            remote_public_key: accept.public_key,
            connected_at: now_secs(),
        },
    })
}

/// Accept a federation connection from a remote server.
///
/// The accepting server reads the handshake, verifies the initiator's
/// Ed25519 signature, then responds with its own signed accept.
pub async fn accept_federation(
    conn: Connection,
    local_origin: &str,
    signing_key: &SigningKey,
    known_servers: &HashMap<String, String>, // origin -> public_key_hex
) -> Result<FederationConnection, FederationError> {
    let remote_addr = conn.remote_address();

    // Accept bidirectional stream
    let (mut send, mut recv) = conn.accept_bi().await?;

    // Read FederationHello
    let mut len_buf = [0u8; 4];
    recv.read_exact(&mut len_buf)
        .await
        .map_err(FederationError::Read)?;
    let msg_len = u32::from_be_bytes(len_buf) as usize;

    let mut msg_buf = vec![0u8; msg_len];
    recv.read_exact(&mut msg_buf)
        .await
        .map_err(FederationError::Read)?;

    let hello: FederationHello = serde_json::from_slice(&msg_buf)?;

    info!(
        remote_origin = %hello.origin,
        remote_addr = %remote_addr,
        "federation: received handshake from peer"
    );

    // Verify the hello
    let expected_key = known_servers
        .get(&hello.origin)
        .ok_or_else(|| FederationError::UnknownServer(hello.origin.clone()))?;

    verify_hello(&hello, expected_key)?;

    // Send FederationAccept
    let timestamp = now_secs();
    let payload_to_sign = format!("{}{}{}", local_origin, timestamp, hello.origin);
    let signature = hex_encode(&signing_key.sign(payload_to_sign.as_bytes()).to_bytes());

    let accept = FederationAccept {
        origin: local_origin.to_string(),
        public_key: hex_encode(&signing_key.verifying_key().to_bytes()),
        timestamp,
        signature,
    };

    let accept_bytes = serde_json::to_vec(&accept)?;
    let len = (accept_bytes.len() as u32).to_be_bytes();
    send.write_all(&len).await?;
    send.write_all(&accept_bytes).await?;

    info!(
        remote_origin = %hello.origin,
        remote_addr = %remote_addr,
        "federation: handshake accepted"
    );

    Ok(FederationConnection {
        conn,
        meta: FederationMeta {
            remote_origin: hello.origin,
            remote_public_key: hello.public_key,
            connected_at: now_secs(),
        },
    })
}

/// Verify a FederationHello message.
fn verify_hello(hello: &FederationHello, expected_public_key: &str) -> Result<(), FederationError> {
    // Check timestamp freshness
    let now = now_secs();
    if now.saturating_sub(hello.timestamp) > CHALLENGE_MAX_AGE_SECS {
        return Err(FederationError::TimestampExpired);
    }

    // Verify public key matches expected
    if hello.public_key != expected_public_key {
        return Err(FederationError::InvalidHandshake(format!(
            "public key mismatch: expected {}, got {}",
            expected_public_key, hello.public_key
        )));
    }

    // Verify signature
    let payload = format!("{}{}", hello.origin, hello.timestamp);
    verify_signature(&payload, &hello.signature, &hello.public_key)?;

    Ok(())
}

/// Verify a FederationAccept message.
fn verify_accept(
    accept: &FederationAccept,
    initiator_origin: &str,
    expected_public_key: &str,
) -> Result<(), FederationError> {
    let now = now_secs();
    if now.saturating_sub(accept.timestamp) > CHALLENGE_MAX_AGE_SECS {
        return Err(FederationError::TimestampExpired);
    }

    if accept.public_key != expected_public_key {
        return Err(FederationError::InvalidHandshake(format!(
            "public key mismatch: expected {}, got {}",
            expected_public_key, accept.public_key
        )));
    }

    let payload = format!("{}{}{}", accept.origin, accept.timestamp, initiator_origin);
    verify_signature(&payload, &accept.signature, &accept.public_key)?;

    Ok(())
}

/// Verify an Ed25519 signature.
fn verify_signature(
    payload: &str,
    signature_hex: &str,
    public_key_hex: &str,
) -> Result<(), FederationError> {
    let sig_bytes =
        hex_decode(signature_hex).ok_or(FederationError::SignatureVerificationFailed)?;
    let pk_bytes =
        hex_decode(public_key_hex).ok_or(FederationError::SignatureVerificationFailed)?;

    let signature = Signature::from_slice(&sig_bytes)
        .map_err(|_| FederationError::SignatureVerificationFailed)?;
    let pk_arr: [u8; 32] = pk_bytes
        .try_into()
        .map_err(|_| FederationError::SignatureVerificationFailed)?;
    let verifying_key = VerifyingKey::from_bytes(&pk_arr)
        .map_err(|_| FederationError::SignatureVerificationFailed)?;

    verifying_key
        .verify(payload.as_bytes(), &signature)
        .map_err(|_| FederationError::SignatureVerificationFailed)
}

/// Connection pool for managing multiple federation connections.
pub struct FederationPool {
    connections: RwLock<HashMap<String, Arc<FederationConnection>>>,
}

impl FederationPool {
    pub fn new() -> Self {
        Self {
            connections: RwLock::new(HashMap::new()),
        }
    }

    /// Get an existing connection to a federated server.
    pub async fn get(&self, origin: &str) -> Option<Arc<FederationConnection>> {
        let conns = self.connections.read().await;
        conns.get(origin).and_then(|c| {
            if c.is_alive() {
                Some(Arc::clone(c))
            } else {
                None
            }
        })
    }

    /// Store a federation connection.
    pub async fn insert(&self, conn: FederationConnection) {
        let origin = conn.meta.remote_origin.clone();
        let mut conns = self.connections.write().await;
        conns.insert(origin, Arc::new(conn));
    }

    /// Remove a connection by origin.
    pub async fn remove(&self, origin: &str) {
        let mut conns = self.connections.write().await;
        if let Some(conn) = conns.remove(origin) {
            conn.close();
        }
    }

    /// Get or establish a connection to a federated server.
    ///
    /// If an active connection exists, returns it. Otherwise, initiates
    /// a new federation handshake.
    pub async fn get_or_connect(
        &self,
        endpoint: &MediaEndpoint,
        remote_addr: SocketAddr,
        local_origin: &str,
        signing_key: &SigningKey,
        remote_origin: &str,
        remote_public_key: &str,
    ) -> Result<Arc<FederationConnection>, FederationError> {
        // Check for existing connection
        if let Some(conn) = self.get(remote_origin).await {
            return Ok(conn);
        }

        // Establish new connection
        info!(
            remote_origin,
            remote_addr = %remote_addr,
            "federation pool: establishing new connection"
        );

        let conn = initiate_federation(
            endpoint,
            remote_addr,
            local_origin,
            signing_key,
            remote_public_key,
        )
        .await?;

        let arc_conn = Arc::new(conn);
        let mut conns = self.connections.write().await;
        conns.insert(remote_origin.to_string(), Arc::clone(&arc_conn));

        Ok(arc_conn)
    }

    /// List all connected federation origins.
    pub async fn connected_origins(&self) -> Vec<String> {
        let conns = self.connections.read().await;
        conns
            .iter()
            .filter(|(_, c)| c.is_alive())
            .map(|(origin, _)| origin.clone())
            .collect()
    }

    /// Remove dead connections.
    pub async fn prune_dead(&self) {
        let mut conns = self.connections.write().await;
        let dead: Vec<String> = conns
            .iter()
            .filter(|(_, c)| !c.is_alive())
            .map(|(origin, _)| origin.clone())
            .collect();

        for origin in dead {
            debug!(origin = %origin, "federation pool: removing dead connection");
            conns.remove(&origin);
        }
    }

    /// Number of active connections.
    pub async fn connection_count(&self) -> usize {
        let conns = self.connections.read().await;
        conns.values().filter(|c| c.is_alive()).count()
    }
}

impl Default for FederationPool {
    fn default() -> Self {
        Self::new()
    }
}

// Hex encoding/decoding utilities (matching paracord-federation patterns).

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::RngCore;

    fn generate_keypair() -> (SigningKey, String) {
        let mut secret = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut secret);
        let signing_key = SigningKey::from_bytes(&secret);
        let public_hex = hex_encode(&signing_key.verifying_key().to_bytes());
        (signing_key, public_hex)
    }

    #[test]
    fn hex_round_trip() {
        let data = b"hello federation";
        let encoded = hex_encode(data);
        let decoded = hex_decode(&encoded).unwrap();
        assert_eq!(decoded, data);
    }

    #[test]
    fn hello_signature_valid() {
        let (key, pub_hex) = generate_keypair();
        let timestamp = now_secs();
        let origin = "chat.example.com";
        let payload = format!("{}{}", origin, timestamp);
        let sig = hex_encode(&key.sign(payload.as_bytes()).to_bytes());

        let hello = FederationHello {
            origin: origin.to_string(),
            public_key: pub_hex.clone(),
            timestamp,
            signature: sig,
        };

        verify_hello(&hello, &pub_hex).unwrap();
    }

    #[test]
    fn hello_rejects_wrong_key() {
        let (key, _pub_hex) = generate_keypair();
        let (_other_key, other_pub_hex) = generate_keypair();

        let timestamp = now_secs();
        let origin = "chat.example.com";
        let payload = format!("{}{}", origin, timestamp);
        let sig = hex_encode(&key.sign(payload.as_bytes()).to_bytes());

        let hello = FederationHello {
            origin: origin.to_string(),
            public_key: hex_encode(&key.verifying_key().to_bytes()),
            timestamp,
            signature: sig,
        };

        // Expecting the other key should fail
        let result = verify_hello(&hello, &other_pub_hex);
        assert!(result.is_err());
    }

    #[test]
    fn hello_rejects_tampered_origin() {
        let (key, pub_hex) = generate_keypair();
        let timestamp = now_secs();
        let payload = format!("{}{}", "original.com", timestamp);
        let sig = hex_encode(&key.sign(payload.as_bytes()).to_bytes());

        let hello = FederationHello {
            origin: "tampered.com".to_string(), // different from what was signed
            public_key: pub_hex.clone(),
            timestamp,
            signature: sig,
        };

        let result = verify_hello(&hello, &pub_hex);
        assert!(result.is_err());
    }

    #[test]
    fn accept_signature_valid() {
        let (key, pub_hex) = generate_keypair();
        let timestamp = now_secs();
        let acceptor_origin = "server-b.com";
        let initiator_origin = "server-a.com";
        let payload = format!("{}{}{}", acceptor_origin, timestamp, initiator_origin);
        let sig = hex_encode(&key.sign(payload.as_bytes()).to_bytes());

        let accept = FederationAccept {
            origin: acceptor_origin.to_string(),
            public_key: pub_hex.clone(),
            timestamp,
            signature: sig,
        };

        verify_accept(&accept, initiator_origin, &pub_hex).unwrap();
    }

    #[test]
    fn accept_rejects_wrong_initiator() {
        let (key, pub_hex) = generate_keypair();
        let timestamp = now_secs();
        let acceptor_origin = "server-b.com";
        // Signed with "server-a.com" as initiator
        let payload = format!("{}{}{}", acceptor_origin, timestamp, "server-a.com");
        let sig = hex_encode(&key.sign(payload.as_bytes()).to_bytes());

        let accept = FederationAccept {
            origin: acceptor_origin.to_string(),
            public_key: pub_hex.clone(),
            timestamp,
            signature: sig,
        };

        // Verifying with wrong initiator should fail
        let result = verify_accept(&accept, "wrong-initiator.com", &pub_hex);
        assert!(result.is_err());
    }

    #[test]
    fn expired_timestamp_rejected() {
        let (key, pub_hex) = generate_keypair();
        let old_timestamp = now_secs() - CHALLENGE_MAX_AGE_SECS - 10;
        let origin = "chat.example.com";
        let payload = format!("{}{}", origin, old_timestamp);
        let sig = hex_encode(&key.sign(payload.as_bytes()).to_bytes());

        let hello = FederationHello {
            origin: origin.to_string(),
            public_key: pub_hex.clone(),
            timestamp: old_timestamp,
            signature: sig,
        };

        let result = verify_hello(&hello, &pub_hex);
        assert!(matches!(result, Err(FederationError::TimestampExpired)));
    }

    #[tokio::test]
    async fn federation_pool_basics() {
        let pool = FederationPool::new();
        assert_eq!(pool.connection_count().await, 0);
        assert!(pool.get("unknown.com").await.is_none());
        assert!(pool.connected_origins().await.is_empty());
    }

    #[tokio::test]
    async fn full_handshake_round_trip() {
        // Set up two QUIC endpoints simulating two federated servers
        let tls_a = crate::endpoint::generate_self_signed_cert().unwrap();
        let tls_b = crate::endpoint::generate_self_signed_cert().unwrap();

        let server_a = MediaEndpoint::bind("127.0.0.1:0".parse().unwrap(), tls_a).unwrap();
        let server_b = MediaEndpoint::bind("127.0.0.1:0".parse().unwrap(), tls_b).unwrap();

        let _addr_a = server_a.local_addr().unwrap();
        let addr_b = server_b.local_addr().unwrap();

        let (key_a, pub_a) = generate_keypair();
        let (key_b, pub_b) = generate_keypair();

        let mut known_by_b = HashMap::new();
        known_by_b.insert("server-a.example.com".to_string(), pub_a.clone());

        let pub_b_clone = pub_b.clone();
        let key_b_clone = key_b.clone();

        // Server B: accept federation connection
        let accept_task = tokio::spawn(async move {
            let incoming = server_b.accept().await.unwrap();
            let conn = incoming.accept().unwrap().await.unwrap();
            accept_federation(conn, "server-b.example.com", &key_b_clone, &known_by_b).await
        });

        // Server A: initiate federation connection
        let fed_conn_a = initiate_federation(
            &server_a,
            addr_b,
            "server-a.example.com",
            &key_a,
            &pub_b_clone,
        )
        .await
        .unwrap();

        let fed_conn_b = accept_task.await.unwrap().unwrap();

        // Verify metadata
        assert_eq!(fed_conn_a.meta().remote_origin, "server-b.example.com");
        assert_eq!(fed_conn_b.meta().remote_origin, "server-a.example.com");
        assert_eq!(fed_conn_a.meta().remote_public_key, pub_b);
        assert_eq!(fed_conn_b.meta().remote_public_key, pub_a);

        // Exchange datagrams
        fed_conn_a
            .send_datagram(Bytes::from_static(b"media from A"))
            .unwrap();
        let received = fed_conn_b.read_datagram().await.unwrap();
        assert_eq!(received.as_ref(), b"media from A");

        fed_conn_b
            .send_datagram(Bytes::from_static(b"media from B"))
            .unwrap();
        let received = fed_conn_a.read_datagram().await.unwrap();
        assert_eq!(received.as_ref(), b"media from B");

        // Clean up
        fed_conn_a.close();
        fed_conn_b.close();
        server_a.close();
    }
}
