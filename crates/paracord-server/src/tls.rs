use anyhow::{Context, Result};
use axum_server::tls_rustls::RustlsConfig;
use std::path::Path;

use crate::config::TlsConfig;

/// Ensure TLS certificate and key files exist, generating them if needed.
/// Returns a `RustlsConfig` ready for use with `axum-server`.
pub async fn ensure_certs(
    tls_config: &TlsConfig,
    external_ip: Option<&str>,
    local_ip: Option<&str>,
) -> Result<RustlsConfig> {
    let cert_path = Path::new(&tls_config.cert_path);
    let key_path = Path::new(&tls_config.key_path);

    if !cert_path.exists() || !key_path.exists() {
        if !tls_config.auto_generate {
            anyhow::bail!(
                "TLS cert/key not found at {:?} / {:?} and auto_generate is disabled",
                cert_path,
                key_path
            );
        }
        generate_self_signed(cert_path, key_path, external_ip, local_ip)?;
    } else {
        tracing::info!("Using existing TLS certificate: {:?}", cert_path);
    }

    // Build a custom rustls ServerConfig so we can set ALPN protocols.
    // We ONLY advertise http/1.1 — WebSocket upgrades require HTTP/1.1,
    // and HTTP/2 WebSocket (RFC 8441 extended CONNECT) is not supported
    // by axum-server/hyper. If we offer h2, browsers negotiate it and
    // then WebSocket connections silently fail (never reach the server).
    let cert_pem = std::fs::read(cert_path)
        .with_context(|| format!("Failed to read cert from {:?}", cert_path))?;
    let key_pem = std::fs::read(key_path)
        .with_context(|| format!("Failed to read key from {:?}", key_path))?;

    let certs = rustls_pemfile::certs(&mut &cert_pem[..])
        .collect::<Result<Vec<_>, _>>()
        .context("Failed to parse PEM certificates")?;
    let key = rustls_pemfile::private_key(&mut &key_pem[..])
        .context("Failed to parse PEM private key")?
        .context("No private key found in PEM file")?;

    let mut server_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("Failed to build rustls ServerConfig")?;

    server_config.alpn_protocols = vec![b"http/1.1".to_vec()];

    let rustls_config = RustlsConfig::from_config(std::sync::Arc::new(server_config));

    Ok(rustls_config)
}

/// Generate a self-signed certificate with SANs for localhost, 127.0.0.1,
/// the detected LAN IP, and the detected external IP.
fn generate_self_signed(
    cert_path: &Path,
    key_path: &Path,
    external_ip: Option<&str>,
    local_ip: Option<&str>,
) -> Result<()> {
    tracing::info!("Generating self-signed TLS certificate...");

    // Build subject alt names list
    let mut san_strings: Vec<String> = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];

    if let Some(ip) = local_ip {
        if !san_strings.contains(&ip.to_string()) {
            tracing::info!("  SAN: {}", ip);
            san_strings.push(ip.to_string());
        }
    }

    if let Some(ip) = external_ip {
        if !san_strings.contains(&ip.to_string()) {
            tracing::info!("  SAN: {}", ip);
            san_strings.push(ip.to_string());
        }
    }

    let certified_key = rcgen::generate_simple_self_signed(san_strings)
        .context("Failed to generate self-signed certificate")?;

    // Ensure parent directory exists
    if let Some(parent) = cert_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create certs directory: {:?}", parent))?;
    }

    std::fs::write(cert_path, certified_key.cert.pem())
        .with_context(|| format!("Failed to write cert to {:?}", cert_path))?;
    std::fs::write(key_path, certified_key.key_pair.serialize_pem())
        .with_context(|| format!("Failed to write key to {:?}", key_path))?;

    tracing::info!("Self-signed TLS certificate written to {:?}", cert_path);
    tracing::info!("TLS private key written to {:?}", key_path);

    Ok(())
}
