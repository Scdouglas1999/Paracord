use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// How a member takes part in a voice channel. `listen` hears the voices and
/// never sends; everyone in the channel sees the member as listening in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum VoiceMode {
    Joined,
    Listen,
}

/// What a view session receives.
///
/// - `watch`: the chosen stream's video and its own audio (never the voices).
///   Counted in the channel's watcher counts, so others see "2 watching".
/// - `ambient`: the stream's lowest simulcast layer, keyframes only, at most
///   one frame a second, video only. Not counted and not shown to anybody.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum VoiceViewKind {
    Watch,
    Ambient,
}

/// A voice state as READY lists it (`guilds[].voice_states[]`) and as a
/// `VOICE_STATE_UPDATE` for someone *in* a channel carries it. (A leave is
/// `channel_id: null` plus `prior_channel_id` and is not this shape.)
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VoiceStateSnapshot {
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub user_id: String,
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub channel_id: String,
    /// Null for a DM call.
    pub guild_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub self_mute: bool,
    pub self_deaf: bool,
    pub self_stream: bool,
    pub self_video: bool,
    pub suppress: bool,
    #[serde(default)]
    pub mute: bool,
    #[serde(default)]
    pub deaf: bool,
    /// `listen` shows as "Listening in" on the roster.
    pub mode: VoiceMode,
    /// When the member's current stream started (RFC 3339), for "LIVE 42 MIN".
    /// Non-null exactly while `self_stream` is true.
    pub self_stream_started_at: Option<String>,
    /// When the member entered this channel (RFC 3339), for "live 12 min" on a
    /// room: the room started at the earliest `joined_at` among its members.
    /// Stamped on every join and listen join, kept while the member stays in
    /// the channel, reset by a move. Null only on a status announcement whose
    /// stored row could not be read.
    pub joined_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_to_speak_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_hash: Option<String>,
    /// READY only: talking right now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaking: Option<bool>,
}

/// `POST /api/v2/voice/{channel_id}/mode`: switch between listening in and a
/// full membership in place (no reconnect).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct UpdateVoiceModeRequest {
    pub mode: VoiceMode,
    /// The call receipt from the join. When present the switch applies only
    /// to that call (409 otherwise).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// Response of `POST /api/v2/voice/{channel_id}/mode`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VoiceModeResponse {
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub channel_id: String,
    #[schemars(length(min = 1))]
    pub session_id: String,
    pub mode: VoiceMode,
    /// Whether the relay now accepts this member's media. `joined` without the
    /// SPEAK permission is still `false`.
    pub can_publish: bool,
}

/// `POST /api/v2/voice/{channel_id}/view`: start a view session. In a DM or
/// group DM call only `watch` exists, for the DM's recipients.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct StartVoiceViewRequest {
    pub kind: VoiceViewKind,
    /// The streamer (a member of the channel with `self_stream`).
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub user_id: String,
}

/// How to connect a view session's media (the same native endpoint a call
/// uses; the token admits only this view).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VoiceViewMedia {
    #[schemars(length(min = 1))]
    pub media_endpoint: String,
    pub media_endpoint_candidates: Vec<String>,
    #[schemars(length(min = 1))]
    pub media_token: String,
    pub cert_hash: Option<String>,
    #[schemars(length(min = 1))]
    pub room_name: String,
}

/// Response of `POST /api/v2/voice/{channel_id}/view`.
///
/// When the caller is already in this channel's call (joined or listening),
/// the view rides that call: `via_membership` is true, `session_id` and
/// `media` are null, and the caller subscribes to the stream through its call
/// connection. Otherwise it is a separate view session with its own receipt
/// and media credentials; an account holds one at a time, and a new one
/// replaces the old (whose connection the relay closes).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VoiceViewSession {
    /// Null for a DM or group DM call.
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub guild_id: Option<String>,
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub channel_id: String,
    pub kind: VoiceViewKind,
    /// The streamer being viewed.
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub user_id: String,
    pub via_membership: bool,
    pub session_id: Option<String>,
    pub media: Option<VoiceViewMedia>,
}

/// One stream's watcher count.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VoiceStreamWatchers {
    /// The streamer.
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub user_id: String,
    #[schemars(range(min = 1, max = 4294967295u64))]
    pub watchers: u32,
}

/// Watcher counts for one voice channel: `GET
/// /api/v2/voice/{channel_id}/watchers` and the `VOICE_WATCHERS_UPDATE`
/// gateway event. A complete snapshot for the channel: a stream that is not
/// listed has no watchers.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VoiceWatchers {
    /// Null for a DM or group DM call (sent to its recipients only).
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub guild_id: Option<String>,
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub channel_id: String,
    pub streams: Vec<VoiceStreamWatchers>,
}
