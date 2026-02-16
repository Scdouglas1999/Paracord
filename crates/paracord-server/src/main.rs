use anyhow::{Context, Result};
use axum::response::IntoResponse;
use clap::Parser;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing_subscriber::EnvFilter;

mod cli;
mod config;
#[cfg(feature = "embed-ui")]
mod embedded_ui;
mod livekit_proc;
mod tls;
mod upnp;

#[derive(Clone, Default)]
struct AtRestRuntimeProfile {
    sqlite_key_hex: Option<String>,
    file_cryptor: Option<paracord_util::at_rest::FileCryptor>,
}

fn map_db_engine(engine: config::DatabaseEngine) -> paracord_db::DatabaseEngine {
    match engine {
        config::DatabaseEngine::Sqlite => paracord_db::DatabaseEngine::Sqlite,
        config::DatabaseEngine::Postgres => paracord_db::DatabaseEngine::Postgres,
    }
}

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
    if config.tls.acme.enabled && !config.tls.enabled {
        tracing::warn!(
            "tls.acme.enabled is true while tls.enabled is false; ACME automation will be inactive"
        );
    }
    let at_rest_profile = build_at_rest_profile(&config)?;
    if livekit_credentials_look_insecure(&config.livekit.api_key, &config.livekit.api_secret) {
        if config.server.public_url.is_some() {
            anyhow::bail!(
                "Refusing to start with insecure LiveKit credentials when public_url is configured. Set strong [livekit] api_key/api_secret values first."
            );
        }
        tracing::warn!(
            "LiveKit credentials appear insecure. This is acceptable only for local development."
        );
    }

    // ── Auto-create data directories ─────────────────────────────────────────
    ensure_data_dirs(&config);

    // ── Windows firewall auto-allow ──────────────────────────────────────────
    #[cfg(target_os = "windows")]
    if config.network.windows_firewall_auto_allow {
        ensure_firewall_rule();
    } else {
        tracing::info!(
            "Windows firewall auto-rule creation is disabled. Set network.windows_firewall_auto_allow=true to enable."
        );
    }

    // CLI --web-dir overrides config file
    let web_dir: Option<PathBuf> = args
        .web_dir
        .or(config.server.web_dir.clone())
        .map(PathBuf::from)
        .filter(|p| {
            if p.is_dir() {
                true
            } else {
                tracing::warn!(
                    "Web UI directory {:?} does not exist, skipping static file serving",
                    p
                );
                false
            }
        });
    std::env::set_var("PARACORD_SERVER_NAME", config.server.server_name.clone());
    if let Some(public_url) = &config.server.public_url {
        std::env::set_var("PARACORD_PUBLIC_URL", public_url);
    }
    std::env::set_var(
        "PARACORD_FEDERATION_ENABLED",
        if config.federation.enabled {
            "true"
        } else {
            "false"
        },
    );
    match &config.federation.domain {
        Some(domain) => std::env::set_var("PARACORD_FEDERATION_DOMAIN", domain),
        None => std::env::remove_var("PARACORD_FEDERATION_DOMAIN"),
    }
    std::env::set_var(
        "PARACORD_FEDERATION_ALLOW_DISCOVERY",
        if config.federation.allow_discovery {
            "true"
        } else {
            "false"
        },
    );
    let federation_signing_key_hex: Option<String> = if config.federation.enabled {
        let key_path = config
            .federation
            .signing_key_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("./data/federation_signing_key.hex");
        let key_hex = ensure_federation_signing_key_file(key_path)?;
        // Still set the env var for backward compat with any code that reads it,
        // but the primary path now goes through AppState.federation_service.
        std::env::set_var("PARACORD_FEDERATION_SIGNING_KEY_HEX", &key_hex);
        Some(key_hex)
    } else {
        std::env::remove_var("PARACORD_FEDERATION_SIGNING_KEY_HEX");
        None
    };

    // Parse the server's bind port and choose the public signaling/media port.
    let bind_port: u16 = config
        .server
        .bind_address
        .rsplit(':')
        .next()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let tls_port = config.tls.port;

    let livekit_port: u16 = config
        .livekit
        .url
        .rsplit(':')
        .next()
        .and_then(|s| s.trim_end_matches('/').parse().ok())
        .unwrap_or(7880);
    let tls_preferred = config.tls.enabled;
    // In HTTPS mode the browser is redirected to tls_port, so expose WebRTC
    // UDP/TURN on that same public port to avoid "WS upgrade succeeds but
    // media join times out" failures when only HTTPS is reachable.
    let public_signal_port = if tls_preferred { tls_port } else { bind_port };

    // UPnP auto port forwarding + public IP detection
    let mut upnp_server_port = public_signal_port;
    let mut upnp_livekit_port = livekit_port;
    let mut upnp_status = "Disabled".to_string();
    let mut needs_manual_forwarding = false;
    let mut detected_external_ip: Option<String> = None;
    if config.network.upnp && !config.network.upnp_confirm_exposure {
        tracing::warn!(
            "UPnP is configured but disabled until network.upnp_confirm_exposure=true is set explicitly."
        );
    }

    if config.network.upnp && config.network.upnp_confirm_exposure {
        match upnp::setup_upnp(
            public_signal_port,
            livekit_port,
            config.network.upnp_lease_seconds,
        )
        .await
        {
            Ok(result) => {
                upnp_server_port = result.server_port;
                upnp_livekit_port = result.livekit_port;
                let ip = result.external_ip;

                // Auto-configure public URLs if not explicitly set
                if config.server.public_url.is_none() {
                    let scheme = if tls_preferred { "https" } else { "http" };
                    let public_port = if tls_preferred {
                        config.tls.port
                    } else {
                        upnp_server_port
                    };
                    let url = format!("{scheme}://{}:{}", ip, public_port);
                    config.server.public_url = Some(url);
                }
                if config.livekit.public_url.is_none() {
                    // Route LiveKit through the main server's /livekit proxy
                    // so only one port needs to be exposed.
                    let ws_scheme = if tls_preferred { "wss" } else { "ws" };
                    let proxy_port = if tls_preferred {
                        config.tls.port
                    } else {
                        upnp_server_port
                    };
                    let url = format!("{ws_scheme}://{}:{}/livekit", ip, proxy_port);
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
    if config.network.upnp
        && config.tls.enabled
        && detected_external_ip.is_some()
        && upnp_server_port != tls_port
    {
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
            upnp_server_port,
            detected_external_ip.as_deref(),
            detected_local_ip.as_deref(),
        )
        .await
        {
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

    let db_engine = map_db_engine(config.database.engine);
    let pg_options = paracord_db::PgConnectOptions {
        statement_timeout_secs: config.database.statement_timeout_secs,
        idle_in_transaction_timeout_secs: config.database.idle_in_transaction_timeout_secs,
    };
    let db = paracord_db::create_pool_full(
        &config.database.url,
        config.database.max_connections,
        Some(db_engine),
        at_rest_profile.sqlite_key_hex.clone(),
        Some(pg_options),
    )
    .await
    .map_err(|e| {
        if matches!(db_engine, paracord_db::DatabaseEngine::Postgres) {
            anyhow::anyhow!(
                "Failed to connect to PostgreSQL at '{}': {}. \
                 Check that the server is running, credentials are correct, \
                 and the database exists. For SSL connections, append ?sslmode=require to the URL.",
                config.database.url,
                e
            )
        } else {
            anyhow::anyhow!("{}", e)
        }
    })?;
    paracord_db::run_migrations_for_engine(&db, db_engine)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to run {} migrations: {}", db_engine.as_str(), e))?;

    // Clear stale voice states from the database. After a server restart no
    // client is actually connected to a LiveKit room, so any leftover rows
    // are ghosts from a previous process.
    match paracord_db::voice_states::clear_all_voice_states(&db).await {
        Ok(n) if n > 0 => {
            tracing::info!("Cleared {} stale voice state(s) from previous session", n)
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("Failed to clear stale voice states: {}", e),
    }

    // ── Load runtime settings from database ─────────────────────────────────
    let runtime = load_runtime_settings(&db).await;
    let runtime = Arc::new(RwLock::new(runtime));

    // Create LiveKit config for the media layer
    // On Windows, "localhost" can resolve to IPv6 [::1] which may hang if
    // LiveKit only listens on IPv4.  Normalise to 127.0.0.1 for reliability.
    let livekit_config = Arc::new(paracord_media::LiveKitConfig {
        api_key: config.livekit.api_key.clone(),
        api_secret: config.livekit.api_secret.clone(),
        url: config.livekit.url.replace("://localhost:", "://127.0.0.1:"),
        http_url: config
            .livekit
            .http_url
            .replace("://localhost:", "://127.0.0.1:"),
    });

    // Verify LiveKit admin API credentials match the running instance.
    if livekit_reachable {
        match livekit_config.check_health().await {
            Ok(()) => tracing::info!("LiveKit admin API health check passed"),
            Err(e) => {
                tracing::error!("==========================================================");
                tracing::error!("  LiveKit admin API health check FAILED!");
                tracing::error!("  {}", e);
                tracing::error!("");
                tracing::error!("  Voice features will be unreliable until this is resolved.");
                tracing::error!("  Check that [livekit] api_key and api_secret in your");
                tracing::error!("  config match the running LiveKit server's keys.");
                tracing::error!("==========================================================");
            }
        }
    }

    let voice = Arc::new(paracord_media::VoiceManager::new(livekit_config));
    let storage = Arc::new(paracord_media::StorageManager::new(
        paracord_media::StorageConfig {
            base_path: config.media.storage_path.clone().into(),
            max_file_size: config.media.max_file_size,
            p2p_threshold: config.media.p2p_threshold,
            allowed_extensions: None,
        },
    ));

    // Initialize pluggable storage backend (local or S3).
    let s3_cfg = if config.storage.storage_type == "s3" {
        Some(&config.s3)
    } else {
        None
    };
    let storage_backend = Arc::new(
        paracord_media::create_storage_backend(
            &config.storage.storage_type,
            &config.storage.path,
            s3_cfg,
        )
        .await
        .context("Failed to initialize storage backend")?,
    );

    // Resolve the public LiveKit URL — default to the /livekit proxy on our port
    let livekit_public_url = config.livekit.public_url.clone().unwrap_or_else(|| {
        // Use the main server's /livekit proxy so clients only need one port
        let bind = &config.server.bind_address;
        let bind_for_clients = if bind.starts_with("0.0.0.0:") {
            bind.replacen("0.0.0.0", "localhost", 1)
        } else if bind.starts_with("[::]:") {
            bind.replacen("[::]", "localhost", 1)
        } else {
            bind.to_string()
        };
        let ws_scheme = if tls_preferred { "wss" } else { "ws" };
        format!("{ws_scheme}://{}/livekit", bind_for_clients)
    });

    if let Some(public_url) = &config.server.public_url {
        std::env::set_var("PARACORD_PUBLIC_URL", public_url);
    }

    let shutdown_notify = Arc::new(tokio::sync::Notify::new());

    // Build a pre-initialized FederationService so routes don't re-parse
    // environment variables on every request.
    let federation_service = if config.federation.enabled {
        let signing_key = federation_signing_key_hex
            .as_deref()
            .and_then(|hex| paracord_federation::signing::signing_key_from_hex(hex).ok());
        let fed_domain = config
            .federation
            .domain
            .clone()
            .unwrap_or_else(|| config.server.server_name.clone());
        Some(paracord_federation::FederationService::new(
            paracord_federation::FederationConfig {
                enabled: true,
                server_name: config.server.server_name.clone(),
                domain: fed_domain,
                key_id: "ed25519:auto".to_string(),
                signing_key,
                allow_discovery: config.federation.allow_discovery,
            },
        ))
    } else {
        None
    };

    let state = paracord_core::AppState {
        db,
        event_bus: paracord_core::events::EventBus::default(),
        runtime,
        shutdown: shutdown_notify.clone(),
        config: paracord_core::AppConfig {
            jwt_secret: config.auth.jwt_secret.clone(),
            jwt_expiry_seconds: config.auth.jwt_expiry_seconds,
            registration_enabled: config.auth.registration_enabled,
            allow_username_login: config.auth.allow_username_login,
            require_email: config.auth.require_email,
            storage_path: config.storage.path.clone(),
            max_upload_size: config.storage.max_upload_size,
            livekit_api_key: config.livekit.api_key.clone(),
            livekit_api_secret: config.livekit.api_secret.clone(),
            livekit_url: config.livekit.url.clone(),
            livekit_http_url: config
                .livekit
                .http_url
                .replace("://localhost:", "://127.0.0.1:"),
            livekit_public_url,
            livekit_available: livekit_reachable,
            public_url: config.server.public_url.clone(),
            media_storage_path: config.media.storage_path.clone(),
            media_max_file_size: config.media.max_file_size,
            media_p2p_threshold: config.media.p2p_threshold,
            file_cryptor: at_rest_profile.file_cryptor.clone(),
            backup_dir: config.backup.backup_dir.clone(),
            database_url: config.database.url.clone(),
            federation_max_events_per_peer_per_minute: config
                .federation
                .max_events_per_peer_per_minute,
            federation_max_user_creates_per_peer_per_hour: config
                .federation
                .max_user_creates_per_peer_per_hour,
        },
        voice,
        storage,
        storage_backend,
        online_users: Arc::new(tokio::sync::RwLock::new(std::collections::HashSet::new())),
        user_presences: Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new())),
        permission_cache: paracord_core::build_permission_cache(),
        federation_service,
    };

    paracord_api::install_rate_limit_backend(state.db.clone());

    spawn_pending_attachment_cleanup(
        state.db.clone(),
        state.storage_backend.clone(),
        shutdown_notify.clone(),
    );
    spawn_retention_jobs(
        state.db.clone(),
        state.storage_backend.clone(),
        config.retention.clone(),
        shutdown_notify.clone(),
    );
    spawn_auto_backup(
        config.backup.clone(),
        config.database.url.clone(),
        config.storage.path.clone(),
        config.media.storage_path.clone(),
        shutdown_notify.clone(),
    );
    spawn_federation_delivery_worker(state.clone(), shutdown_notify.clone());

    let router = paracord_api::build_router()
        .merge(paracord_ws::gateway_router())
        .with_state(state);

    // ── Web UI serving ───────────────────────────────────────────────────────
    let web_ui_status;
    let app = if let Some(ref dir) = web_dir {
        let index_path = dir.join("index.html");
        let spa_fallback = tower_http::services::ServeFile::new(&index_path);
        let serve_dir = tower_http::services::ServeDir::new(dir).not_found_service(spa_fallback);
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
        )
        .await
        {
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
    std::env::set_var(
        "PARACORD_TLS_ENABLED",
        if tls_rustls_config.is_some() {
            "true"
        } else {
            "false"
        },
    );

    if let Some(ref rustls_config) = tls_rustls_config {
        tls::spawn_acme_renewal_task(
            config.tls.clone(),
            rustls_config.clone(),
            shutdown_notify.clone(),
        );
    }

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
        upnp_server_port,
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
            if tls_enabled && upnp_server_port != tls_port {
                upnp::cleanup_extra_port(tls_port).await;
            }
        }
    };

    if let Some(rustls_config) = tls_rustls_config {
        // Run HTTP redirect + HTTPS concurrently.
        // HTTPS listener injects X-Forwarded-Proto so downstream handlers
        // return secure URLs (wss://, HSTS, etc.).
        let tls_addr: std::net::SocketAddr = format!("0.0.0.0:{}", tls_port).parse()?;
        let app_https = app
            .clone()
            .layer(axum::middleware::from_fn(inject_https_proto));
        let redirect_port = tls_port;
        let tls_redirect_config = config.tls.clone();
        let http_redirect_app = axum::Router::new().fallback(move |req: axum::extract::Request| {
            let tls_redirect_config = tls_redirect_config.clone();
            async move {
                if let Some(challenge) =
                    tls::maybe_serve_acme_http_challenge(&tls_redirect_config, req.uri().path())
                        .await
                {
                    return challenge;
                }
                redirect_to_https(req, redirect_port)
            }
        });

        let http_server = axum::serve(
            listener,
            http_redirect_app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(shutdown_signal_http);

        let https_server = axum_server::bind_rustls(tls_addr, rustls_config)
            .serve(app_https.into_make_service_with_connect_info::<std::net::SocketAddr>());

        tokio::select! {
            result = http_server => { result?; }
            result = https_server => { result?; }
        }
    } else {
        // HTTP only
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(shutdown_signal_http)
        .await?;
    }

    Ok(())
}

/// Ensure all data directories exist before the server starts.
fn ensure_data_dirs(config: &config::Config) {
    // Storage directories
    for dir in [
        &config.storage.path,
        &config.media.storage_path,
        &config.tls.acme.webroot_path,
        &config.backup.backup_dir,
    ] {
        if let Err(e) = std::fs::create_dir_all(dir) {
            tracing::warn!("Could not create directory '{}': {}", dir, e);
        }
    }

    // Database parent directory
    if matches!(config.database.engine, config::DatabaseEngine::Sqlite) {
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
}

fn ensure_federation_signing_key_file(path: &str) -> Result<String> {
    let path = Path::new(path);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).with_context(|| {
                format!(
                    "failed to create federation signing key directory '{}'",
                    parent.display()
                )
            })?;
        }
    }

    if !path.exists() {
        let (key, _) = paracord_federation::signing::generate_keypair();
        let key_hex = paracord_federation::signing::signing_key_to_hex(&key);
        std::fs::write(path, format!("{key_hex}\n")).with_context(|| {
            format!(
                "failed to write federation signing key file '{}'",
                path.display()
            )
        })?;
        harden_secret_file_permissions(path);
        tracing::info!("Generated federation signing key at '{}'", path.display());
        return Ok(key_hex);
    }

    let raw_key = std::fs::read_to_string(path).with_context(|| {
        format!(
            "failed to read federation signing key from '{}'",
            path.display()
        )
    })?;
    let key_hex = raw_key.trim().to_string();
    paracord_federation::signing::signing_key_from_hex(&key_hex).map_err(|_| {
        anyhow::anyhow!(
            "invalid federation signing key at '{}': expected 32-byte ed25519 private key as hex",
            path.display()
        )
    })?;
    harden_secret_file_permissions(path);
    Ok(key_hex)
}

fn harden_secret_file_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(err) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
            tracing::warn!(
                "failed to tighten permissions for '{}': {}",
                path.display(),
                err
            );
        }
    }
    #[cfg(windows)]
    {
        use std::process::Command;

        let path_value = path.display().to_string();
        let principal_output = Command::new("whoami").output();
        match principal_output {
            Ok(output) if output.status.success() => {
                let principal = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !principal.is_empty() {
                    let _ = Command::new("icacls")
                        .args([&path_value, "/inheritance:r"])
                        .status();
                    let _ = Command::new("icacls")
                        .args([&path_value, "/grant:r", &format!("{principal}:F")])
                        .status();
                }
            }
            Ok(_) => {
                tracing::warn!(
                    "failed to resolve current Windows principal for '{}'",
                    path.display()
                );
            }
            Err(err) => {
                tracing::warn!("failed to run whoami for '{}': {}", path.display(), err);
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
        let livekit_name = if cfg!(windows) {
            "livekit-server.exe"
        } else {
            "livekit-server"
        };
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
        .args([
            "advfirewall",
            "firewall",
            "show",
            "rule",
            &format!("name={}", rule_name),
        ])
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
            "advfirewall",
            "firewall",
            "add",
            "rule",
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
        _ => tracing::debug!(
            "Could not add firewall rule '{}' (may need admin rights)",
            rule_name
        ),
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

fn redirect_to_https(req: axum::extract::Request, tls_port: u16) -> axum::response::Response {
    let host = req
        .headers()
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost");
    let normalized_host = normalize_https_host(host, tls_port);
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let location = format!("https://{}{}", normalized_host, path_and_query);
    axum::response::Redirect::permanent(&location).into_response()
}

fn normalize_https_host(host: &str, tls_port: u16) -> String {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return if tls_port == 443 {
            "localhost".to_string()
        } else {
            format!("localhost:{}", tls_port)
        };
    }

    let base = if trimmed.starts_with('[') {
        // IPv6 host header format: [::1]:8080
        if let Some(end) = trimmed.find(']') {
            &trimmed[..=end]
        } else {
            trimmed
        }
    } else {
        trimmed.split(':').next().unwrap_or(trimmed)
    };

    if tls_port == 443 {
        base.to_string()
    } else {
        format!("{}:{}", base, tls_port)
    }
}

fn livekit_credentials_look_insecure(api_key: &str, api_secret: &str) -> bool {
    let key = api_key.trim();
    let secret = api_secret.trim();
    let key_lower = key.to_ascii_lowercase();
    let secret_lower = secret.to_ascii_lowercase();
    if key.is_empty() || secret.is_empty() {
        return true;
    }
    if key_lower == "devkey"
        || key_lower == "paracord_dev"
        || secret_lower == "devsecret"
        || secret_lower == "secret"
        || key_lower.contains("change_me")
        || secret_lower.contains("change_me")
    {
        return true;
    }
    key.len() < 12 || secret.len() < 32
}

fn build_at_rest_profile(config: &config::Config) -> Result<AtRestRuntimeProfile> {
    if !config.at_rest.enabled {
        return Ok(AtRestRuntimeProfile::default());
    }
    let sqlite_db = matches!(config.database.engine, config::DatabaseEngine::Sqlite);
    let encrypt_sqlite = config.at_rest.encrypt_sqlite && sqlite_db;
    if config.at_rest.encrypt_sqlite && !sqlite_db {
        tracing::warn!(
            "at_rest.encrypt_sqlite is enabled but database.engine={} - ignoring SQLite DB encryption setting",
            match config.database.engine {
                config::DatabaseEngine::Sqlite => "sqlite",
                config::DatabaseEngine::Postgres => "postgres",
            }
        );
    }

    if !encrypt_sqlite && !config.at_rest.encrypt_files {
        tracing::warn!(
            "At-rest encryption profile is enabled, but no storage targets are selected"
        );
        return Ok(AtRestRuntimeProfile::default());
    }

    let key_env_name = config.at_rest.key_env.trim();
    if key_env_name.is_empty() {
        anyhow::bail!("at_rest.key_env must not be empty when at-rest encryption is enabled");
    }
    let raw_master_key = std::env::var(key_env_name).with_context(|| {
        format!(
            "at-rest encryption is enabled but env var '{}' is not set",
            key_env_name
        )
    })?;

    let master_key = paracord_util::at_rest::parse_master_key(&raw_master_key)
        .map_err(|err| anyhow::anyhow!("invalid at-rest key in {}: {}", key_env_name, err))?;

    let sqlite_key_hex = if encrypt_sqlite {
        Some(paracord_util::at_rest::derive_sqlite_key_hex(&master_key))
    } else {
        None
    };
    let file_cryptor = if config.at_rest.encrypt_files {
        Some(paracord_util::at_rest::FileCryptor::from_master_key(
            &master_key,
            config.at_rest.allow_plaintext_file_reads,
        ))
    } else {
        None
    };

    tracing::info!(
        "At-rest encryption enabled (sqlite={}, files={}, allow_plaintext_file_reads={})",
        encrypt_sqlite,
        config.at_rest.encrypt_files,
        config.at_rest.allow_plaintext_file_reads
    );

    Ok(AtRestRuntimeProfile {
        sqlite_key_hex,
        file_cryptor,
    })
}

fn spawn_pending_attachment_cleanup(
    db: paracord_db::DbPool,
    backend: Arc<paracord_media::Storage>,
    shutdown: Arc<tokio::sync::Notify>,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = shutdown.notified() => {
                    break;
                }
                _ = interval.tick() => {
                    if let Err(err) = cleanup_pending_attachments_once(&db, &backend).await {
                        tracing::warn!("Pending attachment cleanup failed: {}", err);
                    }
                }
            }
        }
    });
}

