use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use anyhow::Result;
use clap::Parser;
use tracing_subscriber::EnvFilter;

mod cli;
mod config;
#[cfg(feature = "embed-ui")]
mod embedded_ui;
mod livekit_proc;
mod tls;
mod upnp;

#[tokio::main]
async fn main() -> Result<()> {
    // Install rustls crypto provider before any TLS operations
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("paracord=info,tower_http=debug")),
        )
        .init();

    let args = cli::Args::parse();
    let mut config = config::Config::load(&args.config)?;

    // ── Auto-create data directories ─────────────────────────────────────────
    ensure_data_dirs(&config);

    // ── Windows firewall auto-allow ──────────────────────────────────────────
    #[cfg(target_os = "windows")]
    ensure_firewall_rule();

    // CLI --web-dir overrides config file
    let web_dir: Option<PathBuf> = args
        .web_dir
        .or(config.server.web_dir.clone())
        .map(PathBuf::from)
        .filter(|p| {
            if p.is_dir() {
                true
            } else {
                tracing::warn!("Web UI directory {:?} does not exist, skipping static file serving", p);
                false
            }
        });
    std::env::set_var("PARACORD_SERVER_NAME", config.server.server_name.clone());
    if config.federation.enabled {
        std::env::set_var("PARACORD_FEDERATION_ENABLED", "true");
        if let Some(path) = &config.federation.signing_key_path {
            if let Ok(contents) = std::fs::read_to_string(path) {
                std::env::set_var("PARACORD_FEDERATION_SIGNING_KEY_HEX", contents.trim());
            }
        }
    }

    // Parse the server's bind port for UPnP
    let bind_port: u16 = config
        .server
        .bind_address
        .rsplit(':')
        .next()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);

    let livekit_port: u16 = config
        .livekit
        .url
        .rsplit(':')
        .next()
        .and_then(|s| s.trim_end_matches('/').parse().ok())
        .unwrap_or(7880);

    // UPnP auto port forwarding + public IP detection
    let mut upnp_server_port = bind_port;
    let mut upnp_livekit_port = livekit_port;
    let mut upnp_status = "Disabled".to_string();
    let mut needs_manual_forwarding = false;
    let mut detected_external_ip: Option<String> = None;
    if config.network.upnp {
        match upnp::setup_upnp(bind_port, livekit_port, config.network.upnp_lease_seconds).await {
            Ok(result) => {
                upnp_server_port = result.server_port;
                upnp_livekit_port = result.livekit_port;
                let ip = result.external_ip;

                // Auto-configure public URLs if not explicitly set
                if config.server.public_url.is_none() {
                    let url = format!("http://{}:{}", ip, upnp_server_port);
                    config.server.public_url = Some(url);
                }
                if config.livekit.public_url.is_none() {
                    // Route LiveKit through the main server's /livekit proxy
                    // so only one port needs to be exposed.
                    let url = format!("ws://{}:{}/livekit", ip, upnp_server_port);
                    config.livekit.public_url = Some(url);
                }

                detected_external_ip = Some(ip.to_string());

                if result.method.contains("manual") {
                    needs_manual_forwarding = true;
                    upnp_status = format!("Manual (external IP: {})", ip);
                } else {
                    upnp_status = format!("{} (external IP: {})", result.method, ip);
                }
            }
            Err(e) => {
                tracing::warn!("{}", e);
                upnp_status = "Failed (could not detect external IP)".to_string();
            }
        }
    }

    // Forward HTTPS port via UPnP if TLS is enabled
    let tls_port = config.tls.port;
    if config.network.upnp && config.tls.enabled && detected_external_ip.is_some() {
        upnp::forward_extra_port(tls_port, config.network.upnp_lease_seconds).await;
    }

    // If we still don't have an external IP (UPnP failed or disabled) but
    // LiveKit is local, detect the public IP via HTTP so we can configure
    // LiveKit's ICE candidates correctly for remote users.
    if detected_external_ip.is_none()
        && (config.livekit.url.contains("localhost") || config.livekit.url.contains("127.0.0.1"))
    {
        if let Ok(resp) = reqwest::get("https://api.ipify.org").await {
            if let Ok(text) = resp.text().await {
                let ip = text.trim().to_string();
                if !ip.is_empty() {
                    tracing::info!("Detected external IP via HTTP: {}", ip);
                    detected_external_ip = Some(ip);
                }
            }
        }
    }

    // Detect the local LAN IP for LiveKit ICE candidate filtering.
    // This ensures LiveKit only advertises the real LAN IP (which maps to
    // the public IP) instead of Docker/WSL/loopback addresses.
    let detected_local_ip = livekit_proc::detect_local_ip();
    if let Some(ref lip) = detected_local_ip {
        tracing::info!("Detected local LAN IP: {}", lip);
    }

    // Start managed LiveKit if no external one is configured
    let mut managed_livekit = None;
    let mut livekit_status = "External".to_string();
    let mut livekit_reachable = false;
    if config.livekit.url.contains("localhost") || config.livekit.url.contains("127.0.0.1") {
        // Check if LiveKit is already running on the port (e.g. from a previous server run)
        let already_running = tokio::net::TcpStream::connect(format!("127.0.0.1:{}", livekit_port))
            .await
            .is_ok();

        match livekit_proc::start_livekit(
            &config.livekit.api_key,
            &config.livekit.api_secret,
            livekit_port,
            bind_port,
            detected_external_ip.as_deref(),
            detected_local_ip.as_deref(),
        ).await {
            Some(proc) => {
                livekit_status = format!("Managed (port {})", livekit_port);
                livekit_reachable = true;
                managed_livekit = Some(proc);
            }
            None if already_running => {
                livekit_status = format!("External (port {})", livekit_port);
                livekit_reachable = true;
            }
            None => {
                livekit_status = "Not available (binary not found)".to_string();
            }
        }
    } else {
        // External LiveKit URL configured — assume reachable
        livekit_reachable = true;
    }

    let db = paracord_db::create_pool(&config.database.url, config.database.max_connections).await?;
    paracord_db::run_migrations(&db).await?;

    // Clear stale voice states from the database. After a server restart no
    // client is actually connected to a LiveKit room, so any leftover rows
    // are ghosts from a previous process.
    match paracord_db::voice_states::clear_all_voice_states(&db).await {
        Ok(n) if n > 0 => tracing::info!("Cleared {} stale voice state(s) from previous session", n),
        Ok(_) => {}
        Err(e) => tracing::warn!("Failed to clear stale voice states: {}", e),
    }

    // ── Load runtime settings from database ─────────────────────────────────
    let runtime = load_runtime_settings(&db).await;
    let runtime = Arc::new(RwLock::new(runtime));

    // Create LiveKit config for the media layer
    let livekit_config = Arc::new(paracord_media::LiveKitConfig {
        api_key: config.livekit.api_key.clone(),
        api_secret: config.livekit.api_secret.clone(),
        url: config.livekit.url.clone(),
        http_url: config.livekit.http_url.clone(),
    });

    let voice = Arc::new(paracord_media::VoiceManager::new(livekit_config));
    let storage = Arc::new(paracord_media::StorageManager::new(
        paracord_media::StorageConfig {
            base_path: config.media.storage_path.clone().into(),
            max_file_size: config.media.max_file_size,
            p2p_threshold: config.media.p2p_threshold,
            allowed_extensions: None,
        },
    ));

    // Resolve the public LiveKit URL — default to the /livekit proxy on our port
    let livekit_public_url = config
        .livekit
        .public_url
        .clone()
        .unwrap_or_else(|| {
            // Use the main server's /livekit proxy so clients only need one port
            let bind = &config.server.bind_address;
            let bind_for_clients = if bind.starts_with("0.0.0.0:") {
                bind.replacen("0.0.0.0", "localhost", 1)
            } else if bind.starts_with("[::]:") {
                bind.replacen("[::]", "localhost", 1)
            } else {
                bind.to_string()
            };
            format!("ws://{}/livekit", bind_for_clients)
        });

    let shutdown_notify = Arc::new(tokio::sync::Notify::new());

    let state = paracord_core::AppState {
        db,
        event_bus: paracord_core::events::EventBus::default(),
        runtime,
        shutdown: shutdown_notify.clone(),
        config: paracord_core::AppConfig {
            jwt_secret: config.auth.jwt_secret.clone(),
            jwt_expiry_seconds: config.auth.jwt_expiry_seconds,
            registration_enabled: config.auth.registration_enabled,
            storage_path: config.storage.path.clone(),
            max_upload_size: config.storage.max_upload_size,
            livekit_api_key: config.livekit.api_key.clone(),
            livekit_api_secret: config.livekit.api_secret.clone(),
            livekit_url: config.livekit.url.clone(),
            livekit_http_url: config.livekit.http_url.clone(),
            livekit_public_url,
            livekit_available: livekit_reachable,
            public_url: config.server.public_url.clone(),
            media_storage_path: config.media.storage_path.clone(),
            media_max_file_size: config.media.max_file_size,
            media_p2p_threshold: config.media.p2p_threshold,
        },
        voice,
        storage,
        online_users: Arc::new(tokio::sync::RwLock::new(std::collections::HashSet::new())),
    };

    let router = paracord_api::build_router()
        .merge(paracord_ws::gateway_router())
        .with_state(state);

    // ── Web UI serving ───────────────────────────────────────────────────────
    let web_ui_status;
    let app = if let Some(ref dir) = web_dir {
        let index_path = dir.join("index.html");
        let spa_fallback = tower_http::services::ServeFile::new(&index_path);
        let serve_dir = tower_http::services::ServeDir::new(dir)
            .not_found_service(spa_fallback);
        web_ui_status = format!("Serving from {:?}", dir);
        router.fallback_service(serve_dir)
    } else {
        #[cfg(feature = "embed-ui")]
        {
            web_ui_status = "Embedded".to_string();
            router.merge(embedded_ui::router())
        }
        #[cfg(not(feature = "embed-ui"))]
        {
            web_ui_status = "None (API-only mode)".to_string();
            router
        }
    };

    let listener = tokio::net::TcpListener::bind(&config.server.bind_address).await?;

    // ── TLS / HTTPS setup ───────────────────────────────────────────────────
    let tls_enabled = config.tls.enabled;
    let tls_rustls_config = if tls_enabled {
        match tls::ensure_certs(
            &config.tls,
            detected_external_ip.as_deref(),
            detected_local_ip.as_deref(),
        ).await {
            Ok(cfg) => Some(cfg),
            Err(e) => {
                tracing::warn!("TLS setup failed, HTTPS disabled: {}", e);
                None
            }
        }
    } else {
        None
    };

    let tls_status = if let Some(ref _cfg) = tls_rustls_config {
        format!("Enabled (port {})", tls_port)
    } else if tls_enabled {
        "Failed (see logs)".to_string()
    } else {
        "Disabled".to_string()
    };

    // ── Startup banner ───────────────────────────────────────────────────────
    print_startup_banner(
        &config.server.bind_address,
        &config.server.public_url,
        &livekit_status,
        &config.database.url,
        &upnp_status,
        &web_ui_status,
        &tls_status,
        tls_rustls_config.is_some(),
        tls_port,
        needs_manual_forwarding,
        bind_port,
    );

    // Graceful shutdown: clean up UPnP on ctrl-c or API-triggered restart
    let upnp_enabled = config.network.upnp;
    let shutdown_notify_http = shutdown_notify.clone();
    let shutdown_signal_http = async move {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                println!();
                tracing::info!("Shutting down (ctrl-c)...");
            }
            _ = shutdown_notify_http.notified() => {
                tracing::info!("Shutting down (restart requested via API)...");
            }
        }
        if let Some(mut lk) = managed_livekit {
            lk.kill().await;
        }
        if upnp_enabled {
            upnp::cleanup_upnp(upnp_server_port, upnp_livekit_port).await;
            if tls_enabled {
                upnp::cleanup_extra_port(tls_port).await;
            }
        }
    };

    if let Some(rustls_config) = tls_rustls_config {
        // Run HTTP and HTTPS concurrently.
        // Inject X-Forwarded-Proto so the voice endpoint returns wss:// URLs.
        let tls_addr: std::net::SocketAddr = format!("0.0.0.0:{}", tls_port).parse()?;
        let app_https = app
            .clone()
            .layer(axum::middleware::from_fn(inject_https_proto));

        let http_server = axum::serve(listener, app.into_make_service())
            .with_graceful_shutdown(shutdown_signal_http);

        let https_server = axum_server::bind_rustls(tls_addr, rustls_config)
            .serve(app_https.into_make_service());

        tokio::select! {
            result = http_server => { result?; }
            result = https_server => { result?; }
        }
    } else {
        // HTTP only
        axum::serve(listener, app.into_make_service())
            .with_graceful_shutdown(shutdown_signal_http)
            .await?;
    }

    Ok(())
}

