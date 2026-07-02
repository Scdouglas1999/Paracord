use serde::{Deserialize, Serialize};

// Client -> Server opcodes
pub const OP_HEARTBEAT: u8 = 1;
pub const OP_IDENTIFY: u8 = 2;
pub const OP_PRESENCE_UPDATE: u8 = 3;
pub const OP_VOICE_STATE_UPDATE: u8 = 4;
pub const OP_RESUME: u8 = 6;
pub const OP_REQUEST_GUILD_MEMBERS: u8 = 8;
pub const OP_TYPING_START: u8 = 5;

// Server -> Client opcodes
pub const OP_DISPATCH: u8 = 0;
pub const OP_RECONNECT: u8 = 7;
pub const OP_INVALID_SESSION: u8 = 9;
pub const OP_HELLO: u8 = 10;
pub const OP_HEARTBEAT_ACK: u8 = 11;

// Media opcodes (client <-> server, for native QUIC media)
pub const OP_MEDIA_CONNECT: u8 = 12;
pub const OP_MEDIA_SUBSCRIBE: u8 = 13;
pub const OP_MEDIA_KEY_ANNOUNCE: u8 = 14;
pub const OP_MEDIA_SESSION_DESC: u8 = 15;
pub const OP_MEDIA_KEY_DELIVER: u8 = 16;
pub const OP_MEDIA_SPEAKER_UPDATE: u8 = 17;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayMessage {
    pub op: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub d: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub s: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub t: Option<String>,
}

// Dispatch event names
pub const EVENT_READY: &str = "READY";
pub const EVENT_RESUMED: &str = "RESUMED";

// Guild events
pub const EVENT_GUILD_CREATE: &str = "GUILD_CREATE";
pub const EVENT_GUILD_UPDATE: &str = "GUILD_UPDATE";
pub const EVENT_GUILD_DELETE: &str = "GUILD_DELETE";
pub const EVENT_GUILD_BAN_ADD: &str = "GUILD_BAN_ADD";
pub const EVENT_GUILD_BAN_REMOVE: &str = "GUILD_BAN_REMOVE";
pub const EVENT_GUILD_EMOJIS_UPDATE: &str = "GUILD_EMOJIS_UPDATE";
pub const EVENT_GUILD_MEMBER_ADD: &str = "GUILD_MEMBER_ADD";
pub const EVENT_GUILD_MEMBER_REMOVE: &str = "GUILD_MEMBER_REMOVE";
pub const EVENT_GUILD_MEMBER_UPDATE: &str = "GUILD_MEMBER_UPDATE";
pub const EVENT_GUILD_MEMBERS_CHUNK: &str = "GUILD_MEMBERS_CHUNK";
pub const EVENT_GUILD_ROLE_CREATE: &str = "GUILD_ROLE_CREATE";
pub const EVENT_GUILD_ROLE_UPDATE: &str = "GUILD_ROLE_UPDATE";
pub const EVENT_GUILD_ROLE_DELETE: &str = "GUILD_ROLE_DELETE";

// Channel events
pub const EVENT_CHANNEL_CREATE: &str = "CHANNEL_CREATE";
pub const EVENT_CHANNEL_UPDATE: &str = "CHANNEL_UPDATE";
pub const EVENT_CHANNEL_DELETE: &str = "CHANNEL_DELETE";
pub const EVENT_CHANNEL_PINS_UPDATE: &str = "CHANNEL_PINS_UPDATE";

// Message events
pub const EVENT_MESSAGE_CREATE: &str = "MESSAGE_CREATE";
pub const EVENT_MESSAGE_UPDATE: &str = "MESSAGE_UPDATE";
pub const EVENT_MESSAGE_DELETE: &str = "MESSAGE_DELETE";
pub const EVENT_MESSAGE_DELETE_BULK: &str = "MESSAGE_DELETE_BULK";
pub const EVENT_MESSAGE_REACTION_ADD: &str = "MESSAGE_REACTION_ADD";
pub const EVENT_MESSAGE_REACTION_REMOVE: &str = "MESSAGE_REACTION_REMOVE";
pub const EVENT_MESSAGE_REACTION_REMOVE_ALL: &str = "MESSAGE_REACTION_REMOVE_ALL";

// Presence and typing
pub const EVENT_PRESENCE_UPDATE: &str = "PRESENCE_UPDATE";
pub const EVENT_TYPING_START: &str = "TYPING_START";

// Voice events
pub const EVENT_VOICE_STATE_UPDATE: &str = "VOICE_STATE_UPDATE";
pub const EVENT_VOICE_SERVER_UPDATE: &str = "VOICE_SERVER_UPDATE";

// Invite events
pub const EVENT_INVITE_CREATE: &str = "INVITE_CREATE";
pub const EVENT_INVITE_DELETE: &str = "INVITE_DELETE";

// Relationship events
pub const EVENT_RELATIONSHIP_ADD: &str = "RELATIONSHIP_ADD";
pub const EVENT_RELATIONSHIP_REMOVE: &str = "RELATIONSHIP_REMOVE";

// Media events
pub const EVENT_MEDIA_SESSION_DESC: &str = "MEDIA_SESSION_DESC";
pub const EVENT_MEDIA_KEY_DELIVER: &str = "MEDIA_KEY_DELIVER";
pub const EVENT_MEDIA_SPEAKER_UPDATE: &str = "MEDIA_SPEAKER_UPDATE";

// --- Media signaling types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaSessionDesc {
    pub relay_endpoint: String,
    pub wt_endpoint: String,
    pub token: String,
    pub room_id: String,
    pub codecs: Vec<String>,
    pub peers: Vec<PeerInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerInfo {
    pub user_id: i64,
    pub public_addr: Option<String>,
    pub supports_p2p: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaKeyAnnounce {
    pub user_id: i64,
    pub epoch: u8,
    /// Sender key encrypted to each recipient's X25519 identity key.
    pub encrypted_keys: Vec<EncryptedSenderKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedSenderKey {
    pub recipient_user_id: i64,
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaKeyDeliver {
    pub sender_user_id: i64,
    pub epoch: u8,
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaSubscribe {
    pub user_id: i64,
    pub track_type: String,
    pub simulcast_layer: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeakerUpdate {
    pub speakers: Vec<SpeakerInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeakerInfo {
    pub user_id: i64,
    pub audio_level: u8,
    pub speaking: bool,
}
