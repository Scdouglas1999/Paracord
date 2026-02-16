pub mod client;
pub mod protocol;
pub mod signing;
pub mod transport;

use client::FederationClient;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use paracord_db::DbPool;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;

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
    #[error("http error: {0}")]
    Http(String),
    #[error("remote server error: {0}")]
    RemoteError(String),
    #[error("unknown server: {0}")]
    UnknownServer(String),
}

#[derive(Debug, Clone)]
pub struct FederationConfig {
    pub enabled: bool,
    pub server_name: String,
    pub domain: String,
    pub key_id: String,
    pub signing_key: Option<SigningKey>,
    pub allow_discovery: bool,
}

impl FederationConfig {
    pub fn disabled(server_name: impl Into<String>) -> Self {
        let name = server_name.into();
        Self {
            enabled: false,
            server_name: name.clone(),
            domain: name,
            key_id: "ed25519:auto".to_string(),
            signing_key: None,
            allow_discovery: false,
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

    pub fn domain(&self) -> &str {
        &self.config.domain
    }

    pub fn key_id(&self) -> &str {
        &self.config.key_id
    }

    pub fn allow_discovery(&self) -> bool {
        self.config.allow_discovery
    }

    pub fn config(&self) -> &FederationConfig {
        &self.config
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
        let public_key_bytes =
            hex_decode(public_key_hex).ok_or(FederationError::InvalidSignature)?;
        let signature = Signature::from_slice(&signature_bytes)
            .map_err(|_| FederationError::InvalidSignature)?;
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
        .bind(serde_json::to_string(&envelope.content).map_err(|e| {
            FederationError::Database(sqlx::Error::Protocol(format!(
                "invalid federation content json: {e}"
            )))
        })?)
        .bind(envelope.depth)
        .bind(&envelope.state_key)
        .bind(serde_json::to_string(&envelope.signatures).map_err(|e| {
            FederationError::Database(sqlx::Error::Protocol(format!(
                "invalid federation signatures json: {e}"
            )))
        })?)
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

    /// Build a signed `FederationEventEnvelope` for a message event.
    ///
    /// `guild_id` is encoded in `room_id` so membership and message events
    /// share the same federated room namespace. `sender_username` is the
    /// local user's display name used to build the federated identity string.
    pub fn build_message_envelope(
        &self,
        message_id: i64,
        channel_id: i64,
        guild_id: i64,
        sender_username: &str,
        content: &Value,
        channel_name: Option<&str>,
        channel_type: Option<i16>,
        guild_name: Option<&str>,
        timestamp_ms: i64,
    ) -> Result<FederationEventEnvelope, FederationError> {
        if !self.config.enabled {
            return Err(FederationError::Disabled);
        }

        let event_id = format!("${}:{}", message_id, self.config.domain);
        let room_id = format!("!{}:{}", guild_id, self.config.domain);
        let sender = format!("@{}:{}", sender_username, self.config.domain);
        let mut message_content = serde_json::json!({
            "body": content,
            "msgtype": "m.text",
            "guild_id": guild_id.to_string(),
            "channel_id": channel_id.to_string(),
            "message_id": message_id.to_string(),
        });
        if let Some(name) = channel_name {
            message_content["channel_name"] = Value::String(name.to_string());
        }
        if let Some(kind) = channel_type {
            message_content["channel_type"] = Value::Number(serde_json::Number::from(kind));
        }
        if let Some(name) = guild_name {
            message_content["guild_name"] = Value::String(name.to_string());
        }

        let mut envelope = FederationEventEnvelope {
            event_id,
            room_id,
            event_type: "m.message".to_string(),
            sender,
            origin_server: self.config.server_name.clone(),
            origin_ts: timestamp_ms,
            content: message_content,
            // MVP monotonic depth: use origin timestamp so pagination works.
            depth: timestamp_ms,
            state_key: None,
            signatures: serde_json::json!({}),
        };

        // Build canonical payload (excluding signatures) and sign it
        let canonical = canonical_envelope_bytes(&envelope);
        let signature_hex = self.sign_payload(&canonical)?;
        envelope.signatures = serde_json::json!({
            self.config.server_name.clone(): {
                self.config.key_id.clone(): signature_hex,
            }
        });

        Ok(envelope)
    }

    /// Build a signed custom federation event envelope.
    pub fn build_custom_envelope(
        &self,
        event_type: &str,
        room_id: String,
        sender_username: &str,
        content: &Value,
        timestamp_ms: i64,
        state_key: Option<String>,
        event_stable_id: Option<&str>,
    ) -> Result<FederationEventEnvelope, FederationError> {
        if !self.config.enabled {
            return Err(FederationError::Disabled);
        }

        let event_suffix = event_stable_id.map(str::to_string).unwrap_or_else(|| {
            let content_bytes = serde_json::to_vec(content).unwrap_or_default();
            let digest = transport::sha256_hex(&content_bytes);
            digest.chars().take(12).collect::<String>()
        });
        let event_id = format!(
            "${}:{}:{}:{}",
            event_type.replace('.', "_"),
            event_suffix,
            timestamp_ms,
            self.config.domain
        );
        let sender = format!("@{}:{}", sender_username, self.config.domain);

        let mut envelope = FederationEventEnvelope {
            event_id,
            room_id,
            event_type: event_type.to_string(),
            sender,
            origin_server: self.config.server_name.clone(),
            origin_ts: timestamp_ms,
            content: content.clone(),
            // MVP monotonic depth: use origin timestamp so pagination works.
            depth: timestamp_ms,
            state_key,
            signatures: serde_json::json!({}),
        };

        let canonical = canonical_envelope_bytes(&envelope);
        let signature_hex = self.sign_payload(&canonical)?;
        envelope.signatures = serde_json::json!({
            self.config.server_name.clone(): {
                self.config.key_id.clone(): signature_hex,
            }
        });

        Ok(envelope)
    }

    /// Forward a signed event envelope to all trusted federated peer servers.
    ///
    /// This is intended to be called from within a `tokio::spawn` so that it
    /// does not block the original HTTP response.  Errors for individual peers
    /// are logged and do not propagate.
    pub async fn forward_envelope_to_peers(
        &self,
        pool: &DbPool,
        envelope: &FederationEventEnvelope,
    ) {
        self.forward_envelope_to_peers_inner(pool, envelope, None)
            .await;
    }

    pub async fn forward_envelope_to_peers_except(
        &self,
        pool: &DbPool,
        envelope: &FederationEventEnvelope,
        skip_server: Option<&str>,
    ) {
        self.forward_envelope_to_peers_inner(pool, envelope, skip_server)
            .await;
    }

    async fn forward_envelope_to_peers_inner(
        &self,
        pool: &DbPool,
        envelope: &FederationEventEnvelope,
        skip_server: Option<&str>,
    ) {
        if !self.config.enabled {
            return;
        }

        // Relay cycle guard: if we already persisted this event, skip relaying.
        match self.fetch_event(pool, &envelope.event_id).await {
            Ok(Some(_)) => {
                tracing::debug!(
                    "federation: skipping relay of already-persisted event {}",
                    envelope.event_id
                );
                return;
            }
            Err(e) => {
                tracing::warn!(
                    "federation: relay dedup check failed for {}: {}",
                    envelope.event_id,
                    e
                );
            }
            Ok(None) => {}
        }

        let now_ms = chrono::Utc::now().timestamp_millis();
        let peers = match paracord_db::federation::list_trusted_federated_servers(pool).await {
            Ok(servers) => servers,
            Err(e) => {
                tracing::error!("federation: failed to list trusted peers: {e}");
                return;
            }
        };

        if peers.is_empty() {
            return;
        }

        let scoped_targets = match paracord_db::federation::list_room_member_servers(
            pool,
            &envelope.room_id,
        )
        .await
        {
            Ok(servers) => servers
                .into_iter()
                .map(|name| name.to_ascii_lowercase())
                .collect::<std::collections::HashSet<_>>(),
            Err(err) => {
                tracing::warn!(
                    "federation: failed loading room member targets for {}: {}",
                    envelope.room_id,
                    err
                );
                std::collections::HashSet::new()
            }
        };
        let has_scoped_targets = !scoped_targets.is_empty();

        let client = match self.build_signed_client() {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("federation: failed to create HTTP client: {e}");
                return;
            }
        };

        for peer in &peers {
            // Don't forward back to ourselves
            if peer.server_name == self.config.server_name {
                continue;
            }
            // Don't bounce relayed events back to their origin server.
            if peer.server_name == envelope.origin_server {
                continue;
            }
            if skip_server.is_some_and(|name| name == peer.server_name) {
                continue;
            }
            if has_scoped_targets {
                let peer_server = peer.server_name.to_ascii_lowercase();
                let peer_domain = peer.domain.to_ascii_lowercase();
                if !scoped_targets.contains(&peer_server) && !scoped_targets.contains(&peer_domain)
                {
                    continue;
                }
            }

            if let Err(e) = paracord_db::federation::enqueue_outbound_event(
                pool,
                &peer.server_name,
                &envelope.event_id,
                &envelope.room_id,
                &envelope.event_type,
                &envelope.sender,
                &envelope.origin_server,
                envelope.origin_ts,
                &envelope.content,
                envelope.depth,
                envelope.state_key.as_deref(),
                &envelope.signatures,
                now_ms,
            )
            .await
            {
                tracing::warn!(
                    "federation: failed to enqueue outbound event {} for {}: {}",
                    envelope.event_id,
                    peer.server_name,
                    e
                );
            }

            let attempt_started = std::time::Instant::now();
            match client.post_event(&peer.federation_endpoint, envelope).await {
                Ok(resp) => {
                    let latency_ms = attempt_started.elapsed().as_millis() as i64;
                    let attempt_ts = chrono::Utc::now().timestamp_millis();
                    let _ = paracord_db::federation::record_delivery_attempt(
                        pool,
                        &peer.server_name,
                        &envelope.event_id,
                        true,
                        Some(202),
                        None,
                        Some(latency_ms),
                        attempt_ts,
                    )
                    .await;
                    let _ = paracord_db::federation::mark_outbound_event_delivered(
                        pool,
                        &peer.server_name,
                        &envelope.event_id,
                    )
                    .await;
                    tracing::info!(
                        "federation: forwarded event {} to {} (inserted={})",
                        envelope.event_id,
                        peer.server_name,
                        resp.inserted,
                    );
                }
                Err(e) => {
                    let latency_ms = attempt_started.elapsed().as_millis() as i64;
                    let attempt_ts = chrono::Utc::now().timestamp_millis();
                    let retry_at = next_retry_ts(attempt_ts, 0);
                    let err_msg = e.to_string();
                    let _ = paracord_db::federation::record_delivery_attempt(
                        pool,
                        &peer.server_name,
                        &envelope.event_id,
                        false,
                        None,
                        Some(&err_msg),
                        Some(latency_ms),
                        attempt_ts,
                    )
                    .await;
                    let _ = paracord_db::federation::mark_outbound_event_retry(
                        pool,
                        &peer.server_name,
                        &envelope.event_id,
                        retry_at,
                        Some(&err_msg),
                        attempt_ts,
                    )
                    .await;
                    tracing::warn!(
                        "federation: failed to forward event {} to {}: {e}",
                        envelope.event_id,
                        peer.server_name,
                    );
                }
            }
        }
    }

    pub async fn process_outbound_queue_once(&self, pool: &DbPool, limit: i64) {
        if !self.config.enabled {
            return;
        }

        // Purge events that have exceeded max retries or max age before processing.
        const MAX_RETRY_ATTEMPTS: i64 = 12;
        const MAX_EVENT_AGE_MS: i64 = 86_400_000; // 24 hours
        let now_ms = chrono::Utc::now().timestamp_millis();
        match paracord_db::federation::purge_expired_outbound_events(
            pool,
            now_ms,
            MAX_RETRY_ATTEMPTS,
            MAX_EVENT_AGE_MS,
        )
        .await
        {
            Ok(purged) if purged > 0 => {
                tracing::info!(
                    "federation: purged {} expired outbound queue entries",
                    purged
                );
            }
            Err(e) => {
                tracing::warn!("federation: failed to purge expired outbound events: {}", e);
            }
            _ => {}
        }
        let due =
            match paracord_db::federation::fetch_due_outbound_events(pool, now_ms, limit).await {
                Ok(rows) => rows,
                Err(e) => {
                    tracing::warn!("federation: failed to load outbound queue: {}", e);
                    return;
                }
            };
        if due.is_empty() {
            return;
        }

        let client = match self.build_signed_client() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("federation: queue delivery client unavailable: {e}");
                return;
            }
        };

        for row in due {
            let envelope = FederationEventEnvelope {
                event_id: row.event_id.clone(),
                room_id: row.room_id.clone(),
                event_type: row.event_type.clone(),
                sender: row.sender.clone(),
                origin_server: row.origin_server.clone(),
                origin_ts: row.origin_ts,
                content: row.content.clone(),
                depth: row.depth,
                state_key: row.state_key.clone(),
                signatures: row.signatures.clone(),
            };

            let started = std::time::Instant::now();
            let delivered = client.post_event(&row.federation_endpoint, &envelope).await;
            let attempt_ts = chrono::Utc::now().timestamp_millis();
            let latency_ms = started.elapsed().as_millis() as i64;

            match delivered {
                Ok(_) => {
                    let _ = paracord_db::federation::record_delivery_attempt(
                        pool,
                        &row.destination_server,
                        &row.event_id,
                        true,
                        Some(202),
                        None,
                        Some(latency_ms),
                        attempt_ts,
                    )
                    .await;
                    let _ = paracord_db::federation::mark_outbound_event_delivered(
                        pool,
                        &row.destination_server,
                        &row.event_id,
                    )
                    .await;
                }
                Err(e) => {
                    let err_msg = e.to_string();
                    let retry_at = next_retry_ts(attempt_ts, row.attempt_count);
                    let _ = paracord_db::federation::record_delivery_attempt(
                        pool,
                        &row.destination_server,
                        &row.event_id,
                        false,
                        None,
                        Some(&err_msg),
                        Some(latency_ms),
                        attempt_ts,
                    )
                    .await;
                    let _ = paracord_db::federation::mark_outbound_event_retry(
                        pool,
                        &row.destination_server,
                        &row.event_id,
                        retry_at,
                        Some(&err_msg),
                        attempt_ts,
                    )
                    .await;
                }
            }
        }
    }

