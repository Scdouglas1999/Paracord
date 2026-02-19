use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    http::{HeaderMap, Uri},
    Json,
};
use ed25519_dalek::SigningKey;
use paracord_core::AppState;
use paracord_federation::{
    client::FederationClient, protocol::FederatedIdentity, FederationConfig,
    FederationEventEnvelope, FederationServerKey, FederationService,
};
use paracord_models::permissions::Permissions;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AdminUser;

fn parse_signing_key() -> Option<SigningKey> {
    let raw = std::env::var("PARACORD_FEDERATION_SIGNING_KEY_HEX").ok()?;
    if raw.len() != 64 {
        return None;
    }
    let mut bytes = [0u8; 32];
    for (idx, chunk) in raw.as_bytes().chunks(2).enumerate() {
        let s = std::str::from_utf8(chunk).ok()?;
        bytes[idx] = u8::from_str_radix(s, 16).ok()?;
    }
    Some(SigningKey::from_bytes(&bytes))
}

/// Build a `FederationService` from environment variables.
///
/// Prefer using `state.federation_service` from AppState when available.
/// This fallback is kept for backward compatibility with code paths that
/// don't have access to AppState (e.g. standalone CLI tools).
pub fn build_federation_service() -> FederationService {
    let enabled = std::env::var("PARACORD_FEDERATION_ENABLED")
        .ok()
        .and_then(|v| v.parse::<bool>().ok())
        .unwrap_or(false);
    let server_name =
        std::env::var("PARACORD_SERVER_NAME").unwrap_or_else(|_| "localhost".to_string());
    let domain =
        std::env::var("PARACORD_FEDERATION_DOMAIN").unwrap_or_else(|_| server_name.clone());
    let key_id =
        std::env::var("PARACORD_FEDERATION_KEY_ID").unwrap_or_else(|_| "ed25519:auto".to_string());
    let allow_discovery = std::env::var("PARACORD_FEDERATION_ALLOW_DISCOVERY")
        .ok()
        .and_then(|v| v.parse::<bool>().ok())
        .unwrap_or(false);
    FederationService::new(FederationConfig {
        enabled,
        server_name,
        domain,
        key_id,
        signing_key: parse_signing_key(),
        allow_discovery,
    })
}

/// Get the FederationService from AppState, falling back to env-var construction.
fn federation_service_from_state(state: &AppState) -> FederationService {
    state
        .federation_service
        .clone()
        .unwrap_or_else(build_federation_service)
}

fn federation_service() -> FederationService {
    build_federation_service()
}

/// Maximum serialized content size for inbound federation events (1 MB).
const MAX_CONTENT_SIZE_BYTES: usize = 1_048_576;
/// Maximum JSON nesting depth for inbound federation event content.
const MAX_CONTENT_DEPTH: usize = 32;
/// Maximum number of elements/keys allowed in a single JSON collection.
const MAX_COLLECTION_LENGTH: usize = 10_000;

fn validate_federation_content(content: &Value) -> Result<(), ApiError> {
    let serialized = serde_json::to_vec(content).unwrap_or_default();
    if serialized.len() > MAX_CONTENT_SIZE_BYTES {
        return Err(ApiError::BadRequest(format!(
            "federation event content exceeds maximum size of {} bytes",
            MAX_CONTENT_SIZE_BYTES
        )));
    }
    match validate_json_structure(content) {
        Err(reason) => return Err(ApiError::BadRequest(reason.to_string())),
        Ok(depth) if depth > MAX_CONTENT_DEPTH => {
            return Err(ApiError::BadRequest(format!(
                "federation event content exceeds maximum nesting depth of {}",
                MAX_CONTENT_DEPTH
            )));
        }
        _ => {}
    }
    Ok(())
}

fn validate_json_structure(value: &Value) -> Result<usize, &'static str> {
    match value {
        Value::Array(arr) => {
            if arr.len() > MAX_COLLECTION_LENGTH {
                return Err("federation event content array exceeds maximum element count");
            }
            let mut max_child = 0;
            for child in arr {
                max_child = max_child.max(validate_json_structure(child)?);
            }
            Ok(1 + max_child)
        }
        Value::Object(obj) => {
            if obj.len() > MAX_COLLECTION_LENGTH {
                return Err("federation event content object exceeds maximum key count");
            }
            let mut max_child = 0;
            for child in obj.values() {
                max_child = max_child.max(validate_json_structure(child)?);
            }
            Ok(1 + max_child)
        }
        _ => Ok(0),
    }
}

pub fn build_signed_federation_client(service: &FederationService) -> Option<FederationClient> {
    let signing_key = service.config().signing_key.clone()?;
    FederationClient::new_signed(
        service.server_name().to_string(),
        service.key_id().to_string(),
        signing_key,
    )
    .ok()
}

