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
/// What a native request gets when the caller names no deadline — the same
/// 15 s the axios clients declare as their default `timeout`.
const DEFAULT_NATIVE_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// The longest deadline a caller may ask for. Every native request used to
/// share one hard 15 s client timeout regardless of `config.timeout`, so a call
/// the browser is allowed two minutes for — `uploadOpaqueCiphertext` asks for
/// 120 s, and a multi-megabyte attachment needs it — died at 15 s on the
/// desktop with "Connection timed out." while the same code worked in a browser.
const MAX_NATIVE_REQUEST_TIMEOUT_MS: u64 = 10 * 60 * 1000;

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

pub(crate) fn ensure_native_fetch_target_is_trusted(uri: &str) -> Result<(), String> {
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

/// Hosts of every currently-trusted server origin, lowercased and without IPv6
/// brackets (the same normalisation [`pin_host_from_url`] applies).
fn trusted_server_hosts() -> HashSet<String> {
    TRUSTED_SERVER_ORIGINS
        .read()
        .map(|guard| {
            guard
                .iter()
                .filter_map(|origin| pin_host_from_url(origin))
                .collect()
        })
        .unwrap_or_default()
}

/// Normalise a native media endpoint into a bare host.
///
/// Unlike the HTTP commands, media endpoints reach Rust as `host:port` (see
/// `normalizeNativeRelayEndpoint` in the renderer), so `Url::parse` alone is not
/// enough — `chat.example:9443` parses as a URL with scheme `chat.example` and
/// no host at all.
fn native_endpoint_host(endpoint: &str) -> Option<String> {
    let trimmed = endpoint.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(addr) = trimmed.parse::<std::net::SocketAddr>() {
        return Some(addr.ip().to_string().to_ascii_lowercase());
    }

    if let Ok(parsed) = url::Url::parse(trimmed) {
        if let Some(host) = parsed.host_str() {
            return Some(
                host.trim_start_matches('[')
                    .trim_end_matches(']')
                    .to_ascii_lowercase(),
            );
        }
    }

    // Bare `host:port` / `[v6]:port`.
    let host = if let Some(rest) = trimmed.strip_prefix('[') {
        let end = rest.find(']')?;
        let after = &rest[end + 1..];
        if !after.is_empty() && !after.starts_with(':') {
            return None;
        }
        rest[..end].to_string()
    } else {
        let (host, port) = trimmed.rsplit_once(':')?;
        if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        host.to_string()
    };

    if host.is_empty() || host.contains('/') || host.contains('@') {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

/// Host-only trust gate for native transports whose endpoint is a bare
/// `host:port` rather than a URL (the QUIC media relay).
///
/// Comparison is by host, not origin: the media relay listens on a different
/// port from the HTTP API, so its port is legitimately absent from
/// [`TRUSTED_SERVER_ORIGINS`]. Restricting to approved *hosts* still confines a
/// compromised renderer to servers the user has explicitly trusted, which is
/// what the caller-supplied `cert_hash` cannot do — a pin chosen by the caller
/// is not a control.
///
/// Every QUIC command in `native_media/commands.rs` that accepts a
/// renderer-supplied `endpoint` calls this first — `start_voice_session`,
/// `quic_upload_file` and `quic_download_file` — exactly as the HTTP/SSE
/// commands in this file call `ensure_native_fetch_target_is_trusted`. Removing
/// any of those call sites reopens renderer-chosen dialling; they are load
/// bearing, not defensive decoration.
pub(crate) fn ensure_native_media_endpoint_is_trusted(endpoint: &str) -> Result<(), String> {
    let Some(host) = native_endpoint_host(endpoint) else {
        return Err("Native media endpoint must be a host:port address".to_string());
    };
    if trusted_server_hosts().contains(&host) {
        return Ok(());
    }
    Err("Native media endpoint host is not in the trusted server list".to_string())
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
    /// A body that is not JSON, as base64 of the exact bytes to put on the
    /// wire, with the caller's own `content-type` left untouched. Everything
    /// non-JSON a browser can send — a form-encoded string, a `Blob`, an
    /// `ArrayBuffer` — used to be coerced through `serde_json::Value` and
    /// arrive as a quoted JSON string or an empty object.
    #[serde(default)]
    body_base64: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
    /// Per-request deadline in milliseconds, mirroring axios `config.timeout`.
    /// Absent means [`DEFAULT_NATIVE_REQUEST_TIMEOUT`].
    #[serde(default)]
    timeout_ms: Option<u64>,
    /// How the renderer wants the body back: `"json"` (the default — parse as
    /// JSON, fall back to the raw text exactly as axios does) or `"binary"`,
    /// which answers with `body_base64` instead and is how `responseType:
    /// 'blob' | 'arraybuffer'` reaches a non-JSON endpoint.
    #[serde(default)]
    response_type: Option<String>,
}

/// Resolve a caller-supplied deadline into one reqwest will accept.
///
/// `Some(0)` is axios' "no timeout"; it is clamped to the maximum rather than
/// made unbounded, because a native request with no deadline at all wedges the
/// UI action behind it forever when a server stops answering mid-body.
fn native_request_timeout(timeout_ms: Option<u64>) -> Duration {
    match timeout_ms {
        None => DEFAULT_NATIVE_REQUEST_TIMEOUT,
        Some(0) => Duration::from_millis(MAX_NATIVE_REQUEST_TIMEOUT_MS),
        Some(ms) => Duration::from_millis(ms.min(MAX_NATIVE_REQUEST_TIMEOUT_MS)),
    }
}

/// Turn a response body into what `response.data` would hold in a browser.
///
/// Axios leaves a body it cannot parse as JSON on `response.data` as the raw
/// text. This used to answer `null` for anything that was not valid JSON, so
/// every plain-text error page, every `text/plain` endpoint and every
/// non-JSON 4xx explanation arrived at the renderer as an empty body and the
/// UI reported "Request failed" with no reason.
fn native_body_value(bytes: &[u8]) -> serde_json::Value {
    if bytes.is_empty() {
        // Axios gives `data: ''` for an empty body (a 204, say). Match it, so
        // `if (!response.data)` behaves the same on both shells.
        return serde_json::Value::String(String::new());
    }
    match serde_json::from_slice(bytes) {
        Ok(value) => value,
        Err(_) => serde_json::Value::String(String::from_utf8_lossy(bytes).into_owned()),
    }
}

/// Build the request for `method`, supporting every method a browser can send
/// rather than silently turning the unknown ones into a GET — which is what
/// this did to HEAD and OPTIONS.
fn native_request_builder(
    client: &reqwest::Client,
    method: Option<&str>,
    url: &str,
) -> Result<reqwest::RequestBuilder, String> {
    let method = method.unwrap_or("GET").to_uppercase();
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| format!("Unsupported HTTP method: {method}"))?;
    Ok(client.request(method, url))
}

/// Apply caller headers, dropping the ones the transport owns.
///
/// `content-type` is skipped when the transport sets its own (a JSON body, or
/// a multipart form whose boundary reqwest generates): `RequestBuilder::header`
/// *appends*, so leaving the caller's value in place sent two `content-type`
/// headers and the server read whichever came first.
fn apply_native_headers(
    mut builder: reqwest::RequestBuilder,
    headers: Option<std::collections::HashMap<String, String>>,
    skip_content_type: bool,
) -> reqwest::RequestBuilder {
    if let Some(headers) = headers {
        for (k, v) in headers {
            if skip_content_type && k.eq_ignore_ascii_case("content-type") {
                continue;
            }
            builder = builder.header(&k, &v);
        }
    }
    builder
}

#[derive(serde::Serialize)]
struct NativeFetchResponse {
    status: u16,
    body: serde_json::Value,
    /// Response headers, lowercased, so the renderer can read the ones the API
    /// contract puts there.
    ///
    /// This used to be omitted entirely, and the axios adapter that consumes
    /// this reported `headers: {}` for every desktop request. The API answers
    /// every call with `X-Paracord-History-Epoch`, and the operation context
    /// compares it against the epoch the operation captured: absent is not
    /// equal, so on the desktop *every* response looked like the account's
    /// database history had changed underneath it. That expired the operation
    /// (an error on almost every screen) and asked for a history
    /// reconciliation, which drops the realtime stream — so the desktop client
    /// could not hold a connection for longer than it took to make one request.
    headers: std::collections::HashMap<String, String>,
    /// The raw body, base64-encoded, when the caller asked for
    /// `response_type: "binary"` (axios `responseType: 'blob' |
    /// 'arraybuffer'`). `body` is left null in that case: a PNG forced through
    /// `serde_json::Value` is not a round trip.
    #[serde(skip_serializing_if = "Option::is_none")]
    body_base64: Option<String>,
}

/// Collect a response's headers for the renderer.
///
/// `set-cookie` is withheld: it is not readable from JavaScript in a browser
/// either, and the cookie jar is the shell's business. Values that are not
/// valid UTF-8 are dropped rather than lossily transcoded.
fn native_response_headers(resp: &reqwest::Response) -> std::collections::HashMap<String, String> {
    resp.headers()
        .iter()
        .filter(|(name, _)| !name.as_str().eq_ignore_ascii_case("set-cookie"))
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_ascii_lowercase(), value.to_string()))
        })
        .collect()
}

