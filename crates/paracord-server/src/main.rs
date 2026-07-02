#![allow(clippy::collapsible_if, clippy::derivable_impls)]

use anyhow::{Context, Result};
use axum::response::IntoResponse;
use clap::Parser;
use dashmap::{DashMap, DashSet};
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing_subscriber::EnvFilter;

mod bots;
mod cli;
mod config;
#[cfg(feature = "embed-ui")]
mod embedded_ui;
mod livekit_proc;
mod tls;

const PUBLIC_IP_DETECTION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
const PUBLIC_IP_DETECTION_BODY_LIMIT: usize = 128;

fn parse_detected_public_ip(text: &str) -> Option<String> {
    let ip = text.trim();
    if ip.is_empty() || ip.parse::<std::net::IpAddr>().is_err() {
        return None;
    }
    Some(ip.to_string())
}

#[derive(Clone, Default)]
struct AtRestRuntimeProfile {
    sqlite_key_hex: Option<String>,
    file_cryptor: Option<paracord_util::at_rest::FileCryptor>,
    totp_cryptor: Option<paracord_util::at_rest::FileCryptor>,
}

fn map_db_engine(engine: config::DatabaseEngine) -> paracord_db::DatabaseEngine {
    match engine {
        config::DatabaseEngine::Sqlite => paracord_db::DatabaseEngine::Sqlite,
        config::DatabaseEngine::Postgres => paracord_db::DatabaseEngine::Postgres,
    }
}

fn parse_env_bool(name: &str, default: bool) -> bool {
    std::env::var(name)
        .ok()
        .and_then(|raw| match raw.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        })
        .unwrap_or(default)
}

