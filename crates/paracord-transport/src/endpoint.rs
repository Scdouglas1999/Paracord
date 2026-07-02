//! QUIC endpoint setup and configuration.
//!
//! Provides `MediaEndpoint` for both server (relay) and client (P2P) modes,
//! with self-signed certificate generation for development.

use std::net::SocketAddr;
use std::sync::Arc;

use quinn::crypto::rustls::QuicServerConfig;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

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

impl MediaEndpoint {
    /// Bind a QUIC endpoint to the given address with the provided TLS config.
    ///
    /// The endpoint supports both accepting incoming connections (server mode)
    /// and initiating outgoing connections (client mode / P2P).
    pub fn bind(addr: SocketAddr, tls: TlsConfig) -> anyhow::Result<Self> {
        ensure_rustls_provider();
        let mut server_crypto = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(tls.cert_chain.clone(), tls.private_key.clone_key())?;
        server_crypto.alpn_protocols = vec![b"paracord-media".to_vec()];

        let server_config =
            quinn::ServerConfig::with_crypto(Arc::new(QuicServerConfig::try_from(server_crypto)?));

        let client_crypto = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(InsecureCertVerifier))
            .with_no_client_auth();
        let mut client_crypto = client_crypto;
        client_crypto.alpn_protocols = vec![b"paracord-media".to_vec()];

        let client_config = quinn::ClientConfig::new(Arc::new(
            quinn::crypto::rustls::QuicClientConfig::try_from(client_crypto)?,
        ));

        let mut endpoint = quinn::Endpoint::server(server_config, addr)?;
        endpoint.set_default_client_config(client_config);

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

        let client_alpn_protocols = alpn_protocols.clone();
        server_crypto.alpn_protocols = alpn_protocols;

        let server_config =
            quinn::ServerConfig::with_crypto(Arc::new(QuicServerConfig::try_from(server_crypto)?));

        let mut client_crypto = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(InsecureCertVerifier))
            .with_no_client_auth();
        client_crypto.alpn_protocols = client_alpn_protocols;

        let client_config = quinn::ClientConfig::new(Arc::new(
            quinn::crypto::rustls::QuicClientConfig::try_from(client_crypto)?,
        ));

        let mut endpoint = quinn::Endpoint::server(server_config, addr)?;
        endpoint.set_default_client_config(client_config);

        Ok(Self { endpoint })
    }

    /// Create a client-only endpoint (no server config, for P2P initiators).
    pub fn client(addr: SocketAddr) -> anyhow::Result<Self> {
        ensure_rustls_provider();
        let mut client_crypto = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(InsecureCertVerifier))
            .with_no_client_auth();

        // The server's unified QUIC endpoint requires ALPN negotiation.
        // Without this, rustls rejects the handshake with NoApplicationProtocol.
        client_crypto.alpn_protocols = vec![b"paracord-media".to_vec()];

        let client_config = quinn::ClientConfig::new(Arc::new(
            quinn::crypto::rustls::QuicClientConfig::try_from(client_crypto)?,
        ));

        let mut endpoint = quinn::Endpoint::client(addr)?;
        endpoint.set_default_client_config(client_config);

        Ok(Self { endpoint })
    }

    /// Accept the next incoming QUIC connection.
    pub async fn accept(&self) -> Option<quinn::Incoming> {
        self.endpoint.accept().await
    }

    /// Initiate a QUIC connection to a remote endpoint.
    pub fn connect(
        &self,
        addr: SocketAddr,
        server_name: &str,
    ) -> Result<quinn::Connecting, quinn::ConnectError> {
        self.endpoint.connect(addr, server_name)
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

/// A certificate verifier that accepts any certificate.
/// Used for development / self-signed cert scenarios.
#[derive(Debug)]
struct InsecureCertVerifier;

impl rustls::client::danger::ServerCertVerifier for InsecureCertVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
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
        let server = MediaEndpoint::bind("127.0.0.1:0".parse().unwrap(), tls).unwrap();
        let server_addr = server.local_addr().unwrap();

        // Start client
        let client = MediaEndpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();

        // Client connects to server
        let client_connecting = client.connect(server_addr, "localhost").unwrap();

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
}
