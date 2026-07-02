use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub discriminator: String,
    pub email: Option<String>,
    pub avatar: Option<String>,
    pub banner: Option<String>,
    pub bio: Option<String>,
    pub bot: bool,
    pub system: bool,
    pub flags: i64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfile {
    pub user: User,
    pub roles: Vec<crate::role::Role>,
    pub mutual_guilds: Vec<MutualGuild>,
    pub mutual_friends: Vec<MutualFriend>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MutualGuild {
    pub id: i64,
    pub name: String,
    pub icon_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MutualFriend {
    pub id: i64,
    pub username: String,
    pub discriminator: i16,
    pub avatar_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSettings {
    pub user_id: i64,
    pub theme: String,
    pub locale: String,
    pub message_display_compact: bool,
    pub custom_css: Option<String>,
    pub status: String,
    pub custom_status: Option<String>,
    pub crypto_auth_enabled: bool,
}