#[derive(Debug, Clone)]
pub struct FederationOutboundContext {
    pub room_id: String,
    pub payload_guild_id: String,
    pub payload_channel_id: Option<String>,
    pub uses_remote_mapping: bool,
    pub origin_server: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FederationRemoteTarget {
    pub server_name: String,
    pub domain: String,
    pub federation_endpoint: String,
}

pub async fn resolve_remote_target_for_outbound_context(
    state: &AppState,
    outbound: &FederationOutboundContext,
) -> Option<FederationRemoteTarget> {
    if !outbound.uses_remote_mapping {
        return None;
    }

    let namespace = outbound
        .origin_server
        .clone()
        .or_else(|| parse_room_parts(&outbound.room_id).map(|(_, domain)| domain.to_string()))?;
    let peers = paracord_db::federation::list_trusted_federated_servers(&state.db)
        .await
        .ok()?;
    let peer = peers.into_iter().find(|peer| {
        peer.server_name.eq_ignore_ascii_case(&namespace)
            || peer.domain.eq_ignore_ascii_case(&namespace)
    })?;
    Some(FederationRemoteTarget {
        server_name: peer.server_name,
        domain: peer.domain,
        federation_endpoint: peer.federation_endpoint,
    })
}

pub async fn local_federated_user_id(
    state: &AppState,
    service: &FederationService,
    user_id: i64,
) -> Option<String> {
    let user = paracord_db::users::get_user_by_id(&state.db, user_id)
        .await
        .ok()
        .flatten()?;
    Some(format!("@{}:{}", user.username, service.domain()))
}

pub async fn resolve_outbound_context(
    state: &AppState,
    service: &FederationService,
    guild_id: i64,
    channel_id: Option<i64>,
) -> FederationOutboundContext {
    let mut context = FederationOutboundContext {
        room_id: canonical_local_room_id(service, guild_id),
        payload_guild_id: guild_id.to_string(),
        payload_channel_id: channel_id.map(|id| id.to_string()),
        uses_remote_mapping: false,
        origin_server: None,
    };

    let Some(space_mapping) =
        paracord_db::federation::get_space_mapping_by_local(&state.db, guild_id)
            .await
            .ok()
            .flatten()
    else {
        return context;
    };

    // If this guild is mirrored from another namespace, emit outbound events
    // using that room namespace so all servers stay in one converged room graph.
    let is_local_namespace = space_mapping
        .origin_server
        .eq_ignore_ascii_case(service.domain())
        || space_mapping
            .origin_server
            .eq_ignore_ascii_case(service.server_name());
    if is_local_namespace {
        return context;
    }

    context.room_id = remote_room_id(&space_mapping.remote_space_id, &space_mapping.origin_server);
    context.payload_guild_id = space_mapping.remote_space_id.clone();
    context.uses_remote_mapping = true;
    context.origin_server = Some(space_mapping.origin_server.clone());

    if let Some(local_channel_id) = channel_id {
        if let Some(channel_mapping) =
            paracord_db::federation::get_channel_mapping_by_local(&state.db, local_channel_id)
                .await
                .ok()
                .flatten()
        {
            if channel_mapping.local_guild_id == guild_id
                && channel_mapping
                    .origin_server
                    .eq_ignore_ascii_case(&space_mapping.origin_server)
            {
                context.payload_channel_id = Some(channel_mapping.remote_channel_id);
            }
        }
    }

    context
}

fn optional_federation_read_token() -> Option<String> {
    std::env::var("PARACORD_FEDERATION_READ_TOKEN")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn parse_room_parts(room_id: &str) -> Option<(i64, &str)> {
    // Canonical room format: !<guild_id>:<domain>
    let raw = room_id.strip_prefix('!')?;
    let (id_part, domain) = raw.split_once(':')?;
    let guild_id = id_part.parse::<i64>().ok()?;
    let domain = domain.trim();
    if domain.is_empty() {
        return None;
    }
    Some((guild_id, domain))
}

fn parse_local_room_guild_id(service: &FederationService, room_id: &str) -> Option<i64> {
    let (guild_id, domain) = parse_room_parts(room_id)?;
    let local_domain = service.domain();
    let local_server_name = service.server_name();
    if !domain.eq_ignore_ascii_case(local_domain) && !domain.eq_ignore_ascii_case(local_server_name)
    {
        return None;
    }
    Some(guild_id)
}

fn canonical_local_room_id(service: &FederationService, guild_id: i64) -> String {
    format!("!{}:{}", guild_id, service.domain())
}

fn remote_room_id(remote_space_id: &str, remote_domain: &str) -> String {
    format!("!{}:{}", remote_space_id, remote_domain)
}

fn mapping_namespace_from_room(room_id: &str, fallback_origin: &str) -> String {
    parse_room_parts(room_id)
        .map(|(_, domain)| domain.to_string())
        .unwrap_or_else(|| fallback_origin.to_string())
}

fn ensure_identity_matches_origin(
    identity: &FederatedIdentity,
    origin_server: &str,
) -> Result<(), ApiError> {
    if identity.server.eq_ignore_ascii_case(origin_server) {
        return Ok(());
    }
    Err(ApiError::Forbidden)
}

async fn ensure_identity_matches_origin_or_alias(
    state: &AppState,
    identity: &FederatedIdentity,
    origin_server: &str,
) -> Result<(), ApiError> {
    if ensure_identity_matches_origin(identity, origin_server).is_ok() {
        return Ok(());
    }

    let peers = paracord_db::federation::list_trusted_federated_servers(&state.db)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let matches_alias = peers.into_iter().any(|peer| {
        let origin_matches = peer.server_name.eq_ignore_ascii_case(origin_server)
            || peer.domain.eq_ignore_ascii_case(origin_server);
        let identity_matches = identity.server.eq_ignore_ascii_case(&peer.server_name)
            || identity.server.eq_ignore_ascii_case(&peer.domain);
        origin_matches && identity_matches
    });
    if matches_alias {
        Ok(())
    } else {
        Err(ApiError::Forbidden)
    }
}

fn parse_federation_allowed_guild_ids() -> Vec<i64> {
    std::env::var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS")
        .ok()
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .filter_map(|v| v.parse::<i64>().ok())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn ensure_federation_guild_allowed(guild_id: i64) -> Result<(), ApiError> {
    let allowlist = parse_federation_allowed_guild_ids();
    if allowlist.iter().any(|allowed| *allowed == guild_id) {
        return Ok(());
    }
    Err(ApiError::Forbidden)
}

#[derive(Debug)]
struct FederationTransportHeaders {
    origin: String,
    key_id: String,
    timestamp_ms: i64,
    signature_hex: String,
}

fn parse_transport_headers(headers: &HeaderMap) -> Result<FederationTransportHeaders, ApiError> {
    let origin = headers
        .get("x-paracord-origin")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or(ApiError::Unauthorized)?
        .to_string();
    let key_id = headers
        .get("x-paracord-key-id")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or(ApiError::Unauthorized)?
        .to_string();
    let timestamp_ms = headers
        .get("x-paracord-timestamp")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<i64>().ok())
        .ok_or(ApiError::Unauthorized)?;
    let signature_hex = headers
        .get("x-paracord-signature")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or(ApiError::Unauthorized)?
        .to_string();
    Ok(FederationTransportHeaders {
        origin,
        key_id,
        timestamp_ms,
        signature_hex,
    })
}

async fn verify_transport_request(
    state: &AppState,
    service: &FederationService,
    headers: &HeaderMap,
    method: &str,
    path: &str,
    body_bytes: &[u8],
    expected_origin: Option<&str>,
    enforce_replay_protection: bool,
) -> Result<FederationTransportHeaders, ApiError> {
    let transport = parse_transport_headers(headers)?;
    if let Some(expected) = expected_origin {
        if transport.origin != expected {
            return Err(ApiError::Forbidden);
        }
    }

    let now_ms = chrono::Utc::now().timestamp_millis();
    if (now_ms - transport.timestamp_ms).abs() > paracord_federation::transport::DEFAULT_MAX_SKEW_MS
    {
        return Err(ApiError::Unauthorized);
    }

    let trusted =
        paracord_db::federation::is_federated_server_trusted(&state.db, &transport.origin, now_ms)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !trusted {
        return Err(ApiError::Forbidden);
    }

    let keys = service
        .list_server_keys(&state.db, &transport.origin)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let trusted_key = keys
        .iter()
        .find(|k| k.key_id == transport.key_id && k.valid_until >= now_ms)
        .ok_or(ApiError::Forbidden)?;

    let canonical = paracord_federation::transport::canonical_transport_bytes_with_body(
        method,
        path,
        transport.timestamp_ms,
        body_bytes,
    );
    service
        .verify_payload(
            &canonical,
            &transport.signature_hex,
            &trusted_key.public_key,
        )
        .map_err(|_| ApiError::Forbidden)?;

    if enforce_replay_protection {
        let replay_material = format!(
            "{}\n{}\n{}\n{}\n{}",
            transport.origin,
            transport.key_id,
            transport.timestamp_ms,
            path,
            transport.signature_hex
        );
        let replay_key = paracord_federation::transport::sha256_hex(replay_material.as_bytes());
        let inserted_replay = paracord_db::federation::insert_transport_replay_key(
            &state.db,
            &transport.origin,
            &replay_key,
            transport.timestamp_ms,
        )
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        if !inserted_replay {
            return Err(ApiError::Conflict(
                "replayed federation transport signature".to_string(),
            ));
        }
        let _ =
            paracord_db::federation::prune_transport_replay_cache(&state.db, now_ms - 86_400_000)
                .await;
    }

    Ok(transport)
}

fn sanitize_remote_username(localpart: &str, fallback: &str) -> String {
    let mut out: String = localpart
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .collect();
    if out.is_empty() {
        out = fallback.to_string();
    }
    if out.len() > 24 {
        out.truncate(24);
    }
    out
}

async fn ensure_remote_user_mapping(
    state: &AppState,
    identity: &FederatedIdentity,
) -> Result<i64, ApiError> {
    let remote_id = identity.to_canonical();
    if let Some(existing) = paracord_db::federation::get_remote_user_mapping(&state.db, &remote_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    {
        return Ok(existing.local_user_id);
    }

    // Per-peer rate limiting on remote user creation
    if let Some(limit) = state.config.federation_max_user_creates_per_peer_per_hour {
        if limit > 0 {
            let now = chrono::Utc::now().timestamp();
            let hour = now / 3600;
            let bucket_key = format!("fed:user_create:{}", identity.server);
            let count = paracord_db::rate_limits::increment_window_counter(
                &state.db,
                &bucket_key,
                hour,
                3600,
            )
            .await
            .unwrap_or(0);
            if count > limit as i64 {
                return Err(ApiError::RateLimited);
            }
        }
    }

    let digest = paracord_federation::transport::sha256_hex(remote_id.as_bytes());
    let username = format!(
        "{}_{}",
        sanitize_remote_username(&identity.localpart, "remote"),
        &digest[..6]
    );
    let email = format!("fed+{}@remote.invalid", &digest[..24]);
    let user_id = paracord_util::snowflake::generate(1);

    let created =
        paracord_db::users::create_user(&state.db, user_id, &username, 0, &email, "!federated!")
            .await;
    if let Err(err) = created {
        return Err(ApiError::Internal(anyhow::anyhow!(
            "failed to create remote federated user {}: {}",
            remote_id,
            err
        )));
    }

    paracord_db::federation::upsert_remote_user_mapping(
        &state.db,
        &remote_id,
        &identity.server,
        user_id,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(user_id)
}

fn canonical_event_payload_bytes(envelope: &FederationEventEnvelope) -> Vec<u8> {
    serde_json::to_vec(&json!({
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

fn extract_signature_for_origin(
    signatures: &Value,
    origin_server: &str,
) -> Option<(String, String)> {
    // Preferred format: { "<origin_server>": { "<key_id>": "<signature_hex>" } }
    if let Some(by_origin) = signatures.get(origin_server).and_then(|v| v.as_object()) {
        for (key_id, signature) in by_origin {
            if let Some(sig) = signature.as_str() {
                return Some((key_id.clone(), sig.to_string()));
            }
        }
    }

    // Fallback format: { "<key_id>": "<signature_hex>" }
    if let Some(flat) = signatures.as_object() {
        for (key_id, signature) in flat {
            if let Some(sig) = signature.as_str() {
                return Some((key_id.clone(), sig.to_string()));
            }
        }
    }

    None
}

async fn verify_envelope_origin_signature(
    state: &AppState,
    service: &FederationService,
    payload: &FederationEventEnvelope,
) -> Result<(), ApiError> {
    let (payload_key_id, signature_hex) =
        extract_signature_for_origin(&payload.signatures, &payload.origin_server)
            .ok_or(ApiError::Unauthorized)?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let payload_origin_trusted = paracord_db::federation::is_federated_server_trusted(
        &state.db,
        &payload.origin_server,
        now_ms,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !payload_origin_trusted {
        return Err(ApiError::Forbidden);
    }
    let keys = service
        .list_server_keys(&state.db, &payload.origin_server)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let trusted_key = keys
        .iter()
        .find(|k| k.key_id == payload_key_id && k.valid_until >= now_ms)
        .ok_or(ApiError::Forbidden)?;

    let payload_bytes = canonical_event_payload_bytes(payload);
    service
        .verify_payload(&payload_bytes, &signature_hex, &trusted_key.public_key)
        .map_err(|_| ApiError::Forbidden)?;
    Ok(())
}

async fn ingest_verified_payload(
    state: &AppState,
    service: &FederationService,
    mut payload: FederationEventEnvelope,
    transport_origin: Option<&str>,
) -> Result<bool, ApiError> {
    if payload.depth <= 0 {
        payload.depth = payload.origin_ts.max(1);
    }

    // Update last_seen_at for the envelope origin and immediate transport sender.
    let _ =
        paracord_db::federation::touch_federated_server(&state.db, &payload.origin_server).await;
    if let Some(origin) = transport_origin {
        if origin != payload.origin_server {
            let _ = paracord_db::federation::touch_federated_server(&state.db, origin).await;
        }
    }

    let inserted = service
        .persist_event(&state.db, &payload)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // Forward the event to the local event bus so connected gateway clients see it
    if inserted {
        match payload.event_type.as_str() {
            "m.message" => {
                dispatch_federated_message(state, &payload).await;
            }
            "m.message.edit" => {
                dispatch_federated_message_edit(state, &payload).await;
            }
            "m.message.delete" => {
                dispatch_federated_message_delete(state, &payload).await;
            }
            "m.reaction.add" => {
                dispatch_federated_reaction_add(state, &payload).await;
            }
            "m.reaction.remove" => {
                dispatch_federated_reaction_remove(state, &payload).await;
            }
            "m.member.join" => {
                dispatch_federated_member_join(state, &payload).await;
            }
            "m.member.leave" => {
                dispatch_federated_member_leave(state, &payload).await;
            }
            _ => {
                state.event_bus.dispatch(
                    &format!("FEDERATION_{}", payload.event_type.to_uppercase()),
                    json!({
                        "event_id": payload.event_id,
                        "origin_server": payload.origin_server,
                        "sender": payload.sender,
                        "content": payload.content,
                    }),
                    None,
                );
            }
        }

        // Relay newly accepted events to other trusted peers so non-full-mesh
        // topologies can still converge. Skip the immediate sender hop.
        let relay_state = state.clone();
        let relay_service = service.clone();
        let relay_payload = payload.clone();
        let skip_server = transport_origin.map(str::to_string);
        tokio::spawn(async move {
            relay_service
                .forward_envelope_to_peers_except(
                    &relay_state.db,
                    &relay_payload,
                    skip_server.as_deref(),
                )
                .await;
        });
    }

    Ok(inserted)
}

// ── Discovery & Key Exchange ────────────────────────────────────────────────

pub async fn well_known() -> Result<Json<Value>, ApiError> {
    let service = federation_service();
    Ok(Json(json!({
        "server_name": service.server_name(),
        "domain": service.domain(),
        "federation_endpoint": "/_paracord/federation/v1",
        "enabled": service.is_enabled(),
        "version": "federation-v1",
    })))
}

pub async fn get_keys(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Ok(Json(json!({
            "server_name": service.server_name(),
            "keys": [],
        })));
    }
    let mut keys = service
        .list_server_keys(&state.db, service.server_name())
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if keys.is_empty() {
        if let Some(public_key) = service.signing_public_key() {
            let key = FederationServerKey {
                server_name: service.server_name().to_string(),
                key_id: service.key_id().to_string(),
                public_key,
                valid_until: chrono::Utc::now().timestamp_millis() + 86_400_000,
            };
            service
                .upsert_server_key(&state.db, &key)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            keys.push(key);
        }
    }
    Ok(Json(json!({
        "server_name": service.server_name(),
        "keys": keys,
    })))
}

// ── Event Ingestion ─────────────────────────────────────────────────────────

pub async fn ingest_event(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<FederationEventEnvelope>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::Forbidden);
    }

    let transport_body = serde_json::to_vec(&payload).unwrap_or_default();
    let transport = verify_transport_request(
        &state,
        &service,
        &headers,
        "POST",
        "/_paracord/federation/v1/event",
        &transport_body,
        None,
        true,
    )
    .await?;

    // Per-peer rate limiting on event ingestion
    if let Some(limit) = state.config.federation_max_events_per_peer_per_minute {
        if limit > 0 {
            let now = chrono::Utc::now().timestamp();
            let minute = now / 60;
            let bucket_key = format!("fed:ingest:{}", transport.origin);
            let count = paracord_db::rate_limits::increment_window_counter(
                &state.db,
                &bucket_key,
                minute,
                60,
            )
            .await
            .unwrap_or(0);
            if count > limit as i64 {
                return Err(ApiError::RateLimited);
            }
        }
    }

    // Validate content size and depth
    validate_federation_content(&payload.content)?;

    verify_envelope_origin_signature(&state, &service, &payload).await?;
    let inserted =
        ingest_verified_payload(&state, &service, payload.clone(), Some(&transport.origin)).await?;

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "event_id": payload.event_id,
            "inserted": inserted,
        })),
    ))
}

/// Handle an inbound federated message event: store it as a local message and
/// dispatch a `MESSAGE_CREATE` gateway event so connected clients see it.
async fn dispatch_federated_message(state: &AppState, payload: &FederationEventEnvelope) {
    // Extract remote IDs and map them into local namespace.
    let mapping_namespace = mapping_namespace_from_room(&payload.room_id, &payload.origin_server);
    let remote_channel_id = content_i64(&payload.content, "channel_id");
    let remote_guild_id = content_i64(&payload.content, "guild_id")
        .or_else(|| parse_room_parts(&payload.room_id).map(|(id, _)| id));
    let mapped_local_guild_id = if let Some(remote_gid) = remote_guild_id {
        resolve_local_guild_id(state, &mapping_namespace, remote_gid).await
    } else {
        None
    };
    let body = payload.content.get("body").cloned().unwrap_or(Value::Null);
    let body_text = match &body {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    let federated_msg_id_str = payload
        .content
        .get("message_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let Some(remote_ch_id) = remote_channel_id else {
        tracing::warn!(
            "federation: m.message event {} missing channel_id, dispatching generic event",
            payload.event_id,
        );
        state.event_bus.dispatch(
            "FEDERATION_M.MESSAGE",
            json!({
                "event_id": payload.event_id,
                "origin_server": payload.origin_server,
                "sender": payload.sender,
                "content": payload.content,
            }),
            mapped_local_guild_id,
        );
        return;
    };

    // Resolve (or materialize) the target channel locally so federated events
    // don't require pre-cloned guild/channel IDs.
    let channel = if let Some(mapped_channel_id) =
        resolve_local_channel_id(state, &mapping_namespace, remote_ch_id).await
    {
        match paracord_db::channels::get_channel(&state.db, mapped_channel_id).await {
            Ok(Some(existing)) => existing,
            _ => {
                let Some(remote_gid) = remote_guild_id else {
                    tracing::warn!(
                        "federation: m.message event {} has no resolvable guild_id for unknown remote channel {remote_ch_id}",
                        payload.event_id,
                    );
                    state.event_bus.dispatch(
                        "FEDERATION_M.MESSAGE",
                        json!({
                            "event_id": payload.event_id,
                            "origin_server": payload.origin_server,
                            "sender": payload.sender,
                            "content": payload.content,
                        }),
                        mapped_local_guild_id,
                    );
                    return;
                };
                let Some(local_guild_id) =
                    ensure_federated_space_exists(state, payload, remote_gid).await
                else {
                    tracing::warn!(
                        "federation: m.message event {} could not materialize remote guild {}",
                        payload.event_id,
                        remote_gid,
                    );
                    return;
                };
                let Some(materialized) =
                    ensure_federated_channel_exists(state, payload, remote_ch_id, local_guild_id)
                        .await
                else {
                    tracing::warn!(
                        "federation: m.message event {} could not materialize remote channel {}",
                        payload.event_id,
                        remote_ch_id,
                    );
                    state.event_bus.dispatch(
                        "FEDERATION_M.MESSAGE",
                        json!({
                            "event_id": payload.event_id,
                            "origin_server": payload.origin_server,
                            "sender": payload.sender,
                            "content": payload.content,
                        }),
                        Some(local_guild_id),
                    );
                    return;
                };
                materialized
            }
        }
    } else {
        let Some(remote_gid) = remote_guild_id else {
            tracing::warn!(
                "federation: m.message event {} has no resolvable guild_id for unknown remote channel {remote_ch_id}",
                payload.event_id,
            );
            state.event_bus.dispatch(
                "FEDERATION_M.MESSAGE",
                json!({
                    "event_id": payload.event_id,
                    "origin_server": payload.origin_server,
                    "sender": payload.sender,
                    "content": payload.content,
                }),
                mapped_local_guild_id,
            );
            return;
        };
        let Some(local_guild_id) = ensure_federated_space_exists(state, payload, remote_gid).await
        else {
            tracing::warn!(
                "federation: m.message event {} could not materialize remote guild {}",
                payload.event_id,
                remote_gid,
            );
            return;
        };
        let Some(materialized) =
            ensure_federated_channel_exists(state, payload, remote_ch_id, local_guild_id).await
        else {
            tracing::warn!(
                "federation: m.message event {} could not materialize remote channel {}",
                payload.event_id,
                remote_ch_id,
            );
            state.event_bus.dispatch(
                "FEDERATION_M.MESSAGE",
                json!({
                    "event_id": payload.event_id,
                    "origin_server": payload.origin_server,
                    "sender": payload.sender,
                    "content": payload.content,
                }),
                Some(local_guild_id),
            );
            return;
        };
        materialized
    };
    let local_channel_id = channel.id;

    // Generate a local message ID for storage
    let local_msg_id = paracord_util::snowflake::generate(1);

    let author_id = match FederatedIdentity::parse(&payload.sender) {
        Some(identity) => match ensure_remote_user_mapping(state, &identity).await {
            Ok(uid) => uid,
            Err(e) => {
                tracing::warn!(
                    "federation: failed to map sender identity {} for event {}: {}",
                    payload.sender,
                    payload.event_id,
                    e
                );
                if !ensure_federated_system_user(state).await {
                    tracing::error!(
                        "federation: cannot store inbound message from event {} because no fallback system user exists",
                        payload.event_id,
                    );
                    return;
                }
                0
            }
        },
        None => {
            if !ensure_federated_system_user(state).await {
                tracing::error!(
                    "federation: cannot store inbound message from event {} because sender identity is invalid and fallback user is unavailable",
                    payload.event_id
                );
                return;
            }
            0
        }
    };

    // Store the federated message in the local messages table.
    // Author ID may be a mapped remote pseudo-user. Falls back to user 0.
    match paracord_db::messages::create_message(
        &state.db,
        local_msg_id,
        local_channel_id,
        author_id,
        &body_text,
        0,
        None,
    )
    .await
    {
        Ok(msg) => {
            let author_username = paracord_db::users::get_user_by_id(&state.db, author_id)
                .await
                .ok()
                .flatten()
                .map(|u| u.username)
                .unwrap_or_else(|| payload.sender.clone());

            // Build a MESSAGE_CREATE payload that includes federation metadata
            let msg_json = json!({
                "id": msg.id.to_string(),
                "channel_id": msg.channel_id.to_string(),
                "author": {
                    "id": author_id.to_string(),
                    "username": author_username,
                    "discriminator": 0,
                    "avatar_hash": null,
                    "public_key": null,
                    "flags": 0,
                    "bot": false,
                },
                "content": body_text,
                "pinned": false,
                "type": 0,
                "message_type": 0,
                "timestamp": msg.created_at.to_rfc3339(),
                "created_at": msg.created_at.to_rfc3339(),
                "edited_timestamp": null,
                "edited_at": null,
                "reference_id": null,
                "attachments": [],
                "reactions": [],
                "poll": null,
                "federation": {
                    "event_id": payload.event_id,
                    "origin_server": payload.origin_server,
                    "sender": payload.sender,
                    "remote_message_id": federated_msg_id_str,
                },
            });

            state
                .event_bus
                .dispatch("MESSAGE_CREATE", msg_json, channel.guild_id());

            let remote_mid = payload
                .content
                .get("message_id")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty());
            if let Err(e) = paracord_db::federation::map_federated_message(
                &state.db,
                &payload.event_id,
                &payload.origin_server,
                remote_mid,
                msg.id,
                local_channel_id,
            )
            .await
            {
                tracing::warn!(
                    "federation: failed to map federated message {} -> {}: {}",
                    payload.event_id,
                    msg.id,
                    e
                );
            }
        }
        Err(e) => {
            tracing::error!(
                "federation: failed to store inbound message from event {}: {e}",
                payload.event_id,
            );
            // Fall back to generic event dispatch
            state.event_bus.dispatch(
                "FEDERATION_M.MESSAGE",
                json!({
                        "event_id": payload.event_id,
                    "origin_server": payload.origin_server,
                    "sender": payload.sender,
                    "content": payload.content,
                }),
                channel.guild_id(),
            );
        }
    }
}

fn content_str<'a>(content: &'a Value, key: &str) -> Option<&'a str> {
    content
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

