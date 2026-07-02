use anyhow::{Context, Result};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum_server::tls_rustls::RustlsConfig;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::config::TlsConfig;

fn harden_private_key_permissions(_path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(_path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("Failed to restrict private key permissions: {:?}", _path))?;
    }
    Ok(())
}

fn build_server_config_from_files(
    cert_path: &Path,
    key_path: &Path,
) -> Result<rustls::ServerConfig> {
    let cert_pem = std::fs::read(cert_path)
        .with_context(|| format!("Failed to read cert from {:?}", cert_path))?;
    let certs = {
        use rustls::pki_types::pem::PemObject;
        use rustls::pki_types::CertificateDer;
        CertificateDer::pem_slice_iter(&cert_pem)
            .collect::<Result<Vec<_>, _>>()
            .context("Failed to parse PEM certificates")?
    };

    let key = {
        use rustls::pki_types::pem::PemObject;
        use rustls::pki_types::PrivateKeyDer;
        let key_pem = std::fs::read(key_path)
            .with_context(|| format!("Failed to read key from {:?}", key_path))?;
        PrivateKeyDer::from_pem_slice(&key_pem).context("Failed to parse PEM private key")?
    };

    let mut server_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("Failed to build rustls ServerConfig")?;

    // Force HTTP/1.1 for WebSocket compatibility with current gateway stack.
    server_config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(server_config)
}

pub fn reload_rustls_from_disk(rustls_config: &RustlsConfig, tls_config: &TlsConfig) -> Result<()> {
    let cert_path = Path::new(&tls_config.cert_path);
    let key_path = Path::new(&tls_config.key_path);
    let server_config = build_server_config_from_files(cert_path, key_path)?;
    rustls_config.reload_from_config(Arc::new(server_config));
    Ok(())
}

/// Ensure TLS certificate and key files exist, generating them if needed.
/// Returns a `RustlsConfig` ready for use with `axum-server`.
pub async fn ensure_certs(
    tls_config: &TlsConfig,
    external_ip: Option<&str>,
    local_ip: Option<&str>,
) -> Result<RustlsConfig> {
    let cert_path = Path::new(&tls_config.cert_path);
    let key_path = Path::new(&tls_config.key_path);
    let missing_initial = !cert_path.exists() || !key_path.exists();

    if tls_config.acme.enabled {
        match run_acme_automation_cycle(tls_config).await {
            Ok(changed) => {
                if changed {
                    tracing::info!("ACME automation cycle completed");
                }
            }
            Err(err) => {
                if missing_initial {
                    tracing::warn!("ACME bootstrap failed with missing certs: {}", err);
                } else {
                    tracing::warn!(
                        "ACME renewal attempt failed; continuing with existing certs: {}",
                        err
                    );
                }
            }
        }
    }

    if !cert_path.exists() || !key_path.exists() {
        if !tls_config.auto_generate {
            anyhow::bail!(
                "TLS cert/key not found at {:?} / {:?} and auto_generate is disabled",
                cert_path,
                key_path
            );
        }
        tracing::warn!(
            "Generating self-signed TLS certificate. This is for local/testing use only; use ACME or a CA-issued certificate in production."
        );
        generate_self_signed(cert_path, key_path, external_ip, local_ip)?;
    } else {
        tracing::info!("Using existing TLS certificate: {:?}", cert_path);
    }

    let server_config = build_server_config_from_files(cert_path, key_path)?;
    let rustls_config = RustlsConfig::from_config(Arc::new(server_config));
    Ok(rustls_config)
}

