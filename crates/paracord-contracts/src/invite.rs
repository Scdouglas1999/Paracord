use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// A guild invite as returned by create and guild-scoped list endpoints.
/// Nullable fields are present in responses, including when their value is null.
/// `max_uses`/`max_age` of 0 mean unlimited/never expire.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GuildInvite {
    pub code: String,
    pub guild_id: String,
    pub channel_id: String,
    pub inviter_id: Option<String>,
    pub max_uses: Option<i32>,
    pub uses: i32,
    pub max_age: Option<i32>,
    pub created_at: String,
}

/// Servers from before the first-run invite card send no `hue` or
/// `online_count`; see [`crate::absent_on_older_servers`].
fn guild_preview_fields_absent_on_older_servers(schema: &mut schemars::Schema) {
    crate::absent_on_older_servers(schema, &["hue", "online_count"]);
}

/// The guild card embedded in `GET /invites/{code}`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[schemars(transform = guild_preview_fields_absent_on_older_servers)]
pub struct InviteGuildPreview {
    pub id: String,
    pub name: String,
    pub icon_hash: Option<String>,
    #[schemars(range(min = 0, max = 4294967295u64))]
    pub member_count: u32,
    /// The server's color as a hue, 0-359; null when unset. Always sent by this
    /// server; absent from older ones.
    #[serde(default)]
    #[schemars(range(min = 0, max = 359))]
    pub hue: Option<i16>,
    /// Members online now. Always sent by this server; absent from older ones.
    #[serde(default)]
    #[schemars(range(min = 0, max = 4294967295u64))]
    pub online_count: u32,
}

/// One of up to three members shown on an invite card: only the first
/// grapheme of the display name and the avatar hue. No names, ids or images.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct InviteFace {
    pub initial: String,
    #[schemars(range(min = 0, max = 359))]
    pub hue: i16,
}

/// What the joining client needs to know about the instance before any
/// account work (spec §6.1, §3.12).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct InviteInstance {
    pub name: String,
    pub version: String,
    /// 2 on servers with one-password sign-up.
    pub credential_version: u8,
    pub registration_mode: crate::credential::RegistrationMode,
    pub require_email: bool,
}

/// What joining asks of a newcomer, when the server's owner has turned the
/// verification gate on. The questions are the prompts only; the expected
/// answers never leave the server.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct InviteJoinGate {
    /// The newcomer must tick an acknowledgment of the server's rules.
    pub require_ack: bool,
    /// Questions to answer, in order. Empty when the gate asks none.
    pub questions: Vec<String>,
}

/// Servers from before the first-run invite card send no `faces`,
/// `expires_at` or `instance`. An absent `instance` is how a client knows the
/// server is older (spec §3.12).
fn preview_fields_absent_on_older_servers(schema: &mut schemars::Schema) {
    crate::absent_on_older_servers(schema, &["faces", "expires_at", "instance"]);
}

/// `GET /invites/{code}`: public invite resolution. `guild` is null when the
/// invite's channel no longer resolves to a guild. `join_gate` is null unless
/// the owner enabled one — which is what lets the invite page ask a newcomer
/// for nothing at all in the ordinary case.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[schemars(transform = preview_fields_absent_on_older_servers)]
pub struct InvitePreview {
    pub code: String,
    pub guild: Option<InviteGuildPreview>,
    /// Present only when the owner enabled a gate. Absent is the ordinary case,
    /// and it is also what a server that predates this field sends — so a
    /// client can still open its invites; such a server enforces its gate on
    /// accept and says what is missing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join_gate: Option<InviteJoinGate>,
    /// Up to three members, online first, then most recently joined.
    #[serde(default)]
    pub faces: Vec<InviteFace>,
    /// RFC 3339; null when the invite never expires.
    #[serde(default)]
    pub expires_at: Option<String>,
    pub instance: InviteInstance,
}

/// The guild card returned after successfully accepting an invite.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct InviteAcceptGuild {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub icon_hash: Option<String>,
    pub owner_id: String,
    pub created_at: String,
    /// First usable channel for post-join navigation.
    pub default_channel_id: Option<String>,
    #[schemars(range(min = 0, max = 4294967295u64))]
    pub member_count: u32,
}

/// `POST /invites/{code}` response.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct InviteAcceptResponse {
    pub guild: InviteAcceptGuild,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct CreateInviteRequest {
    /// 0 means unlimited uses; at most 100 otherwise.
    #[serde(default = "default_max_uses")]
    pub max_uses: i32,
    /// Seconds until expiry; 0 means never, at most 604800 (7 days).
    #[serde(default = "default_max_age")]
    pub max_age: i32,
}

fn default_max_uses() -> i32 {
    0
}
fn default_max_age() -> i32 {
    86400
}

/// `POST /invites/{code}` accepts an optional JSON body.
#[derive(Debug, Clone, Deserialize, Default, JsonSchema)]
pub struct AcceptInviteRequest {
    pub verification_ack: Option<bool>,
    pub verification_answers: Option<Vec<String>>,
}
