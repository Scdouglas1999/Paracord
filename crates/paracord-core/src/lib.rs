pub mod auth;
pub mod error;
pub mod events;
pub mod permissions;
pub mod guild;
pub mod channel;
pub mod message;
pub mod user;
pub mod admin;

use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::{Notify, RwLock};
use paracord_db::DbPool;
use paracord_media::{VoiceManager, StorageManager};

/// Bit flag: user is a server-wide admin.
pub const USER_FLAG_ADMIN: i32 = 1 << 0;

pub fn is_admin(flags: i32) -> bool {
    flags & USER_FLAG_ADMIN != 0
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

#[derive(Clone)]
pub struct AppState {
    pub db: DbPool,
    pub event_bus: events::EventBus,
    pub config: AppConfig,
    pub runtime: Arc<RwLock<RuntimeSettings>>,
    pub voice: Arc<VoiceManager>,
    pub storage: Arc<StorageManager>,
    pub shutdown: Arc<Notify>,
    /// Set of user IDs currently connected to the gateway (online).
    pub online_users: Arc<RwLock<HashSet<i64>>>,
}

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub jwt_secret: String,
    pub jwt_expiry_seconds: u64,
    pub registration_enabled: bool,
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
}
