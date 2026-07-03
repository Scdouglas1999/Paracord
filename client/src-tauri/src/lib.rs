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

use std::collections::HashSet;
use std::sync::{LazyLock, RwLock};
use std::time::Duration;

/// Origins that the user has explicitly configured as servers. Certificate
/// errors for these origins (and localhost) are allowed through so that
/// self-hosted servers with self-signed certificates continue to work.
/// All other origins fall back to the default (reject) behaviour.
static TRUSTED_SERVER_ORIGINS: LazyLock<RwLock<HashSet<String>>> =
    LazyLock::new(|| RwLock::new(HashSet::new()));

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

/// Update the set of trusted server origins for TLS certificate override.
/// Called from JS whenever the server list changes. Non-loopback origins are
/// trusted only after Rust verifies their `/health` endpoint identifies as a
/// Paracord server, so renderer code cannot directly whitelist arbitrary TLS
/// targets for the permissive native HTTP client.
#[tauri::command]
async fn update_trusted_server_hosts(server_urls: Vec<String>) {
    let mut origins = HashSet::new();
    let client = match tls_permissive_client_with_timeout(Duration::from_secs(5)) {
        Ok(client) => client,
        Err(_) => return,
    };
    for raw_url in &server_urls {
        let Some(origin) = trusted_origin_from_url(raw_url) else {
            continue;
        };
        if is_trusted_cert_origin(raw_url) {
            origins.insert(origin);
            continue;
        }
        let Ok(health_url) = health_url_for_server(raw_url) else {
            continue;
        };
        let Ok(resp) = client.get(&health_url).send().await else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        if let Ok(body) = resp.json::<serde_json::Value>().await {
            if body.get("service").and_then(|value| value.as_str()) == Some("paracord") {
                origins.insert(origin);
            }
        }
    }
    if let Ok(mut guard) = TRUSTED_SERVER_ORIGINS.write() {
        *guard = origins;
    }
}

/// Build a shared reqwest client that accepts self-signed certs.
fn tls_permissive_client_with_timeout(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(timeout)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))
}

fn tls_permissive_client() -> Result<reqwest::Client, String> {
    tls_permissive_client_with_timeout(Duration::from_secs(15))
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
/// TLS restrictions. Accepts self-signed certs so self-hosted servers work.
#[tauri::command]
async fn probe_server(server_url: String) -> Result<serde_json::Value, String> {
    let client = tls_permissive_client()?;
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
/// The reqwest client accepts self-signed certs, so requests are restricted to
/// loopback or origins that the user explicitly added to the server list.
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
    let client = tls_permissive_client()?;
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

pub fn run() {
    let builder = tauri::Builder::default()
        .manage(native_media::MediaState::new())
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
    fn health_url_requires_absolute_http_server_url() {
        assert_eq!(
            health_url_for_server("https://chat.example:8443/api/v1").unwrap(),
            "https://chat.example:8443/api/v1/health"
        );
        assert!(health_url_for_server("file:///tmp/server").is_err());
        assert!(health_url_for_server("/relative").is_err());
    }
}