fn content_i64(content: &Value, key: &str) -> Option<i64> {
    content.get(key).and_then(|v| match v {
        Value::Number(num) => num.as_i64(),
        Value::String(raw) => raw.trim().parse::<i64>().ok(),
        _ => None,
    })
}

async fn resolve_local_guild_id(
    state: &AppState,
    namespace_server: &str,
    remote_guild_id: i64,
) -> Option<i64> {
    let remote_space_id = remote_guild_id.to_string();
    if let Ok(Some(mapping)) = paracord_db::federation::get_space_mapping_by_remote(
        &state.db,
        namespace_server,
        &remote_space_id,
    )
    .await
    {
        return Some(mapping.local_guild_id);
    }

    // Legacy backfill only for system-owned mirrored spaces.
    if let Ok(Some(existing)) = paracord_db::guilds::get_guild(&state.db, remote_guild_id).await {
        if existing.owner_id == 0 {
            let _ = paracord_db::federation::upsert_space_mapping(
                &state.db,
                namespace_server,
                &remote_space_id,
                remote_guild_id,
            )
            .await;
            return Some(remote_guild_id);
        }
    }

    None
}

async fn resolve_local_channel_id(
    state: &AppState,
    namespace_server: &str,
    remote_channel_id: i64,
) -> Option<i64> {
    let remote_channel = remote_channel_id.to_string();
    if let Ok(Some(mapping)) = paracord_db::federation::get_channel_mapping_by_remote(
        &state.db,
        namespace_server,
        &remote_channel,
    )
    .await
    {
        return Some(mapping.local_channel_id);
    }

    if let Ok(Some(existing)) =
        paracord_db::channels::get_channel(&state.db, remote_channel_id).await
    {
        let local_guild_id = existing.guild_id().unwrap_or_default();
        if local_guild_id > 0 {
            let system_owned_guild = paracord_db::guilds::get_guild(&state.db, local_guild_id)
                .await
                .ok()
                .flatten()
                .map(|guild| guild.owner_id == 0)
                .unwrap_or(false);
            if system_owned_guild {
                let _ = paracord_db::federation::upsert_channel_mapping(
                    &state.db,
                    namespace_server,
                    &remote_channel,
                    remote_channel_id,
                    local_guild_id,
                )
                .await;
                return Some(remote_channel_id);
            }
        }
    }

    None
}

