#![allow(clippy::derivable_impls, clippy::too_many_arguments)]

pub mod admin;
pub mod auth;
pub mod automod;
pub mod automod_enforce;
#[cfg(feature = "backup")]
pub mod backup;
pub mod channel;
pub mod error;
pub mod events;
pub mod guild;
pub mod health;
pub mod identity;
pub mod interactions;
pub mod member_index;
pub mod message;
pub mod observability;
pub mod permissions;
pub mod presence_manager;
pub mod user;

use dashmap::{DashMap, DashSet};
use paracord_db::DbPool;
use paracord_federation::FederationService;
use paracord_media::{Storage, StorageManager, VoiceManager};
#[cfg(feature = "native-media")]
use paracord_relay::relay::RelayForwarder;
#[cfg(feature = "native-media")]
use paracord_relay::room::MediaRoomManager;
#[cfg(feature = "native-media")]
use paracord_relay::speaker::SpeakerDetector;
#[cfg(feature = "native-media")]
use paracord_transport::endpoint::MediaEndpoint;
use std::sync::Arc;
use tokio::sync::{Notify, RwLock};

/// Bit flag: user is a server-wide admin.
pub const USER_FLAG_ADMIN: i32 = 1 << 0;
/// Bit flag: user is a bot account.
pub const USER_FLAG_BOT: i32 = 1 << 1;
/// Bit flag: message content is DM end-to-end encrypted ciphertext.
pub const MESSAGE_FLAG_DM_E2EE: i32 = 1 << 0;

pub fn is_admin(flags: i32) -> bool {
    flags & USER_FLAG_ADMIN != 0
}

pub fn is_bot(flags: i32) -> bool {
    flags & USER_FLAG_BOT != 0
}

/// Settings that can be changed at runtime via the admin dashboard.
#[derive(Clone, Debug)]
pub struct RuntimeSettings {
    pub registration_enabled: bool,
    pub server_name: String,
    pub server_description: String,
    pub max_guilds_per_user: u32,
    pub max_members_per_guild: u32,
}

impl Default for RuntimeSettings {
    fn default() -> Self {
        Self {
            registration_enabled: true,
            server_name: "Paracord Server".to_string(),
            server_description: String::new(),
            max_guilds_per_user: 100,
            max_members_per_guild: 1000,
        }
    }
}

/// Cache key for computed channel permissions: (user_id, channel_id).
pub type PermissionCacheKey = (i64, i64);
pub const DEFAULT_PERMISSION_CACHE_MAX_ENTRIES: u64 = 10_000;

/// Build the permission cache with a 5-minute TTL and configurable max entries.
pub fn build_permission_cache(max_entries: u64) -> permissions::PermissionCache {
    let capacity = if max_entries == 0 {
        DEFAULT_PERMISSION_CACHE_MAX_ENTRIES
    } else {
        max_entries
    };
    permissions::PermissionCache::new(capacity)
}

#[derive(Clone)]
pub struct AppState {
    pub db: DbPool,
    pub event_bus: events::EventBus,
    pub config: AppConfig,
    pub runtime: Arc<RwLock<RuntimeSettings>>,
    pub voice: Arc<VoiceManager>,
    pub storage: Arc<StorageManager>,
    /// Pluggable storage backend (local filesystem or S3-compatible).
    pub storage_backend: Arc<Storage>,
    pub shutdown: Arc<Notify>,
    /// Set of user IDs currently connected to the gateway (online).
    pub online_users: Arc<DashSet<i64>>,
    /// Live presence payloads keyed by user ID.
    ///
    /// Tracks **online users only** and mirrors `online_users`: the gateway's
    /// disconnect path removes the entry rather than parking an "offline"
    /// payload in it. Nothing evicts from this map otherwise, so writing on
    /// disconnect made it retain one JSON value per user that had ever connected
    /// and grow without bound for the life of the process. A missing entry means
    /// "offline"; readers must treat it that way rather than reintroduce a
    /// stored offline placeholder.
    pub user_presences: Arc<DashMap<i64, serde_json::Value>>,
    /// Cached computed channel permissions: (user_id, channel_id) -> Permissions,
    /// with reverse indexes for targeted invalidation.
    pub permission_cache: permissions::PermissionCache,
    /// Pre-built federation service (avoids re-parsing env vars on every request).
    pub federation_service: Option<FederationService>,
    /// In-memory guild->members index for zero-query presence dispatch.
    pub member_index: Arc<member_index::MemberIndex>,
    /// Deferred offline presence manager to avoid disconnect/reconnect races.
    pub presence_manager: Arc<presence_manager::PresenceManager>,
    /// Native QUIC media relay state (None when using LiveKit).
    pub native_media: Option<NativeMediaState>,
    /// Temporary MFA login tickets: ticket UUID -> user_id. 5-min TTL.
    pub mfa_tickets: moka::future::Cache<String, i64>,
}

/// State for the native QUIC-based media server.
#[cfg(feature = "native-media")]
#[derive(Clone)]
pub struct NativeMediaState {
    pub rooms: Arc<MediaRoomManager>,
    pub speaker_detector: Arc<SpeakerDetector>,
    pub endpoint: Arc<MediaEndpoint>,
    pub relay_forwarder: Arc<RelayForwarder>,
    /// Base64-encoded SHA-256 hash of the server's TLS certificate DER.
    /// Browsers need this for `serverCertificateHashes` when connecting
    /// to self-signed certs via WebTransport.
    pub cert_hash: String,
}