#[tokio::main]
async fn main() -> Result<()> {
    // Install rustls crypto provider before any TLS operations
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    let ansi_default = if cfg!(windows) {
        false
    } else {
        std::io::stderr().is_terminal()
    };
    let use_ansi = parse_env_bool("PARACORD_LOG_ANSI", ansi_default);
    let default_log_filter =
        "paracord=info,paracord_api=info,paracord_server=info,paracord_core=info,tower_http=info,axum=warn,hyper=warn";

    tracing_subscriber::fmt()
        .compact()
        .with_target(false)
        .with_ansi(use_ansi)
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new(default_log_filter)),
        )
        .init();

    let args = cli::Args::parse();
    let config = config::Config::load(&args.config)?;
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

    // Manual port forwarding status (automatic router mapping removed).
    let server_public_port = public_signal_port;
    let bind_is_loopback = config.server.bind_address.starts_with("127.0.0.1:")
        || config.server.bind_address.starts_with("localhost:")
        || config.server.bind_address.starts_with("[::1]:");
    let port_forwarding_status = if bind_is_loopback {
        "N/A (loopback-only bind)".to_string()
    } else {
        "Manual (configure router/firewall for WAN access)".to_string()
    };
    let needs_manual_forwarding = !bind_is_loopback;
    let mut detected_external_ip: Option<String> = None;

    // If we don't yet have an external IP but
    // LiveKit is local, detect the public IP via HTTP so we can configure
    // LiveKit's ICE candidates correctly for remote users.
    if detected_external_ip.is_none()
        && (config.livekit.url.contains("localhost") || config.livekit.url.contains("127.0.0.1"))
    {
        let public_ip_client = reqwest::Client::builder()
            .timeout(PUBLIC_IP_DETECTION_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build();
        if let Ok(client) = public_ip_client {
            let response = client.get("https://api.ipify.org").send().await;
            if let Ok(resp) = response {
                if resp.status().is_success() {
                    let text = match axum::body::to_bytes(
                        axum::body::Body::from_stream(resp.bytes_stream()),
                        PUBLIC_IP_DETECTION_BODY_LIMIT,
                    )
                    .await
                    {
                        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                        Err(_) => String::new(),
                    };
                    if let Some(ip) = parse_detected_public_ip(&text) {
                        tracing::info!("Detected external IP via HTTP: {}", ip);
                        detected_external_ip = Some(ip);
                    }
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
            server_public_port,
            detected_external_ip.as_deref(),
            detected_local_ip.as_deref(),
            config.voice.native_media,
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
        work_mem_mb: config.database.work_mem_mb,
        maintenance_work_mem_mb: config.database.maintenance_work_mem_mb,
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

    // Optional LAN candidate for clients on the same network. This avoids
    // hairpin-NAT signaling paths when the configured public URL points to
    // the server's WAN address.
    if let Some(local_ip) = detected_local_ip.as_deref() {
        let ws_scheme = if tls_preferred { "wss" } else { "ws" };
        let proxy_port = if tls_preferred {
            config.tls.port
        } else {
            server_public_port
        };
        let local_candidate_url = format!("{ws_scheme}://{local_ip}:{proxy_port}/livekit");
        std::env::set_var("PARACORD_LIVEKIT_LOCAL_CANDIDATE_URL", &local_candidate_url);
        tracing::info!("LiveKit local candidate URL: {}", local_candidate_url);

        // Same pattern for native QUIC media: provide the LAN IP so clients
        // on the same network don't need hairpin NAT through the public IP.
        let media_port = config.voice.port;
        let native_local = format!("https://{}:{}/media", local_ip, media_port);
        std::env::set_var("PARACORD_NATIVE_MEDIA_LOCAL_CANDIDATE", &native_local);
        tracing::info!("Native media local candidate URL: {}", native_local);
    }

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

    let memberships = paracord_db::members::get_all_memberships(&db)
        .await
        .context("failed to load memberships for member index")?;
    let member_index = paracord_core::member_index::MemberIndex::from_memberships(memberships);

    let mut state = paracord_core::AppState {
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
            totp_cryptor: at_rest_profile.totp_cryptor.clone(),
            backup_dir: config.backup.backup_dir.clone(),
            database_url: config.database.url.clone(),
            federation_max_events_per_peer_per_minute: config
                .federation
                .max_events_per_peer_per_minute,
            federation_max_user_creates_per_peer_per_hour: config
                .federation
                .max_user_creates_per_peer_per_hour,
            native_media_enabled: config.voice.native_media,
            native_media_port: config.voice.port,
            native_media_max_participants: config.voice.max_participants_per_room,
            native_media_e2ee_required: config.voice.e2ee_required,
            max_guild_storage_quota: config.storage.max_guild_storage_quota,
            federation_file_cache_enabled: config.federation.file_cache_enabled,
            federation_file_cache_max_size: config.federation.file_cache_max_size,
            federation_file_cache_ttl_hours: config.federation.file_cache_ttl_hours,
            tenor_api_key: config.integrations.tenor_api_key.clone(),
            require_email_verification: config.auth.require_email_verification,
            ai_provider: config.ai.provider.clone(),
            ai_base_url: config.ai.base_url.clone(),
            ai_api_key: config.ai.api_key.clone(),
            ai_model: config.ai.model.clone(),
            ai_timeout_seconds: config.ai.timeout_seconds,
        },
        voice,
        storage,
        storage_backend,
        online_users: Arc::new(DashSet::new()),
        user_presences: Arc::new(DashMap::new()),
        permission_cache: paracord_core::build_permission_cache(
            config.server.permission_cache_max_entries,
        ),
        federation_service,
        member_index: Arc::new(member_index),
        presence_manager: Arc::new(paracord_core::presence_manager::PresenceManager::new()),
        native_media: None,
        mfa_tickets: moka::future::Cache::builder()
            .max_capacity(10_000)
            .time_to_live(std::time::Duration::from_secs(300))
            .build(),
    };

    // ── Native QUIC media server ─────────────────────────────────────────────
    // Uses a single UDP port (defaults to 8443, same as TLS) with ALPN-based
    // routing: `h3` → WebTransport (browsers), anything else → raw QUIC
    // (desktop/federation). Admins only need to forward one port (TCP + UDP).
    if config.voice.native_media {
        use paracord_transport::endpoint::{generate_self_signed_cert, MediaEndpoint};

        let media_port = config.voice.port;
        let media_addr: std::net::SocketAddr = format!("0.0.0.0:{}", media_port).parse()?;
        match generate_self_signed_cert() {
            Ok(tls) => {
                // Compute SHA-256 hash of the DER certificate for WebTransport
                // `serverCertificateHashes`. Browsers need this to trust
                // self-signed certs.
                let cert_hash = {
                    use sha2::{Digest, Sha256};
                    let mut hasher = Sha256::new();
                    hasher.update(tls.cert_chain[0].as_ref());
                    let digest = hasher.finalize();
                    use base64::Engine;
                    base64::engine::general_purpose::STANDARD.encode(digest)
                };

                // Single unified endpoint: ALPN `h3` for WebTransport browsers,
                // `paracord-media` for raw QUIC desktop/federation clients.
                // Clients MUST send a matching ALPN (rustls requires it).
                match MediaEndpoint::bind_unified(
                    media_addr,
                    tls,
                    vec![b"h3".to_vec(), b"paracord-media".to_vec()],
                ) {
                    Ok(endpoint) => {
                        let rooms = Arc::new(paracord_relay::room::MediaRoomManager::new());
                        let speaker = Arc::new(paracord_relay::speaker::SpeakerDetector::new());
                        let relay_forwarder = Arc::new(paracord_relay::relay::RelayForwarder::new(
                            Arc::clone(&rooms),
                            Arc::clone(&speaker),
                        ));
                        let endpoint = Arc::new(endpoint);
                        let native_state = paracord_core::NativeMediaState {
                            rooms: Arc::clone(&rooms),
                            speaker_detector: Arc::clone(&speaker),
                            endpoint: Arc::clone(&endpoint),
                            relay_forwarder: Arc::clone(&relay_forwarder),
                            cert_hash: cert_hash.clone(),
                        };
                        state.native_media = Some(native_state);
                        tracing::info!(
                            "Native QUIC media server listening on UDP port {} (unified: raw QUIC + WebTransport)",
                            media_port
                        );

                        // Spawn unified accept loop — inspects ALPN to route
                        // each connection to the appropriate handler.
                        {
                            let relay = Arc::clone(&relay_forwarder);
                            let jwt_secret = config.auth.jwt_secret.clone();
                            let db = state.db.clone();
                            tokio::spawn(async move {
                                unified_media_accept_loop(endpoint, relay, jwt_secret, db).await;
                            });
                        }
                    }
                    Err(e) => {
                        tracing::error!("Failed to start native QUIC media server: {}", e);
                    }
                }
            }
            Err(e) => {
                tracing::error!("Failed to generate self-signed cert for media: {}", e);
            }
        }
    }

    // ── QUIC file transfer partial upload cleanup ─────────────────────────────
    if config.voice.native_media {
        let partial_dir = std::path::Path::new(&config.storage.path).join("partial");
        paracord_transport::file_transfer::PartialUploadManager::spawn_cleanup_task(
            partial_dir,
            shutdown_notify.clone(),
        );
        tracing::info!("QUIC file transfer enabled (sharing native media QUIC endpoint)");
    }

    paracord_api::install_http_rate_limiter();
    paracord_api::spawn_http_rate_limiter_cleanup(shutdown_notify.clone());

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
    spawn_federation_moderation_worker(state.clone(), shutdown_notify.clone());
    spawn_scheduled_message_worker(state.clone(), shutdown_notify.clone());
    spawn_disappearing_message_worker(state.clone(), shutdown_notify.clone());
    spawn_scheduled_event_worker(state.clone(), shutdown_notify.clone());
    bots::spawn_bot_manager(state.clone(), shutdown_notify.clone());

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
    let voice_status = if config.voice.native_media && livekit_reachable {
        "Native QUIC (LiveKit fallback)".to_string()
    } else if config.voice.native_media {
        "Native QUIC".to_string()
    } else if livekit_reachable {
        livekit_status.clone()
    } else {
        "Not available".to_string()
    };

    print_startup_banner(
        &config.server.bind_address,
        &config.server.public_url,
        &livekit_status,
        &config.database.url,
        &port_forwarding_status,
        &web_ui_status,
        &tls_status,
        tls_rustls_config.is_some(),
        tls_port,
        needs_manual_forwarding,
        server_public_port,
        &voice_status,
    );

    // Graceful shutdown on ctrl-c or API-triggered restart
    let shutdown_notify_http = shutdown_notify.clone();
    let shutdown_signal_http = async move {
        #[cfg(windows)]
        {
            let mut ctrl_break = tokio::signal::windows::ctrl_break()
                .expect("failed to install ctrl-break signal handler");
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {
                    println!();
                    tracing::info!("Shutting down (ctrl-c)...");
                }
                _ = ctrl_break.recv() => {
                    println!();
                    tracing::info!("Shutting down (ctrl-break)...");
                }
                _ = shutdown_notify_http.notified() => {
                    tracing::info!("Shutting down (restart requested via API)...");
                }
            }
        }
        #[cfg(not(windows))]
        {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {
                    println!();
                    tracing::info!("Shutting down (ctrl-c)...");
                }
                _ = shutdown_notify_http.notified() => {
                    tracing::info!("Shutting down (restart requested via API)...");
                }
            }
        }
        if let Some(mut lk) = managed_livekit {
            lk.kill().await;
        }
    };

    if let Some(rustls_config) = tls_rustls_config {
        // Run HTTP redirect + HTTPS concurrently.
        // HTTPS listener injects X-Forwarded-Proto so downstream handlers
        // return secure URLs (wss://, HSTS, etc.).
        let bind_host = config
            .server
            .bind_address
            .rsplit_once(':')
            .map(|(h, _)| h)
            .unwrap_or("0.0.0.0");
        let tls_addr: std::net::SocketAddr = format!("{}:{}", bind_host, tls_port).parse()?;
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

    // Always create TOTP cryptor when at-rest encryption master key is available,
    // with plaintext read fallback to handle pre-encryption secrets transparently.
    let totp_cryptor = Some(
        paracord_util::at_rest::FileCryptor::from_master_key_with_context(
            &master_key,
            b"totp",
            true, // allow plaintext reads for migration of unencrypted secrets
        ),
    );

    tracing::info!(
        "At-rest encryption enabled (sqlite={}, files={}, totp=true, allow_plaintext_file_reads={})",
        encrypt_sqlite,
        config.at_rest.encrypt_files,
        config.at_rest.allow_plaintext_file_reads
    );

    Ok(AtRestRuntimeProfile {
        sqlite_key_hex,
        file_cryptor,
        totp_cryptor,
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

fn spawn_federation_moderation_worker(
    state: paracord_core::AppState,
    shutdown: Arc<tokio::sync::Notify>,
) {
    let Some(ref service) = state.federation_service else {
        return;
    };
    if !service.is_enabled() {
        return;
    }

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(600));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                _ = interval.tick() => {
                    paracord_api::routes::federation::sync_moderation_lists_once(&state).await;
                }
            }
        }
    });
}

