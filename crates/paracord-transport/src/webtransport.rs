//! HTTP/3 WebTransport session handling for browser clients.
//!
//! Wraps h3 + h3-quinn to accept WebTransport sessions over HTTP/3,
//! providing the same datagram/stream interface as native QUIC connections.

use std::net::SocketAddr;
use std::sync::Arc;

use bytes::Bytes;
use h3::ext::Protocol;
use h3::server::Connection as H3Connection;
use quinn::crypto::rustls::QuicServerConfig;

use crate::endpoint::TlsConfig;
use crate::ensure_rustls_provider;

#[derive(Debug, thiserror::Error)]
pub enum WebTransportError {
    #[error("h3 connection error: {0}")]
    H3Connection(#[from] h3::error::ConnectionError),
    #[error("h3 stream error: {0}")]
    H3Stream(#[from] h3::error::StreamError),
    #[error("quinn error: {0}")]
    Quinn(#[from] quinn::ConnectionError),
    #[error("not a WebTransport CONNECT request")]
    NotWebTransport,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("tls error: {0}")]
    Tls(#[from] rustls::Error),
    #[error("bind error: {0}")]
    Bind(String),
}

/// Configuration for the WebTransport server.
pub struct WebTransportConfig {
    /// Address to bind the QUIC/HTTP3 endpoint on.
    pub bind_addr: SocketAddr,
    /// TLS configuration (cert + key).
    pub tls: TlsConfig,
}

/// A WebTransport server that accepts HTTP/3 connections and upgrades
/// WebTransport sessions.
pub struct WebTransportServer {
    endpoint: quinn::Endpoint,
}

impl WebTransportServer {
    /// Create and bind a new WebTransport server.
    pub fn bind(config: WebTransportConfig) -> Result<Self, WebTransportError> {
        ensure_rustls_provider();
        let mut server_crypto = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(config.tls.cert_chain, config.tls.private_key.clone_key())
            .map_err(WebTransportError::Tls)?;

        // Enable ALPN for HTTP/3
        server_crypto.alpn_protocols = vec![b"h3".to_vec()];

        let server_config = quinn::ServerConfig::with_crypto(Arc::new(
            QuicServerConfig::try_from(server_crypto)
                .map_err(|e| WebTransportError::Bind(e.to_string()))?,
        ));

        let endpoint = quinn::Endpoint::server(server_config, config.bind_addr)
            .map_err(WebTransportError::Io)?;

        Ok(Self { endpoint })
    }

    /// Accept the next incoming QUIC connection for HTTP/3.
    pub async fn accept(&self) -> Option<quinn::Incoming> {
        self.endpoint.accept().await
    }

    /// Handle an accepted QUIC connection as HTTP/3 with WebTransport support.
    ///
    /// This sets up the h3 server connection with WebTransport, extended CONNECT,
    /// and datagram support enabled.
    pub async fn handle_connection(
        conn: quinn::Connection,
    ) -> Result<H3Session, WebTransportError> {
        let h3_conn = h3::server::builder()
            .enable_webtransport(true)
            .enable_extended_connect(true)
            .enable_datagram(true)
            .build(h3_quinn::Connection::new(conn.clone()))
            .await?;

        Ok(H3Session {
            h3_conn,
            quinn_conn: conn,
        })
    }

    /// Returns the local address this server is bound to.
    pub fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.endpoint.local_addr()
    }

    /// Close the WebTransport server.
    pub fn close(&self) {
        self.endpoint.close(quinn::VarInt::from_u32(0), b"shutdown");
    }
}

/// An active HTTP/3 session that can accept WebTransport upgrades.
pub struct H3Session {
    h3_conn: H3Connection<h3_quinn::Connection, Bytes>,
    quinn_conn: quinn::Connection,
}

impl H3Session {
    /// Accept the next WebTransport session request.
    ///
    /// Returns `Ok(Some(session))` if a WebTransport CONNECT request was received,
    /// `Ok(None)` if the connection closed, or `Err` on protocol error.
    pub async fn accept_session(
        &mut self,
    ) -> Result<Option<WebTransportSession>, WebTransportError> {
        loop {
            let resolver = match self.h3_conn.accept().await? {
                Some(resolver) => resolver,
                None => return Ok(None),
            };

            let (request, _stream) = resolver.resolve_request().await?;
            let (parts, _body) = request.into_parts();

            // Check if this is a WebTransport CONNECT request
            let is_webtransport =
                parts.extensions.get::<Protocol>() == Some(&Protocol::WEB_TRANSPORT);

            if is_webtransport {
                return Ok(Some(WebTransportSession {
                    quinn_conn: self.quinn_conn.clone(),
                    path: parts.uri.path().to_string(),
                }));
            }

            tracing::debug!(
                method = %parts.method,
                uri = %parts.uri,
                "ignoring non-WebTransport HTTP/3 request"
            );
        }
    }
}

/// A WebTransport session wrapping the underlying QUIC connection.
///
/// Provides the same datagram/stream interface as `MediaConnection`
/// so browser clients can interop with native QUIC clients.
pub struct WebTransportSession {
    quinn_conn: quinn::Connection,
    path: String,
}

impl WebTransportSession {
    /// The request path from the CONNECT request.
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Send an unreliable datagram (for media packets).
    pub fn send_datagram(&self, data: Bytes) -> Result<(), quinn::SendDatagramError> {
        self.quinn_conn.send_datagram(data)
    }

    /// Receive an unreliable datagram.
    pub async fn read_datagram(&self) -> Result<Bytes, quinn::ConnectionError> {
        self.quinn_conn.read_datagram().await
    }

    /// Open a bidirectional stream.
    pub async fn open_bi(
        &self,
    ) -> Result<(quinn::SendStream, quinn::RecvStream), quinn::ConnectionError> {
        self.quinn_conn.open_bi().await
    }

    /// Accept a bidirectional stream from the browser.
    pub async fn accept_bi(
        &self,
    ) -> Result<(quinn::SendStream, quinn::RecvStream), quinn::ConnectionError> {
        self.quinn_conn.accept_bi().await
    }

    /// Remote address of the browser client.
    pub fn remote_address(&self) -> SocketAddr {
        self.quinn_conn.remote_address()
    }

    /// Get a reference to the underlying QUIC connection.
    pub fn quinn_conn(&self) -> &quinn::Connection {
        &self.quinn_conn
    }

    /// Close the session.
    pub fn close(&self, reason: &str) {
        self.quinn_conn
            .close(quinn::VarInt::from_u32(1), reason.as_bytes());
    }
}

// ── QSID datagram bridge ────────────────────────────────────────────────

/// Decode a QUIC variable-length integer from the front of the buffer.
/// Returns `(value, bytes_consumed)`.
fn decode_quic_varint(buf: &[u8]) -> Option<(u64, usize)> {
    if buf.is_empty() {
        return None;
    }
    let first = buf[0];
    let len = 1 << (first >> 6);
    if buf.len() < len {
        return None;
    }
    let val = match len {
        1 => (first & 0x3f) as u64,
        2 => {
            let mut v = [0u8; 2];
            v.copy_from_slice(&buf[..2]);
            v[0] &= 0x3f;
            u16::from_be_bytes(v) as u64
        }
        4 => {
            let mut v = [0u8; 4];
            v.copy_from_slice(&buf[..4]);
            v[0] &= 0x3f;
            u32::from_be_bytes(v) as u64
        }
        8 => {
            let mut v = [0u8; 8];
            v.copy_from_slice(&buf[..8]);
            v[0] &= 0x3f;
            u64::from_be_bytes(v)
        }
        _ => return None,
    };
    Some((val, len))
}

/// Encode a QUIC variable-length integer into the smallest representation.
fn encode_quic_varint(val: u64) -> Vec<u8> {
    if val <= 63 {
        vec![val as u8]
    } else if val <= 16383 {
        let v = (val as u16) | 0x4000;
        v.to_be_bytes().to_vec()
    } else if val <= 1_073_741_823 {
        let v = (val as u32) | 0x80000000;
        v.to_be_bytes().to_vec()
    } else {
        let v = val | 0xc000000000000000;
        v.to_be_bytes().to_vec()
    }
}

/// Spawn a datagram bridge that translates between HTTP/3 datagrams
/// (with QSID varint prefix) and raw media packets.
///
/// Returns `(outbound_tx, inbound_rx)` channels:
/// - Write raw media packets to `outbound_tx` → bridge prepends QSID and
///   sends via the QUIC connection.
/// - Read raw media packets from `inbound_rx` ← bridge strips QSID from
///   incoming QUIC datagrams.
pub fn spawn_webtransport_bridge(
    quinn_conn: quinn::Connection,
    qsid: u64,
) -> (
    tokio::sync::mpsc::UnboundedSender<Bytes>,
    tokio::sync::mpsc::UnboundedReceiver<Bytes>,
) {
    let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
    let (inbound_tx, inbound_rx) = tokio::sync::mpsc::unbounded_channel::<Bytes>();

    let qsid_prefix = Bytes::from(encode_quic_varint(qsid));
    let conn_out = quinn_conn.clone();
    let prefix_clone = qsid_prefix.clone();

    // Outbound: relay → browser
    tokio::spawn(async move {
        while let Some(raw_packet) = outbound_rx.recv().await {
            let mut datagram =
                bytes::BytesMut::with_capacity(prefix_clone.len() + raw_packet.len());
            datagram.extend_from_slice(&prefix_clone);
            datagram.extend_from_slice(&raw_packet);
            if conn_out.send_datagram(datagram.freeze()).is_err() {
                break;
            }
        }
    });

    // Inbound: browser → relay
    tokio::spawn(async move {
        while let Ok(datagram) = quinn_conn.read_datagram().await {
            // Strip the QSID varint prefix
            if let Some((_qsid_val, prefix_len)) = decode_quic_varint(&datagram) {
                if prefix_len <= datagram.len() {
                    let raw = datagram.slice(prefix_len..);
                    if inbound_tx.send(raw).is_err() {
                        break;
                    }
                }
            }
        }
    });

    (outbound_tx, inbound_rx)
}
