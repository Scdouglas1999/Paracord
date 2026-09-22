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
mod file_transfer;
mod livekit_proc;
mod portmap;
mod restore;
mod tls;
mod web_ui;

const PUBLIC_IP_DETECTION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
const PUBLIC_IP_DETECTION_BODY_LIMIT: usize = 128;

/// Bounded grace period granted to background workers to drain their current
/// batch after shutdown is signalled, before the process tears down.
const WORKER_SHUTDOWN_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

/// How long the restart notice gets to reach connected clients before the
/// listeners are torn down. The frame is already queued on each session's
/// channel when `dispatch` returns; this only lets the gateway's send loop run.
const RESTART_NOTICE_FLUSH: std::time::Duration = std::time::Duration::from_millis(250);

/// Hard ceiling on how long axum may wait for in-flight connections to finish
/// after the shutdown future returns.
///
/// `with_graceful_shutdown` waits for *every* open connection, and the two
/// connections a browser always holds — the realtime SSE stream and the gateway
/// websocket — are open by design until someone closes them. Both now end
/// themselves when `ShutdownSignal` latches, so the drain is normally instant;
/// this is the backstop for the one that does not (a wedged socket, a client
/// that stopped reading). A restart must never hang on a stuck client, so past
/// this deadline the process exits anyway and says how many were still open.
const CONNECTION_DRAIN_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);

/// Wait for the drain to start, then for `CONNECTION_DRAIN_DEADLINE` to pass.
///
/// Resolves only after the shutdown future has returned (which is when axum
/// actually begins draining), so the deadline measures the drain and not the
/// worker grace period that precedes it.
async fn connection_drain_deadline(started: tokio::sync::oneshot::Receiver<()>) {
    if started.await.is_err() {
        // The shutdown future was dropped without signalling; nothing to bound.
        std::future::pending::<()>().await;
    }
    tokio::time::sleep(CONNECTION_DRAIN_DEADLINE).await;
}

/// Accepted HTTP connections this process has not finished with.
static OPEN_HTTP_CONNECTIONS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// The bound listener, wrapped so every connection it hands out is counted.
///
/// Nothing else can answer "how many are still open": axum owns the connections
/// once it has accepted them and keeps no public gauge, and a per-handler count
/// only ever knows about the handlers it was added to. The drain deadline needs
/// the real number — including the connection nobody thought to instrument.
struct CountingListener(tokio::net::TcpListener);

impl axum::serve::Listener for CountingListener {
    type Io = CountedStream;
    type Addr = std::net::SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let (io, addr) = axum::serve::Listener::accept(&mut self.0).await;
        (CountedStream::new(io), addr)
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.0.local_addr()
    }
}

/// A `TcpStream` that counts itself as open until it is dropped.
struct CountedStream(tokio::net::TcpStream);

impl CountedStream {
    fn new(inner: tokio::net::TcpStream) -> Self {
        OPEN_HTTP_CONNECTIONS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Self(inner)
    }
}

