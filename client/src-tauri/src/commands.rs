use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use rand::RngCore;
use serde::Serialize;
use std::io::Write;
use std::path::Path;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! Welcome to Paracord.", name)
}

#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct UpdateTargetInfo {
    os: String,
    arch: String,
    installer_preference: String,
}

#[tauri::command]
pub fn get_update_target() -> UpdateTargetInfo {
    let installer_preference = if cfg!(target_os = "windows") {
        "msi".to_string()
    } else if cfg!(target_os = "linux") {
        let prefers_appimage = std::env::current_exe()
            .ok()
            .and_then(|p| p.to_str().map(|s| s.ends_with(".AppImage")))
            .unwrap_or(false);
        if prefers_appimage {
            "appimage".to_string()
        } else {
            "deb".to_string()
        }
    } else {
        "asset".to_string()
    };

    UpdateTargetInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        installer_preference,
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ForegroundApplication {
    pid: u32,
    process_name: String,
    display_name: String,
    executable_path: Option<String>,
    window_title: Option<String>,
}

fn readable_process_name(raw: &str) -> String {
    let without_ext = raw.trim_end_matches(".exe");
    let cleaned = without_ext.replace(['_', '-'], " ");
    let mut out = String::new();
    for (idx, part) in cleaned.split_whitespace().enumerate() {
        if idx > 0 {
            out.push(' ');
        }
        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            out.push(first.to_ascii_uppercase());
            out.push_str(chars.as_str());
        }
    }
    if out.is_empty() {
        "Unknown App".to_string()
    } else {
        out
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn run_command_capture(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn parse_first_u32(text: &str) -> Option<u32> {
    let digits: String = text.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse::<u32>().ok()
    }
}

fn process_name_from_path(path: &str) -> Option<String> {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
}

const SECURE_STORE_SERVICE: &str = "com.paracord.app";
const SECURE_STORE_KEY_PREFIX: &str = "paracord:";
const SECURE_STORE_FALLBACK_KEY_FILE: &str = "secure-store-fallback.key";
const SECURE_STORE_FALLBACK_NONCE_LEN: usize = 12;
static ACTIVITY_SHARING_ENABLED: AtomicBool = AtomicBool::new(false);

fn validate_secure_store_key(key: &str) -> Result<(), String> {
    if !key.starts_with(SECURE_STORE_KEY_PREFIX) {
        return Err("secure store key must start with 'paracord:'".into());
    }
    if key.len() > 128 {
        return Err("secure store key is too long".into());
    }
    Ok(())
}

fn secure_store_fallback_key_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let mut dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    dir.push("security");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create security directory: {e}"))?;
    Ok(dir.join(SECURE_STORE_FALLBACK_KEY_FILE))
}

/// Copy a DPAPI output blob into an owned `Vec`, then overwrite the original
/// (DPAPI-allocated) buffer with zeros.
///
/// The original buffer is allocated by DPAPI via `LocalAlloc` and would normally
/// be released with `LocalFree`. `LocalFree`'s generated binding has changed its
/// signature across `windows` crate releases, so to keep this Windows-only path
/// robust we deliberately leak the (small, allocated at most once per secure-store
/// operation) buffer instead. Zeroizing first guarantees no key material lingers
/// in the leaked allocation.
///
/// # Safety
/// `blob.pbData` must either be null or point to `blob.cbData` valid, writable
/// bytes that this function has exclusive access to.
#[cfg(windows)]
unsafe fn take_and_zeroize_dpapi_blob(
    blob: &windows::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB,
) -> Vec<u8> {
    let len = blob.cbData as usize;
    if blob.pbData.is_null() || len == 0 {
        return Vec::new();
    }
    let out = std::slice::from_raw_parts(blob.pbData, len).to_vec();
    std::ptr::write_bytes(blob.pbData, 0, len);
    out
}

/// Protect bytes at rest with Windows DPAPI (`CryptProtectData`) scoped to the
/// current user.
///
/// NOTE: this provides current-user at-rest obfuscation, not keychain-grade
/// protection — any code running as the same Windows user can unprotect the
/// blob. It is used only as a fallback when the OS keychain (Credential Manager)
/// is unavailable.
#[cfg(windows)]
fn dpapi_protect(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    // SAFETY: `in_blob` borrows `plaintext` for the duration of the call. On
    // success DPAPI writes a freshly allocated buffer into `out_blob`, which we
    // copy out and zeroize in `take_and_zeroize_dpapi_blob`.
    unsafe {
        CryptProtectData(
            &in_blob,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
        .map_err(|e| format!("DPAPI protect failed: {e}"))?;
        Ok(take_and_zeroize_dpapi_blob(&out_blob))
    }
}

/// Reverse [`dpapi_protect`]: unprotect a DPAPI blob produced for the current user.
#[cfg(windows)]
fn dpapi_unprotect(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: ciphertext.len() as u32,
        pbData: ciphertext.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    // SAFETY: `in_blob` borrows `ciphertext`; on success DPAPI writes a freshly
    // allocated plaintext buffer into `out_blob`, which we copy out and zeroize
    // in `take_and_zeroize_dpapi_blob`.
    unsafe {
        CryptUnprotectData(
            &in_blob,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
        .map_err(|e| format!("DPAPI unprotect failed: {e}"))?;
        Ok(take_and_zeroize_dpapi_blob(&out_blob))
    }
}

/// Load (or lazily create) the 32-byte AES key that guards secure-store data
/// when the OS keychain is unavailable.
///
/// At-rest protection of the key file is best-effort and platform-dependent:
/// on unix the file is written with `0600` permissions; on Windows it is wrapped
/// with DPAPI (`CryptProtectData`) so it is bound to the current user account.
/// Neither provides keychain-grade protection — this is at-rest obfuscation for
/// the fallback path only.
fn load_or_create_secure_store_fallback_key(app: &tauri::AppHandle) -> Result<[u8; 32], String> {
    let path = secure_store_fallback_key_path(app)?;
    if path.is_file() {
        let stored =
            std::fs::read(&path).map_err(|e| format!("failed to read fallback key: {e}"))?;

        // On Windows the key file is DPAPI-protected. A file that is exactly 32
        // bytes long is an un-protected legacy key (DPAPI output is always
        // larger), so accept it as-is for backward compatibility.
        #[cfg(windows)]
        let existing = if stored.len() == 32 {
            stored
        } else {
            dpapi_unprotect(&stored)?
        };
        #[cfg(not(windows))]
        let existing = stored;

        if existing.len() != 32 {
            return Err("fallback key has invalid length".into());
        }
        let mut key = [0_u8; 32];
        key.copy_from_slice(&existing);
        return Ok(key);
    }

    let mut key = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key);

    // Compute the on-disk representation before creating the file so a failure
    // here does not leave an empty key file behind (`create_new` would then
    // refuse to re-create it on the next run).
    #[cfg(windows)]
    let payload = dpapi_protect(&key)?;

    {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|e| format!("failed to create fallback key: {e}"))?;
        #[cfg(windows)]
        std::io::Write::write_all(&mut file, &payload)
            .map_err(|e| format!("failed to write fallback key: {e}"))?;
        #[cfg(not(windows))]
        std::io::Write::write_all(&mut file, &key)
            .map_err(|e| format!("failed to write fallback key: {e}"))?;
        let _ = file.sync_all();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(key)
}

fn diagnostics_log_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let mut dir = if cfg!(windows) {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            std::path::PathBuf::from(local_app_data)
        } else {
            app.path()
                .app_data_dir()
                .map_err(|e| format!("failed to resolve diagnostics log dir: {e}"))?
        }
    } else {
        app.path()
            .app_log_dir()
            .or_else(|_| app.path().app_data_dir())
            .map_err(|e| format!("failed to resolve diagnostics log dir: {e}"))?
    };
    dir.push("Paracord");
    dir.push("logs");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create diagnostics log dir: {e}"))?;
    dir.push("client-voice.log");
    Ok(dir)
}

