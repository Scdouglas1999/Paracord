//! HTTP/3 WebTransport session handling for browser clients.
//!
//! Wraps h3 + h3-quinn to accept WebTransport sessions over HTTP/3,
//! providing the same datagram/stream interface as native QUIC connections.
//!
//! # Why this module frames streams by hand
//!
//! Under h3-quinn a WebTransport stream *is* a quinn stream, but it is not a
//! **raw** quinn stream: WebTransport over HTTP/3
//! (draft-ietf-webtrans-http3, §4.1–4.2) multiplexes its streams onto the same
//! HTTP/3 connection as ordinary requests, so every WebTransport stream carries
//! a header naming the session it belongs to:
//!
//! | Stream | On-the-wire prefix |
//! |---|---|
//! | bidirectional | varint `0x41` (`WEBTRANSPORT_STREAM`) + session-id varint |
//! | unidirectional | varint `0x54` (`WEBTRANSPORT_UNI`) + session-id varint |
//! | datagram | quarter-stream-id varint (RFC 9297 §2.1) |
//!
//! The session id is the **stream id of the extended-CONNECT request** the
//! session was established on, and the quarter stream id is that stream id
//! divided by four.
//!
//! Handing a browser-opened stream to the media protocol reader without
//! stripping that header makes the reader see `0x41 …` where it expects a
//! 4-byte length prefix (observed as `invalid auth JSON: expected value at line
//! 1 column 1`). Writing a server-opened stream without prepending it makes the
//! browser drop the stream instead of attributing it to the session. Both
//! directions of both stream kinds therefore go through
//! [`WebTransportStreams`], which is the only place this framing lives.
//!
//! Raw QUIC (the Tauri desktop and federation paths) is a different transport
//! with no HTTP/3 layer and is deliberately untouched by any of this.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

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

        let mut server_config = quinn::ServerConfig::with_crypto(Arc::new(
            QuicServerConfig::try_from(server_crypto)
                .map_err(|e| WebTransportError::Bind(e.to_string()))?,
        ));
        server_config.transport_config(crate::endpoint::server_transport_config());

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
///
/// **Hold this for as long as the WebTransport session must live.** Dropping
/// `h3::server::Connection` closes the whole QUIC connection with `H3_NO_ERROR`
/// (its `Drop` calls `close_connection`), which tears the media session down
/// the instant the accept scope returns.
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

            let (request, mut stream) = resolver.resolve_request().await?;
            let (parts, _body) = request.into_parts();

            // Check if this is a WebTransport CONNECT request
            let is_webtransport =
                parts.extensions.get::<Protocol>() == Some(&Protocol::WEB_TRANSPORT);

            if is_webtransport {
                // The WebTransport session id is the stream id of the CONNECT
                // request it was established on (draft-ietf-webtrans-http3
                // §4.2). Every stream and datagram of this session is tagged
                // with it, so capture it before the response is sent.
                let session_id = stream.id().into_inner();

                // A WebTransport session does not exist until the server answers
                // the extended CONNECT with a 2xx. Returning the session without
                // responding left the browser's `WebTransport.ready` hanging
                // until the request stream was dropped, which FINs it — and a
                // CONNECT stream that ends without a response is a failed
                // handshake, reported by Chromium as the bare
                // "Opening handshake failed." So respond first, and keep the
                // stream alive for the life of the session: closing the CONNECT
                // stream is how either side tears a WebTransport session down.
                let response = http::Response::builder()
                    .status(http::StatusCode::OK)
                    .body(())
                    .expect("a 200 response with an empty body is always valid");
                stream.send_response(response).await?;

                return Ok(Some(WebTransportSession {
                    streams: WebTransportStreams::new(self.quinn_conn.clone(), session_id),
                    path: parts.uri.path().to_string(),
                    connect_stream: Some(stream),
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

// ── WebTransport stream framing ─────────────────────────────────────────

/// HTTP/3 stream type prefixing a WebTransport **bidirectional** stream
/// (`WEBTRANSPORT_STREAM`, draft-ietf-webtrans-http3 §4.2).
pub const WEBTRANSPORT_BIDI_STREAM_TYPE: u64 = 0x41;

/// HTTP/3 stream type prefixing a WebTransport **unidirectional** stream
/// (`WEBTRANSPORT_UNI`, draft-ietf-webtrans-http3 §4.1).
pub const WEBTRANSPORT_UNI_STREAM_TYPE: u64 = 0x54;

/// Something went wrong reading or writing a WebTransport stream header.
///
/// Distinct from [`WebTransportError`] (which covers session establishment) so a
/// caller can tell "this peer framed a stream wrongly" from "the HTTP/3
/// handshake failed".
#[derive(Debug, thiserror::Error)]
pub enum FramingError {
    #[error("quinn connection error: {0}")]
    Connection(#[from] quinn::ConnectionError),
    #[error("could not read the WebTransport stream header: {0}")]
    Read(#[from] quinn::ReadExactError),
    #[error("could not write the WebTransport stream header: {0}")]
    Write(#[from] quinn::WriteError),
    #[error("malformed variable-length integer in the WebTransport stream header")]
    MalformedVarint,
    #[error("expected WebTransport stream type {expected:#x}, got {actual:#x}")]
    UnexpectedStreamType { expected: u64, actual: u64 },
    #[error("WebTransport stream names session {actual}, not {expected}")]
    SessionMismatch { expected: u64, actual: u64 },
}

/// Decode a QUIC variable-length integer from the front of the buffer.
/// Returns `(value, bytes_consumed)`.
pub(crate) fn decode_quic_varint(buf: &[u8]) -> Option<(u64, usize)> {
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
pub(crate) fn encode_quic_varint(val: u64) -> Vec<u8> {
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

/// The RFC 9297 §2.1 quarter stream id that prefixes a session's datagrams.
///
/// Pure arithmetic on the CONNECT stream id, kept separate from
/// [`WebTransportStreams`] so it can be asserted without a live connection.
pub fn datagram_quarter_stream_id(session_id: u64) -> u64 {
    session_id / 4
}

/// The `WEBTRANSPORT_*` header bytes that prefix one stream of `session_id`.
fn stream_header(stream_type: u64, session_id: u64) -> Vec<u8> {
    let mut header = encode_quic_varint(stream_type);
    header.extend_from_slice(&encode_quic_varint(session_id));
    header
}

/// Read one QUIC varint off the front of a receive stream.
///
/// Read length-first (one byte, then the remainder the two high bits declare) so
/// exactly the varint is consumed and the media payload behind it stays intact.
async fn read_varint(recv: &mut quinn::RecvStream) -> Result<u64, FramingError> {
    let mut buf = [0u8; 8];
    recv.read_exact(&mut buf[..1]).await?;
    let len = 1usize << (buf[0] >> 6);
    if len > 1 {
        recv.read_exact(&mut buf[1..len]).await?;
    }
    decode_quic_varint(&buf[..len])
        .map(|(value, _)| value)
        .ok_or(FramingError::MalformedVarint)
}

/// Strip and validate the header of an accepted WebTransport stream.
async fn strip_stream_header(
    recv: &mut quinn::RecvStream,
    expected_type: u64,
    expected_session: u64,
) -> Result<(), FramingError> {
    let stream_type = read_varint(recv).await?;
    if stream_type != expected_type {
        return Err(FramingError::UnexpectedStreamType {
            expected: expected_type,
            actual: stream_type,
        });
    }
    let session_id = read_varint(recv).await?;
    if session_id != expected_session {
        return Err(FramingError::SessionMismatch {
            expected: expected_session,
            actual: session_id,
        });
    }
    Ok(())
}

// ── Accepting streams without head-of-line blocking ─────────────────────

/// How long one accepted stream has to say what it is.
///
/// A stream announces itself in its first varint — a WebTransport stream in its
/// first two — and every peer writes those bytes as it creates the stream. A
/// stream that has said nothing by the time this elapses is not going to be
/// routed as media, so it stops occupying a classification slot. It is not
/// *reset*: see [`ignore_foreign_stream`].
const STREAM_HEADER_TIMEOUT: Duration = Duration::from_secs(15);

/// How many accepted streams may be waiting to be classified at once.
///
/// Classification runs off the accept loop, which is the whole point of this
/// path — but it must not be unbounded, or a peer that opens streams and says
/// nothing would spend the server's memory for it. Past this, a newly accepted
/// stream is reset rather than classified.
const MAX_PENDING_STREAM_HEADERS: usize = 128;

/// How many foreign streams one session will sit and drain (see
/// [`ignore_foreign_stream`]). An HTTP/3 connection has a handful: the control
/// stream, the two QPACK streams, and possibly a GREASE stream.
const MAX_IGNORED_STREAMS: usize = 16;

/// How many classified streams may queue for the caller before the classifier
/// waits — which is back-pressure on one stream, never on the accept loop.
const ACCEPT_QUEUE_CAPACITY: usize = 256;

/// `0x1f * N + 0x21`: the reserved stream types a peer opens purely to check
/// that the other side really does ignore what it does not know
/// (RFC 9114 §6.2.3).
fn is_grease_stream_type(stream_type: u64) -> bool {
    stream_type >= 0x21 && (stream_type - 0x21).is_multiple_of(0x1f)
}

/// Name a stream type for a log line (RFC 9114 §6.2, RFC 9204 §4.2,
/// RFC 9220 §4). Naming it is all this module does with it.
fn describe_stream_type(stream_type: u64) -> String {
    match stream_type {
        0x00 => "the HTTP/3 control stream".to_string(),
        0x01 => "an HTTP/3 push stream".to_string(),
        0x02 => "the QPACK encoder stream".to_string(),
        0x03 => "the QPACK decoder stream".to_string(),
        WEBTRANSPORT_BIDI_STREAM_TYPE => "a WebTransport bidirectional stream".to_string(),
        WEBTRANSPORT_UNI_STREAM_TYPE => "a WebTransport unidirectional stream".to_string(),
        other if is_grease_stream_type(other) => format!("a GREASE stream ({other:#x})"),
        other => format!("a stream of unknown type {other:#x}"),
    }
}

/// Consume a stream that is not this session's, without disturbing the HTTP/3
/// connection underneath it.
///
/// RFC 9114 §6.2.3 says a recipient that does not recognize a unidirectional
/// stream's type ignores it; §6.2.1 says closing a *critical* stream — the
/// control stream or either QPACK stream — is `H3_CLOSED_CRITICAL_STREAM`, a
/// connection error. Together those rule out the obvious implementation,
/// dropping the handle: quinn sends STOP_SENDING for a `RecvStream` dropped
/// before EOF, and a browser answers STOP_SENDING on its control stream by
/// closing the whole HTTP/3 connection — taking the call with it. So read the
/// stream and throw the bytes away instead, until the peer finishes it or the
/// connection ends.
fn ignore_foreign_stream(
    mut recv: quinn::RecvStream,
    session_id: u64,
    direction: &'static str,
    what: String,
    ignored: Arc<tokio::sync::Semaphore>,
) {
    let Ok(permit) = ignored.try_acquire_owned() else {
        // A peer that opens this many streams we cannot read is not an HTTP/3
        // connection doing its housekeeping. Reset this one.
        tracing::debug!(
            session_id,
            direction,
            stream = %what,
            "resetting a foreign stream: this session is already draining its limit"
        );
        return;
    };
    tracing::debug!(
        session_id,
        direction,
        stream = %what,
        "ignoring a stream that does not belong to this WebTransport session"
    );
    tokio::spawn(async move {
        let _permit = permit;
        // Whatever has arrived, discarded. Nothing is buffered and nothing is
        // parsed; `Ok(None)` is the peer's FIN.
        while let Ok(Some(_chunk)) = recv.read_chunk(4096, false).await {}
    });
}

/// Read one accepted stream's header **off the accept loop's critical path**,
/// and hand the stream on if it is this session's.
///
/// This spawn is the fix for the defect this path had: reading the header
/// inline meant the *first* stream to go quiet — an HTTP/3 control or QPACK
/// stream that Chromium opens beside the session and does not write to
/// immediately — parked the accept loop forever, and every keyframe stream the
/// browser opened behind it queued in quinn and was never accepted. Video
/// therefore never arrived at all while audio, which rides datagrams, was fine.
///
/// `surface` turns the readable half into whatever the caller receives: the
/// receive stream alone for a unidirectional stream, the pair for a
/// bidirectional one.
///
/// Streams are surfaced in header-completion order rather than accept order.
/// Nothing downstream depends on accept order — the relay spawns a task per
/// stream the moment it has one — and each stream is a whole self-describing
/// frame.
fn classify_in_background<T, F>(
    mut recv: quinn::RecvStream,
    expected_type: u64,
    session_id: u64,
    surface: F,
    tx: tokio::sync::mpsc::Sender<T>,
    pending: &Arc<tokio::sync::Semaphore>,
    ignored: &Arc<tokio::sync::Semaphore>,
) where
    T: Send + 'static,
    F: FnOnce(quinn::RecvStream) -> T + Send + 'static,
{
    let direction = if expected_type == WEBTRANSPORT_UNI_STREAM_TYPE {
        "unidirectional"
    } else {
        "bidirectional"
    };
    let Ok(permit) = Arc::clone(pending).try_acquire_owned() else {
        tracing::warn!(
            session_id,
            direction,
            limit = MAX_PENDING_STREAM_HEADERS,
            "resetting a stream: too many accepted streams have not declared themselves"
        );
        return;
    };
    let ignored = Arc::clone(ignored);
    tokio::spawn(async move {
        let header = tokio::time::timeout(
            STREAM_HEADER_TIMEOUT,
            strip_stream_header(&mut recv, expected_type, session_id),
        )
        .await;
        let unclaimed = match header {
            Ok(Ok(())) => {
                // Ours. The permit is held until the caller has it, so the
                // queue's bound is the real ceiling on streams in flight.
                let _ = tx.send(surface(recv)).await;
                drop(permit);
                return;
            }
            Ok(Err(FramingError::UnexpectedStreamType { actual, .. })) => {
                describe_stream_type(actual)
            }
            Ok(Err(FramingError::SessionMismatch { actual, .. })) => {
                format!("a WebTransport stream of session {actual}")
            }
            Ok(Err(err)) => format!("an unreadable stream ({err})"),
            Err(_elapsed) => "a stream that never declared a type".to_string(),
        };
        drop(permit);
        ignore_foreign_stream(recv, session_id, direction, unclaimed, ignored);
    });
}

/// The classified-stream queues of one session.
#[derive(Debug)]
struct SessionStreamQueues {
    uni: tokio::sync::Mutex<tokio::sync::mpsc::Receiver<quinn::RecvStream>>,
    bi: tokio::sync::Mutex<tokio::sync::mpsc::Receiver<(quinn::SendStream, quinn::RecvStream)>>,
}

/// The accept loops of one session, started on first use and shared by every
/// clone of its [`WebTransportStreams`].
#[derive(Debug)]
struct StreamDemux {
    conn: quinn::Connection,
    session_id: u64,
    queues: tokio::sync::OnceCell<SessionStreamQueues>,
}

impl StreamDemux {
    /// The queues, starting the accept loops if this is the first caller.
    ///
    /// Lazy so that constructing a [`WebTransportStreams`] outside a Tokio
    /// runtime is still just arithmetic; by the time anybody accepts a stream
    /// there is a runtime by definition.
    async fn queues(&self) -> &SessionStreamQueues {
        self.queues.get_or_init(|| async { self.start() }).await
    }

    /// Spawn one accept loop per direction. Each loop does nothing but accept
    /// and hand off — every byte of every header is read elsewhere.
    fn start(&self) -> SessionStreamQueues {
        let (uni_tx, uni_rx) = tokio::sync::mpsc::channel(ACCEPT_QUEUE_CAPACITY);
        let (bi_tx, bi_rx) = tokio::sync::mpsc::channel(ACCEPT_QUEUE_CAPACITY);
        let pending = Arc::new(tokio::sync::Semaphore::new(MAX_PENDING_STREAM_HEADERS));
        let ignored = Arc::new(tokio::sync::Semaphore::new(MAX_IGNORED_STREAMS));
        let session_id = self.session_id;

        let conn = self.conn.clone();
        let (loop_pending, loop_ignored) = (Arc::clone(&pending), Arc::clone(&ignored));
        tokio::spawn(async move {
            loop {
                let recv = tokio::select! {
                    accepted = conn.accept_uni() => match accepted {
                        Ok(recv) => recv,
                        Err(err) => {
                            tracing::debug!(
                                session_id,
                                error = %err,
                                "WebTransport unidirectional accept loop stopping"
                            );
                            break;
                        }
                    },
                    // Nobody is left to take them: stop, and let the
                    // connection handle this loop holds go with it.
                    () = uni_tx.closed() => break,
                };
                classify_in_background(
                    recv,
                    WEBTRANSPORT_UNI_STREAM_TYPE,
                    session_id,
                    |recv| recv,
                    uni_tx.clone(),
                    &loop_pending,
                    &loop_ignored,
                );
            }
        });

        let conn = self.conn.clone();
        tokio::spawn(async move {
            loop {
                let (send, recv) = tokio::select! {
                    accepted = conn.accept_bi() => match accepted {
                        Ok(pair) => pair,
                        Err(err) => {
                            tracing::debug!(
                                session_id,
                                error = %err,
                                "WebTransport bidirectional accept loop stopping"
                            );
                            break;
                        }
                    },
                    () = bi_tx.closed() => break,
                };
                classify_in_background(
                    recv,
                    WEBTRANSPORT_BIDI_STREAM_TYPE,
                    session_id,
                    move |recv| (send, recv),
                    bi_tx.clone(),
                    &pending,
                    &ignored,
                );
            }
        });

        SessionStreamQueues {
            uni: tokio::sync::Mutex::new(uni_rx),
            bi: tokio::sync::Mutex::new(bi_rx),
        }
    }

    /// Why there will be no more streams. The accept loops only ever stop on a
    /// connection error, so by the time a queue runs dry the connection has a
    /// close reason to give.
    fn terminal_error(&self) -> quinn::ConnectionError {
        self.conn
            .close_reason()
            .unwrap_or(quinn::ConnectionError::LocallyClosed)
    }
}

/// Opens and accepts WebTransport streams on one session, applying the HTTP/3
/// framing described in this module's header.
///
/// Cheap to clone — a handle on the session's shared accept loops — so every
/// task that needs to move a stream can hold one. Clones share one queue per
/// direction: a stream is delivered to exactly one caller.
#[derive(Clone, Debug)]
pub struct WebTransportStreams {
    demux: Arc<StreamDemux>,
}

impl WebTransportStreams {
    /// Frame streams for `session_id` on `conn`.
    ///
    /// `session_id` is the stream id of the extended-CONNECT request the session
    /// was established on.
    pub fn new(conn: quinn::Connection, session_id: u64) -> Self {
        Self {
            demux: Arc::new(StreamDemux {
                conn,
                session_id,
                queues: tokio::sync::OnceCell::new(),
            }),
        }
    }

    /// The WebTransport session id these streams are tagged with.
    pub fn session_id(&self) -> u64 {
        self.demux.session_id
    }

    /// The RFC 9297 quarter stream id that prefixes this session's datagrams.
    pub fn datagram_quarter_stream_id(&self) -> u64 {
        datagram_quarter_stream_id(self.demux.session_id)
    }

    /// The underlying QUIC connection (statistics, close reason, teardown).
    pub fn connection(&self) -> &quinn::Connection {
        &self.demux.conn
    }

    /// Open a bidirectional stream to the peer, headed for this session.
    ///
    /// The header is written before the caller gets the stream, so the first
    /// bytes the caller writes are the first bytes of the *payload*.
    pub async fn open_bi(&self) -> Result<(quinn::SendStream, quinn::RecvStream), FramingError> {
        let (mut send, recv) = self.demux.conn.open_bi().await?;
        send.write_all(&stream_header(
            WEBTRANSPORT_BIDI_STREAM_TYPE,
            self.demux.session_id,
        ))
        .await?;
        Ok((send, recv))
    }

    /// Open a unidirectional stream to the peer, headed for this session.
    pub async fn open_uni(&self) -> Result<quinn::SendStream, FramingError> {
        let mut send = self.demux.conn.open_uni().await?;
        send.write_all(&stream_header(
            WEBTRANSPORT_UNI_STREAM_TYPE,
            self.demux.session_id,
        ))
        .await?;
        Ok(send)
    }

    /// Accept the next bidirectional stream **belonging to this session**,
    /// header stripped.
    ///
    /// A WebTransport session shares its QUIC connection with the HTTP/3 layer
    /// underneath it, so the connection's accept queue is not this session's
    /// alone: the browser's control stream, its two QPACK streams, a GREASE
    /// stream and any other session's WebTransport streams arrive in the same
    /// queue. Those are consumed and ignored, never surfaced and never reset —
    /// and, crucially, never waited for. Only the connection ending ends this.
    ///
    /// Cancel-safe: the classification of every accepted stream lives in its own
    /// task, so dropping this future (the relay selects on it) loses nothing.
    pub async fn accept_bi(
        &self,
    ) -> Result<(quinn::SendStream, quinn::RecvStream), quinn::ConnectionError> {
        let queues = self.demux.queues().await;
        let mut queue = queues.bi.lock().await;
        queue
            .recv()
            .await
            .ok_or_else(|| self.demux.terminal_error())
    }

    /// Accept the next unidirectional stream belonging to this session, header
    /// stripped. Same rules as [`Self::accept_bi`].
    pub async fn accept_uni(&self) -> Result<quinn::RecvStream, quinn::ConnectionError> {
        let queues = self.demux.queues().await;
        let mut queue = queues.uni.lock().await;
        queue
            .recv()
            .await
            .ok_or_else(|| self.demux.terminal_error())
    }
}

/// A WebTransport session wrapping the underlying QUIC connection.
///
/// Provides the same datagram/stream interface as `MediaConnection`
/// so browser clients can interop with native QUIC clients.
pub struct WebTransportSession {
    streams: WebTransportStreams,
    path: String,
    /// The extended-CONNECT request stream this session was established on.
    ///
    /// A WebTransport session lives exactly as long as its CONNECT stream, in
    /// both directions: dropping this signals the browser that the session
    /// ended, and the browser ending the session closes its half of this
    /// stream. [`Self::closed`] watches for the latter. `None` only in tests
    /// that synthesise a session over a raw QUIC pair.
    connect_stream: Option<h3::server::RequestStream<h3_quinn::BidiStream<Bytes>, Bytes>>,
}

impl WebTransportSession {
    /// The request path from the CONNECT request.
    pub fn path(&self) -> &str {
        &self.path
    }

    /// The session id (the CONNECT request's stream id).
    pub fn session_id(&self) -> u64 {
        self.streams.session_id()
    }

    /// A cloneable framer for this session's streams.
    pub fn streams(&self) -> WebTransportStreams {
        self.streams.clone()
    }

    /// Send an unreliable datagram (for media packets).
    ///
    /// Raw: the caller is responsible for the quarter-stream-id prefix. Prefer
    /// [`Self::spawn_datagram_bridge`], which applies it.
    pub fn send_datagram(&self, data: Bytes) -> Result<(), quinn::SendDatagramError> {
        self.streams.connection().send_datagram(data)
    }

    /// Receive an unreliable datagram (quarter-stream-id prefix included).
    pub async fn read_datagram(&self) -> Result<Bytes, quinn::ConnectionError> {
        self.streams.connection().read_datagram().await
    }

    /// Open a bidirectional stream to the browser (header prepended).
    pub async fn open_bi(&self) -> Result<(quinn::SendStream, quinn::RecvStream), FramingError> {
        self.streams.open_bi().await
    }

    /// Accept a bidirectional stream from the browser (header stripped).
    pub async fn accept_bi(
        &self,
    ) -> Result<(quinn::SendStream, quinn::RecvStream), quinn::ConnectionError> {
        self.streams.accept_bi().await
    }

    /// Open a unidirectional stream to the browser.
    ///
    /// The uni-stream bridge carries whole-frame keyframe messages (contract S5)
    /// byte-for-byte in the exact same wire framing as native QUIC uni streams —
    /// behind the WebTransport stream header, which is HTTP/3 envelope and not
    /// part of the message.
    pub async fn open_uni(&self) -> Result<quinn::SendStream, FramingError> {
        self.streams.open_uni().await
    }

    /// Accept a unidirectional stream from the browser (one whole keyframe frame).
    ///
    /// Mirror of [`Self::open_uni`] for the browser→relay direction: the bridge
    /// relays these to the relay ingress as QUIC uni streams, header stripped.
    pub async fn accept_uni(&self) -> Result<quinn::RecvStream, quinn::ConnectionError> {
        self.streams.accept_uni().await
    }

    /// Remote address of the browser client.
    pub fn remote_address(&self) -> SocketAddr {
        self.streams.connection().remote_address()
    }

    /// Get a reference to the underlying QUIC connection.
    pub fn quinn_conn(&self) -> &quinn::Connection {
        self.streams.connection()
    }

    /// Spawn this session's datagram bridge with the session's own quarter
    /// stream id, so outbound datagrams are attributed to it and inbound ones
    /// that name a different session are dropped.
    pub fn spawn_datagram_bridge(
        &self,
    ) -> (
        tokio::sync::mpsc::Sender<Bytes>,
        tokio::sync::mpsc::Receiver<Bytes>,
    ) {
        spawn_webtransport_bridge(
            self.streams.connection().clone(),
            self.streams.datagram_quarter_stream_id(),
        )
    }

    /// Resolve when this WebTransport session ends, describing why.
    ///
    /// A browser does **not** tear a session down by closing the QUIC
    /// connection: the connection is the HTTP/3 connection, which may carry
    /// other sessions and which Chromium keeps warm afterwards. It closes the
    /// session's CONNECT stream instead (a `CLOSE_WEBTRANSPORT_SESSION`
    /// capsule, then FIN). Waiting only on `Connection::closed` therefore keeps
    /// a departed participant registered with the relay until the QUIC idle
    /// timeout — observed as a call that stayed "connected" server-side for
    /// ~30 s after the user pressed Disconnect.
    ///
    /// So watch both: whichever ends first ends the session. Capsule bodies are
    /// drained and discarded — the only fact needed here is that the stream
    /// stopped.
    pub async fn closed(&mut self) -> String {
        let conn = self.streams.connection().clone();
        let Some(stream) = self.connect_stream.as_mut() else {
            return conn.closed().await.to_string();
        };
        tokio::select! {
            reason = conn.closed() => reason.to_string(),
            () = drain_connect_stream(stream) => {
                "WebTransport session closed by the client".to_string()
            }
        }
    }

    /// Close the session.
    pub fn close(&self, reason: &str) {
        self.streams
            .connection()
            .close(quinn::VarInt::from_u32(1), reason.as_bytes());
    }
}

/// Read the CONNECT stream until it stops producing data, for any reason.
async fn drain_connect_stream(
    stream: &mut h3::server::RequestStream<h3_quinn::BidiStream<Bytes>, Bytes>,
) {
    while let Ok(Some(_capsule)) = stream.recv_data().await {}
}

// ── QSID datagram bridge ────────────────────────────────────────────────

/// Bound on each WebTransport bridge channel, in datagrams.
///
/// The bridge is an extra queue hop between the QUIC connection and the relay.
/// Unbounded, a stalled peer (slow browser downlink, or a relay reader that
/// falls behind) lets the queue grow without limit and buffers seconds of stale
/// media. Bounding it caps that backlog; media is unreliable, so an over-full
/// bridge drops the datagram rather than blocking — the same shedding quinn
/// does when its own datagram buffer overflows. Sized to clear a fragmented
/// keyframe burst without hoarding.
const BRIDGE_CHANNEL_CAPACITY: usize = 8192;

/// Spawn a datagram bridge that translates between HTTP/3 datagrams
/// (with QSID varint prefix) and raw media packets.
///
/// Returns `(outbound_tx, inbound_rx)` channels:
/// - Write raw media packets to `outbound_tx` → bridge prepends QSID and
///   sends via the QUIC connection.
/// - Read raw media packets from `inbound_rx` ← bridge strips QSID from
///   incoming QUIC datagrams.
///
/// A datagram whose quarter stream id names a *different* session is dropped
/// rather than forwarded as media: it does not belong to this session, and its
/// first payload byte would otherwise be read as part of a [`MediaHeader`].
///
/// [`MediaHeader`]: crate::protocol::MediaHeader
pub fn spawn_webtransport_bridge(
    quinn_conn: quinn::Connection,
    qsid: u64,
) -> (
    tokio::sync::mpsc::Sender<Bytes>,
    tokio::sync::mpsc::Receiver<Bytes>,
) {
    let (outbound_tx, mut outbound_rx) =
        tokio::sync::mpsc::channel::<Bytes>(BRIDGE_CHANNEL_CAPACITY);
    let (inbound_tx, inbound_rx) = tokio::sync::mpsc::channel::<Bytes>(BRIDGE_CHANNEL_CAPACITY);

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
            if let Some((qsid_val, prefix_len)) = decode_quic_varint(&datagram) {
                if qsid_val == qsid && prefix_len <= datagram.len() {
                    let raw = datagram.slice(prefix_len..);
                    // Unreliable media: if the relay reader is behind, drop
                    // rather than block the QUIC read loop. A closed receiver
                    // means the session is gone, so stop the bridge.
                    match inbound_tx.try_send(raw) {
                        Ok(()) => {}
                        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {}
                        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => break,
                    }
                }
            }
        }
    });

    (outbound_tx, inbound_rx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::endpoint::{certificate_hash, generate_self_signed_cert, MediaEndpoint};

    /// Establish a raw QUIC loopback pair, returning `(server_conn, client_conn)`.
    /// Stands in for the h3-quinn WebTransport connection, whose streams are
    /// quinn streams carrying the HTTP/3 WebTransport header this module adds.
    async fn quinn_pair() -> (quinn::Connection, quinn::Connection) {
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
        // Keep the endpoints alive for the duration of the connection by leaking
        // them into the test process; they are cleaned up on process exit.
        std::mem::forget(server);
        std::mem::forget(client);
        (server_conn, client_conn)
    }

    fn wt_session(conn: quinn::Connection, session_id: u64) -> WebTransportSession {
        WebTransportSession {
            streams: WebTransportStreams::new(conn, session_id),
            path: "/media".to_string(),
            connect_stream: None,
        }
    }

    /// Every varint width round trips, and each value uses the *smallest*
    /// encoding — a session id of 0 (the usual CONNECT stream) must be one byte,
    /// because that is what a browser writes and what it expects back.
    #[test]
    fn varint_round_trips_at_every_width() {
        for (value, width) in [
            (0u64, 1usize),
            (1, 1),
            (63, 1),
            (64, 2),
            (16_383, 2),
            (16_384, 4),
            (1_073_741_823, 4),
            (1_073_741_824, 8),
            (4_611_686_018_427_387_903, 8),
        ] {
            let encoded = encode_quic_varint(value);
            assert_eq!(encoded.len(), width, "width of {value}");
            assert_eq!(
                decode_quic_varint(&encoded),
                Some((value, width)),
                "round trip of {value}"
            );
        }
    }

    /// A truncated varint is not silently read as a shorter one.
    #[test]
    fn truncated_varint_is_rejected() {
        assert_eq!(decode_quic_varint(&[]), None);
        // 0x40.. declares two bytes; only one is present.
        assert_eq!(decode_quic_varint(&[0x40]), None);
        // 0x80.. declares four.
        assert_eq!(decode_quic_varint(&[0x80, 0x00, 0x00]), None);
        // 0xc0.. declares eight.
        assert_eq!(decode_quic_varint(&[0xc0, 0, 0, 0, 0, 0, 0]), None);
    }

    /// The header this module writes is exactly what
    /// draft-ietf-webtrans-http3 specifies: the stream type varint, then the
    /// session id varint, smallest encoding each.
    ///
    /// Both stream types are past 63, so each is a **two**-byte varint on the
    /// wire (`0x41` → `0x40 0x41`). Writing the raw byte instead would name
    /// stream type 1 (HTTP/3 PUSH) and lose the session id's first byte.
    #[test]
    fn stream_headers_match_the_wire_format() {
        assert_eq!(
            stream_header(WEBTRANSPORT_BIDI_STREAM_TYPE, 0),
            vec![0x40, 0x41, 0x00]
        );
        assert_eq!(
            stream_header(WEBTRANSPORT_UNI_STREAM_TYPE, 0),
            vec![0x40, 0x54, 0x00]
        );
        // A CONNECT on client bidi stream 4 gives session id 4.
        assert_eq!(
            stream_header(WEBTRANSPORT_BIDI_STREAM_TYPE, 4),
            vec![0x40, 0x41, 0x04]
        );
        // Session ids past 63 spill into the two-byte encoding as well.
        assert_eq!(
            stream_header(WEBTRANSPORT_UNI_STREAM_TYPE, 64),
            vec![0x40, 0x54, 0x40, 0x40]
        );
    }

    /// The quarter stream id is the CONNECT stream id divided by four
    /// (RFC 9297 §2.1).
    #[test]
    fn datagram_quarter_stream_id_is_the_session_id_over_four() {
        for (session_id, expected) in [(0u64, 0u64), (4, 1), (8, 2), (400, 100)] {
            assert_eq!(datagram_quarter_stream_id(session_id), expected);
        }
    }

    /// A bidirectional stream opened by either side must arrive with the
    /// WebTransport header on the wire and *without* it in the payload the peer
    /// reads — in both directions, which is what makes a browser's auth stream
    /// and the relay's control streams interoperate.
    #[tokio::test]
    async fn bi_stream_round_trip_strips_and_prepends_the_header() {
        let (server_conn, client_conn) = quinn_pair().await;
        let server = WebTransportStreams::new(server_conn, 0);
        let client = WebTransportStreams::new(client_conn, 0);

        // browser → relay (this is the auth stream).
        let payload = b"\x00\x00\x00\x04auth".to_vec();
        let (mut send, _recv) = client.open_bi().await.unwrap();
        send.write_all(&payload).await.unwrap();
        send.finish().unwrap();
        let (_send, mut recv) = server.accept_bi().await.unwrap();
        let got = recv.read_to_end(4096).await.unwrap();
        assert_eq!(got, payload, "relay reads the payload, not the header");

        // relay → browser (this is a control message).
        let control = b"\x00\x00\x00\x02hi".to_vec();
        let (mut send, _recv) = server.open_bi().await.unwrap();
        send.write_all(&control).await.unwrap();
        send.finish().unwrap();
        let (_send, mut recv) = client.accept_bi().await.unwrap();
        let got = recv.read_to_end(4096).await.unwrap();
        assert_eq!(got, control, "browser reads the payload, not the header");
    }

    /// A whole-frame keyframe message written on a WebTransport uni stream must
    /// arrive at the peer byte-for-byte, in BOTH directions (contract S5). The
    /// FIN delimits the message, so `read_to_end` recovers exactly the bytes sent.
    #[tokio::test]
    async fn uni_stream_round_trip_is_byte_identical_both_directions() {
        let (server_conn, client_conn) = quinn_pair().await;
        let server = wt_session(server_conn, 0);
        let client = wt_session(client_conn, 0);

        // relay → browser: server opens a uni stream, browser accepts + drains it.
        let frame_a = Bytes::from((0u32..4096).map(|i| i as u8).collect::<Vec<u8>>());
        let mut send = server.open_uni().await.unwrap();
        send.write_all(&frame_a).await.unwrap();
        send.finish().unwrap();
        let mut recv = client.accept_uni().await.unwrap();
        let got_a = recv.read_to_end(1024 * 1024).await.unwrap();
        assert_eq!(
            got_a.as_slice(),
            frame_a.as_ref(),
            "relay→browser byte-identical"
        );

        // browser → relay: browser opens a uni stream, relay accepts + drains it.
        let frame_b = Bytes::from(vec![0xABu8; 70_000]);
        let mut send = client.open_uni().await.unwrap();
        send.write_all(&frame_b).await.unwrap();
        send.finish().unwrap();
        let mut recv = server.accept_uni().await.unwrap();
        let got_b = recv.read_to_end(1024 * 1024).await.unwrap();
        assert_eq!(
            got_b.as_slice(),
            frame_b.as_ref(),
            "browser→relay byte-identical"
        );
    }

    /// A multi-byte session id is read back exactly, so a CONNECT that did not
    /// land on stream 0 still works (the header then spans three bytes, and a
    /// reader that assumed two would eat a payload byte).
    #[tokio::test]
    async fn a_multi_byte_session_id_is_framed_and_stripped_exactly() {
        let (server_conn, client_conn) = quinn_pair().await;
        let server = WebTransportStreams::new(server_conn, 1_000);
        let client = WebTransportStreams::new(client_conn, 1_000);
        assert_eq!(encode_quic_varint(1_000).len(), 2, "two-byte session id");

        let payload = vec![0x5A; 1024];
        let mut send = client.open_uni().await.unwrap();
        send.write_all(&payload).await.unwrap();
        send.finish().unwrap();
        let mut recv = server.accept_uni().await.unwrap();
        assert_eq!(recv.read_to_end(8192).await.unwrap(), payload);
    }

    /// A stream tagged with someone else's session is never handed to the media
    /// reader — the reader would see a corrupt first byte — and it does not stop
    /// this session's own stream from arriving behind it.
    #[tokio::test]
    async fn a_stream_naming_another_session_is_never_surfaced() {
        let (server_conn, client_conn) = quinn_pair().await;
        let server = WebTransportStreams::new(server_conn, 0);
        let impostor = WebTransportStreams::new(client_conn.clone(), 4);

        let mut send = impostor.open_uni().await.unwrap();
        send.write_all(b"not ours").await.unwrap();
        send.finish().unwrap();

        let mut ours = WebTransportStreams::new(client_conn, 0)
            .open_uni()
            .await
            .unwrap();
        ours.write_all(b"ours").await.unwrap();
        ours.finish().unwrap();

        let mut recv = tokio::time::timeout(Duration::from_secs(5), server.accept_uni())
            .await
            .expect("this session's stream arrives")
            .expect("no connection error");
        assert_eq!(
            recv.read_to_end(4096).await.unwrap(),
            b"ours",
            "the other session's stream must not be surfaced as this one's"
        );
    }

    /// A uni stream that is not a WebTransport stream at all — the HTTP/3
    /// control stream, say — is read and thrown away, **not** reset.
    ///
    /// Dropping the handle is the obvious way to ignore it and the wrong one:
    /// quinn sends STOP_SENDING for a `RecvStream` dropped before EOF, and
    /// RFC 9114 §6.2.1 makes closing a critical stream a connection error, so a
    /// browser answers by closing the whole HTTP/3 connection — and the call
    /// with it. The proof is that the peer can still write to it afterwards.
    #[tokio::test]
    async fn an_http3_critical_stream_is_drained_rather_than_reset() {
        let (server_conn, client_conn) = quinn_pair().await;
        let server = WebTransportStreams::new(server_conn, 0);

        // 0x00 is the HTTP/3 CONTROL stream type, and it stays open for the
        // life of the connection.
        let mut control = client_conn.open_uni().await.unwrap();
        control.write_all(&[0x00]).await.unwrap();

        // This session's own stream, opened behind it, still arrives.
        let mut ours = WebTransportStreams::new(client_conn, 0)
            .open_uni()
            .await
            .unwrap();
        ours.write_all(b"keyframe").await.unwrap();
        ours.finish().unwrap();
        let mut recv = tokio::time::timeout(Duration::from_secs(5), server.accept_uni())
            .await
            .expect("the session's own stream arrives")
            .expect("no connection error");
        assert_eq!(recv.read_to_end(4096).await.unwrap(), b"keyframe");

        // And the control stream is still writable: nothing stopped it.
        tokio::time::sleep(Duration::from_millis(200)).await;
        control
            .write_all(&[0x04, 0x00])
            .await
            .expect("an ignored HTTP/3 control stream must not be reset");
    }

    /// The defect this accept path was rebuilt for: a stream that is accepted
    /// and then says nothing must not hold up the streams behind it.
    ///
    /// Chromium opens its HTTP/3 control and QPACK streams beside the
    /// WebTransport session, and one of them can sit silent. Reading each
    /// header inline and in order parked the accept loop on that stream
    /// forever, so every keyframe uni stream the browser opened afterwards
    /// queued in quinn and was never accepted — 87 opened, 0 received, no
    /// remote video anywhere while audio (which rides datagrams) was fine.
    #[tokio::test]
    async fn a_silent_stream_does_not_block_the_keyframes_behind_it() {
        let (server_conn, client_conn) = quinn_pair().await;
        let server = WebTransportStreams::new(server_conn, 0);
        let browser = WebTransportStreams::new(client_conn.clone(), 0);

        // A stream that is opened and never written to. `open_uni` alone does
        // not put the stream on the wire, so write one byte that is not a
        // complete header and then stop, which is exactly the shape that parked
        // the old loop inside its first `read_varint`.
        let mut silent = client_conn.open_uni().await.unwrap();
        silent.write_all(&[0x40]).await.unwrap();

        // Ten keyframes behind it.
        for i in 0..10u8 {
            let mut send = browser.open_uni().await.unwrap();
            send.write_all(&[i; 64]).await.unwrap();
            send.finish().unwrap();
        }

        for i in 0..10u8 {
            let mut recv = tokio::time::timeout(Duration::from_secs(5), server.accept_uni())
                .await
                .unwrap_or_else(|_| panic!("keyframe {i} must not queue behind a silent stream"))
                .expect("no connection error");
            assert_eq!(recv.read_to_end(4096).await.unwrap().len(), 64);
        }
    }

    /// The same, bidirectionally: the control plane's streams must not queue
    /// behind an HTTP/3 request stream that has sent no frame yet.
    #[tokio::test]
    async fn a_silent_stream_does_not_block_the_control_streams_behind_it() {
        let (server_conn, client_conn) = quinn_pair().await;
        let server = WebTransportStreams::new(server_conn, 0);
        let browser = WebTransportStreams::new(client_conn.clone(), 0);

        let (mut silent, _silent_recv) = client_conn.open_bi().await.unwrap();
        silent.write_all(&[0x40]).await.unwrap();

        let (mut send, _recv) = browser.open_bi().await.unwrap();
        send.write_all(b"\x00\x00\x00\x02hi").await.unwrap();
        send.finish().unwrap();

        let (_send, mut recv) = tokio::time::timeout(Duration::from_secs(5), server.accept_bi())
            .await
            .expect("the control stream must not queue behind a silent stream")
            .expect("no connection error");
        assert_eq!(recv.read_to_end(4096).await.unwrap(), b"\x00\x00\x00\x02hi");
    }

    /// GREASE stream types (RFC 9114 §6.2.3) are recognized as something to
    /// ignore rather than mistaken for a WebTransport stream.
    #[test]
    fn grease_stream_types_are_recognized() {
        for reserved in [0x21u64, 0x21 + 0x1f, 0x21 + 0x1f * 2, 0x21 + 0x1f * 1000] {
            assert!(is_grease_stream_type(reserved), "{reserved:#x}");
            assert!(describe_stream_type(reserved).contains("GREASE"));
        }
        for known in [0x00u64, 0x01, 0x02, 0x03, WEBTRANSPORT_UNI_STREAM_TYPE] {
            assert!(!is_grease_stream_type(known), "{known:#x}");
        }
        assert_eq!(describe_stream_type(0x00), "the HTTP/3 control stream");
        assert_eq!(describe_stream_type(0x02), "the QPACK encoder stream");
        assert_eq!(describe_stream_type(0x03), "the QPACK decoder stream");
    }

    /// The HTTP/3 connection under a WebTransport session carries streams that
    /// are not the session's — its own control and QPACK streams, and any other
    /// session multiplexed onto the same connection. `accept_uni` must skip
    /// those and keep waiting, because the relay's accept loop stops on error:
    /// returning a stray HTTP/3 control stream as a failure would end a healthy
    /// call's keyframe path.
    #[tokio::test]
    async fn foreign_streams_are_skipped_rather_than_ending_the_accept_loop() {
        let (server_conn, client_conn) = quinn_pair().await;
        let server = WebTransportStreams::new(server_conn, 0);
        let other_session = WebTransportStreams::new(client_conn.clone(), 4);

        // An HTTP/3 QPACK encoder stream (type 0x02)…
        let mut qpack = client_conn.open_uni().await.unwrap();
        qpack.write_all(&[0x02]).await.unwrap();
        qpack.finish().unwrap();
        // …and another session's WebTransport stream…
        let mut foreign = other_session.open_uni().await.unwrap();
        foreign.write_all(b"not ours").await.unwrap();
        foreign.finish().unwrap();
        // …then this session's actual keyframe.
        let mut ours = WebTransportStreams::new(client_conn, 0)
            .open_uni()
            .await
            .unwrap();
        ours.write_all(b"keyframe").await.unwrap();
        ours.finish().unwrap();

        let mut recv = tokio::time::timeout(std::time::Duration::from_secs(5), server.accept_uni())
            .await
            .expect("the session's own stream arrives")
            .expect("no connection error");
        assert_eq!(recv.read_to_end(4096).await.unwrap(), b"keyframe");
    }

    /// The datagram bridge tags outbound packets with the session's quarter
    /// stream id, strips it from inbound ones, and drops anything addressed to a
    /// different session rather than feeding it to the media header decoder.
    #[tokio::test]
    async fn datagram_bridge_applies_and_filters_the_quarter_stream_id() {
        let (server_conn, client_conn) = quinn_pair().await;
        // A CONNECT on stream 4 → session id 4 → quarter stream id 1.
        let qsid = WebTransportStreams::new(server_conn.clone(), 4).datagram_quarter_stream_id();
        assert_eq!(qsid, 1);
        let (outbound_tx, mut inbound_rx) = spawn_webtransport_bridge(server_conn, qsid);

        // relay → browser: the browser sees the quarter stream id, then media.
        outbound_tx
            .send(Bytes::from_static(b"media"))
            .await
            .unwrap();
        let seen = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            client_conn.read_datagram(),
        )
        .await
        .expect("datagram arrives")
        .unwrap();
        assert_eq!(seen.as_ref(), b"\x01media");

        // browser → relay: a datagram for another session is dropped...
        client_conn
            .send_datagram(Bytes::from_static(b"\x09wrong"))
            .unwrap();
        // ...while this session's is delivered with the prefix removed.
        client_conn
            .send_datagram(Bytes::from_static(b"\x01right"))
            .unwrap();
        let got = tokio::time::timeout(std::time::Duration::from_secs(5), inbound_rx.recv())
            .await
            .expect("datagram arrives")
            .expect("bridge still open");
        assert_eq!(
            got.as_ref(),
            b"right",
            "the mis-addressed datagram must not reach the relay"
        );
    }
}