/// Send a built request and shape the answer the way the renderer expects.
///
/// Shared by every native HTTP command so a fix to one — response headers, the
/// non-JSON body fallback, the size cap — is a fix to all of them. Diverging
/// copies of this tail are how `native_fetch` came to drop response headers
/// while `native_upload_file` did not.
async fn send_native_request(
    builder: reqwest::RequestBuilder,
    binary: bool,
) -> Result<NativeFetchResponse, String> {
    use base64::Engine as _;

    let resp = builder.send().await.map_err(map_reqwest_error)?;
    let status = resp.status().as_u16();
    let headers = native_response_headers(&resp);
    let limit = if binary {
        MAX_NATIVE_DOWNLOAD_BYTES
    } else {
        MAX_NATIVE_JSON_RESPONSE_BYTES
    };
    let bytes = read_limited_response(resp, limit).await?;
    if binary {
        return Ok(NativeFetchResponse {
            status,
            body: serde_json::Value::Null,
            headers,
            body_base64: Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
        });
    }
    Ok(NativeFetchResponse {
        status,
        body: native_body_value(&bytes),
        headers,
        body_base64: None,
    })
}

#[tauri::command]
async fn native_fetch(req: NativeFetchRequest) -> Result<NativeFetchResponse, String> {
    ensure_native_fetch_target_is_trusted(&req.url)?;
    let client = tls_pinning_client_with_timeout(native_request_timeout(req.timeout_ms))?;
    let mut builder = native_request_builder(&client, req.method.as_deref(), &req.url)?;
    // Only a JSON body makes the transport own `content-type`; a raw body
    // carries the caller's own declared type.
    let json_body = req.body.filter(|_| req.body_base64.is_none());
    builder = apply_native_headers(builder, req.headers, json_body.is_some());
    if let Some(body_base64) = req.body_base64 {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(body_base64.as_bytes())
            .map_err(|e| format!("Invalid request body encoding: {e}"))?;
        if bytes.len() > MAX_NATIVE_UPLOAD_BYTES {
            return Err(format!(
                "Request body exceeds the {MAX_NATIVE_UPLOAD_BYTES} byte native limit"
            ));
        }
        builder = builder.body(bytes);
    } else if let Some(body) = json_body {
        builder = builder
            .header("content-type", "application/json")
            .json(&body);
    }
    let binary = req.response_type.as_deref() == Some("binary");
    send_native_request(builder, binary).await
}