async fn cleanup_pending_attachments_once(
    db: &paracord_db::DbPool,
    backend: &paracord_media::Storage,
) -> Result<()> {
    let expired =
        paracord_db::attachments::get_expired_pending_attachments(db, chrono::Utc::now(), 256)
            .await?;
    if expired.is_empty() {
        return Ok(());
    }

    for attachment in expired {
        let ext = std::path::Path::new(&attachment.filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin");
        let storage_key = format!("attachments/{}.{}", attachment.id, ext);
        let _ = backend.delete(&storage_key).await;
        let _ = paracord_db::attachments::delete_attachment(db, attachment.id).await;
    }
    Ok(())
}

fn spawn_federation_delivery_worker(
    state: paracord_core::AppState,
    shutdown: Arc<tokio::sync::Notify>,
) {
    let Some(ref service) = state.federation_service else {
        return;
    };
    if !service.is_enabled() {
        return;
    }
    let service = service.clone();

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                _ = interval.tick() => {
                    service.process_outbound_queue_once(&state.db, 64).await;
                    paracord_api::routes::federation::run_federation_catchup_once(&state, 128, 64)
                        .await;
                    let cutoff = chrono::Utc::now().timestamp_millis() - 86_400_000;
                    let _ = paracord_db::federation::prune_transport_replay_cache(&state.db, cutoff).await;
                }
            }
        }
    });
}