    fn build_signed_client(&self) -> Result<FederationClient, FederationError> {
        let signing_key = self
            .config
            .signing_key
            .clone()
            .ok_or(FederationError::MissingSigningKey)?;
        FederationClient::new_signed(
            self.config.server_name.clone(),
            self.config.key_id.clone(),
            signing_key,
        )
    }

    pub async fn list_room_events(
        &self,
        pool: &DbPool,
        room_id: &str,
        since_depth: i64,
        limit: i64,
    ) -> Result<Vec<FederationEventEnvelope>, FederationError> {
        if !self.config.enabled {
            return Err(FederationError::Disabled);
        }
        let rows = sqlx::query_as::<_, FederationEventEnvelopeRow>(
            "SELECT event_id, room_id, event_type, sender, origin_server, origin_ts, content, depth, state_key, signatures
             FROM federation_events
             WHERE room_id = $1
               AND depth > $2
             ORDER BY depth ASC
             LIMIT $3",
        )
        .bind(room_id)
        .bind(since_depth)
        .bind(limit.max(1))
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }
}

fn next_retry_ts(now_ms: i64, attempt_count: i64) -> i64 {
    let exp = (attempt_count.clamp(0, 8)) as u32;
    let delay_ms = 5_000_i64.saturating_mul(1_i64 << exp);
    now_ms.saturating_add(delay_ms.min(3_600_000))
}