#[tauri::command]
pub fn append_client_log(app: tauri::AppHandle, line: String) -> Result<(), String> {
    eprintln!("[client-diag] {line}");
    let path = diagnostics_log_path(&app)?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("failed to open diagnostics log file: {e}"))?;
    writeln!(file, "{line}").map_err(|e| format!("failed to write diagnostics log line: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn get_client_log_path(app: tauri::AppHandle) -> Result<String, String> {
    diagnostics_log_path(&app).map(|p| p.display().to_string())
}

#[tauri::command]
pub fn secure_store_set(key: String, value: String) -> Result<(), String> {
    validate_secure_store_key(&key)?;
    let entry = keyring::Entry::new(SECURE_STORE_SERVICE, &key)
        .map_err(|e| format!("secure store init failed: {e}"))?;
    entry
        .set_password(&value)
        .map_err(|e| format!("secure store write failed: {e}"))
}

#[tauri::command]
pub fn secure_store_get(key: String) -> Result<Option<String>, String> {
    validate_secure_store_key(&key)?;
    let entry = keyring::Entry::new(SECURE_STORE_SERVICE, &key)
        .map_err(|e| format!("secure store init failed: {e}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("secure store read failed: {err}")),
    }
}

#[tauri::command]
pub fn secure_store_delete(key: String) -> Result<(), String> {
    validate_secure_store_key(&key)?;
    let entry = keyring::Entry::new(SECURE_STORE_SERVICE, &key)
        .map_err(|e| format!("secure store init failed: {e}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("secure store delete failed: {err}")),
    }
}

#[tauri::command]
pub fn secure_store_fallback_encrypt(
    app: tauri::AppHandle,
    plaintext: String,
) -> Result<String, String> {
    let key = load_or_create_secure_store_fallback_key(&app)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "invalid fallback key".to_string())?;
    let mut nonce_bytes = [0_u8; SECURE_STORE_FALLBACK_NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|_| "fallback encryption failed".to_string())?;

    let mut payload = Vec::with_capacity(SECURE_STORE_FALLBACK_NONCE_LEN + ciphertext.len());
    payload.extend_from_slice(&nonce_bytes);
    payload.extend_from_slice(&ciphertext);
    Ok(BASE64_STANDARD.encode(payload))
}

#[tauri::command]
pub fn secure_store_fallback_decrypt(
    app: tauri::AppHandle,
    payload: String,
) -> Result<String, String> {
    let key = load_or_create_secure_store_fallback_key(&app)?;
    let decoded = BASE64_STANDARD
        .decode(payload.as_bytes())
        .map_err(|_| "fallback payload is not valid base64".to_string())?;
    if decoded.len() <= SECURE_STORE_FALLBACK_NONCE_LEN {
        return Err("fallback payload is invalid".into());
    }

    let nonce = Nonce::from_slice(&decoded[..SECURE_STORE_FALLBACK_NONCE_LEN]);
    let ciphertext = &decoded[SECURE_STORE_FALLBACK_NONCE_LEN..];
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "invalid fallback key".to_string())?;
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "fallback decryption failed".to_string())?;

    String::from_utf8(plaintext).map_err(|_| "fallback plaintext is not valid utf-8".to_string())
}

