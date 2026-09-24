use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Identity block shared by every user response projection.
/// Nullable fields are present in responses, including when their value is null.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct UserCore {
    pub id: String,
    pub username: String,
    pub discriminator: i32,
    pub display_name: Option<String>,
    pub avatar_hash: Option<String>,
    pub banner_hash: Option<String>,
    pub bio: Option<String>,
    /// Profile accent as `0xRRGGBB`. Omitted when the member has not chosen one.
    ///
    /// New in 3.2. Unlike the other nullable fields it may be absent rather
    /// than null, so a 3.2 client can still read accounts from a 3.1 instance,
    /// which never sends it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent_color: Option<i32>,
    pub flags: i32,
    pub bot: bool,
    pub system: bool,
    pub created_at: String,
}

/// A linked account published on a user's public profile.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LinkedAccount {
    pub label: String,
    pub url: String,
}

/// The user object embedded in the public profile response.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PublicUser {
    #[serde(flatten)]
    pub core: UserCore,
    pub pronouns: Option<String>,
    pub linked_accounts: Vec<LinkedAccount>,
}

/// `GET /users/@me`: the authenticated account, including credential metadata.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CurrentUser {
    #[serde(flatten)]
    pub user: PublicUser,
    pub email: String,
    pub email_verified: bool,
    /// An attached Ed25519 key can authenticate this account on its own, so the
    /// owner must be able to see that one exists and which one it is.
    pub public_key: Option<String>,
    pub has_public_key: bool,
}

/// `PATCH /users/@me` and `POST /users/@me/avatar`: the updated account fields.
/// Settings-derived extras (pronouns, linked accounts) and key metadata are
/// only returned by `GET /users/@me`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct UpdatedCurrentUser {
    #[serde(flatten)]
    pub core: UserCore,
    pub email: String,
}

/// A guild role embedded in the public profile response. `permissions` is the
/// bitset as a decimal string, preserving values beyond JavaScript's safe
/// integer range.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProfileRole {
    pub id: String,
    pub guild_id: String,
    pub name: String,
    pub color: i32,
    pub hoist: bool,
    pub position: i32,
    pub permissions: String,
    pub mentionable: bool,
    pub created_at: String,
}

/// A guild shared by the viewer and the profile subject. `icon_url` is the
/// persisted icon hash; the wire name predates the `icon_hash` convention.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MutualGuild {
    pub id: String,
    pub name: String,
    pub icon_url: Option<String>,
}

/// A friend shared by the viewer and the profile subject.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MutualFriend {
    pub id: String,
    pub username: String,
    pub discriminator: i32,
    pub avatar_hash: Option<String>,
}

/// `GET /users/{user_id}/profile`: the public profile card. When the subject
/// has blocked the viewer the server returns the same shape with profile
/// extras nulled out and empty relationship lists.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PublicUserProfile {
    pub user: PublicUser,
    pub roles: Vec<ProfileRole>,
    pub mutual_guilds: Vec<MutualGuild>,
    pub mutual_friends: Vec<MutualFriend>,
    pub created_at: String,
}

/// `GET`/`PATCH /users/@me/settings`. The server stores `theme`, `locale`, and
/// `status` as opaque strings (bounded by length only), and `notifications` and
/// `keybinds` as free-form JSON objects; they are echoed verbatim.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct UserSettingsResponse {
    pub user_id: String,
    pub theme: String,
    pub locale: String,
    pub message_display_compact: bool,
    pub custom_css: Option<String>,
    pub status: String,
    pub custom_status: Option<String>,
    pub crypto_auth_enabled: bool,
    pub notifications: BTreeMap<String, Value>,
    pub keybinds: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct UpdateMeRequest {
    pub display_name: Option<String>,
    pub bio: Option<String>,
    /// Legacy data-URL avatars are still accepted for backward compatibility,
    /// but clients should prefer `POST /users/@me/avatar`.
    pub avatar_hash: Option<String>,
    /// Profile accent as `0xRRGGBB`. `null` clears it. Omit the field to leave
    /// the stored color unchanged.
    #[serde(default, deserialize_with = "deserialize_clearable_i32")]
    pub accent_color: Option<Option<i32>>,
}

fn deserialize_clearable_i32<'de, D>(deserializer: D) -> Result<Option<Option<i32>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::<i32>::deserialize(deserializer)?))
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct UpdateSettingsRequest {
    pub theme: Option<String>,
    pub locale: Option<String>,
    pub message_display_compact: Option<bool>,
    pub custom_css: Option<String>,
    pub status: Option<String>,
    pub custom_status: Option<String>,
    pub crypto_auth_enabled: Option<bool>,
    pub notifications: Option<Value>,
    pub keybinds: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ChangeEmailRequest {
    pub current_password: String,
    pub new_email: String,
}
