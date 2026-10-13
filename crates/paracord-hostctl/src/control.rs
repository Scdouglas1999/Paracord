//! The app ↔ host control channel (spec §2.5) and the public loopback calls
//! setup makes (health, claim).
//!
//! The hosted server's own certificate is on disk (`[tls] cert_path`), so the
//! client pins exactly that certificate instead of trusting "anything on
//! loopback": a different process squatting on the port never receives the
//! control token. The token is read from its file for every call and never
//! leaves Rust.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use paracord_contracts::credential::{CredentialClaimRequest, NewOwnerClaim};
use paracord_contracts::host::{BackupNowResponse, HostStatus, StorageKeyEscrowRequest};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};

/// What `POST /host/storage-key/escrow` answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EscrowOutcome {
    Written,
    /// 409: an escrow for this instance and owner key already exists (a
    /// resumed setup). A 409 `escrow_owner_mismatch` is an error instead.
    AlreadyPresent,
}

/// The hosted server, as setup and supervision see it.
pub trait HostApi: Send + Sync {
    /// `GET /health` answers `service: "paracord"` with the pinned certificate.
    fn healthy(&self) -> bool;
    fn status(&self) -> Result<HostStatus>;
    fn retry_reachability(&self) -> Result<()>;
    fn backup_now(&self) -> Result<BackupNowResponse>;
    /// `owner_public_key`: hex of the identity key `wrapping_key` comes from;
    /// the server refuses one that is not the owner's current key.
    fn write_escrow(&self, wrapping_key: &str, owner_public_key: &str) -> Result<EscrowOutcome>;
    /// `POST /setup/credential-claim`; returns the server's `ClaimResponse`.
    fn claim(&self, token: &str, owner: &NewOwnerClaim) -> Result<serde_json::Value>;
}

