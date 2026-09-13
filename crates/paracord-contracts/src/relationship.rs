use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The other party's identity embedded in a relationship entry.
/// Nullable fields are present in responses, including when their value is null.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RelationshipUser {
    pub id: String,
    pub username: String,
    pub display_name: Option<String>,
    pub discriminator: i32,
    pub avatar_hash: Option<String>,
}

/// `GET /users/@me/relationships` entry. `type` and `rel_type` carry the same
/// relationship kind (1 = friend, 2 = blocked, 3 = pending incoming,
/// 4 = pending outgoing); both names are sent for compatibility.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Relationship {
    /// `"<user_id>:<target_id>"`, not a snowflake.
    pub id: String,
    pub user_id: String,
    pub target_id: String,
    #[serde(rename = "type")]
    pub relationship_type: i32,
    pub rel_type: i32,
    pub created_at: String,
    pub user: RelationshipUser,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct CreateRelationshipRequest {
    pub user_id: Option<String>,
    pub username: Option<String>,
    /// Only 1 (friend request) and 2 (block) are accepted.
    #[serde(rename = "type")]
    pub relationship_type: Option<i32>,
}