/// Placeholder type when native-media support is disabled at compile time.
#[cfg(not(feature = "native-media"))]
#[derive(Clone)]
pub struct NativeMediaState;

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub jwt_secret: String,
    pub jwt_expiry_seconds: u64,
    pub registration_enabled: bool,
    pub allow_username_login: bool,
    pub require_email: bool,
    pub storage_path: String,
    pub max_upload_size: u64,
    pub livekit_api_key: String,
    pub livekit_api_secret: String,
    pub livekit_url: String,
    pub livekit_http_url: String,
    /// The LiveKit URL sent to clients. Falls back to `livekit_url` if not set.
    pub livekit_public_url: String,
    /// Whether a LiveKit server is available for voice/video.
    pub livekit_available: bool,
    /// The public URL of this server (e.g., https://chat.example.com).
    /// Used for CORS auto-configuration and invite links.
    pub public_url: Option<String>,
    pub media_storage_path: String,
    pub media_max_file_size: u64,
    pub media_p2p_threshold: u64,
    pub file_cryptor: Option<paracord_util::at_rest::FileCryptor>,
    /// Cryptor for encrypting TOTP secrets at rest (derived from the same master key with "totp" context).
    pub totp_cryptor: Option<paracord_util::at_rest::FileCryptor>,
    pub backup_dir: String,
    pub database_url: String,
    /// Per-peer rate limit for inbound federation events (per minute). None = no limit.
    pub federation_max_events_per_peer_per_minute: Option<u32>,
    /// Per-peer rate limit for remote user creation (per hour). None = no limit.
    pub federation_max_user_creates_per_peer_per_hour: Option<u32>,
    /// Whether the native QUIC media server is enabled.
    pub native_media_enabled: bool,
    /// UDP port for the unified QUIC media endpoint (raw QUIC + WebTransport).
    pub native_media_port: u16,
    /// Maximum participants per voice room (native media).
    pub native_media_max_participants: u32,
    /// Whether E2EE is required for native media sessions.
    pub native_media_e2ee_required: bool,
    /// Maximum storage quota per guild in bytes.
    pub max_guild_storage_quota: u64,
    /// Whether federation file caching is enabled.
    pub federation_file_cache_enabled: bool,
    /// Maximum size of the federation file cache in bytes.
    pub federation_file_cache_max_size: u64,
    /// TTL for cached federation files in hours.
    pub federation_file_cache_ttl_hours: u64,
    /// Optional Tenor API key for GIF search proxy.
    pub tenor_api_key: Option<String>,
    /// Whether email verification is required after registration.
    pub require_email_verification: bool,
    /// Optional AI provider id (openai/anthropic/ollama/openai_compatible).
    pub ai_provider: Option<String>,
    /// Optional AI API base URL.
    pub ai_base_url: Option<String>,
    /// Optional AI API key.
    pub ai_api_key: Option<String>,
    /// Optional AI model id.
    pub ai_model: Option<String>,
    /// Timeout for AI requests in seconds.
    pub ai_timeout_seconds: u64,

    // --- Operational metadata -------------------------------------------
    // Surfaced by the admin health check so operators can see how the server
    // is actually running without reading the config file.
    /// Address the HTTP server is bound to.
    pub bind_address: String,
    /// Whether the server terminates TLS itself.
    pub tls_enabled: bool,
    /// Whether TLS is using a self-generated certificate.
    pub tls_self_signed: bool,
    /// Whether scheduled automatic backups are running.
    pub auto_backup_enabled: bool,
    /// Interval between automatic backups, in seconds.
    pub auto_backup_interval_seconds: u64,
    /// Whether server-to-server federation is enabled.
    pub federation_enabled: bool,
    /// Process start time, for uptime reporting.
    pub started_at: chrono::DateTime<chrono::Utc>,
}

#[cfg(test)]
impl AppConfig {
    /// Minimal config for unit tests that only read a handful of fields.
    pub(crate) fn test_default() -> Self {
        Self {
            jwt_secret: "test-secret".into(),
            jwt_expiry_seconds: 86_400,
            registration_enabled: true,
            allow_username_login: true,
            require_email: false,
            storage_path: "./data/uploads".into(),
            max_upload_size: 1024,
            livekit_api_key: String::new(),
            livekit_api_secret: String::new(),
            livekit_url: String::new(),
            livekit_http_url: String::new(),
            livekit_public_url: String::new(),
            livekit_available: false,
            public_url: None,
            media_storage_path: "./data/files".into(),
            media_max_file_size: 1024,
            media_p2p_threshold: 1024,
            file_cryptor: None,
            totp_cryptor: None,
            backup_dir: "./data/backups".into(),
            database_url: "sqlite://./data/paracord.db".into(),
            federation_max_events_per_peer_per_minute: None,
            federation_max_user_creates_per_peer_per_hour: None,
            native_media_enabled: true,
            native_media_port: 8443,
            native_media_max_participants: 50,
            native_media_e2ee_required: false,
            max_guild_storage_quota: 0,
            federation_file_cache_enabled: false,
            federation_file_cache_max_size: 0,
            federation_file_cache_ttl_hours: 0,
            tenor_api_key: None,
            require_email_verification: false,
            ai_provider: None,
            ai_base_url: None,
            ai_api_key: None,
            ai_model: None,
            ai_timeout_seconds: 30,
            bind_address: "0.0.0.0:8443".into(),
            tls_enabled: true,
            tls_self_signed: false,
            auto_backup_enabled: true,
            auto_backup_interval_seconds: 86_400,
            federation_enabled: false,
            started_at: chrono::Utc::now(),
        }
    }
}
