#![allow(
    clippy::arc_with_non_send_sync,
    clippy::derivable_impls,
    clippy::manual_is_multiple_of,
    clippy::needless_return,
    clippy::too_many_arguments
)]

mod audio_capture;
mod commands;
mod native_media;
mod tray;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, RwLock};
use std::time::Duration;
use tauri::Emitter;

/// Origins that the user has explicitly configured as servers. Certificate
/// errors for these origins (and localhost) are allowed through so that
/// self-hosted servers with self-signed certificates continue to work.
/// All other origins fall back to the default (reject) behaviour.
static TRUSTED_SERVER_ORIGINS: LazyLock<RwLock<HashSet<String>>> =
    LazyLock::new(|| RwLock::new(HashSet::new()));

#[derive(Default)]
struct NativeSseState {
    tasks: tokio::sync::Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeSseEvent {
    stream_id: String,
    kind: &'static str,
    event: Option<String>,
    data: Option<String>,
    error: Option<String>,
}

const NATIVE_SSE_EVENT: &str = "native_sse_event";

fn trusted_origin_from_url(raw_url: &str) -> Option<String> {
    let parsed = url::Url::parse(raw_url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    Some(parsed.origin().ascii_serialization().to_ascii_lowercase())
}

fn is_trusted_cert_origin(uri: &str) -> bool {
    let parsed = match url::Url::parse(uri) {
        Ok(parsed) => parsed,
        Err(_) => return false,
    };
    let Some(host) = parsed.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };

    // Always trust localhost / loopback
    if host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1" {
        return true;
    }

    // Trust exact origins that the user has added to their server list.
    let origin = parsed.origin().ascii_serialization().to_ascii_lowercase();
    if let Ok(guard) = TRUSTED_SERVER_ORIGINS.read() {
        if guard.contains(&origin) {
            return true;
        }
    }

    false
}

fn ensure_native_fetch_target_is_trusted(uri: &str) -> Result<(), String> {
    let parsed = url::Url::parse(uri).map_err(|_| "Native fetch requires an absolute URL")?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("Native fetch only supports HTTP(S) URLs".to_string()),
    }
    if !is_trusted_cert_origin(uri) {
        return Err("Native fetch target is not in the trusted server list".to_string());
    }
    Ok(())
}

fn health_url_for_server(server_url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(server_url).map_err(|_| "Server URL must be absolute")?;
    match parsed.scheme() {
        "http" | "https" => Ok(format!("{}/health", server_url.trim_end_matches('/'))),
        _ => Err("Server URL must use HTTP(S)".to_string()),
    }
}

#[cfg(windows)]
fn configure_webview2_overrides(app: &tauri::App) {
    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_14, ICoreWebView2_27,
        COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW,
        COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_DEFAULT,
    };
    use webview2_com::ScreenCaptureStartingEventHandler;
    use webview2_com::ServerCertificateErrorDetectedEventHandler;
    use windows_core::Interface;

    let Some(main_webview) = app.get_webview_window("main") else {
        return;
    };

    if let Err(err) = main_webview.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };

        // --- Accept self-signed TLS certificates only for trusted origins ---
        if let Ok(core14) = core.cast::<ICoreWebView2_14>() {
            let handler =
                ServerCertificateErrorDetectedEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        // Extract the request URI to check against trusted origins.
                        let mut uri_pwstr = windows_core::PWSTR::null();
                        let uri_str =
                            if args.RequestUri(&mut uri_pwstr).is_ok() && !uri_pwstr.is_null() {
                                let s = uri_pwstr.to_string().unwrap_or_default();
                                // Free the PWSTR allocated by COM
                                windows::Win32::System::Com::CoTaskMemFree(Some(
                                    uri_pwstr.as_ptr() as *const _,
                                ));
                                s
                            } else {
                                String::new()
                            };

                        if is_trusted_cert_origin(&uri_str) {
                            let _ = args.SetAction(
                                COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW,
                            );
                        } else {
                            let _ = args
                                .SetAction(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_DEFAULT);
                        }
                    }
                    Ok(())
                }));

            let mut token = 0_i64;
            if let Err(e) = core14.add_ServerCertificateErrorDetected(&handler, &mut token) {
                eprintln!("failed to register WebView2 certificate override: {e}");
            }
        }

        // --- Observe screen-capture start events ---
        // This hook is useful for telemetry and future native-capture work, but
        // it does not reliably suppress WebView2's built-in sharing indicator.
        if let Ok(core27) = core.cast::<ICoreWebView2_27>() {
            let handler = ScreenCaptureStartingEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    let _ = args.SetHandled(true);
                }
                Ok(())
            }));

            let mut token = 0_i64;
            if let Err(e) = core27.add_ScreenCaptureStarting(&handler, &mut token) {
                eprintln!("failed to register WebView2 screen capture handler: {e}");
            }
        }
    }) {
        eprintln!("failed to configure WebView2 overrides: {err}");
    }
}