/// Build the canonical bytes used for signing an envelope (excludes signatures).
pub fn canonical_envelope_bytes(envelope: &FederationEventEnvelope) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "event_id": envelope.event_id,
        "room_id": envelope.room_id,
        "event_type": envelope.event_type,
        "sender": envelope.sender,
        "origin_server": envelope.origin_server,
        "origin_ts": envelope.origin_ts,
        "content": envelope.content,
        "depth": envelope.depth,
        "state_key": envelope.state_key,
    }))
    .unwrap_or_default()
}

#[derive(Debug, Clone)]
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

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for FederationEventEnvelopeRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let content_raw: String = row.try_get("content")?;
        let signatures_raw: String = row.try_get("signatures")?;
        let content = serde_json::from_str(&content_raw)
            .map_err(|e| sqlx::Error::Protocol(format!("invalid content json: {e}")))?;
        let signatures = serde_json::from_str(&signatures_raw)
            .map_err(|e| sqlx::Error::Protocol(format!("invalid signatures json: {e}")))?;
        Ok(Self {
            event_id: row.try_get("event_id")?,
            room_id: row.try_get("room_id")?,
            event_type: row.try_get("event_type")?,
            sender: row.try_get("sender")?,
            origin_server: row.try_get("origin_server")?,
            origin_ts: row.try_get("origin_ts")?,
            content,
            depth: row.try_get("depth")?,
            state_key: row.try_get("state_key")?,
            signatures,
        })
    }
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