pub async fn maybe_serve_acme_http_challenge(
    tls_config: &TlsConfig,
    request_path: &str,
) -> Option<axum::response::Response> {
    if !tls_config.acme.enabled || !tls_config.acme.serve_http_challenge {
        return None;
    }

    const PREFIX: &str = "/.well-known/acme-challenge/";
    if !request_path.starts_with(PREFIX) {
        return None;
    }

    let token = &request_path[PREFIX.len()..];
    if token.is_empty() || !is_valid_acme_token(token) {
        return Some(StatusCode::NOT_FOUND.into_response());
    }

    let challenge_path = Path::new(&tls_config.acme.webroot_path)
        .join(".well-known")
        .join("acme-challenge")
        .join(token);

    match tokio::fs::read_to_string(challenge_path).await {
        Ok(body) => Some(
            (
                StatusCode::OK,
                [
                    (
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("text/plain; charset=utf-8"),
                    ),
                    (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
                ],
                body,
            )
                .into_response(),
        ),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Some(StatusCode::NOT_FOUND.into_response())
        }
        Err(err) => {
            tracing::warn!("ACME challenge read failed: {}", err);
            Some(StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
    }
}

pub fn spawn_acme_renewal_task(
    tls_config: TlsConfig,
    rustls_config: RustlsConfig,
    shutdown: Arc<tokio::sync::Notify>,
) {
    if !tls_config.acme.enabled || !tls_config.acme.auto_renew {
        return;
    }
    let interval_seconds = tls_config.acme.renew_interval_seconds.max(300);

    tokio::spawn(async move {
        tracing::info!(
            "ACME renewer enabled (interval={}s, cert_name='{}')",
            interval_seconds,
            tls_config.acme.cert_name
        );

        let mut interval = tokio::time::interval(std::time::Duration::from_secs(interval_seconds));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        interval.tick().await;

        loop {
            tokio::select! {
                _ = shutdown.notified() => {
                    break;
                }
                _ = interval.tick() => {
                    match run_acme_automation_cycle(&tls_config).await {
                        Ok(changed) => {
                            if changed {
                                if let Err(err) = reload_rustls_from_disk(&rustls_config, &tls_config) {
                                    tracing::warn!("ACME cert reload failed: {}", err);
                                } else {
                                    tracing::info!("TLS certificate reloaded after ACME cycle");
                                }
                            }
                        }
                        Err(err) => tracing::warn!("ACME automation cycle failed: {}", err),
                    }
                }
            }
        }
    });
}

async fn run_acme_automation_cycle(tls_config: &TlsConfig) -> Result<bool> {
    validate_acme_config(tls_config)?;

    let challenge_dir = Path::new(&tls_config.acme.webroot_path)
        .join(".well-known")
        .join("acme-challenge");
    std::fs::create_dir_all(&challenge_dir)
        .with_context(|| format!("Failed creating ACME challenge path: {:?}", challenge_dir))?;

    run_certbot_certonly(tls_config).await?;
    sync_cert_from_acme_source(tls_config)
}

fn validate_acme_config(tls_config: &TlsConfig) -> Result<()> {
    if tls_config.acme.domains.is_empty() {
        anyhow::bail!("tls.acme.enabled=true requires at least one entry in tls.acme.domains");
    }
    if tls_config.acme.client_path.trim().is_empty() {
        anyhow::bail!("tls.acme.client_path must not be empty");
    }
    if tls_config.acme.directory_url.trim().is_empty() {
        anyhow::bail!("tls.acme.directory_url must not be empty");
    }
    if tls_config.acme.cert_name.trim().is_empty() {
        anyhow::bail!("tls.acme.cert_name must not be empty");
    }
    Ok(())
}

async fn run_certbot_certonly(tls_config: &TlsConfig) -> Result<()> {
    let acme = &tls_config.acme;
    let mut command = tokio::process::Command::new(&acme.client_path);
    command
        .arg("certonly")
        .arg("--non-interactive")
        .arg("--agree-tos")
        .arg("--keep-until-expiring")
        .arg("--server")
        .arg(acme.directory_url.trim())
        .arg("--cert-name")
        .arg(acme.cert_name.trim())
        .arg("--webroot")
        .arg("-w")
        .arg(acme.webroot_path.trim());

    if let Some(email) = acme
        .email
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        command.arg("--email").arg(email);
    } else {
        command.arg("--register-unsafely-without-email");
    }

    for domain in acme
        .domains
        .iter()
        .map(String::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        command.arg("-d").arg(domain);
    }
    for arg in &acme.additional_args {
        let trimmed = arg.trim();
        if !trimmed.is_empty() {
            command.arg(trimmed);
        }
    }

    let output = command
        .output()
        .await
        .with_context(|| format!("Failed to execute ACME client '{}'", acme.client_path))?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    anyhow::bail!(
        "ACME client failed (status={}): stderr='{}' stdout='{}'",
        output.status,
        truncate_for_log(stderr.trim(), 600),
        truncate_for_log(stdout.trim(), 300)
    );
}

fn sync_cert_from_acme_source(tls_config: &TlsConfig) -> Result<bool> {
    let cert_path = Path::new(&tls_config.cert_path);
    let key_path = Path::new(&tls_config.key_path);
    let (source_cert, source_key) = acme_source_paths(tls_config);
    let mut changed = false;

    if let (Some(source_cert), Some(source_key)) = (source_cert, source_key) {
        if source_cert.exists() && source_key.exists() {
            changed |= copy_if_different(&source_cert, cert_path)?;
            changed |= copy_if_different(&source_key, key_path)?;
            harden_private_key_permissions(key_path)?;
        } else {
            // If source paths are configured but missing, assume the ACME client
            // writes directly to tls cert_path/key_path.
            changed = true;
        }
    } else {
        // Source paths are not configured; assume direct write into tls cert/key paths.
        changed = true;
    }

    if !cert_path.exists() || !key_path.exists() {
        anyhow::bail!(
            "ACME run completed but TLS cert/key are still missing at {:?} / {:?}",
            cert_path,
            key_path
        );
    }

    Ok(changed)
}

fn acme_source_paths(tls_config: &TlsConfig) -> (Option<PathBuf>, Option<PathBuf>) {
    let acme = &tls_config.acme;

    let explicit_cert = acme
        .cert_source_path
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    let explicit_key = acme
        .key_source_path
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    if explicit_cert.is_some() || explicit_key.is_some() {
        return (explicit_cert, explicit_key);
    }

    let cert_name = acme.cert_name.trim();
    if cert_name.is_empty() {
        return (None, None);
    }
    (
        Some(
            Path::new("/etc/letsencrypt/live")
                .join(cert_name)
                .join("fullchain.pem"),
        ),
        Some(
            Path::new("/etc/letsencrypt/live")
                .join(cert_name)
                .join("privkey.pem"),
        ),
    )
}

fn copy_if_different(src: &Path, dst: &Path) -> Result<bool> {
    let src_bytes = std::fs::read(src).with_context(|| format!("Failed reading {:?}", src))?;
    let dst_bytes = std::fs::read(dst).ok();
    if dst_bytes.as_deref() == Some(src_bytes.as_slice()) {
        return Ok(false);
    }

    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Failed creating destination directory {:?}", parent))?;
    }
    std::fs::write(dst, &src_bytes).with_context(|| format!("Failed writing {:?}", dst))?;
    Ok(true)
}