impl Drop for CountedStream {
    fn drop(&mut self) {
        OPEN_HTTP_CONNECTIONS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

impl tokio::io::AsyncRead for CountedStream {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

impl tokio::io::AsyncWrite for CountedStream {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.0).poll_write(cx, buf)
    }

    fn poll_write_vectored(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        bufs: &[std::io::IoSlice<'_>],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.0).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.0.is_write_vectored()
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.0).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

/// Describe what is still attached when the drain deadline expires, for the
/// WARN that explains why the process is exiting with connections open.
///
/// The connection count is the whole truth; the three that follow are the kinds
/// this server holds open by design, named because they are the ones an
/// operator can act on.
fn open_connection_summary() -> String {
    format!(
        "{} HTTP connection(s) still open ({} gateway, {} realtime stream(s), {} voice \
         signaling socket(s))",
        OPEN_HTTP_CONNECTIONS.load(std::sync::atomic::Ordering::SeqCst),
        paracord_ws::live_connection_count(),
        paracord_api::live_stream_count(),
        paracord_api::live_voice_signaling_count(),
    )
}

fn parse_detected_public_ip(text: &str) -> Option<String> {
    let ip = text.trim();
    if ip.is_empty() || ip.parse::<std::net::IpAddr>().is_err() {
        return None;
    }
    Some(ip.to_string())
}

/// Ask an outside service what this network's public address is.
///
/// Two callers need it and neither can derive it locally: LiveKit, for ICE
/// candidates, and the port mapper, because a NAT-PMP gateway (unlike PCP or
/// UPnP) never reports the address it forwards from — and without the address
/// the banner cannot tell the owner where friends should connect. Bounded by
/// `PUBLIC_IP_DETECTION_TIMEOUT` and a tiny body limit; `None` on any failure,
/// which every caller treats as "unknown" rather than as an error.
async fn detect_public_ip_via_http() -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(PUBLIC_IP_DETECTION_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let response = client.get("https://api.ipify.org").send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = axum::body::to_bytes(
        axum::body::Body::from_stream(response.bytes_stream()),
        PUBLIC_IP_DETECTION_BODY_LIMIT,
    )
    .await
    .ok()?;
    parse_detected_public_ip(&String::from_utf8_lossy(&bytes))
}

/// Whether the startup path launched a port-mapping attempt, or decided not to.
///
/// Kept as one value so the decision is made once, in one place, and the banner
/// reports what actually happened rather than re-deriving it.
enum PortMapStart {
    Skipped(portmap::SkipReason),
    Running(tokio::task::JoinHandle<portmap::Attempt>),
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

    // Maintenance subcommands run to completion and exit without starting the
    // server or touching the runtime config.
    if let Some(command) = &args.command {
        return match command {
            cli::Command::MigrateToPostgres(migrate_args) => {
                run_migrate_to_postgres(migrate_args).await
            }
            cli::Command::Init(init_args) => run_init(init_args, &args.config),
            cli::Command::RestoreBackup(restore_args) => {
                restore::run(restore_args, &args.config).await
            }
        };
    }

    let config = config::Config::load(&args.config)?;
    if let Some(replay) = config.sports_replay.clone() {
        paracord_core::sports::install_sports_replay(replay.games, replay.speed, replay.start)
            .await;
    }
    if config.tls.acme.enabled && !config.tls.enabled {
        tracing::warn!(
            "tls.acme.enabled is true while tls.enabled is false; ACME automation will be inactive"
        );
    }
    let at_rest_profile = build_at_rest_profile(&config)?;
    if config::is_production_deployment(&config) && at_rest_profile.totp_cryptor.is_none() {
        tracing::warn!(
            "public_url is configured but at-rest TOTP encryption is unavailable; MFA setup will be rejected until [at_rest] is enabled with a valid key"
        );
    }
    if livekit_credentials_look_insecure(&config.livekit.api_key, &config.livekit.api_secret) {
        // Only enforce LiveKit credential hygiene when LiveKit will actually be
        // used: native media is disabled, or an explicit external LiveKit is
        // configured via [livekit].public_url. Under the native-media default
        // LiveKit is inert, so weak placeholder credentials are irrelevant and
        // must neither spam warnings nor block startup.
        let livekit_in_use = !config.voice.native_media || config.livekit.public_url.is_some();
        if livekit_in_use {
            if config.server.public_url.is_some() {
                anyhow::bail!(
                    "Refusing to start with insecure LiveKit credentials when public_url is configured. Set strong [livekit] api_key/api_secret values first."
                );
            }
            tracing::warn!(
                "LiveKit credentials appear insecure. This is acceptable only for local development."
            );
        }
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
        .unwrap_or(8090);
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

    let server_public_port = public_signal_port;
    let bind_is_loopback = config.server.bind_address.starts_with("127.0.0.1:")
        || config.server.bind_address.starts_with("localhost:")
        || config.server.bind_address.starts_with("[::1]:");

    // ── Ask the router to let friends in ────────────────────────────────────
    // Started here and collected just before the banner, so the whole 8s budget
    // overlaps the database migrations and TLS setup that follow. A router that
    // never answers therefore costs a first-time owner nothing they can notice.
    //
    // Exactly two ports: the TCP port a browser reaches the app on, and the UDP
    // port native media uses. Under the generated defaults both are 8443.
    let portmap_request = portmap::PortRequest {
        tcp_port: server_public_port,
        udp_port: config.voice.port,
    };
    let portmap_lease = portmap::lease_from_seconds(config.network.port_forward_lease_seconds);
    let portmap_start = if !config.network.auto_port_forward {
        PortMapStart::Skipped(portmap::SkipReason::Disabled)
    } else if bind_is_loopback {
        PortMapStart::Skipped(portmap::SkipReason::LoopbackBind)
    } else {
        PortMapStart::Running(tokio::spawn(async move {
            portmap::establish(
                &portmap::default_routers(),
                portmap_request,
                portmap_lease,
                portmap::DISCOVERY_BUDGET,
            )
            .await
        }))
    };
    let port_mapping_attempted = matches!(portmap_start, PortMapStart::Running(_));

    // The public address of this network. LiveKit needs it for ICE candidates;
    // the port mapper needs it because a NAT-PMP gateway never reports one, and
    // without it the banner cannot say where friends should connect.
    let mut detected_external_ip: Option<String> = None;
    let livekit_is_local =
        config.livekit.url.contains("localhost") || config.livekit.url.contains("127.0.0.1");
    if livekit_is_local || port_mapping_attempted {
        if let Some(ip) = detect_public_ip_via_http().await {
            tracing::info!("Detected external IP via HTTP: {}", ip);
            detected_external_ip = Some(ip);
        }
    }

    // Detect the local LAN IP for LiveKit ICE candidate filtering.
    // This ensures LiveKit only advertises the real LAN IP (which maps to
    // the public IP) instead of Docker/WSL/loopback addresses.
    let detected_local_ip = livekit_proc::detect_local_ip();
    if let Some(ref lip) = detected_local_ip {
        tracing::info!("Detected local LAN IP: {}", lip);
    }

    // LiveKit is a pure opt-in fallback; native QUIC (config.voice.native_media)
    // is the default media engine. A managed LiveKit binary is only spawned or
    // probed when an operator actually opts in — by disabling native media, or by
    // pointing [livekit] at a real server (a non-local url, or an explicit
    // public_url). Under the native default we never touch LiveKit at all, so a
    // missing binary is a normal, silent outcome rather than an error.
    let mut managed_livekit = None;
    let mut livekit_reachable = false;
    let livekit_url_is_local = livekit_is_local;
    let livekit_opt_in =
        !config.voice.native_media || !livekit_url_is_local || config.livekit.public_url.is_some();
    let livekit_status = if !livekit_opt_in {
        "Disabled (native QUIC default)".to_string()
    } else if livekit_url_is_local {
        // Operator opted into a locally-managed LiveKit. Reuse an already-running
        // instance if present, otherwise try to launch one.
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
            config.livekit.turn_udp_port,
        )
        .await
        {
            Some(proc) => {
                livekit_reachable = true;
                managed_livekit = Some(proc);
                format!("Managed (port {})", livekit_port)
            }
            None if already_running => {
                livekit_reachable = true;
                format!("External (port {})", livekit_port)
            }
            None => "Not available (binary not found)".to_string(),
        }
    } else {
        // Explicit external LiveKit URL configured — assume reachable.
        livekit_reachable = true;
        "External".to_string()
    };

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
                paracord_util::redact::redact_db_url(&config.database.url),
                e
            )
        } else {
            anyhow::anyhow!("{}", e)
        }
    })?;
    paracord_db::run_migrations_for_engine(&db, db_engine)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to run {} migrations: {}", db_engine.as_str(), e))?;

    // Servers from before uploaded banners kept theirs inside the hub settings
    // as a data URL. Turn each into a real banner before anything reads them.
    let converted = paracord_api::convert_legacy_hub_banners(&db, &config.storage.path)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to convert old server banners: {e}"))?;
    if converted > 0 {
        tracing::info!("Converted {converted} old server banner(s) to uploaded banners");
    }

    // ── First-owner claim ───────────────────────────────────────────────────
    // Decided before anything can serve a request: while the instance is
    // unclaimed the API refuses every registration, so the bootstrap token has
    // to exist by the time the listener opens.
    let mut setup_state = provision_instance_setup(&db, &config, &args.config).await?;

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

    // Latched, so a connection that arms its wait *after* the signal fires —
    // an SSE stream a browser opened mid-drain — still sees it. Workers keep
    // taking the bare `Notify` behind it.
    let shutdown_signal = paracord_core::shutdown::ShutdownSignal::new();
    let shutdown_notify = shutdown_signal.notify_handle();

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

    let database_history_epoch =
        paracord_db::server_settings::get_or_create_database_history_epoch(&db)
            .await
            .context("failed to load database history epoch")?;
    let mut state = paracord_core::AppState {
        database_history_epoch,
        db,
        event_bus: paracord_core::events::EventBus::default(),
        runtime,
        shutdown: shutdown_signal.clone(),
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
            bind_address: config.server.bind_address.clone(),
            tls_enabled: config.tls.enabled,
            tls_self_signed: config.tls.enabled
                && config.tls.auto_generate
                && !config.tls.acme.enabled,
            auto_backup_enabled: config.backup.auto_backup_enabled,
            auto_backup_interval_seconds: config.backup.auto_backup_interval_seconds,
            federation_enabled: config.federation.enabled,
            started_at: chrono::Utc::now(),
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

    // Membership is what decides a guild event's audience. Wiring the index to
    // the bus here means every route that records a membership widens the
    // realtime fan-out in the same call — the reason a guild created after a
    // client connected now reaches that client instead of nobody.
    state.member_index.attach_event_bus(state.event_bus.clone());

    // ── Native QUIC media server ─────────────────────────────────────────────
    // Uses a single UDP port (defaults to 8443, same as TLS) with ALPN-based
    // routing: `h3` → WebTransport (browsers), anything else → raw QUIC
    // (desktop/federation). Admins only need to forward one port (TCP + UDP).
    if config.voice.native_media {
        use paracord_transport::endpoint::{generate_media_certificate, MediaEndpoint};

        let media_port = config.voice.port;
        let media_addr: std::net::SocketAddr = format!("0.0.0.0:{}", media_port).parse()?;

        // Provision the native QUIC endpoint. On success `state.native_media` is
        // populated and the ALPN accept loop spawned; on failure we capture a
        // concrete, operator-actionable reason and decide below whether to
        // hard-fail (no fallback) or degrade to LiveKit.
        // The certificate is valid for under 14 days, which is what browsers
        // require of a WebTransport `serverCertificateHashes` pin; a rotation
        // task below regenerates it before it expires.
        let provisioning_error: Option<String> = match generate_media_certificate() {
            Ok(generated) => {
                // SHA-256 of the DER, for WebTransport `serverCertificateHashes`.
                // Browsers need this to trust a self-signed cert.
                let cert_hash = paracord_core::MediaCertHash::new(generated.hash.clone());
                let cert_not_after = generated.not_after;

                // Single unified endpoint: ALPN `h3` for WebTransport browsers,
                // `paracord-media` for raw QUIC desktop/federation clients.
                // Clients MUST send a matching ALPN (rustls requires it).
                match MediaEndpoint::bind_unified(
                    media_addr,
                    generated.tls,
                    MEDIA_ALPN_PROTOCOLS
                        .iter()
                        .map(|alpn| alpn.to_vec())
                        .collect(),
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
                            "Native QUIC media server listening on UDP port {} (unified: raw QUIC + WebTransport), certificate pin {}… valid until {}",
                            media_port,
                            cert_hash_prefix(&generated.hash),
                            format_timestamp(cert_not_after),
                        );

                        // Keep the certificate inside the browser's 14-day
                        // window for as long as the process runs.
                        spawn_media_certificate_rotation(
                            Arc::clone(&endpoint),
                            cert_hash.clone(),
                            cert_not_after,
                            shutdown_notify.clone(),
                        );

                        // Spawn unified accept loop — inspects ALPN to route
                        // each connection to the appropriate handler.
                        {
                            let relay = Arc::clone(&relay_forwarder);
                            let jwt_secret = config.auth.jwt_secret.clone();
                            let db = state.db.clone();
                            let files =
                                Arc::new(file_transfer::FileTransferRuntime::new(state.clone()));
                            tokio::spawn(async move {
                                unified_media_accept_loop(endpoint, relay, jwt_secret, db, files)
                                    .await;
                            });
                        }
                        None
                    }
                    Err(e) => Some(describe_media_bind_error(&e, media_port)),
                }
            }
            Err(e) => Some(format!(
                "failed to generate the self-signed media certificate: {e}"
            )),
        };

        if let Some(reason) = provisioning_error {
            if livekit_reachable {
                // A working LiveKit fallback is configured, so voice still works.
                // Degrade loudly but keep serving.
                tracing::warn!("==========================================================");
                tracing::warn!("  Native QUIC voice engine FAILED to start!");
                tracing::warn!("  {}", reason);
                tracing::warn!("");
                tracing::warn!("  Falling back to the configured LiveKit backend.");
                tracing::warn!("  Native QUIC media (E2EE, low-latency) stays DISABLED");
                tracing::warn!("  until this is resolved.");
                tracing::warn!("==========================================================");
            } else {
                // Native QUIC is the default and only voice engine, it failed, and
                // there is no LiveKit fallback. Refuse to boot a server that cannot
                // do voice at all — a silent no-voice server is worse than a clear
                // startup failure.
                anyhow::bail!(
                    "Native QUIC voice is the default media engine but it failed to start, \
                     and no working LiveKit fallback is configured. Refusing to boot a server \
                     that cannot do voice.\n  Reason: {reason}\n  \
                     Fix the underlying problem (e.g. free the UDP port, or configure an \
                     external [livekit] server as a fallback) and restart."
                );
            }
        }
    }

    // Reconcile the advertised native-media capability with what actually came
    // up. `native_media_enabled` was seeded from config intent, but native
    // provisioning may have degraded to LiveKit (state.native_media == None).
    // Voice-join handlers gate the native branch on this flag, so leaving it
    // true would advertise native_media:true with a null cert_hash pointing
    // clients at a dead endpoint. Track the real runtime state instead.
    state.config.native_media_enabled = state.native_media.is_some();

    // ── QUIC file transfer partial upload cleanup ─────────────────────────────
    // Only when the native QUIC endpoint actually came up (it shares that
    // endpoint). If native media degraded to a LiveKit fallback, skip it.
    if state.native_media.is_some() {
        let partial_dir = std::path::Path::new(&config.storage.path).join("partial");
        paracord_transport::file_transfer::PartialUploadManager::spawn_cleanup_task(
            partial_dir,
            shutdown_notify.clone(),
        );
        tracing::info!("QUIC file transfer enabled (sharing native media QUIC endpoint)");
    }

    paracord_api::install_http_rate_limiter();
    paracord_api::spawn_http_rate_limiter_cleanup(shutdown_notify.clone());

    // The two first-owner files hold a credential that is spent the instant
    // somebody finishes setting the server up. The route that finishes it lives
    // in `paracord-api`, which has no business reaching into this process's
    // config directory — so the moment is watched for here instead of leaving a
    // dead secret readable on disk until the next restart.
    if setup_state.is_some() {
        spawn_claim_file_cleanup(
            state.db.clone(),
            args.config.clone(),
            shutdown_notify.clone(),
        );
    }

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
        state.clone(),
        shutdown_notify.clone(),
    );
    spawn_federation_delivery_worker(state.clone(), shutdown_notify.clone());
    spawn_federation_moderation_worker(state.clone(), shutdown_notify.clone());
    spawn_scheduled_message_worker(state.clone(), shutdown_notify.clone());
    spawn_sports_announce_worker(state.clone(), shutdown_notify.clone());
    spawn_reminder_worker(state.clone(), shutdown_notify.clone());
    spawn_disappearing_message_worker(state.clone(), shutdown_notify.clone());
    spawn_scheduled_event_worker(state.clone(), shutdown_notify.clone());
    spawn_member_index_reconcile_worker(state.clone(), shutdown_notify.clone());
    bots::spawn_bot_manager(state.clone(), shutdown_notify.clone());

    // The shutdown path publishes the restart notice on this bus, so it needs
    // the state after the router has taken ownership of it.
    let shutdown_state = state.clone();
    let router = paracord_api::build_router(&state)
        .merge(paracord_ws::gateway_router())
        .with_state(state);

    // ── Web UI serving ───────────────────────────────────────────────────────
    // `build_router` applies its middleware with `.layer(...)`, which only wraps
    // the routes registered before it. The UI is attached here, afterwards, so
    // it was landing OUTSIDE the security-header middleware: the SPA document
    // and every static asset came back with no `X-Frame-Options`, no
    // `frame-ancestors`, no `nosniff` and no COOP/CORP, leaving the
    // authenticated UI frameable. The document's `<meta>` CSP still constrained
    // `script-src`, but a meta tag cannot express `frame-ancestors`.
    //
    // Only the header middleware is re-applied — never CSRF or the rate
    // limiter, which would double-count.
    let web_ui_status;
    let app = if let Some(ref dir) = web_dir {
        web_ui_status = format!("Serving from {:?}", dir);
        router.fallback_service(web_ui::external_router(dir))
    } else {
        #[cfg(feature = "embed-ui")]
        {
            web_ui_status = "Embedded".to_string();
            router.merge(embedded_ui::router().layer(axum::middleware::from_fn(
                paracord_api::security_headers_middleware,
            )))
        }
        #[cfg(not(feature = "embed-ui"))]
        {
            web_ui_status = "None (API-only mode)".to_string();
            router
        }
    };

    let listener = tokio::net::TcpListener::bind(&config.server.bind_address)
        .await
        .map_err(|err| {
            anyhow::anyhow!(describe_http_bind_error(&err, &config.server.bind_address))
        })?;
    // Counted from here on, so the drain deadline can say what it gave up on.
    // The no-op `tap_io` is not decoration: `SocketAddr: Connected<..>` — what
    // `into_make_service_with_connect_info` needs, and what every handler that
    // reads a client IP depends on — is implemented for `TcpListener` and for
    // any tapped listener, and the orphan rule forbids implementing it here for
    // a listener of our own. Going through `TapIo` is how a custom listener
    // keeps connect info.
    let listener = axum::serve::ListenerExt::tap_io(CountingListener(listener), |_io| {});

    // ── TLS / HTTPS setup ───────────────────────────────────────────────────
    let tls_enabled = config.tls.enabled;
    let tls_rustls_config = if tls_enabled {
        Some(
            tls::ensure_certs(
                &config.tls,
                detected_external_ip.as_deref(),
                detected_local_ip.as_deref(),
            )
            .await
            .context("TLS is enabled but certificate setup failed; refusing to serve credentials over plaintext HTTP")?,
        )
    } else {
        None
    };

    let tls_status = if let Some(ref _cfg) = tls_rustls_config {
        format!("Enabled (port {})", tls_port)
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

    // Loudly refuse to be silent about serving auth tokens over cleartext.
    // When the server is bound to a non-loopback interface (LAN/WAN/Docker
    // 0.0.0.0) with no active TLS, every login, JWT access/refresh token and
    // session/CSRF cookie crosses the wire in plaintext and can be captured by
    // any on-path attacker. This is the insecure Docker/quick-start default, so
    // make it impossible to miss and tell the operator exactly how to fix it.
    if !bind_is_loopback && tls_rustls_config.is_none() {
        tracing::warn!("============================================================");
        tracing::warn!("  SECURITY WARNING: serving plaintext HTTP on a public bind!");
        tracing::warn!("");
        tracing::warn!(
            "  Bind address {} is not loopback and TLS is not active.",
            config.server.bind_address
        );
        tracing::warn!("  Auth tokens, session cookies and all traffic are sent in");
        tracing::warn!("  cleartext and can be captured by anyone on the network.");
        tracing::warn!("");
        tracing::warn!("  Do NOT expose this port to a LAN/WAN as-is. Either:");
        tracing::warn!("    - terminate TLS at a reverse proxy in front (Caddy/nginx), or");
        tracing::warn!("    - set PARACORD_TLS_ENABLED=true (self-signed bootstrap/ACME), or");
        tracing::warn!("    - keep the port reachable only from localhost/a trusted proxy.");
        if config.server.public_url.is_some() {
            tracing::warn!("");
            tracing::warn!("  public_url is configured, so remote clients are expected:");
            tracing::warn!("  plaintext exposure here is an active account-takeover risk.");
        }
        tracing::warn!("============================================================");
    }

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

    let share_url = derive_share_url(
        &config.server.public_url,
        &config.server.bind_address,
        detected_local_ip.as_deref(),
        tls_rustls_config.is_some(),
        tls_port,
        bind_port,
    );

    // Collect the router attempt started at the top of startup. Everything since
    // then — migrations, workers, TLS — ran alongside it, so on a cooperative
    // network this is already done and on a silent one it has already spent its
    // own bounded budget rather than adding to boot time.
    let port_mapping = match portmap_start {
        PortMapStart::Skipped(reason) => portmap::Attempt {
            outcome: portmap::Outcome::Skipped(reason),
            router: None,
        },
        PortMapStart::Running(handle) => match handle.await {
            Ok(attempt) => attempt,
            Err(err) => portmap::Attempt {
                outcome: portmap::Outcome::NotAvailable {
                    external_ip: None,
                    reason: format!("the port-mapping attempt did not finish ({err})"),
                },
                router: None,
            },
        },
    };
    let port_mapping_outcome = port_mapping.outcome.with_fallback_ip(
        detected_external_ip
            .as_deref()
            .and_then(|ip| ip.parse::<std::net::IpAddr>().ok()),
    );
    port_mapping_outcome.log(portmap_request);
    if let Some(router) = port_mapping.router.as_ref() {
        portmap::spawn_renewal(
            Arc::clone(router),
            portmap_request,
            portmap_lease,
            shutdown_notify.clone(),
        );
    }
    // Moved into the shutdown path below, so the mappings this process asked for
    // are taken back down when it leaves.
    let port_mapping_release = port_mapping
        .router
        .clone()
        .map(|router| (router, portmap_request));

    let tls_active = tls_rustls_config.is_some();
    let self_made_certificate = certificate_is_self_made(&config.tls, tls_active);
    let invite = invite_lines(
        &port_mapping_outcome,
        &share_url,
        detected_local_ip.as_deref(),
        if tls_active { "https" } else { "http" },
        server_public_port,
        config.voice.port,
    );

    // What an invite link should point at. The app asks for this when the owner
    // is on `localhost`, where their own address bar is no use to a friend.
    paracord_core::share_address::set_share_address(share_address_for(
        &port_mapping_outcome,
        config.server.public_url.as_deref(),
        &share_url,
        if tls_active { "https" } else { "http" },
        server_public_port,
    ));

    // The link the owner clicks, with the one-time code already in it. Built here
    // because it needs the address the banner is about to print.
    if let Some(pending) = setup_state.as_mut() {
        record_claim_link(
            pending,
            &share_url,
            &config.server.bind_address,
            tls_active,
            tls_port,
            bind_port,
            &args.config,
        );
    }

    print_startup_banner(
        &config.server.bind_address,
        &share_url,
        config.first_run,
        setup_state.as_ref(),
        &livekit_status,
        &config.database.url,
        &port_mapping_outcome,
        &web_ui_status,
        &tls_status,
        tls_active,
        tls_port,
        self_made_certificate,
        &invite,
        &voice_status,
    );

    // Graceful shutdown on ctrl-c / ctrl-break / SIGTERM.
    //
    // The API-triggered restart path is intentionally unwired: the
    // `admin::restart_update` endpoint is permanently disabled for security
    // (it returns Forbidden and never signals shutdown), so no in-process
    // caller fires `shutdown_notify`. Only OS signals initiate shutdown here.
    let shutdown_signal_http_handle = shutdown_signal.clone();
    // Told when the shutdown future returns, i.e. when axum actually starts
    // draining connections, so the drain deadline below times the drain itself.
    let (drain_started_tx, drain_started_rx) = tokio::sync::oneshot::channel::<()>();
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
            }
        }
        #[cfg(not(windows))]
        {
            // SIGTERM is how a restart actually reaches this process: it is
            // what `systemctl restart` sends (the units written by
            // scripts/install.sh take the default KillSignal), what `docker
            // stop` sends, and what a supervisor sends. Listening for SIGINT
            // alone meant the whole graceful path below — worker grace period,
            // managed LiveKit teardown, and now the restart notice — ran only
            // when an operator pressed ctrl-c in a foreground terminal.
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("failed to install SIGTERM handler");
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {
                    println!();
                    tracing::info!("Shutting down (ctrl-c)...");
                }
                _ = terminate.recv() => {
                    tracing::info!("Shutting down (SIGTERM)...");
                }
            }
        }

        // Tell everyone who is connected before the sockets go. The client
        // shows "Server is restarting — you'll reconnect automatically" and
        // holds its place instead of reporting a bare connection loss; without
        // this the banner was unreachable UI that no crate ever emitted.
        shutdown_state
            .event_bus
            .dispatch("SERVER_RESTART", serde_json::json!({}), None);
        // Long enough for the gateway's send loop to put the frame on the wire,
        // short enough that it costs nothing an operator would notice.
        tokio::time::sleep(RESTART_NOTICE_FLUSH).await;

        // Latch the signal. This does two things at once:
        //
        // - wakes every background worker (retention, backups, federation
        //   delivery, scheduled/disappearing messages, bot manager, rate-limit
        //   and attachment cleanup, ...). They park on `shutdown.notified()`
        //   inside their select loops, so one `notify_waiters()` wakes them all;
        // - tells the long-lived connection handlers to end. The realtime SSE
        //   stream and every gateway session watch this latch and close as soon
        //   as it is set — the notice above is already on the wire by now.
        //   Without that, `with_graceful_shutdown` waited on connections that
        //   are open by design until a client closes them, and any attached
        //   browser meant the process never exited at all.
        shutdown_signal_http_handle.trigger();

        // Give workers a bounded grace period to finish the current iteration
        // (e.g. a retention or backup batch already in flight) before we return
        // and let axum tear down the HTTP servers. The connections are closing
        // themselves concurrently, so this costs the drain nothing.
        tokio::time::sleep(WORKER_SHUTDOWN_GRACE).await;

        if let Some(mut lk) = managed_livekit {
            lk.kill().await;
        }

        // Close the doors this process asked the router to open. Bounded inside
        // `release`, so a router that stopped answering cannot hold a restart
        // hostage — an entry left behind expires with its lease either way.
        if let Some((router, request)) = port_mapping_release {
            portmap::release(router, request).await;
        }

        // From here axum waits for whatever is still open; start the clock.
        let _ = drain_started_tx.send(());
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
            _ = connection_drain_deadline(drain_started_rx) => {
                warn_drain_deadline_expired();
            }
        }
    } else {
        // HTTP only
        let server = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(shutdown_signal_http);

        tokio::select! {
            result = server => { result?; }
            _ = connection_drain_deadline(drain_started_rx) => {
                warn_drain_deadline_expired();
            }
        }
    }

    Ok(())
}

