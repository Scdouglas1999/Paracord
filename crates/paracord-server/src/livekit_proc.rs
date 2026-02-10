use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::{Child, Command};

/// Handle to a managed LiveKit server process.
pub struct LiveKitProcess {
    child: Child,
    config_path: PathBuf,
}

impl LiveKitProcess {
    pub async fn kill(&mut self) {
        if let Err(e) = self.child.kill().await {
            tracing::warn!("Failed to kill LiveKit process: {}", e);
        } else {
            tracing::info!("LiveKit server stopped.");
        }
        // Clean up temp config
        let _ = std::fs::remove_file(&self.config_path);
    }
}

/// Find the livekit-server binary.
fn find_livekit_binary() -> Option<PathBuf> {
    let exe_name = if cfg!(windows) {
        "livekit-server.exe"
    } else {
        "livekit-server"
    };

    // 1. Same directory as our executable
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let candidate = exe_dir.join(exe_name);
            if candidate.is_file() {
                return Some(candidate);
            }
            // 2. bin/ subdirectory
            let candidate = exe_dir.join("bin").join(exe_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // 3. Current working directory
    let candidate = PathBuf::from(exe_name);
    if candidate.is_file() {
        return Some(candidate);
    }

    // 4. Check PATH via `which`
    if let Ok(path) = which::which(exe_name) {
        return Some(path);
    }

    None
}

/// Generate a minimal LiveKit config YAML and write it to a temp file.
fn write_livekit_config(
    api_key: &str,
    api_secret: &str,
    port: u16,
    external_ip: Option<&str>,
) -> std::io::Result<PathBuf> {
    // If we know the external IP, pin it in the RTC config so LiveKit
    // doesn't rely on STUN (which can fail on Windows).  Also enable
    // the built-in TURN server so clients behind strict NATs can relay
    // media through TCP.
    let turn_port = port + 1;
    let udp_start = port + 2;
    let udp_end = port + 12;

    let mut lines = vec![
        format!("port: {port}"),
        "rtc:".to_string(),
        "    use_external_ip: true".to_string(),
    ];
    if let Some(ip) = external_ip {
        lines.push(format!("    node_ip: {ip}"));
    }
    lines.push(format!("    port_range_start: {udp_start}"));
    lines.push(format!("    port_range_end: {udp_end}"));
    lines.push(format!("    tcp_port: {turn_port}"));
    lines.push("keys:".to_string());
    lines.push(format!("    {api_key}: {api_secret}"));
    if let Some(ip) = external_ip {
        lines.push("turn:".to_string());
        lines.push("    enabled: true".to_string());
        lines.push(format!("    domain: {ip}"));
        lines.push("    tls_port: 0".to_string());
        lines.push(format!("    udp_port: {turn_port}"));
        lines.push("    external_tls: false".to_string());
    }
    lines.push("logging:".to_string());
    lines.push("    level: info".to_string());
    let config = lines.join("\n") + "\n";

    let dir = std::env::temp_dir();
    let path = dir.join("paracord-livekit.yaml");
    std::fs::write(&path, config)?;
    Ok(path)
}

/// Try to start a managed LiveKit server process.
///
/// Returns `Some(LiveKitProcess)` if successful, `None` if the binary wasn't found
/// or couldn't be started.
pub async fn start_livekit(
    api_key: &str,
    api_secret: &str,
    port: u16,
    external_ip: Option<&str>,
) -> Option<LiveKitProcess> {
    let binary = match find_livekit_binary() {
        Some(path) => {
            tracing::info!("Found LiveKit binary at: {}", path.display());
            path
        }
        None => {
            tracing::warn!("==========================================================");
            tracing::warn!("  LiveKit server binary not found!");
            tracing::warn!("  Voice/video chat will not work without LiveKit.");
            tracing::warn!("");
            tracing::warn!("  Download it from: https://github.com/livekit/livekit/releases");
            tracing::warn!("  Place the binary next to the paracord-server executable.");
            tracing::warn!("==========================================================");
            return None;
        }
    };

    let config_path = match write_livekit_config(api_key, api_secret, port, external_ip) {
        Ok(path) => path,
        Err(e) => {
            tracing::error!("Failed to write LiveKit config: {}", e);
            return None;
        }
    };

    // Check if something is already listening on the LiveKit port
    if tokio::net::TcpStream::connect(format!("127.0.0.1:{}", port))
        .await
        .is_ok()
    {
        tracing::info!("LiveKit already running on port {}, skipping managed start", port);
        let _ = std::fs::remove_file(&config_path);
        return None;
    }

    tracing::info!("Starting managed LiveKit server on port {}...", port);

    let child = match Command::new(&binary)
        .arg("--config")
        .arg(&config_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            tracing::error!("Failed to start LiveKit: {}", e);
            let _ = std::fs::remove_file(&config_path);
            return None;
        }
    };

    // Give LiveKit a moment to start — needs time to bind ports and init
    tokio::time::sleep(std::time::Duration::from_secs(4)).await;

    tracing::info!("Managed LiveKit server started (PID: {})",
        child.id().map(|id| id.to_string()).unwrap_or_else(|| "unknown".into()));

    Some(LiveKitProcess { child, config_path })
}