#[tauri::command]
pub fn set_activity_sharing_enabled(enabled: bool) {
    ACTIVITY_SHARING_ENABLED.store(enabled, Ordering::SeqCst);
}

#[cfg(windows)]
fn get_window_title(hwnd: windows::Win32::Foundation::HWND) -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextLengthW, GetWindowTextW};

    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return None;
        }
        let mut buffer = vec![0u16; len as usize + 1];
        let copied = GetWindowTextW(hwnd, &mut buffer);
        if copied <= 0 {
            return None;
        }
        let title = String::from_utf16_lossy(&buffer[..copied as usize])
            .trim()
            .to_string();
        if title.is_empty() {
            None
        } else {
            Some(title)
        }
    }
}

#[cfg(windows)]
fn get_process_executable_path(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_core::PWSTR;

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = vec![0u16; 32768];
        let mut len = buffer.len() as u32;
        let success = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            PWSTR(buffer.as_mut_ptr()),
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !success || len == 0 {
            return None;
        }
        let value = String::from_utf16_lossy(&buffer[..len as usize])
            .trim()
            .to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    }
}

/// How long a foreground probe is reused before `osascript` is invoked again.
/// The renderer polls on a short interval; without this each poll would spawn
/// an `osascript` process, which is comparatively expensive to launch.
#[cfg(target_os = "macos")]
const MACOS_FOREGROUND_CACHE_TTL: std::time::Duration = std::time::Duration::from_millis(500);

