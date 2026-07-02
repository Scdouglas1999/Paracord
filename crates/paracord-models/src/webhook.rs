use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Webhook {
    pub id: i64,
    pub guild_id: i64,
    pub channel_id: i64,
    pub name: String,
    pub token: String,
    pub creator_id: Option<i64>,
    pub created_at: DateTime<Utc>,
}
