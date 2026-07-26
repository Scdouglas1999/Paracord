//! QUIC endpoint setup and configuration.
//!
//! Provides `MediaEndpoint` for both server (relay) and client (P2P) modes,
//! with self-signed certificate generation for development.

use std::net::SocketAddr;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use quinn::crypto::rustls::QuicServerConfig;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use sha2::{Digest, Sha256};

use crate::ensure_rustls_provider;

/// TLS configuration for a media endpoint.
pub struct TlsConfig {
    pub cert_chain: Vec<CertificateDer<'static>>,
    pub private_key: PrivateKeyDer<'static>,
}

/// A QUIC endpoint that can act as both server and client.
pub struct MediaEndpoint {
    endpoint: quinn::Endpoint,
}

/// Send-side datagram buffer for publisher/client endpoints.
///
/// Video frames are fragmented into MTU-sized unreliable datagrams, so a single
/// keyframe at screen-share bitrates is a burst of hundreds of datagrams.
/// quinn's default datagram send buffer is ~50 KB; anything beyond it is
/// silently dropped before reaching the wire, starving frame reassembly
/// (whole-frame loss). Publishers must absorb multi-megabyte keyframe bursts.
const CLIENT_DATAGRAM_SEND_BUFFER: usize = 8 * 1024 * 1024;

/// Send-side datagram buffer for the relay's server endpoint (egress to viewers).
///
/// On relay->viewer egress a large send buffer is harmful, not helpful: it lets
/// quinn queue several seconds of stale video before it starts dropping, so a
/// viewer whose downlink briefly dips sees latency balloon instead of the relay
/// shedding old frames. A ~1MB egress buffer bounds queued staleness to a
/// fraction of a second while still clearing a single fragmented frame.
const RELAY_EGRESS_DATAGRAM_SEND_BUFFER: usize = 1024 * 1024;

/// Receive-side datagram buffer, sized to absorb an ingress keyframe burst.
///
/// This is a *ceiling*, not a reservation: quinn queues received datagrams
/// lazily and drops from the front once the queue exceeds it, so an idle
/// connection costs nothing. It still bounds how much one connection can pin
/// before the relay reads from it — including a connection that has completed
/// the handshake but not yet authenticated. That window is bounded separately by
/// [`crate::admission::PreAuthAdmission`] (a global and per-IP ceiling on
/// unauthenticated connections) rather than by shrinking this value, which a
/// legitimate publisher needs to keep whole keyframes off the floor.
const DATAGRAM_RECEIVE_BUFFER: usize = 8 * 1024 * 1024;

/// Concurrent unidirectional streams a peer may open toward this endpoint.
///
/// The loss-resilient keyframe path opens one uni stream per whole keyframe
/// (publisher->relay and relay->each viewer). One stream is normally in flight
/// per track at a time, but under loss a retransmitting keyframe can briefly
/// overlap the next, and a viewer subscribed to several tracks multiplies that.
/// A generous ceiling keeps a keyframe from ever being flow-controlled off the
/// wire while still bounding how many streams a peer can hold open.
const MAX_CONCURRENT_UNI_STREAMS: u32 = 256;

fn base_transport_config(send_buffer: usize) -> quinn::TransportConfig {
    let mut transport = quinn::TransportConfig::default();
    transport.datagram_send_buffer_size(send_buffer);
    transport.datagram_receive_buffer_size(Some(DATAGRAM_RECEIVE_BUFFER));
    transport.max_concurrent_uni_streams(MAX_CONCURRENT_UNI_STREAMS.into());
    // quinn defaults to a 30s idle timeout with NO keep-alive pings. Media
    // sessions must survive quiet periods (voice-only lulls, brief encoder
    // stalls, a co-located server briefly starved for CPU) without the
    // connection being torn down as "timed out".
    transport.keep_alive_interval(Some(std::time::Duration::from_secs(5)));
    transport.max_idle_timeout(Some(
        quinn::IdleTimeout::try_from(std::time::Duration::from_secs(30))
            .expect("30s fits in a QUIC idle timeout"),
    ));
    transport
}

/// Transport tuning for the relay's server endpoint (bounded egress buffer).
pub(crate) fn server_transport_config() -> Arc<quinn::TransportConfig> {
    Arc::new(base_transport_config(RELAY_EGRESS_DATAGRAM_SEND_BUFFER))
}

/// Transport tuning for publisher/client endpoints (large keyframe-burst buffer).
pub(crate) fn client_transport_config() -> Arc<quinn::TransportConfig> {
    Arc::new(base_transport_config(CLIENT_DATAGRAM_SEND_BUFFER))
}

