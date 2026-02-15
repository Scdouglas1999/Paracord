use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use paracord_db::DbPool;
use paracord_util::hex::{hex_decode, hex_encode};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum FederationError {
    #[error("federation is disabled")]
    Disabled,
    #[error("missing signing key")]
    MissingSigningKey,
    #[error("invalid signature")]
    InvalidSignature,
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
}

#[derive(Debug, Clone)]
pub struct FederationConfig {
    pub enabled: bool,
    pub server_name: String,
    pub key_id: String,
    pub signing_key: Option<SigningKey>,
}

impl FederationConfig {
    pub fn disabled(server_name: impl Into<String>) -> Self {
        Self {
            enabled: false,
            server_name: server_name.into(),
            key_id: "ed25519:auto".to_string(),
            signing_key: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct FederationService {
    config: FederationConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FederationEventEnvelope {
    pub event_id: String,
    pub room_id: String,
    pub event_type: String,
    pub sender: String,
    pub origin_server: String,
    pub origin_ts: i64,
    pub content: Value,
    pub depth: i64,
    pub state_key: Option<String>,
    pub signatures: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct FederationServerKey {
    pub server_name: String,
    pub key_id: String,
    pub public_key: String,
    pub valid_until: i64,
}

impl FederationService {
    pub fn new(config: FederationConfig) -> Self {
        Self { config }
    }

    pub fn is_enabled(&self) -> bool {
        self.config.enabled
    }

    pub fn server_name(&self) -> &str {
        &self.config.server_name
    }

    pub fn key_id(&self) -> &str {
        &self.config.key_id
    }

    pub fn signing_public_key(&self) -> Option<String> {
        self.config
            .signing_key
            .as_ref()
            .map(|key| hex_encode(&key.verifying_key().to_bytes()))
    }

    pub fn sign_payload(&self, payload: &[u8]) -> Result<String, FederationError> {
        if !self.config.enabled {
            return Err(FederationError::Disabled);
        }
        let signing_key = self
            .config
            .signing_key
            .as_ref()
            .ok_or(FederationError::MissingSigningKey)?;
        let signature = signing_key.sign(payload);
        Ok(hex_encode(&signature.to_bytes()))
    }

    pub fn verify_payload(
        &self,
        payload: &[u8],
        signature_hex: &str,
        public_key_hex: &str,
    ) -> Result<(), FederationError> {
        let signature_bytes = hex_decode(signature_hex).ok_or(FederationError::InvalidSignature)?;
        let public_key_bytes = hex_decode(public_key_hex).ok_or(FederationError::InvalidSignature)?;
        let signature =
            Signature::from_slice(&signature_bytes).map_err(|_| FederationError::InvalidSignature)?;
        let key_bytes: [u8; 32] = public_key_bytes
            .try_into()
            .map_err(|_| FederationError::InvalidSignature)?;
        let verifying_key =
            VerifyingKey::from_bytes(&key_bytes).map_err(|_| FederationError::InvalidSignature)?;
        verifying_key
            .verify(payload, &signature)
            .map_err(|_| FederationError::InvalidSignature)
    }

    pub async fn persist_event(
        &self,
        pool: &DbPool,
        envelope: &FederationEventEnvelope,
    ) -> Result<bool, FederationError> {
        if !self.config.enabled {
            return Err(FederationError::Disabled);
        }
        let rows = sqlx::query(
            "INSERT INTO federation_events (event_id, room_id, event_type, sender, origin_server, origin_ts, content, depth, state_key, signatures)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (event_id) DO NOTHING",
        )
        .bind(&envelope.event_id)
        .bind(&envelope.room_id)
        .bind(&envelope.event_type)
        .bind(&envelope.sender)
        .bind(&envelope.origin_server)
        .bind(envelope.origin_ts)
        .bind(&envelope.content)
        .bind(envelope.depth)
        .bind(&envelope.state_key)
        .bind(&envelope.signatures)
        .execute(pool)
        .await?
        .rows_affected();
        Ok(rows > 0)
    }

    pub async fn fetch_event(
        &self,
        pool: &DbPool,
        event_id: &str,
    ) -> Result<Option<FederationEventEnvelope>, FederationError> {
        if !self.config.enabled {
            return Err(FederationError::Disabled);
        }
        let row = sqlx::query_as::<_, FederationEventEnvelopeRow>(
            "SELECT event_id, room_id, event_type, sender, origin_server, origin_ts, content, depth, state_key, signatures
             FROM federation_events WHERE event_id = $1",
        )
        .bind(event_id)
        .fetch_optional(pool)
        .await?;
        Ok(row.map(|r| r.into()))
    }

    pub async fn upsert_server_key(
        &self,
        pool: &DbPool,
        key: &FederationServerKey,
    ) -> Result<(), FederationError> {
        if !self.config.enabled {
            return Err(FederationError::Disabled);
        }
        sqlx::query(
            "INSERT INTO federation_server_keys (server_name, key_id, public_key, valid_until)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (server_name, key_id) DO UPDATE SET public_key = EXCLUDED.public_key, valid_until = EXCLUDED.valid_until",
        )
        .bind(&key.server_name)
        .bind(&key.key_id)
        .bind(&key.public_key)
        .bind(key.valid_until)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn list_server_keys(
        &self,
        pool: &DbPool,
        server_name: &str,
    ) -> Result<Vec<FederationServerKey>, FederationError> {
        if !self.config.enabled {
            return Err(FederationError::Disabled);
        }
        let rows = sqlx::query_as::<_, FederationServerKey>(
            "SELECT server_name, key_id, public_key, valid_until
             FROM federation_server_keys
             WHERE server_name = $1",
        )
        .bind(server_name)
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct FederationEventEnvelopeRow {
    event_id: String,
    room_id: String,
    event_type: String,
    sender: String,
    origin_server: String,
    origin_ts: i64,
    content: Value,
    depth: i64,
    state_key: Option<String>,
    signatures: Value,
}

impl From<FederationEventEnvelopeRow> for FederationEventEnvelope {
    fn from(value: FederationEventEnvelopeRow) -> Self {
        Self {
            event_id: value.event_id,
            room_id: value.room_id,
            event_type: value.event_type,
            sender: value.sender,
            origin_server: value.origin_server,
            origin_ts: value.origin_ts,
            content: value.content,
            depth: value.depth,
            state_key: value.state_key,
            signatures: value.signatures,
        }
    }
}

pub fn is_enabled() -> bool {
    std::env::var("PARACORD_FEDERATION_ENABLED")
        .ok()
        .and_then(|v| v.parse::<bool>().ok())
        .unwrap_or(false)
}