#[cfg(target_os = "macos")]
fn detect_foreground_application_macos() -> Option<ForegroundApplication> {
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;

    // Short-lived cache so a burst of polls reuses a single probe. Storing the
    // full `Option` (including a `None` result) means "no foreground app" is
    // cached too, not just successful probes.
    static CACHE: OnceLock<Mutex<Option<(Instant, Option<ForegroundApplication>)>>> =
        OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));

    if let Ok(guard) = cache.lock() {
        if let Some((fetched_at, cached)) = guard.as_ref() {
            if fetched_at.elapsed() < MACOS_FOREGROUND_CACHE_TTL {
                return cached.clone();
            }
        }
    }

    let fresh = probe_foreground_application_macos();

    if let Ok(mut guard) = cache.lock() {
        *guard = Some((Instant::now(), fresh.clone()));
    }

    fresh
}

/// Run a single `osascript` pass that returns the frontmost process name, its
/// unix pid, and the front-window title (newline-separated, in that order),
/// collapsing what used to be three separate `osascript` launches into one.
#[cfg(target_os = "macos")]
fn probe_foreground_application_macos() -> Option<ForegroundApplication> {
    let combined = run_command_capture(
        "osascript",
        &[
            "-e",
            "tell application \"System Events\"",
            "-e",
            "set frontApp to first application process whose frontmost is true",
            "-e",
            "set appName to name of frontApp",
            "-e",
            "set appPid to (unix id of frontApp) as text",
            "-e",
            "set winName to \"\"",
            "-e",
            "try",
            "-e",
            "set winName to name of front window of frontApp",
            "-e",
            "end try",
            "-e",
            "end tell",
            "-e",
            "return appName & linefeed & appPid & linefeed & winName",
        ],
    )?;

    // `splitn(3, ..)` keeps the (rare) case of a newline inside a window title
    // intact by treating everything past the second newline as the title.
    let mut lines = combined.splitn(3, '\n');
    let app_name = lines
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let pid = lines.next().and_then(parse_first_u32)?;
    let window_title = lines
        .next()
        .map(|title| title.trim().to_string())
        .filter(|title| !title.is_empty());

    if pid == std::process::id() {
        return None;
    }

    let executable_path = run_command_capture("ps", &["-p", &pid.to_string(), "-o", "comm="]);
    let process_name = executable_path
        .as_ref()
        .and_then(|path| process_name_from_path(path))
        .unwrap_or_else(|| app_name.clone());

    if process_name.to_lowercase().contains("paracord") {
        return None;
    }

    Some(ForegroundApplication {
        pid,
        process_name,
        display_name: app_name,
        executable_path,
        window_title,
    })
}