impl MediaEndpoint {
    /// Bind a QUIC endpoint to the given address with the provided TLS config.
    ///
    /// Outgoing connections must use [`Self::connect_pinned`]; server endpoints
    /// intentionally have no default client TLS configuration.
    pub fn bind(addr: SocketAddr, tls: TlsConfig) -> anyhow::Result<Self> {
        ensure_rustls_provider();
        let mut server_crypto = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(tls.cert_chain.clone(), tls.private_key.clone_key())?;
        server_crypto.alpn_protocols = vec![b"paracord-media".to_vec()];

        let mut server_config =
            quinn::ServerConfig::with_crypto(Arc::new(QuicServerConfig::try_from(server_crypto)?));
        server_config.transport_config(server_transport_config());

        let endpoint = quinn::Endpoint::server(server_config, addr)?;

        Ok(Self { endpoint })
    }

    /// Bind a unified QUIC endpoint that advertises multiple ALPN protocols.
    ///
    /// This allows a single UDP port to handle both raw QUIC media connections
    /// (e.g. `paracord-media` ALPN) and HTTP/3 WebTransport connections
    /// (`h3` ALPN). After accepting a connection, inspect the negotiated ALPN
    /// via `connection.handshake_data()` to route appropriately.
    pub fn bind_unified(
        addr: SocketAddr,
        tls: TlsConfig,
        alpn_protocols: Vec<Vec<u8>>,
    ) -> anyhow::Result<Self> {
        ensure_rustls_provider();
        let mut server_crypto = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(tls.cert_chain.clone(), tls.private_key.clone_key())?;

        server_crypto.alpn_protocols = alpn_protocols;

        let mut server_config =
            quinn::ServerConfig::with_crypto(Arc::new(QuicServerConfig::try_from(server_crypto)?));
        server_config.transport_config(server_transport_config());

        let endpoint = quinn::Endpoint::server(server_config, addr)?;

        Ok(Self { endpoint })
    }

    /// Create a client-only endpoint. Connections must use
    /// [`Self::connect_pinned`]; there is deliberately no insecure default.
    pub fn client(addr: SocketAddr) -> anyhow::Result<Self> {
        ensure_rustls_provider();
        let endpoint = quinn::Endpoint::client(addr)?;
        Ok(Self { endpoint })
    }

    /// Accept the next incoming QUIC connection.
    pub async fn accept(&self) -> Option<quinn::Incoming> {
        self.endpoint.accept().await
    }

    /// Initiate a QUIC connection whose leaf certificate must match the
    /// base64-encoded SHA-256 DER fingerprint advertised by the trusted REST
    /// control plane. A missing, malformed, or mismatched pin fails closed.
    pub fn connect_pinned(
        &self,
        addr: SocketAddr,
        server_name: &str,
        cert_hash: &str,
    ) -> anyhow::Result<quinn::Connecting> {
        let expected_sha256 = decode_certificate_hash(cert_hash)?;
        let client_config = pinned_client_config(expected_sha256)?;
        Ok(self
            .endpoint
            .connect_with(client_config, addr, server_name)?)
    }

    /// Returns the local address this endpoint is bound to.
    pub fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.endpoint.local_addr()
    }

    /// Returns a reference to the inner quinn endpoint.
    pub fn inner(&self) -> &quinn::Endpoint {
        &self.endpoint
    }

    /// Close the endpoint, refusing new connections and winding down existing ones.
    pub fn close(&self) {
        self.endpoint.close(quinn::VarInt::from_u32(0), b"shutdown");
    }

    /// Wait for all connections to finish closing.
    pub async fn wait_idle(&self) {
        self.endpoint.wait_idle().await;
    }
}

/// Generate a self-signed TLS certificate for development use.
pub fn generate_self_signed_cert() -> anyhow::Result<TlsConfig> {
    let rcgen::CertifiedKey { cert, key_pair } =
        rcgen::generate_simple_self_signed(vec!["localhost".to_string()])?;

    let cert_der = CertificateDer::from(cert.der().to_vec());
    let key_der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_pair.serialize_der()));

    Ok(TlsConfig {
        cert_chain: vec![cert_der],
        private_key: key_der,
    })
}

/// Return the base64-encoded SHA-256 fingerprint used by WebTransport and raw
/// QUIC clients to pin a self-signed media certificate.
pub fn certificate_hash(cert: &CertificateDer<'_>) -> String {
    STANDARD.encode(Sha256::digest(cert.as_ref()))
}

fn decode_certificate_hash(cert_hash: &str) -> anyhow::Result<[u8; 32]> {
    let decoded = STANDARD
        .decode(cert_hash.trim())
        .map_err(|_| anyhow::anyhow!("media certificate pin is not valid base64"))?;
    decoded.try_into().map_err(|decoded: Vec<u8>| {
        anyhow::anyhow!(
            "media certificate pin must be a SHA-256 digest (32 bytes, got {})",
            decoded.len()
        )
    })
}