/// Report an exit that did not wait for every connection to close.
fn warn_drain_deadline_expired() {
    tracing::warn!(
        "Exiting after a {}s drain deadline: {}. A restart does not wait on a client that \
         will not let go.",
        CONNECTION_DRAIN_DEADLINE.as_secs(),
        open_connection_summary()
    );
}

/// Run the `migrate-to-postgres` subcommand: copy a SQLite database into a
/// PostgreSQL database and print a per-table report.
async fn run_migrate_to_postgres(args: &cli::MigrateToPostgresArgs) -> Result<()> {
    if args.dry_run {
        tracing::info!(
            "Dry run: applying target schema migrations and seeds, validating column maps and \
             counting source rows (no source rows will be copied)"
        );
    } else {
        tracing::info!(
            "Migrating SQLite -> PostgreSQL (row copy and repairs commit together after target \
             schema migrations). Ensure both databases are offline and the SQLite file is idle."
        );
    }

    let report = paracord_db::migrate_export::migrate_sqlite_to_postgres(
        &args.source,
        &args.target,
        i64::from(args.batch_size),
        args.dry_run,
    )
    .await
    .map_err(|e| {
        anyhow::anyhow!("migration failed; target schema migrations may remain applied: {e}")
    })?;

    for table in &report.tables {
        if report.dry_run {
            tracing::info!(
                "  {:<32} {:>4} cols  {:>10} rows",
                table.table,
                table.columns,
                table.source_rows
            );
        } else {
            tracing::info!(
                "  {:<32} {:>4} cols  {:>10} rows copied",
                table.table,
                table.columns,
                table.copied_rows
            );
        }
    }

    if report.dry_run {
        tracing::info!(
            "Dry run complete: {} tables, {} source rows. No source rows copied; target schema \
             migrations and seeds remain applied.",
            report.tables.len(),
            report.total_source_rows()
        );
    } else {
        tracing::info!(
            "Migration complete: {} tables, {} rows copied and verified.",
            report.tables.len(),
            report.total_copied_rows()
        );
        tracing::info!(
            "Repaired {} channel message tails and committed a new database history epoch.",
            report.repaired_channel_tails
        );
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
        let contents = format!("{key_hex}\n");
        // Create the key file with restrictive permissions BEFORE writing any
        // bytes so the freshly generated Ed25519 key never exists on disk in a
        // world-readable state. A plain write honors the umask (typically 0644)
        // and only chmods afterward — a TOCTOU exposure on multi-tenant hosts.
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
                .with_context(|| {
                    format!(
                        "failed to create federation signing key file '{}'",
                        path.display()
                    )
                })?;
            file.write_all(contents.as_bytes()).with_context(|| {
                format!(
                    "failed to write federation signing key file '{}'",
                    path.display()
                )
            })?;
        }
        #[cfg(not(unix))]
        {
            std::fs::write(path, &contents).with_context(|| {
                format!(
                    "failed to write federation signing key file '{}'",
                    path.display()
                )
            })?;
            harden_secret_file_permissions(path);
        }
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

/// Turn a native-media provisioning failure into a concrete, operator-actionable
/// message. Address-in-use is by far the most common cause, so name the exact UDP
/// port and point at the fix; otherwise surface the underlying error verbatim.
fn describe_media_bind_error(err: &anyhow::Error, media_port: u16) -> String {
    let addr_in_use = err
        .chain()
        .filter_map(|cause| cause.downcast_ref::<std::io::Error>())
        .any(|io_err| io_err.kind() == std::io::ErrorKind::AddrInUse);
    if addr_in_use {
        format!(
            "UDP port {media_port} is already in use, so the native QUIC voice \
             endpoint could not bind it. Stop whatever is holding UDP/{media_port} \
             (another server instance?), or set [voice] port to a free UDP port, \
             then restart. (underlying error: {err})"
        )
    } else {
        format!("failed to bind the native QUIC media endpoint on UDP port {media_port}: {err}")
    }
}

/// Turn a failure to bind the HTTP listener into a concrete, operator-actionable
/// message. A bare `Address already in use (os error 98)` gives an operator
/// nothing to act on — it names neither the address nor the fix — and this is
/// the single most likely way a first run fails (a second instance, or the
/// default port already taken). Mirrors `describe_media_bind_error`.
fn describe_http_bind_error(err: &std::io::Error, bind_address: &str) -> String {
    match err.kind() {
        std::io::ErrorKind::AddrInUse => format!(
            "Address {bind_address} is already in use, so Paracord could not start \
             its HTTP listener. Stop whatever is holding it (another server \
             instance?), or set [server] bind_address to a free port, then \
             restart. (underlying error: {err})"
        ),
        std::io::ErrorKind::PermissionDenied => format!(
            "Permission denied binding {bind_address}. Ports below 1024 need root \
             or CAP_NET_BIND_SERVICE; set [server] bind_address to a port above \
             1024, or run Paracord behind a reverse proxy. (underlying error: {err})"
        ),
        std::io::ErrorKind::AddrNotAvailable => format!(
            "Address {bind_address} is not available on this host — no interface \
             owns that IP. Set [server] bind_address to an address this machine \
             has (for example 0.0.0.0:8090 to listen on all of them). \
             (underlying error: {err})"
        ),
        _ => format!("failed to bind the HTTP listener on {bind_address}: {err}"),
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
        // Known secret shipped in docker-compose.yml — never let it pass as-is.
        || secret_lower.contains("paracord-local-dev")
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

/// ALPN protocols the unified media port advertises: `h3` for browser
/// WebTransport, `paracord-media` for raw QUIC desktop and federation peers.
const MEDIA_ALPN_PROTOCOLS: [&[u8]; 2] = [b"h3", b"paracord-media"];

/// Enough of a pin to correlate a rotation in the log with what a client saw,
/// without printing a full fingerprint on every line.
fn cert_hash_prefix(hash: &str) -> &str {
    let end = hash
        .char_indices()
        .nth(12)
        .map(|(idx, _)| idx)
        .unwrap_or(hash.len());
    &hash[..end]
}

fn format_timestamp(at: std::time::SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(at).to_rfc3339()
}

/// Keep the media certificate inside the window browsers accept.
///
/// A browser accepts a WebTransport `serverCertificateHashes` pin only when the
/// certificate is valid for at most 14 days, so the media certificate is issued
/// for 13 (`paracord_transport::endpoint::MEDIA_CERT_LIFETIME`). A server that
/// runs longer than that would keep presenting an expired certificate and every
/// browser join would fail, so this task regenerates it roughly every 7 days —
/// or immediately if the live certificate is already inside its last 3 days —
/// and republishes the pin.
///
/// Sessions already established are unaffected: QUIC authenticates once, at
/// handshake, so swapping the endpoint's server config only changes what *new*
/// handshakes see. The endpoint swap happens before the published pin changes,
/// so there is no window in which a client is handed a pin the port does not
/// yet present.
fn spawn_media_certificate_rotation(
    endpoint: Arc<paracord_transport::endpoint::MediaEndpoint>,
    cert_hash: paracord_core::MediaCertHash,
    initial_not_after: std::time::SystemTime,
    shutdown: Arc<tokio::sync::Notify>,
) {
    use paracord_transport::endpoint::{generate_media_certificate, media_cert_rotation_delay};

    tokio::spawn(async move {
        let mut not_after = initial_not_after;
        loop {
            let delay = media_cert_rotation_delay(std::time::SystemTime::now(), not_after);
            tokio::select! {
                _ = shutdown.notified() => break,
                _ = tokio::time::sleep(delay) => {}
            }

            match generate_media_certificate() {
                Ok(generated) => {
                    // Present the new certificate first, publish the new pin
                    // second: a client that reads the pin between the two steps
                    // would otherwise pin a certificate the port is not serving.
                    if let Err(err) = endpoint.set_certificate(&generated.tls) {
                        tracing::error!(
                            "Media certificate rotation failed to install the new certificate: {err}. \
                             Retrying; the current certificate expires at {}.",
                            format_timestamp(not_after)
                        );
                        // Back off rather than spinning on a persistent failure.
                        tokio::select! {
                            _ = shutdown.notified() => break,
                            _ = tokio::time::sleep(std::time::Duration::from_secs(300)) => {}
                        }
                        continue;
                    }
                    cert_hash.store(generated.hash.clone());
                    not_after = generated.not_after;
                    tracing::info!(
                        "Rotated the native media certificate: pin {}… valid until {}. \
                         Established voice sessions are unaffected; new joins use the new pin.",
                        cert_hash_prefix(&generated.hash),
                        format_timestamp(not_after)
                    );
                }
                Err(err) => {
                    tracing::error!(
                        "Media certificate rotation failed to generate a certificate: {err}. \
                         Retrying; the current certificate expires at {}.",
                        format_timestamp(not_after)
                    );
                    tokio::select! {
                        _ = shutdown.notified() => break,
                        _ = tokio::time::sleep(std::time::Duration::from_secs(300)) => {}
                    }
                }
            }
        }
    });
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

/// Periodically reload the guild membership index from the database so it
/// self-heals any drift left by missed GUILD_MEMBER_ADD/REMOVE events. The index
/// is built once at startup; between reloads the event-driven mutators keep it
/// hot, and this reconcile pass is the backstop against permanent desync.
fn spawn_member_index_reconcile_worker(
    state: paracord_core::AppState,
    shutdown: Arc<tokio::sync::Notify>,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // Consume the immediate first tick: the index was just loaded at startup.
        interval.tick().await;
        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                _ = interval.tick() => {
                    match paracord_db::members::get_all_memberships(&state.db).await {
                        Ok(rows) => state.member_index.reconcile(rows),
                        Err(err) => tracing::warn!(
                            "member index reconcile skipped: failed to load memberships: {err}"
                        ),
                    }
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

fn spawn_reminder_worker(state: paracord_core::AppState, shutdown: Arc<tokio::sync::Notify>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                _ = interval.tick() => {
                    if let Err(err) = paracord_api::routes::reminders::fire_due_reminders(
                        &state,
                        chrono::Utc::now(),
                    )
                    .await
                    {
                        tracing::warn!("reminder worker failed: {err}");
                    }
                }
            }
        }
    });
}

fn spawn_sports_announce_worker(
    state: paracord_core::AppState,
    shutdown: Arc<tokio::sync::Notify>,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                _ = interval.tick() => {
                    paracord_api::routes::sports_announce::announce_due(&state).await;
                }
            }
        }
    });
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
        if paracord_db::scheduled_messages::reconcile_committed_delivery(&state.db, &scheduled)
            .await?
        {
            continue;
        }
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
                reference_id: scheduled.reference_id,
                allow_empty_content: allow_empty,
                dm_e2ee,
                nonce: Some(scheduled.delivery_nonce()),
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

        // A receipt may return the message committed by an earlier worker run
        // whose mark-sent operation failed. Replays must not re-notify recipients.
        if message.id != msg_id {
            continue;
        }
        let payload =
            paracord_api::routes::channels::message_to_json(state, &message, scheduled.author_id)
                .await;
        if let Some(guild_id) = channel.guild_id() {
            state
                .event_bus
                .dispatch_message(&state.db, "MESSAGE_CREATE", payload, Some(guild_id))
                .await;
        } else {
            let recipients =
                paracord_db::dms::get_dm_recipient_ids(&state.db, scheduled.channel_id).await?;
            state
                .event_bus
                .dispatch_message_to_users(&state.db, "MESSAGE_CREATE", payload, recipients)
                .await;
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
                        .dispatch_message(&state.db, "MESSAGE_DELETE_BULK", payload, Some(guild_id))
                        .await;
                } else {
                    let recipients = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id)
                        .await
                        .unwrap_or_default();
                    state
                        .event_bus
                        .dispatch_message_to_users(
                            &state.db,
                            "MESSAGE_DELETE_BULK",
                            payload,
                            recipients,
                        )
                        .await;
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
/// Compute the single URL an operator should open in a browser and share with
/// others. Prefers an explicit `public_url`; otherwise derives one from the
/// detected LAN IP (or the bind host) using the scheme and port that actually
/// accept connections. Pure and side-effect-free so it can be unit-tested.
fn derive_share_url(
    public_url: &Option<String>,
    bind_address: &str,
    detected_local_ip: Option<&str>,
    tls_active: bool,
    tls_port: u16,
    bind_port: u16,
) -> String {
    if let Some(url) = public_url {
        let url = url.trim_end_matches('/');
        // When TLS is active but public_url was written as http://, present the
        // HTTPS form on the TLS port so the shared link actually connects.
        if tls_active {
            if let Some(host) = url.strip_prefix("http://") {
                let host_no_port = host.split(':').next().unwrap_or(host);
                return format!("https://{host_no_port}:{tls_port}");
            }
        }
        return url.to_string();
    }

    let scheme = if tls_active { "https" } else { "http" };
    let port = if tls_active { tls_port } else { bind_port };

    let bind_is_loopback = bind_address.starts_with("127.0.0.1:")
        || bind_address.starts_with("localhost:")
        || bind_address.starts_with("[::1]:");
    // Host portion of the bind address (everything before the final ':').
    let bind_host = bind_address
        .rsplit_once(':')
        .map(|(host, _)| host)
        .unwrap_or(bind_address);
    let host = if bind_is_loopback {
        "localhost"
    } else if let Some(ip) = detected_local_ip {
        ip
    } else if bind_host.is_empty() || bind_host == "0.0.0.0" || bind_host == "[::]" {
        // Wildcard bind with no detectable LAN IP: localhost is the only
        // address guaranteed to resolve on this machine.
        "localhost"
    } else {
        bind_host
    };
    format!("{scheme}://{host}:{port}")
}

