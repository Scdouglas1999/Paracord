//! QUIC endpoint setup and configuration.
//!
//! Provides `MediaEndpoint` for both server (relay) and client (P2P) modes,
//! with self-signed certificate generation for development.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

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
    /// ALPN list this endpoint was bound with, replayed on certificate rotation.
    alpn_protocols: Vec<Vec<u8>>,
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
        Self::bind_unified(addr, tls, vec![b"paracord-media".to_vec()])
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
        let server_config = server_config_for(&tls, alpn_protocols.clone())?;
        let endpoint = quinn::Endpoint::server(server_config, addr)?;
        Ok(Self {
            endpoint,
            alpn_protocols,
        })
    }

    /// Replace the TLS certificate this endpoint presents to *new* handshakes.
    ///
    /// Connections that already completed their handshake are untouched: QUIC
    /// authenticates once at connection setup, so a live media session survives
    /// a certificate rotation. Only handshakes started after this call see the
    /// new certificate, which is why the published pin must be updated in the
    /// same step (see the rotation task in `paracord-server`).
    ///
    /// The ALPN list is preserved from [`Self::bind_unified`]; rotating a
    /// certificate must never silently narrow which protocols the port accepts.
    pub fn set_certificate(&self, tls: &TlsConfig) -> anyhow::Result<()> {
        let server_config = server_config_for(tls, self.alpn_protocols.clone())?;
        self.endpoint.set_server_config(Some(server_config));
        Ok(())
    }

    /// Create a client-only endpoint. Connections must use
    /// [`Self::connect_pinned`]; there is deliberately no insecure default.
    pub fn client(addr: SocketAddr) -> anyhow::Result<Self> {
        ensure_rustls_provider();
        let endpoint = quinn::Endpoint::client(addr)?;
        Ok(Self {
            endpoint,
            alpn_protocols: Vec::new(),
        })
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

/// Build the QUIC server configuration for a media endpoint.
fn server_config_for(
    tls: &TlsConfig,
    alpn_protocols: Vec<Vec<u8>>,
) -> anyhow::Result<quinn::ServerConfig> {
    let mut server_crypto = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(tls.cert_chain.clone(), tls.private_key.clone_key())?;
    server_crypto.alpn_protocols = alpn_protocols;

    let mut server_config =
        quinn::ServerConfig::with_crypto(Arc::new(QuicServerConfig::try_from(server_crypto)?));
    server_config.transport_config(server_transport_config());
    Ok(server_config)
}

/// Subject alternative names placed on the generated media certificate.
///
/// The certificate is never validated by name: desktop and federation peers pin
/// the raw SHA-256 of the DER, and browsers pin it through WebTransport's
/// `serverCertificateHashes`, which bypasses name and CA checks entirely. The
/// SAN exists only so the certificate is well-formed.
const MEDIA_CERT_SAN: &str = "localhost";

/// How far in the past the generated certificate starts being valid.
///
/// Clocks between a server and a client routinely differ by seconds to minutes.
/// A certificate that becomes valid exactly "now" is rejected by a client whose
/// clock runs slightly behind, so back-date it by an hour.
pub const MEDIA_CERT_BACKDATE: Duration = Duration::from_secs(60 * 60);

/// How long the generated media certificate stays valid.
///
/// **This must stay under 14 days.** Chromium (and Safari) accept a certificate
/// supplied through WebTransport's `serverCertificateHashes` only when it is
/// ECDSA P-256 *and* its total validity window is at most 14 days. rcgen's
/// `generate_simple_self_signed` defaults to 1975-01-01 → 4096-01-01, which
/// silently fails that rule: the browser refuses the handshake in a millisecond
/// and reports nothing distinguishable from a blocked UDP port. Thirteen days
/// leaves a day of headroom for clock skew at both ends, and
/// [`MEDIA_CERT_BACKDATE`] is charged against it so the *total* window —
/// notBefore to notAfter, which is what the browser measures — stays under the
/// limit.
pub const MEDIA_CERT_LIFETIME: Duration = Duration::from_secs(13 * 24 * 60 * 60);

/// The hard ceiling the browser rule imposes. Asserted by tests, not by policy.
pub const MEDIA_CERT_MAX_WINDOW: Duration = Duration::from_secs(14 * 24 * 60 * 60);

/// Nominal interval between media-certificate rotations.
///
/// Half the lifetime: a rotation that fails still leaves days of runway before
/// the published pin goes stale, and the next attempt is far from the cliff.
pub const MEDIA_CERT_ROTATION_INTERVAL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Remaining validity below which a rotation is due immediately.
pub const MEDIA_CERT_MIN_REMAINING: Duration = Duration::from_secs(3 * 24 * 60 * 60);

/// A freshly generated media certificate, its published pin, and the validity
/// window it was issued for.
///
/// The window is returned rather than re-parsed from the DER because the
/// rotation task needs it to schedule the next regeneration.
pub struct MediaCertificate {
    pub tls: TlsConfig,
    /// Base64 SHA-256 of the leaf DER — what clients pin.
    pub hash: String,
    pub not_before: SystemTime,
    pub not_after: SystemTime,
}

/// Generate the self-signed certificate the native media endpoint presents.
///
/// Built through [`rcgen::CertificateParams`] rather than
/// `generate_simple_self_signed` so the validity window can be constrained to
/// [`MEDIA_CERT_LIFETIME`]; see that constant for why the default window makes
/// browser voice impossible. The key is ECDSA P-256 (rcgen's default), which
/// the same browser rule also requires.
pub fn generate_media_certificate() -> anyhow::Result<MediaCertificate> {
    let now = SystemTime::now();
    let not_before = now - MEDIA_CERT_BACKDATE;
    let not_after = not_before + MEDIA_CERT_LIFETIME;

    let mut params = rcgen::CertificateParams::new(vec![MEDIA_CERT_SAN.to_string()])?;
    params.not_before = to_offset_date_time(not_before)?;
    params.not_after = to_offset_date_time(not_after)?;

    // `KeyPair::generate` is ECDSA P-256, which the browser pin rule requires.
    let key_pair = rcgen::KeyPair::generate()?;
    let cert = params.self_signed(&key_pair)?;

    let cert_der = CertificateDer::from(cert.der().to_vec());
    let hash = certificate_hash(&cert_der);
    let key_der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_pair.serialize_der()));

    Ok(MediaCertificate {
        tls: TlsConfig {
            cert_chain: vec![cert_der],
            private_key: key_der,
        },
        hash,
        not_before,
        not_after,
    })
}