/// SHA-256 fingerprints of the TLS leaf certificate pinned for each non-loopback
/// host (trust-on-first-use). Loaded from disk at startup and updated whenever a
/// new Paracord server is verified for the very first time.
static PINNED_CERTS: LazyLock<RwLock<HashMap<String, [u8; 32]>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Leaf-certificate fingerprints captured during an in-flight first-use
/// handshake, awaiting promotion into [`PINNED_CERTS`] once the peer's `/health`
/// response has been confirmed to identify as Paracord.
static OBSERVED_CERTS: LazyLock<RwLock<HashMap<String, [u8; 32]>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

/// Normalise the host of a URL into the key used for certificate pinning. IPv6
/// literals are stored without their surrounding brackets so they match the
/// form produced from a rustls [`ServerName`](rustls::pki_types::ServerName).
fn pin_host_from_url(raw_url: &str) -> Option<String> {
    let parsed = url::Url::parse(raw_url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    Some(
        host.trim_start_matches('[')
            .trim_end_matches(']')
            .to_string(),
    )
}

fn sha256_fingerprint(der: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(der);
    hasher.finalize().into()
}

fn encode_fingerprint_hex(fp: &[u8; 32]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(64);
    for byte in fp {
        let _ = write!(s, "{byte:02x}");
    }
    s
}

fn decode_fingerprint_hex(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let bytes = hex.as_bytes();
    let mut out = [0u8; 32];
    for (i, slot) in out.iter_mut().enumerate() {
        let hi = (bytes[2 * i] as char).to_digit(16)?;
        let lo = (bytes[2 * i + 1] as char).to_digit(16)?;
        *slot = ((hi << 4) | lo) as u8;
    }
    Some(out)
}

fn pinned_fingerprint(host: &str) -> Option<[u8; 32]> {
    PINNED_CERTS.read().ok()?.get(host).copied()
}

fn set_pinned_fingerprint(host: String, fp: [u8; 32]) {
    if let Ok(mut guard) = PINNED_CERTS.write() {
        guard.insert(host, fp);
    }
}

fn record_observed_fingerprint(host: &str, fp: [u8; 32]) {
    if let Ok(mut guard) = OBSERVED_CERTS.write() {
        guard.insert(host.to_string(), fp);
    }
}

fn take_observed_fingerprint(host: &str) -> Option<[u8; 32]> {
    OBSERVED_CERTS.write().ok()?.remove(host)
}

fn clear_observed_fingerprint(host: &str) {
    if let Ok(mut guard) = OBSERVED_CERTS.write() {
        guard.remove(host);
    }
}

fn server_name_host(name: &rustls::pki_types::ServerName<'_>) -> String {
    match name {
        rustls::pki_types::ServerName::DnsName(dns) => dns.as_ref().to_ascii_lowercase(),
        rustls::pki_types::ServerName::IpAddress(ip) => std::net::IpAddr::from(*ip).to_string(),
        _ => String::new(),
    }
}

fn cert_pins_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let mut dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    dir.push("security");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create security directory: {e}"))?;
    Ok(dir.join("cert_pins.json"))
}

/// Load persisted certificate pins into [`PINNED_CERTS`] at startup. A missing
/// or malformed file is treated as "no pins yet" so that first-use capture can
/// re-establish them; it never causes the app to fail to start.
fn load_pinned_certs(app: &tauri::AppHandle) {
    let Ok(path) = cert_pins_path(app) else {
        return;
    };
    let Ok(data) = std::fs::read(&path) else {
        return;
    };
    let Ok(parsed) = serde_json::from_slice::<HashMap<String, String>>(&data) else {
        return;
    };
    let mut map = HashMap::new();
    for (host, hex) in parsed {
        if let Some(fp) = decode_fingerprint_hex(&hex) {
            map.insert(host.to_ascii_lowercase(), fp);
        }
    }
    if let Ok(mut guard) = PINNED_CERTS.write() {
        *guard = map;
    }
}

