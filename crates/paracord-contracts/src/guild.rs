use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Space metadata used by the authenticated space list and navigation.
/// Nullable fields are present in responses, including when their value is null.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GuildSummary {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub icon_hash: Option<String>,
    /// `/api/v1/guilds/{id}/banner?v=…` once a banner is uploaded, otherwise null.
    /// The version changes with every upload.
    pub banner_hash: Option<String>,
    pub owner_id: String,
    #[schemars(range(min = 0, max = 4294967295u64))]
    pub member_count: u32,
    pub created_at: String,
    pub visibility: GuildVisibility,
    pub allowed_roles: Vec<String>,
    pub discovery_tags: Vec<String>,
    pub hub_settings: Option<HubSettings>,
    pub bot_settings: Option<BTreeMap<String, GuildBotConfig>>,
}

/// Full settings returned by the space detail and mutation endpoints.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GuildDetail {
    #[serde(flatten)]
    pub summary: GuildSummary,
    pub system_channel_id: Option<String>,
    pub vanity_url_code: Option<String>,
    /// The persisted feature bitset; it is not an array of feature names.
    #[schemars(range(min = -2147483648i64, max = 2147483647))]
    pub feature_flags: i32,
}

/// Persisted space metadata carried by the gateway READY payload.
/// Distinct from `GuildSummary`: READY sends only durable fields, never the
/// REST settings surface. Nullable fields are present, including when null.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ReadyGuildCore {
    #[schemars(length(min = 1), regex(pattern = r"\S"))]
    pub id: String,
    #[schemars(length(min = 1), regex(pattern = r"\S"))]
    pub owner_id: String,
    #[schemars(length(min = 1), regex(pattern = r"\S"))]
    pub name: String,
    pub icon_hash: Option<String>,
    #[schemars(length(min = 1))]
    pub created_at: String,
    #[schemars(range(min = 0, max = 4294967295u64))]
    pub member_count: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum GuildVisibility {
    Private,
    Public,
    Roles,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct CreateGuildRequest {
    pub name: String,
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct UpdateGuildRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub hub_settings: Option<HubSettings>,
    pub bot_settings: Option<BTreeMap<String, GuildBotConfig>>,
    // The route accepts case-insensitive, trimmed visibility names and validates
    // them before storing the canonical enum used in responses.
    pub visibility: Option<String>,
    pub discovery_tags: Option<Vec<String>>,
    pub allowed_roles: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct TransferOwnershipRequest {
    pub new_owner_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct HubSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned_channels: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub welcome_text: Option<String>,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GuildBotConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct OwnershipTransferResponse {
    pub id: String,
    pub owner_id: String,
}
