use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[repr(i16)]
pub enum ChannelType {
    Text = 0,
    DM = 1,
    Voice = 2,
    GroupDM = 3,
    Category = 4,
    Announcement = 5,
    Thread = 6,
    Forum = 7,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadMetadata {
    pub archived: bool,
    pub auto_archive_duration: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive_timestamp: Option<DateTime<Utc>>,
    pub locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub starter_message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Channel {
    pub id: i64,
    pub channel_type: ChannelType,
    pub guild_id: Option<i64>,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub position: i32,
    pub nsfw: bool,
    pub bitrate: Option<i32>,
    pub user_limit: Option<i32>,
    pub rate_limit_per_user: Option<i32>,
    pub parent_id: Option<i64>,
    pub last_message_id: Option<i64>,
    #[serde(default)]
    pub required_role_ids: Vec<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_metadata: Option<ThreadMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_count: Option<i32>,
    pub created_at: DateTime<Utc>,
}