/// Where an owner can find the bootstrap credential for a server that nobody has
/// finished setting up yet, and (for a freshly minted one) the token itself.
pub struct PendingSetup {
    /// The plaintext token, shown only when this process minted or was handed
    /// it. `None` when a token from a previous run is being reused and the
    /// plaintext is no longer available in memory.
    token: Option<String>,
    /// Where the token came from, in words an operator can act on.
    source: String,
    /// Path of the 0600 file the token was written to, when one was written.
    token_file: Option<String>,
    /// The one link that finishes setup, with the token already in it. Built
    /// once the startup path knows which address to print, so it is filled in
    /// after `provision_instance_setup` returns.
    link: Option<String>,
    /// Path of the 0600 file that link was written to, when one was written.
    link_file: Option<String>,
    /// The same link built on the server's shared address, when that differs
    /// from the one above (a LAN or public address versus this machine's own).
    remote_link: Option<String>,
}

/// Decide, before the server can accept a request, whether this instance still
/// needs a first owner — and if so make sure exactly one bootstrap credential
/// exists for it.
///
/// Returns `Some` while the instance is unclaimed, so the startup banner can
/// tell the operator what to do. Never derives the answer from the user count
/// or from whether a config file exists: the `instance_setup` row decides.
async fn provision_instance_setup(
    db: &paracord_db::DbPool,
    config: &config::Config,
    config_path: &str,
) -> Result<Option<PendingSetup>> {
    let row = paracord_db::instance_setup::get(db)
        .await
        .context("Failed to read instance setup state")?;
    if !row.is_pending() {
        // Setup is finished, so the bootstrap credential is spent. Both files
        // that carried it are useless from this moment on, and a spent secret
        // lying around on disk is only a liability — take them away.
        remove_claim_files(config_path);
        return Ok(None);
    }

    if !config.setup.require_claim {
        paracord_db::instance_setup::complete_bootstrap(db, chrono::Utc::now())
            .await
            .context("Failed to record the bootstrap completion of instance setup")?;
        tracing::warn!(
            target: "paracord::setup",
            "[setup] require_claim is false: the FIRST account registered on this server becomes its owner. \
             Anyone who reaches this server before you do will own it. Use this only for automated deployments."
        );
        return Ok(None);
    }

    // A token pinned in configuration wins: it is what a provisioning system or
    // a test harness expects to be able to present, and it is reproducible
    // across restarts by construction.
    if let Some(configured) = config
        .setup
        .claim_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if configured.chars().count() < paracord_core::instance_setup::MIN_CLAIM_TOKEN_LEN {
            anyhow::bail!(
                "[setup] claim_token must be at least {} characters; it is the only credential \
                 protecting ownership of this server",
                paracord_core::instance_setup::MIN_CLAIM_TOKEN_LEN
            );
        }
        let hash = paracord_core::instance_setup::hash_claim_token(configured);
        paracord_db::instance_setup::set_claim_token(
            db,
            &hash,
            paracord_db::instance_setup::TOKEN_SOURCE_CONFIG,
            chrono::Utc::now(),
        )
        .await
        .context("Failed to store the configured setup claim token")?;
        return Ok(Some(PendingSetup {
            token: Some(configured.to_string()),
            source: format!("[setup] claim_token in {config_path}"),
            token_file: None,
            link: None,
            link_file: None,
            remote_link: None,
        }));
    }

    // Otherwise reuse the token this server minted on an earlier run, as long
    // as the file it was written to still holds the matching secret. A missing
    // or edited file means the operator no longer has the token, so churning it
    // is the useful behaviour — and it is announced rather than silent.
    let token_path = claim_token_file_path(config_path);
    let token_path_display = token_path.display().to_string();
    if row.claim_token_source.as_deref()
        == Some(paracord_db::instance_setup::TOKEN_SOURCE_GENERATED)
    {
        if let Some(stored_hash) = row.claim_token_hash.as_deref() {
            if let Ok(contents) = std::fs::read_to_string(&token_path) {
                let existing = contents.trim();
                if paracord_core::instance_setup::claim_token_matches(existing, stored_hash) {
                    return Ok(Some(PendingSetup {
                        token: Some(existing.to_string()),
                        source: "generated on a previous start".to_string(),
                        token_file: Some(token_path_display),
                        link: None,
                        link_file: None,
                        remote_link: None,
                    }));
                }
            }
            tracing::warn!(
                target: "paracord::setup",
                path = %token_path_display,
                "the previously generated setup claim token file is missing or no longer matches; minting a new token"
            );
        }
    }

    let token = paracord_core::instance_setup::generate_claim_token();
    let hash = paracord_core::instance_setup::hash_claim_token(&token);
    paracord_db::instance_setup::set_claim_token(
        db,
        &hash,
        paracord_db::instance_setup::TOKEN_SOURCE_GENERATED,
        chrono::Utc::now(),
    )
    .await
    .context("Failed to store the generated setup claim token")?;

    let token_file = match write_claim_token_file(&token_path, &token) {
        Ok(()) => Some(token_path_display.clone()),
        Err(err) => {
            // Not fatal: the token is also printed below. But say so, because
            // an operator who scrolls past the banner has nowhere else to look.
            tracing::error!(
                target: "paracord::setup",
                path = %token_path_display,
                error = %err,
                "could not write the setup claim token file; the token below is the only copy"
            );
            None
        }
    };

    Ok(Some(PendingSetup {
        token: Some(token),
        source: "generated for this first run".to_string(),
        token_file,
        link: None,
        link_file: None,
        remote_link: None,
    }))
}

/// A file beside the config file, by name.
fn config_sibling_path(config_path: &str, name: &str) -> std::path::PathBuf {
    let base = std::path::Path::new(config_path);
    match base
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        Some(parent) => parent.join(name),
        None => std::path::PathBuf::from(name),
    }
}

/// `first-owner-claim.txt`, beside the config file. Its content is exactly the
/// token: installers read this file, so the format is fixed.
fn claim_token_file_path(config_path: &str) -> std::path::PathBuf {
    config_sibling_path(config_path, "first-owner-claim.txt")
}

/// `first-owner-claim-link.txt`, beside the config file. Its content is exactly
/// the finish-setup link, token included — the thing a human actually needs.
fn claim_link_file_path(config_path: &str) -> std::path::PathBuf {
    config_sibling_path(config_path, "first-owner-claim-link.txt")
}

/// Delete both bootstrap files, ignoring the ones that are not there.
///
/// Called the moment this process sees that setup is finished, because from then
/// on the token they hold opens nothing and is only worth stealing.
fn remove_claim_files(config_path: &str) {
    for path in [
        claim_token_file_path(config_path),
        claim_link_file_path(config_path),
    ] {
        match std::fs::remove_file(&path) {
            Ok(()) => tracing::info!(
                target: "paracord::setup",
                path = %path.display(),
                "removed a spent first-owner file: this server already has an owner"
            ),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => tracing::warn!(
                target: "paracord::setup",
                path = %path.display(),
                error = %err,
                "could not remove a spent first-owner file; delete it by hand"
            ),
        }
    }
}

/// Watch for the moment setup is finished, then take the bootstrap files away.
///
/// Polling is the honest mechanism here: the claim is completed by an HTTP route
/// in another crate, the check is one tiny row read, the task only exists while
/// this server has no owner, and it ends the first time it fires.
fn spawn_claim_file_cleanup(
    db: paracord_db::DbPool,
    config_path: String,
    shutdown: Arc<tokio::sync::Notify>,
) {
    const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);
    tokio::spawn(async move {
        let mut warned = false;
        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                _ = tokio::time::sleep(POLL_INTERVAL) => {
                    match paracord_db::instance_setup::get(&db).await {
                        Ok(row) if !row.is_pending() => {
                            remove_claim_files(&config_path);
                            break;
                        }
                        Ok(_) => {}
                        Err(err) => {
                            if !warned {
                                warned = true;
                                tracing::warn!(
                                    target: "paracord::setup",
                                    error = %err,
                                    "could not check whether setup is finished; the first-owner \
                                     files will be removed on the next start instead"
                                );
                            }
                        }
                    }
                }
            }
        }
    });
}

