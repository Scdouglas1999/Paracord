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
#[cfg(target_os = "linux")]
mod pulse_router;
mod tray;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, RwLock};
use std::time::Duration;
use tauri::Emitter;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Origins that have been explicitly approved through the native trust prompt
/// and are currently configured in the renderer's server list. Certificate
/// errors and native HTTP requests are allowed only for these exact origins.
static TRUSTED_SERVER_ORIGINS: LazyLock<RwLock<HashSet<String>>> =
    LazyLock::new(|| RwLock::new(HashSet::new()));

/// Exact origins previously approved through the native trust prompt. This is
/// persisted separately from certificate pins: a pin proves continuity for a
/// host, but it must never itself authorise a new scheme/port/origin supplied by
/// the renderer.
static USER_APPROVED_SERVER_ORIGINS: LazyLock<RwLock<HashSet<String>>> =
    LazyLock::new(|| RwLock::new(HashSet::new()));

/// Only one native trust prompt may be outstanding. This prevents a compromised
/// renderer from stacking dialogs until the user accidentally approves one.
/// Serialize all privileged native consent prompts. A compromised renderer
/// must not be able to stack server, camera, and screen-capture dialogs.
pub(crate) static NATIVE_PRIVILEGE_PROMPT_ACTIVE: AtomicBool = AtomicBool::new(false);

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
const MAX_NATIVE_JSON_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_NATIVE_DOWNLOAD_BYTES: usize = 256 * 1024 * 1024;
const MAX_NATIVE_UPLOAD_BYTES: usize = 256 * 1024 * 1024;
const MAX_NATIVE_SSE_BUFFER_BYTES: usize = 1024 * 1024;

fn trusted_origin_from_url(raw_url: &str) -> Option<String> {
    let parsed = url::Url::parse(raw_url).ok()?;
    let host = parsed.host_str()?;
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && is_loopback_host(host)) {
        return None;
    }
    Some(parsed.origin().ascii_serialization().to_ascii_lowercase())
}