async fn ensure_federated_space_exists(
    state: &AppState,
    payload: &FederationEventEnvelope,
    remote_guild_id: i64,
) -> Option<i64> {
    let remote_space_id = remote_guild_id.to_string();
    let mapping_namespace = mapping_namespace_from_room(&payload.room_id, &payload.origin_server);
    let local_guild_id = if let Some(mapped) =
        resolve_local_guild_id(state, &mapping_namespace, remote_guild_id).await
    {
        mapped
    } else {
        paracord_util::snowflake::generate(1)
    };

    if matches!(
        paracord_db::guilds::get_guild(&state.db, local_guild_id).await,
        Ok(Some(_))
    ) {
        let _ = paracord_db::federation::upsert_space_mapping(
            &state.db,
            &mapping_namespace,
            &remote_space_id,
            local_guild_id,
        )
        .await;
        return Some(local_guild_id);
    }

    if !ensure_federated_system_user(state).await {
        return None;
    }

    let guild_name = content_str(&payload.content, "guild_name")
        .map(str::to_string)
        .unwrap_or_else(|| format!("Federated {remote_guild_id} @ {}", payload.origin_server));

    if let Err(err) =
        paracord_db::guilds::create_guild(&state.db, local_guild_id, &guild_name, 0, None).await
    {
        if !matches!(
            paracord_db::guilds::get_guild(&state.db, local_guild_id).await,
            Ok(Some(_))
        ) {
            tracing::warn!(
                "federation: failed creating mirrored guild {} (remote {}:{}) from {}: {}",
                local_guild_id,
                payload.origin_server,
                remote_space_id,
                payload.origin_server,
                err,
            );
            return None;
        }
    }

    let _ = paracord_db::roles::create_role(
        &state.db,
        local_guild_id,
        local_guild_id,
        "@everyone",
        Permissions::default().bits(),
    )
    .await;
    let _ = paracord_db::members::add_member(&state.db, 0, local_guild_id).await;
    let _ = paracord_db::roles::add_member_role(&state.db, 0, local_guild_id, local_guild_id).await;

    if let Err(err) = paracord_db::federation::upsert_space_mapping(
        &state.db,
        &mapping_namespace,
        &remote_space_id,
        local_guild_id,
    )
    .await
    {
        tracing::warn!(
            "federation: failed creating space mapping {}:{} -> {}: {}",
            mapping_namespace,
            remote_space_id,
            local_guild_id,
            err
        );
        return None;
    }

    Some(local_guild_id)
}