fn truncate_worker_error(raw: &str) -> String {
    const MAX_ERROR_LEN: usize = 512;
    let trimmed = raw.trim();
    if trimmed.len() <= MAX_ERROR_LEN {
        trimmed.to_string()
    } else {
        format!("{}...", &trimmed[..MAX_ERROR_LEN.saturating_sub(3)])
    }
}

fn parse_scheduled_dm_e2ee(
    raw_payload: Option<&str>,
) -> Result<Option<paracord_core::message::DmE2eePayload>> {
    let Some(raw_payload) = raw_payload else {
        return Ok(None);
    };
    let value: serde_json::Value =
        serde_json::from_str(raw_payload).context("invalid scheduled e2ee payload JSON")?;
    let version = value
        .get("version")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| anyhow::anyhow!("scheduled e2ee payload missing version"))?
        as u8;
    let nonce = value
        .get("nonce")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("scheduled e2ee payload missing nonce"))?
        .to_string();
    let ciphertext = value
        .get("ciphertext")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("scheduled e2ee payload missing ciphertext"))?
        .to_string();
    let header = value
        .get("header")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Ok(Some(paracord_core::message::DmE2eePayload {
        version,
        nonce,
        ciphertext,
        header,
    }))
}

fn spawn_scheduled_message_worker(
    state: paracord_core::AppState,
    shutdown: Arc<tokio::sync::Notify>,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                _ = interval.tick() => {
                    if let Err(err) = run_scheduled_message_worker_once(&state).await {
                        tracing::warn!("scheduled message worker failed: {}", err);
                    }
                }
            }
        }
    });
}

async fn run_scheduled_message_worker_once(state: &paracord_core::AppState) -> Result<()> {
    let due = paracord_db::scheduled_messages::list_due_scheduled_messages(
        &state.db,
        chrono::Utc::now(),
        64,
    )
    .await?;
    if due.is_empty() {
        return Ok(());
    }

    for scheduled in due {
        let channel =
            match paracord_db::channels::get_channel(&state.db, scheduled.channel_id).await {
                Ok(Some(channel)) => channel,
                Ok(None) => {
                    let _ = paracord_db::scheduled_messages::mark_scheduled_message_failed(
                        &state.db,
                        scheduled.id,
                        "channel no longer exists",
                    )
                    .await;
                    continue;
                }
                Err(err) => {
                    let _ = paracord_db::scheduled_messages::mark_scheduled_message_failed(
                        &state.db,
                        scheduled.id,
                        &truncate_worker_error(&err.to_string()),
                    )
                    .await;
                    continue;
                }
            };

        let dm_e2ee = match parse_scheduled_dm_e2ee(scheduled.e2ee_payload.as_deref()) {
            Ok(payload) => payload,
            Err(err) => {
                let _ = paracord_db::scheduled_messages::mark_scheduled_message_failed(
                    &state.db,
                    scheduled.id,
                    &truncate_worker_error(&err.to_string()),
                )
                .await;
                continue;
            }
        };
        let content = scheduled.content.as_deref().unwrap_or_default();
        let allow_empty = content.trim().is_empty();
        let msg_id = paracord_util::snowflake::generate(1);
        let create_result = paracord_core::message::create_message_with_options(
            &state.db,
            msg_id,
            scheduled.channel_id,
            scheduled.author_id,
            content,
            paracord_core::message::CreateMessageOptions {
                message_type: 0,
                reference_id: None,
                allow_empty_content: allow_empty,
                dm_e2ee,
                nonce: scheduled.nonce.clone(),
            },
        )
        .await;

        let message = match create_result {
            Ok(message) => message,
            Err(err) => {
                let _ = paracord_db::scheduled_messages::mark_scheduled_message_failed(
                    &state.db,
                    scheduled.id,
                    &truncate_worker_error(&err.to_string()),
                )
                .await;
                continue;
            }
        };

        paracord_db::scheduled_messages::mark_scheduled_message_sent(
            &state.db,
            scheduled.id,
            message.id,
        )
        .await?;

        let payload =
            paracord_api::routes::channels::message_to_json(state, &message, scheduled.author_id)
                .await;
        if let Some(guild_id) = channel.guild_id() {
            state
                .event_bus
                .dispatch("MESSAGE_CREATE", payload, Some(guild_id));
        } else {
            let recipients =
                paracord_db::dms::get_dm_recipient_ids(&state.db, scheduled.channel_id).await?;
            state
                .event_bus
                .dispatch_to_users("MESSAGE_CREATE", payload, recipients);
        }
    }

    Ok(())
}