/// Ensure all data directories exist before the server starts.
fn ensure_data_dirs(config: &config::Config) {
    // Storage directories
    for dir in [&config.storage.path, &config.media.storage_path] {
        if let Err(e) = std::fs::create_dir_all(dir) {
            tracing::warn!("Could not create directory '{}': {}", dir, e);
        }
    }

    // Database parent directory
    if let Some(db_path) = config
        .database
        .url
        .strip_prefix("sqlite://")
        .and_then(|s| s.split('?').next())
    {
        if let Some(parent) = std::path::Path::new(db_path).parent() {
            if !parent.as_os_str().is_empty() {
                let _ = std::fs::create_dir_all(parent);
            }
        }
    }
}

async fn load_runtime_settings(db: &paracord_db::DbPool) -> paracord_core::RuntimeSettings {
    let mut settings = paracord_core::RuntimeSettings::default();

    if let Ok(all) = paracord_db::server_settings::get_all_settings(db).await {
        for (key, value) in all {
            match key.as_str() {
                "registration_enabled" => settings.registration_enabled = value == "true",
                "server_name" => settings.server_name = value,
                "server_description" => settings.server_description = value,
                "max_guilds_per_user" => {
                    if let Ok(v) = value.parse() {
                        settings.max_guilds_per_user = v;
                    }
                }
                "max_members_per_guild" => {
                    if let Ok(v) = value.parse() {
                        settings.max_members_per_guild = v;
                    }
                }
                _ => {}
            }
        }
    }

    settings
}