fn spawn_retention_jobs(
    db: paracord_db::DbPool,
    backend: Arc<paracord_media::Storage>,
    retention: config::RetentionConfig,
    shutdown: Arc<tokio::sync::Notify>,
) {
    if !retention.enabled {
        tracing::info!("Retention worker disabled");
        return;
    }

    let interval_seconds = retention.interval_seconds.max(60);
    tracing::info!(
        "Retention worker enabled (interval={}s, batch_size={})",
        interval_seconds,
        retention.batch_size
    );

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(interval_seconds));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = shutdown.notified() => {
                    break;
                }
                _ = interval.tick() => {
                    if let Err(err) = run_retention_once(&db, &backend, &retention).await {
                        tracing::warn!("Retention cleanup failed: {}", err);
                    }
                }
            }
        }
    });
}

async fn run_retention_once(
    db: &paracord_db::DbPool,
    backend: &paracord_media::Storage,
    retention: &config::RetentionConfig,
) -> Result<()> {
    let now = chrono::Utc::now();
    let batch_size = retention.batch_size.clamp(1, 10_000);

    if let Some(cutoff) = retention_cutoff(now, retention.message_days) {
        let deleted = purge_messages_older_than(db, backend, cutoff, batch_size).await?;
        if deleted > 0 {
            tracing::info!("Retention removed {} message(s)", deleted);
        }
    }

    if let Some(cutoff) = retention_cutoff(now, retention.attachment_days) {
        let deleted =
            purge_unlinked_attachments_older_than(db, backend, cutoff, batch_size).await?;
        if deleted > 0 {
            tracing::info!("Retention removed {} unlinked attachment(s)", deleted);
        }
    }

    if let Some(cutoff) = retention_cutoff(now, retention.audit_log_days) {
        let deleted = purge_audit_entries_older_than(db, cutoff, batch_size).await?;
        if deleted > 0 {
            tracing::info!("Retention removed {} audit log entrie(s)", deleted);
        }
    }

    if let Some(cutoff) = retention_cutoff(now, retention.security_event_days) {
        let deleted = purge_security_events_older_than(db, cutoff, batch_size).await?;
        if deleted > 0 {
            tracing::info!("Retention removed {} security event(s)", deleted);
        }
    }

    if let Some(days) = retention.session_days.filter(|d| *d > 0) {
        // Keep session records for a bounded post-expiry period.
        let session_cutoff = now - chrono::Duration::days(days.min(3650));
        let deleted = purge_expired_sessions_older_than(db, session_cutoff, batch_size).await?;
        if deleted > 0 {
            tracing::info!("Retention removed {} expired/revoked session(s)", deleted);
        }
    }

    Ok(())
}

