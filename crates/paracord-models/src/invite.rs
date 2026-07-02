use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Invite {
    pub code: String,
    pub guild_id: i64,
    pub channel_id: i64,
    pub inviter_id: Option<i64>,
    pub uses: i32,
    pub max_uses: Option<i32>,
    pub max_age: Option<i32>,
    pub temporary: bool,
    pub created_at: DateTime<Utc>,
}