fn spawn_disappearing_message_worker(
    state: paracord_core::AppState,
    shutdown: Arc<tokio::sync::Notify>,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                _ = interval.tick() => {
                    if let Err(err) = run_disappearing_message_worker_once(&state).await {
                        tracing::warn!("disappearing-message worker failed: {}", err);
                    }
                }
            }
        }
    });
}

async fn run_disappearing_message_worker_once(state: &paracord_core::AppState) -> Result<()> {
    let channels =
        paracord_db::channel_features::list_channels_with_disappearing(&state.db, 10_000).await?;
    if channels.is_empty() {
        return Ok(());
    }

    for (channel_id, disappearing_seconds) in channels {
        let cutoff =
            chrono::Utc::now() - chrono::Duration::seconds(i64::from(disappearing_seconds));
        loop {
            let ids = paracord_db::messages::get_channel_message_ids_older_than(
                &state.db, channel_id, cutoff, 500,
            )
            .await?;
            if ids.is_empty() {
                break;
            }

            let deleted = paracord_db::messages::delete_messages_by_ids(&state.db, &ids).await?;
            if deleted == 0 {
                break;
            }

            if let Some(channel) = paracord_db::channels::get_channel(&state.db, channel_id).await?
            {
                let payload = serde_json::json!({
                    "channel_id": channel_id.to_string(),
                    "ids": ids.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
                });
                if let Some(guild_id) = channel.guild_id() {
                    state
                        .event_bus
                        .dispatch("MESSAGE_DELETE_BULK", payload, Some(guild_id));
                } else {
                    let recipients = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
                        .await
                        .unwrap_or_default();
                    state
                        .event_bus
                        .dispatch_to_users("MESSAGE_DELETE_BULK", payload, recipients);
                }
            }

            if ids.len() < 500 {
                break;
            }
        }
    }

    Ok(())
}

fn parse_event_time(raw: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|v| v.with_timezone(&chrono::Utc))
}

fn normalize_event_channel_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if (ch.is_whitespace() || ch == '-' || ch == '_') && !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "event-chat".to_string()
    } else {
        format!("event-{}", trimmed.chars().take(72).collect::<String>())
    }
}

fn recurrence_delta(rule: Option<&str>) -> Option<chrono::Duration> {
    match rule.map(|v| v.trim().to_ascii_lowercase()) {
        Some(ref v) if v == "daily" => Some(chrono::Duration::days(1)),
        Some(ref v) if v == "weekly" => Some(chrono::Duration::days(7)),
        Some(ref v) if v == "monthly" => Some(chrono::Duration::days(30)),
        _ => None,
    }
}

fn spawn_scheduled_event_worker(
    state: paracord_core::AppState,
    shutdown: Arc<tokio::sync::Notify>,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                _ = interval.tick() => {
                    if let Err(err) = run_scheduled_event_worker_once(&state).await {
                        tracing::warn!("scheduled-event worker failed: {}", err);
                    }
                }
            }
        }
    });
}

