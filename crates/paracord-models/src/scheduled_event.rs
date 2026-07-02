use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(i16)]
pub enum EventStatus {
    Scheduled = 1,
    Active = 2,
    Completed = 3,
    Cancelled = 4,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(i16)]
pub enum EventEntityType {
    Voice = 1,
    External = 2,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledEvent {
    pub id: i64,
    pub guild_id: i64,
    pub channel_id: Option<i64>,
    pub creator_id: i64,
    pub name: String,
    pub description: Option<String>,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
    pub status: i16,
    pub entity_type: i16,
    pub location: Option<String>,
    pub image_url: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventRsvp {
    pub event_id: i64,
    pub user_id: i64,
    pub status: i16,
    pub created_at: DateTime<Utc>,
}