async fn ensure_federated_channel_exists(
    state: &AppState,
    payload: &FederationEventEnvelope,
    remote_channel_id: i64,
    local_guild_id: i64,
) -> Option<paracord_db::channels::ChannelRow> {
    let remote_channel = remote_channel_id.to_string();
    let mapping_namespace = mapping_namespace_from_room(&payload.room_id, &payload.origin_server);
    let local_channel_id = if let Some(mapped) =
        resolve_local_channel_id(state, &mapping_namespace, remote_channel_id).await
    {
        mapped
    } else {
        paracord_util::snowflake::generate(1)
    };

    if let Ok(Some(existing)) =
        paracord_db::channels::get_channel(&state.db, local_channel_id).await
    {
        let _ = paracord_db::federation::upsert_channel_mapping(
            &state.db,
            &mapping_namespace,
            &remote_channel,
            local_channel_id,
            local_guild_id,
        )
        .await;
        return Some(existing);
    }

    let channel_name = content_str(&payload.content, "channel_name")
        .map(str::to_string)
        .unwrap_or_else(|| format!("federated-{remote_channel_id}"));
    let mut channel_type = content_i64(&payload.content, "channel_type")
        .and_then(|kind| i16::try_from(kind).ok())
        .unwrap_or(0);
    if channel_type < 0 {
        channel_type = 0;
    }

    if let Err(err) = paracord_db::channels::create_channel(
        &state.db,
        local_channel_id,
        local_guild_id,
        &channel_name,
        channel_type,
        0,
        None,
        None,
    )
    .await
    {
        if let Ok(Some(existing)) =
            paracord_db::channels::get_channel(&state.db, local_channel_id).await
        {
            return Some(existing);
        }
        tracing::warn!(
            "federation: failed creating mirrored channel {} (remote {}:{}) in guild {} from {}: {}",
            local_channel_id,
            payload.origin_server,
            remote_channel,
            local_guild_id,
            payload.origin_server,
            err,
        );
        return None;
    }

    if let Err(err) = paracord_db::federation::upsert_channel_mapping(
        &state.db,
        &mapping_namespace,
        &remote_channel,
        local_channel_id,
        local_guild_id,
    )
    .await
    {
        tracing::warn!(
            "federation: failed creating channel mapping {}:{} -> {}: {}",
            mapping_namespace,
            remote_channel,
            local_channel_id,
            err
        );
        return None;
    }

    paracord_db::channels::get_channel(&state.db, local_channel_id)
        .await
        .ok()
        .flatten()
}

async fn resolve_local_message_id_from_payload(
    state: &AppState,
    payload: &FederationEventEnvelope,
) -> Option<i64> {
    if let Some(remote_mid) = content_str(&payload.content, "message_id") {
        if let Ok(id) = paracord_db::federation::get_local_message_id_by_remote(
            &state.db,
            &payload.origin_server,
            remote_mid,
        )
        .await
        {
            if id.is_some() {
                return id;
            }
        }
    }
    if let Some(target_event_id) = content_str(&payload.content, "target_event_id") {
        if let Ok(id) =
            paracord_db::federation::get_local_message_id_by_event(&state.db, target_event_id).await
        {
            if id.is_some() {
                return id;
            }
        }
    }
    None
}

async fn dispatch_federated_message_edit(state: &AppState, payload: &FederationEventEnvelope) {
    let Some(local_message_id) = resolve_local_message_id_from_payload(state, payload).await else {
        tracing::warn!(
            "federation: m.message.edit {} did not resolve to a local message",
            payload.event_id
        );
        return;
    };

    let mapping_namespace = mapping_namespace_from_room(&payload.room_id, &payload.origin_server);
    let fallback_channel_id =
        match paracord_db::messages::get_message(&state.db, local_message_id).await {
            Ok(Some(msg)) => msg.channel_id,
            _ => return,
        };
    let channel_id = if let Some(remote_channel_id) = content_i64(&payload.content, "channel_id") {
        resolve_local_channel_id(state, &mapping_namespace, remote_channel_id)
            .await
            .unwrap_or(fallback_channel_id)
    } else {
        fallback_channel_id
    };
    let new_content = payload
        .content
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let updated = match paracord_db::messages::update_message(
        &state.db,
        local_message_id,
        &new_content,
    )
    .await
    {
        Ok(msg) => msg,
        Err(err) => {
            tracing::warn!(
                "federation: failed applying m.message.edit {}: {}",
                payload.event_id,
                err
            );
            return;
        }
    };

    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .ok()
        .flatten();
    let guild_id = channel.and_then(|c| c.guild_id());
    let msg_json = json!({
        "id": updated.id.to_string(),
        "channel_id": updated.channel_id.to_string(),
        "author": {
            "id": updated.author_id.to_string(),
        },
        "content": updated.content,
        "edited_timestamp": updated.edited_at.map(|v| v.to_rfc3339()),
        "edited_at": updated.edited_at.map(|v| v.to_rfc3339()),
        "federation": {
            "event_id": payload.event_id,
            "origin_server": payload.origin_server,
        }
    });
    state
        .event_bus
        .dispatch("MESSAGE_UPDATE", msg_json, guild_id);
}

async fn dispatch_federated_message_delete(state: &AppState, payload: &FederationEventEnvelope) {
    let Some(local_message_id) = resolve_local_message_id_from_payload(state, payload).await else {
        tracing::warn!(
            "federation: m.message.delete {} did not resolve to a local message",
            payload.event_id
        );
        return;
    };

    let channel_id = match paracord_db::messages::get_message(&state.db, local_message_id).await {
        Ok(Some(msg)) => msg.channel_id,
        _ => return,
    };
    let guild_id = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .ok()
        .flatten()
        .and_then(|c| c.guild_id());
    if let Err(err) = paracord_db::messages::delete_message(&state.db, local_message_id).await {
        tracing::warn!(
            "federation: failed applying m.message.delete {}: {}",
            payload.event_id,
            err
        );
        return;
    }

    state.event_bus.dispatch(
        "MESSAGE_DELETE",
        json!({
            "id": local_message_id.to_string(),
            "channel_id": channel_id.to_string(),
            "federation": {
                "event_id": payload.event_id,
                "origin_server": payload.origin_server,
            }
        }),
        guild_id,
    );
}

async fn dispatch_federated_reaction_add(state: &AppState, payload: &FederationEventEnvelope) {
    let Some(local_message_id) = resolve_local_message_id_from_payload(state, payload).await else {
        return;
    };
    let Some(identity) = FederatedIdentity::parse(&payload.sender) else {
        return;
    };
    let Ok(local_user_id) = ensure_remote_user_mapping(state, &identity).await else {
        return;
    };
    let emoji = content_str(&payload.content, "emoji").unwrap_or("");
    if emoji.is_empty() {
        return;
    }
    if paracord_db::reactions::add_reaction(&state.db, local_message_id, local_user_id, emoji, None)
        .await
        .is_err()
    {
        return;
    }
    let channel_id = match paracord_db::messages::get_message(&state.db, local_message_id).await {
        Ok(Some(msg)) => msg.channel_id,
        _ => return,
    };
    let guild_id = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .ok()
        .flatten()
        .and_then(|c| c.guild_id());
    state.event_bus.dispatch(
        "MESSAGE_REACTION_ADD",
        json!({
            "user_id": local_user_id.to_string(),
            "channel_id": channel_id.to_string(),
            "message_id": local_message_id.to_string(),
            "emoji": emoji,
        }),
        guild_id,
    );
}

async fn dispatch_federated_reaction_remove(state: &AppState, payload: &FederationEventEnvelope) {
    let Some(local_message_id) = resolve_local_message_id_from_payload(state, payload).await else {
        return;
    };
    let Some(identity) = FederatedIdentity::parse(&payload.sender) else {
        return;
    };
    let Ok(local_user_id) = ensure_remote_user_mapping(state, &identity).await else {
        return;
    };
    let emoji = content_str(&payload.content, "emoji").unwrap_or("");
    if emoji.is_empty() {
        return;
    }
    if paracord_db::reactions::remove_reaction(&state.db, local_message_id, local_user_id, emoji)
        .await
        .is_err()
    {
        return;
    }
    let channel_id = match paracord_db::messages::get_message(&state.db, local_message_id).await {
        Ok(Some(msg)) => msg.channel_id,
        _ => return,
    };
    let guild_id = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .ok()
        .flatten()
        .and_then(|c| c.guild_id());
    state.event_bus.dispatch(
        "MESSAGE_REACTION_REMOVE",
        json!({
            "user_id": local_user_id.to_string(),
            "channel_id": channel_id.to_string(),
            "message_id": local_message_id.to_string(),
            "emoji": emoji,
        }),
        guild_id,
    );
}