async fn run_scheduled_event_worker_once(state: &paracord_core::AppState) -> Result<()> {
    let now = chrono::Utc::now();
    let events =
        paracord_db::scheduled_events::list_events_by_status(&state.db, &[1, 2], 1_024).await?;
    if events.is_empty() {
        return Ok(());
    }

    for event in events {
        let start_at = parse_event_time(&event.scheduled_start);
        let end_at = event
            .scheduled_end
            .as_deref()
            .and_then(parse_event_time)
            .or(start_at);

        if event.status == 1 {
            if let (Some(reminder_minutes), Some(start_at)) = (event.reminder_minutes, start_at) {
                if event.reminder_sent_at.is_none()
                    && reminder_minutes > 0
                    && now >= start_at - chrono::Duration::minutes(i64::from(reminder_minutes))
                {
                    let payload = serde_json::json!({
                        "id": event.id.to_string(),
                        "guild_id": event.guild_id.to_string(),
                        "name": event.name,
                        "scheduled_start": event.scheduled_start,
                        "reminder_minutes": reminder_minutes,
                    });
                    state.event_bus.dispatch(
                        "GUILD_SCHEDULED_EVENT_REMINDER",
                        payload,
                        Some(event.guild_id),
                    );
                    let _ =
                        paracord_db::scheduled_events::mark_reminder_sent(&state.db, event.id, now)
                            .await;
                }
            }

            if event.event_channel_id.is_none()
                && !event.event_channel_created
                && start_at.is_some_and(|start| now >= start - chrono::Duration::minutes(30))
            {
                let next_position =
                    paracord_db::channels::get_guild_channels(&state.db, event.guild_id)
                        .await
                        .map(|rows| rows.len() as i32)
                        .unwrap_or(0);
                let channel_name = normalize_event_channel_name(&event.name);
                if let Ok(channel) = paracord_db::channels::create_channel(
                    &state.db,
                    paracord_util::snowflake::generate(1),
                    event.guild_id,
                    &channel_name,
                    0,
                    next_position,
                    None,
                    None,
                )
                .await
                {
                    let _ = paracord_db::scheduled_events::set_event_channel(
                        &state.db, event.id, channel.id, true,
                    )
                    .await;
                    state.event_bus.dispatch(
                        "GUILD_SCHEDULED_EVENT_UPDATE",
                        serde_json::json!({
                            "id": event.id.to_string(),
                            "guild_id": event.guild_id.to_string(),
                            "event_channel_id": channel.id.to_string(),
                            "event_channel_created": true,
                        }),
                        Some(event.guild_id),
                    );
                }
            }

            if start_at.is_some_and(|start| now >= start) {
                let _ = paracord_db::scheduled_events::update_event_status(&state.db, event.id, 2)
                    .await;
                state.event_bus.dispatch(
                    "GUILD_SCHEDULED_EVENT_UPDATE",
                    serde_json::json!({
                        "id": event.id.to_string(),
                        "guild_id": event.guild_id.to_string(),
                        "status": 2,
                    }),
                    Some(event.guild_id),
                );
            }
        }

        if (event.status == 1 || event.status == 2) && end_at.is_some_and(|end| now >= end) {
            let _ =
                paracord_db::scheduled_events::update_event_status(&state.db, event.id, 3).await;
            state.event_bus.dispatch(
                "GUILD_SCHEDULED_EVENT_UPDATE",
                serde_json::json!({
                    "id": event.id.to_string(),
                    "guild_id": event.guild_id.to_string(),
                    "status": 3,
                }),
                Some(event.guild_id),
            );

            if event.event_channel_created {
                if let Some(event_channel_id) = event.event_channel_id {
                    if let Err(err) =
                        paracord_db::scheduled_events::clear_event_channel(&state.db, event.id)
                            .await
                    {
                        tracing::warn!(
                            "failed to clear scheduled event {} auto-channel reference: {}",
                            event.id,
                            err
                        );
                    } else {
                        match paracord_db::channels::delete_channel(&state.db, event_channel_id)
                            .await
                        {
                            Ok(()) => {
                                state.event_bus.dispatch(
                                    "CHANNEL_DELETE",
                                    serde_json::json!({
                                        "id": event_channel_id.to_string(),
                                        "guild_id": event.guild_id.to_string(),
                                    }),
                                    Some(event.guild_id),
                                );
                            }
                            Err(err) => {
                                tracing::warn!(
                                    "failed to delete scheduled event {} auto-channel {}: {}",
                                    event.id,
                                    event_channel_id,
                                    err
                                );
                            }
                        }
                    }
                }
            }

            if let (Some(delta), Some(start_at)) =
                (recurrence_delta(event.recurrence_rule.as_deref()), start_at)
            {
                let next_start = start_at + delta;
                let next_end = end_at.map(|end| end + delta);
                let next_end_text = next_end.map(|end| end.to_rfc3339());
                if let Ok(next_event) = paracord_db::scheduled_events::create_event(
                    &state.db,
                    paracord_util::snowflake::generate(1),
                    event.guild_id,
                    event.creator_id,
                    &event.name,
                    event.description.as_deref(),
                    &next_start.to_rfc3339(),
                    next_end_text.as_deref(),
                    event.entity_type,
                    event.channel_id,
                    event.location.as_deref(),
                    event.image_url.as_deref(),
                    event.recurrence_rule.as_deref(),
                    event.reminder_minutes,
                    event
                        .event_channel_id
                        .filter(|_| !event.event_channel_created),
                )
                .await
                {
                    state.event_bus.dispatch(
                        "GUILD_SCHEDULED_EVENT_CREATE",
                        serde_json::json!({
                            "id": next_event.id.to_string(),
                            "guild_id": next_event.guild_id.to_string(),
                            "scheduled_start": next_event.scheduled_start,
                            "scheduled_end": next_event.scheduled_end,
                            "status": next_event.status,
                        }),
                        Some(next_event.guild_id),
                    );
                }
            }
        }
    }

    Ok(())
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

    // Per-guild file retention: purge attachments older than each guild's retention_days.
    if let Ok(guild_policies) =
        paracord_db::guild_storage_policies::list_guilds_with_retention_policies(db).await
    {
        for (guild_id, retention_days) in guild_policies {
            let cutoff = now - chrono::Duration::days(retention_days as i64);
            let cutoff_str = cutoff.format("%Y-%m-%d %H:%M:%S").to_string();
            let mut guild_deleted = 0_u64;
            loop {
                let attachments =
                    match paracord_db::guild_storage_policies::get_guild_attachments_older_than(
                        db,
                        guild_id,
                        &cutoff_str,
                        batch_size,
                    )
                    .await
                    {
                        Ok(rows) => rows,
                        Err(err) => {
                            tracing::warn!("Guild {} retention query failed: {}", guild_id, err);
                            break;
                        }
                    };
                if attachments.is_empty() {
                    break;
                }
                let batch_len = attachments.len();
                for attachment in &attachments {
                    let _ = paracord_db::attachments::delete_attachment(db, attachment.id).await;
                    remove_attachment_file(backend, attachment).await;
                    guild_deleted += 1;
                }
                if (batch_len as i64) < batch_size {
                    break;
                }
            }
            if guild_deleted > 0 {
                tracing::info!(
                    "Guild {} retention removed {} attachment(s)",
                    guild_id,
                    guild_deleted
                );
            }
        }
    }

    // Federation file cache cleanup: delete expired entries, then LRU evict if over size limit.
    {
        let now_str = now.format("%Y-%m-%d %H:%M:%S").to_string();
        if let Ok(expired) =
            paracord_db::federation_file_cache::get_expired_cache_entries(db, &now_str, batch_size)
                .await
        {
            let mut cache_deleted = 0_u64;
            for entry in &expired {
                let _ = backend.delete(&entry.storage_key).await;
                let _ = paracord_db::federation_file_cache::delete_cache_entry(db, entry.id).await;
                cache_deleted += 1;
            }
            if cache_deleted > 0 {
                tracing::info!(
                    "Federation cache cleanup removed {} expired entrie(s)",
                    cache_deleted
                );
            }
        }

        // LRU eviction if total cache size exceeds the configured maximum.
        // We read the limit from server_settings DB, falling back to a 1GB default.
        let cache_max_size: u64 =
            paracord_db::server_settings::get_setting(db, "federation_file_cache_max_size")
                .await
                .ok()
                .flatten()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1_073_741_824);

        if let Ok(total_size) = paracord_db::federation_file_cache::get_total_cache_size(db).await {
            if (total_size as u64) > cache_max_size {
                if let Ok(lru_entries) =
                    paracord_db::federation_file_cache::get_lru_cache_entries(db, batch_size).await
                {
                    let mut evicted = 0_u64;
                    let mut running_size = total_size as u64;
                    for entry in &lru_entries {
                        if running_size <= cache_max_size {
                            break;
                        }
                        let _ = backend.delete(&entry.storage_key).await;
                        let _ =
                            paracord_db::federation_file_cache::delete_cache_entry(db, entry.id)
                                .await;
                        running_size = running_size.saturating_sub(entry.size as u64);
                        evicted += 1;
                    }
                    if evicted > 0 {
                        tracing::info!("Federation cache LRU evicted {} entrie(s)", evicted);
                    }
                }
            }
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
    port_forwarding_status: &str,
    web_ui: &str,
    tls_status: &str,
    tls_active: bool,
    tls_port: u16,
    needs_manual_forwarding: bool,
    server_port: u16,
    voice_status: &str,
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
    println!("  Voice:       {}", voice_status);
    println!("  LiveKit:     {}", livekit_status);
    println!("  Port Fwd:    {}", port_forwarding_status);
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

// ── Unified media accept loop ────────────────────────────────────────────

/// Accept incoming QUIC connections on the unified media endpoint,
/// inspect the negotiated ALPN, and route to the appropriate handler:
/// - `h3` → WebTransport (browser clients)
/// - anything else (or no ALPN) → raw QUIC (desktop/federation)
async fn unified_media_accept_loop(
    endpoint: Arc<paracord_transport::endpoint::MediaEndpoint>,
    relay: Arc<paracord_relay::relay::RelayForwarder>,
    jwt_secret: String,
    db: paracord_db::DbPool,
) {
    tracing::info!(
        "Unified media accept loop started (ALPN routing: h3 → WebTransport, other → raw QUIC)"
    );
    loop {
        let incoming = match endpoint.accept().await {
            Some(i) => i,
            None => {
                tracing::info!("Media endpoint closed");
                break;
            }
        };

        let relay = Arc::clone(&relay);
        let jwt_secret = jwt_secret.clone();
        let db = db.clone();
        tokio::spawn(async move {
            let conn = match incoming.accept() {
                Ok(connecting) => match connecting.await {
                    Ok(conn) => conn,
                    Err(e) => {
                        tracing::debug!("Media connection failed: {}", e);
                        return;
                    }
                },
                Err(e) => {
                    tracing::debug!("Media incoming accept failed: {}", e);
                    return;
                }
            };

            // Inspect the negotiated ALPN to determine connection type.
            let alpn = conn
                .handshake_data()
                .and_then(|data| data.downcast::<quinn::crypto::rustls::HandshakeData>().ok())
                .and_then(|hs| hs.protocol.clone());

            let is_h3 = alpn.as_deref() == Some(b"h3");

            if is_h3 {
                handle_webtransport_connection(conn, relay, jwt_secret, db).await;
            } else {
                handle_raw_quic_connection(conn, relay, jwt_secret, db).await;
            }
        });
    }
}

/// Handle a raw QUIC media connection (desktop Tauri clients, federation).
async fn handle_raw_quic_connection(
    conn: quinn::Connection,
    relay: Arc<paracord_relay::relay::RelayForwarder>,
    jwt_secret: String,
    db: paracord_db::DbPool,
) {
    let remote_addr = conn.remote_address();
    tracing::info!(addr = %remote_addr, "QUIC: new raw media connection");

    let media_conn = match paracord_transport::connection::MediaConnection::accept_and_auth(
        conn.clone(),
        &jwt_secret,
        paracord_transport::connection::ConnectionMode::Relay,
    )
    .await
    {
        Ok(mc) => mc,
        Err(e) => {
            tracing::warn!(addr = %remote_addr, "QUIC: auth failed: {}", e);
            return;
        }
    };

    let user_id = media_conn.meta().user_id;
    tracing::info!(user_id, addr = %remote_addr, "QUIC: authenticated");

    let session_id = match media_conn.meta().session_id.as_deref() {
        Some(session_id) if !session_id.trim().is_empty() => session_id,
        _ => {
            tracing::warn!(user_id, "QUIC: media token missing session id");
            return;
        }
    };
    let room_id = match resolve_active_media_room(
        &db,
        user_id,
        session_id,
        media_conn.meta().room_id.as_deref(),
    )
    .await
    {
        Some(room_id) => room_id,
        None => {
            tracing::warn!(
                user_id,
                "QUIC: media token no longer matches active voice state"
            );
            return;
        }
    };

    let handle = paracord_relay::relay::ConnectionHandle::new(user_id, room_id.clone(), conn);
    relay.add_connection(handle.clone());
    relay.spawn_forwarding_task(handle.clone());
    relay.spawn_control_task(handle.clone());
    {
        let relay = relay.clone();
        tokio::spawn(async move {
            relay.send_initial_track_state(&handle).await;
        });
    }
    tracing::info!(user_id, room_id = %room_id, "QUIC: relay forwarding started");
}

async fn resolve_active_media_room(
    db: &paracord_db::DbPool,
    user_id: i64,
    expected_session_id: &str,
    claimed_room_id: Option<&str>,
) -> Option<String> {
    let states = paracord_db::voice_states::get_all_user_voice_states(db, user_id)
        .await
        .ok()?;
    states.into_iter().find_map(|state| {
        if state.session_id != expected_session_id {
            return None;
        }
        let guild_id = state.guild_id().unwrap_or(0);
        let active_room_id = format!("{}:{}", guild_id, state.channel_id);
        if claimed_room_id.is_some_and(|claimed| claimed != active_room_id) {
            return None;
        }
        Some(active_room_id)
    })
}

#[cfg(test)]
mod media_room_tests {
    use super::*;

    async fn media_room_test_db() -> Result<paracord_db::DbPool> {
        let db = paracord_db::create_pool("sqlite::memory:", 1).await?;
        paracord_db::run_migrations(&db).await?;
        Ok(db)
    }

    #[tokio::test]
    async fn resolve_active_media_room_requires_current_voice_session_and_claimed_room(
    ) -> Result<()> {
        let db = media_room_test_db().await?;
        let user_id = 901_001;
        let guild_id = 901_002;
        let channel_id = 901_003;
        let session_id = "voice-session-current";

        paracord_db::users::create_user(
            &db,
            user_id,
            "mediauser",
            1,
            "mediauser@example.com",
            "hash",
        )
        .await?;
        paracord_db::guilds::create_guild(&db, guild_id, "Media Guild", user_id, None).await?;
        paracord_db::channels::create_channel(&db, channel_id, guild_id, "voice", 2, 0, None, None)
            .await?;
        paracord_db::voice_states::upsert_voice_state(
            &db,
            user_id,
            Some(guild_id),
            channel_id,
            session_id,
        )
        .await?;
        let states = paracord_db::voice_states::get_all_user_voice_states(&db, user_id).await?;
        assert_eq!(states.len(), 1, "expected seeded active voice state");
        assert_eq!(states[0].session_id, session_id);

        let active_room = format!("{guild_id}:{channel_id}");
        assert_eq!(
            resolve_active_media_room(&db, user_id, session_id, Some(&active_room)).await,
            Some(active_room.clone())
        );
        assert_eq!(
            resolve_active_media_room(&db, user_id, session_id, Some("999:901003")).await,
            None,
            "media tokens must not authorize a claimed room that differs from DB voice state"
        );
        assert_eq!(
            resolve_active_media_room(&db, user_id, "stale-session", Some(&active_room)).await,
            None,
            "stale media-token session IDs must not authorize the active room"
        );

        let removed = paracord_db::voice_states::remove_voice_state_if_session(
            &db,
            user_id,
            Some(guild_id),
            session_id,
        )
        .await?;
        assert!(removed, "matching-session leave should clear voice state");
        assert_eq!(
            resolve_active_media_room(&db, user_id, session_id, Some(&active_room)).await,
            None,
            "media tokens must stop authorizing after the user leaves voice"
        );

        Ok(())
    }

    #[tokio::test]
    async fn resolve_active_media_room_scopes_dm_voice_to_zero_guild_room() -> Result<()> {
        let db = media_room_test_db().await?;
        let user_id = 902_001;
        let channel_id = 902_002;
        let session_id = "dm-voice-session";

        paracord_db::users::create_user(
            &db,
            user_id,
            "dmmediauser",
            1,
            "dmmediauser@example.com",
            "hash",
        )
        .await?;
        paracord_db::guilds::create_guild(&db, 0, "DM Voice Container", user_id, None).await?;
        paracord_db::channels::create_channel(&db, channel_id, 0, "dm-voice", 1, 0, None, None)
            .await?;
        paracord_db::voice_states::upsert_voice_state(&db, user_id, None, channel_id, session_id)
            .await?;

        let active_room = format!("0:{channel_id}");
        assert_eq!(
            resolve_active_media_room(&db, user_id, session_id, Some(&active_room)).await,
            Some(active_room.clone())
        );
        assert_eq!(
            resolve_active_media_room(&db, user_id, session_id, Some("1:902002")).await,
            None,
            "DM media tokens must not be accepted for a guild-scoped room"
        );

        Ok(())
    }
}

/// Handle an HTTP/3 WebTransport connection from a browser client.
async fn handle_webtransport_connection(
    conn: quinn::Connection,
    relay: Arc<paracord_relay::relay::RelayForwarder>,
    jwt_secret: String,
    db: paracord_db::DbPool,
) {
    let remote_addr = conn.remote_address();
    tracing::info!(addr = %remote_addr, "WebTransport: new HTTP/3 connection");

    // Handle as HTTP/3 and accept WebTransport session
    let mut h3_session = match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        paracord_transport::webtransport::WebTransportServer::handle_connection(conn.clone()),
    )
    .await
    {
        Ok(result) => match result {
            Ok(s) => s,
            Err(e) => {
                tracing::debug!(addr = %remote_addr, "WebTransport: HTTP/3 setup failed: {}", e);
                return;
            }
        },
        Err(_) => {
            tracing::debug!(addr = %remote_addr, "WebTransport: HTTP/3 setup timed out");
            return;
        }
    };

    let wt_session = match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        h3_session.accept_session(),
    )
    .await
    {
        Ok(Ok(Some(s))) => s,
        Ok(Ok(None)) => {
            tracing::debug!(addr = %remote_addr, "WebTransport: no session received");
            return;
        }
        Ok(Err(e)) => {
            tracing::debug!(addr = %remote_addr, "WebTransport: session accept failed: {}", e);
            return;
        }
        Err(_) => {
            tracing::debug!(addr = %remote_addr, "WebTransport: session accept timed out");
            return;
        }
    };

    if wt_session.path() != "/media" {
        tracing::warn!(addr = %remote_addr, path = %wt_session.path(), "WebTransport: invalid media path");
        return;
    }

    let (mut send, mut recv) = match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        wt_session.accept_bi(),
    )
    .await
    {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => {
            tracing::warn!(addr = %remote_addr, "WebTransport: no bidi stream for auth: {}", e);
            return;
        }
        Err(_) => {
            tracing::warn!(addr = %remote_addr, "WebTransport: timed out waiting for auth stream");
            return;
        }
    };

    tracing::info!(
        addr = %remote_addr,
        path = %wt_session.path(),
        "WebTransport: session established"
    );

    // Authenticate: read first bidi stream message. Accept both the legacy
    // newline-delimited JSON auth format and the unified length-prefixed
    // control-frame format used by the QUIC transport.

    // Read up to 8KB for the auth message
    let mut buf = vec![0u8; 8192];
    let mut total = 0usize;
    let user_id: i64;
    let room_id: String;

    loop {
        match tokio::time::timeout(
            std::time::Duration::from_secs(10),
            recv.read(&mut buf[total..]),
        )
        .await
        {
            Err(_) => {
                tracing::warn!(addr = %remote_addr, "WebTransport: read timeout during auth");
                return;
            }
            Ok(read_result) => match read_result {
                Ok(Some(n)) => {
                    total += n;
                    let parsed_message = if total >= 4 {
                        let frame_len =
                            u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
                        if frame_len > 0 && frame_len <= buf.len() && total >= 4 + frame_len {
                            serde_json::from_slice::<serde_json::Value>(&buf[4..4 + frame_len]).ok()
                        } else {
                            None
                        }
                    } else {
                        None
                    };

                    let parsed_message = if let Some(message) = parsed_message {
                        Some(message)
                    } else if let Some(nl_pos) = buf[..total].iter().position(|&b| b == b'\n') {
                        match serde_json::from_slice::<serde_json::Value>(&buf[..nl_pos]) {
                            Ok(message) => Some(message),
                            Err(e) => {
                                tracing::warn!(addr = %remote_addr, "WebTransport: invalid auth JSON: {}", e);
                                return;
                            }
                        }
                    } else {
                        None
                    };

                    if let Some(msg) = parsed_message {
                        if msg.get("type").and_then(|t| t.as_str()) != Some("auth") {
                            tracing::warn!(addr = %remote_addr, "WebTransport: first message not auth");
                            return;
                        }

                        let token = match msg.get("token").and_then(|t| t.as_str()) {
                            Some(t) => t,
                            None => {
                                tracing::warn!(addr = %remote_addr, "WebTransport: auth message missing token");
                                return;
                            }
                        };

                        // Validate JWT
                        let validation =
                            jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
                        let token_data = match jsonwebtoken::decode::<serde_json::Value>(
                            token,
                            &jsonwebtoken::DecodingKey::from_secret(jwt_secret.as_bytes()),
                            &validation,
                        ) {
                            Ok(td) => td,
                            Err(e) => {
                                tracing::warn!(addr = %remote_addr, "WebTransport: JWT validation failed: {}", e);
                                return;
                            }
                        };

                        let claims = token_data.claims;
                        user_id = claims
                            .get("sub")
                            .and_then(|value| {
                                value.as_i64().or_else(|| {
                                    value.as_str().and_then(|raw| raw.parse::<i64>().ok())
                                })
                            })
                            .unwrap_or(0);

                        if user_id == 0 {
                            tracing::warn!(addr = %remote_addr, "WebTransport: invalid user_id in JWT");
                            return;
                        }

                        let session_id = claims
                            .get("sid")
                            .or_else(|| claims.get("session_id"))
                            .and_then(|sid| sid.as_str())
                            .map(str::trim)
                            .filter(|sid| !sid.is_empty());
                        let Some(session_id) = session_id else {
                            tracing::warn!(addr = %remote_addr, "WebTransport: media token missing session id");
                            return;
                        };
                        let claimed_room = claims.get("room").and_then(|r| r.as_str());
                        room_id =
                            match resolve_active_media_room(&db, user_id, session_id, claimed_room)
                                .await
                            {
                                Some(room_id) => room_id,
                                None => {
                                    tracing::warn!(
                                user_id,
                                "WebTransport: media token no longer matches active voice state"
                            );
                                    return;
                                }
                            };

                        // Send length-prefixed Pong acknowledgement.
                        if let Ok(ack) = paracord_transport::control::ControlMessage::Pong.encode()
                        {
                            let _ = send.write_all(&ack).await;
                        }

                        break;
                    }

                    if total >= buf.len() {
                        tracing::warn!(addr = %remote_addr, "WebTransport: auth message too large");
                        return;
                    }
                }
                Ok(None) => {
                    tracing::warn!(addr = %remote_addr, "WebTransport: stream closed before auth");
                    return;
                }
                Err(e) => {
                    tracing::warn!(addr = %remote_addr, "WebTransport: read error during auth: {}", e);
                    return;
                }
            },
        }
    }

    tracing::info!(
        user_id,
        room_id = %room_id,
        addr = %remote_addr,
        "WebTransport: authenticated"
    );

    // Spawn datagram bridge (handles QSID framing).
    // The first WebTransport session on a fresh connection has QSID = 0.
    let (outbound_tx, inbound_rx) = paracord_transport::webtransport::spawn_webtransport_bridge(
        wt_session.quinn_conn().clone(),
        0,
    );

    // Create bridged connection handle and start forwarding
    let handle = paracord_relay::relay::ConnectionHandle::new_bridged(
        user_id,
        room_id.clone(),
        outbound_tx,
        inbound_rx,
        Some(wt_session.quinn_conn().clone()),
    );
    relay.add_connection(handle.clone());
    relay.spawn_forwarding_task(handle.clone());
    relay.spawn_control_task(handle.clone());
    {
        let relay = relay.clone();
        tokio::spawn(async move {
            relay.send_initial_track_state(&handle).await;
        });
    }
    tracing::info!(
        user_id,
        room_id = %room_id,
        "WebTransport: relay forwarding started"
    );
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_federation_signing_key_file, livekit_credentials_look_insecure,
        normalize_https_host, parse_detected_public_ip,
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
    fn parses_detected_public_ip_only_when_valid() {
        assert_eq!(
            parse_detected_public_ip(" 203.0.113.42\n"),
            Some("203.0.113.42".to_string())
        );
        assert_eq!(
            parse_detected_public_ip(" 2001:db8::1\n"),
            Some("2001:db8::1".to_string())
        );
        assert_eq!(parse_detected_public_ip("not an ip"), None);
        assert_eq!(parse_detected_public_ip(""), None);
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