/// The first certificate of a PEM file, as DER.
pub fn first_certificate_der(pem: &str) -> Result<Vec<u8>> {
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    let start = pem.find(BEGIN).context("no certificate in the PEM file")? + BEGIN.len();
    let end = pem[start..]
        .find(END)
        .context("the PEM certificate is not terminated")?
        + start;
    let body: String = pem[start..end]
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    base64::engine::general_purpose::STANDARD
        .decode(body)
        .context("the PEM certificate is not valid base64")
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Accepts exactly one certificate (or, for the existing-server probe, any
/// certificate), and always checks the handshake signature with it.
#[derive(Debug)]
struct LoopbackVerifier {
    pinned: Option<Vec<u8>>,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl ServerCertVerifier for LoopbackVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        match &self.pinned {
            Some(pinned) if pinned.as_slice() != end_entity.as_ref() => Err(rustls::Error::General(
                "the server on this port is not Paracord on this computer (its certificate differs)".into(),
            )),
            _ => Ok(ServerCertVerified::assertion()),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
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
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

fn loopback_client(
    pinned: Option<Vec<u8>>,
    timeout: Duration,
) -> Result<reqwest::blocking::Client> {
    let provider = provider();
    let verifier = LoopbackVerifier {
        pinned,
        provider: provider.clone(),
    };
    let tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    Ok(reqwest::blocking::Client::builder()
        .use_preconfigured_tls(tls)
        .no_proxy()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(2))
        .build()?)
}

fn is_paracord_health(response: reqwest::blocking::Response) -> bool {
    response.status().is_success()
        && response
            .json::<serde_json::Value>()
            .ok()
            .and_then(|v| {
                v.get("service")
                    .and_then(|s| s.as_str())
                    .map(|s| s == "paracord")
            })
            .unwrap_or(false)
}

/// Spec §2.3 `existing_server`: does any Paracord server answer `/health` on
/// `127.0.0.1:<port>`? Only `/health` is read and nothing is sent, so any
/// certificate is accepted for this one loopback request.
pub fn existing_server_answers(port: u16) -> bool {
    let Ok(client) = loopback_client(None, Duration::from_secs(3)) else {
        return false;
    };
    client
        .get(format!("https://127.0.0.1:{port}/health"))
        .send()
        .map(is_paracord_health)
        .unwrap_or(false)
}

/// The real control channel to `https://127.0.0.1:<port>`.
pub struct LoopbackHost {
    port: u16,
    cert_path: PathBuf,
    token_file: PathBuf,
    claim_file: PathBuf,
}

impl LoopbackHost {
    pub fn new(port: u16, cert_path: &Path, token_file: &Path, claim_file: &Path) -> Self {
        Self {
            port,
            cert_path: cert_path.into(),
            token_file: token_file.into(),
            claim_file: claim_file.into(),
        }
    }

    pub fn claim_file(&self) -> &Path {
        &self.claim_file
    }

    fn url(&self, path: &str) -> String {
        format!("https://127.0.0.1:{}{path}", self.port)
    }

    fn client(&self, timeout: Duration) -> Result<reqwest::blocking::Client> {
        let pem = std::fs::read_to_string(&self.cert_path).with_context(|| {
            format!(
                "the server's certificate isn't there yet ({})",
                self.cert_path.display()
            )
        })?;
        loopback_client(Some(first_certificate_der(&pem)?), timeout)
    }

    fn token(&self) -> Result<String> {
        let token = std::fs::read_to_string(&self.token_file).with_context(|| {
            format!(
                "couldn't read the control token ({})",
                self.token_file.display()
            )
        })?;
        let token = token.trim().to_string();
        if token.is_empty() {
            bail!("the control token file is empty");
        }
        Ok(token)
    }

    fn host_request(
        &self,
        method: reqwest::Method,
        path: &str,
        timeout: Duration,
    ) -> Result<reqwest::blocking::RequestBuilder> {
        Ok(self
            .client(timeout)?
            .request(method, self.url(path))
            .header("Authorization", format!("Host {}", self.token()?)))
    }
}

/// `{ code, message }` from an error response, as one line.
fn error_text(response: reqwest::blocking::Response) -> anyhow::Error {
    let status = response.status();
    let body: Option<serde_json::Value> = response.json().ok();
    let message = body
        .as_ref()
        .and_then(|b| {
            b.get("message")
                .and_then(|m| m.as_str())
                .map(str::to_string)
        })
        .or_else(|| {
            body.as_ref()
                .and_then(|b| b.get("error").and_then(|m| m.as_str()).map(str::to_string))
        });
    let code = body
        .as_ref()
        .and_then(|b| b.get("code").and_then(|c| c.as_str()).map(str::to_string));
    match (message, code) {
        (Some(m), _) => anyhow!(m),
        (None, Some(c)) => anyhow!("the server answered {status} ({c})"),
        (None, None) => anyhow!("the server answered {status}"),
    }
}

impl HostApi for LoopbackHost {
    fn healthy(&self) -> bool {
        let Ok(client) = self.client(Duration::from_secs(3)) else {
            return false;
        };
        client
            .get(self.url("/health"))
            .send()
            .map(is_paracord_health)
            .unwrap_or(false)
    }

    fn status(&self) -> Result<HostStatus> {
        let response = self
            .host_request(
                reqwest::Method::GET,
                "/api/v1/host/status",
                Duration::from_secs(10),
            )?
            .send()?;
        if !response.status().is_success() {
            return Err(error_text(response));
        }
        Ok(response.json()?)
    }

    fn retry_reachability(&self) -> Result<()> {
        let response = self
            .host_request(
                reqwest::Method::POST,
                "/api/v1/host/reachability/retry",
                Duration::from_secs(10),
            )?
            .send()?;
        if !response.status().is_success() {
            return Err(error_text(response));
        }
        Ok(())
    }

    fn backup_now(&self) -> Result<BackupNowResponse> {
        // A backup with media can take a while on a big server.
        let response = self
            .host_request(
                reqwest::Method::POST,
                "/api/v1/host/backup-now",
                Duration::from_secs(30 * 60),
            )?
            .send()?;
        if !response.status().is_success() {
            return Err(error_text(response));
        }
        Ok(response.json()?)
    }

    fn write_escrow(&self, wrapping_key: &str, owner_public_key: &str) -> Result<EscrowOutcome> {
        let response = self
            .host_request(
                reqwest::Method::POST,
                "/api/v1/host/storage-key/escrow",
                Duration::from_secs(10),
            )?
            .json(&StorageKeyEscrowRequest {
                wrapping_key: wrapping_key.to_string(),
                owner_public_key: owner_public_key.to_string(),
            })
            .send()?;
        match response.status() {
            s if s.is_success() => Ok(EscrowOutcome::Written),
            reqwest::StatusCode::CONFLICT => {
                // Every other 409 (already escrowed, not encrypted) leaves a
                // good state behind; a phrase that is not the owner's does not.
                let body: serde_json::Value = response.json().unwrap_or_default();
                if body.get("code").and_then(|c| c.as_str()) == Some("escrow_owner_mismatch") {
                    let message = body
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("that recovery phrase is not the server owner's current one");
                    bail!("{message}");
                }
                Ok(EscrowOutcome::AlreadyPresent)
            }
            _ => Err(error_text(response)),
        }
    }

    fn claim(&self, token: &str, owner: &NewOwnerClaim) -> Result<serde_json::Value> {
        let response = self
            .client(Duration::from_secs(30))?
            .post(self.url("/api/v1/setup/credential-claim"))
            .json(&CredentialClaimRequest {
                token: token.to_string(),
                owner: owner.clone(),
            })
            .send()?;
        if !response.status().is_success() {
            return Err(error_text(response));
        }
        Ok(response.json()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pem_parsing_takes_the_first_certificate() {
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let pem = format!("{}{}", cert.cert.pem(), cert.cert.pem());
        assert_eq!(
            first_certificate_der(&pem).unwrap(),
            cert.cert.der().to_vec()
        );
        assert!(first_certificate_der("nothing").is_err());
    }

    #[test]
    fn the_pinned_verifier_refuses_another_certificate() {
        let ours = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let theirs = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let verifier = LoopbackVerifier {
            pinned: Some(ours.cert.der().to_vec()),
            provider: provider(),
        };
        let name = ServerName::try_from("127.0.0.1").unwrap();
        assert!(verifier
            .verify_server_cert(ours.cert.der(), &[], &name, &[], UnixTime::now())
            .is_ok());
        let err = verifier
            .verify_server_cert(theirs.cert.der(), &[], &name, &[], UnixTime::now())
            .unwrap_err();
        assert!(err.to_string().contains("not Paracord on this computer"));
    }
}
