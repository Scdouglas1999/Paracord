use serde::{Deserialize, Serialize};

/// How a member takes part in a voice channel.
///
/// `Joined` is a full call membership (publishing gated only by SPEAK and, on
/// a stage, by suppression). `Listen` hears the voices and never sends: the
/// media relay admits the member receive-only, and everyone in the channel
/// sees the member as "listening in".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VoiceMode {
    #[default]
    Joined,
    Listen,
}

impl VoiceMode {
    /// The value stored in `voice_states.mode` and sent on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Joined => "joined",
            Self::Listen => "listen",
        }
    }

    /// Parse the stored or wire value. Anything else is `None`, never a guess.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "joined" => Some(Self::Joined),
            "listen" => Some(Self::Listen),
            _ => None,
        }
    }

    pub fn is_listen(self) -> bool {
        matches!(self, Self::Listen)
    }
}

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
    #[serde(default)]
    pub mode: VoiceMode,
    /// When the current stream started (RFC 3339), set while `self_stream`.
    #[serde(default)]
    pub self_stream_started_at: Option<String>,
    /// When the member entered this channel (RFC 3339); a move resets it.
    #[serde(default)]
    pub joined_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_mode_round_trips_its_stored_value() {
        for mode in [VoiceMode::Joined, VoiceMode::Listen] {
            assert_eq!(VoiceMode::parse(mode.as_str()), Some(mode));
            assert_eq!(
                serde_json::to_value(mode).unwrap(),
                serde_json::json!(mode.as_str())
            );
        }
        assert_eq!(VoiceMode::parse("full"), None);
        assert_eq!(VoiceMode::parse(""), None);
    }
}