/// One part of a multipart form crossing the bridge.
///
/// Either a text field (`value`) or a file field (`data_base64`, with the
/// `filename` and `content_type` the browser would have attached).
#[derive(serde::Deserialize)]
struct NativeMultipartPart {
    name: String,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    content_type: Option<String>,
    #[serde(default)]
    data_base64: Option<String>,
}

/// A multipart/form-data request with arbitrary fields and files.
///
/// The bridge had no such route. A `FormData` handed to `invoke('native_fetch')`
/// is serialised by `structuredClone`/JSON as `{}` — it has no enumerable own
/// properties — so on the desktop every multipart call arrived with the body
/// `{}` and `content-type: application/json`, and the server answered 400
/// "Missing …". That killed encrypted DM attachments, custom emoji, stickers
/// and avatar uploads, while the browser (where axios hands FormData straight
/// to XHR) was fine — so nothing in CI saw it.
#[derive(serde::Deserialize)]
struct NativeMultipartRequest {
    url: String,
    #[serde(default)]
    method: Option<String>,
    parts: Vec<NativeMultipartPart>,
    #[serde(default)]
    headers: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

/// Assemble the reqwest form, enforcing the upload cap across *all* parts.
fn build_native_multipart_form(
    parts: Vec<NativeMultipartPart>,
) -> Result<reqwest::multipart::Form, String> {
    use base64::Engine as _;

    if parts.is_empty() {
        return Err("A multipart request needs at least one part".to_string());
    }
    let mut total = 0usize;
    let mut form = reqwest::multipart::Form::new();
    for part in parts {
        if let Some(data_base64) = part.data_base64 {
            let data = base64::engine::general_purpose::STANDARD
                .decode(data_base64.as_bytes())
                .map_err(|e| format!("Invalid upload payload encoding: {e}"))?;
            total = total.saturating_add(data.len());
            if total > MAX_NATIVE_UPLOAD_BYTES {
                return Err(format!(
                    "Upload exceeds the {MAX_NATIVE_UPLOAD_BYTES} byte native limit"
                ));
            }
            let mut file = reqwest::multipart::Part::bytes(data);
            if let Some(filename) = part.filename {
                file = file.file_name(filename);
            }
            // A browser stamps a Blob part with its own type, defaulting to
            // application/octet-stream. Match that: the emoji and avatar
            // routes sniff `field.content_type()` to pick the stored extension.
            let mime = part
                .content_type
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "application/octet-stream".to_string());
            file = file.mime_str(&mime).map_err(|e| e.to_string())?;
            form = form.part(part.name, file);
        } else {
            let value = part.value.unwrap_or_default();
            total = total.saturating_add(value.len());
            if total > MAX_NATIVE_UPLOAD_BYTES {
                return Err(format!(
                    "Upload exceeds the {MAX_NATIVE_UPLOAD_BYTES} byte native limit"
                ));
            }
            form = form.text(part.name, value);
        }
    }
    Ok(form)
}

