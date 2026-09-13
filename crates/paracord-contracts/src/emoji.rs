use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// A custom guild emoji. `creator_id` is null for emoji whose creator record
/// is gone; the field is always present.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GuildEmoji {
    pub id: String,
    pub guild_id: String,
    pub name: String,
    pub animated: bool,
    pub creator_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct UpdateEmojiRequest {
    /// 1-32 characters.
    pub name: String,
}
