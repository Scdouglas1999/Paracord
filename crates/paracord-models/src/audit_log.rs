use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditLogEntry {
    pub id: i64,
    pub guild_id: i64,
    pub user_id: i64,
    pub action_type: i16,
    pub target_id: Option<i64>,
    pub changes: Option<serde_json::Value>,
    pub reason: Option<String>,
    pub created_at: DateTime<Utc>,
}