/// Generate a self-signed TLS certificate for the media endpoint.
///
/// Thin wrapper over [`generate_media_certificate`] for callers that do not
/// need the pin or the validity window (tests, the federation transport, the
/// standalone media dev server).
pub fn generate_self_signed_cert() -> anyhow::Result<TlsConfig> {
    Ok(generate_media_certificate()?.tls)
}

fn to_offset_date_time(at: SystemTime) -> anyhow::Result<time::OffsetDateTime> {
    let unix = at
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|_| anyhow::anyhow!("system clock is before the Unix epoch"))?;
    time::OffsetDateTime::from_unix_timestamp(unix.as_secs() as i64)
        .map_err(|e| anyhow::anyhow!("media certificate validity is out of range: {e}"))
}

/// How long to wait before regenerating a media certificate that expires at
/// `not_after`.
///
/// Normally [`MEDIA_CERT_ROTATION_INTERVAL`], but a certificate already closer
/// than [`MEDIA_CERT_MIN_REMAINING`] to expiry rotates immediately — that is the
/// case a server restored from a snapshot, or resumed from suspend after a long
/// sleep, lands in.
pub fn media_cert_rotation_delay(now: SystemTime, not_after: SystemTime) -> Duration {
    let remaining = not_after
        .duration_since(now)
        .unwrap_or(Duration::from_secs(0));
    if remaining <= MEDIA_CERT_MIN_REMAINING {
        return Duration::from_secs(0);
    }
    // Never sleep past the point where the certificate would be nearly expired.
    MEDIA_CERT_ROTATION_INTERVAL.min(remaining - MEDIA_CERT_MIN_REMAINING)
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

    /// The regression this whole module exists to prevent.
    ///
    /// A browser accepts a WebTransport `serverCertificateHashes` pin only when
    /// the certificate's total validity window is at most 14 days. rcgen's
    /// `generate_simple_self_signed` defaults to 1975 → 4096, which made browser
    /// voice impossible on every network, including loopback, and failed in a
    /// millisecond with an error indistinguishable from a blocked UDP port.
    ///
    /// The DER is parsed independently (x509-parser) rather than reading back
    /// the rcgen parameters, so this asserts what actually goes on the wire.
    #[test]
    fn media_certificate_validity_window_satisfies_the_browser_pin_rule() {
        use x509_parser::prelude::FromDer;

        let generated = generate_media_certificate().expect("cert generation should succeed");
        let der = generated.tls.cert_chain[0].as_ref();
        let (rest, parsed) =
            x509_parser::certificate::X509Certificate::from_der(der).expect("valid DER");
        assert!(rest.is_empty(), "certificate DER had trailing bytes");

        let not_before = parsed.validity().not_before.timestamp();
        let not_after = parsed.validity().not_after.timestamp();
        assert!(
            not_after > not_before,
            "notAfter ({not_after}) must be after notBefore ({not_before})"
        );

        let window = Duration::from_secs((not_after - not_before) as u64);
        assert!(
            window <= MEDIA_CERT_MAX_WINDOW,
            "media certificate is valid for {window:?}; browsers refuse a \
             `serverCertificateHashes` pin beyond {MEDIA_CERT_MAX_WINDOW:?}"
        );

        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        assert!(
            not_before < now,
            "notBefore ({not_before}) must already be in the past at issue time \
             so a client whose clock lags slightly still accepts it"
        );
        assert!(
            not_after > now,
            "notAfter ({not_after}) must be in the future"
        );

        // And the reported window matches the DER, because the rotation task
        // schedules off the reported one.
        let reported_after = generated
            .not_after
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        assert_eq!(reported_after, not_after);
    }

    /// The other half of the browser rule: the key must be ECDSA P-256.
    #[test]
    fn media_certificate_uses_an_ecdsa_p256_key() {
        use x509_parser::prelude::FromDer;

        let generated = generate_media_certificate().unwrap();
        let (_, parsed) = x509_parser::certificate::X509Certificate::from_der(
            generated.tls.cert_chain[0].as_ref(),
        )
        .expect("valid DER");
        let spki = parsed.public_key();
        // id-ecPublicKey, with the prime256v1 named curve as its parameter.
        assert_eq!(spki.algorithm.algorithm.to_id_string(), "1.2.840.10045.2.1");
        let curve = spki
            .algorithm
            .parameters
            .as_ref()
            .expect("EC public keys carry a named-curve parameter")
            .as_oid()
            .expect("named curve OID");
        assert_eq!(curve.to_id_string(), "1.2.840.10045.3.1.7");
    }

    #[test]
    fn published_hash_matches_the_generated_certificate() {
        let generated = generate_media_certificate().unwrap();
        assert_eq!(
            generated.hash,
            certificate_hash(&generated.tls.cert_chain[0])
        );
    }

    #[test]
    fn rotation_is_scheduled_before_the_certificate_goes_stale() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000);

        // A freshly issued certificate rotates on the nominal interval.
        let fresh = now + MEDIA_CERT_LIFETIME;
        assert_eq!(
            media_cert_rotation_delay(now, fresh),
            MEDIA_CERT_ROTATION_INTERVAL
        );

        // The scheduled rotation must land while the certificate is still valid.
        assert!(MEDIA_CERT_ROTATION_INTERVAL < MEDIA_CERT_LIFETIME);

        // A certificate inside the minimum-remaining window rotates now.
        let nearly_expired = now + MEDIA_CERT_MIN_REMAINING;
        assert_eq!(
            media_cert_rotation_delay(now, nearly_expired),
            Duration::from_secs(0)
        );

        // An already-expired certificate rotates now rather than underflowing.
        assert_eq!(
            media_cert_rotation_delay(now, now - Duration::from_secs(1)),
            Duration::from_secs(0)
        );

        // Between the two, the wait is clamped so it never overshoots the cliff.
        let middling = now + MEDIA_CERT_MIN_REMAINING + Duration::from_secs(3_600);
        assert_eq!(
            media_cert_rotation_delay(now, middling),
            Duration::from_secs(3_600)
        );
    }

    /// Rotating the certificate must not change which ALPN protocols the port
    /// accepts, and must not disturb a session that already handshook.
    #[tokio::test]
    async fn rotation_swaps_the_certificate_without_dropping_live_sessions() {
        let first = generate_media_certificate().unwrap();
        let server = MediaEndpoint::bind_unified(
            "127.0.0.1:0".parse().unwrap(),
            first.tls,
            vec![b"h3".to_vec(), b"paracord-media".to_vec()],
        )
        .unwrap();
        let server_addr = server.local_addr().unwrap();

        let client = MediaEndpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();
        let connecting = client
            .connect_pinned(server_addr, "localhost", &first.hash)
            .unwrap();
        let server_incoming = server.accept().await.expect("server should accept");
        let server_conn = server_incoming.accept().unwrap().await.unwrap();
        let client_conn = connecting.await.unwrap();

        // Rotate under the live session.
        let second = generate_media_certificate().unwrap();
        assert_ne!(second.hash, first.hash);
        server.set_certificate(&second.tls).unwrap();

        // The established connection keeps working: QUIC authenticated once.
        client_conn
            .send_datagram(bytes::Bytes::from_static(b"still here"))
            .unwrap();
        assert_eq!(
            server_conn.read_datagram().await.unwrap().as_ref(),
            b"still here"
        );

        // A new handshake pinned to the old hash is refused...
        let stale = MediaEndpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();
        let stale_connecting = stale
            .connect_pinned(server_addr, "localhost", &first.hash)
            .unwrap();
        let accept_stale = async {
            if let Some(incoming) = server.accept().await {
                if let Ok(conn) = incoming.accept() {
                    let _ = conn.await;
                }
            }
        };
        let (stale_result, ()) = tokio::join!(stale_connecting, accept_stale);
        assert!(
            stale_result.is_err(),
            "a handshake pinned to the rotated-out certificate must fail"
        );

        // ...and a handshake pinned to the new hash succeeds on the same port,
        // with the ALPN list preserved across the swap.
        let fresh = MediaEndpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();
        let fresh_connecting = fresh
            .connect_pinned(server_addr, "localhost", &second.hash)
            .unwrap();
        let accept_fresh = async {
            let incoming = server.accept().await.expect("server should accept");
            incoming.accept().unwrap().await
        };
        let (fresh_result, accepted) = tokio::join!(fresh_connecting, accept_fresh);
        let fresh_conn = fresh_result.expect("new pin must be accepted");
        accepted.expect("server side of the rotated handshake");
        assert_eq!(
            fresh_conn
                .handshake_data()
                .unwrap()
                .downcast::<quinn::crypto::rustls::HandshakeData>()
                .unwrap()
                .protocol
                .as_deref(),
            Some(&b"paracord-media"[..])
        );

        server.close();
        client.close();
        stale.close();
        fresh.close();
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
