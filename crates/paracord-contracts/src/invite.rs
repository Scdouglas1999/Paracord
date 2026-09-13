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

/// The guild card embedded in `GET /invites/{code}`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct InviteGuildPreview {
    pub id: String,
    pub name: String,
    pub icon_hash: Option<String>,
    #[schemars(range(min = 0, max = 4294967295u64))]
    pub member_count: u32,
}

/// `GET /invites/{code}`: public invite resolution. `guild` is null when the
/// invite's channel no longer resolves to a guild.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct InvitePreview {
    pub code: String,
    pub guild: Option<InviteGuildPreview>,
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