fn retention_cutoff(
    now: chrono::DateTime<chrono::Utc>,
    days: Option<i64>,
) -> Option<chrono::DateTime<chrono::Utc>> {
    days.filter(|d| *d > 0)
        .map(|d| now - chrono::Duration::days(d.min(3650)))
}

async fn purge_messages_older_than(
    db: &paracord_db::DbPool,
    backend: &paracord_media::Storage,
    older_than: chrono::DateTime<chrono::Utc>,
    batch_size: i64,
) -> Result<u64> {
    let mut total_deleted = 0_u64;

    loop {
        let message_ids =
            paracord_db::messages::get_message_ids_older_than(db, older_than, batch_size).await?;
        if message_ids.is_empty() {
            break;
        }

        let attachment_limit = batch_size.saturating_mul(32).clamp(32, 100_000);
        let attachments = paracord_db::attachments::get_attachments_for_message_ids(
            db,
            &message_ids,
            attachment_limit,
        )
        .await?;

        let deleted = paracord_db::messages::delete_messages_by_ids(db, &message_ids).await?;
        total_deleted = total_deleted.saturating_add(deleted);

        for attachment in attachments {
            remove_attachment_file(backend, &attachment).await;
        }

        if (message_ids.len() as i64) < batch_size {
            break;
        }
    }

    Ok(total_deleted)
}