/// Durably persist the current set of certificate pins next to the other
/// security state in the app data directory.
fn persist_pinned_certs(app: &tauri::AppHandle) -> Result<(), String> {
    let path = cert_pins_path(app)?;
    let serializable: HashMap<String, String> = {
        let guard = PINNED_CERTS
            .read()
            .map_err(|_| "certificate pin store poisoned".to_string())?;
        guard
            .iter()
            .map(|(host, fp)| (host.clone(), encode_fingerprint_hex(fp)))
            .collect()
    };
    let json = serde_json::to_vec_pretty(&serializable)
        .map_err(|e| format!("failed to serialize certificate pins: {e}"))?;
    std::fs::write(&path, &json).map_err(|e| format!("failed to write certificate pins: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// TLS certificate verifier implementing trust-on-first-use (TOFU) pinning.
///
/// SAFETY / TRUST MODEL: self-hosted Paracord servers usually present
/// self-signed certificates, so neither the public CA hierarchy nor hostname
/// (SAN) validation can be relied upon. Instead:
///   * Loopback hosts are trusted unconditionally (local dev / same machine).
///   * The FIRST time a non-loopback host is reached, the SHA-256 fingerprint of
///     its leaf certificate is captured into [`OBSERVED_CERTS`].
///     `update_trusted_server_hosts` promotes that fingerprint to a durable pin
///     only after the `/health` response identifies the peer as Paracord.
///   * On EVERY later handshake the presented leaf MUST match the pinned
///     fingerprint; a mismatch aborts the handshake. A MITM or re-issued
///     certificate is rejected outright and is never silently re-trusted.
///
/// The handshake signature is always verified against the presented leaf key, so
/// a captured certificate cannot be replayed without its private key. The sole
/// unavoidable exposure is the very first contact with a new host — the inherent
/// TOFU trade-off — after which the connection is cryptographically pinned.
#[derive(Debug)]
struct TofuPinningVerifier {
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl rustls::client::danger::ServerCertVerifier for TofuPinningVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let host = server_name_host(server_name);
        if host.is_empty() {
            return Err(rustls::Error::General(
                "unsupported server name for certificate pinning".to_string(),
            ));
        }
        if is_loopback_host(&host) {
            return Ok(rustls::client::danger::ServerCertVerified::assertion());
        }
        let fingerprint = sha256_fingerprint(end_entity.as_ref());
        match pinned_fingerprint(&host) {
            Some(expected) if expected == fingerprint => {
                Ok(rustls::client::danger::ServerCertVerified::assertion())
            }
            Some(_) => Err(rustls::Error::General(format!(
                "TLS certificate pin mismatch for {host}"
            ))),
            None => {
                // Trust-on-first-use: record for the caller to promote to a pin
                // once the peer's identity has been confirmed.
                record_observed_fingerprint(&host, fingerprint);
                Ok(rustls::client::danger::ServerCertVerified::assertion())
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
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
        cert: &rustls::pki_types::CertificateDer<'_>,
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

/// Update the set of trusted server origins for TLS certificate override.
/// Called from JS whenever the server list changes. Non-loopback origins are
/// trusted only after Rust verifies their `/health` endpoint identifies as a
/// Paracord server AND its TLS certificate matches (or, on first contact,
/// establishes) the pin recorded for that host, so renderer code cannot
/// whitelist arbitrary or MITM'd TLS targets for the native HTTP client.
#[tauri::command]
async fn update_trusted_server_hosts(app: tauri::AppHandle, server_urls: Vec<String>) {
    let mut origins = HashSet::new();
    let client = match tls_pinning_client_with_timeout(Duration::from_secs(5)) {
        Ok(client) => client,
        Err(_) => return,
    };
    let mut pins_changed = false;
    for raw_url in &server_urls {
        let Some(origin) = trusted_origin_from_url(raw_url) else {
            continue;
        };
        // Loopback (and origins already trusted this session) need no probe.
        if is_trusted_cert_origin(raw_url) {
            origins.insert(origin);
            continue;
        }
        let Ok(health_url) = health_url_for_server(raw_url) else {
            continue;
        };
        let Some(host) = pin_host_from_url(raw_url) else {
            continue;
        };
        clear_observed_fingerprint(&host);
        // A pin mismatch aborts the TLS handshake, so `send` fails and the
        // origin is left untrusted (never silently re-trusted).
        let Ok(resp) = client.get(&health_url).send().await else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(body) = resp.json::<serde_json::Value>().await else {
            continue;
        };
        if body.get("service").and_then(|value| value.as_str()) != Some("paracord") {
            continue;
        }
        // Identity confirmed. On first contact, promote the captured fingerprint
        // to a durable pin; on later probes the pin already matched above.
        if pinned_fingerprint(&host).is_none() {
            if let Some(observed) = take_observed_fingerprint(&host) {
                set_pinned_fingerprint(host.clone(), observed);
                pins_changed = true;
            }
        }
        origins.insert(origin);
    }
    if let Ok(mut guard) = TRUSTED_SERVER_ORIGINS.write() {
        *guard = origins;
    }
    if pins_changed {
        if let Err(err) = persist_pinned_certs(&app) {
            eprintln!("failed to persist certificate pins: {err}");
        }
    }
}

/// Build a reqwest client whose TLS layer enforces trust-on-first-use pinning
/// (see [`TofuPinningVerifier`]). Unlike a fully permissive client, self-signed
/// certificates are accepted only for loopback or on first contact with a host;
/// a host with an established pin must present the recorded certificate.
fn tls_pinning_client_builder() -> Result<reqwest::ClientBuilder, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let tls_config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("Failed to configure TLS: {e}"))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(TofuPinningVerifier { provider }))
        .with_no_client_auth();
    Ok(reqwest::Client::builder().use_preconfigured_tls(tls_config))
}

fn tls_pinning_client_with_timeout(timeout: Duration) -> Result<reqwest::Client, String> {
    tls_pinning_client_builder()?
        .timeout(timeout)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))
}

fn tls_pinning_client() -> Result<reqwest::Client, String> {
    tls_pinning_client_with_timeout(Duration::from_secs(15))
}

fn tls_pinning_stream_client() -> Result<reqwest::Client, String> {
    // SSE is intentionally a long-lived request. Keep the same TOFU certificate
    // pinning as native fetches, but do not apply a total request timeout that
    // would terminate a healthy idle stream at the timeout boundary.
    tls_pinning_client_builder()?
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))
}