/// Percent-encode a value for use inside a URL fragment.
///
/// A generated token is base32 and needs none of this, but a token pinned via
/// `[setup] claim_token` is whatever the operator typed — and a `#`, a space or
/// a `&` in it would silently truncate the link the owner clicks.
fn encode_fragment_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(char::from(*byte))
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// The one link that finishes setting up a server.
///
/// The token rides in the URL *fragment* on purpose: a fragment is never sent to
/// any server and never reaches an access log or a proxy log, so pasting this
/// link somewhere does not leak the credential the way a query string would. The
/// web client reads `#claim=` and fills the field in.
fn build_claim_link(base_url: &str, token: &str) -> String {
    format!(
        "{}/setup-server#claim={}",
        base_url.trim_end_matches('/'),
        encode_fragment_value(token)
    )
}

/// Which address to build the finish-setup link on.
///
/// The banner's shared address is the right thing to hand to other people, but
/// it is not always the right thing for the person sitting at this machine: a
/// non-loopback HTTPS address means a certificate tied to a name or IP the local
/// browser may not match. When this machine can reach the server over loopback —
/// which it can whenever the bind address is a wildcard or loopback itself — the
/// link the owner clicks is built there instead. The base is produced by
/// `derive_share_url`, the same function the banner uses, so there is exactly one
/// piece of URL logic in this file.
fn claim_link_base(
    share_url: &str,
    bind_address: &str,
    tls_active: bool,
    tls_port: u16,
    bind_port: u16,
) -> String {
    let reachable_on_this_machine = {
        let host = bind_address
            .rsplit_once(':')
            .map(|(host, _)| host)
            .unwrap_or(bind_address);
        host.is_empty()
            || host == "0.0.0.0"
            || host == "[::]"
            || host == "::"
            || host == "127.0.0.1"
            || host == "localhost"
            || host == "[::1]"
    };
    let shared_host_is_local = share_url.contains("//localhost")
        || share_url.contains("//127.0.0.1")
        || share_url.contains("//[::1]");

    if share_url.starts_with("https://") && !shared_host_is_local && reachable_on_this_machine {
        return derive_share_url(
            &None,
            &format!("127.0.0.1:{bind_port}"),
            None,
            tls_active,
            tls_port,
            bind_port,
        );
    }
    share_url.to_string()
}

/// Build the finish-setup link, write it beside the token file, and record both
/// on the pending state so the banner can print them.
fn record_claim_link(
    pending: &mut PendingSetup,
    share_url: &str,
    bind_address: &str,
    tls_active: bool,
    tls_port: u16,
    bind_port: u16,
    config_path: &str,
) {
    let Some(token) = pending.token.as_deref() else {
        return;
    };
    let local_base = claim_link_base(share_url, bind_address, tls_active, tls_port, bind_port);
    let link = build_claim_link(&local_base, token);
    let shared_link = build_claim_link(share_url, token);
    pending.remote_link = (shared_link != link).then_some(shared_link);

    // Only write the link file when a token file was written too: a token pinned
    // in the config is a secret the operator already holds, and copying it onto
    // disk would widen its exposure for nothing.
    if pending.token_file.is_some() {
        let path = claim_link_file_path(config_path);
        match write_owner_only_line(&path, &link) {
            Ok(()) => pending.link_file = Some(path.display().to_string()),
            Err(err) => tracing::error!(
                target: "paracord::setup",
                path = %path.display(),
                error = %err,
                "could not write the finish-setup link file; the link below is the only copy"
            ),
        }
    }
    pending.link = Some(link);
}

/// Write the token with owner-only permissions, established before any bytes
/// are written so there is no window in which another local user can read it.
fn write_claim_token_file(path: &std::path::Path, token: &str) -> std::io::Result<()> {
    write_owner_only_line(path, token)
}

/// Write one line to a file only the account running the server can read.
///
/// The mode is set as the file is created rather than chmod-ed afterwards, so
/// there is no window in which another local user can read the secret.
fn write_owner_only_line(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;

    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    // A leftover file from a previous run must not keep its old contents or its
    // old permissions.
    let _ = std::fs::remove_file(path);

    #[cfg(unix)]
    let mut file = {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?
    };
    #[cfg(not(unix))]
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;

    writeln!(file, "{contents}")?;
    file.sync_all()?;
    Ok(())
}

/// The block printed whenever nobody has finished setting this server up.
///
/// One clickable link is the whole point: the token is already in it, as a URL
/// *fragment*, which no server and no proxy ever sees. The bare token stays
/// below it as the fallback for a terminal that mangles long links — and because
/// installers and the release smoke test read it from the log.
fn print_claim_instructions(share_url: &str, pending: &PendingSetup) {
    println!();
    println!("  ┌─ This server has no owner yet ─────────────────────");
    println!("  │");
    match pending.link.as_deref() {
        Some(link) => {
            println!("  │  Finish setting up — open this link:");
            println!("  │       {link}");
            if let Some(remote) = pending.remote_link.as_deref() {
                println!("  │");
                println!("  │  From another computer, the same page is at:");
                println!("  │       {remote}");
            }
        }
        None => {
            println!("  │  Finish setting up — open this page:");
            println!("  │       {share_url}/setup-server");
        }
    }
    println!("  │");
    match pending.token.as_deref() {
        Some(token) => {
            println!("  │  If the link does not fill in the code for you, paste");
            println!("  │  it in by hand. One-time claim token");
            println!("  │  ({}):", pending.source);
            println!("  │       {token}");
        }
        None => {
            println!("  │  One-time claim token: {}", pending.source);
        }
    }
    let saved: Vec<&str> = [pending.link_file.as_deref(), pending.token_file.as_deref()]
        .into_iter()
        .flatten()
        .collect();
    if !saved.is_empty() {
        println!("  │");
        println!("  │  Also saved, readable only by the account running this");
        println!("  │  server:");
        for path in saved {
            println!("  │       {path}");
        }
    }
    println!("  │");
    println!("  │  Until someone does this, nobody can create an");
    println!("  │  account here — including anyone who finds this");
    println!("  │  address before you do.");
    println!("  │");
    println!("  └────────────────────────────────────────────────────");
}

