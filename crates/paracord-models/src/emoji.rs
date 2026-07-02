use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Emoji {
    pub id: i64,
    pub guild_id: i64,
    pub name: String,
    pub animated: bool,
    pub available: bool,
    pub creator_id: Option<i64>,
    pub created_at: Option<String>,
}