fn pinned_client_config(expected_sha256: [u8; 32]) -> anyhow::Result<quinn::ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut client_crypto = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedCertVerifier {
            expected_sha256,
            provider,
        }))
        .with_no_client_auth();
    client_crypto.alpn_protocols = vec![b"paracord-media".to_vec()];

    let mut client_config = quinn::ClientConfig::new(Arc::new(
        quinn::crypto::rustls::QuicClientConfig::try_from(client_crypto)?,
    ));
    client_config.transport_config(client_transport_config());
    Ok(client_config)
}

/// Verifies a self-signed media certificate against an exact SHA-256 pin and
/// verifies the TLS CertificateVerify signature against that certificate.
#[derive(Debug)]
struct PinnedCertVerifier {
    expected_sha256: [u8; 32],
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl rustls::client::danger::ServerCertVerifier for PinnedCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let presented: [u8; 32] = Sha256::digest(end_entity.as_ref()).into();
        if presented != self.expected_sha256 {
            return Err(rustls::Error::General(
                "native media TLS certificate pin mismatch".to_string(),
            ));
        }
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn self_signed_cert_generation() {
        let tls = generate_self_signed_cert().expect("cert generation should succeed");
        assert_eq!(tls.cert_chain.len(), 1);
        assert!(!tls.cert_chain[0].is_empty());
    }

    #[tokio::test]
    async fn bind_and_get_local_addr() {
        let tls = generate_self_signed_cert().unwrap();
        let endpoint = MediaEndpoint::bind("127.0.0.1:0".parse().unwrap(), tls).unwrap();
        let addr = endpoint.local_addr().unwrap();
        assert!(addr.port() > 0);
        endpoint.close();
    }

    #[tokio::test]
    async fn client_endpoint() {
        let endpoint = MediaEndpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();
        let addr = endpoint.local_addr().unwrap();
        assert!(addr.port() > 0);
        endpoint.close();
    }

    #[tokio::test]
    async fn server_client_connect_and_exchange_datagram() {
        // Start server
        let tls = generate_self_signed_cert().unwrap();
        let cert_hash = certificate_hash(&tls.cert_chain[0]);
        let server = MediaEndpoint::bind("127.0.0.1:0".parse().unwrap(), tls).unwrap();
        let server_addr = server.local_addr().unwrap();

        // Start client
        let client = MediaEndpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();

        // Client connects to server
        let client_connecting = client
            .connect_pinned(server_addr, "localhost", &cert_hash)
            .unwrap();

        // Server accepts
        let server_incoming = server.accept().await.expect("server should accept");
        let server_conn = server_incoming.accept().unwrap().await.unwrap();

        // Client completes connection
        let client_conn = client_connecting.await.unwrap();

        // Exchange datagrams
        let payload = bytes::Bytes::from_static(b"hello from client");
        client_conn.send_datagram(payload.clone()).unwrap();

        let received = server_conn.read_datagram().await.unwrap();
        assert_eq!(received.as_ref(), b"hello from client");

        // Server sends back
        let reply = bytes::Bytes::from_static(b"hello from server");
        server_conn.send_datagram(reply.clone()).unwrap();

        let received = client_conn.read_datagram().await.unwrap();
        assert_eq!(received.as_ref(), b"hello from server");

        // Clean up
        server.close();
        client.close();
    }

    #[tokio::test]
    async fn pinned_connection_rejects_wrong_certificate() {
        let server_tls = generate_self_signed_cert().unwrap();
        let server = MediaEndpoint::bind("127.0.0.1:0".parse().unwrap(), server_tls).unwrap();
        let server_addr = server.local_addr().unwrap();

        let other_tls = generate_self_signed_cert().unwrap();
        let wrong_hash = certificate_hash(&other_tls.cert_chain[0]);
        let client = MediaEndpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();

        let client_connecting = client
            .connect_pinned(server_addr, "localhost", &wrong_hash)
            .unwrap();
        let server_incoming = server.accept().await.expect("server should accept");
        let server_connecting = server_incoming.accept().unwrap();
        let (client_result, _server_result) = tokio::join!(client_connecting, server_connecting);
        assert!(
            client_result.is_err(),
            "a mismatched certificate pin must fail"
        );

        server.close();
        client.close();
    }

    #[tokio::test]
    async fn malformed_certificate_pin_is_rejected() {
        let client = MediaEndpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();
        let result = client.connect_pinned(
            "127.0.0.1:9".parse().unwrap(),
            "localhost",
            "not-a-sha256-pin",
        );
        assert!(result.is_err());
        client.close();
    }
}