fn map_reqwest_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "Connection timed out.".to_string()
    } else if e.is_connect() {
        format!("Connection refused or unreachable: {e}")
    } else {
        format!("Network request failed: {e}")
    }
}

/// Probe a server's /health endpoint from the Rust side, bypassing WebView2's
/// TLS restrictions. Self-signed certs are accepted only for loopback or on
/// first contact; hosts with an established pin are enforced (see
/// [`TofuPinningVerifier`]).
#[tauri::command]
async fn probe_server(server_url: String) -> Result<serde_json::Value, String> {
    let client = tls_pinning_client()?;
    let url = health_url_for_server(&server_url)?;
    ensure_native_fetch_target_is_trusted(&url)?;
    let resp = client.get(&url).send().await.map_err(map_reqwest_error)?;
    if !resp.status().is_success() {
        return Err(format!("Server returned HTTP {}", resp.status()));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Invalid JSON response: {e}"))
}

/// Generic HTTP fetch via Rust for trusted Paracord servers.
/// Requests are restricted to loopback or origins the user added to the server
/// list, and the TLS layer enforces the certificate pin recorded for each host
/// so a MITM against an already-trusted server is rejected.
#[derive(serde::Deserialize)]
struct NativeFetchRequest {
    url: String,
    method: Option<String>,
    body: Option<serde_json::Value>,
    headers: Option<std::collections::HashMap<String, String>>,
}

#[derive(serde::Serialize)]
struct NativeFetchResponse {
    status: u16,
    body: serde_json::Value,
}

#[tauri::command]
async fn native_fetch(req: NativeFetchRequest) -> Result<NativeFetchResponse, String> {
    ensure_native_fetch_target_is_trusted(&req.url)?;
    let client = tls_pinning_client()?;
    let method = req.method.as_deref().unwrap_or("GET");
    let mut builder = match method.to_uppercase().as_str() {
        "POST" => client.post(&req.url),
        "PUT" => client.put(&req.url),
        "PATCH" => client.patch(&req.url),
        "DELETE" => client.delete(&req.url),
        _ => client.get(&req.url),
    };
    if let Some(headers) = req.headers {
        for (k, v) in headers {
            builder = builder.header(&k, &v);
        }
    }
    if let Some(body) = req.body {
        builder = builder
            .header("content-type", "application/json")
            .json(&body);
    }
    let resp = builder.send().await.map_err(map_reqwest_error)?;
    let status = resp.status().as_u16();
    let body = resp
        .json::<serde_json::Value>()
        .await
        .unwrap_or(serde_json::Value::Null);
    Ok(NativeFetchResponse { status, body })
}

fn find_sse_delimiter(buffer: &str) -> Option<(usize, usize)> {
    let lf = buffer.find("\n\n").map(|idx| (idx, 2));
    let crlf = buffer.find("\r\n\r\n").map(|idx| (idx, 4));
    match (lf, crlf) {
        (Some(a), Some(b)) => Some(if a.0 < b.0 { a } else { b }),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

fn drain_sse_events(buffer: &mut String) -> Vec<(Option<String>, String)> {
    let mut events = Vec::new();
    while let Some((idx, delimiter_len)) = find_sse_delimiter(buffer) {
        let frame = buffer[..idx].to_string();
        buffer.drain(..idx + delimiter_len);

        let mut event_name = None;
        let mut data_lines = Vec::new();
        for raw_line in frame.lines() {
            let line = raw_line.trim_end_matches('\r');
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            if let Some(value) = line.strip_prefix("event:") {
                event_name = Some(value.trim_start().to_string());
            } else if let Some(value) = line.strip_prefix("data:") {
                data_lines.push(value.trim_start().to_string());
            }
        }

        if !data_lines.is_empty() {
            events.push((event_name, data_lines.join("\n")));
        }
    }
    events
}

fn emit_native_sse(app: &tauri::AppHandle, payload: NativeSseEvent) {
    let _ = app.emit(NATIVE_SSE_EVENT, payload);
}

#[tauri::command]
async fn start_native_sse_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeSseState>,
    stream_id: String,
    url: String,
) -> Result<(), String> {
    ensure_native_fetch_target_is_trusted(&url)?;
    {
        let mut tasks = state.tasks.lock().await;
        if let Some(existing) = tasks.remove(&stream_id) {
            existing.abort();
        }
    }

    let client = tls_pinning_stream_client()?;
    let task_stream_id = stream_id.clone();
    let task = tokio::spawn(async move {
        let emit_error = |message: String, app: &tauri::AppHandle, stream_id: &str| {
            emit_native_sse(
                app,
                NativeSseEvent {
                    stream_id: stream_id.to_string(),
                    kind: "error",
                    event: None,
                    data: None,
                    error: Some(message),
                },
            );
        };

        let resp = match client
            .get(&url)
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(err) => {
                emit_error(map_reqwest_error(err), &app, &task_stream_id);
                return;
            }
        };

        if !resp.status().is_success() {
            emit_error(
                format!("SSE stream returned HTTP {}", resp.status()),
                &app,
                &task_stream_id,
            );
            return;
        }

        emit_native_sse(
            &app,
            NativeSseEvent {
                stream_id: task_stream_id.clone(),
                kind: "open",
                event: None,
                data: None,
                error: None,
            },
        );

        let mut buffer = String::new();
        let mut resp = resp;
        loop {
            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    buffer.push_str(&String::from_utf8_lossy(&chunk));
                    for (event, data) in drain_sse_events(&mut buffer) {
                        emit_native_sse(
                            &app,
                            NativeSseEvent {
                                stream_id: task_stream_id.clone(),
                                kind: "message",
                                event,
                                data: Some(data),
                                error: None,
                            },
                        );
                    }
                }
                Ok(None) => {
                    emit_error("SSE stream ended".to_string(), &app, &task_stream_id);
                    return;
                }
                Err(err) => {
                    emit_error(map_reqwest_error(err), &app, &task_stream_id);
                    return;
                }
            }
        }
    });

    let mut tasks = state.tasks.lock().await;
    tasks.insert(stream_id, task);
    Ok(())
}