async fn dispatch_federated_member_join(state: &AppState, payload: &FederationEventEnvelope) {
    let service = federation_service_from_state(state);
    if !service.is_enabled() {
        return;
    }
    let Some(identity) = FederatedIdentity::parse(&payload.sender) else {
        return;
    };
    if !identity.server.eq_ignore_ascii_case(&payload.origin_server) {
        return;
    }
    let Some(remote_guild_id) = content_i64(&payload.content, "guild_id")
        .or_else(|| parse_room_parts(&payload.room_id).map(|(id, _)| id))
    else {
        return;
    };
    let Some(guild_id) = ensure_federated_space_exists(state, payload, remote_guild_id).await
    else {
        return;
    };
    if ensure_federation_guild_allowed(guild_id).is_err() {
        return;
    };
    let Ok(Some(guild)) = paracord_db::guilds::get_guild(&state.db, guild_id).await else {
        return;
    };
    let Ok(local_user_id) = ensure_remote_user_mapping(state, &identity).await else {
        return;
    };
    let room_id = if payload.room_id.trim().is_empty() {
        canonical_local_room_id(&service, guild_id)
    } else {
        payload.room_id.clone()
    };
    let _ = paracord_db::members::add_member(&state.db, local_user_id, guild_id).await;
    let _ = paracord_db::roles::add_member_role(&state.db, local_user_id, guild_id, guild_id).await;
    let _ = paracord_db::federation::upsert_room_membership(
        &state.db,
        &room_id,
        &identity.to_canonical(),
        local_user_id,
        guild_id,
    )
    .await;
    state.member_index.add_member(guild_id, local_user_id);
    state.event_bus.dispatch(
        "GUILD_MEMBER_ADD",
        json!({
            "guild_id": guild_id.to_string(),
            "user": {
                "id": local_user_id.to_string(),
                "username": identity.localpart,
                "discriminator": 0,
                "avatar_hash": null,
                "flags": 0,
                "bot": false,
                "system": false,
            },
            "nick": null,
            "roles": [guild_id.to_string()],
            "joined_at": chrono::Utc::now().to_rfc3339(),
            "deaf": false,
            "mute": false,
        }),
        Some(guild.id),
    );
}

async fn dispatch_federated_member_leave(state: &AppState, payload: &FederationEventEnvelope) {
    let service = federation_service_from_state(state);
    if !service.is_enabled() {
        return;
    }
    let Some(identity) = FederatedIdentity::parse(&payload.sender) else {
        return;
    };
    if !identity.server.eq_ignore_ascii_case(&payload.origin_server) {
        return;
    }
    let mapping_namespace = mapping_namespace_from_room(&payload.room_id, &payload.origin_server);
    let Some(remote_guild_id) = content_i64(&payload.content, "guild_id")
        .or_else(|| parse_room_parts(&payload.room_id).map(|(id, _)| id))
    else {
        return;
    };
    let Some(guild_id) = resolve_local_guild_id(state, &mapping_namespace, remote_guild_id).await
    else {
        return;
    };
    if ensure_federation_guild_allowed(guild_id).is_err() {
        return;
    };
    let Ok(Some(mapping)) =
        paracord_db::federation::get_remote_user_mapping(&state.db, &identity.to_canonical()).await
    else {
        return;
    };
    let room_id = if payload.room_id.trim().is_empty() {
        canonical_local_room_id(&service, guild_id)
    } else {
        payload.room_id.clone()
    };
    let _ = paracord_db::members::remove_member(&state.db, mapping.local_user_id, guild_id).await;
    let _ = paracord_db::federation::delete_room_membership(
        &state.db,
        &room_id,
        &identity.to_canonical(),
    )
    .await;
    state.member_index.remove_member(guild_id, mapping.local_user_id);
    state.event_bus.dispatch(
        "GUILD_MEMBER_REMOVE",
        json!({
            "guild_id": guild_id.to_string(),
            "user_id": mapping.local_user_id.to_string(),
        }),
        Some(guild_id),
    );
}

async fn ensure_federated_system_user(state: &AppState) -> bool {
    match paracord_db::users::get_user_by_id(&state.db, 0).await {
        Ok(Some(_)) => return true,
        Ok(None) => {}
        Err(e) => {
            tracing::warn!("federation: failed checking system user existence: {}", e);
            return false;
        }
    }

    match paracord_db::users::create_user(
        &state.db,
        0,
        "federated",
        0,
        "federated@local.invalid",
        "!federated!",
    )
    .await
    {
        Ok(_) => true,
        Err(e) => {
            tracing::warn!("federation: failed creating system user: {}", e);
            matches!(
                paracord_db::users::get_user_by_id(&state.db, 0).await,
                Ok(Some(_))
            )
        }
    }
}

pub async fn get_event(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(event_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::Forbidden);
    }
    authorize_federation_read_request(&state, &service, &headers, uri.path()).await?;
    let event = service
        .fetch_event(&state.db, &event_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    match event {
        Some(envelope) => Ok(Json(json!(envelope))),
        None => Err(ApiError::NotFound),
    }
}

#[derive(Debug, Deserialize)]
pub struct ListEventsQuery {
    pub room_id: String,
    pub since_depth: Option<i64>,
    pub limit: Option<i64>,
}

pub async fn list_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Query(query): Query<ListEventsQuery>,
) -> Result<Json<Value>, ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::Forbidden);
    }
    let path_and_query = uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| uri.path().to_string());
    authorize_federation_read_request(&state, &service, &headers, &path_and_query).await?;

    let since_depth = query.since_depth.unwrap_or(0).max(0);
    let limit = query.limit.unwrap_or(100).clamp(1, 1000);
    let events = service
        .list_room_events(&state.db, &query.room_id, since_depth, limit)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!({ "events": events })))
}

pub async fn run_federation_catchup_once(
    state: &AppState,
    per_room_limit: i64,
    max_rooms_per_peer: usize,
) {
    let service = federation_service_from_state(state);
    if !service.is_enabled() {
        return;
    }
    let Some(client) = build_signed_federation_client(&service) else {
        tracing::warn!("federation: catch-up disabled because signed client is unavailable");
        return;
    };

    let peers = match paracord_db::federation::list_trusted_federated_servers(&state.db).await {
        Ok(peers) => peers,
        Err(err) => {
            tracing::warn!("federation: catch-up failed loading trusted peers: {}", err);
            return;
        }
    };

    for peer in peers {
        if peer.server_name.eq_ignore_ascii_case(service.server_name()) {
            continue;
        }
        let mut mappings = match paracord_db::federation::list_space_mappings_by_origin(
            &state.db,
            &peer.server_name,
        )
        .await
        {
            Ok(rows) => rows,
            Err(err) => {
                tracing::warn!(
                    "federation: catch-up failed loading room mappings for {}: {}",
                    peer.server_name,
                    err
                );
                continue;
            }
        };
        if !peer.domain.eq_ignore_ascii_case(&peer.server_name) {
            match paracord_db::federation::list_space_mappings_by_origin(&state.db, &peer.domain)
                .await
            {
                Ok(rows) => mappings.extend(rows),
                Err(err) => {
                    tracing::debug!(
                        "federation: catch-up could not load domain mappings for {}: {}",
                        peer.domain,
                        err
                    );
                }
            }
        }
        mappings.sort_by(|a, b| a.remote_space_id.cmp(&b.remote_space_id));
        mappings.dedup_by(|a, b| {
            a.remote_space_id == b.remote_space_id && a.local_guild_id == b.local_guild_id
        });
        if mappings.is_empty() {
            continue;
        }

        for mapping in mappings.into_iter().take(max_rooms_per_peer) {
            let mut candidate_domains = vec![peer.domain.clone()];
            if !peer.server_name.eq_ignore_ascii_case(&peer.domain) {
                candidate_domains.push(peer.server_name.clone());
            }

            for domain in candidate_domains {
                let room_id = remote_room_id(&mapping.remote_space_id, &domain);
                let since_depth = match paracord_db::federation::get_room_sync_cursor(
                    &state.db,
                    &peer.server_name,
                    &room_id,
                )
                .await
                {
                    Ok(depth) => depth.max(0),
                    Err(err) => {
                        tracing::warn!(
                            "federation: catch-up failed loading cursor for {} {}: {}",
                            peer.server_name,
                            room_id,
                            err
                        );
                        continue;
                    }
                };

                let events = match client
                    .fetch_messages(
                        &peer.federation_endpoint,
                        &room_id,
                        since_depth,
                        per_room_limit.clamp(1, 500),
                    )
                    .await
                {
                    Ok(events) => events,
                    Err(err) => {
                        tracing::debug!(
                            "federation: catch-up fetch failed for {} {}: {}",
                            peer.server_name,
                            room_id,
                            err
                        );
                        continue;
                    }
                };

                if events.is_empty() {
                    continue;
                }

                let mut newest_depth = since_depth;
                for event in events {
                    if verify_envelope_origin_signature(state, &service, &event)
                        .await
                        .is_err()
                    {
                        tracing::warn!(
                            "federation: catch-up rejected invalid event {} for peer {}",
                            event.event_id,
                            peer.server_name
                        );
                        continue;
                    }
                    match ingest_verified_payload(
                        state,
                        &service,
                        event.clone(),
                        Some(&peer.server_name),
                    )
                    .await
                    {
                        Ok(_) => {
                            newest_depth =
                                newest_depth.max(event.depth.max(event.origin_ts.max(1)));
                        }
                        Err(err) => {
                            tracing::warn!(
                                "federation: catch-up ingest failed for {} event {}: {}",
                                peer.server_name,
                                event.event_id,
                                err
                            );
                        }
                    }
                }

                if newest_depth > since_depth {
                    let _ = paracord_db::federation::upsert_room_sync_cursor(
                        &state.db,
                        &peer.server_name,
                        &room_id,
                        newest_depth,
                        chrono::Utc::now().timestamp_millis(),
                    )
                    .await;
                }
            }
        }
    }
}

