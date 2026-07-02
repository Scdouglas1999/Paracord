use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotApplication {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub owner_id: i64,
    pub bot_user_id: i64,
    pub redirect_uri: Option<String>,
    pub permissions: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotGuildInstall {
    pub bot_app_id: i64,
    pub guild_id: i64,
    pub added_by: Option<i64>,
    pub permissions: i64,
    pub created_at: DateTime<Utc>,
}