#[tauri::command]
async fn stop_native_sse_stream(
    state: tauri::State<'_, NativeSseState>,
    stream_id: String,
) -> Result<(), String> {
    let mut tasks = state.tasks.lock().await;
    if let Some(task) = tasks.remove(&stream_id) {
        task.abort();
    }
    Ok(())
}

/// Event name carrying a `paracord://` deep link to the webview. The connect
/// flow listens for this (via `@tauri-apps/api/event`) to route invite tokens
/// (`paracord://invite/<token>`) and server hosts (`paracord://server/<host>`).
const DEEP_LINK_EVENT: &str = "deep-link";

/// Pick out the `paracord://` entries from a process argument list. Used to
/// recover a deep link that Linux/Windows pass as a second-instance argv.
fn extract_paracord_urls<I>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    args.into_iter()
        .filter(|arg| arg.starts_with("paracord://"))
        .collect()
}

/// Focus the main window and forward each deep link to the webview so the
/// connect flow can act on it. No-op when there are no links.
fn forward_deep_link_urls(app: &tauri::AppHandle, urls: &[String]) {
    use tauri::{Emitter, Manager};
    if urls.is_empty() {
        return;
    }
    // Bring the existing window to the foreground so the connect flow is visible
    // when a link is opened while the app is hidden to the tray or backgrounded.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    for url in urls {
        if let Err(err) = commands::append_client_log(app.clone(), format!("deep-link {url}")) {
            eprintln!("failed to log deep link: {err}");
        }
        if let Err(err) = app.emit(DEEP_LINK_EVENT, url.clone()) {
            eprintln!("failed to forward deep link to webview: {err}");
        }
    }
}