async fn authorize_federation_read_request(
    state: &AppState,
    service: &FederationService,
    headers: &HeaderMap,
    path: &str,
) -> Result<(), ApiError> {
    if let Some(expected) = optional_federation_read_token() {
        let presented = headers
            .get("x-paracord-federation-token")
            .and_then(|v| v.to_str().ok())
            .map(str::trim);
        if presented == Some(expected.as_str()) {
            return Ok(());
        }
    }

    verify_transport_request(state, service, headers, "GET", path, &[], None, false)
        .await
        .map(|_| ())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FederationInviteRequest {
    pub origin_server: String,
    pub room_id: String,
    pub sender: String,
    pub max_age_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FederationJoinRequest {
    pub origin_server: String,
    pub room_id: String,
    pub user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FederationLeaveRequest {
    pub origin_server: String,
    pub room_id: String,
    pub user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FederationMediaTokenRequest {
    pub origin_server: String,
    pub channel_id: String,
    pub user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FederationMediaRelayRequest {
    pub origin_server: String,
    pub channel_id: String,
    pub user_id: String,
    pub action: String,
    pub title: Option<String>,
}

pub async fn invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<FederationInviteRequest>,
) -> Result<Json<Value>, ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::Forbidden);
    }

    let body_bytes = serde_json::to_vec(&body).unwrap_or_default();
    verify_transport_request(
        &state,
        &service,
        &headers,
        "POST",
        "/_paracord/federation/v1/invite",
        &body_bytes,
        Some(body.origin_server.as_str()),
        true,
    )
    .await?;

    let guild_id = parse_local_room_guild_id(&service, &body.room_id)
        .ok_or(ApiError::BadRequest("Invalid room_id format".to_string()))?;
    ensure_federation_guild_allowed(guild_id)?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let channels = paracord_db::channels::get_guild_channels(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let default_channel_id = channels
        .iter()
        .find(|ch| ch.channel_type == 0)
        .or_else(|| channels.first())
        .map(|ch| ch.id);
    let canonical_room_id = canonical_local_room_id(&service, guild_id);

    Ok(Json(json!({
        "accepted": true,
        "room_id": canonical_room_id,
        "guild_id": guild.id.to_string(),
        "guild_name": guild.name,
        "default_channel_id": default_channel_id.map(|id| id.to_string()),
        "join_endpoint": "/_paracord/federation/v1/join",
        "expires_in_seconds": body.max_age_seconds.unwrap_or(3600).clamp(60, 86_400),
    })))
}

pub async fn join(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<FederationJoinRequest>,
) -> Result<Json<Value>, ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::Forbidden);
    }
    let body_bytes = serde_json::to_vec(&body).unwrap_or_default();
    verify_transport_request(
        &state,
        &service,
        &headers,
        "POST",
        "/_paracord/federation/v1/join",
        &body_bytes,
        Some(body.origin_server.as_str()),
        true,
    )
    .await?;

    let identity = FederatedIdentity::parse(&body.user_id)
        .ok_or(ApiError::BadRequest("Invalid user_id".to_string()))?;
    ensure_identity_matches_origin_or_alias(&state, &identity, &body.origin_server).await?;
    let guild_id = parse_local_room_guild_id(&service, &body.room_id)
        .ok_or(ApiError::BadRequest("Invalid room_id format".to_string()))?;
    ensure_federation_guild_allowed(guild_id)?;
    let _guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let canonical_room_id = canonical_local_room_id(&service, guild_id);

    let local_user_id = ensure_remote_user_mapping(&state, &identity).await?;
    paracord_db::members::add_member(&state.db, local_user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let _ = paracord_db::roles::add_member_role(&state.db, local_user_id, guild_id, guild_id).await;
    paracord_db::federation::upsert_room_membership(
        &state.db,
        &canonical_room_id,
        &identity.to_canonical(),
        local_user_id,
        guild_id,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    state.member_index.add_member(guild_id, local_user_id);
    state.event_bus.dispatch(
        "GUILD_MEMBER_ADD",
        json!({
            "guild_id": guild_id.to_string(),
            "user": {
                "id": local_user_id.to_string(),
                "username": identity.localpart,
                "discriminator": 0,
                "avatar_hash": null,
                "flags": 0,
                "bot": false,
                "system": false,
            },
            "nick": null,
            "roles": [guild_id.to_string()],
            "joined_at": chrono::Utc::now().to_rfc3339(),
            "deaf": false,
            "mute": false,
        }),
        Some(guild_id),
    );

    Ok(Json(json!({
        "joined": true,
        "room_id": canonical_room_id,
        "guild_id": guild_id.to_string(),
        "local_user_id": local_user_id.to_string(),
    })))
}

pub async fn leave(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<FederationLeaveRequest>,
) -> Result<Json<Value>, ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::Forbidden);
    }
    let body_bytes = serde_json::to_vec(&body).unwrap_or_default();
    verify_transport_request(
        &state,
        &service,
        &headers,
        "POST",
        "/_paracord/federation/v1/leave",
        &body_bytes,
        Some(body.origin_server.as_str()),
        true,
    )
    .await?;

    let identity = FederatedIdentity::parse(&body.user_id)
        .ok_or(ApiError::BadRequest("Invalid user_id".to_string()))?;
    ensure_identity_matches_origin_or_alias(&state, &identity, &body.origin_server).await?;
    let guild_id = parse_local_room_guild_id(&service, &body.room_id)
        .ok_or(ApiError::BadRequest("Invalid room_id format".to_string()))?;
    ensure_federation_guild_allowed(guild_id)?;
    let canonical_room_id = canonical_local_room_id(&service, guild_id);
    let mapping =
        paracord_db::federation::get_remote_user_mapping(&state.db, &identity.to_canonical())
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let mut removed = false;
    if let Some(mapping) = mapping {
        paracord_db::members::remove_member(&state.db, mapping.local_user_id, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        removed = true;
        state.member_index.remove_member(guild_id, mapping.local_user_id);
        state.event_bus.dispatch(
            "GUILD_MEMBER_REMOVE",
            json!({
                "guild_id": guild_id.to_string(),
                "user_id": mapping.local_user_id.to_string(),
            }),
            Some(guild_id),
        );
    }
    let _ = paracord_db::federation::delete_room_membership(
        &state.db,
        &canonical_room_id,
        &identity.to_canonical(),
    )
    .await;

    Ok(Json(json!({
        "left": removed,
        "room_id": canonical_room_id,
        "guild_id": guild_id.to_string(),
    })))
}

pub async fn media_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<FederationMediaTokenRequest>,
) -> Result<Json<Value>, ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::Forbidden);
    }
    let body_bytes = serde_json::to_vec(&body).unwrap_or_default();
    verify_transport_request(
        &state,
        &service,
        &headers,
        "POST",
        "/_paracord/federation/v1/media/token",
        &body_bytes,
        Some(body.origin_server.as_str()),
        true,
    )
    .await?;

    let identity = FederatedIdentity::parse(&body.user_id)
        .ok_or(ApiError::BadRequest("Invalid user_id".to_string()))?;
    ensure_identity_matches_origin_or_alias(&state, &identity, &body.origin_server).await?;
    let local_user_id = ensure_remote_user_mapping(&state, &identity).await?;

    let channel_id = body
        .channel_id
        .parse::<i64>()
        .map_err(|_| ApiError::BadRequest("Invalid channel_id".to_string()))?;
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if channel.channel_type != 2 {
        return Err(ApiError::BadRequest("Not a voice channel".to_string()));
    }
    let guild_id = channel.guild_id().ok_or(ApiError::BadRequest(
        "Voice token requires guild channel".to_string(),
    ))?;
    ensure_federation_guild_allowed(guild_id)?;
    let room_id = canonical_local_room_id(&service, guild_id);
    let has_membership = paracord_db::federation::has_room_membership(
        &state.db,
        &room_id,
        &identity.to_canonical(),
        guild_id,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !has_membership {
        return Err(ApiError::Forbidden);
    }
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, local_user_id)
        .await
        .map_err(ApiError::from)?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let perms = paracord_core::permissions::compute_channel_permissions(
        &state.db,
        guild_id,
        channel_id,
        guild.owner_id,
        local_user_id,
    )
    .await?;
    paracord_core::permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;
    paracord_core::permissions::require_permission(perms, Permissions::CONNECT)?;
    let user = paracord_db::users::get_user_by_id(&state.db, local_user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let session_id = uuid::Uuid::new_v4().to_string();
    let join_resp = state
        .voice
        .join_channel(
            channel_id,
            guild_id,
            local_user_id,
            &user.username,
            &session_id,
            true,
            paracord_media::AudioBitrate::default(),
        )
        .await
        .map_err(ApiError::Internal)?;

    Ok(Json(json!({
        "token": join_resp.token,
        "url": state.config.livekit_public_url,
        "room_name": join_resp.room_name,
        "session_id": session_id,
        "local_user_id": local_user_id.to_string(),
    })))
}

