pub mod admin;
pub mod auth;
pub mod backup;
pub mod channel;
pub mod error;
pub mod events;
pub mod guild;
pub mod identity;
pub mod message;
pub mod observability;
pub mod permissions;
pub mod user;

use paracord_db::DbPool;
use paracord_federation::FederationService;
use paracord_media::{Storage, StorageManager, VoiceManager};
use paracord_models::permissions::Permissions;
use std::collections::{HashMap, HashSet};
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

/// Build the permission cache with a 5-minute TTL and 10k max entries.
pub fn build_permission_cache() -> moka::future::Cache<PermissionCacheKey, Permissions> {
    moka::future::Cache::builder()
        .max_capacity(10_000)
        .time_to_live(std::time::Duration::from_secs(300))
        .build()
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
    pub online_users: Arc<RwLock<HashSet<i64>>>,
    /// Live presence payloads keyed by user ID.
    pub user_presences: Arc<RwLock<HashMap<i64, serde_json::Value>>>,
    /// Cached computed channel permissions: (user_id, channel_id) -> Permissions.
    pub permission_cache: moka::future::Cache<PermissionCacheKey, Permissions>,
    /// Pre-built federation service (avoids re-parsing env vars on every request).
    pub federation_service: Option<FederationService>,
}

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
    pub backup_dir: String,
    pub database_url: String,
    /// Per-peer rate limit for inbound federation events (per minute). None = no limit.
    pub federation_max_events_per_peer_per_minute: Option<u32>,
    /// Per-peer rate limit for remote user creation (per hour). None = no limit.
    pub federation_max_user_creates_per_peer_per_hour: Option<u32>,
}