/// Default server URL to prefill in the connect flow. Debug builds point at the
/// local dev server (matching the client's `VITE_DEV_PROXY_TARGET` default);
/// release builds return an empty string so the user supplies their own server.
#[tauri::command]
fn get_default_connect_target() -> String {
    if cfg!(debug_assertions) {
        "https://localhost:8443".to_string()
    } else {
        String::new()
    }
}

#[cfg(target_os = "linux")]
fn configure_linux_gstreamer_audio_backend() {
    // WebKitGTK uses GStreamer for media playback. On PipeWire desktops, letting
    // autoaudiosink probe every legacy backend produces noisy JACK/OSS failures
    // before it reaches a usable sink. Prefer the native PipeWire sink, keep
    // PulseAudio as a practical secondary path, and demote the unavailable
    // legacy sinks that otherwise spam startup/voice logs.
    const PARACORD_GST_RANKS: &str =
        "pipewiresink:PRIMARY,pulsesink:SECONDARY,jackaudiosink:NONE,osssink:NONE";

    if std::env::var_os("GST_PLUGIN_FEATURE_RANK").is_none() {
        std::env::set_var("GST_PLUGIN_FEATURE_RANK", PARACORD_GST_RANKS);
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_linux_gstreamer_audio_backend() {}

pub fn run() {
    configure_linux_gstreamer_audio_backend();

    let builder = tauri::Builder::default()
        // Register single-instance FIRST so a second launch (how Linux/Windows
        // deliver a paracord:// link to a running app) focuses the existing
        // window and forwards the link instead of opening a new window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            forward_deep_link_urls(app, &extract_paracord_urls(argv));
        }))
        .manage(native_media::MediaState::new())
        .manage(NativeSseState::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let startup_line = format!(
                "{} [desktop] startup version={} pid={}",
                chrono_like_timestamp_utc(),
                env!("CARGO_PKG_VERSION"),
                std::process::id()
            );
            if let Err(err) = commands::append_client_log(app.handle().clone(), startup_line) {
                eprintln!("failed to write startup diagnostics log line: {err}");
            }
            // Restore durably pinned server certificates so pin enforcement
            // survives restarts even before the server list is re-synced.
            load_pinned_certs(app.handle());

            // --- paracord:// deep link handling ---
            use tauri_plugin_deep_link::DeepLinkExt;
            // Register the scheme at runtime on Linux/Windows. macOS binds it via
            // the app bundle's Info.plist, so runtime registration is skipped
            // there. Best-effort: a failure (e.g. sandboxed env) must not abort
            // startup.
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            if let Err(err) = app.deep_link().register_all() {
                eprintln!("failed to register paracord:// deep link scheme: {err}");
            }
            // Cold start: the app was launched by opening a link.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                let urls: Vec<String> = urls.into_iter().map(|u| u.to_string()).collect();
                forward_deep_link_urls(app.handle(), &urls);
            }
            // Warm path: links opened while running arrive here on macOS (and on
            // Linux/Windows via the single-instance handler above).
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<String> = event.urls().into_iter().map(|u| u.to_string()).collect();
                forward_deep_link_urls(&handle, &urls);
            });

            #[cfg(windows)]
            configure_webview2_overrides(app);
            tray::setup_tray(app.handle())?;
            Ok(())
        });

    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::greet,
        commands::get_app_version,
        commands::get_update_target,
        commands::append_client_log,
        commands::get_client_log_path,
        commands::secure_store_set,
        commands::secure_store_get,
        commands::secure_store_delete,
        commands::secure_store_fallback_encrypt,
        commands::secure_store_fallback_decrypt,
        commands::set_activity_sharing_enabled,
        commands::get_foreground_application,
        update_trusted_server_hosts,
        probe_server,
        native_fetch,
        start_native_sse_stream,
        stop_native_sse_stream,
        get_default_connect_target,
        audio_capture::set_system_audio_capture_enabled,
        audio_capture::start_system_audio_capture,
        audio_capture::stop_system_audio_capture,
        // Native QUIC media engine
        native_media::commands::quic_upload_file,
        native_media::commands::quic_download_file,
        native_media::commands::start_voice_session,
        native_media::commands::stop_voice_session,
        native_media::commands::voice_set_mute,
        native_media::commands::voice_set_deaf,
        native_media::commands::voice_switch_input_device,
        native_media::commands::voice_switch_output_device,
        native_media::commands::voice_list_output_devices,
        native_media::commands::voice_list_input_devices,
        native_media::commands::voice_enable_video,
        native_media::commands::voice_start_screen_share,
        native_media::commands::voice_stop_screen_share,
        native_media::commands::screen_share_list_sources,
        native_media::commands::screen_share_source_thumbnail,
        native_media::commands::screen_share_start,
        native_media::commands::screen_share_stop,
        native_media::commands::voice_push_video_frame,
        native_media::commands::voice_push_screen_frame,
        native_media::commands::voice_set_screen_audio_enabled,
        native_media::commands::voice_push_screen_audio_frame,
        native_media::commands::media_pull_stream_video_frame,
        native_media::commands::media_get_stream_capabilities,
        native_media::commands::media_get_stream_diagnostics,
        native_media::commands::media_list_session_participants,
        native_media::commands::media_list_session_participant_capabilities,
        native_media::commands::media_list_published_tracks,
        native_media::commands::media_export_audio_sender_key,
        native_media::commands::media_export_track_sender_key,
        native_media::commands::media_send_audio_key_announce,
        native_media::commands::media_send_track_key_announce,
        native_media::commands::media_register_track_subscription,
        native_media::commands::media_register_stream_video_subscription,
        native_media::commands::media_unregister_track_subscription,
        native_media::commands::media_unregister_stream_video_subscription,
        native_media::commands::media_subscribe_audio,
        native_media::commands::media_unsubscribe_audio,
        native_media::commands::media_apply_audio_sender_key,
        native_media::commands::media_apply_track_sender_key,
    ]);

    builder
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn chrono_like_timestamp_utc() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("unix_ts={now}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static TRUSTED_ORIGINS_TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    fn reset_trusted_origins() {
        if let Ok(mut guard) = TRUSTED_SERVER_ORIGINS.write() {
            guard.clear();
        }
    }

    #[test]
    fn native_fetch_allows_loopback_without_configured_server() {
        let _guard = TRUSTED_ORIGINS_TEST_LOCK.lock().expect("test lock");
        reset_trusted_origins();

        assert!(
            ensure_native_fetch_target_is_trusted("https://localhost:8443/api/v1/health").is_ok()
        );
        assert!(
            ensure_native_fetch_target_is_trusted("http://127.0.0.1:8090/api/v1/health").is_ok()
        );
        assert!(ensure_native_fetch_target_is_trusted("https://[::1]:8443/api/v1/health").is_ok());
    }

    #[test]
    fn native_fetch_rejects_untrusted_external_hosts() {
        let _guard = TRUSTED_ORIGINS_TEST_LOCK.lock().expect("test lock");
        reset_trusted_origins();

        let err = ensure_native_fetch_target_is_trusted("https://evil.example/api/v1/users")
            .expect_err("untrusted host should be rejected");
        assert!(err.contains("not in the trusted server list"));
    }

    #[test]
    fn native_fetch_allows_origins_synced_from_server_list() {
        let _guard = TRUSTED_ORIGINS_TEST_LOCK.lock().expect("test lock");
        reset_trusted_origins();

        let mut origins = HashSet::new();
        origins.insert(
            trusted_origin_from_url("https://chat.example:8443/api/v1")
                .expect("valid trusted origin"),
        );
        if let Ok(mut guard) = TRUSTED_SERVER_ORIGINS.write() {
            *guard = origins;
        }

        assert!(
            ensure_native_fetch_target_is_trusted("https://chat.example:8443/api/v1/channels")
                .is_ok()
        );
        assert!(
            ensure_native_fetch_target_is_trusted("https://ignored.example/api/v1/channels")
                .is_err()
        );
        assert!(
            ensure_native_fetch_target_is_trusted("https://chat.example/api/v1/channels").is_err()
        );
    }

    #[test]
    fn native_fetch_rejects_relative_and_non_http_urls() {
        let _guard = TRUSTED_ORIGINS_TEST_LOCK.lock().expect("test lock");
        reset_trusted_origins();

        assert!(ensure_native_fetch_target_is_trusted("/api/v1/users").is_err());
        assert!(ensure_native_fetch_target_is_trusted("file:///etc/passwd").is_err());
    }

    #[test]
    fn trusted_origin_parser_accepts_only_http_origins() {
        assert_eq!(
            trusted_origin_from_url("https://chat.example:8443/api/v1"),
            Some("https://chat.example:8443".to_string())
        );
        assert_eq!(trusted_origin_from_url("ftp://chat.example"), None);
        assert_eq!(trusted_origin_from_url("/api/v1"), None);
    }

    #[test]
    fn fingerprint_hex_round_trips() {
        let mut fp = [0u8; 32];
        for (i, byte) in fp.iter_mut().enumerate() {
            *byte = (i * 7) as u8;
        }
        let hex = encode_fingerprint_hex(&fp);
        assert_eq!(hex.len(), 64);
        assert_eq!(decode_fingerprint_hex(&hex), Some(fp));
        assert_eq!(decode_fingerprint_hex("zz"), None);
        assert_eq!(decode_fingerprint_hex(&"g".repeat(64)), None);
    }

    #[test]
    fn loopback_hosts_are_recognised() {
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("127.5.6.7"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("[::1]"));
        assert!(!is_loopback_host("chat.example"));
        assert!(!is_loopback_host("203.0.113.5"));
    }

    #[test]
    fn pin_host_strips_ipv6_brackets_and_lowercases() {
        assert_eq!(
            pin_host_from_url("https://Chat.Example:8443/api"),
            Some("chat.example".to_string())
        );
        assert_eq!(
            pin_host_from_url("https://[2001:db8::1]:8443/api"),
            Some("2001:db8::1".to_string())
        );
        assert_eq!(pin_host_from_url("/relative"), None);
    }

    #[test]
    fn pinned_fingerprint_enforces_recorded_value() {
        let fp = [42u8; 32];
        set_pinned_fingerprint("pin-test.example".to_string(), fp);
        assert_eq!(pinned_fingerprint("pin-test.example"), Some(fp));
        assert_ne!(pinned_fingerprint("pin-test.example"), Some([0u8; 32]));
        assert_eq!(pinned_fingerprint("absent.example"), None);
    }

    #[test]
    fn extract_paracord_urls_filters_only_scheme_matches() {
        let args = vec![
            "/usr/bin/paracord-desktop".to_string(),
            "--flag".to_string(),
            "paracord://invite/abc123".to_string(),
            "https://example.com".to_string(),
            "paracord://server/chat.example:8443".to_string(),
        ];
        assert_eq!(
            extract_paracord_urls(args),
            vec![
                "paracord://invite/abc123".to_string(),
                "paracord://server/chat.example:8443".to_string(),
            ]
        );
        assert!(extract_paracord_urls(Vec::<String>::new()).is_empty());
    }

    #[test]
    fn default_connect_target_is_dev_server_in_debug_and_empty_in_release() {
        let target = get_default_connect_target();
        if cfg!(debug_assertions) {
            assert_eq!(target, "https://localhost:8443");
        } else {
            assert!(target.is_empty());
        }
    }

    #[test]
    fn health_url_requires_absolute_http_server_url() {
        assert_eq!(
            health_url_for_server("https://chat.example:8443/api/v1").unwrap(),
            "https://chat.example:8443/api/v1/health"
        );
        assert!(health_url_for_server("file:///tmp/server").is_err());
        assert!(health_url_for_server("/relative").is_err());
    }
}