pub async fn media_relay(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<FederationMediaRelayRequest>,
) -> Result<Json<Value>, ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::Forbidden);
    }
    let body_bytes = serde_json::to_vec(&body).unwrap_or_default();
    verify_transport_request(
        &state,
        &service,
        &headers,
        "POST",
        "/_paracord/federation/v1/media/relay",
        &body_bytes,
        Some(body.origin_server.as_str()),
        true,
    )
    .await?;

    let identity = FederatedIdentity::parse(&body.user_id)
        .ok_or(ApiError::BadRequest("Invalid user_id".to_string()))?;
    ensure_identity_matches_origin_or_alias(&state, &identity, &body.origin_server).await?;
    let local_user_id = ensure_remote_user_mapping(&state, &identity).await?;
    let channel_id = body
        .channel_id
        .parse::<i64>()
        .map_err(|_| ApiError::BadRequest("Invalid channel_id".to_string()))?;
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if channel.channel_type != 2 {
        return Err(ApiError::BadRequest("Not a voice channel".to_string()));
    }
    let guild_id = channel.guild_id().ok_or(ApiError::BadRequest(
        "Streaming requires guild voice channel".to_string(),
    ))?;
    ensure_federation_guild_allowed(guild_id)?;
    let room_id = canonical_local_room_id(&service, guild_id);
    let has_membership = paracord_db::federation::has_room_membership(
        &state.db,
        &room_id,
        &identity.to_canonical(),
        guild_id,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !has_membership {
        return Err(ApiError::Forbidden);
    }
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, local_user_id)
        .await
        .map_err(ApiError::from)?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let perms = paracord_core::permissions::compute_channel_permissions(
        &state.db,
        guild_id,
        channel_id,
        guild.owner_id,
        local_user_id,
    )
    .await?;
    paracord_core::permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;
    paracord_core::permissions::require_permission(perms, Permissions::CONNECT)?;
    paracord_core::permissions::require_permission(perms, Permissions::STREAM)?;

    match body.action.as_str() {
        "start_stream" => {
            let user = paracord_db::users::get_user_by_id(&state.db, local_user_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                .ok_or(ApiError::NotFound)?;
            let stream = state
                .voice
                .start_stream(
                    channel_id,
                    guild_id,
                    local_user_id,
                    &user.username,
                    body.title.as_deref(),
                )
                .await
                .map_err(ApiError::Internal)?;
            Ok(Json(json!({
                "ok": true,
                "action": "start_stream",
                "token": stream.token,
                "room_name": stream.room_name,
                "url": state.config.livekit_public_url,
            })))
        }
        "stop_stream" => {
            state.voice.stop_stream(channel_id, local_user_id).await;
            Ok(Json(json!({
                "ok": true,
                "action": "stop_stream",
            })))
        }
        _ => Err(ApiError::BadRequest(
            "Unsupported media relay action".to_string(),
        )),
    }
}

// ── Federated Server Management (admin-only) ────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct AddServerRequest {
    pub server_name: String,
    pub domain: String,
    pub federation_endpoint: String,
    pub public_key_hex: Option<String>,
    pub key_id: Option<String>,
    #[serde(default)]
    pub trusted: bool,
    #[serde(default)]
    pub discover: bool,
}

pub async fn list_servers(
    _admin: AdminUser,
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::BadRequest("federation is disabled".to_string()));
    }

    let servers = paracord_db::federation::list_federated_servers(&state.db)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!({ "servers": servers })))
}

pub async fn add_server(
    _admin: AdminUser,
    State(state): State<AppState>,
    Json(body): Json<AddServerRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::BadRequest("federation is disabled".to_string()));
    }

    if body.server_name.is_empty() || body.domain.is_empty() || body.federation_endpoint.is_empty()
    {
        return Err(ApiError::BadRequest(
            "server_name, domain, and federation_endpoint are required".to_string(),
        ));
    }

    let mut public_key = body.public_key_hex.clone();
    let mut key_id = body.key_id.clone();

    // If discover is set, try to fetch keys from the remote server
    if body.discover {
        let client = paracord_federation::client::FederationClient::new()
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        match client.fetch_server_keys(&body.federation_endpoint).await {
            Ok(keys_resp) => {
                if let Some(first_key) = keys_resp.keys.first() {
                    public_key = Some(first_key.public_key.clone());
                    key_id = Some(first_key.key_id.clone());
                    // Also store it in the server_keys table for signature verification
                    let _ = service.upsert_server_key(&state.db, first_key).await;
                }
            }
            Err(e) => {
                tracing::warn!(
                    "Failed to discover keys from {}: {}",
                    body.federation_endpoint,
                    e
                );
            }
        }
    }

    let id = paracord_util::snowflake::generate(1);
    paracord_db::federation::upsert_federated_server(
        &state.db,
        id,
        &body.server_name,
        &body.domain,
        &body.federation_endpoint,
        public_key.as_deref(),
        key_id.as_deref(),
        body.trusted,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": id,
            "server_name": body.server_name,
            "domain": body.domain,
            "trusted": body.trusted,
        })),
    ))
}

pub async fn get_server(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(server_name): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::BadRequest("federation is disabled".to_string()));
    }

    let server = paracord_db::federation::get_federated_server(&state.db, &server_name)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    match server {
        Some(s) => Ok(Json(json!(s))),
        None => Err(ApiError::NotFound),
    }
}

pub async fn delete_server(
    _admin: AdminUser,
    State(state): State<AppState>,
    Path(server_name): Path<String>,
) -> Result<StatusCode, ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::BadRequest("federation is disabled".to_string()));
    }

    let deleted = paracord_db::federation::delete_federated_server(&state.db, &server_name)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn test_service(domain: &str, server_name: &str) -> FederationService {
        FederationService::new(FederationConfig {
            enabled: true,
            server_name: server_name.to_string(),
            domain: domain.to_string(),
            key_id: "ed25519:test".to_string(),
            signing_key: None,
            allow_discovery: false,
        })
    }

    #[test]
    fn parses_only_local_room_ids() {
        let service = test_service("chat.example.com", "server.example.com");
        assert_eq!(
            parse_local_room_guild_id(&service, "!42:chat.example.com"),
            Some(42)
        );
        assert_eq!(
            parse_local_room_guild_id(&service, "!42:server.example.com"),
            Some(42)
        );
        assert_eq!(
            parse_local_room_guild_id(&service, "!42:evil.example"),
            None
        );
    }

    #[test]
    fn identity_must_match_request_origin() {
        let identity = FederatedIdentity::parse("@alice:remote.example").expect("identity");
        assert!(ensure_identity_matches_origin(&identity, "remote.example").is_ok());
        assert!(ensure_identity_matches_origin(&identity, "other.example").is_err());
    }

    #[test]
    fn federation_guild_allowlist_defaults_to_deny() {
        let _guard = env_lock().lock().expect("env lock");
        std::env::remove_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS");
        assert!(ensure_federation_guild_allowed(123).is_err());
    }

    #[test]
    fn federation_guild_allowlist_accepts_configured_ids() {
        let _guard = env_lock().lock().expect("env lock");
        std::env::set_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS", "10,20,30");
        assert!(ensure_federation_guild_allowed(20).is_ok());
        assert!(ensure_federation_guild_allowed(99).is_err());
        std::env::remove_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS");
    }

    #[test]
    fn federation_content_rejects_oversized_collection() {
        let oversized = Value::Array(
            (0..(MAX_COLLECTION_LENGTH + 1))
                .map(|idx| Value::Number(idx.into()))
                .collect(),
        );
        assert!(validate_federation_content(&oversized).is_err());
    }

    #[test]
    fn federation_content_accepts_reasonable_collection() {
        let ok = Value::Array(
            (0..5_000)
                .map(|idx| Value::Number(idx.into()))
                .collect(),
        );
        assert!(validate_federation_content(&ok).is_ok());
    }
}
