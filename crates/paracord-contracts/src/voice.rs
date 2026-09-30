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

/// `POST /api/v2/voice/{channel_id}/view`: start a view session.
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
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub guild_id: String,
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
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub guild_id: String,
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub channel_id: String,
    pub streams: Vec<VoiceStreamWatchers>,
}

/// What a reaction on a stream is. Extensible: a later version adds kinds, and
/// a client that does not know a kind skips that reaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum StreamReactionKind {
    Flame,
    Heart,
}

/// The most taps one request may carry. A client merges the taps it could not
/// send inside the one-a-second limit into its next request.
pub const MAX_STREAM_REACTION_COUNT: u32 = 20;
/// The longest echo nonce a client may attach.
pub const MAX_STREAM_REACTION_NONCE_LEN: usize = 64;

fn one() -> u32 {
    1
}

/// `POST /api/v2/voice/{channel_id}/stream-reactions`: react to a stream in
/// that voice channel. The caller must be in the channel's call or watching it
/// through a view session. One request a second per person (429 with
/// `Retry-After` otherwise).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SendStreamReactionRequest {
    pub kind: StreamReactionKind,
    /// The streamer whose stream this reacts to (sharing in this channel now).
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub stream_user_id: String,
    /// How many taps this request merges (default 1).
    #[serde(default = "one")]
    #[schemars(range(min = 1, max = 20))]
    pub count: u32,
    /// Echoed back in the event, so the sending client can drop the echo of a
    /// reaction it has already drawn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 64), regex(pattern = r"^[A-Za-z0-9_-]+$"))]
    pub nonce: Option<String>,
}

/// One reaction (possibly several merged taps) from one person.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct StreamReaction {
    /// Who reacted.
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub user_id: String,
    /// The streamer whose stream it reacts to.
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub stream_user_id: String,
    pub kind: StreamReactionKind,
    #[schemars(range(min = 1, max = 20))]
    pub count: u32,
    /// The sender's nonce, when it sent one.
    pub nonce: Option<String>,
    /// For the face in the bubble's corner when the roster does not have the
    /// sender (a viewer outside the call).
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_hash: Option<String>,
}

/// The `STREAM_REACTIONS` gateway event: the reactions one voice channel
/// received in the last quarter second, in the order they arrived. Sent to
/// the channel's voice members and its watch viewers only.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct StreamReactions {
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub guild_id: String,
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub channel_id: String,
    #[schemars(length(min = 1))]
    pub reactions: Vec<StreamReaction>,
}
