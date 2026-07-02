use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::user::User;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Member {
    pub user: User,
    pub nick: Option<String>,
    pub roles: Vec<i64>,
    pub joined_at: DateTime<Utc>,
    pub deaf: bool,
    pub mute: bool,
}
