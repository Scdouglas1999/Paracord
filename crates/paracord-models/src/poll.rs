use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Poll {
    pub id: i64,
    pub message_id: i64,
    pub question: String,
    pub options: Vec<PollOption>,
    pub allow_multiselect: bool,
    pub expires_at: Option<String>,
    pub total_votes: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollOption {
    pub id: i64,
    pub text: String,
    pub emoji: Option<String>,
    pub vote_count: i32,
    pub voted: bool,
}