pub fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

pub fn hex_decode(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(value.len() / 2);
    let mut i = 0;
    while i < value.len() {
        let byte = u8::from_str_radix(&value[i..i + 2], 16).ok()?;
        out.push(byte);
        i += 2;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_service() -> FederationService {
        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        FederationService::new(FederationConfig {
            enabled: true,
            server_name: "node-a.example".to_string(),
            domain: "chat.example".to_string(),
            key_id: "ed25519:test".to_string(),
            signing_key: Some(signing_key),
            allow_discovery: false,
        })
    }

    #[test]
    fn message_envelope_uses_guild_room_and_timestamp_depth() {
        let service = test_service();
        let ts = 1_700_000_000_123_i64;
        let env = service
            .build_message_envelope(
                100,
                200,
                300,
                "alice",
                &serde_json::json!("hello"),
                Some("general"),
                Some(0),
                Some("Guild"),
                ts,
            )
            .expect("message envelope should build");
        assert_eq!(env.room_id, "!300:chat.example");
        assert_eq!(env.depth, ts);
        assert_eq!(env.event_type, "m.message");
    }

    #[test]
    fn custom_envelope_uses_timestamp_depth() {
        let service = test_service();
        let ts = 1_700_000_000_999_i64;
        let env = service
            .build_custom_envelope(
                "m.member.join",
                "!42:chat.example".to_string(),
                "bob",
                &serde_json::json!({"guild_id":"42","user_id":"123"}),
                ts,
                None,
                Some("42:123"),
            )
            .expect("custom envelope should build");
        assert_eq!(env.depth, ts);
        assert_eq!(env.room_id, "!42:chat.example");
    }
}
