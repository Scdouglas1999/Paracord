//! Authenticated connection management.
//!
//! Wraps a quinn `Connection` with authentication state, datagram
//! send/receive, and bidirectional stream management.

use std::net::SocketAddr;
use std::time::Duration;

use bytes::Bytes;
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use quinn::Connection;
use serde::{Deserialize, Serialize};

use crate::control::{ControlError, ControlMessage};

const PRE_AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_AUTH_MESSAGE_SIZE: u32 = 8 * 1024;

/// Connection type: client-to-server relay or peer-to-peer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionMode {
    Relay,
    PeerToPeer,
}

/// JWT claims for media transport authentication.
#[derive(Debug, Serialize, Deserialize)]
pub struct MediaClaims {
    pub sub: i64,
    pub exp: usize,
    pub iat: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
}

/// Metadata tracked for each authenticated connection.
#[derive(Debug, Clone)]
pub struct ConnectionMeta {
    pub user_id: i64,
    pub session_id: Option<String>,
    pub room_id: Option<String>,
    pub remote_addr: SocketAddr,
    pub mode: ConnectionMode,
}

/// An authenticated media connection wrapping a QUIC connection.
pub struct MediaConnection {
    conn: Connection,
    meta: ConnectionMeta,
}

#[derive(Debug, thiserror::Error)]
pub enum ConnectionError {
    #[error("authentication failed: {0}")]
    AuthFailed(String),
    #[error("connection error: {0}")]
    Connection(#[from] quinn::ConnectionError),
    #[error("write error: {0}")]
    WriteError(#[from] quinn::WriteError),
    #[error("read error: {0}")]
    ReadError(#[from] quinn::ReadExactError),
    #[error("control protocol error: {0}")]
    Control(#[from] ControlError),
    #[error("no auth message received")]
    NoAuthMessage,
    #[error("send datagram error: {0}")]
    SendDatagram(#[from] quinn::SendDatagramError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl MediaConnection {
    /// Wrap an already-authenticated connection.
    pub fn new(conn: Connection, meta: ConnectionMeta) -> Self {
        Self { conn, meta }
    }

    /// Accept an incoming connection and authenticate via control stream.
    ///
    /// The client must open a bidirectional stream and send an `Auth` control
    /// message as its first message. The JWT is validated using the provided secret.
    pub async fn accept_and_auth(
        conn: Connection,
        jwt_secret: &str,
        mode: ConnectionMode,
    ) -> Result<Self, ConnectionError> {
        tokio::time::timeout(PRE_AUTH_TIMEOUT, async move {
            let remote_addr = conn.remote_address();

            // Accept the first bidirectional stream (control stream)
            let (mut send, mut recv) = conn
                .accept_bi()
                .await
                .map_err(ConnectionError::Connection)?;

            // Read length prefix (4 bytes) + message. Bound the pre-auth
            // frame before allocating attacker-controlled memory.
            let mut len_buf = [0u8; 4];
            recv.read_exact(&mut len_buf)
                .await
                .map_err(ConnectionError::ReadError)?;
            let len = u32::from_be_bytes(len_buf);
            if len == 0 || len > MAX_AUTH_MESSAGE_SIZE || len > crate::control::MAX_MESSAGE_SIZE {
                return Err(ConnectionError::Control(ControlError::MessageTooLarge {
                    size: len,
                }));
            }
            let len = len as usize;

            let mut msg_buf = vec![0u8; len];
            recv.read_exact(&mut msg_buf)
                .await
                .map_err(ConnectionError::ReadError)?;

            let msg: ControlMessage =
                serde_json::from_slice(&msg_buf).map_err(ControlError::Json)?;

            let token = match msg {
                ControlMessage::Auth { token } => token,
                _ => return Err(ConnectionError::NoAuthMessage),
            };

            // Validate JWT
            let validation = Validation::new(Algorithm::HS256);
            let token_data = decode::<MediaClaims>(
                &token,
                &DecodingKey::from_secret(jwt_secret.as_bytes()),
                &validation,
            )
            .map_err(|e| ConnectionError::AuthFailed(e.to_string()))?;

            let claims = token_data.claims;
            let meta = ConnectionMeta {
                user_id: claims.sub,
                session_id: claims.sid,
                room_id: claims.room,
                remote_addr,
                mode,
            };

            // Send back a Pong to acknowledge auth success
            let ack = ControlMessage::Pong.encode()?;
            send.write_all(&ack).await?;

            Ok(Self { conn, meta })
        })
        .await
        .map_err(|_| ConnectionError::AuthFailed("pre-auth timeout".to_string()))?
    }

    /// Connect to a remote endpoint and authenticate.
    pub async fn connect_and_auth(
        conn: Connection,
        token: &str,
        mode: ConnectionMode,
    ) -> Result<Self, ConnectionError> {
        let remote_addr = conn.remote_address();

        // Open the control stream
        let (mut send, mut recv) = conn.open_bi().await.map_err(ConnectionError::Connection)?;

        // Send auth message
        let auth_msg = ControlMessage::Auth {
            token: token.to_string(),
        };
        let encoded = auth_msg.encode()?;
        send.write_all(&encoded).await?;

        // Wait for Pong acknowledgement
        let mut len_buf = [0u8; 4];
        recv.read_exact(&mut len_buf)
            .await
            .map_err(ConnectionError::ReadError)?;
        let len = u32::from_be_bytes(len_buf) as usize;

        let mut msg_buf = vec![0u8; len];
        recv.read_exact(&mut msg_buf)
            .await
            .map_err(ConnectionError::ReadError)?;

        // We don't strictly validate the pong, just that we got a response

        // For client-initiated connections we don't know our own user_id
        // from the JWT (server validates it). Use 0 as placeholder; the server
        // will track the real user_id.
        let meta = ConnectionMeta {
            user_id: 0,
            session_id: None,
            room_id: None,
            remote_addr,
            mode,
        };

        Ok(Self { conn, meta })
    }

    /// Send an unreliable datagram (for media packets).
    pub fn send_datagram(&self, data: Bytes) -> Result<(), ConnectionError> {
        self.conn.send_datagram(data)?;
        Ok(())
    }

    /// Receive an unreliable datagram (for media packets).
    pub async fn read_datagram(&self) -> Result<Bytes, ConnectionError> {
        Ok(self.conn.read_datagram().await?)
    }

    /// Open a new bidirectional stream (for control messages).
    pub async fn open_bi(&self) -> Result<(quinn::SendStream, quinn::RecvStream), ConnectionError> {
        Ok(self.conn.open_bi().await?)
    }

    /// Accept a bidirectional stream opened by the remote peer.
    pub async fn accept_bi(
        &self,
    ) -> Result<(quinn::SendStream, quinn::RecvStream), ConnectionError> {
        Ok(self.conn.accept_bi().await?)
    }

    /// Connection metadata (user, session, address, mode).
    pub fn meta(&self) -> &ConnectionMeta {
        &self.meta
    }

    /// The remote peer's current address (may change due to connection migration).
    pub fn remote_address(&self) -> SocketAddr {
        self.conn.remote_address()
    }

    /// Current round-trip time estimate.
    pub fn rtt(&self) -> Duration {
        self.conn.rtt()
    }

    /// Maximum datagram size the peer will accept, if datagrams are supported.
    pub fn max_datagram_size(&self) -> Option<usize> {
        self.conn.max_datagram_size()
    }

    /// Returns a reference to the inner quinn connection.
    pub fn inner(&self) -> &Connection {
        &self.conn
    }

    /// Close the connection.
    pub fn close(&self, reason: &str) {
        self.conn
            .close(quinn::VarInt::from_u32(1), reason.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_mode_debug() {
        assert_eq!(format!("{:?}", ConnectionMode::Relay), "Relay");
        assert_eq!(format!("{:?}", ConnectionMode::PeerToPeer), "PeerToPeer");
    }

    #[test]
    fn media_claims_serialize() {
        let claims = MediaClaims {
            sub: 42,
            exp: 9999999999,
            iat: 1000000000,
            sid: Some("session-1".to_string()),
            room: Some("guild:1:channel:2".to_string()),
        };
        let json = serde_json::to_string(&claims).unwrap();
        let parsed: MediaClaims = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.sub, 42);
        assert_eq!(parsed.sid.as_deref(), Some("session-1"));
        assert_eq!(parsed.room.as_deref(), Some("guild:1:channel:2"));
    }

    #[test]
    fn expired_media_claims_are_rejected() {
        let secret = b"media-secret";
        let claims = MediaClaims {
            sub: 42,
            exp: 1,
            iat: 0,
            sid: Some("session-1".to_string()),
            room: Some("1:2".to_string()),
        };
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(Algorithm::HS256),
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(secret),
        )
        .unwrap();

        let err = decode::<MediaClaims>(
            &token,
            &DecodingKey::from_secret(secret),
            &Validation::new(Algorithm::HS256),
        )
        .expect_err("expired media tokens must not authenticate");
        assert_eq!(
            err.kind(),
            &jsonwebtoken::errors::ErrorKind::ExpiredSignature
        );
    }
}