#[cfg(target_os = "linux")]
fn parse_xprop_string_value(raw: &str) -> Option<String> {
    if let Some(first_quote) = raw.find('"') {
        let rest = &raw[first_quote + 1..];
        if let Some(last_quote) = rest.rfind('"') {
            let value = rest[..last_quote].trim().to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }

    raw.split('=')
        .nth(1)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Outcome of a Linux foreground-window probe. `Unsupported` is deliberately
/// distinct from `NoApp`: xprop can only see X11 windows, so on a Wayland
/// session it would silently report "nothing" even when an app is focused.
/// Distinguishing the two lets the caller skip the (futile) xprop shell-outs and
/// surface the limitation instead of pretending nothing is focused.
#[cfg(target_os = "linux")]
enum LinuxForegroundProbe {
    Detected(ForegroundApplication),
    NoApp,
    Unsupported,
}

/// Whether the current session is Wayland, in which case xprop-based foreground
/// detection cannot work. Split from environment reads so it is unit-testable.
#[cfg(target_os = "linux")]
fn is_wayland_session(session_type: Option<&str>, wayland_display: Option<&str>) -> bool {
    if session_type.is_some_and(|value| value.eq_ignore_ascii_case("wayland")) {
        return true;
    }
    // Some compositors leave XDG_SESSION_TYPE unset but always export the
    // Wayland socket name.
    wayland_display.is_some_and(|value| !value.is_empty())
}

#[cfg(target_os = "linux")]
fn detect_foreground_application_linux() -> LinuxForegroundProbe {
    if is_wayland_session(
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
    ) {
        return LinuxForegroundProbe::Unsupported;
    }

    // X11 path via xprop.
    let Some(active_window_raw) = run_command_capture("xprop", &["-root", "_NET_ACTIVE_WINDOW"])
    else {
        return LinuxForegroundProbe::NoApp;
    };
    let Some(window_id) = active_window_raw
        .split_whitespace()
        .last()
        .map(|token| token.trim().to_string())
    else {
        return LinuxForegroundProbe::NoApp;
    };
    if window_id == "0x0" {
        return LinuxForegroundProbe::NoApp;
    }

    let Some(pid) =
        run_command_capture("xprop", &["-id", &window_id, "_NET_WM_PID"]).and_then(|raw| {
            let pid = parse_first_u32(&raw)?;
            (pid != 0 && pid != std::process::id()).then_some(pid)
        })
    else {
        return LinuxForegroundProbe::NoApp;
    };

    let window_title = run_command_capture("xprop", &["-id", &window_id, "_NET_WM_NAME"])
        .and_then(|raw| parse_xprop_string_value(&raw))
        .or_else(|| {
            run_command_capture("xprop", &["-id", &window_id, "WM_NAME"])
                .and_then(|raw| parse_xprop_string_value(&raw))
        });

    let executable_path = std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .map(|path| path.to_string_lossy().to_string());
    let process_name = executable_path
        .as_ref()
        .and_then(|path| process_name_from_path(path))
        .or_else(|| std::fs::read_to_string(format!("/proc/{pid}/comm")).ok())
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| format!("pid-{pid}"));

    if process_name.to_lowercase().contains("paracord") {
        return LinuxForegroundProbe::NoApp;
    }

    LinuxForegroundProbe::Detected(ForegroundApplication {
        pid,
        display_name: readable_process_name(&process_name),
        process_name,
        executable_path,
        window_title,
    })
}

#[tauri::command]
pub fn get_foreground_application() -> Option<ForegroundApplication> {
    if !ACTIVITY_SHARING_ENABLED.load(Ordering::SeqCst) {
        return None;
    }

    #[cfg(windows)]
    {
        use windows::Win32::System::Threading::GetCurrentProcessId;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowThreadProcessId,
        };

        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() {
                return None;
            }

            let mut pid = 0u32;
            let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 || pid == GetCurrentProcessId() {
                return None;
            }

            let executable_path = get_process_executable_path(pid);
            let process_name = executable_path
                .as_ref()
                .and_then(|path| process_name_from_path(path))
                .unwrap_or_else(|| format!("pid-{}", pid));

            if process_name.to_lowercase().contains("paracord") {
                return None;
            }

            return Some(ForegroundApplication {
                pid,
                display_name: readable_process_name(&process_name),
                process_name,
                executable_path,
                window_title: get_window_title(hwnd),
            });
        }
    }

    #[cfg(target_os = "macos")]
    {
        detect_foreground_application_macos()
    }

    #[cfg(target_os = "linux")]
    {
        match detect_foreground_application_linux() {
            LinuxForegroundProbe::Detected(app) => Some(app),
            LinuxForegroundProbe::NoApp => None,
            LinuxForegroundProbe::Unsupported => {
                // Log the limitation once rather than on every poll: on Wayland
                // there is no portable way to read the focused window, so
                // activity detection is unavailable there.
                static WARNED: AtomicBool = AtomicBool::new(false);
                if !WARNED.swap(true, Ordering::Relaxed) {
                    tracing::info!(
                        "foreground application detection is unsupported on Wayland; activity sharing will report no app"
                    );
                }
                None
            }
        }
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::is_wayland_session;

    #[test]
    fn wayland_detected_via_session_type() {
        assert!(is_wayland_session(Some("wayland"), None));
        assert!(is_wayland_session(Some("Wayland"), None));
    }

    #[test]
    fn wayland_detected_via_display_socket() {
        assert!(is_wayland_session(None, Some("wayland-0")));
        // Session type wins even when it disagrees with an empty socket var.
        assert!(is_wayland_session(Some("wayland"), Some("")));
    }

    #[test]
    fn x11_session_is_not_wayland() {
        assert!(!is_wayland_session(Some("x11"), None));
        assert!(!is_wayland_session(None, None));
        assert!(!is_wayland_session(Some("tty"), Some("")));
    }
}
