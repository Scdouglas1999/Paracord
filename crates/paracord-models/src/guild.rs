use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Guild {
    pub id: i64,
    pub name: String,
    pub icon: Option<String>,
    pub banner: Option<String>,
    pub description: Option<String>,
    pub owner_id: i64,
    pub member_count: i32,
    pub features: Vec<String>,
    pub system_channel_id: Option<i64>,
    pub rules_channel_id: Option<i64>,
    pub vanity_url_code: Option<String>,
    pub created_at: DateTime<Utc>,
    pub hub_settings: Option<serde_json::Value>,
    pub bot_settings: Option<serde_json::Value>,
}