fn is_trusted_cert_origin(uri: &str) -> bool {
    let parsed = match url::Url::parse(uri) {
        Ok(parsed) => parsed,
        Err(_) => return false,
    };
    let origin = parsed.origin().ascii_serialization().to_ascii_lowercase();
    if origin == "null" {
        return false;
    }

    // Trust exact, native-approved origins that are currently in the server
    // list. Loopback is intentionally not a blanket exception: otherwise an
    // XSS could drive native_fetch against arbitrary local services.
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

/// Decide whether a `/health` response body actually identifies a Paracord
/// server. This is the identity gate that decides whether the renderer is
/// allowed to promote a (renderer-supplied) origin into the native
/// certificate-override / native-fetch trust set, so it is deliberately strict:
///
/// The renderer cannot be trusted to only forward genuine servers (a compromised
/// webview can call `update_trusted_server_hosts` with an attacker origin), so we
/// require the response to match the full Paracord health contract
/// (`{"status":"ok","service":"paracord"}` — see `paracord-api` `health()`)
/// rather than a single attacker-controllable field. A bare `service` string is
/// no longer sufficient; the body must be a JSON object exposing both the
/// `status` and `service` fields with their expected values.
///
/// NOTE: this raises the bar (an opportunistic endpoint that merely echoes one
/// field no longer qualifies) but is not a cryptographic proof of identity — a
/// host that fully emulates the health contract still passes. Closing that
/// residual gap requires a trusted signal the renderer cannot forge (a native
/// user-consent prompt for first-trust, or a server-signed identity challenge),
/// both of which live outside this file.
fn health_body_identifies_paracord(body: &serde_json::Value) -> bool {
    let Some(obj) = body.as_object() else {
        return false;
    };
    let service_ok = obj
        .get("service")
        .and_then(serde_json::Value::as_str)
        .map(|s| s.eq_ignore_ascii_case("paracord"))
        .unwrap_or(false);
    let status_ok = obj
        .get("status")
        .and_then(serde_json::Value::as_str)
        .map(|s| s.eq_ignore_ascii_case("ok"))
        .unwrap_or(false);
    service_ok && status_ok
}

#[cfg(windows)]
fn configure_webview2_overrides(app: &tauri::App) {
    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
    use base64::Engine;
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

                        let fingerprint = args.ServerCertificate().ok().and_then(|certificate| {
                            let mut pem_pwstr = windows_core::PWSTR::null();
                            if certificate.ToPemEncoding(&mut pem_pwstr).is_err()
                                || pem_pwstr.is_null()
                            {
                                return None;
                            }
                            let pem = pem_pwstr.to_string().ok();
                            windows::Win32::System::Com::CoTaskMemFree(Some(
                                pem_pwstr.as_ptr() as *const _
                            ));
                            let encoded: String = pem?
                                .lines()
                                .filter(|line| !line.starts_with("-----"))
                                .collect();
                            let der = BASE64_STANDARD.decode(encoded.as_bytes()).ok()?;
                            Some(sha256_fingerprint(&der))
                        });

                        if webview_certificate_is_allowed(&uri_str, fingerprint.as_ref()) {
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

/// Certificate-error overrides in WebView2 must enforce the same pin used by
/// native HTTP. Origin approval alone is insufficient: otherwise any later
/// self-signed certificate for that origin would be accepted by WSS.
#[cfg(any(windows, test))]
fn webview_certificate_is_allowed(uri: &str, fingerprint: Option<&[u8; 32]>) -> bool {
    if !is_trusted_cert_origin(uri) {
        return false;
    }
    let Some(host) = pin_host_from_url(uri) else {
        return false;
    };
    if is_loopback_host(&host) {
        return true;
    }
    fingerprint.is_some_and(|presented| {
        pinned_fingerprint(&host).is_some_and(|pinned| pinned == *presented)
    })
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

fn remove_pinned_fingerprint(host: &str) {
    if let Ok(mut guard) = PINNED_CERTS.write() {
        guard.remove(host);
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

fn security_state_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let mut dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    dir.push("security");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create security directory: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("failed to secure security directory: {e}"))?;
    }
    Ok(dir)
}

fn cert_pins_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(security_state_dir(app)?.join("cert_pins.json"))
}

fn approved_origins_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(security_state_dir(app)?.join("approved_origins.json"))
}

fn write_private_state_file(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| format!("failed to open security state: {e}"))?;
    use std::io::Write;
    file.write_all(data)
        .map_err(|e| format!("failed to write security state: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("failed to sync security state: {e}"))
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
    write_private_state_file(&path, &json)
        .map_err(|e| format!("failed to write certificate pins: {e}"))
}

/// Restore the exact server origins that the user approved through a native
/// prompt. Invalid and insecure external HTTP entries are discarded rather than
/// becoming trusted merely because they are present on disk.
fn load_user_approved_origins(app: &tauri::AppHandle) {
    let Ok(path) = approved_origins_path(app) else {
        return;
    };
    let Ok(data) = std::fs::read(&path) else {
        return;
    };
    let Ok(saved) = serde_json::from_slice::<Vec<String>>(&data) else {
        return;
    };
    let approved: HashSet<String> = saved
        .into_iter()
        .filter_map(|raw| trusted_origin_from_url(&raw))
        .collect();
    if let Ok(mut guard) = USER_APPROVED_SERVER_ORIGINS.write() {
        *guard = approved;
    }
}

/// Persist native-approved origins independently from certificate pins. A pin
/// alone is never treated as user approval for another origin on the same host.
fn persist_user_approved_origins(app: &tauri::AppHandle) -> Result<(), String> {
    let path = approved_origins_path(app)?;
    let mut approved: Vec<String> = USER_APPROVED_SERVER_ORIGINS
        .read()
        .map_err(|_| "approved-origin store poisoned".to_string())?
        .iter()
        .cloned()
        .collect();
    approved.sort_unstable();
    let json = serde_json::to_vec_pretty(&approved)
        .map_err(|e| format!("failed to serialize approved origins: {e}"))?;
    write_private_state_file(&path, &json)
        .map_err(|e| format!("failed to write approved origins: {e}"))
}

fn is_user_approved_server_origin(origin: &str) -> bool {
    USER_APPROVED_SERVER_ORIGINS
        .read()
        .map(|approved| approved.contains(origin))
        .unwrap_or(false)
}

fn record_user_approved_server_origin(origin: String) -> Result<(), String> {
    USER_APPROVED_SERVER_ORIGINS
        .write()
        .map_err(|_| "approved-origin store poisoned".to_string())?
        .insert(origin);
    Ok(())
}

fn remove_user_approved_server_origin(origin: &str) {
    if let Ok(mut approved) = USER_APPROVED_SERVER_ORIGINS.write() {
        approved.remove(origin);
    }
}

/// Ask through an OS-native dialog before trusting an origin for privileged
/// native networking. The renderer cannot approve this dialog, and a global
/// guard prevents it from queueing prompt spam after a renderer compromise.
async fn request_native_server_trust_confirmation(app: &tauri::AppHandle, origin: &str) -> bool {
    if NATIVE_PRIVILEGE_PROMPT_ACTIVE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return false;
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!(
            "Paracord wants to trust {origin} for server API requests and TLS certificate overrides.\n\n\
             Trust this exact origin only if you intended to add this server.\n\n\
             A new certificate fingerprint will be pinned on first use."
        ))
        .title("Trust new Paracord server?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Trust server".to_string(),
            "Cancel".to_string(),
        ))
        .show(move |approved| {
            let _ = tx.send(approved);
        });

    let approved = matches!(
        tokio::time::timeout(Duration::from_secs(60), rx).await,
        Ok(Ok(true))
    );
    NATIVE_PRIVILEGE_PROMPT_ACTIVE.store(false, Ordering::SeqCst);
    approved
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
/// Called from JS whenever the server list changes. An origin is admitted only
/// after the user approves it in a native dialog, Rust verifies its `/health`
/// response identifies Paracord, and (for HTTPS) its certificate matches or
/// establishes a TOFU pin. Renderer-controlled input can therefore reconcile
/// the active list but cannot silently grant native networking authority.
#[tauri::command]
async fn update_trusted_server_hosts(app: tauri::AppHandle, server_urls: Vec<String>) {
    if server_urls.len() > 100 {
        eprintln!("refusing oversized trusted server list");
        return;
    }
    let mut origins = HashSet::new();
    let client = match tls_pinning_client_with_timeout(Duration::from_secs(5)) {
        Ok(client) => client,
        Err(_) => return,
    };
    for raw_url in &server_urls {
        let Some(origin) = trusted_origin_from_url(raw_url) else {
            continue;
        };

        let previously_approved = is_user_approved_server_origin(&origin);
        let Some(host) = pin_host_from_url(raw_url) else {
            continue;
        };
        let external_https_without_pin = url::Url::parse(raw_url)
            .is_ok_and(|parsed| parsed.scheme() == "https")
            && !is_loopback_host(&host)
            && pinned_fingerprint(&host).is_none();
        // A first use must be approved before making any request. In particular,
        // this keeps an XSS from using the native client as a localhost SSRF
        // primitive against arbitrary loopback ports. A previously approved
        // origin whose pin disappeared must also be re-approved; silently
        // re-establishing it would turn a corrupt/deleted pin file into a MITM
        // opportunity.
        if (!previously_approved || external_https_without_pin)
            && !request_native_server_trust_confirmation(&app, &origin).await
        {
            continue;
        }

        let Ok(health_url) = health_url_for_server(raw_url) else {
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
        let Ok(bytes) = read_limited_response(resp, MAX_NATIVE_JSON_RESPONSE_BYTES).await else {
            continue;
        };
        let Ok(body) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        if !health_body_identifies_paracord(&body) {
            continue;
        }
        // Identity confirmed. On first contact, promote the captured fingerprint
        // to a durable pin; on later probes the pin already matched above.
        if pinned_fingerprint(&host).is_none() {
            if let Some(observed) = take_observed_fingerprint(&host) {
                set_pinned_fingerprint(host.clone(), observed);
                if let Err(err) = persist_pinned_certs(&app) {
                    eprintln!("failed to persist certificate pin: {err}");
                    remove_pinned_fingerprint(&host);
                    continue;
                }
            }
        }
        if !previously_approved {
            if record_user_approved_server_origin(origin.clone()).is_ok() {
                if let Err(err) = persist_user_approved_origins(&app) {
                    eprintln!("failed to persist approved server origins: {err}");
                    // A trust grant that cannot survive a restart must not be
                    // usable for the current session either.
                    remove_user_approved_server_origin(&origin);
                    continue;
                }
            } else {
                // Never activate an origin whose approval could not be retained;
                // this avoids a one-session trust grant after a storage failure.
                continue;
            }
        }
        origins.insert(origin);
    }
    if let Ok(mut guard) = TRUSTED_SERVER_ORIGINS.write() {
        *guard = origins;
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

async fn read_limited_response(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(format!("Response exceeds the {} byte native limit", limit));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Failed to read response body: {e}"))?
    {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(format!("Response exceeds the {} byte native limit", limit));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
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
    let body = read_limited_response(resp, MAX_NATIVE_JSON_RESPONSE_BYTES).await?;
    serde_json::from_slice(&body).map_err(|e| format!("Invalid JSON response: {e}"))
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
    let bytes = read_limited_response(resp, MAX_NATIVE_JSON_RESPONSE_BYTES).await?;
    let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    Ok(NativeFetchResponse { status, body })
}

#[derive(serde::Deserialize)]
struct NativeUploadFileRequest {
    url: String,
    filename: String,
    content_type: String,
    // Base64-encoded file bytes. Sent as a string rather than a raw byte array
    // because nested typed arrays do not round-trip reliably through the Tauri
    // JSON IPC (a `Uint8Array` serializes to an object, not a `Vec<u8>`), which
    // previously produced an empty multipart body and a 400 from the server.
    data_base64: String,
    headers: Option<std::collections::HashMap<String, String>>,
}

#[tauri::command]
async fn native_upload_file(req: NativeUploadFileRequest) -> Result<NativeFetchResponse, String> {
    use base64::Engine as _;

    ensure_native_fetch_target_is_trusted(&req.url)?;
    let client = tls_pinning_client()?;

    let data = base64::engine::general_purpose::STANDARD
        .decode(req.data_base64.as_bytes())
        .map_err(|e| format!("Invalid upload payload encoding: {e}"))?;
    if data.is_empty() {
        return Err("Upload payload was empty".to_string());
    }
    if data.len() > MAX_NATIVE_UPLOAD_BYTES {
        return Err(format!(
            "Upload exceeds the {} byte native limit",
            MAX_NATIVE_UPLOAD_BYTES
        ));
    }

    let part = reqwest::multipart::Part::bytes(data)
        .file_name(req.filename)
        .mime_str(&req.content_type)
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().part("file", part);

    let mut builder = client.post(&req.url).multipart(form);
    if let Some(headers) = req.headers {
        for (k, v) in headers {
            if k.eq_ignore_ascii_case("content-type") {
                continue;
            }
            builder = builder.header(&k, &v);
        }
    }

    let resp = builder.send().await.map_err(map_reqwest_error)?;
    let status = resp.status().as_u16();
    let bytes = read_limited_response(resp, MAX_NATIVE_JSON_RESPONSE_BYTES).await?;
    let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    Ok(NativeFetchResponse { status, body })
}

#[derive(serde::Deserialize)]
struct NativeDownloadFileRequest {
    url: String,
    headers: Option<std::collections::HashMap<String, String>>,
}

#[derive(serde::Serialize)]
struct NativeDownloadFileResponse {
    status: u16,
    content_type: Option<String>,
    // Base64-encoded body. Returning raw bytes as a JSON number array
    // (`Vec<u8>`) is enormous and slow to serialize/parse for multi-MB
    // attachments, which blocks the UI thread for a noticeable moment on every
    // image load/open/download. Base64 is ~4x smaller over the IPC and decodes
    // quickly via `atob` on the client.
    data_base64: String,
}

#[tauri::command]
async fn native_download_file(
    req: NativeDownloadFileRequest,
) -> Result<NativeDownloadFileResponse, String> {
    use base64::Engine as _;

    ensure_native_fetch_target_is_trusted(&req.url)?;
    let client = tls_pinning_client()?;
    let mut builder = client.get(&req.url);
    if let Some(headers) = req.headers {
        for (k, v) in headers {
            builder = builder.header(&k, &v);
        }
    }
    let resp = builder.send().await.map_err(map_reqwest_error)?;
    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let data = read_limited_response(resp, MAX_NATIVE_DOWNLOAD_BYTES).await?;
    let data_base64 = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok(NativeDownloadFileResponse {
        status,
        content_type,
        data_base64,
    })
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
                    if buffer.len() > MAX_NATIVE_SSE_BUFFER_BYTES
                        && find_sse_delimiter(&buffer).is_none()
                    {
                        emit_error(
                            "SSE event exceeded the native buffer limit".to_string(),
                            &app,
                            &task_stream_id,
                        );
                        return;
                    }
                    for (event, data) in drain_sse_events(&mut buffer) {
                        if data.len() > MAX_NATIVE_SSE_BUFFER_BYTES {
                            emit_error(
                                "SSE event exceeded the native buffer limit".to_string(),
                                &app,
                                &task_stream_id,
                            );
                            return;
                        }
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
/// connect flow can act on it. A plain second launch has no link args, but it
/// must still bring the existing window forward; otherwise desktop launchers
/// appear to do nothing while the single-instance plugin exits the new process.
fn forward_deep_link_urls(app: &tauri::AppHandle, urls: &[String]) {
    use tauri::{Emitter, Manager};
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    for url in urls {
        // Invite deep links contain bearer secrets. Never persist the URL.
        if let Err(err) =
            commands::append_client_log(app.clone(), "deep-link received [redacted]".to_string())
        {
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

#[cfg(target_os = "linux")]
fn linux_native_render_enabled() -> bool {
    !matches!(
        std::env::var("PARACORD_DISABLE_LINUX_NATIVE_RENDER")
            .ok()
            .as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
    )
}

#[cfg(not(target_os = "linux"))]
fn linux_native_render_enabled() -> bool {
    false
}

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
        .manage(native_media::native_render::NativeRenderState)
        .manage(NativeSseState::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
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
            load_user_approved_origins(app.handle());

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
            // Native surface rendering (spec §3.3): reparent the webview into a
            // gtk::Overlay so native-decoded video tracks can render into GLArea
            // overlay children composited over it. The local tauri-runtime-wry
            // patch makes Wry's GTK resize hook walk to the ancestor GtkWindow
            // instead of assuming a fixed parent depth, so this host is safe to
            // install by default on Linux. Best-effort: startup should survive a
            // host installation failure, while native_render_attach fails loudly
            // per subscription (spec §3.7).
            #[cfg(target_os = "linux")]
            if linux_native_render_enabled() {
                if let Err(err) =
                    native_media::native_render::linux::install_render_host(app.handle())
                {
                    let _ = commands::append_client_log(
                        app.handle().clone(),
                        format!(
                            "{} [native-render] linux host install failed: {}",
                            chrono_like_timestamp_utc(),
                            err
                        ),
                    );
                    eprintln!("failed to install native render host: {err}");
                } else {
                    let _ = commands::append_client_log(
                        app.handle().clone(),
                        format!(
                            "{} [native-render] linux host installed: GTK GLArea underlay tier-2",
                            chrono_like_timestamp_utc()
                        ),
                    );
                }
            } else {
                let _ = commands::append_client_log(
                    app.handle().clone(),
                    format!(
                        "{} [native-render] linux host disabled by PARACORD_DISABLE_LINUX_NATIVE_RENDER",
                        chrono_like_timestamp_utc()
                    ),
                );
                eprintln!(
                    "linux native render host disabled by PARACORD_DISABLE_LINUX_NATIVE_RENDER"
                );
            }
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
        native_upload_file,
        native_download_file,
        start_native_sse_stream,
        stop_native_sse_stream,
        get_default_connect_target,
        audio_capture::set_system_audio_capture_enabled,
        audio_capture::stop_system_audio_capture,
        // Native QUIC media engine
        native_media::commands::quic_upload_file,
        native_media::commands::quic_download_file,
        native_media::commands::start_voice_session,
        native_media::commands::stop_voice_session,
        native_media::commands::voice_set_mute,
        native_media::commands::voice_set_deaf,
        native_media::commands::voice_set_source_volume,
        native_media::commands::voice_set_noise_suppression,
        native_media::commands::voice_switch_input_device,
        native_media::commands::voice_switch_output_device,
        native_media::commands::voice_list_output_devices,
        native_media::commands::voice_list_input_devices,
        native_media::commands::voice_enable_video,
        native_media::commands::camera_list_devices,
        native_media::commands::voice_stop_screen_share,
        native_media::commands::screen_share_list_sources,
        native_media::commands::screen_share_source_thumbnail,
        native_media::commands::screen_share_start,
        native_media::commands::screen_share_stop,
        native_media::commands::voice_set_screen_audio_enabled,
        native_media::commands::media_request_keyframe,
        native_media::commands::media_set_stream_visibility,
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
        native_media::commands::media_generate_decode_probe,
        native_media::commands::media_unregister_track_subscription,
        native_media::commands::media_unregister_stream_video_subscription,
        native_media::commands::media_subscribe_audio,
        native_media::commands::media_unsubscribe_audio,
        native_media::commands::media_apply_audio_sender_key,
        native_media::commands::media_apply_track_sender_key,
        // Native surface rendering (spec §3.6)
        native_media::native_render::native_render_attach,
        native_media::native_render::native_render_update_geometry,
        native_media::native_render::native_render_detach,
    ]);

    let app = builder
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            // NVENC/NVDEC sessions must be torn down BEFORE libc `exit()`:
            // libnvcuvid's atexit handler aborts the process when sessions are
            // still alive on other threads (2026-07-07 SIGABRT coredumps on
            // quit). Bounded so a wedged component cannot hold the quit
            // hostage — after the timeout we exit anyway, loudly.
            let (tx, rx) = std::sync::mpsc::channel();
            let handle = app_handle.clone();
            std::thread::spawn(move || {
                native_media::shutdown_for_exit(&handle);
                let _ = tx.send(());
            });
            if rx.recv_timeout(std::time::Duration::from_secs(3)).is_err() {
                eprintln!("[native] media shutdown timed out at exit; exiting anyway");
            }
        }
    });
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
        if let Ok(mut guard) = USER_APPROVED_SERVER_ORIGINS.write() {
            guard.clear();
        }
    }

    #[test]
    fn native_fetch_requires_explicit_loopback_origin() {
        let _guard = TRUSTED_ORIGINS_TEST_LOCK.lock().expect("test lock");
        reset_trusted_origins();

        assert!(
            ensure_native_fetch_target_is_trusted("https://localhost:8443/api/v1/health").is_err()
        );
        assert!(
            ensure_native_fetch_target_is_trusted("http://127.0.0.1:8090/api/v1/health").is_err()
        );
        assert!(ensure_native_fetch_target_is_trusted("https://[::1]:8443/api/v1/health").is_err());
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
    fn webview_certificate_override_requires_external_host_pin() {
        let _guard = TRUSTED_ORIGINS_TEST_LOCK.lock().expect("test lock");
        reset_trusted_origins();
        let external = "https://pinned.example:8443".to_string();
        let loopback = "https://localhost:8443".to_string();
        if let Ok(mut origins) = TRUSTED_SERVER_ORIGINS.write() {
            origins.insert(external.clone());
            origins.insert(loopback);
        }
        remove_pinned_fingerprint("pinned.example");
        let expected = [9_u8; 32];
        assert!(!webview_certificate_is_allowed(
            &format!("{external}/gateway"),
            Some(&expected)
        ));

        set_pinned_fingerprint("pinned.example".to_string(), expected);
        assert!(webview_certificate_is_allowed(
            &format!("{external}/gateway"),
            Some(&expected)
        ));
        assert!(!webview_certificate_is_allowed(
            &format!("{external}/gateway"),
            Some(&[8_u8; 32])
        ));
        assert!(webview_certificate_is_allowed(
            "https://localhost:8443/gateway",
            None
        ));
        remove_pinned_fingerprint("pinned.example");
        reset_trusted_origins();
    }

    #[test]
    fn native_fetch_rejects_relative_and_non_http_urls() {
        let _guard = TRUSTED_ORIGINS_TEST_LOCK.lock().expect("test lock");
        reset_trusted_origins();

        assert!(ensure_native_fetch_target_is_trusted("/api/v1/users").is_err());
        assert!(ensure_native_fetch_target_is_trusted("file:///etc/passwd").is_err());
    }

    #[test]
    fn trusted_origin_parser_enforces_transport_policy() {
        assert_eq!(
            trusted_origin_from_url("https://chat.example:8443/api/v1"),
            Some("https://chat.example:8443".to_string())
        );
        assert_eq!(
            trusted_origin_from_url("http://127.0.0.1:8090/api/v1"),
            Some("http://127.0.0.1:8090".to_string())
        );
        assert_eq!(trusted_origin_from_url("http://chat.example/api/v1"), None);
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
    fn health_identity_requires_full_paracord_contract() {
        use serde_json::json;

        // Genuine Paracord health payload is accepted.
        assert!(health_body_identifies_paracord(
            &json!({ "status": "ok", "service": "paracord" })
        ));

        // A body that only echoes the single `service` field (the previous,
        // weaker check) is now rejected — the finding's core weakness.
        assert!(!health_body_identifies_paracord(
            &json!({ "service": "paracord" })
        ));

        // Wrong values, wrong types, and non-object bodies are all rejected.
        assert!(!health_body_identifies_paracord(
            &json!({ "status": "degraded", "service": "paracord" })
        ));
        assert!(!health_body_identifies_paracord(
            &json!({ "status": "ok", "service": "not-paracord" })
        ));
        assert!(!health_body_identifies_paracord(&json!([
            { "status": "ok", "service": "paracord" }
        ])));
        assert!(!health_body_identifies_paracord(&json!(
            "status=ok;service=paracord"
        )));
        assert!(!health_body_identifies_paracord(&json!(null)));
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