async fn purge_unlinked_attachments_older_than(
    db: &paracord_db::DbPool,
    backend: &paracord_media::Storage,
    older_than: chrono::DateTime<chrono::Utc>,
    batch_size: i64,
) -> Result<u64> {
    let mut total_deleted = 0_u64;

    loop {
        let attachments = paracord_db::attachments::get_unlinked_attachments_older_than(
            db, older_than, batch_size,
        )
        .await?;
        if attachments.is_empty() {
            break;
        }

        for attachment in &attachments {
            paracord_db::attachments::delete_attachment(db, attachment.id).await?;
            remove_attachment_file(backend, attachment).await;
            total_deleted = total_deleted.saturating_add(1);
        }

        if (attachments.len() as i64) < batch_size {
            break;
        }
    }

    Ok(total_deleted)
}

async fn purge_audit_entries_older_than(
    db: &paracord_db::DbPool,
    older_than: chrono::DateTime<chrono::Utc>,
    batch_size: i64,
) -> Result<u64> {
    let mut total_deleted = 0_u64;
    loop {
        let deleted =
            paracord_db::audit_log::purge_entries_older_than(db, older_than, batch_size).await?;
        total_deleted = total_deleted.saturating_add(deleted);
        if deleted < batch_size as u64 {
            break;
        }
    }
    Ok(total_deleted)
}

