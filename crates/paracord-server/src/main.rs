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
mod upnp;

#[tokio::main]
async fn main() -> Result<()> {
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
            detected_external_ip.as_deref(),
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
            format!("ws://{}/livekit", bind)
        });

    let state = paracord_core::AppState {
        db,
        event_bus: paracord_core::events::EventBus::default(),
        runtime,
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

    // ── Startup banner ───────────────────────────────────────────────────────
    print_startup_banner(
        &config.server.bind_address,
        &config.server.public_url,
        &livekit_status,
        &config.database.url,
        &upnp_status,
        &web_ui_status,
        needs_manual_forwarding,
        bind_port,
    );

    // Graceful shutdown: clean up UPnP on ctrl-c
    let upnp_enabled = config.network.upnp;
    let shutdown_signal = async move {
        let _ = tokio::signal::ctrl_c().await;
        println!();
        tracing::info!("Shutting down...");
        if let Some(mut lk) = managed_livekit {
            lk.kill().await;
        }
        if upnp_enabled {
            upnp::cleanup_upnp(upnp_server_port, upnp_livekit_port).await;
        }
    };

    axum::serve(listener, app.into_make_service())
        .with_graceful_shutdown(shutdown_signal)
        .await?;

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

#[allow(clippy::too_many_arguments)]
fn print_startup_banner(
    bind_address: &str,
    public_url: &Option<String>,
    livekit_status: &str,
    db_url: &str,
    upnp_status: &str,
    web_ui: &str,
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
    if let Some(url) = public_url {
        println!("  Public URL:  {}", url);
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

    if needs_manual_forwarding {
        println!();
        println!("  ╔══════════════════════════════════════════════════╗");
        println!("  ║  ⚠  Port forwarding required for remote access  ║");
        println!("  ║                                                  ║");
        println!("  ║  Forward port {:<5} (TCP) in your router to    ║", server_port);
        println!("  ║  this machine. Most routers have this under:     ║");
        println!("  ║  Settings > Firewall > Port Forwarding           ║");
        println!("  ║                                                  ║");
        println!("  ║  Tip: Enable UPnP in your router settings       ║");
        println!("  ║  to skip this step next time.                    ║");
        println!("  ╚══════════════════════════════════════════════════╝");
    }
    println!();
}
