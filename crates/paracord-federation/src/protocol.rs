use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A federated user identity in the form `@username:server.domain`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FederatedIdentity {
    pub localpart: String,
    pub server: String,
}

impl FederatedIdentity {
    pub fn new(localpart: impl Into<String>, server: impl Into<String>) -> Self {
        Self {
            localpart: localpart.into(),
            server: server.into(),
        }
    }

    /// Parse from the canonical `@localpart:server` string format.
    pub fn parse(input: &str) -> Option<Self> {
        let stripped = input.strip_prefix('@')?;
        let colon_pos = stripped.find(':')?;
        let localpart = &stripped[..colon_pos];
        let server = &stripped[colon_pos + 1..];
        if localpart.is_empty() || server.is_empty() {
            return None;
        }
        Some(Self {
            localpart: localpart.to_string(),
            server: server.to_string(),
        })
    }

    /// Return the canonical `@localpart:server` string representation.
    pub fn to_canonical(&self) -> String {
        format!("@{}:{}", self.localpart, self.server)
    }

    /// Check whether this identity belongs to the given server domain.
    pub fn is_local(&self, domain: &str) -> bool {
        self.server == domain
    }
}

impl std::fmt::Display for FederatedIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "@{}:{}", self.localpart, self.server)
    }
}

/// Describes a remote Paracord server discovered via `.well-known` or manual linking.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerInfo {
    pub server_name: String,
    pub domain: String,
    pub federation_endpoint: String,
    pub enabled: bool,
    #[serde(default)]
    pub version: Option<String>,
}

/// A signed event envelope used for server-to-server event transport.
/// This wraps arbitrary event data with origin information and a cryptographic signature.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FederatedEvent {
    pub event_id: String,
    pub event_type: String,
    pub sender: String,
    pub origin_server: String,
    pub origin_ts: i64,
    pub content: Value,
    pub room_id: Option<String>,
    pub guild_id: Option<String>,
    pub signatures: Value,
}

impl FederatedEvent {
    /// Build the canonical bytes used for signing (excludes signatures field).
    pub fn canonical_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "event_id": self.event_id,
            "event_type": self.event_type,
            "sender": self.sender,
            "origin_server": self.origin_server,
            "origin_ts": self.origin_ts,
            "content": self.content,
            "room_id": self.room_id,
            "guild_id": self.guild_id,
        }))
        .unwrap_or_default()
    }
}

/// A linked/known federated server record stored in the database.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct FederatedServer {
    pub id: i64,
    pub server_name: String,
    pub domain: String,
    pub federation_endpoint: String,
    pub public_key_hex: Option<String>,
    pub key_id: Option<String>,
    pub trusted: bool,
    pub last_seen_at: Option<String>,
    pub created_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_federated_identity() {
        let id = FederatedIdentity::parse("@alice:example.com").unwrap();
        assert_eq!(id.localpart, "alice");
        assert_eq!(id.server, "example.com");
        assert_eq!(id.to_canonical(), "@alice:example.com");
    }

    #[test]
    fn parse_federated_identity_invalid() {
        assert!(FederatedIdentity::parse("alice:example.com").is_none());
        assert!(FederatedIdentity::parse("@:example.com").is_none());
        assert!(FederatedIdentity::parse("@alice:").is_none());
        assert!(FederatedIdentity::parse("@alice").is_none());
    }

    #[test]
    fn is_local_check() {
        let id = FederatedIdentity::new("alice", "my.server");
        assert!(id.is_local("my.server"));
        assert!(!id.is_local("other.server"));
    }
}