async fn purge_expired_sessions_older_than(
    db: &paracord_db::DbPool,
    cutoff: chrono::DateTime<chrono::Utc>,
    batch_size: i64,
) -> Result<u64> {
    let mut total_deleted = 0_u64;
    loop {
        let deleted = paracord_db::sessions::purge_expired_sessions(db, cutoff, batch_size).await?;
        total_deleted = total_deleted.saturating_add(deleted);
        if deleted < batch_size as u64 {
            break;
        }
    }
    Ok(total_deleted)
}

async fn purge_security_events_older_than(
    db: &paracord_db::DbPool,
    older_than: chrono::DateTime<chrono::Utc>,
    batch_size: i64,
) -> Result<u64> {
    let mut total_deleted = 0_u64;
    loop {
        let deleted =
            paracord_db::security_events::purge_entries_older_than(db, older_than, batch_size)
                .await?;
        total_deleted = total_deleted.saturating_add(deleted);
        if deleted < batch_size as u64 {
            break;
        }
    }
    Ok(total_deleted)
}

fn attachment_storage_key(attachment: &paracord_db::attachments::AttachmentRow) -> String {
    let ext = std::path::Path::new(&attachment.filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    format!("attachments/{}.{}", attachment.id, ext)
}

async fn remove_attachment_file(
    backend: &paracord_media::Storage,
    attachment: &paracord_db::attachments::AttachmentRow,
) {
    let key = attachment_storage_key(attachment);
    if let Err(err) = backend.delete(&key).await {
        tracing::warn!("Failed deleting attachment file {}: {}", attachment.id, err);
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
        if tls_active && server_port == tls_port {
            println!(
                "  ║  Forward port {:<5} (TCP + UDP) in router to  ║",
                server_port
            );
            println!("  ║  this machine (HTTPS + voice media).           ║");
        } else {
            println!(
                "  ║  Forward port {:<5} (TCP + UDP) in router to  ║",
                server_port
            );
            println!("  ║  this machine. Most routers have this under:     ║");
        }
        if tls_active && server_port != tls_port {
            println!(
                "  ║  and port {:<5} (TCP) for HTTPS.              ║",
                tls_port
            );
        }
        println!("  ║  Settings > Firewall > Port Forwarding           ║");
        println!("  ║                                                  ║");
        println!("  ║  Tip: Enable UPnP in your router settings       ║");
        println!("  ║  to skip this step next time.                    ║");
        println!("  ╚══════════════════════════════════════════════════╝");
    }
    println!();
}

fn spawn_auto_backup(
    backup_config: config::BackupConfig,
    db_url: String,
    storage_path: String,
    media_storage_path: String,
    shutdown: Arc<tokio::sync::Notify>,
) {
    if !backup_config.auto_backup_enabled {
        tracing::info!("Auto-backup disabled");
        return;
    }

    let interval_secs = backup_config.auto_backup_interval_seconds.max(3600);
    let include_media = backup_config.include_media;
    let backup_dir = backup_config.backup_dir.clone();
    let max_backups = backup_config.max_backups;

    tracing::info!(
        "Auto-backup enabled (interval={}s, max_backups={}, include_media={})",
        interval_secs,
        max_backups,
        include_media,
    );

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // Skip the first immediate tick
        interval.tick().await;
        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                _ = interval.tick() => {
                    match paracord_core::backup::create_backup(
                        &db_url,
                        &backup_dir,
                        &storage_path,
                        &media_storage_path,
                        include_media,
                    )
                    .await
                    {
                        Ok(filename) => {
                            tracing::info!("Auto-backup created: {}", filename);
                            // Prune old backups
                            if let Ok(backups) =
                                paracord_core::backup::list_backups(&backup_dir).await
                            {
                                if backups.len() > max_backups as usize {
                                    for old in backups.into_iter().skip(max_backups as usize) {
                                        let path = std::path::Path::new(&backup_dir).join(&old.name);
                                        let _ = tokio::fs::remove_file(path).await;
                                        tracing::info!("Pruned old backup: {}", old.name);
                                    }
                                }
                            }
                        }
                        Err(err) => {
                            tracing::error!("Auto-backup failed: {}", err);
                        }
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_federation_signing_key_file, livekit_credentials_look_insecure, normalize_https_host,
    };

    #[test]
    fn normalizes_https_host_with_custom_port() {
        assert_eq!(
            normalize_https_host("example.com:8080", 8443),
            "example.com:8443"
        );
        assert_eq!(normalize_https_host("[::1]:8080", 8443), "[::1]:8443");
    }

    #[test]
    fn detects_insecure_livekit_credentials() {
        assert!(livekit_credentials_look_insecure("devkey", "devsecret"));
        assert!(!livekit_credentials_look_insecure(
            "paracord_0123456789abcdef",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ));
    }

    #[test]
    fn generates_federation_signing_key_file_when_missing() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let key_path = temp_dir.path().join("federation_signing_key.hex");
        let key_hex =
            ensure_federation_signing_key_file(key_path.to_str().expect("utf8 path")).unwrap();

        assert_eq!(key_hex.len(), 64);
        let stored = std::fs::read_to_string(key_path).expect("stored key");
        assert_eq!(stored.trim(), key_hex);
    }

    #[test]
    fn rejects_invalid_federation_signing_key_file() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let key_path = temp_dir.path().join("invalid.key");
        std::fs::write(&key_path, "not-a-valid-ed25519-key").expect("write invalid key");

        let err = ensure_federation_signing_key_file(key_path.to_str().expect("utf8 path"))
            .expect_err("invalid key should fail");
        assert!(err
            .to_string()
            .contains("invalid federation signing key at"));
    }
}