/// `host:port`, with an IPv6 literal bracketed so it can be pasted into a
/// browser as-is.
fn format_host_port(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// The port numbers a friend outside this network has to be able to reach, as
/// one phrase.
///
/// Two different settings hide behind them: the TCP port a browser reaches the
/// app on, and `[voice] port`, the UDP port that carries voice and video. The
/// generated config puts both at 8443, which is why one number read correctly
/// for so long; the moment either moves, naming only the first sends someone to
/// open a port that carries no calls.
fn forwarded_ports_phrase(web_port: u16, voice_port: u16) -> String {
    if web_port == voice_port {
        format!("port {web_port} (TCP and UDP)")
    } else {
        format!("port {web_port} (TCP) and port {voice_port} (UDP)")
    }
}

/// What the app should put in an invite link, and how far that link carries.
///
/// An operator's configured `public_url` is the last word. Otherwise a mapped
/// router with a known public address reaches the internet; anything else that
/// is not a loopback bind reaches the local network at the address the banner
/// already prints.
fn share_address_for(
    outcome: &portmap::Outcome,
    public_url: Option<&str>,
    share_url: &str,
    scheme: &str,
    public_port: u16,
) -> paracord_core::share_address::ShareAddress {
    use paracord_core::share_address::{ShareAddress, ShareReach};
    if let Some(url) = public_url.map(str::trim).filter(|url| !url.is_empty()) {
        return ShareAddress {
            url: Some(url.to_string()),
            reach: ShareReach::Internet,
        };
    }
    let is_loopback = |url: &str| {
        url.contains("://localhost") || url.contains("://127.") || url.contains("://[::1]")
    };
    match outcome {
        portmap::Outcome::Skipped(portmap::SkipReason::LoopbackBind) => ShareAddress {
            url: None,
            reach: ShareReach::ThisComputer,
        },
        portmap::Outcome::Mapped {
            external_ip: Some(ip),
            ..
        } => {
            let host = match ip {
                std::net::IpAddr::V6(v6) => format!("[{v6}]"),
                std::net::IpAddr::V4(v4) => v4.to_string(),
            };
            ShareAddress {
                url: Some(format!("{scheme}://{host}:{public_port}")),
                reach: ShareReach::Internet,
            }
        }
        _ if is_loopback(share_url) => ShareAddress {
            url: None,
            reach: ShareReach::ThisComputer,
        },
        _ => ShareAddress {
            url: Some(share_url.to_string()),
            reach: ShareReach::LocalNetwork,
        },
    }
}

/// The "Invite friends" paragraph, chosen from what the router actually did.
///
/// Pure and side-effect-free: this is the sentence a first-time owner acts on,
/// and it is the one part of the banner that must never overstate what works.
/// Every branch ends by naming what would have to change on the router, so the
/// reader is never left with "it did not work" and nothing to do about it.
fn invite_lines(
    outcome: &portmap::Outcome,
    share_url: &str,
    lan_ip: Option<&str>,
    scheme: &str,
    web_port: u16,
    voice_port: u16,
) -> Vec<String> {
    let ports = forwarded_ports_phrase(web_port, voice_port);
    let this_computer = match lan_ip {
        Some(ip) => format!("this computer ({ip})"),
        None => "this computer".to_string(),
    };

    match outcome {
        portmap::Outcome::Mapped {
            external_ip: Some(ip),
            ..
        } => vec![
            "Friends anywhere can join at:".to_string(),
            format!(
                "     {scheme}://{}",
                format_host_port(&ip.to_string(), web_port)
            ),
            "Paracord asked your router to allow that, so there is".to_string(),
            "nothing left for you to change on your router.".to_string(),
        ],
        portmap::Outcome::Mapped {
            external_ip: None, ..
        } => vec![
            "Your router is letting people in from outside, but it".to_string(),
            "did not say what this network's address is. Look it up".to_string(),
            "at https://ifconfig.me and give friends that address".to_string(),
            format!("with port {web_port}. There is nothing else to change"),
            "on your router.".to_string(),
        ],
        portmap::Outcome::Skipped(portmap::SkipReason::LoopbackBind) => vec![
            "Nobody else can reach this server yet: it is only".to_string(),
            "listening on this computer. To let other people in,".to_string(),
            "set bind_address = \"0.0.0.0:<port>\" in the config and".to_string(),
            "start it again — then friends outside your home also".to_string(),
            format!("need {ports} opened on your router."),
        ],
        portmap::Outcome::Skipped(portmap::SkipReason::Disabled) => vec![
            "Right now only people on the same Wi-Fi or network as".to_string(),
            "this computer can join, at:".to_string(),
            format!("     {share_url}"),
            String::new(),
            "Paracord was told not to ask your router for anything".to_string(),
            "([network] auto_port_forward = false). To let anyone".to_string(),
            format!("else in, {ports}"),
            format!("must reach {this_computer}."),
            "docs/port-forwarding.md walks through it — look for".to_string(),
            "\"port forwarding\" on your router.".to_string(),
        ],
        portmap::Outcome::Skipped(portmap::SkipReason::NotAskedYet) => vec![
            "When the server starts it asks your router to let".to_string(),
            "people outside your network in. If the router says no,".to_string(),
            "only people on the same Wi-Fi can join — and to change".to_string(),
            format!("that, {ports}"),
            "must reach this computer. docs/port-forwarding.md walks".to_string(),
            "through it — look for \"port forwarding\" on your router.".to_string(),
        ],
        portmap::Outcome::NotAvailable { external_ip, .. } => {
            let mut lines = vec![
                "Right now only people on the same Wi-Fi or network as".to_string(),
                "this computer can join, at:".to_string(),
                format!("     {share_url}"),
                String::new(),
                "Your router did not open the way in by itself. To let".to_string(),
                format!("anyone else in, {ports}"),
                format!("must reach {this_computer}."),
            ];
            if let Some(ip) = external_ip {
                lines.push(format!(
                    "Friends would then join at {scheme}://{}.",
                    format_host_port(&ip.to_string(), web_port)
                ));
            }
            lines.push("docs/port-forwarding.md walks through it step by step,".to_string());
            lines.push("including how to check it worked — look for".to_string());
            lines.push("\"port forwarding\" on your router.".to_string());
            lines
        }
    }
}

/// The plain sentence about the certificate this server made for itself.
///
/// Printed only when it applies, because a warning that does not happen is worse
/// than no warning: the owner starts distrusting the rest of the page.
const SELF_MADE_CERT_LINES: [&str; 3] = [
    "Your browser will show a one-time security warning",
    "because this server made its own certificate — choose",
    "Advanced, then Continue. The desktop app does not show this.",
];

/// True when HTTPS is on and the certificate is the one this server generated
/// for itself, rather than one from a certificate authority.
///
/// Derived from configuration rather than from the certificate bytes: with ACME
/// off and `auto_generate` on, the file at `cert_path` is the one this server
/// wrote. An operator who drops a CA-issued certificate at that path and leaves
/// `auto_generate = true` gets one sentence too many — the honest fix, and the
/// setting that says so, is `auto_generate = false`.
fn certificate_is_self_made(tls: &config::TlsConfig, tls_active: bool) -> bool {
    tls_active && !tls.acme.enabled && tls.auto_generate
}

/// What a person who has never run a server has to do next, in order.
///
/// Printed on a genuine first run and by `init`. `claim_link` is the one link
/// that finishes setup; `init` has no database yet, so it passes `None` and says
/// where the link will appear instead.
fn print_next_steps(
    share_url: &str,
    claim_link: Option<&str>,
    claim_required: bool,
    invite: &[String],
    self_made_certificate: bool,
) {
    println!();
    println!("  ┌─ Next steps ───────────────────────────────────────");
    println!("  │");
    // Step 1 has to match how this server actually bootstraps. Pointing someone
    // at a link that was never minted — because `require_claim` is off — sends
    // them looking for a secret that does not exist, and hides the fact that the
    // next person to register owns the server.
    if claim_required {
        println!("  │  1. Finish setting up — open this link:");
        match claim_link {
            Some(link) => println!("  │       {link}"),
            None => {
                println!("  │       {share_url}/setup-server");
                println!("  │     The first start prints the full link, with the");
                println!("  │     one-time code already in it.");
            }
        }
        println!("  │     It makes you the owner of this server: it creates");
        println!("  │     your OWNER account, gives the server its name and");
        println!("  │     opens its first channel. Nobody can create an");
        println!("  │     account here until you do. (Older guides and the");
        println!("  │     installer call this step \"Claim the server\".)");
    } else {
        println!("  │  1. Open this address and create your account:");
        println!("  │       {share_url}");
        println!("  │     This server is set to hand ownership to the FIRST");
        println!("  │     account that registers ([setup] require_claim =");
        println!("  │     false) — including a stranger who gets there before");
        println!("  │     you. Register yours now, or turn that setting back");
        println!("  │     on before sharing the address.");
    }
    println!("  │");
    if !invite.is_empty() {
        println!("  │  2. Invite friends:");
        for line in invite {
            if line.is_empty() {
                println!("  │");
            } else {
                println!("  │     {line}");
            }
        }
        println!("  │");
    }
    if self_made_certificate {
        let step = if invite.is_empty() { 2 } else { 3 };
        println!("  │  {step}. {}", SELF_MADE_CERT_LINES[0]);
        for line in &SELF_MADE_CERT_LINES[1..] {
            println!("  │     {line}");
        }
        println!("  │");
    }
    println!("  └────────────────────────────────────────────────────");
}

#[allow(clippy::too_many_arguments)]
fn print_startup_banner(
    bind_address: &str,
    share_url: &str,
    first_run: bool,
    pending_setup: Option<&PendingSetup>,
    livekit_status: &str,
    db_url: &str,
    port_mapping: &portmap::Outcome,
    web_ui: &str,
    tls_status: &str,
    tls_active: bool,
    tls_port: u16,
    self_made_certificate: bool,
    invite: &[String],
    voice_status: &str,
) {
    println!();
    println!("  ____                                     _");
    println!(" |  _ \\ __ _ _ __ __ _  ___ ___  _ __ __| |");
    println!(" | |_) / _` | '__/ _` |/ __/ _ \\| '__/ _` |");
    println!(" |  __/ (_| | | | (_| | (_| (_) | | | (_| |");
    println!(" |_|   \\__,_|_|  \\__,_|\\___\\___/|_|  \\__,_|");
    println!();
    // The one URL to open and share. Always shown so an operator never has to
    // reverse-engineer scheme/host/port from the raw bind address.
    println!("  ➜  Open / share:  {share_url}");
    println!();
    println!("  Listening:   http://{}", bind_address);
    if tls_active {
        println!("  HTTPS:       https://0.0.0.0:{}", tls_port);
    }
    // Redact any userinfo so a PostgreSQL password is never echoed to the
    // terminal or captured in startup logs.
    println!(
        "  Database:    {}",
        paracord_util::redact::redact_db_url(db_url)
    );
    println!("  Voice:       {}", voice_status);
    // Under the native-QUIC default LiveKit is inert; present it as an optional
    // add-on rather than a scary "Disabled" so operators don't think media is off.
    let livekit_line = if livekit_status.starts_with("Disabled") {
        "optional (not configured)"
    } else {
        livekit_status
    };
    println!("  LiveKit:     {}", livekit_line);
    println!("  Web UI:      {}", web_ui);
    println!("  TLS/HTTPS:   {}", tls_status);
    // The one line in this block a non-technical owner reads, so it is a plain
    // answer to a plain question rather than a protocol name.
    println!(
        "  Friends outside your network:  {}",
        port_mapping.status_line()
    );

    // A server nobody has finished setting up is the single most important thing
    // on this screen: nobody can register until someone does, and the credential
    // is shown once.
    if let Some(pending) = pending_setup {
        print_claim_instructions(share_url, pending);
    }

    if first_run {
        print_next_steps(
            share_url,
            pending_setup.and_then(|pending| pending.link.as_deref()),
            pending_setup.is_some(),
            invite,
            self_made_certificate,
        );
    } else if !port_mapping.is_mapped() && !invite.is_empty() {
        // Not a first run, so the Next-steps block is not printed — but the one
        // thing that still stands between this server and a friend who cannot
        // reach it does need saying, every time, until it is fixed.
        println!();
        println!("  ┌─ Letting friends outside your network in ──────────");
        println!("  │");
        for line in invite {
            if line.is_empty() {
                println!("  │");
            } else {
                println!("  │  {line}");
            }
        }
        println!("  │");
        println!("  └────────────────────────────────────────────────────");
    }
    println!();
}

/// `paracord-server init [--config PATH]`: generate the config (if missing) via
/// the canonical first-run path, print where it landed plus the share URL and
/// Next-steps block, then return so the process exits without starting.
/// An existing config is reported as ready and is never overwritten.
fn run_init(init_args: &cli::InitArgs, default_config: &str) -> Result<()> {
    let path = init_args.config.as_deref().unwrap_or(default_config);

    // Config::load generates the default file when absent (setting first_run)
    // and loads an existing file unchanged — it never overwrites. Reusing it
    // keeps `init` and the zero-config startup path byte-for-byte identical.
    let config = config::Config::load(path)?;

    if !config.first_run {
        println!();
        println!("  Config already exists at: {path}");
        println!("  It's ready — Paracord will use it on the next start.");
        println!("  Start the server with:  paracord-server -c {path}");
        println!();
        return Ok(());
    }

    let tls_active = config.tls.enabled;
    let bind_port: u16 = config
        .server
        .bind_address
        .rsplit(':')
        .next()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8090);
    let tls_port = config.tls.port;
    let web_port = if tls_active { tls_port } else { bind_port };
    let share_url = derive_share_url(
        &config.server.public_url,
        &config.server.bind_address,
        None,
        tls_active,
        tls_port,
        bind_port,
    );

    // `init` never opens a socket, so it cannot know what the router will say.
    // Describe the step the way a server that has not asked yet has to describe
    // it, rather than reporting a result it does not have.
    let invite = invite_lines(
        &portmap::Outcome::Skipped(portmap::SkipReason::NotAskedYet),
        &share_url,
        None,
        if tls_active { "https" } else { "http" },
        web_port,
        config.voice.port,
    );

    println!();
    println!("  Generated a new Paracord config at: {path}");
    print_next_steps(
        &share_url,
        None,
        config.setup.require_claim,
        &invite,
        certificate_is_self_made(&config.tls, tls_active),
    );
    println!();
    println!("  Start the server with:  paracord-server -c {path}");
    println!();
    // The one-time code needs the database, which `init` deliberately does not
    // open, so it is minted on the first real start. Say exactly where the link
    // will appear rather than leaving step 1 above hanging.
    if config.setup.require_claim {
        println!("  That first start prints the finish-setup link for step 1, and");
        println!("  saves it (readable only by the account running the server) as:");
        println!("      {}", claim_link_file_path(path).display());
        println!("  The one-time claim token on its own is saved as:");
        println!("      {}", claim_token_file_path(path).display());
        println!();
        println!("  To pin it in advance instead, set [setup] claim_token in the");
        println!("  config, or PARACORD_SETUP_CLAIM_TOKEN in the environment.");
        println!();
    }
    Ok(())
}