#[tauri::command]
async fn native_multipart(req: NativeMultipartRequest) -> Result<NativeFetchResponse, String> {
    ensure_native_fetch_target_is_trusted(&req.url)?;
    let client = tls_pinning_client_with_timeout(native_request_timeout(req.timeout_ms))?;
    let form = build_native_multipart_form(req.parts)?;
    let builder = native_request_builder(&client, req.method.as_deref().or(Some("POST")), &req.url)?
        .multipart(form);
    // reqwest owns `content-type` here: it carries the generated boundary, and
    // the caller's literal `multipart/form-data` (which axios sets, boundaryless)
    // would make the server unable to split the body.
    let builder = apply_native_headers(builder, req.headers, true);
    send_native_request(builder, false).await
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
    #[serde(default)]
    timeout_ms: Option<u64>,
}

/// The single-file upload the attachment path has always used. Kept as its own
/// command for that caller, but expressed in terms of [`native_multipart`] so
/// there is exactly one multipart implementation to be right.
#[tauri::command]
async fn native_upload_file(req: NativeUploadFileRequest) -> Result<NativeFetchResponse, String> {
    use base64::Engine as _;

    let data = base64::engine::general_purpose::STANDARD
        .decode(req.data_base64.as_bytes())
        .map_err(|e| format!("Invalid upload payload encoding: {e}"))?;
    if data.is_empty() {
        return Err("Upload payload was empty".to_string());
    }

    native_multipart(NativeMultipartRequest {
        url: req.url,
        method: Some("POST".to_string()),
        parts: vec![NativeMultipartPart {
            name: "file".to_string(),
            value: None,
            filename: Some(req.filename),
            content_type: Some(req.content_type),
            data_base64: Some(req.data_base64),
        }],
        headers: req.headers,
        // An attachment can be hundreds of megabytes; the old shared 15 s
        // client timeout aborted it mid-body. Default to the browser's upload
        // allowance when the caller names none.
        timeout_ms: Some(req.timeout_ms.unwrap_or(120_000)),
    })
    .await
}

