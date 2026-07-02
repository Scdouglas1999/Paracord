use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceState {
    pub user_id: i64,
    pub channel_id: Option<i64>,
    pub guild_id: Option<i64>,
    pub session_id: String,
    pub deaf: bool,
    pub mute: bool,
    pub self_deaf: bool,
    pub self_mute: bool,
    pub self_stream: bool,
    pub self_video: bool,
    pub suppress: bool,
}