fn spawn_auto_backup(
    backup_config: config::BackupConfig,
    state: paracord_core::AppState,
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
                    match paracord_core::backup::create_backup_from_pool(
                        &state.db,
                        &state.config.database_url,
                        &backup_dir,
                        &state.config.storage_path,
                        &state.config.media_storage_path,
                        include_media,
                        matches!(state.storage_backend.as_ref(), paracord_media::Storage::Local(_)),
                        state.config.file_cryptor.as_ref(),
                        state.config.totp_cryptor.as_ref(),
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
///
/// Everything past authentication is bounded per participant (per-sender rate
/// limits, the 50-participant room cap, the relay's per-sender caches). This
/// loop is the only place an *unauthenticated* peer allocates server state, so
/// it enforces two bounds of its own:
///
/// 1. QUIC address validation (`Incoming::retry`). Without it a peer spoofing
///    source addresses makes the server allocate connection state for addresses
///    that never proved reachability. A retry costs one round trip and quinn
///    handles the token transparently, so legitimate clients only notice an
///    extra RTT on the very first connection.
/// 2. A [`PreAuthAdmission`] slot, global and per-IP, held from the start of the
///    handshake until the connection authenticates. Each pre-auth connection can
///    buffer up to the endpoint's datagram receive window before the relay is
///    willing to read anything from it, so the slot count is what converts
///    attacker uplink into server memory.
async fn unified_media_accept_loop(
    endpoint: Arc<paracord_transport::endpoint::MediaEndpoint>,
    relay: Arc<paracord_relay::relay::RelayForwarder>,
    jwt_secret: String,
    db: paracord_db::DbPool,
    files: Arc<file_transfer::FileTransferRuntime>,
) {
    let admission = Arc::new(paracord_transport::admission::PreAuthAdmission::new());
    tracing::info!(
        max_pending = paracord_transport::admission::MAX_PENDING_CONNECTIONS,
        max_pending_per_ip = paracord_transport::admission::MAX_PENDING_CONNECTIONS_PER_IP,
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

        // Address validation first: an unvalidated source gets a Retry, which
        // costs the server nothing but a token and proves the peer can receive
        // at the address it claims. Only validated peers reach the admission
        // ceiling below, so a spoofed source can never consume a slot.
        if !incoming.remote_address_validated() {
            if let Err(err) = incoming.retry() {
                tracing::debug!("Media incoming retry failed: {}", err);
            }
            continue;
        }

        let remote_ip = incoming.remote_address().ip();
        let permit = match admission.try_admit(remote_ip) {
            Ok(permit) => permit,
            Err(refusal) => {
                tracing::warn!(
                    addr = %incoming.remote_address(),
                    pending = admission.pending(),
                    "Media connection refused: {}",
                    refusal
                );
                incoming.refuse();
                continue;
            }
        };

        let relay = Arc::clone(&relay);
        let jwt_secret = jwt_secret.clone();
        let db = db.clone();
        let files = files.clone();
        tokio::spawn(async move {
            // `permit` is moved into whichever handler runs and released the
            // moment that connection authenticates, so an established call never
            // occupies a pre-auth slot for its lifetime. Every early return below
            // drops it here instead.
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
                handle_webtransport_connection(conn, relay, jwt_secret, db, files, permit).await;
            } else {
                handle_raw_quic_connection(conn, relay, jwt_secret, db, permit).await;
            }
        });
    }
}

/// Handle a raw QUIC media connection (desktop Tauri clients, federation).
///
/// `permit` is the pre-auth admission slot from [`unified_media_accept_loop`];
/// it is released as soon as the JWT validates so an established call does not
/// occupy a slot for its lifetime.
async fn handle_raw_quic_connection(
    conn: quinn::Connection,
    relay: Arc<paracord_relay::relay::RelayForwarder>,
    jwt_secret: String,
    db: paracord_db::DbPool,
    permit: paracord_transport::admission::AdmissionGuard,
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
    // Authenticated: release the pre-auth slot. Everything below this point is
    // bounded per user by the relay's own limits.
    drop(permit);
    tracing::info!(user_id, addr = %remote_addr, "QUIC: authenticated");

    let session_id = match media_conn.meta().session_id.as_deref() {
        Some(session_id) if !session_id.trim().is_empty() => session_id,
        _ => {
            tracing::warn!(user_id, "QUIC: media token missing session id");
            return;
        }
    };
    let auth_session_id = match media_conn.meta().auth_session_id.as_deref() {
        Some(session_id) if !session_id.trim().is_empty() => session_id,
        _ => {
            tracing::warn!(user_id, "QUIC: media token missing auth session id");
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

    if !is_media_session_active(&db, user_id, auth_session_id).await {
        tracing::warn!(user_id, "QUIC: media token session revoked or expired");
        return;
    }

    let handle = paracord_relay::relay::ConnectionHandle::new(
        user_id,
        room_id.clone(),
        session_id.to_string(),
        conn,
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
    tracing::info!(user_id, room_id = %room_id, "QUIC: relay forwarding started");
}

/// Reject media bridging when the auth session behind a media JWT has been
/// revoked or has expired. Media tokens carry a 24h `exp` (voice.rs) and no
/// rotating `jti`, so without this the REST/WS revocation applied by
/// `is_access_token_active` would not reach QUIC/WebTransport for up to a day.
/// Fails closed on any lookup error.
async fn is_media_session_active(db: &paracord_db::DbPool, user_id: i64, session_id: &str) -> bool {
    match paracord_db::sessions::get_session_by_id(db, session_id).await {
        Ok(Some(session)) => {
            session.user_id == user_id
                && session.revoked_at.is_none()
                && session.expires_at > chrono::Utc::now()
        }
        _ => false,
    }
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

    #[tokio::test]
    async fn is_media_session_active_rejects_revoked_expired_and_mismatched_sessions() -> Result<()>
    {
        let db = media_room_test_db().await?;
        let user_id = 903_001;
        let session_id = "media-auth-session";

        paracord_db::users::create_user(
            &db,
            user_id,
            "revokeuser",
            1,
            "revokeuser@example.com",
            "hash",
        )
        .await?;
        paracord_db::sessions::create_session(
            &db,
            session_id,
            user_id,
            "refresh-hash",
            "jti-1",
            None,
            None,
            None,
            None,
            chrono::Utc::now() + chrono::Duration::hours(1),
        )
        .await?;

        assert!(
            is_media_session_active(&db, user_id, session_id).await,
            "a live, unrevoked session must authorize media bridging"
        );
        assert!(
            !is_media_session_active(&db, user_id, "no-such-session").await,
            "missing sessions must fail closed"
        );
        assert!(
            !is_media_session_active(&db, user_id + 1, session_id).await,
            "a session belonging to another user must not authorize media"
        );

        // Revoking the underlying auth session must immediately cut off media,
        // even though the media JWT itself is still within its 24h exp.
        assert!(
            paracord_db::sessions::revoke_session(
                &db,
                session_id,
                user_id,
                "logout",
                chrono::Utc::now(),
            )
            .await?
        );
        assert!(
            !is_media_session_active(&db, user_id, session_id).await,
            "a revoked auth session must not authorize media bridging"
        );

        // An expired session must also be rejected.
        let expired_session = "media-auth-session-expired";
        paracord_db::sessions::create_session(
            &db,
            expired_session,
            user_id,
            "refresh-hash-2",
            "jti-2",
            None,
            None,
            None,
            None,
            chrono::Utc::now() - chrono::Duration::seconds(1),
        )
        .await?;
        assert!(
            !is_media_session_active(&db, user_id, expired_session).await,
            "an expired auth session must not authorize media bridging"
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
    files: Arc<file_transfer::FileTransferRuntime>,
    permit: paracord_transport::admission::AdmissionGuard,
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

    let mut wt_session = match tokio::time::timeout(
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

    if wt_session.path() == "/files" {
        files.handle_session(&mut wt_session, permit).await;
        return;
    }

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
    // The media-session receipt the relay fences this connection on. Taken from
    // the media JWT here, never from a later control frame.
    let media_session_id: String;

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
                        let auth_session_id = claims
                            .get("auth_sid")
                            .or_else(|| claims.get("auth_session_id"))
                            .and_then(|sid| sid.as_str())
                            .map(str::trim)
                            .filter(|sid| !sid.is_empty());
                        let Some(auth_session_id) = auth_session_id else {
                            tracing::warn!(addr = %remote_addr, "WebTransport: media token missing auth session id");
                            return;
                        };
                        let claimed_room = claims.get("room").and_then(|r| r.as_str());
                        media_session_id = session_id.to_string();
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

                        if !is_media_session_active(&db, user_id, auth_session_id).await {
                            tracing::warn!(
                                user_id,
                                "WebTransport: media token session revoked or expired"
                            );
                            return;
                        }

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

    // Authenticated: release the pre-auth slot (see `unified_media_accept_loop`).
    drop(permit);

    tracing::info!(
        user_id,
        room_id = %room_id,
        addr = %remote_addr,
        "WebTransport: authenticated"
    );

    // Spawn the datagram bridge with this session's own quarter stream id
    // (the CONNECT stream id / 4), so outbound media is attributed to the
    // session and inbound datagrams naming another one are dropped.
    let (outbound_tx, inbound_rx) = wt_session.spawn_datagram_bridge();

    // Create bridged connection handle and start forwarding. The handle gets
    // the session's stream framer, not the bare quinn connection: a browser's
    // control and keyframe streams are HTTP/3 WebTransport streams and must be
    // opened and accepted with the session header applied.
    let handle = paracord_relay::relay::ConnectionHandle::new_bridged(
        user_id,
        room_id.clone(),
        media_session_id,
        outbound_tx,
        inbound_rx,
        Some(wt_session.streams()),
    );
    relay.add_connection(handle.clone());
    relay.spawn_forwarding_task(handle.clone());
    relay.spawn_control_task(handle.clone());
    {
        let relay = relay.clone();
        let handle = handle.clone();
        tokio::spawn(async move {
            relay.send_initial_track_state(&handle).await;
        });
    }
    tracing::info!(
        user_id,
        room_id = %room_id,
        session_id = wt_session.session_id(),
        "WebTransport: relay forwarding started"
    );

    // Park here for the life of the call, holding the HTTP/3 connection and the
    // session's CONNECT stream. Both are load-bearing, not bookkeeping:
    // `h3::server::Connection::drop` closes the QUIC connection with
    // H3_NO_ERROR, and dropping the CONNECT request stream FINs it, which is
    // how a WebTransport session is torn down. Returning here without them
    // killed every browser call the instant forwarding started.
    //
    // `closed()` watches that CONNECT stream as well as the QUIC connection,
    // because a browser ends a session by closing the former and leaves the
    // latter warm — waiting only on the connection kept a departed participant
    // registered with the relay until the QUIC idle timeout.
    let closed = wt_session.closed().await;

    // Retiring the relay connection is transport-driven and lease-fenced: the
    // bridge task's `read_datagram` must fail for the forwarding task to run
    // its cleanup. When the session (rather than the connection) ended, the
    // connection is still alive, so close it — this handle's connection carries
    // exactly this session. If the account has already reconnected, this handle
    // no longer owns it and the lease fence makes the cleanup a no-op.
    handle.close("WebTransport session closed");
    drop(wt_session);
    drop(h3_session);
    tracing::info!(
        user_id,
        room_id = %room_id,
        reason = %closed,
        "WebTransport: session closed"
    );
}

#[cfg(test)]
mod tests {
    use super::forwarded_ports_phrase;

    /// The generated config puts the app and the media endpoint on the same
    /// 8443, and one number is the honest thing to print for it.
    #[test]
    fn coincident_ports_are_named_once() {
        assert_eq!(
            forwarded_ports_phrase(8443, 8443),
            "port 8443 (TCP and UDP)".to_string()
        );
    }

    /// The regression: with TLS off the app is on the bind port while voice
    /// stays on `[voice] port`, and naming only the first sent the operator to
    /// forward a port that carries no media.
    #[test]
    fn a_moved_voice_port_is_named_too() {
        let phrase = forwarded_ports_phrase(8090, 8443);
        assert!(phrase.contains("8090 (TCP)"), "{phrase}");
        assert!(phrase.contains("8443 (UDP)"), "{phrase}");
    }

    use super::{
        build_at_rest_profile, build_claim_link, certificate_is_self_made, claim_link_base,
        claim_link_file_path, claim_token_file_path, derive_share_url, describe_http_bind_error,
        encode_fragment_value, ensure_federation_signing_key_file, invite_lines,
        livekit_credentials_look_insecure, normalize_https_host, parse_detected_public_ip,
        remove_claim_files, share_address_for, write_owner_only_line,
    };
    use crate::portmap;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    // ── The one link that finishes setup ────────────────────────────────────

    /// The token rides in the fragment, after `#`, because a fragment is never
    /// sent to a server and so never lands in an access log or a proxy log. A
    /// query string would put the only credential that owns this server into
    /// every log between the browser and the process.
    #[test]
    fn the_claim_link_carries_the_token_in_a_fragment() {
        let link = build_claim_link("https://localhost:8443", "ABCDEF234567");
        assert_eq!(
            link,
            "https://localhost:8443/setup-server#claim=ABCDEF234567"
        );
        assert!(!link.contains('?'), "the token must not be a query: {link}");
        let (before_hash, _) = link.split_once('#').expect("a fragment");
        assert!(
            !before_hash.contains("ABCDEF234567"),
            "the token leaked into the part a server sees: {link}"
        );
        // A trailing slash on the base must not double up.
        assert_eq!(
            build_claim_link("https://localhost:8443/", "TOKEN"),
            "https://localhost:8443/setup-server#claim=TOKEN"
        );
    }

    /// A generated token is base32 and needs no escaping; a token pinned in the
    /// config is whatever the operator typed, and an unescaped `#`, `&` or space
    /// would silently truncate the link they click.
    #[test]
    fn a_pinned_token_is_escaped_into_a_usable_link() {
        assert_eq!(
            encode_fragment_value("plain-token_1.2~3"),
            "plain-token_1.2~3"
        );
        assert_eq!(encode_fragment_value("a b"), "a%20b");
        assert_eq!(
            encode_fragment_value("a#b&c=d/e?f"),
            "a%23b%26c%3Dd%2Fe%3Ff"
        );
        assert_eq!(encode_fragment_value("%"), "%25");

        let link = build_claim_link("https://localhost:8443", "tok en#with&junk");
        assert_eq!(
            link,
            "https://localhost:8443/setup-server#claim=tok%20en%23with%26junk"
        );
        // Everything after the single '#' is the fragment: no second '#' can cut
        // the token short.
        assert_eq!(link.matches('#').count(), 1, "{link}");
    }

    /// When the shared address is HTTPS on a LAN or public host, the link the
    /// owner clicks is the loopback one: it is the same server, and it avoids a
    /// certificate tied to a name this machine's browser may not match.
    #[test]
    fn the_link_prefers_the_address_this_machine_can_open() {
        assert_eq!(
            claim_link_base("https://192.168.1.5:8443", "0.0.0.0:8090", true, 8443, 8090),
            "https://localhost:8443"
        );
        assert_eq!(
            claim_link_base("https://chat.example.com", "0.0.0.0:8090", true, 8443, 8090),
            "https://localhost:8443"
        );

        // Plain HTTP has no certificate to mismatch, so the shared address is
        // already the friendliest thing to print.
        assert_eq!(
            claim_link_base("http://192.168.1.5:8090", "0.0.0.0:8090", false, 8443, 8090),
            "http://192.168.1.5:8090"
        );
        // Already local: nothing to prefer.
        assert_eq!(
            claim_link_base("https://localhost:8443", "127.0.0.1:8090", true, 8443, 8090),
            "https://localhost:8443"
        );
        // Bound to one specific LAN address: loopback would not answer, so the
        // shared address is the only honest one.
        assert_eq!(
            claim_link_base(
                "https://192.168.1.5:8443",
                "192.168.1.5:8090",
                true,
                8443,
                8090
            ),
            "https://192.168.1.5:8443"
        );
    }

    /// Both files are owner-only, and both go away the moment they are spent —
    /// a used bootstrap credential sitting on disk is only worth stealing.
    #[test]
    fn both_bootstrap_files_are_owner_only_and_removable_together() {
        let temp = tempfile::tempdir().expect("temp dir");
        let config_path = temp.path().join("paracord.toml");
        let config_path = config_path.to_str().expect("utf8 path");

        let token_path = claim_token_file_path(config_path);
        let link_path = claim_link_file_path(config_path);
        assert_eq!(token_path.file_name().unwrap(), "first-owner-claim.txt");
        assert_eq!(link_path.file_name().unwrap(), "first-owner-claim-link.txt");

        let link = build_claim_link("https://localhost:8443", "TOKEN234567");
        write_owner_only_line(&token_path, "TOKEN234567").expect("write token");
        write_owner_only_line(&link_path, &link).expect("write link");

        // The token file's format is fixed: installers read it, so it is exactly
        // the token and nothing else.
        assert_eq!(
            std::fs::read_to_string(&token_path).expect("read token"),
            "TOKEN234567\n"
        );
        assert_eq!(
            std::fs::read_to_string(&link_path)
                .expect("read link")
                .trim(),
            link
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [&token_path, &link_path] {
                let mode = std::fs::metadata(path)
                    .expect("metadata")
                    .permissions()
                    .mode()
                    & 0o777;
                assert_eq!(mode, 0o600, "{} is not owner-only", path.display());
            }
        }

        remove_claim_files(config_path);
        assert!(!token_path.exists(), "the spent token file survived");
        assert!(!link_path.exists(), "the spent link file survived");
        // Removing again is a no-op, not an error: a server that starts claimed
        // runs this on every boot.
        remove_claim_files(config_path);
    }

    // ── What the banner tells a first-time owner ────────────────────────────

    #[test]
    fn an_invite_points_where_friends_can_actually_reach_the_server() {
        use paracord_core::share_address::ShareReach;
        let lan = "https://192.168.1.20:8443";
        let mapped = portmap::Outcome::Mapped {
            external_ip: Some("203.0.113.7".parse().unwrap()),
            method: "UPnP",
        };
        let address = share_address_for(&mapped, None, lan, "https", 8443);
        assert_eq!(address.url.as_deref(), Some("https://203.0.113.7:8443"));
        assert_eq!(address.reach, ShareReach::Internet);

        // A configured public URL is the last word, whatever the router said.
        let address = share_address_for(
            &mapped,
            Some("https://chat.example.com"),
            lan,
            "https",
            8443,
        );
        assert_eq!(address.url.as_deref(), Some("https://chat.example.com"));

        let closed = portmap::Outcome::NotAvailable {
            external_ip: Some("203.0.113.7".parse().unwrap()),
            reason: "no router answered".into(),
        };
        let address = share_address_for(&closed, None, lan, "https", 8443);
        assert_eq!(address.url.as_deref(), Some(lan));
        assert_eq!(address.reach, ShareReach::LocalNetwork);

        // Never hand out a link to localhost.
        let loopback = portmap::Outcome::Skipped(portmap::SkipReason::LoopbackBind);
        let address = share_address_for(&loopback, None, "https://localhost:8443", "https", 8443);
        assert_eq!(address.url, None);
        assert_eq!(address.reach, ShareReach::ThisComputer);
        let address = share_address_for(&closed, None, "https://localhost:8443", "https", 8443);
        assert_eq!(address.url, None);
    }

    fn invite_text(outcome: &portmap::Outcome, lan_ip: Option<&str>) -> String {
        invite_lines(
            outcome,
            "https://192.168.1.5:8443",
            lan_ip,
            "https",
            8443,
            8443,
        )
        .join(" ")
    }

    /// Mapped: the one thing the owner wants to know is the address to give out,
    /// and that there is nothing left for them to do.
    #[test]
    fn a_mapped_router_names_the_address_friends_use() {
        let text = invite_text(
            &portmap::Outcome::Mapped {
                external_ip: Some("203.0.113.9".parse().unwrap()),
                method: "UPnP",
            },
            Some("192.168.1.5"),
        );
        assert!(text.contains("Friends anywhere can join at:"), "{text}");
        assert!(text.contains("https://203.0.113.9:8443"), "{text}");
        assert!(text.contains("nothing left for you to change"), "{text}");
        assert!(
            !text.contains("docs/port-forwarding.md"),
            "a working server must not send its owner to a router guide: {text}"
        );
    }

    /// An IPv6 public address has to be bracketed or it cannot be pasted into a
    /// browser at all.
    #[test]
    fn an_ipv6_address_is_bracketed_so_it_can_be_pasted() {
        let text = invite_text(
            &portmap::Outcome::Mapped {
                external_ip: Some("2001:db8::1".parse().unwrap()),
                method: "UPnP",
            },
            None,
        );
        assert!(text.contains("https://[2001:db8::1]:8443"), "{text}");
    }

    /// Not mapped: say plainly who can join now, then exactly what has to change
    /// and where the instructions are. Never "it failed" with nothing to do.
    #[test]
    fn a_router_that_did_not_answer_gets_a_plain_explanation_and_a_way_forward() {
        let text = invite_text(
            &portmap::Outcome::NotAvailable {
                external_ip: Some("203.0.113.9".parse().unwrap()),
                reason: "no UPnP router answered".to_string(),
            },
            Some("192.168.1.5"),
        );
        assert!(text.contains("same Wi-Fi or network"), "{text}");
        assert!(text.contains("https://192.168.1.5:8443"), "{text}");
        assert!(text.contains("port 8443 (TCP and UDP)"), "{text}");
        assert!(text.contains("this computer (192.168.1.5)"), "{text}");
        assert!(text.contains("docs/port-forwarding.md"), "{text}");
        assert!(text.contains("port forwarding"), "{text}");
        // The address a hand-made rule would be reachable at is still named.
        assert!(text.contains("https://203.0.113.9:8443"), "{text}");
    }

    /// A moved media port has to be named too, or the owner forwards a port that
    /// carries no calls and every outside caller is silent.
    #[test]
    fn a_split_port_pair_is_named_in_the_invite_text() {
        let text = invite_lines(
            &portmap::Outcome::NotAvailable {
                external_ip: None,
                reason: "no router answered".to_string(),
            },
            "http://192.168.1.5:8090",
            Some("192.168.1.5"),
            "http",
            8090,
            8443,
        )
        .join(" ");
        assert!(text.contains("port 8090 (TCP)"), "{text}");
        assert!(text.contains("port 8443 (UDP)"), "{text}");
    }

    /// Loopback: nobody else can reach this at all, and pretending port
    /// forwarding is the next step would send the owner to the wrong place.
    #[test]
    fn a_loopback_bind_says_nobody_else_can_reach_it_yet() {
        let text = invite_text(
            &portmap::Outcome::Skipped(portmap::SkipReason::LoopbackBind),
            None,
        );
        assert!(
            text.contains("Nobody else can reach this server yet"),
            "{text}"
        );
        assert!(text.contains("bind_address"), "{text}");
        assert!(
            !text.contains("Friends anywhere"),
            "a loopback server must not claim to be reachable: {text}"
        );
    }

    /// Turned off on purpose: say so, and say what the owner has to do instead.
    #[test]
    fn a_disabled_router_request_admits_it_was_disabled() {
        let text = invite_text(
            &portmap::Outcome::Skipped(portmap::SkipReason::Disabled),
            Some("192.168.1.5"),
        );
        assert!(text.contains("auto_port_forward = false"), "{text}");
        assert!(text.contains("docs/port-forwarding.md"), "{text}");
        assert!(text.contains("port 8443 (TCP and UDP)"), "{text}");
    }

    /// The instructions a first-time owner reads must not contain a word they
    /// would have to look up. The compact status block above them is allowed to
    /// stay technical; these lines are not.
    #[test]
    fn the_invite_text_never_uses_a_word_that_needs_looking_up() {
        let outcomes = [
            portmap::Outcome::Mapped {
                external_ip: Some("203.0.113.9".parse().unwrap()),
                method: "UPnP",
            },
            portmap::Outcome::Mapped {
                external_ip: None,
                method: "NAT-PMP/PCP",
            },
            portmap::Outcome::NotAvailable {
                external_ip: None,
                reason: "no UPnP router answered".to_string(),
            },
            portmap::Outcome::Skipped(portmap::SkipReason::LoopbackBind),
            portmap::Outcome::Skipped(portmap::SkipReason::Disabled),
            portmap::Outcome::Skipped(portmap::SkipReason::NotAskedYet),
        ];
        for outcome in &outcomes {
            let text = invite_text(outcome, Some("192.168.1.5")).to_lowercase();
            for jargon in [
                "quic",
                "sfu",
                "jwt",
                "self-signed",
                "instance",
                "operator",
                "upnp",
                "nat-pmp",
                "pcp",
                "igd",
                "claim token",
            ] {
                assert!(
                    !text.contains(jargon),
                    "invite text leaks {jargon:?} for {outcome:?}: {text}"
                );
            }
        }
    }

    /// Every branch ends by naming what would have to change on the router, so
    /// the reader is never left with a dead end — and the release smoke test
    /// anchors its log read on exactly this sentence ending.
    #[test]
    fn every_invite_branch_ends_by_naming_the_router() {
        let outcomes = [
            portmap::Outcome::Mapped {
                external_ip: Some("203.0.113.9".parse().unwrap()),
                method: "UPnP",
            },
            portmap::Outcome::Mapped {
                external_ip: None,
                method: "NAT-PMP/PCP",
            },
            portmap::Outcome::NotAvailable {
                external_ip: None,
                reason: "no UPnP router answered".to_string(),
            },
            portmap::Outcome::Skipped(portmap::SkipReason::LoopbackBind),
            portmap::Outcome::Skipped(portmap::SkipReason::Disabled),
            portmap::Outcome::Skipped(portmap::SkipReason::NotAskedYet),
        ];
        for outcome in &outcomes {
            let lines = invite_lines(
                outcome,
                "https://192.168.1.5:8443",
                Some("192.168.1.5"),
                "https",
                8443,
                8443,
            );
            let last = lines.last().expect("invite text is never empty");
            assert!(
                last.ends_with("on your router."),
                "{outcome:?} ends with {last:?}"
            );
        }
    }

    /// The certificate sentence is printed only when it is true: a warning the
    /// owner never sees teaches them to distrust the rest of the page.
    #[test]
    fn the_certificate_warning_only_applies_to_a_certificate_we_made() {
        let mut tls = crate::config::TlsConfig::default();
        assert!(tls.auto_generate);
        assert!(!tls.acme.enabled);
        assert!(certificate_is_self_made(&tls, true));
        // TLS off: there is no certificate and no warning.
        assert!(!certificate_is_self_made(&tls, false));
        // A real certificate from an authority produces no warning.
        tls.acme.enabled = true;
        assert!(!certificate_is_self_made(&tls, true));
        tls.acme.enabled = false;
        tls.auto_generate = false;
        assert!(!certificate_is_self_made(&tls, true));
    }

    #[test]
    fn http_bind_failure_names_the_address_and_the_fix() {
        // The most common first-run failure. A bare "Address already in use
        // (os error 98)" names neither the port nor anything to do about it.
        let message = describe_http_bind_error(
            &std::io::Error::from(std::io::ErrorKind::AddrInUse),
            "127.0.0.1:8090",
        );
        assert!(message.contains("127.0.0.1:8090"), "{message}");
        assert!(message.contains("bind_address"), "{message}");

        let denied = describe_http_bind_error(
            &std::io::Error::from(std::io::ErrorKind::PermissionDenied),
            "0.0.0.0:443",
        );
        assert!(denied.contains("0.0.0.0:443"), "{denied}");
        assert!(denied.contains("1024"), "{denied}");

        // Anything unexpected still says which address failed rather than only
        // the errno.
        let other = describe_http_bind_error(
            &std::io::Error::from(std::io::ErrorKind::Other),
            "10.0.0.5:8090",
        );
        assert!(other.contains("10.0.0.5:8090"), "{other}");
    }

    #[test]
    fn derive_share_url_prefers_public_url() {
        assert_eq!(
            derive_share_url(
                &Some("https://chat.example.com".to_string()),
                "0.0.0.0:8090",
                Some("192.168.1.5"),
                false,
                8443,
                8090,
            ),
            "https://chat.example.com"
        );
        // http public_url is upgraded to https on the TLS port when TLS is active.
        assert_eq!(
            derive_share_url(
                &Some("http://chat.example.com:8090".to_string()),
                "0.0.0.0:8090",
                None,
                true,
                8443,
                8090,
            ),
            "https://chat.example.com:8443"
        );
    }

    #[test]
    fn derive_share_url_uses_lan_ip_then_localhost() {
        // Wildcard bind + detected LAN IP → LAN IP with http scheme + bind port.
        assert_eq!(
            derive_share_url(
                &None,
                "0.0.0.0:8090",
                Some("192.168.1.5"),
                false,
                8443,
                8090
            ),
            "http://192.168.1.5:8090"
        );
        // Wildcard bind, no LAN IP, TLS active → localhost on the TLS port.
        assert_eq!(
            derive_share_url(&None, "0.0.0.0:8090", None, true, 8443, 8090),
            "https://localhost:8443"
        );
        // Loopback bind always resolves to localhost regardless of a LAN IP.
        assert_eq!(
            derive_share_url(
                &None,
                "127.0.0.1:8090",
                Some("192.168.1.5"),
                false,
                8443,
                8090
            ),
            "http://localhost:8090"
        );
    }

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
        // The 33-char default shipped in docker-compose.yml must be rejected
        // despite being long enough and matching no other placeholder token.
        assert!(livekit_credentials_look_insecure(
            "paracordlocal",
            "paracord-local-dev-livekit-secret",
        ));
        assert!(!livekit_credentials_look_insecure(
            "paracord_0123456789abcdef",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ));
    }

    #[test]
    fn at_rest_master_key_enables_totp_without_file_or_sqlite_targets() {
        let _guard = env_lock().lock().expect("env lock");
        const KEY_ENV: &str = "PARACORD_TEST_TOTP_ONLY_MASTER_KEY";
        std::env::set_var(KEY_ENV, format!("hex:{}", "11".repeat(32)));
        let mut config = crate::config::Config::default();
        config.at_rest.enabled = true;
        config.at_rest.encrypt_files = false;
        config.at_rest.encrypt_sqlite = false;
        config.at_rest.key_env = KEY_ENV.to_string();

        let profile = build_at_rest_profile(&config).expect("TOTP-only at-rest profile");
        std::env::remove_var(KEY_ENV);
        assert!(profile.totp_cryptor.is_some());
        assert!(profile.file_cryptor.is_none());
        assert!(profile.sqlite_key_hex.is_none());
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
