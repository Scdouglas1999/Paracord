use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Presence {
    pub user_id: i64,
    pub guild_id: Option<i64>,
    pub status: String,
    pub activities: Vec<Activity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Activity {
    pub name: String,
    pub activity_type: i32,
    pub details: Option<String>,
    pub state: Option<String>,
}