#[derive(serde::Deserialize)]
struct NativeDownloadFileRequest {
    url: String,
    headers: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    timeout_ms: Option<u64>,
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
    // A multi-megabyte attachment does not finish inside the 15 s default.
    let client = tls_pinning_client_with_timeout(native_request_timeout(Some(
        req.timeout_ms.unwrap_or(120_000),
    )))?;
    let builder = apply_native_headers(client.get(&req.url), req.headers, false);
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
        native_multipart,
        native_download_file,
        start_native_sse_stream,
        stop_native_sse_stream,
        get_default_connect_target,
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

    /// The native SSE parser must surface the server's idle heartbeat.
    ///
    /// The desktop client reads the realtime stream here rather than through a
    /// browser `EventSource`, and this parser drops comment lines for the same
    /// reason the specification tells a browser to: a comment carries nothing.
    /// While the server's keepalive *was* a comment, an idle desktop client saw
    /// literally nothing after READY and its liveness watchdog tore down a
    /// healthy stream every ninety seconds. The keepalive is now a real frame;
    /// this pins that this parser hands it to the frontend.
    #[test]
    fn native_sse_parser_surfaces_the_idle_heartbeat_and_still_drops_comments() {
        let mut buffer =
            String::from(": keep-alive\n\nevent: gateway\ndata: {\"op\":11,\"d\":null}\n\n");
        let events = drain_sse_events(&mut buffer);
        assert_eq!(
            events,
            vec![(
                Some("gateway".to_string()),
                "{\"op\":11,\"d\":null}".to_string()
            )],
            "a comment carries nothing to the frontend; the heartbeat frame must"
        );
        assert!(buffer.is_empty(), "both frames were consumed");
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
    fn native_media_endpoint_gate_accepts_trusted_host_on_any_port() {
        let _guard = TRUSTED_ORIGINS_TEST_LOCK.lock().expect("test lock");
        reset_trusted_origins();

        // Untrusted until the server list says otherwise.
        assert!(ensure_native_media_endpoint_is_trusted("relay.example:9443").is_err());

        if let Ok(mut guard) = TRUSTED_SERVER_ORIGINS.write() {
            guard.insert(
                trusted_origin_from_url("https://relay.example:8443/api/v1")
                    .expect("valid trusted origin"),
            );
        }

        // The media relay runs on its own port, so the gate is host-scoped.
        assert!(ensure_native_media_endpoint_is_trusted("relay.example:9443").is_ok());
        assert!(ensure_native_media_endpoint_is_trusted("RELAY.EXAMPLE:9443").is_ok());
        assert!(ensure_native_media_endpoint_is_trusted("evil.example:9443").is_err());
        assert!(ensure_native_media_endpoint_is_trusted("").is_err());
        assert!(ensure_native_media_endpoint_is_trusted("relay.example").is_err());

        reset_trusted_origins();
    }

    #[test]
    fn native_endpoint_host_parses_every_endpoint_shape() {
        assert_eq!(
            native_endpoint_host("chat.example:9443"),
            Some("chat.example".to_string())
        );
        assert_eq!(
            native_endpoint_host("127.0.0.1:9443"),
            Some("127.0.0.1".to_string())
        );
        assert_eq!(native_endpoint_host("[::1]:9443"), Some("::1".to_string()));
        assert_eq!(
            native_endpoint_host("https://chat.example:9443"),
            Some("chat.example".to_string())
        );
        assert_eq!(native_endpoint_host("chat.example:notaport"), None);
        assert_eq!(native_endpoint_host("chat.example"), None);
        assert_eq!(native_endpoint_host(""), None);
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

/// The desktop bridge contract, from the Rust side.
///
/// `client/src-tauri/bridge-contract.json` is the one description of what
/// crosses `invoke`, and `client/src/lib/tauriAxiosAdapter.contract.test.ts`
/// asserts the renderer emits exactly these payloads. Here we assert the
/// commands *accept* them and keep every field.
///
/// Five release blockers were the same bug — the two sides disagreeing about a
/// shape that no browser test can observe. This pair of suites is what makes
/// that disagreement a failing test instead of a dead feature.
#[cfg(test)]
pub(crate) mod bridge_contract {
    pub(crate) const CONTRACT_JSON: &str = include_str!("../bridge-contract.json");

    pub(crate) fn contract() -> serde_json::Value {
        serde_json::from_str(CONTRACT_JSON).expect("bridge-contract.json must be valid JSON")
    }

    /// Every entry of `key` whose `name` is not `"$comment"`.
    pub(crate) fn entries(key: &str) -> Vec<serde_json::Value> {
        contract()[key]
            .as_array()
            .unwrap_or_else(|| panic!("bridge-contract.json has no \"{key}\" array"))
            .clone()
    }

    pub(crate) fn entry(key: &str, name: &str) -> serde_json::Value {
        entries(key)
            .into_iter()
            .find(|value| value["name"] == name)
            .unwrap_or_else(|| panic!("bridge-contract.json has no {key} entry named {name}"))
    }
}

#[cfg(test)]
mod bridge_contract_tests {
    use super::bridge_contract::{entries, entry};
    use super::*;

    fn req(name: &str) -> serde_json::Value {
        entry("cases", name)["req"].clone()
    }

    #[test]
    fn every_case_deserializes_into_the_command_it_names() {
        for case in entries("cases") {
            let name = case["name"].as_str().unwrap().to_string();
            let command = case["command"].as_str().unwrap().to_string();
            let req = case["req"].clone();
            let outcome: Result<(), String> = match command.as_str() {
                "native_fetch" => serde_json::from_value::<NativeFetchRequest>(req)
                    .map(|_| ())
                    .map_err(|e| e.to_string()),
                "native_multipart" => serde_json::from_value::<NativeMultipartRequest>(req)
                    .map(|_| ())
                    .map_err(|e| e.to_string()),
                "native_upload_file" => serde_json::from_value::<NativeUploadFileRequest>(req)
                    .map(|_| ())
                    .map_err(|e| e.to_string()),
                "native_download_file" => serde_json::from_value::<NativeDownloadFileRequest>(req)
                    .map(|_| ())
                    .map_err(|e| e.to_string()),
                other => panic!("case {name} names unknown command {other}"),
            };
            outcome.unwrap_or_else(|e| panic!("case {name} ({command}) does not deserialize: {e}"));
        }
    }

    #[test]
    fn a_parameterised_get_keeps_its_query_string() {
        // Bug 2: the adapter dropped `config.params`, so recovery arrived with
        // no `after` and the server answered 400 — which is what left every
        // 3.0.0 profile unable to reach a ready message runtime.
        let parsed: NativeFetchRequest = serde_json::from_value(req("get-with-params")).unwrap();
        assert!(parsed.url.contains("?after=0&limit=100&known_ids="));
        assert_eq!(parsed.method.as_deref(), Some("GET"));
        assert!(parsed.body.is_none() && parsed.body_base64.is_none());
    }

    #[test]
    fn a_multipart_case_becomes_a_form_with_every_part() {
        // Bug 5: a FormData handed to invoke() arrives as `{}`. These parts are
        // the shape that replaces it, and the form must build from them.
        for name in ["multipart-upload", "multipart-opaque-blob"] {
            let parsed: NativeMultipartRequest = serde_json::from_value(req(name)).unwrap();
            let count = parsed.parts.len();
            assert!(count > 0, "{name} carries no parts");
            let form = build_native_multipart_form(parsed.parts)
                .unwrap_or_else(|e| panic!("{name} does not build a form: {e}"));
            assert_eq!(form.boundary().is_empty(), false);
        }
    }

    #[test]
    fn a_multipart_part_defaults_to_octet_stream_but_keeps_a_declared_type() {
        let parsed: NativeMultipartRequest =
            serde_json::from_value(req("multipart-upload")).unwrap();
        let image = parsed
            .parts
            .iter()
            .find(|part| part.name == "image")
            .expect("the emoji case has an image part");
        assert_eq!(image.content_type.as_deref(), Some("image/png"));
        assert_eq!(image.filename.as_deref(), Some("party.png"));
        let text = parsed.parts.iter().find(|part| part.name == "name").unwrap();
        assert_eq!(text.value.as_deref(), Some("party"));
        assert!(text.data_base64.is_none());
    }

    #[test]
    fn the_callers_deadline_is_honoured_within_the_bound() {
        // Every native request used to share one hard 15 s client timeout, so
        // an upload the browser allows 120 s died mid-body.
        let upload: NativeMultipartRequest =
            serde_json::from_value(req("multipart-opaque-blob")).unwrap();
        assert_eq!(
            native_request_timeout(upload.timeout_ms),
            Duration::from_millis(120_000)
        );
        assert_eq!(
            native_request_timeout(None),
            DEFAULT_NATIVE_REQUEST_TIMEOUT,
            "a caller that names no deadline gets the axios default"
        );
        assert_eq!(
            native_request_timeout(Some(0)),
            Duration::from_millis(MAX_NATIVE_REQUEST_TIMEOUT_MS),
            "axios' 'no timeout' is bounded, not unbounded"
        );
        assert_eq!(
            native_request_timeout(Some(u64::MAX)),
            Duration::from_millis(MAX_NATIVE_REQUEST_TIMEOUT_MS)
        );
    }

    #[test]
    fn every_method_a_browser_can_send_survives() {
        let client = reqwest::Client::new();
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] {
            let built =
                native_request_builder(&client, Some(method), "https://server.example/api/v1/x")
                    .unwrap_or_else(|e| panic!("{method}: {e}"))
                    .build()
                    .unwrap();
            // HEAD and OPTIONS used to fall through a match arm into a GET.
            assert_eq!(built.method().as_str(), method);
        }
        assert!(native_request_builder(&client, Some("TRACEROUTE"), "https://x/").is_ok());
        assert!(native_request_builder(&client, Some("bad method"), "https://x/").is_err());
    }

    #[test]
    fn a_response_body_reads_the_way_axios_reads_it() {
        let json = entry("responses", "headers-are-returned")["response"].clone();
        assert_eq!(
            native_body_value(serde_json::to_string(&json["body"]).unwrap().as_bytes()),
            json["body"]
        );
        // Bug: a body that is not JSON used to become `null`, so every
        // plain-text error the server can answer with reached the UI empty.
        let text = entry("responses", "non-json-body-is-text")["response"]["body"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(
            native_body_value(text.as_bytes()),
            serde_json::Value::String(text)
        );
        // Axios reports an empty body (a 204) as `''`, not null.
        assert_eq!(
            native_body_value(b""),
            serde_json::Value::String(String::new())
        );
    }

    #[test]
    fn the_transport_owns_content_type_only_when_it_supplies_one() {
        let client = reqwest::Client::new();
        let mut headers = std::collections::HashMap::new();
        headers.insert("content-type".to_string(), "text/plain".to_string());
        headers.insert("authorization".to_string(), "Bearer t".to_string());

        // A JSON or multipart body: the caller's content-type must be dropped,
        // because `RequestBuilder::header` appends and two content-type headers
        // is not a request any server reads the way the caller meant.
        let dropped = native_request_builder(&client, Some("POST"), "https://x/")
            .unwrap();
        let dropped = apply_native_headers(dropped, Some(headers.clone()), true)
            .build()
            .unwrap();
        assert!(dropped.headers().get("content-type").is_none());
        assert!(dropped.headers().get("authorization").is_some());

        // A raw body carries the caller's own declared type.
        let kept = native_request_builder(&client, Some("POST"), "https://x/").unwrap();
        let kept = apply_native_headers(kept, Some(headers), false).build().unwrap();
        assert_eq!(kept.headers().get("content-type").unwrap(), "text/plain");
    }

    #[test]
    fn an_oversized_multipart_is_refused_across_all_parts_together() {
        use base64::Engine as _;
        let chunk = base64::engine::general_purpose::STANDARD.encode(vec![0u8; 1024]);
        let parts = vec![
            NativeMultipartPart {
                name: "a".into(),
                value: None,
                filename: Some("a.bin".into()),
                content_type: None,
                data_base64: Some(chunk.clone()),
            },
            NativeMultipartPart {
                name: "b".into(),
                value: None,
                filename: Some("b.bin".into()),
                content_type: None,
                data_base64: Some(chunk),
            },
        ];
        assert!(build_native_multipart_form(parts).is_ok());
        assert!(
            build_native_multipart_form(Vec::new()).is_err(),
            "a multipart request with no parts is not a request"
        );
    }
}
