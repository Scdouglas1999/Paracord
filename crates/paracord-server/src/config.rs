use anyhow::Result;
use paracord_media::S3Config;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::fs;

fn harden_secret_file_permissions(path: &str) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(windows)]
    {
        use std::process::Command;

        let principal_output = Command::new("whoami").output()?;
        if principal_output.status.success() {
            let principal = String::from_utf8_lossy(&principal_output.stdout)
                .trim()
                .to_string();
            if !principal.is_empty() {
                let _ = Command::new("icacls")
                    .args([path, "/inheritance:r"])
                    .status();
                let _ = Command::new("icacls")
                    .args([path, "/grant:r", &format!("{principal}:F")])
                    .status();
            }
        }
    }
    Ok(())
}

#[derive(Debug, Default, Deserialize, Serialize)]
pub struct Config {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub auth: AuthConfig,
    pub storage: StorageConfig,
    #[serde(default)]
    pub media: MediaConfig,
    /// Optional S3-compatible object storage configuration.
    /// Activated when `storage.storage_type = "s3"`.
    #[serde(default)]
    pub s3: S3Config,
    #[serde(default)]
    pub livekit: LiveKitConfig,
    #[serde(default)]
    pub voice: VoiceConfig,
    #[serde(default)]
    pub federation: FederationConfig,
    #[serde(default)]
    pub network: NetworkConfig,
    #[serde(default)]
    pub tls: TlsConfig,
    #[serde(default)]
    pub retention: RetentionConfig,
    #[serde(default)]
    pub at_rest: AtRestConfig,
    #[serde(default)]
    pub backup: BackupConfig,
    #[serde(default)]
    pub ai: AiConfig,
    #[serde(default)]
    pub integrations: IntegrationsConfig,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ServerConfig {
    pub bind_address: String,
    #[serde(default = "default_server_name")]
    pub server_name: String,
    /// Max entries for the permission cache in `paracord-core`.
    #[serde(default = "default_permission_cache_max_entries")]
    pub permission_cache_max_entries: u64,
    /// Optional path to a directory containing the built web UI
    pub web_dir: Option<String>,
    /// Public URL of this server (e.g., https://chat.example.com).
    /// Used for CORS auto-configuration and invite links.
    pub public_url: Option<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind_address: "0.0.0.0:8090".into(),
            server_name: default_server_name(),
            permission_cache_max_entries: default_permission_cache_max_entries(),
            web_dir: None,
            public_url: None,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct DatabaseConfig {
    #[serde(default = "default_database_engine")]
    pub engine: DatabaseEngine,
    pub url: String,
    #[serde(default = "default_max_connections")]
    pub max_connections: u32,
    /// Statement timeout in seconds for PostgreSQL connections (0 = disabled).
    #[serde(default)]
    pub statement_timeout_secs: u64,
    /// Idle-in-transaction timeout in seconds for PostgreSQL (0 = disabled).
    #[serde(default)]
    pub idle_in_transaction_timeout_secs: u64,
    /// Per-connection PostgreSQL `work_mem` in MB (0 = use server default).
    #[serde(default)]
    pub work_mem_mb: u32,
    /// Per-connection PostgreSQL `maintenance_work_mem` in MB (0 = use server default).
    #[serde(default)]
    pub maintenance_work_mem_mb: u32,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseEngine {
    Sqlite,
    Postgres,
}

impl Default for DatabaseEngine {
    fn default() -> Self {
        Self::Sqlite
    }
}

impl Default for DatabaseConfig {
    fn default() -> Self {
        Self {
            engine: default_database_engine(),
            url: "sqlite://./data/paracord.db?mode=rwc".into(),
            max_connections: default_max_connections(),
            statement_timeout_secs: 0,
            idle_in_transaction_timeout_secs: 0,
            work_mem_mb: 0,
            maintenance_work_mem_mb: 0,
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
    #[serde(default = "default_true")]
    pub allow_username_login: bool,
    #[serde(default = "default_false")]
    pub require_email: bool,
    #[serde(default = "default_false")]
    pub require_email_verification: bool,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            jwt_secret: generate_random_hex(64),
            jwt_expiry_seconds: default_jwt_expiry(),
            registration_enabled: true,
            allow_username_login: true,
            require_email: false,
            require_email_verification: false,
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
    #[serde(default = "default_max_guild_storage_quota")]
    pub max_guild_storage_quota: u64,
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            storage_type: default_storage_type(),
            path: default_storage_path(),
            max_upload_size: default_max_upload_size(),
            max_guild_storage_quota: default_max_guild_storage_quota(),
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

/// Native QUIC-based voice/video media server configuration.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VoiceConfig {
    /// Enable the native QUIC media server (replaces LiveKit when true).
    #[serde(default = "default_false")]
    pub native_media: bool,
    /// UDP port for the unified QUIC media endpoint.
    /// Defaults to the same port as TLS (8443) — TCP serves HTTPS while
    /// UDP on the same port handles both raw QUIC and WebTransport (via ALPN).
    /// Server admins only need to forward one port (TCP+UDP) for full functionality.
    #[serde(default = "default_voice_port")]
    pub port: u16,
    /// Maximum participants per voice room.
    #[serde(default = "default_voice_max_participants")]
    pub max_participants_per_room: u32,
    /// Opus bitrate in bits/s.
    #[serde(default = "default_voice_audio_bitrate")]
    pub audio_bitrate: u32,
    /// Require E2EE sender key exchange for all media sessions.
    #[serde(default = "default_true")]
    pub e2ee_required: bool,
}

impl Default for VoiceConfig {
    fn default() -> Self {
        Self {
            native_media: false,
            port: default_voice_port(),
            max_participants_per_room: default_voice_max_participants(),
            audio_bitrate: default_voice_audio_bitrate(),
            e2ee_required: true,
        }
    }
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
    /// On Windows, automatically add local firewall allow rules on startup.
    #[serde(default = "default_false")]
    pub windows_firewall_auto_allow: bool,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            windows_firewall_auto_allow: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
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
    #[serde(default)]
    pub acme: TlsAcmeConfig,
}

impl Default for TlsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            port: default_tls_port(),
            cert_path: default_cert_path(),
            key_path: default_key_path(),
            auto_generate: true,
            acme: TlsAcmeConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TlsAcmeConfig {
    #[serde(default = "default_false")]
    pub enabled: bool,
    #[serde(default = "default_acme_client_path")]
    pub client_path: String,
    #[serde(default = "default_acme_directory_url")]
    pub directory_url: String,
    pub email: Option<String>,
    #[serde(default)]
    pub domains: Vec<String>,
    #[serde(default = "default_acme_webroot_path")]
    pub webroot_path: String,
    #[serde(default = "default_acme_cert_name")]
    pub cert_name: String,
    pub cert_source_path: Option<String>,
    pub key_source_path: Option<String>,
    #[serde(default)]
    pub additional_args: Vec<String>,
    #[serde(default = "default_true")]
    pub serve_http_challenge: bool,
    #[serde(default = "default_true")]
    pub auto_renew: bool,
    #[serde(default = "default_acme_renew_interval_seconds")]
    pub renew_interval_seconds: u64,
}

impl Default for TlsAcmeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            client_path: default_acme_client_path(),
            directory_url: default_acme_directory_url(),
            email: None,
            domains: Vec::new(),
            webroot_path: default_acme_webroot_path(),
            cert_name: default_acme_cert_name(),
            cert_source_path: None,
            key_source_path: None,
            additional_args: Vec::new(),
            serve_http_challenge: true,
            auto_renew: true,
            renew_interval_seconds: default_acme_renew_interval_seconds(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RetentionConfig {
    #[serde(default = "default_false")]
    pub enabled: bool,
    #[serde(default = "default_retention_interval_seconds")]
    pub interval_seconds: u64,
    #[serde(default = "default_retention_batch_size")]
    pub batch_size: i64,
    pub message_days: Option<i64>,
    pub attachment_days: Option<i64>,
    pub audit_log_days: Option<i64>,
    pub security_event_days: Option<i64>,
    pub session_days: Option<i64>,
}

impl Default for RetentionConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_seconds: default_retention_interval_seconds(),
            batch_size: default_retention_batch_size(),
            message_days: None,
            attachment_days: None,
            audit_log_days: None,
            security_event_days: Some(30),
            session_days: Some(30),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AtRestConfig {
    #[serde(default = "default_false")]
    pub enabled: bool,
    #[serde(default = "default_at_rest_key_env")]
    pub key_env: String,
    #[serde(default = "default_false")]
    pub encrypt_sqlite: bool,
    #[serde(default = "default_false")]
    pub encrypt_files: bool,
    #[serde(default = "default_false")]
    pub allow_plaintext_file_reads: bool,
}

impl Default for AtRestConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            key_env: default_at_rest_key_env(),
            encrypt_sqlite: false,
            encrypt_files: false,
            allow_plaintext_file_reads: false,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct FederationConfig {
    #[serde(default)]
    pub enabled: bool,
    pub domain: Option<String>,
    #[serde(default = "default_federation_signing_key_path")]
    pub signing_key_path: Option<String>,
    #[serde(default = "default_false")]
    pub allow_discovery: bool,
    #[serde(default = "default_max_events_per_peer_per_minute")]
    pub max_events_per_peer_per_minute: Option<u32>,
    #[serde(default = "default_max_user_creates_per_peer_per_hour")]
    pub max_user_creates_per_peer_per_hour: Option<u32>,
    #[serde(default = "default_false")]
    pub file_cache_enabled: bool,
    #[serde(default = "default_federation_file_cache_max_size")]
    pub file_cache_max_size: u64,
    #[serde(default = "default_federation_file_cache_ttl_hours")]
    pub file_cache_ttl_hours: u64,
}

impl Default for FederationConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            domain: None,
            signing_key_path: default_federation_signing_key_path(),
            allow_discovery: false,
            max_events_per_peer_per_minute: default_max_events_per_peer_per_minute(),
            max_user_creates_per_peer_per_hour: default_max_user_creates_per_peer_per_hour(),
            file_cache_enabled: false,
            file_cache_max_size: default_federation_file_cache_max_size(),
            file_cache_ttl_hours: default_federation_file_cache_ttl_hours(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BackupConfig {
    #[serde(default = "default_backup_dir")]
    pub backup_dir: String,
    #[serde(default = "default_false")]
    pub auto_backup_enabled: bool,
    #[serde(default = "default_auto_backup_interval")]
    pub auto_backup_interval_seconds: u64,
    #[serde(default = "default_true")]
    pub include_media: bool,
    #[serde(default = "default_max_backups")]
    pub max_backups: u32,
}

impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            backup_dir: default_backup_dir(),
            auto_backup_enabled: false,
            auto_backup_interval_seconds: default_auto_backup_interval(),
            include_media: true,
            max_backups: default_max_backups(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AiConfig {
    /// Provider id: openai, anthropic, ollama, or openai_compatible.
    pub provider: Option<String>,
    /// Provider API base URL.
    pub base_url: Option<String>,
    /// API key for provider auth (if required).
    pub api_key: Option<String>,
    /// Default model used for summarize/catch-up requests.
    pub model: Option<String>,
    #[serde(default = "default_ai_timeout_seconds")]
    pub timeout_seconds: u64,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            provider: None,
            base_url: None,
            api_key: None,
            model: None,
            timeout_seconds: default_ai_timeout_seconds(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct IntegrationsConfig {
    /// Tenor API v2 key for GIF search. Obtain from Google Cloud Console.
    pub tenor_api_key: Option<String>,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Generate a cryptographically random hex string of the given length.
fn generate_random_hex(len: usize) -> String {
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| {
            let idx = rng.gen_range(0..16u8);
            char::from(if idx < 10 {
                b'0' + idx
            } else {
                b'a' + idx - 10
            })
        })
        .collect()
}

fn default_server_name() -> String {
    "localhost".into()
}
fn default_database_engine() -> DatabaseEngine {
    DatabaseEngine::Sqlite
}
fn default_max_connections() -> u32 {
    20
}
fn default_permission_cache_max_entries() -> u64 {
    10_000
}
fn default_jwt_expiry() -> u64 {
    900
}
fn default_true() -> bool {
    true
}
fn default_false() -> bool {
    false
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
    format!("paracord_{}", generate_random_hex(16))
}
fn default_livekit_secret() -> String {
    generate_random_hex(64)
}
fn default_livekit_url() -> String {
    "ws://127.0.0.1:7880".into()
}
fn default_livekit_http_url() -> String {
    "http://127.0.0.1:7880".into()
}
fn default_voice_port() -> u16 {
    8443
}
fn default_voice_max_participants() -> u32 {
    50
}
fn default_voice_audio_bitrate() -> u32 {
    96_000
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
fn default_acme_client_path() -> String {
    "certbot".into()
}
fn default_acme_directory_url() -> String {
    "https://acme-v02.api.letsencrypt.org/directory".into()
}
fn default_acme_webroot_path() -> String {
    "./data/acme-webroot".into()
}
fn default_acme_cert_name() -> String {
    "paracord".into()
}
fn default_acme_renew_interval_seconds() -> u64 {
    43_200
}
fn default_retention_interval_seconds() -> u64 {
    3600
}
fn default_retention_batch_size() -> i64 {
    256
}
fn default_at_rest_key_env() -> String {
    "PARACORD_AT_REST_KEY".into()
}
fn default_federation_signing_key_path() -> Option<String> {
    Some("./data/federation_signing_key.hex".into())
}
fn default_max_events_per_peer_per_minute() -> Option<u32> {
    Some(120)
}
fn default_max_user_creates_per_peer_per_hour() -> Option<u32> {
    Some(100)
}
fn default_max_guild_storage_quota() -> u64 {
    5_368_709_120 // 5GB
}
fn default_federation_file_cache_max_size() -> u64 {
    1_073_741_824 // 1GB
}
fn default_federation_file_cache_ttl_hours() -> u64 {
    168 // 7 days
}
fn default_backup_dir() -> String {
    "./data/backups".into()
}
fn default_auto_backup_interval() -> u64 {
    86_400 // 24 hours
}
fn default_max_backups() -> u32 {
    10
}
fn default_ai_timeout_seconds() -> u64 {
    20
}

fn looks_like_placeholder_secret(raw: &str) -> bool {
    let normalized = raw.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return true;
    }
    normalized.contains("change_me")
        || normalized.contains("replace_me")
        || normalized.contains("replace_with")
        || normalized.starts_with("example")
        || normalized == "devkey"
        || normalized == "devsecret"
        || normalized == "secret"
}

fn validate_secret_configuration(config: &Config) -> Result<()> {
    let jwt_secret = config.auth.jwt_secret.trim();
    if jwt_secret.len() < 32 || looks_like_placeholder_secret(jwt_secret) {
        anyhow::bail!(
            "Invalid auth.jwt_secret: use a strong random secret (at least 32 characters) and never leave placeholder values"
        );
    }

    let lk_key = config.livekit.api_key.trim();
    let lk_secret = config.livekit.api_secret.trim();
    if looks_like_placeholder_secret(lk_key) || looks_like_placeholder_secret(lk_secret) {
        anyhow::bail!(
            "Invalid livekit credentials: replace placeholder api_key/api_secret values before startup"
        );
    }

    Ok(())
}

/// Generate a commented config file template with the given values filled in.
fn generate_config_template(config: &Config) -> String {
    format!(
        r#"# Paracord Server Configuration
# Generated automatically on first run. Edit as needed.

[server]
bind_address = "{bind_address}"
server_name = "{server_name}"
permission_cache_max_entries = {permission_cache_max_entries}
# Set explicitly for internet-facing deployments:
# public_url = "https://your-domain-or-ip:8443"

[database]
engine = "{db_engine}"
url = "{db_url}"
max_connections = {max_connections}
# Optional PostgreSQL per-connection tuning (0 keeps server defaults).
work_mem_mb = {work_mem_mb}
maintenance_work_mem_mb = {maintenance_work_mem_mb}

[auth]
jwt_secret = "{jwt_secret}"
jwt_expiry_seconds = {jwt_expiry}
registration_enabled = {registration_enabled}
# Allow username logins for password auth (in addition to email).
allow_username_login = {allow_username_login}
# Require email during password registration.
require_email = {require_email}

[storage]
# Upload storage backend: "local" (default) or optional S3-compatible object storage.
# S3-compatible storage is disabled by default. To enable it, set storage_type = "s3",
# configure the [s3] section below, and build the server with `--features s3`.
storage_type = "{storage_type}"
path = "{storage_path}"

# [s3]
# # Optional S3-compatible object storage (MinIO, Cloudflare R2, AWS S3,
# # DigitalOcean Spaces, etc.).
# # Only used when storage.storage_type = "s3".
# bucket = "paracord-uploads"
# region = "us-east-1"
# # Custom endpoint for non-default providers:
# # endpoint_url = "https://minio.example.com"
# # force_path_style = true
# # access_key_id = "your-access-key"
# # secret_access_key = "your-secret-key"
# # Disabled by default. Set true only when intentionally using AWS env/profile/
# # SSO/instance-role credentials instead of explicit keys above.
# # use_aws_credential_chain = false
# # Optional key prefix for all objects:
# # prefix = "paracord/"
# # Optional CDN base URL (skips presigned URLs):
# # cdn_url = "https://cdn.example.com"
# # Presigned URL expiry (default 3600s):
# # presign_expiry_seconds = 3600

[media]
storage_path = "{media_path}"
max_file_size = {max_file_size}
p2p_threshold = {p2p_threshold}

[voice]
# Native QUIC/WebTransport voice stack. Disabled by default; enable this to
# make native media the primary path while keeping LiveKit as an optional fallback.
# Env override: PARACORD_VOICE_NATIVE_MEDIA
native_media = {voice_native_media}
# Unified UDP port for raw QUIC desktop clients and browser WebTransport.
# Forward this port over UDP in addition to the HTTPS TCP port.
# Env override: PARACORD_VOICE_PORT
port = {voice_port}
# Env override: PARACORD_VOICE_MAX_PARTICIPANTS_PER_ROOM
max_participants_per_room = {voice_max_participants}
# Env override: PARACORD_VOICE_AUDIO_BITRATE
audio_bitrate = {voice_audio_bitrate}
# Env override: PARACORD_VOICE_E2EE_REQUIRED
e2ee_required = {voice_e2ee_required}

[livekit]
api_key = "{lk_key}"
api_secret = "{lk_secret}"
url = "{lk_url}"
http_url = "{lk_http_url}"
# Optional public URL sent to clients:
# public_url = "wss://your-domain-or-ip:8443/livekit"

[federation]
enabled = {federation_enabled}
# domain = "chat.example.com"
# Hex-encoded ed25519 private key file used for federation request signing.
signing_key_path = "{federation_signing_key_path}"
allow_discovery = {federation_allow_discovery}
# Per-peer rate limit for inbound federation events (per minute). Set to 0 to disable.
# max_events_per_peer_per_minute = 120
# Per-peer rate limit for remote user creation (per hour). Set to 0 to disable.
# max_user_creates_per_peer_per_hour = 100

[network]
# On Windows, optionally auto-create local firewall allow rules.
windows_firewall_auto_allow = {windows_firewall_auto_allow}

[tls]
# HTTPS support — required for getUserMedia() on non-localhost origins.
# A self-signed certificate is auto-generated on first run.
enabled = {tls_enabled}
port = {tls_port}
cert_path = "{tls_cert}"
key_path = "{tls_key}"
auto_generate = {tls_auto}

[tls.acme]
# Optional ACME automation (certbot HTTP-01 webroot flow).
enabled = {acme_enabled}
client_path = "{acme_client_path}"
directory_url = "{acme_directory_url}"
# email = "ops@example.com"
# domains = ["chat.example.com"]
webroot_path = "{acme_webroot_path}"
cert_name = "{acme_cert_name}"
# Optional source overrides if your ACME client writes certs elsewhere.
# cert_source_path = "/etc/letsencrypt/live/paracord/fullchain.pem"
# key_source_path = "/etc/letsencrypt/live/paracord/privkey.pem"
serve_http_challenge = {acme_serve_http_challenge}
auto_renew = {acme_auto_renew}
renew_interval_seconds = {acme_renew_interval_seconds}
# additional_args = ["--preferred-challenges", "http"]

[retention]
# Data retention purge worker. Disabled by default.
enabled = {retention_enabled}
# How often to run retention jobs.
interval_seconds = {retention_interval}
# Maximum rows handled per category per tick.
batch_size = {retention_batch}
# Set to integer day values to enable each retention policy.
# message_days = 180
# attachment_days = 30
# audit_log_days = 365
# security_event_days = 180
# session_days = 90

[at_rest]
# Optional encryption-at-rest profile. Disabled by default.
enabled = {at_rest_enabled}
# Name of environment variable that contains the 32-byte master key
# (hex or base64 encoded).
key_env = "{at_rest_key_env}"
# SQLCipher mode for SQLite (requires SQLCipher-enabled SQLite build).
encrypt_sqlite = {at_rest_encrypt_sqlite}
# AES-256-GCM encryption for attachment payload bytes on disk.
encrypt_files = {at_rest_encrypt_files}
# During migration, allow reading older plaintext attachment files.
allow_plaintext_file_reads = {at_rest_allow_plaintext}

[backup]
# Backup configuration.
backup_dir = "{backup_dir}"
# Enable automatic periodic backups.
auto_backup_enabled = {backup_auto_enabled}
# Interval between automatic backups in seconds (default: 86400 = 24h).
auto_backup_interval_seconds = {backup_interval}
# Include media files (uploads, files) in backups.
include_media = {backup_include_media}
# Maximum number of backups to keep (oldest are pruned).
max_backups = {backup_max_backups}

[ai]
# Optional AI provider configuration used by summarize/catch-up features.
# Supported providers: "openai", "anthropic", "ollama", "openai_compatible"
# provider = "openai"
# base_url = "https://api.openai.com"
# api_key = "replace-with-provider-key"
# model = "gpt-4o-mini"
timeout_seconds = {ai_timeout_seconds}
"#,
        bind_address = config.server.bind_address,
        server_name = config.server.server_name,
        permission_cache_max_entries = config.server.permission_cache_max_entries,
        db_engine = match config.database.engine {
            DatabaseEngine::Sqlite => "sqlite",
            DatabaseEngine::Postgres => "postgres",
        },
        db_url = config.database.url,
        max_connections = config.database.max_connections,
        work_mem_mb = config.database.work_mem_mb,
        maintenance_work_mem_mb = config.database.maintenance_work_mem_mb,
        jwt_secret = config.auth.jwt_secret,
        jwt_expiry = config.auth.jwt_expiry_seconds,
        registration_enabled = config.auth.registration_enabled,
        allow_username_login = config.auth.allow_username_login,
        require_email = config.auth.require_email,
        storage_type = config.storage.storage_type,
        storage_path = config.storage.path,
        media_path = config.media.storage_path,
        max_file_size = config.media.max_file_size,
        p2p_threshold = config.media.p2p_threshold,
        voice_native_media = config.voice.native_media,
        voice_port = config.voice.port,
        voice_max_participants = config.voice.max_participants_per_room,
        voice_audio_bitrate = config.voice.audio_bitrate,
        voice_e2ee_required = config.voice.e2ee_required,
        lk_key = config.livekit.api_key,
        lk_secret = config.livekit.api_secret,
        lk_url = config.livekit.url,
        lk_http_url = config.livekit.http_url,
        federation_enabled = config.federation.enabled,
        federation_signing_key_path = config
            .federation
            .signing_key_path
            .as_deref()
            .unwrap_or("./data/federation_signing_key.hex"),
        federation_allow_discovery = config.federation.allow_discovery,
        windows_firewall_auto_allow = config.network.windows_firewall_auto_allow,
        tls_enabled = config.tls.enabled,
        tls_port = config.tls.port,
        tls_cert = config.tls.cert_path,
        tls_key = config.tls.key_path,
        tls_auto = config.tls.auto_generate,
        acme_enabled = config.tls.acme.enabled,
        acme_client_path = config.tls.acme.client_path,
        acme_directory_url = config.tls.acme.directory_url,
        acme_webroot_path = config.tls.acme.webroot_path,
        acme_cert_name = config.tls.acme.cert_name,
        acme_serve_http_challenge = config.tls.acme.serve_http_challenge,
        acme_auto_renew = config.tls.acme.auto_renew,
        acme_renew_interval_seconds = config.tls.acme.renew_interval_seconds,
        retention_enabled = config.retention.enabled,
        retention_interval = config.retention.interval_seconds,
        retention_batch = config.retention.batch_size,
        at_rest_enabled = config.at_rest.enabled,
        at_rest_key_env = config.at_rest.key_env,
        at_rest_encrypt_sqlite = config.at_rest.encrypt_sqlite,
        at_rest_encrypt_files = config.at_rest.encrypt_files,
        at_rest_allow_plaintext = config.at_rest.allow_plaintext_file_reads,
        backup_dir = config.backup.backup_dir,
        backup_auto_enabled = config.backup.auto_backup_enabled,
        backup_interval = config.backup.auto_backup_interval_seconds,
        backup_include_media = config.backup.include_media,
        backup_max_backups = config.backup.max_backups,
        ai_timeout_seconds = config.ai.timeout_seconds,
    )
}

// ── Config Loading ───────────────────────────────────────────────────────────

impl Config {
    pub fn load(path: &str) -> Result<Self> {
        let mut config = if std::path::Path::new(path).exists() {
            let content = fs::read_to_string(path)?;
            toml::from_str(&content)?
        } else {
            tracing::info!(
                "Config file not found at '{}', generating defaults...",
                path
            );
            let config = Config::default();

            // Ensure parent directory exists
            if let Some(parent) = std::path::Path::new(path).parent() {
                fs::create_dir_all(parent)?;
            }

            let template = generate_config_template(&config);
            fs::write(path, &template)?;
            let _ = harden_secret_file_permissions(path);
            tracing::info!("Generated default config at '{}'", path);
            config
        };
        let _ = harden_secret_file_permissions(path);

        // Environment variable overrides
        if let Ok(value) = std::env::var("PARACORD_BIND_ADDRESS") {
            config.server.bind_address = value;
        }
        if let Ok(value) = std::env::var("PARACORD_SERVER_NAME") {
            config.server.server_name = value;
        }
        if let Ok(value) = std::env::var("PARACORD_PERMISSION_CACHE_MAX_ENTRIES") {
            if let Ok(parsed) = value.parse::<u64>() {
                config.server.permission_cache_max_entries = parsed;
            }
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
        if let Ok(value) = std::env::var("PARACORD_DATABASE_ENGINE") {
            let normalized = value.trim().to_ascii_lowercase();
            match normalized.as_str() {
                "sqlite" => config.database.engine = DatabaseEngine::Sqlite,
                "postgres" | "postgresql" => config.database.engine = DatabaseEngine::Postgres,
                _ => {
                    tracing::warn!(
                        "Ignoring invalid PARACORD_DATABASE_ENGINE value '{}'; expected sqlite or postgres",
                        value
                    );
                }
            }
        }
        if let Ok(value) = std::env::var("PARACORD_DATABASE_MAX_CONNECTIONS") {
            if let Ok(parsed) = value.parse::<u32>() {
                config.database.max_connections = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_DATABASE_STATEMENT_TIMEOUT_SECS") {
            if let Ok(parsed) = value.parse::<u64>() {
                config.database.statement_timeout_secs = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_SECS") {
            if let Ok(parsed) = value.parse::<u64>() {
                config.database.idle_in_transaction_timeout_secs = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_DATABASE_WORK_MEM_MB") {
            if let Ok(parsed) = value.parse::<u32>() {
                config.database.work_mem_mb = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_DATABASE_MAINTENANCE_WORK_MEM_MB") {
            if let Ok(parsed) = value.parse::<u32>() {
                config.database.maintenance_work_mem_mb = parsed;
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
        if let Ok(value) = std::env::var("PARACORD_AUTH_ALLOW_USERNAME_LOGIN") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.auth.allow_username_login = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_AUTH_REQUIRE_EMAIL") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.auth.require_email = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_AUTH_REQUIRE_EMAIL_VERIFICATION") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.auth.require_email_verification = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_STORAGE_TYPE") {
            config.storage.storage_type = value;
        }
        if let Ok(value) = std::env::var("PARACORD_STORAGE_PATH") {
            config.storage.path = value;
        }
        // S3 environment overrides
        if let Ok(value) = std::env::var("PARACORD_S3_BUCKET") {
            config.s3.bucket = value;
        }
        if let Ok(value) = std::env::var("PARACORD_S3_REGION") {
            config.s3.region = value;
        }
        if let Ok(value) = std::env::var("PARACORD_S3_ENDPOINT_URL") {
            config.s3.endpoint_url = Some(value);
        }
        if let Ok(value) = std::env::var("PARACORD_S3_ACCESS_KEY_ID") {
            config.s3.access_key_id = Some(value);
        }
        if let Ok(value) = std::env::var("PARACORD_S3_SECRET_ACCESS_KEY") {
            config.s3.secret_access_key = Some(value);
        }
        if let Ok(value) = std::env::var("PARACORD_S3_USE_AWS_CREDENTIAL_CHAIN") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.s3.use_aws_credential_chain = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_S3_PREFIX") {
            config.s3.prefix = value;
        }
        if let Ok(value) = std::env::var("PARACORD_S3_CDN_URL") {
            config.s3.cdn_url = Some(value);
        }
        if let Ok(value) = std::env::var("PARACORD_S3_FORCE_PATH_STYLE") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.s3.force_path_style = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_MEDIA_STORAGE_PATH") {
            config.media.storage_path = value;
        }
        if let Ok(value) = std::env::var("PARACORD_VOICE_NATIVE_MEDIA") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.voice.native_media = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_VOICE_PORT") {
            if let Ok(parsed) = value.parse::<u16>() {
                config.voice.port = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_VOICE_MAX_PARTICIPANTS_PER_ROOM") {
            if let Ok(parsed) = value.parse::<u32>() {
                config.voice.max_participants_per_room = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_VOICE_AUDIO_BITRATE") {
            if let Ok(parsed) = value.parse::<u32>() {
                config.voice.audio_bitrate = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_VOICE_E2EE_REQUIRED") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.voice.e2ee_required = parsed;
            }
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
        if let Ok(value) = std::env::var("PARACORD_WINDOWS_FIREWALL_AUTO_ALLOW") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.network.windows_firewall_auto_allow = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_TLS_ENABLED") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.tls.enabled = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_TLS_ACME_ENABLED") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.tls.acme.enabled = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_TLS_ACME_CLIENT_PATH") {
            if !value.trim().is_empty() {
                config.tls.acme.client_path = value;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_TLS_ACME_DIRECTORY_URL") {
            if !value.trim().is_empty() {
                config.tls.acme.directory_url = value;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_TLS_ACME_EMAIL") {
            config.tls.acme.email = if value.trim().is_empty() {
                None
            } else {
                Some(value)
            };
        }
        if let Ok(value) = std::env::var("PARACORD_TLS_ACME_DOMAINS") {
            config.tls.acme.domains = value
                .split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(str::to_string)
                .collect();
        }
        if let Ok(value) = std::env::var("PARACORD_TLS_ACME_WEBROOT_PATH") {
            if !value.trim().is_empty() {
                config.tls.acme.webroot_path = value;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_TLS_ACME_CERT_NAME") {
            if !value.trim().is_empty() {
                config.tls.acme.cert_name = value;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_TLS_ACME_CERT_SOURCE_PATH") {
            config.tls.acme.cert_source_path = if value.trim().is_empty() {
                None
            } else {
                Some(value)
            };
        }
        if let Ok(value) = std::env::var("PARACORD_TLS_ACME_KEY_SOURCE_PATH") {
            config.tls.acme.key_source_path = if value.trim().is_empty() {
                None
            } else {
                Some(value)
            };
        }
        if let Ok(value) = std::env::var("PARACORD_TLS_ACME_SERVE_HTTP_CHALLENGE") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.tls.acme.serve_http_challenge = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_TLS_ACME_AUTO_RENEW") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.tls.acme.auto_renew = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_TLS_ACME_RENEW_INTERVAL_SECONDS") {
            if let Ok(parsed) = value.parse::<u64>() {
                config.tls.acme.renew_interval_seconds = parsed.max(300);
            }
        }
        if let Ok(value) = std::env::var("PARACORD_TLS_ACME_ADDITIONAL_ARGS") {
            config.tls.acme.additional_args = value
                .split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(str::to_string)
                .collect();
        }
        if let Ok(value) = std::env::var("PARACORD_FEDERATION_ENABLED") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.federation.enabled = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_FEDERATION_DOMAIN") {
            if !value.trim().is_empty() {
                config.federation.domain = Some(value);
            }
        }
        if let Ok(value) = std::env::var("PARACORD_FEDERATION_SIGNING_KEY_PATH") {
            let trimmed = value.trim();
            config.federation.signing_key_path = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            };
        }
        if let Ok(value) = std::env::var("PARACORD_FEDERATION_ALLOW_DISCOVERY") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.federation.allow_discovery = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_FEDERATION_MAX_EVENTS_PER_PEER_PER_MINUTE") {
            if let Ok(parsed) = value.parse::<u32>() {
                config.federation.max_events_per_peer_per_minute = Some(parsed);
            }
        }
        if let Ok(value) = std::env::var("PARACORD_FEDERATION_MAX_USER_CREATES_PER_PEER_PER_HOUR") {
            if let Ok(parsed) = value.parse::<u32>() {
                config.federation.max_user_creates_per_peer_per_hour = Some(parsed);
            }
        }
        if let Ok(value) = std::env::var("PARACORD_MAX_GUILD_STORAGE_QUOTA") {
            if let Ok(parsed) = value.parse::<u64>() {
                config.storage.max_guild_storage_quota = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_FEDERATION_FILE_CACHE_ENABLED") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.federation.file_cache_enabled = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_FEDERATION_FILE_CACHE_MAX_SIZE") {
            if let Ok(parsed) = value.parse::<u64>() {
                config.federation.file_cache_max_size = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_FEDERATION_FILE_CACHE_TTL_HOURS") {
            if let Ok(parsed) = value.parse::<u64>() {
                config.federation.file_cache_ttl_hours = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_RETENTION_ENABLED") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.retention.enabled = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_RETENTION_INTERVAL_SECONDS") {
            if let Ok(parsed) = value.parse::<u64>() {
                config.retention.interval_seconds = parsed.max(60);
            }
        }
        if let Ok(value) = std::env::var("PARACORD_RETENTION_BATCH_SIZE") {
            if let Ok(parsed) = value.parse::<i64>() {
                config.retention.batch_size = parsed.clamp(1, 10_000);
            }
        }
        if let Ok(value) = std::env::var("PARACORD_RETENTION_MESSAGE_DAYS") {
            config.retention.message_days = parse_optional_days(&value);
        }
        if let Ok(value) = std::env::var("PARACORD_RETENTION_ATTACHMENT_DAYS") {
            config.retention.attachment_days = parse_optional_days(&value);
        }
        if let Ok(value) = std::env::var("PARACORD_RETENTION_AUDIT_LOG_DAYS") {
            config.retention.audit_log_days = parse_optional_days(&value);
        }
        if let Ok(value) = std::env::var("PARACORD_RETENTION_SECURITY_EVENT_DAYS") {
            config.retention.security_event_days = parse_optional_days(&value);
        }
        if let Ok(value) = std::env::var("PARACORD_RETENTION_SESSION_DAYS") {
            config.retention.session_days = parse_optional_days(&value);
        }
        if let Ok(value) = std::env::var("PARACORD_AT_REST_ENABLED") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.at_rest.enabled = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_AT_REST_KEY_ENV") {
            if !value.trim().is_empty() {
                config.at_rest.key_env = value;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_AT_REST_ENCRYPT_SQLITE") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.at_rest.encrypt_sqlite = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_AT_REST_ENCRYPT_FILES") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.at_rest.encrypt_files = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_AT_REST_ALLOW_PLAINTEXT_FILE_READS") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.at_rest.allow_plaintext_file_reads = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_BACKUP_DIR") {
            config.backup.backup_dir = value;
        }
        if let Ok(value) = std::env::var("PARACORD_BACKUP_AUTO_ENABLED") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.backup.auto_backup_enabled = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_BACKUP_INTERVAL_SECONDS") {
            if let Ok(parsed) = value.parse::<u64>() {
                config.backup.auto_backup_interval_seconds = parsed.max(3600);
            }
        }
        if let Ok(value) = std::env::var("PARACORD_BACKUP_INCLUDE_MEDIA") {
            if let Ok(parsed) = value.parse::<bool>() {
                config.backup.include_media = parsed;
            }
        }
        if let Ok(value) = std::env::var("PARACORD_BACKUP_MAX_BACKUPS") {
            if let Ok(parsed) = value.parse::<u32>() {
                config.backup.max_backups = parsed.clamp(1, 100);
            }
        }
        if let Ok(value) = std::env::var("PARACORD_AI_PROVIDER") {
            let trimmed = value.trim().to_string();
            config.ai.provider = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            };
        }
        if let Ok(value) = std::env::var("PARACORD_AI_BASE_URL") {
            let trimmed = value.trim().to_string();
            config.ai.base_url = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            };
        }
        if let Ok(value) = std::env::var("PARACORD_AI_API_KEY") {
            let trimmed = value.trim().to_string();
            config.ai.api_key = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            };
        }
        if let Ok(value) = std::env::var("PARACORD_AI_MODEL") {
            let trimmed = value.trim().to_string();
            config.ai.model = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            };
        }
        if let Ok(value) = std::env::var("PARACORD_AI_TIMEOUT_SECONDS") {
            if let Ok(parsed) = value.parse::<u64>() {
                config.ai.timeout_seconds = parsed.clamp(5, 120);
            }
        }

        if let Ok(value) = std::env::var("PARACORD_TENOR_API_KEY") {
            let trimmed = value.trim().to_string();
            config.integrations.tenor_api_key = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            };
        }

        validate_secret_configuration(&config)?;
        Ok(config)
    }
}

fn parse_optional_days(raw: &str) -> Option<i64> {
    raw.parse::<i64>()
        .ok()
        .and_then(|days| if days > 0 { Some(days.min(3650)) } else { None })
}

#[cfg(test)]
mod tests {
    use super::{Config, DatabaseConfig, DatabaseEngine, TlsConfig};
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn tls_defaults_enable_self_signed_bootstrap() {
        let tls = TlsConfig::default();
        assert!(tls.enabled);
        assert!(tls.auto_generate);
    }

    #[test]
    fn database_defaults_to_sqlite_engine() {
        let db = DatabaseConfig::default();
        assert_eq!(db.engine, DatabaseEngine::Sqlite);
    }

    #[test]
    fn storage_defaults_to_local_without_aws_credential_chain() {
        let config = Config::default();

        assert_eq!(config.storage.storage_type, "local");
        assert!(config.s3.access_key_id.is_none());
        assert!(config.s3.secret_access_key.is_none());
        assert!(!config.s3.use_aws_credential_chain);
    }

    #[test]
    fn env_override_accepts_postgres_engine() {
        let _guard = ENV_LOCK.lock().expect("env lock poisoned");
        let temp = tempfile::tempdir().expect("tempdir");
        let config_path = temp.path().join("paracord-test.toml");
        std::env::set_var("PARACORD_JWT_SECRET", "0123456789abcdef0123456789abcdef");
        std::env::set_var("PARACORD_DATABASE_ENGINE", "postgres");
        let config =
            Config::load(config_path.to_str().expect("config path utf8")).expect("load config");
        std::env::remove_var("PARACORD_DATABASE_ENGINE");
        std::env::remove_var("PARACORD_JWT_SECRET");
        assert_eq!(config.database.engine, DatabaseEngine::Postgres);
    }

    #[test]
    fn s3_environment_does_not_select_s3_storage_without_explicit_type() {
        let _guard = ENV_LOCK.lock().expect("env lock poisoned");
        let temp = tempfile::tempdir().expect("tempdir");
        let config_path = temp.path().join("paracord-test.toml");

        std::env::remove_var("PARACORD_STORAGE_TYPE");
        std::env::set_var("PARACORD_JWT_SECRET", "0123456789abcdef0123456789abcdef");
        std::env::set_var("PARACORD_S3_BUCKET", "paracord-test");
        std::env::set_var("PARACORD_S3_ACCESS_KEY_ID", "test-key");
        std::env::set_var("PARACORD_S3_SECRET_ACCESS_KEY", "test-secret");
        std::env::set_var("PARACORD_S3_USE_AWS_CREDENTIAL_CHAIN", "true");

        let config =
            Config::load(config_path.to_str().expect("config path utf8")).expect("load config");

        std::env::remove_var("PARACORD_JWT_SECRET");
        std::env::remove_var("PARACORD_S3_BUCKET");
        std::env::remove_var("PARACORD_S3_ACCESS_KEY_ID");
        std::env::remove_var("PARACORD_S3_SECRET_ACCESS_KEY");
        std::env::remove_var("PARACORD_S3_USE_AWS_CREDENTIAL_CHAIN");

        assert_eq!(config.storage.storage_type, "local");
        assert_eq!(config.s3.bucket, "paracord-test");
        assert!(config.s3.use_aws_credential_chain);
    }
}
