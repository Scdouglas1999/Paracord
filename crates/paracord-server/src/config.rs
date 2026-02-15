use anyhow::Result;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Default, Deserialize, Serialize)]
pub struct Config {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub auth: AuthConfig,
    pub storage: StorageConfig,
    #[serde(default)]
    pub media: MediaConfig,
    #[serde(default)]
    pub livekit: LiveKitConfig,
    #[serde(default)]
    pub federation: FederationConfig,
    #[serde(default)]
    pub network: NetworkConfig,
    #[serde(default)]
    pub tls: TlsConfig,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ServerConfig {
    pub bind_address: String,
    #[serde(default = "default_server_name")]
    pub server_name: String,
    /// Optional path to a directory containing the built web UI
    pub web_dir: Option<String>,
    /// Public URL of this server (e.g., https://chat.example.com).
    /// Used for CORS auto-configuration and invite links.
    pub public_url: Option<String>,
    /// Explicit list of allowed CORS origins. When empty, origins are
    /// derived from `public_url` or left open (development mode).
    #[serde(default)]
    pub allowed_origins: Vec<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind_address: "0.0.0.0:8080".into(),
            server_name: default_server_name(),
            web_dir: None,
            public_url: None,
            allowed_origins: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct DatabaseConfig {
    pub url: String,
    #[serde(default = "default_max_connections")]
    pub max_connections: u32,
}

impl Default for DatabaseConfig {
    fn default() -> Self {
        Self {
            url: "sqlite://./data/paracord.db?mode=rwc".into(),
            max_connections: default_max_connections(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AuthConfig {
    pub jwt_secret: String,
    #[serde(default = "default_jwt_expiry")]
    pub jwt_expiry_seconds: u64,
    #[serde(default = "default_true")]
    pub registration_enabled: bool,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            jwt_secret: generate_random_hex(64),
            jwt_expiry_seconds: default_jwt_expiry(),
            registration_enabled: true,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct StorageConfig {
    #[serde(default = "default_storage_type")]
    pub storage_type: String,
    #[serde(default = "default_storage_path")]
    pub path: String,
    #[serde(default = "default_max_upload_size")]
    pub max_upload_size: u64,
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            storage_type: default_storage_type(),
            path: default_storage_path(),
            max_upload_size: default_max_upload_size(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct MediaConfig {
    #[serde(default = "default_media_storage_path")]
    pub storage_path: String,
    #[serde(default = "default_max_file_size")]
    pub max_file_size: u64,
    #[serde(default = "default_p2p_threshold")]
    pub p2p_threshold: u64,
}

impl Default for MediaConfig {
    fn default() -> Self {
        Self {
            storage_path: default_media_storage_path(),
            max_file_size: default_max_file_size(),
            p2p_threshold: default_p2p_threshold(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct LiveKitConfig {
    #[serde(default = "default_livekit_key")]
    pub api_key: String,
    #[serde(default = "default_livekit_secret")]
    pub api_secret: String,
    #[serde(default = "default_livekit_url")]
    pub url: String,
    #[serde(default = "default_livekit_http_url")]
    pub http_url: String,
    /// Public LiveKit URL sent to clients (e.g., wss://chat.example.com/livekit).
    /// Falls back to `url` if not set.
    pub public_url: Option<String>,
}

impl Default for LiveKitConfig {
    fn default() -> Self {
        Self {
            api_key: format!("paracord_{}", generate_random_hex(8)),
            api_secret: generate_random_hex(32),
            url: default_livekit_url(),
            http_url: default_livekit_http_url(),
            public_url: None,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct NetworkConfig {
    /// Automatically forward ports via UPnP on startup (default: true).
    #[serde(default = "default_true")]
    pub upnp: bool,
    /// Lease duration in seconds for UPnP mappings (default: 3600 = 1 hour, auto-renewed).
    #[serde(default = "default_upnp_lease")]
    pub upnp_lease_seconds: u32,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            upnp: true,
            upnp_lease_seconds: default_upnp_lease(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TlsConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_tls_port")]
    pub port: u16,
    #[serde(default = "default_cert_path")]
    pub cert_path: String,
    #[serde(default = "default_key_path")]
    pub key_path: String,
    #[serde(default = "default_true")]
    pub auto_generate: bool,
}

impl Default for TlsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            port: default_tls_port(),
            cert_path: default_cert_path(),
            key_path: default_key_path(),
            auto_generate: true,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Default)]
pub struct FederationConfig {
    #[serde(default)]
    pub enabled: bool,
    pub signing_key_path: Option<String>,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Generate a cryptographically random hex string of the given length.
fn generate_random_hex(len: usize) -> String {
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| {
            let idx = rng.gen_range(0..16u8);
            char::from(if idx < 10 { b'0' + idx } else { b'a' + idx - 10 })
        })
        .collect()
}

fn default_server_name() -> String {
    "localhost".into()
}
fn default_max_connections() -> u32 {
    20
}
fn default_jwt_expiry() -> u64 {
    3600
}
fn default_true() -> bool {
    true
}
fn default_storage_type() -> String {
    "local".into()
}
fn default_storage_path() -> String {
    "./data/uploads".into()
}
fn default_max_upload_size() -> u64 {
    52_428_800 // 50MB
}
fn default_media_storage_path() -> String {
    "./data/files".into()
}
fn default_max_file_size() -> u64 {
    1_073_741_824 // 1GB
}
fn default_p2p_threshold() -> u64 {
    1_073_741_824 // 1GB
}
fn default_livekit_key() -> String {
    "devkey".into()
}
fn default_livekit_secret() -> String {
    "devsecret".into()
}
fn default_livekit_url() -> String {
    "ws://127.0.0.1:7880".into()
}
fn default_livekit_http_url() -> String {
    "http://127.0.0.1:7880".into()
}
fn default_upnp_lease() -> u32 {
    3600
}
fn default_tls_port() -> u16 {
    8443
}
fn default_cert_path() -> String {
    "./data/certs/cert.pem".into()
}
fn default_key_path() -> String {
    "./data/certs/key.pem".into()
}

/// Generate a commented config file template with the given values filled in.
fn generate_config_template(config: &Config) -> String {
    format!(
        r#"# Paracord Server Configuration
# Generated automatically on first run. Edit as needed.

[server]
bind_address = "{bind_address}"
server_name = "{server_name}"
# public_url is auto-detected via UPnP when not set.
# Set explicitly to override: public_url = "http://your-ip:8080"

[database]
url = "{db_url}"
max_connections = {max_connections}

[auth]
jwt_secret = "{jwt_secret}"
jwt_expiry_seconds = {jwt_expiry}
registration_enabled = {registration_enabled}

[storage]
storage_type = "{storage_type}"
path = "{storage_path}"

[media]
storage_path = "{media_path}"
max_file_size = {max_file_size}
p2p_threshold = {p2p_threshold}

[livekit]
api_key = "{lk_key}"
api_secret = "{lk_secret}"
url = "{lk_url}"
http_url = "{lk_http_url}"
# public_url is auto-detected via UPnP when not set.
# Set explicitly to override: public_url = "ws://your-ip:7880"

[federation]
enabled = false

[network]
# Automatically forward ports via UPnP on startup.
# When enabled, the server discovers your router, forwards the required ports,
# detects your public IP, and prints a shareable URL.
upnp = {upnp}
upnp_lease_seconds = {upnp_lease}

[tls]
# HTTPS support — required for getUserMedia() on non-localhost origins.
# A self-signed certificate is auto-generated on first run.
enabled = {tls_enabled}
port = {tls_port}
cert_path = "{tls_cert}"
key_path = "{tls_key}"
auto_generate = {tls_auto}
"#,
        bind_address = config.server.bind_address,
        server_name = config.server.server_name,
        db_url = config.database.url,
        max_connections = config.database.max_connections,
        jwt_secret = config.auth.jwt_secret,
        jwt_expiry = config.auth.jwt_expiry_seconds,
        registration_enabled = config.auth.registration_enabled,
        storage_type = config.storage.storage_type,
        storage_path = config.storage.path,
        media_path = config.media.storage_path,
        max_file_size = config.media.max_file_size,
        p2p_threshold = config.media.p2p_threshold,
        lk_key = config.livekit.api_key,
        lk_secret = config.livekit.api_secret,
        lk_url = config.livekit.url,
        lk_http_url = config.livekit.http_url,
        upnp = config.network.upnp,
        upnp_lease = config.network.upnp_lease_seconds,
        tls_enabled = config.tls.enabled,
        tls_port = config.tls.port,
        tls_cert = config.tls.cert_path,
        tls_key = config.tls.key_path,
        tls_auto = config.tls.auto_generate,
    )
}

// ── Config Loading ───────────────────────────────────────────────────────────

impl Config {
    pub fn load(path: &str) -> Result<Self> {
        let mut config = if std::path::Path::new(path).exists() {
            let content = fs::read_to_string(path)?;
            toml::from_str(&content)?
        } else {
            tracing::info!("Config file not found at '{}', generating defaults...", path);
            let config = Config::default();

            // Ensure parent directory exists
            if let Some(parent) = std::path::Path::new(path).parent() {
                fs::create_dir_all(parent)?;
            }

            let template = generate_config_template(&config);
            fs::write(path, &template)?;
            tracing::info!("Generated default config at '{}'", path);
            config
        };

        // Environment variable overrides
        if let Ok(value) = std::env::var("PARACORD_BIND_ADDRESS") {
            config.server.bind_address = value;
        }
        if let Ok(value) = std::env::var("PARACORD_SERVER_NAME") {
            config.server.server_name = value;
        }
        if let Ok(value) = std::env::var("PARACORD_WEB_DIR") {
            config.server.web_dir = Some(value);
        }
        if let Ok(value) = std::env::var("PARACORD_PUBLIC_URL") {
            config.server.public_url = Some(value);
        }
        if let Ok(value) = std::env::var("PARACORD_DATABASE_URL") {
            config.database.url = value;
        }
        if let Ok(value) = std::env::var("PARACORD_DATABASE_MAX_CONNECTIONS") {
            if let Ok(parsed) = value.parse::<u32>() {
                config.database.max_connections = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_JWT_SECRET") {
            config.auth.jwt_secret = value;
        }
        if let Ok(value) = std::env::var("PARACORD_JWT_EXPIRY_SECONDS") {
            if let Ok(parsed) = value.parse::<u64>() {
                config.auth.jwt_expiry_seconds = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_REGISTRATION_ENABLED") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.auth.registration_enabled = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_STORAGE_PATH") {
            config.storage.path = value;
        }
        if let Ok(value) = std::env::var("PARACORD_MEDIA_STORAGE_PATH") {
            config.media.storage_path = value;
        }
        if let Ok(value) = std::env::var("PARACORD_LIVEKIT_URL") {
            config.livekit.url = value;
        }
        if let Ok(value) = std::env::var("PARACORD_LIVEKIT_HTTP_URL") {
            config.livekit.http_url = value;
        }
        if let Ok(value) = std::env::var("PARACORD_LIVEKIT_API_KEY") {
            config.livekit.api_key = value;
        }
        if let Ok(value) = std::env::var("PARACORD_LIVEKIT_API_SECRET") {
            config.livekit.api_secret = value;
        }
        if let Ok(value) = std::env::var("PARACORD_LIVEKIT_PUBLIC_URL") {
            config.livekit.public_url = Some(value);
        }
        if let Ok(value) = std::env::var("PARACORD_UPNP") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.network.upnp = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_FEDERATION_ENABLED") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.federation.enabled = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_FEDERATION_SIGNING_KEY_PATH") {
            config.federation.signing_key_path = Some(value);
        }

        Ok(config)
    }
}