/// On Windows, ensure firewall rules exist so inbound connections are not blocked.
/// Uses `netsh advfirewall` to add allow-rules for the server and LiveKit binaries.
/// Silently ignored if the rules already exist or if the user lacks admin rights.
#[cfg(target_os = "windows")]
fn ensure_firewall_rule() {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return,
    };
    let exe_str = exe.display().to_string();

    // Rule for the main Paracord server (TCP)
    add_windows_firewall_rule("Paracord Server", &exe_str, "TCP");

    // Rules for LiveKit (TCP + UDP for WebRTC media)
    if let Some(exe_dir) = exe.parent() {
        let livekit_name = if cfg!(windows) { "livekit-server.exe" } else { "livekit-server" };
        let livekit_path = exe_dir.join(livekit_name);
        if livekit_path.is_file() {
            let lk_str = livekit_path.display().to_string();
            add_windows_firewall_rule("Paracord LiveKit TCP", &lk_str, "TCP");
            add_windows_firewall_rule("Paracord LiveKit UDP", &lk_str, "UDP");
        }
    }
}

#[cfg(target_os = "windows")]
fn add_windows_firewall_rule(rule_name: &str, program: &str, protocol: &str) {
    // Check if rule already exists
    let check = std::process::Command::new("netsh")
        .args(["advfirewall", "firewall", "show", "rule", &format!("name={}", rule_name)])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();

    if let Ok(status) = check {
        if status.success() {
            return; // Rule already exists
        }
    }

    let result = std::process::Command::new("netsh")
        .args([
            "advfirewall", "firewall", "add", "rule",
            &format!("name={}", rule_name),
            "dir=in",
            "action=allow",
            &format!("program={}", program),
            &format!("protocol={}", protocol),
            "enable=yes",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();

    match result {
        Ok(s) if s.success() => tracing::info!("Windows Firewall rule '{}' added", rule_name),
        _ => tracing::debug!("Could not add firewall rule '{}' (may need admin rights)", rule_name),
    }
}

/// Middleware that injects `X-Forwarded-Proto: https` on requests arriving
/// via the HTTPS listener, so downstream handlers (e.g. voice join) can
/// return `wss://` URLs instead of `ws://`.
async fn inject_https_proto(
    mut req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    req.headers_mut().insert(
        "x-forwarded-proto",
        axum::http::HeaderValue::from_static("https"),
    );
    next.run(req).await
}

#[allow(clippy::too_many_arguments)]
fn print_startup_banner(
    bind_address: &str,
    public_url: &Option<String>,
    livekit_status: &str,
    db_url: &str,
    upnp_status: &str,
    web_ui: &str,
    tls_status: &str,
    tls_active: bool,
    tls_port: u16,
    needs_manual_forwarding: bool,
    server_port: u16,
) {
    println!();
    println!("  ____                                     _");
    println!(" |  _ \\ __ _ _ __ __ _  ___ ___  _ __ __| |");
    println!(" | |_) / _` | '__/ _` |/ __/ _ \\| '__/ _` |");
    println!(" |  __/ (_| | | | (_| | (_| (_) | | | (_| |");
    println!(" |_|   \\__,_|_|  \\__,_|\\___\\___/|_|  \\__,_|");
    println!();
    println!("  Listening:   http://{}", bind_address);
    if tls_active {
        println!("  HTTPS:       https://0.0.0.0:{}", tls_port);
    }
    if let Some(url) = public_url {
        println!("  Public URL:  {}", url);
        if tls_active {
            // Derive an HTTPS public URL from the HTTP one
            if let Some(host) = url.strip_prefix("http://") {
                // Strip the port from the host if present
                let host_no_port = host.split(':').next().unwrap_or(host);
                println!("  Public HTTPS: https://{}:{}", host_no_port, tls_port);
            }
        }
        println!();
        println!("  ╔══════════════════════════════════════════════════╗");
        println!("  ║  Share this with friends: {:<24}║", url);
        println!("  ╚══════════════════════════════════════════════════╝");
    }
    println!();
    println!("  Database:    {}", db_url);
    println!("  LiveKit:     {}", livekit_status);
    println!("  Port Fwd:    {}", upnp_status);
    println!("  Web UI:      {}", web_ui);
    println!("  TLS/HTTPS:   {}", tls_status);

    if needs_manual_forwarding {
        println!();
        println!("  ╔══════════════════════════════════════════════════╗");
        println!("  ║  Port forwarding required for remote access     ║");
        println!("  ║                                                  ║");
        println!("  ║  Forward port {:<5} (TCP + UDP) in router to  ║", server_port);
        if tls_active {
        println!("  ║  and port {:<5} (TCP) for HTTPS.              ║", tls_port);
        }
        println!("  ║  this machine. Most routers have this under:     ║");
        println!("  ║  Settings > Firewall > Port Forwarding           ║");
        println!("  ║                                                  ║");
        println!("  ║  Tip: Enable UPnP in your router settings       ║");
        println!("  ║  to skip this step next time.                    ║");
        println!("  ╚══════════════════════════════════════════════════╝");
    }
    println!();
}