fn truncate_for_log(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    let mut out = value[..max].to_string();
    out.push_str("...");
    out
}

fn is_valid_acme_token(token: &str) -> bool {
    token
        .as_bytes()
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_')
}

/// Generate a self-signed certificate with SANs for localhost, loopback,
/// optional detected LAN IP, and optional detected public IP.
fn generate_self_signed(
    cert_path: &Path,
    key_path: &Path,
    external_ip: Option<&str>,
    local_ip: Option<&str>,
) -> Result<()> {
    tracing::info!("Generating self-signed TLS certificate...");

    let mut san_strings: Vec<String> = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];

    if let Some(ip) = local_ip {
        if !san_strings.iter().any(|existing| existing == ip) {
            tracing::info!("  SAN: {}", ip);
            san_strings.push(ip.to_string());
        }
    }

    if let Some(ip) = external_ip {
        if !san_strings.iter().any(|existing| existing == ip) {
            tracing::info!("  SAN: {}", ip);
            san_strings.push(ip.to_string());
        }
    }

    let certified_key = rcgen::generate_simple_self_signed(san_strings)
        .context("Failed to generate self-signed certificate")?;

    if let Some(parent) = cert_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create certs directory: {:?}", parent))?;
    }

    std::fs::write(cert_path, certified_key.cert.pem())
        .with_context(|| format!("Failed to write cert to {:?}", cert_path))?;
    std::fs::write(key_path, certified_key.key_pair.serialize_pem())
        .with_context(|| format!("Failed to write key to {:?}", key_path))?;
    harden_private_key_permissions(key_path)?;

    tracing::info!("Self-signed TLS certificate written to {:?}", cert_path);
    tracing::info!("TLS private key written to {:?}", key_path);
    Ok(())
}
