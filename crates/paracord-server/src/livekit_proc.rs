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

/// Detect the local LAN IP address that routes to the internet.
/// Connects a UDP socket to an external address (doesn't actually send data)
/// and reads back the local address the OS chose.
pub fn detect_local_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    // Connect to a public DNS server — no data is sent, we just need the OS
    // to pick the right outbound interface.
    socket.connect("8.8.8.8:80").ok()?;
    let addr = socket.local_addr().ok()?;
    let ip = addr.ip();
    // Sanity-check: must not be loopback or unspecified
    if ip.is_loopback() || ip.is_unspecified() {
        return None;
    }
    Some(ip.to_string())
}

/// Generate a minimal LiveKit config YAML and write it to a temp file.
///
/// All client-facing traffic shares the single `server_port` (default 8080):
///   - TCP signaling is proxied through the main Paracord HTTP server
///     (`/livekit` WebSocket route).
///   - UDP media uses a UDP mux bound to the same `server_port`.  Since the
///     Paracord HTTP server only binds TCP on that port, LiveKit can bind
///     UDP on the same port number without conflict.  This means the server
///     host only needs to forward **one port** (TCP + UDP) for everything.
///
/// Internal ports (not exposed externally):
///   - `livekit_port` (7880) TCP — LiveKit HTTP API + WS (local only)
///   - `livekit_port + 1` (7881) TCP — ICE/TCP fallback (local only)
fn write_livekit_config(
    api_key: &str,
    api_secret: &str,
    livekit_port: u16,
    server_port: u16,
    external_ip: Option<&str>,
    _local_ip: Option<&str>,
) -> std::io::Result<PathBuf> {
    let mut lines = vec![
        format!("port: {livekit_port}"),
        "rtc:".to_string(),
        "    use_external_ip: true".to_string(),
    ];
    if let Some(ip) = external_ip {
        lines.push(format!("    node_ip: {ip}"));
    }
    // UDP mux on the server port (e.g. 8080).  Paracord only binds TCP
    // on this port, so LiveKit can use the UDP side for all WebRTC media.
    // This means only one port needs to be forwarded by the host.
    lines.push(format!("    udp_port: {server_port}"));
    // Disable ICE/TCP — it would need its own forwarded port and clients
    // behind restrictive NAT will use TURN (UDP) as the fallback instead.
    lines.push("    tcp_port: 0".to_string());
    // Exclude Docker, WSL, and loopback subnets from ICE candidates.
    // Using excludes (instead of includes) avoids interfering with
    // LiveKit's ICE connectivity checks from remote clients.
    lines.push("    ips:".to_string());
    lines.push("        excludes:".to_string());
    lines.push("            - 172.16.0.0/12".to_string());
    lines.push("            - 10.0.0.0/8".to_string());
    lines.push("            - 127.0.0.0/8".to_string());
    lines.push("    enable_loopback_candidate: false".to_string());
    lines.push("keys:".to_string());
    lines.push(format!("    {api_key}: {api_secret}"));
    if let Some(ip) = external_ip {
        // TURN provides relay fallback for clients behind symmetric NAT.
        // The TURN listener shares the server UDP port (already forwarded),
        // and relay allocations use a small port range above the server port.
        // NOTE: these relay ports (server_port+1 through +10) do NOT need
        // to be separately forwarded — TURN relay traffic flows through the
        // TURN server's listener port (server_port) and gets relayed internally.
        lines.push("turn:".to_string());
        lines.push("    enabled: true".to_string());
        lines.push(format!("    domain: {ip}"));
        lines.push("    tls_port: 0".to_string());
        lines.push(format!("    udp_port: {server_port}"));
        lines.push("    external_tls: false".to_string());
        let relay_start = server_port + 1;
        let relay_end = server_port + 10;
        lines.push(format!("    relay_range_start: {relay_start}"));
        lines.push(format!("    relay_range_end: {relay_end}"));
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
    server_port: u16,
    external_ip: Option<&str>,
    local_ip: Option<&str>,
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

    let config_path = match write_livekit_config(api_key, api_secret, port, server_port, external_ip, local_ip) {
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

    // Write LiveKit output to a log file so we can diagnose connection issues.
    let log_path = std::env::temp_dir().join("paracord-livekit.log");
    let (lk_stdout, lk_stderr) = match std::fs::File::create(&log_path) {
        Ok(f) => {
            let f2 = f.try_clone().unwrap_or_else(|_| {
                std::fs::File::create(std::env::temp_dir().join("paracord-livekit-err.log"))
                    .expect("fallback log")
            });
            (Stdio::from(f), Stdio::from(f2))
        }
        Err(_) => (Stdio::null(), Stdio::null()),
    };
    tracing::info!("LiveKit log file: {}", log_path.display());

    let child = match Command::new(&binary)
        .arg("--config")
        .arg(&config_path)
        .stdout(lk_stdout)
        .stderr(lk_stderr)
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
