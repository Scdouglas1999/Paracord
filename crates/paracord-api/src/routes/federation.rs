use axum::{
    body::Bytes,
    extract::{ConnectInfo, Path, Query, State},
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
use std::net::SocketAddr;
use std::time::Duration;

use crate::error::ApiError;
use crate::middleware::AdminUser;
use crate::routes::security;

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

/// Upper bound on how long a key discovered over plain HTTPS is honored. The
/// remote asserts its own `valid_until` and that value is the only expiry gate
/// on the signature-verification path, so it is clamped here (30 days) and the
/// operator must re-discover to extend it.
const MAX_DISCOVERED_KEY_VALIDITY_MS: i64 = 30 * 86_400_000;

/// Maximum serialized content size for inbound federation events (1 MB).
const MAX_CONTENT_SIZE_BYTES: usize = 1_048_576;
/// Maximum JSON nesting depth for inbound federation event content.
const MAX_CONTENT_DEPTH: usize = 32;
/// Maximum number of elements/keys allowed in a single JSON collection.
const MAX_COLLECTION_LENGTH: usize = 10_000;

/// Every identifier column on `federation_events` — and on the outbound queue,
/// message map and membership rows derived from it — is `VARCHAR(255)`.
const MAX_FEDERATION_IDENTIFIER_LEN: usize = 255;

/// Bound the envelope's identifier fields before anything derived from them is
/// written.
///
/// `validate_federation_content` bounds only `content`; the identifiers were
/// never checked at all, and they come straight off a remote peer's request
/// body. A peer sending a 10 KB `event_id` produced a clean insert on SQLite
/// and a PostgreSQL `22001` surfaced as a 500. Applied inside
/// `ingest_verified_payload` so both entry points are covered — the signed
/// `POST /event` handler and the catch-up puller, which never called
/// `validate_federation_content` at all.
fn validate_envelope_identifier_lengths(
    envelope: &FederationEventEnvelope,
) -> Result<(), ApiError> {
    for (field, value) in [
        ("event_id", envelope.event_id.as_str()),
        ("room_id", envelope.room_id.as_str()),
        ("event_type", envelope.event_type.as_str()),
        ("sender", envelope.sender.as_str()),
        ("origin_server", envelope.origin_server.as_str()),
        ("state_key", envelope.state_key.as_deref().unwrap_or("")),
    ] {
        if value.chars().count() > MAX_FEDERATION_IDENTIFIER_LEN {
            return Err(ApiError::BadRequest(format!(
                "federation event {field} exceeds maximum length of {MAX_FEDERATION_IDENTIFIER_LEN} characters"
            )));
        }
    }
    Ok(())
}

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

/// Resolve a peer-presented server identifier to the exact `server_name` under
/// which that peer is registered in `federated_servers`.
///
/// `paracord_db::federation::is_federated_server_trusted` matches
/// `federated_servers.server_name` *exactly* and joins
/// `federation_peer_trust_state` on that same exact string, while the rest of
/// this module compares peer identities with `eq_ignore_ascii_case` and also
/// accepts a peer's `domain` as an alias. That mismatch is how a peer
/// registered as `Peer.Example` and then blocked as `peer.example` kept
/// ingesting: the trust row never joined. Every trust *lookup* and every trust
/// *write* now funnels through this function so both sides of that exact-match
/// join agree on one canonical key.
///
/// Returns `None` when no registered peer matches; callers then keep the
/// candidate unchanged so the trust lookup still fails closed.
async fn resolve_registered_peer_name(
    state: &AppState,
    candidate: &str,
) -> Result<Option<String>, ApiError> {
    let candidate = candidate.trim();
    if candidate.is_empty() {
        return Ok(None);
    }
    let peers = paracord_db::federation::list_federated_servers(&state.db)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    // Exact server_name first, then a case-insensitive server_name, then the
    // `domain` alias — the same precedence the alias-resolving helpers use.
    if let Some(peer) = peers.iter().find(|peer| peer.server_name == candidate) {
        return Ok(Some(peer.server_name.clone()));
    }
    if let Some(peer) = peers
        .iter()
        .find(|peer| peer.server_name.eq_ignore_ascii_case(candidate))
    {
        return Ok(Some(peer.server_name.clone()));
    }
    Ok(peers
        .iter()
        .find(|peer| peer.domain.eq_ignore_ascii_case(candidate))
        .map(|peer| peer.server_name.clone()))
}

/// Canonical registered name for a presented peer identifier, falling back to
/// the trimmed input when no peer is registered under it (so downstream exact
/// matches still fail closed).
async fn canonical_peer_name(state: &AppState, candidate: &str) -> Result<String, ApiError> {
    Ok(resolve_registered_peer_name(state, candidate)
        .await?
        .unwrap_or_else(|| candidate.trim().to_string()))
}

/// Trust check that canonicalizes the presented peer identifier first (see
/// [`resolve_registered_peer_name`]). Always prefer this over calling
/// `is_federated_server_trusted` directly.
async fn is_peer_trusted(state: &AppState, candidate: &str, now_ms: i64) -> Result<bool, ApiError> {
    let canonical = canonical_peer_name(state, candidate).await?;
    paracord_db::federation::is_federated_server_trusted(&state.db, &canonical, now_ms)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))
}

/// Returns true when `origin_server` is authoritative for the namespace domain
/// embedded in `room_id` — i.e. the room's home domain equals the origin (or a
/// trusted alias of it). Rooms whose id is unparseable are treated as
/// authoritative, because in that case `mapping_namespace_from_room` falls back
/// to `origin_server` and no cross-origin namespace is reachable.
async fn origin_authoritative_for_room_namespace(
    state: &AppState,
    origin_server: &str,
    room_id: &str,
) -> Result<bool, ApiError> {
    let Some((_, domain)) = parse_room_parts(room_id) else {
        return Ok(true);
    };
    if domain.eq_ignore_ascii_case(origin_server) {
        return Ok(true);
    }
    // The origin and the room domain may be different presentations of the same
    // trusted peer (server_name vs domain); resolve aliases as elsewhere.
    let peers = paracord_db::federation::list_trusted_federated_servers(&state.db)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let matches_alias = peers.into_iter().any(|peer| {
        let origin_matches = peer.server_name.eq_ignore_ascii_case(origin_server)
            || peer.domain.eq_ignore_ascii_case(origin_server);
        let domain_matches = peer.server_name.eq_ignore_ascii_case(domain)
            || peer.domain.eq_ignore_ascii_case(domain);
        origin_matches && domain_matches
    });
    Ok(matches_alias)
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

fn all_federation_guilds_allowed() -> bool {
    std::env::var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS")
        .ok()
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .any(|value| matches!(value, "*" | "all" | "ALL"))
        })
        .unwrap_or(false)
}

/// Default-deny gate on `PARACORD_FEDERATION_ALLOWED_GUILD_IDS`.
///
/// This governs the OUTBOUND path as well as the inbound one: a guild the
/// operator never opted into federation must neither accept mirrored events nor
/// emit its own (see `federation_forward_message`).
pub(crate) fn ensure_federation_guild_allowed(guild_id: i64) -> Result<(), ApiError> {
    if all_federation_guilds_allowed() {
        return Ok(());
    }
    let allowlist = parse_federation_allowed_guild_ids();
    if allowlist.iter().any(|allowed| *allowed == guild_id) {
        return Ok(());
    }
    Err(ApiError::Forbidden)
}

/// True when `channel` is visible to the guild's `@everyone` baseline.
///
/// Federated peers have no view of local roles, channel overwrites or
/// `required_role_ids`, so mirroring a channel that is narrower than
/// `@everyone` hands its contents to remote members who could never read it
/// locally. Anything that is not plainly public — a denied `VIEW_CHANNEL`
/// overwrite on the `@everyone` role (whose id is the guild id), a non-empty
/// `required_role_ids`, an orphaned thread, or a row we cannot read — is treated
/// as private and never leaves this server.
///
/// Threads and forum posts are evaluated against their parent, matching
/// `paracord_core::permissions`' own gate resolution: they carry no overwrites
/// of their own, so judging them directly would leak every private channel's
/// threads.
pub(crate) async fn federation_channel_is_public(
    state: &AppState,
    channel: &paracord_db::channels::ChannelRow,
    guild_id: i64,
) -> bool {
    let gate = if channel.channel_type == paracord_core::permissions::CHANNEL_TYPE_THREAD {
        let Some(parent_id) = channel.parent_id else {
            // Orphaned thread: no containment to evaluate, so deny.
            return false;
        };
        match paracord_db::channels::get_channel(&state.db, parent_id).await {
            Ok(Some(parent)) => parent,
            _ => return false,
        }
    } else {
        channel.clone()
    };

    if !paracord_db::channels::parse_required_role_ids(&gate.required_role_ids).is_empty() {
        return false;
    }

    // Baseline bits carried by the `@everyone` role (role id == guild id).
    let everyone = match paracord_db::roles::get_role(&state.db, guild_id).await {
        Ok(Some(role)) => role,
        _ => return false,
    };
    let mut perms = Permissions::from_bits_truncate(everyone.permissions);
    if perms.contains(Permissions::ADMINISTRATOR) {
        return true;
    }

    let overwrites =
        match paracord_db::channel_overwrites::get_channel_overwrites(&state.db, gate.id).await {
            Ok(rows) => rows,
            Err(_) => return false,
        };
    if let Some(everyone_overwrite) = overwrites.iter().find(|o| {
        o.target_type == paracord_core::permissions::OVERWRITE_TARGET_ROLE
            && o.target_id == guild_id
    }) {
        perms &= !Permissions::from_bits_truncate(everyone_overwrite.deny_perms);
        perms |= Permissions::from_bits_truncate(everyone_overwrite.allow_perms);
    }

    perms.contains(Permissions::VIEW_CHANNEL)
}

#[derive(Debug)]
struct FederationTransportHeaders {
    /// Presented `x-paracord-origin` as parsed. [`verify_transport_request`]
    /// rewrites this to the peer's registered `server_name` before returning, so
    /// callers always see one canonical spelling per peer — the header itself is
    /// unsigned and matches case-insensitively (and by `domain` alias), so it is
    /// never safe as a per-peer key.
    origin: String,
    key_id: String,
    timestamp_ms: i64,
    signature_hex: String,
    protocol_version: String,
    /// Destination server the request was signed for (host/authority the sender
    /// intended to reach). `None` for legacy peers that predate destination
    /// binding; `Some` requests are bound to this server's own identity.
    destination: Option<String>,
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
    let protocol_version = headers
        .get("x-paracord-fed-version")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(paracord_federation::FEDERATION_PROTOCOL_VERSION_V1)
        .to_string();
    let destination = headers
        .get("x-paracord-destination")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_ascii_lowercase());
    Ok(FederationTransportHeaders {
        origin,
        key_id,
        timestamp_ms,
        signature_hex,
        protocol_version,
        destination,
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
    let mut transport = parse_transport_headers(headers)?;
    if !paracord_federation::is_supported_protocol_version(&transport.protocol_version) {
        return Err(ApiError::UpgradeRequired(format!(
            "Unsupported federation protocol version '{}'. Supported versions: {}",
            transport.protocol_version,
            paracord_federation::FEDERATION_PROTOCOL_SUPPORTED.join(", ")
        )));
    }
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

    // Destination binding: a request signed for another server must not be
    // replayed/forwarded to us. The header is REQUIRED. An omitted destination
    // used to fall back to the unbound canonical form, which meant a signature
    // produced without destination binding verified at *every* server trusting
    // that origin, and any hostile peer holding one could forward it onward.
    // Peers predating destination binding are refused rather than silently
    // downgraded to the unbound form.
    let destination = transport
        .destination
        .as_deref()
        .ok_or(ApiError::Unauthorized)?;
    let is_self = destination.eq_ignore_ascii_case(service.server_name())
        || destination.eq_ignore_ascii_case(service.domain());
    if !is_self {
        return Err(ApiError::Forbidden);
    }

    // Resolve the presented origin to its registered `server_name` once, and use
    // that single canonical key for BOTH the trust lookup and the key lookup —
    // each of which matches `server_name` exactly.
    //
    // The resolved name then REPLACES the raw header on the returned struct, so
    // every downstream per-peer key derives from it. The transport signature
    // covers `METHOD\npath\ntimestamp\nsha256(body)\ndestination` and NOT the
    // origin, while `canonical_peer_name` accepts any casing plus the peer's
    // `domain` alias — so one valid signature could be presented under many
    // spellings of the same peer. Keyed on the raw header, each spelling got its
    // own replay-cache entry and its own rate-limit bucket, defeating both.
    let canonical_origin = canonical_peer_name(state, &transport.origin).await?;
    transport.origin = canonical_origin.clone();
    let trusted =
        paracord_db::federation::is_federated_server_trusted(&state.db, &canonical_origin, now_ms)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !trusted {
        return Err(ApiError::Forbidden);
    }

    let keys = service
        .list_server_keys(&state.db, &canonical_origin)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let trusted_key = keys
        .iter()
        .find(|k| k.key_id == transport.key_id && k.valid_until >= now_ms)
        .ok_or(ApiError::Forbidden)?;

    let canonical =
        paracord_federation::transport::canonical_transport_bytes_with_body_and_destination(
            method,
            path,
            transport.timestamp_ms,
            body_bytes,
            destination,
        );
    service
        .verify_payload(
            &canonical,
            &transport.signature_hex,
            &trusted_key.public_key,
        )
        .map_err(|_| ApiError::Forbidden)?;

    if enforce_replay_protection {
        // Keyed on `canonical_origin`, never the raw header (see above).
        let replay_material = format!(
            "{}\n{}\n{}\n{}\n{}",
            canonical_origin,
            transport.key_id,
            transport.timestamp_ms,
            path,
            transport.signature_hex
        );
        let replay_key = paracord_federation::transport::sha256_hex(replay_material.as_bytes());
        let inserted_replay = paracord_db::federation::insert_transport_replay_key(
            &state.db,
            &canonical_origin,
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

/// Constant-time string equality. Both inputs are folded through an HMAC keyed
/// by a server secret and the fixed-length tags are compared with the
/// constant-time `verify_slice`, mirroring the file-token check. This avoids
/// leaking how many leading bytes matched via an early-exit `==` comparison.
fn constant_time_str_eq(secret: &str, a: &str, b: &str) -> bool {
    use hmac::{Hmac, Mac};
    type HmacSha256 = Hmac<sha2::Sha256>;

    let Ok(mut mac_a) = HmacSha256::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac_a.update(a.as_bytes());
    let tag_a = mac_a.finalize().into_bytes();

    let Ok(mut mac_b) = HmacSha256::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac_b.update(b.as_bytes());
    mac_b.verify_slice(&tag_a).is_ok()
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
            // Fail CLOSED: a DB error used to yield `0`, silently disabling the
            // per-peer creation limit exactly when the database is unhealthy.
            let count = match paracord_db::rate_limits::increment_window_counter(
                &state.db,
                &bucket_key,
                hour,
                3600,
            )
            .await
            {
                Ok(count) => count,
                Err(err) => {
                    tracing::error!(
                        "federation: refusing remote user creation for {} because the rate-limit counter failed: {}",
                        identity.server,
                        err
                    );
                    return Err(ApiError::RateLimited(0));
                }
            };
            if count > limit as i64 {
                return Err(ApiError::RateLimited(0));
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
    let canonical_origin = canonical_peer_name(state, &payload.origin_server).await?;
    let payload_origin_trusted =
        paracord_db::federation::is_federated_server_trusted(&state.db, &canonical_origin, now_ms)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !payload_origin_trusted {
        return Err(ApiError::Forbidden);
    }
    let keys = service
        .list_server_keys(&state.db, &canonical_origin)
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
    validate_envelope_identifier_lengths(&payload)?;

    let now_ms = chrono::Utc::now().timestamp_millis();

    // Per-event freshness. The transport timestamp is bounded to ±60s, but the
    // envelope's own `origin_ts` was previously unchecked, so a peer — or an
    // allowed relay (see below) — could re-inject arbitrarily old signed
    // envelopes under a fresh transport signature. Bounding acceptance here is
    // also what makes `federation_events` prunable without re-opening replay;
    // see `FederationService::prune_expired_events`.
    if !paracord_federation::event_origin_ts_is_fresh(payload.origin_ts, now_ms) {
        tracing::warn!(
            "federation: rejected event {} from {} with out-of-window origin_ts {} (now {})",
            payload.event_id,
            payload.origin_server,
            payload.origin_ts,
            now_ms
        );
        return Err(ApiError::BadRequest(
            "federation event origin_ts is outside the accepted freshness window".to_string(),
        ));
    }

    // `depth` orders room history (`list_room_events`). Left unbounded a peer
    // could pin `i64::MAX` and permanently sit at the head of every backfill,
    // so bound it to the same window `origin_ts` is bound to.
    if payload.depth < 0
        || payload.depth
            > now_ms.saturating_add(paracord_federation::MAX_INBOUND_EVENT_FUTURE_SKEW_MS)
    {
        tracing::warn!(
            "federation: rejected event {} from {} with out-of-range depth {}",
            payload.event_id,
            payload.origin_server,
            payload.depth
        );
        return Err(ApiError::BadRequest(
            "federation event depth is out of range".to_string(),
        ));
    }
    if payload.depth == 0 {
        payload.depth = payload.origin_ts.max(1);
    }

    // Enforce that the immediate transport sender is authorized to deliver this
    // envelope: either it IS the envelope origin, or it is an allowed relay
    // (a currently-trusted federated server delivering on the origin's behalf in
    // a non-full-mesh topology). Reject hard otherwise so a peer cannot smuggle
    // events attributed to an origin it has no relationship with.
    if let Some(origin) = transport_origin {
        if !origin.eq_ignore_ascii_case(&payload.origin_server) {
            let relay_trusted = is_peer_trusted(state, origin, now_ms).await?;
            if !relay_trusted {
                tracing::warn!(
                    "federation: rejected event {} relayed by untrusted server {} for origin {}",
                    payload.event_id,
                    origin,
                    payload.origin_server
                );
                return Err(ApiError::Forbidden);
            }
        }
    }

    // Bind the envelope origin to the room's namespace domain. The target local
    // guild/channel is resolved from the DOMAIN embedded in the peer-supplied
    // room_id (see `mapping_namespace_from_room`), so without this check a trusted
    // peer could inject events into — or pre-create ("squat") the mapping for —
    // another server's room namespace. A cross-origin send is only legitimate when
    // the origin is already a recorded participant of the room, mirroring the
    // read-path `server_participates_in_room` guard; a non-authoritative origin is
    // never allowed to be the first to materialize a room mapping.
    if !origin_authoritative_for_room_namespace(state, &payload.origin_server, &payload.room_id)
        .await?
        && !server_participates_in_room(state, &payload.origin_server, &payload.room_id).await?
    {
        tracing::warn!(
            "federation: rejected event {} from origin {} targeting foreign room namespace {}",
            payload.event_id,
            payload.origin_server,
            payload.room_id
        );
        return Err(ApiError::Forbidden);
    }

    // Update last_seen_at for the envelope origin and immediate transport sender.
    let _ =
        paracord_db::federation::touch_federated_server(&state.db, &payload.origin_server).await;
    if let Some(origin) = transport_origin {
        if !origin.eq_ignore_ascii_case(&payload.origin_server) {
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
            other => {
                // Unknown/unhandled federated event types have no defined client
                // handling. Do NOT globally fan them out: the previous behaviour
                // dispatched `FEDERATION_<TYPE>` with peer-controlled `content` and
                // a `None` guild target, which is a global broadcast to every
                // connected session and lets a trusted peer push arbitrary JSON to
                // all local clients. Drop them instead.
                tracing::debug!(
                    "federation: dropping unhandled event type '{}' (event_id {}, origin {})",
                    other,
                    payload.event_id,
                    payload.origin_server
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

pub async fn well_known(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() || !service.allow_discovery() {
        return Err(ApiError::NotFound);
    }
    Ok(Json(json!({
        "server_name": service.server_name(),
        "domain": service.domain(),
        "federation_endpoint": "/_paracord/federation/v1",
        "enabled": service.is_enabled(),
        "version": paracord_federation::FEDERATION_PROTOCOL_DEFAULT,
        "supported_versions": paracord_federation::FEDERATION_PROTOCOL_SUPPORTED,
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
    raw_body: Bytes,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::Forbidden);
    }

    // Verify the transport signature over the exact bytes received, then parse.
    // Re-serializing a parsed struct could diverge from what the peer signed.
    let transport = verify_transport_request(
        &state,
        &service,
        &headers,
        "POST",
        "/_paracord/federation/v1/event",
        &raw_body,
        None,
        true,
    )
    .await?;
    let payload: FederationEventEnvelope = serde_json::from_slice(&raw_body)
        .map_err(|e| ApiError::BadRequest(format!("invalid federation envelope: {e}")))?;

    // Per-peer rate limiting on event ingestion. `transport.origin` is the
    // canonicalized `server_name` (see `verify_transport_request`); the raw
    // header would let one peer mint a fresh bucket per spelling of its own name.
    if let Some(limit) = state.config.federation_max_events_per_peer_per_minute {
        if limit > 0 {
            let now = chrono::Utc::now().timestamp();
            let minute = now / 60;
            let bucket_key = format!("fed:ingest:{}", transport.origin);
            // Fail CLOSED: a DB error used to yield `0`, silently removing the
            // per-peer ingest limit exactly when the database is unhealthy.
            let count = match paracord_db::rate_limits::increment_window_counter(
                &state.db,
                &bucket_key,
                minute,
                60,
            )
            .await
            {
                Ok(count) => count,
                Err(err) => {
                    tracing::error!(
                        "federation: refusing ingest from {} because the rate-limit counter failed: {}",
                        transport.origin,
                        err
                    );
                    return Err(ApiError::RateLimited(0));
                }
            };
            if count > limit as i64 {
                return Err(ApiError::RateLimited(0));
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

/// Emit the generic `FEDERATION_M.MESSAGE` fallback for an inbound message that
/// could not be stored, scoped to the guild it belongs to.
///
/// `local_guild_id` is REQUIRED to be concrete. `EventBus::dispatch` with a
/// `None` guild and no user targets takes the *global* branch of `publish()` and
/// reaches every connected session, so passing the unresolved `None` here handed
/// a trusted peer an arbitrary-JSON broadcast to every local client — including
/// accounts that share no guild with the sender. That is the same hole already
/// closed for unknown event types (see the `other =>` arm in
/// [`ingest_verified_payload`]); a message that resolves to no local guild is
/// dropped for the same reason.
fn dispatch_federated_message_fallback(
    state: &AppState,
    payload: &FederationEventEnvelope,
    local_guild_id: Option<i64>,
) {
    let Some(guild_id) = local_guild_id else {
        tracing::warn!(
            "federation: dropping m.message event {} from {} because it resolves to no local guild (a guild-less dispatch would broadcast peer content to every session)",
            payload.event_id,
            payload.origin_server
        );
        return;
    };
    // The mirrored guild must still be federation-enabled: `resolve_local_guild_id`
    // only maps ids, it does not consult the default-deny allowlist the rest of
    // the ingest path enforces.
    if ensure_federation_guild_allowed(guild_id).is_err() {
        tracing::warn!(
            "federation: dropping m.message event {} from {} because guild {} is not federation-allowed",
            payload.event_id,
            payload.origin_server,
            guild_id
        );
        return;
    }
    state.event_bus.dispatch(
        "FEDERATION_M.MESSAGE",
        json!({
            "event_id": payload.event_id,
            "origin_server": payload.origin_server,
            "sender": payload.sender,
            "content": payload.content,
        }),
        Some(guild_id),
    );
}

/// Dispatch a gateway event derived from an inbound federated envelope, but only
/// when it is scoped to a concrete guild.
///
/// Same rule as [`dispatch_federated_message_fallback`]: a `None` guild with no
/// user targets is a GLOBAL fan-out. Every federated event is materialized into
/// a guild channel, so `guild_id()` being `None` here means the event no longer
/// describes anything a client should be told about — drop it rather than
/// broadcast it.
fn dispatch_federated_guild_event(
    state: &AppState,
    payload: &FederationEventEnvelope,
    guild_id: Option<i64>,
    event_type: &str,
    body: Value,
) {
    let Some(guild_id) = guild_id else {
        tracing::warn!(
            "federation: dropping {} for event {} from {} because it resolves to no local guild",
            event_type,
            payload.event_id,
            payload.origin_server
        );
        return;
    };
    state.event_bus.dispatch(event_type, body, Some(guild_id));
}

/// Handle an inbound federated message event: store it as a local message and
/// dispatch a `MESSAGE_CREATE` gateway event so connected clients see it.
async fn dispatch_federated_message(state: &AppState, payload: &FederationEventEnvelope) {
    // Bind the message sender to the envelope origin: a validly-signed peer may
    // only assert messages authored by identities that belong to it (or one of
    // its trusted domain aliases). Otherwise a trusted peer could impersonate
    // another server's users.
    let Some(identity) = FederatedIdentity::parse(&payload.sender) else {
        tracing::warn!(
            "federation: cannot store inbound message from event {} because sender identity is invalid: {}",
            payload.event_id,
            payload.sender
        );
        return;
    };
    if ensure_identity_matches_origin_or_alias(state, &identity, &payload.origin_server)
        .await
        .is_err()
    {
        tracing::warn!(
            "federation: rejected m.message event {} because sender {} does not belong to origin {}",
            payload.event_id,
            payload.sender,
            payload.origin_server
        );
        return;
    }

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

    // Federated bodies previously went into `create_message` capped only by the
    // 1 MiB `validate_federation_content` envelope limit, then fanned out to
    // every session in the mirrored guild — while a local send is capped at
    // 2000 chars. Apply the same local limit to peer-supplied content.
    if let Err(err) = paracord_util::validation::validate_message_content(&body_text) {
        tracing::warn!(
            "federation: dropped m.message event {} from {}: body fails local message validation: {}",
            payload.event_id,
            payload.origin_server,
            err
        );
        return;
    }

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
        dispatch_federated_message_fallback(state, payload, mapped_local_guild_id);
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
                    dispatch_federated_message_fallback(state, payload, mapped_local_guild_id);
                    return;
                };
                let Some(local_guild_id) =
                    ensure_federated_space_allowed(state, payload, remote_gid).await
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
                    dispatch_federated_message_fallback(state, payload, Some(local_guild_id));
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
            dispatch_federated_message_fallback(state, payload, mapped_local_guild_id);
            return;
        };
        let Some(local_guild_id) = ensure_federated_space_allowed(state, payload, remote_gid).await
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
            dispatch_federated_message_fallback(state, payload, Some(local_guild_id));
            return;
        };
        materialized
    };
    let local_channel_id = channel.id;

    // Generate a local message ID for storage
    let local_msg_id = paracord_util::snowflake::generate(1);

    let author_id = match ensure_remote_user_mapping(state, &identity).await {
        Ok(uid) => uid,
        Err(e) => {
            tracing::warn!(
                "federation: failed to map sender identity {} for event {}: {}",
                payload.sender,
                payload.event_id,
                e
            );
            return;
        }
    };

    // Store the federated message in the local messages table.
    // Author ID is always a mapped remote pseudo-user.
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
            // Fall back to generic event dispatch, scoped to the channel's guild.
            // `guild_id()` is `None` for a non-guild channel, which would make
            // this a global broadcast of peer-supplied content.
            dispatch_federated_message_fallback(state, payload, channel.guild_id());
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

/// Resolve (and, when permitted, materialize) the local guild backing a
/// federated event — enforcing the operator's federation guild allowlist
/// *before* any local rows are created.
///
/// `ensure_federated_space_exists` creates a guild row, an `@everyone` role, a
/// system member and a role grant on first sight of a remote space id. Calling
/// it without an allowlist check let a trusted peer mint unbounded guilds by
/// varying `room_id`/`content.guild_id` per event. The allowlist is a list of
/// *local* guild ids, so:
///
/// * an already-mirrored space is checked against its resolved local guild id;
/// * an unmapped space can only be materialized when the operator opted every
///   guild in (`PARACORD_FEDERATION_ALLOWED_GUILD_IDS=*`), because a freshly
///   generated snowflake can never appear on an explicit allowlist.
///
/// That is the documented default-deny behaviour.
async fn ensure_federated_space_allowed(
    state: &AppState,
    payload: &FederationEventEnvelope,
    remote_guild_id: i64,
) -> Option<i64> {
    let mapping_namespace = mapping_namespace_from_room(&payload.room_id, &payload.origin_server);
    match resolve_local_guild_id(state, &mapping_namespace, remote_guild_id).await {
        Some(existing) => {
            if ensure_federation_guild_allowed(existing).is_err() {
                tracing::warn!(
                    "federation: dropped event {} from {} for guild {} (not in PARACORD_FEDERATION_ALLOWED_GUILD_IDS)",
                    payload.event_id,
                    payload.origin_server,
                    existing
                );
                return None;
            }
        }
        None => {
            if !all_federation_guilds_allowed() {
                tracing::warn!(
                    "federation: refused to materialize unmapped remote guild {} from {} (event {}): federation guild allowlist is default-deny",
                    remote_guild_id,
                    payload.origin_server,
                    payload.event_id
                );
                return None;
            }
        }
    }
    ensure_federated_space_exists(state, payload, remote_guild_id).await
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
        if let Ok(id) = paracord_db::federation::get_local_message_id_by_event(
            &state.db,
            &payload.origin_server,
            target_event_id,
        )
        .await
        {
            if id.is_some() {
                return id;
            }
        }
    }
    None
}

async fn dispatch_federated_message_edit(state: &AppState, payload: &FederationEventEnvelope) {
    // Bind the editing sender to the envelope origin so a trusted peer cannot
    // edit messages on behalf of another server's users.
    let Some(identity) = FederatedIdentity::parse(&payload.sender) else {
        tracing::warn!(
            "federation: rejected m.message.edit {} because sender identity is invalid: {}",
            payload.event_id,
            payload.sender
        );
        return;
    };
    if ensure_identity_matches_origin_or_alias(state, &identity, &payload.origin_server)
        .await
        .is_err()
    {
        tracing::warn!(
            "federation: rejected m.message.edit {} because sender {} does not belong to origin {}",
            payload.event_id,
            payload.sender,
            payload.origin_server
        );
        return;
    }

    // Edit target resolution is scoped to the envelope origin, so a peer can only
    // edit messages it originally authored, never another server's messages.
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
    dispatch_federated_guild_event(state, payload, guild_id, "MESSAGE_UPDATE", msg_json);
}

async fn dispatch_federated_message_delete(state: &AppState, payload: &FederationEventEnvelope) {
    // Bind the deleting sender to the envelope origin so a trusted peer cannot
    // delete messages on behalf of another server's users.
    let Some(identity) = FederatedIdentity::parse(&payload.sender) else {
        tracing::warn!(
            "federation: rejected m.message.delete {} because sender identity is invalid: {}",
            payload.event_id,
            payload.sender
        );
        return;
    };
    if ensure_identity_matches_origin_or_alias(state, &identity, &payload.origin_server)
        .await
        .is_err()
    {
        tracing::warn!(
            "federation: rejected m.message.delete {} because sender {} does not belong to origin {}",
            payload.event_id,
            payload.sender,
            payload.origin_server
        );
        return;
    }

    // Delete target resolution is scoped to the envelope origin, so a peer can
    // only delete messages it originally authored.
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

    dispatch_federated_guild_event(
        state,
        payload,
        guild_id,
        "MESSAGE_DELETE",
        json!({
            "id": local_message_id.to_string(),
            "channel_id": channel_id.to_string(),
            "federation": {
                "event_id": payload.event_id,
                "origin_server": payload.origin_server,
            }
        }),
    );
}

async fn dispatch_federated_reaction_add(state: &AppState, payload: &FederationEventEnvelope) {
    let Some(local_message_id) = resolve_local_message_id_from_payload(state, payload).await else {
        return;
    };
    let Some(identity) = FederatedIdentity::parse(&payload.sender) else {
        return;
    };
    // Bind the reacting sender to the envelope origin so a trusted peer cannot
    // attribute a reaction to another server's user (identity spoofing).
    if ensure_identity_matches_origin_or_alias(state, &identity, &payload.origin_server)
        .await
        .is_err()
    {
        tracing::warn!(
            "federation: rejected m.reaction.add {} because sender {} does not belong to origin {}",
            payload.event_id,
            payload.sender,
            payload.origin_server
        );
        return;
    }
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
    dispatch_federated_guild_event(
        state,
        payload,
        guild_id,
        "MESSAGE_REACTION_ADD",
        json!({
            "user_id": local_user_id.to_string(),
            "channel_id": channel_id.to_string(),
            "message_id": local_message_id.to_string(),
            "emoji": emoji,
        }),
    );
}

async fn dispatch_federated_reaction_remove(state: &AppState, payload: &FederationEventEnvelope) {
    let Some(local_message_id) = resolve_local_message_id_from_payload(state, payload).await else {
        return;
    };
    let Some(identity) = FederatedIdentity::parse(&payload.sender) else {
        return;
    };
    // Bind the reacting sender to the envelope origin so a trusted peer cannot
    // attribute a reaction removal to another server's user (identity spoofing).
    if ensure_identity_matches_origin_or_alias(state, &identity, &payload.origin_server)
        .await
        .is_err()
    {
        tracing::warn!(
            "federation: rejected m.reaction.remove {} because sender {} does not belong to origin {}",
            payload.event_id,
            payload.sender,
            payload.origin_server
        );
        return;
    }
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
    dispatch_federated_guild_event(
        state,
        payload,
        guild_id,
        "MESSAGE_REACTION_REMOVE",
        json!({
            "user_id": local_user_id.to_string(),
            "channel_id": channel_id.to_string(),
            "message_id": local_message_id.to_string(),
            "emoji": emoji,
        }),
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
    // Allowlist BEFORE materialization: `ensure_federated_space_exists` creates
    // guild/role/member/role-grant rows, so checking afterwards left a denied
    // join with all of that state already written.
    let Some(guild_id) = ensure_federated_space_allowed(state, payload, remote_guild_id).await
    else {
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
    state
        .member_index
        .remove_member(guild_id, mapping.local_user_id);
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
    let auth = authorize_federation_read_request(&state, &service, &headers, uri.path()).await?;
    let event = service
        .fetch_event(&state.db, &event_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    match event {
        Some(envelope) => {
            // Read scoping: a signed peer may only fetch an event for a room it
            // actually participates in. `get_event` takes an event_id (not a
            // room_id), so we resolve the event's room from the fetched envelope
            // and enforce the same participation gate as `list_events`. Deny with
            // NotFound (rather than Forbidden) so a non-participating peer cannot
            // confirm an event's existence by enumerating IDs. The operator read
            // token bypasses this, matching `list_events`.
            if let FederationReadAuth::Peer { origin } = &auth {
                if !server_participates_in_room(&state, origin, &envelope.room_id).await? {
                    return Err(ApiError::NotFound);
                }
            }
            Ok(Json(json!(envelope)))
        }
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
    let auth =
        authorize_federation_read_request(&state, &service, &headers, &path_and_query).await?;

    // Read scoping: a signed peer may only pull history for rooms it actually
    // participates in. Deny by default. The operator read token bypasses this
    // (it is an explicit local-operator escape hatch, not a remote peer).
    if let FederationReadAuth::Peer { origin } = &auth {
        if !server_participates_in_room(&state, origin, &query.room_id).await? {
            return Err(ApiError::Forbidden);
        }
    }

    let since_depth = query.since_depth.unwrap_or(0).max(0);
    let limit = query.limit.unwrap_or(100).clamp(1, 1000);
    let events = service
        .list_room_events(&state.db, &query.room_id, since_depth, limit)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!({ "events": events })))
}

#[derive(Debug, Clone, Deserialize)]
pub struct FederationDiscoveryQuery {
    pub search: Option<String>,
    pub tag: Option<String>,
    pub limit: Option<i64>,
}

/// Hard ceiling on how many local guilds one peer discovery request will
/// consider, mirroring the user-facing discovery handler.
const MAX_PEER_DISCOVERY_CANDIDATES: usize = 200;
/// Maximum entries returned on one peer discovery page.
const MAX_PEER_DISCOVERY_PAGE: i64 = 50;

fn parse_discovery_tags_value(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

/// `GET /_paracord/federation/v1/discovery/guilds` — peer-facing discovery.
///
/// The user-facing `/api/v1/discovery/guilds` now requires `AuthUser` (it was an
/// anonymous N+1 amplification vector), which silently broke peer-to-peer
/// federated discovery: peers fetched it with no credentials and started getting
/// 401. Rather than punching an auth hole in the user-facing route, peer traffic
/// moves here, onto the path that already has Ed25519 transport-signature
/// verification, origin/trust checks and per-peer bounds.
///
/// Only guilds the operator has explicitly opted into federation
/// (`PARACORD_FEDERATION_ALLOWED_GUILD_IDS`) are advertised, and the whole
/// handler runs with zero per-guild database queries: member counts come from
/// the in-memory `member_index`, so the anonymous-amplification shape that
/// motivated the original fix is not reintroduced here.
pub async fn peer_discovery_guilds(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Query(query): Query<FederationDiscoveryQuery>,
) -> Result<Json<Value>, ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() || !service.allow_discovery() {
        return Err(ApiError::NotFound);
    }

    let path_and_query = uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| uri.path().to_string());
    // Signature-verified: rejects unsigned callers, untrusted peers, and peers
    // that are blocked or quarantined (`verify_transport_request` ->
    // `is_peer_trusted`).
    let _auth =
        authorize_federation_read_request(&state, &service, &headers, &path_and_query).await?;

    let limit = query.limit.unwrap_or(20).clamp(1, MAX_PEER_DISCOVERY_PAGE);

    let all_guilds = paracord_db::guilds::list_all_guilds(&state.db)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let search = query.search.as_deref().map(str::to_lowercase);
    let tag = query.tag.as_deref().map(str::to_lowercase);

    let mut discoverable: Vec<_> = all_guilds
        .into_iter()
        .filter(|g| g.visibility.eq_ignore_ascii_case("public"))
        // Federation allowlist: a guild the operator has not opted into
        // federation must not be advertised to peers at all.
        .filter(|g| ensure_federation_guild_allowed(g.id).is_ok())
        .filter(|g| {
            search.as_deref().is_none_or(|needle| {
                g.name.to_lowercase().contains(needle)
                    || g.description
                        .as_deref()
                        .is_some_and(|d| d.to_lowercase().contains(needle))
            })
        })
        .filter(|g| {
            tag.as_deref().is_none_or(|needle| {
                parse_discovery_tags_value(&g.discovery_tags)
                    .iter()
                    .any(|t| t.to_lowercase() == needle)
            })
        })
        .collect();
    discoverable.truncate(MAX_PEER_DISCOVERY_CANDIDATES);

    // Member counts come from the in-memory index the presence path already
    // maintains — no per-guild query, bounded or otherwise.
    let mut entries: Vec<(usize, Value)> = discoverable
        .into_iter()
        .map(|guild| {
            let members = state.member_index.members_of(guild.id);
            let online_count = members
                .iter()
                .filter(|uid| state.online_users.contains(uid))
                .count();
            (
                members.len(),
                json!({
                    "id": guild.id.to_string(),
                    "name": guild.name,
                    "description": guild.description,
                    "icon_hash": guild.icon_hash,
                    "member_count": members.len(),
                    "online_count": online_count,
                    "tags": parse_discovery_tags_value(&guild.discovery_tags),
                    "created_at": guild.created_at.to_rfc3339(),
                    "federated": false,
                }),
            )
        })
        .collect();

    entries.sort_by_key(|(member_count, _)| std::cmp::Reverse(*member_count));
    let total = entries.len() as i64;
    let guilds: Vec<Value> = entries
        .into_iter()
        .take(limit as usize)
        .map(|(_, entry)| entry)
        .collect();

    Ok(Json(json!({
        "guilds": guilds,
        "total": total,
    })))
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

/// Outcome of authorizing an inbound federation read request.
enum FederationReadAuth {
    /// Authorized by the operator-provisioned read token; not tied to any peer,
    /// so per-room membership scoping does not apply.
    OperatorToken,
    /// Authorized by a signed transport from the named federated server.
    Peer { origin: String },
}

async fn authorize_federation_read_request(
    state: &AppState,
    service: &FederationService,
    headers: &HeaderMap,
    path: &str,
) -> Result<FederationReadAuth, ApiError> {
    if let Some(expected) = optional_federation_read_token() {
        let presented = headers
            .get("x-paracord-federation-token")
            .and_then(|v| v.to_str().ok())
            .map(str::trim);
        if presented
            .is_some_and(|p| constant_time_str_eq(&state.config.jwt_secret, p, expected.as_str()))
        {
            return Ok(FederationReadAuth::OperatorToken);
        }
    }

    let transport =
        verify_transport_request(state, service, headers, "GET", path, &[], None, false).await?;
    Ok(FederationReadAuth::Peer {
        origin: transport.origin,
    })
}

/// Return true if `candidate_server` participates in `room_id`, matching by the
/// server's own name/domain or by any trusted-peer alias of it. Deny by default.
async fn server_participates_in_room(
    state: &AppState,
    candidate_server: &str,
    room_id: &str,
) -> Result<bool, ApiError> {
    let member_servers = paracord_db::federation::list_room_member_servers(&state.db, room_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if member_servers
        .iter()
        .any(|server| server.eq_ignore_ascii_case(candidate_server))
    {
        return Ok(true);
    }

    // The candidate may present under a name that differs from how memberships
    // were recorded (e.g. server_name vs domain). Resolve trusted-peer aliases
    // and check those too, mirroring `ensure_identity_matches_origin_or_alias`.
    let peers = paracord_db::federation::list_trusted_federated_servers(&state.db)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    for peer in peers {
        let is_candidate = peer.server_name.eq_ignore_ascii_case(candidate_server)
            || peer.domain.eq_ignore_ascii_case(candidate_server);
        if !is_candidate {
            continue;
        }
        if member_servers.iter().any(|server| {
            server.eq_ignore_ascii_case(&peer.server_name)
                || server.eq_ignore_ascii_case(&peer.domain)
        }) {
            return Ok(true);
        }
    }

    Ok(false)
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
    raw_body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::Forbidden);
    }

    let body: FederationInviteRequest = serde_json::from_slice(&raw_body)
        .map_err(|e| ApiError::BadRequest(format!("invalid request body: {e}")))?;
    verify_transport_request(
        &state,
        &service,
        &headers,
        "POST",
        "/_paracord/federation/v1/invite",
        &raw_body,
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
    raw_body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::Forbidden);
    }
    let body: FederationJoinRequest = serde_json::from_slice(&raw_body)
        .map_err(|e| ApiError::BadRequest(format!("invalid request body: {e}")))?;
    verify_transport_request(
        &state,
        &service,
        &headers,
        "POST",
        "/_paracord/federation/v1/join",
        &raw_body,
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
    raw_body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::Forbidden);
    }
    let body: FederationLeaveRequest = serde_json::from_slice(&raw_body)
        .map_err(|e| ApiError::BadRequest(format!("invalid request body: {e}")))?;
    verify_transport_request(
        &state,
        &service,
        &headers,
        "POST",
        "/_paracord/federation/v1/leave",
        &raw_body,
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
        state
            .member_index
            .remove_member(guild_id, mapping.local_user_id);
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
    raw_body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::Forbidden);
    }
    let body: FederationMediaTokenRequest = serde_json::from_slice(&raw_body)
        .map_err(|e| ApiError::BadRequest(format!("invalid request body: {e}")))?;
    verify_transport_request(
        &state,
        &service,
        &headers,
        "POST",
        "/_paracord/federation/v1/media/token",
        &raw_body,
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
    raw_body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::Forbidden);
    }
    let body: FederationMediaRelayRequest = serde_json::from_slice(&raw_body)
        .map_err(|e| ApiError::BadRequest(format!("invalid request body: {e}")))?;
    verify_transport_request(
        &state,
        &service,
        &headers,
        "POST",
        "/_paracord/federation/v1/media/relay",
        &raw_body,
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
    admin: AdminUser,
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<AddServerRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::BadRequest("federation is disabled".to_string()));
    }

    if body.server_name.trim().is_empty()
        || body.domain.trim().is_empty()
        || body.federation_endpoint.is_empty()
    {
        return Err(ApiError::BadRequest(
            "server_name, domain, and federation_endpoint are required".to_string(),
        ));
    }
    // Server names and domains are hostnames: store them lowercased so the
    // exact-match join in `is_federated_server_trusted` lines up with the
    // lowercased key a moderation list writes for a not-yet-registered peer.
    let server_name = body.server_name.trim().to_ascii_lowercase();
    let domain = body.domain.trim().to_ascii_lowercase();
    paracord_federation::client::validate_public_federation_url_with_dns(&body.federation_endpoint)
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    let mut public_key = body.public_key_hex.clone();
    let mut key_id = body.key_id.clone();

    // If discover is set, fetch keys from the remote server over plain HTTPS.
    // Everything in that response is remote self-assertion, so it is pinned and
    // bounded before it is trusted:
    //   * when the admin supplied a `public_key_hex` it acts as a pin — a
    //     mismatch is a hard failure, never a silent overwrite;
    //   * `key_id`, when supplied, selects the key instead of blindly taking
    //     `keys.first()`;
    //   * `server_name` on the key must be the peer being registered;
    //   * `valid_until` is clamped to `MAX_DISCOVERED_KEY_VALIDITY_MS`, because
    //     it is the *only* expiry gate on the verification path and a peer could
    //     otherwise assert `i64::MAX` and pin the key forever;
    //   * a discovery request that yields no usable key fails the call rather
    //     than quietly registering a keyless peer.
    if body.discover {
        let client = paracord_federation::client::FederationClient::new()
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        let keys_resp = client
            .fetch_server_keys(&body.federation_endpoint)
            .await
            .map_err(|e| {
                ApiError::BadRequest(format!(
                    "key discovery from {} failed: {e}",
                    body.federation_endpoint
                ))
            })?;

        let selected = match key_id.as_deref() {
            Some(pinned_id) => keys_resp.keys.iter().find(|k| k.key_id == pinned_id),
            None => keys_resp.keys.first(),
        }
        .ok_or_else(|| {
            ApiError::BadRequest(format!(
                "key discovery from {} returned no usable key",
                body.federation_endpoint
            ))
        })?;

        if !selected.server_name.eq_ignore_ascii_case(&server_name)
            && !selected.server_name.eq_ignore_ascii_case(&domain)
        {
            return Err(ApiError::BadRequest(format!(
                "discovered key is issued for '{}', not '{}'",
                selected.server_name, server_name
            )));
        }
        if let Some(pinned_key) = public_key.as_deref() {
            if !pinned_key.eq_ignore_ascii_case(&selected.public_key) {
                return Err(ApiError::BadRequest(
                    "discovered public key does not match the pinned public_key_hex".to_string(),
                ));
            }
        }

        let now_ms = chrono::Utc::now().timestamp_millis();
        if selected.valid_until <= now_ms {
            return Err(ApiError::BadRequest(
                "discovered key is already expired".to_string(),
            ));
        }
        let bounded = paracord_federation::FederationServerKey {
            server_name: server_name.clone(),
            key_id: selected.key_id.clone(),
            public_key: selected.public_key.clone(),
            valid_until: selected
                .valid_until
                .min(now_ms.saturating_add(MAX_DISCOVERED_KEY_VALIDITY_MS)),
        };
        public_key = Some(bounded.public_key.clone());
        key_id = Some(bounded.key_id.clone());
        service
            .upsert_server_key(&state.db, &bounded)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    }

    let id = paracord_util::snowflake::generate(1);
    paracord_db::federation::upsert_federated_server(
        &state.db,
        id,
        &server_name,
        &domain,
        &body.federation_endpoint,
        public_key.as_deref(),
        key_id.as_deref(),
        body.trusted,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let peer_ip = addr.ip().to_string();
    security::log_security_event(
        &state,
        "federation.server.add",
        Some(admin.user_id),
        None,
        None,
        Some(&headers),
        Some(peer_ip.as_str()),
        Some(json!({
            "server_name": server_name,
            "domain": domain,
            "trusted": body.trusted,
        })),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": id,
            "server_name": server_name,
            "domain": domain,
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
    admin: AdminUser,
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(server_name): Path<String>,
) -> Result<StatusCode, ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::BadRequest("federation is disabled".to_string()));
    }

    let deleted = paracord_db::federation::delete_federated_server(&state.db, &server_name)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let peer_ip = addr.ip().to_string();
    security::log_security_event(
        &state,
        "federation.server.delete",
        Some(admin.user_id),
        None,
        None,
        Some(&headers),
        Some(peer_ip.as_str()),
        Some(json!({ "server_name": server_name, "deleted": deleted })),
    )
    .await;

    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModerationListEntry {
    #[serde(alias = "server", alias = "domain")]
    pub server_name: String,
    pub action: String,
    pub reason: Option<String>,
    pub quarantine_minutes: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ApplyModerationListRequest {
    pub source: String,
    #[serde(default)]
    pub entries: Vec<ModerationListEntry>,
}

/// Normalize a moderation action string to its canonical form.
///
/// `allow_unblock` controls whether an `allow`/`unblock` action is honored. It
/// must be `false` for entries ingested from a remote subscription: a remote
/// list may add blocks/quarantines but must never be able to *lift* a block a
/// local operator applied, otherwise a compromised or hostile upstream list
/// could silently re-admit a server the admin banned. Admin-direct applies pass
/// `true` and retain the full capability.
fn normalize_moderation_action(action: &str, allow_unblock: bool) -> Option<&'static str> {
    let normalized = action.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "allow" | "unblock" => allow_unblock.then_some("allow"),
        "block" | "deny" => Some("block"),
        "quarantine" => Some("quarantine"),
        _ => None,
    }
}

async fn apply_moderation_entries(
    state: &AppState,
    source: &str,
    entries: &[ModerationListEntry],
    allow_unblock: bool,
) -> Result<usize, ApiError> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut applied = 0usize;
    for entry in entries {
        let raw = entry.server_name.trim();
        if raw.is_empty() {
            continue;
        }
        // Write the trust row under the exact `federated_servers.server_name`
        // the peer is registered as. `is_federated_server_trusted` joins the two
        // tables on an exact string match, so lowercasing here (while
        // `upsert_federated_server` stores the name verbatim) produced trust
        // rows that never joined: blocking `Peer.Example` did nothing at all.
        // `ModerationListEntry` also accepts a `domain` alias, which never
        // matched `server_name` either; `resolve_registered_peer_name` resolves
        // both presentations to the one canonical key.
        //
        // An entry naming a server that is not registered yet is still recorded
        // (lowercased) so a pre-emptive block survives until that server is
        // added, and `add_server` normalizes new registrations to lowercase so
        // the two meet.
        let server = match resolve_registered_peer_name(state, raw).await? {
            Some(canonical) => canonical,
            None => raw.to_ascii_lowercase(),
        };
        let Some(mode) = normalize_moderation_action(&entry.action, allow_unblock) else {
            continue;
        };
        let quarantined_until_ms = if mode == "quarantine" {
            let minutes = entry
                .quarantine_minutes
                .unwrap_or(60)
                .clamp(1, 60 * 24 * 30);
            Some(now_ms + minutes.saturating_mul(60_000))
        } else {
            None
        };
        let reason = entry
            .reason
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| format!("[{source}] {value}"));
        paracord_db::federation::upsert_peer_trust_state(
            &state.db,
            &server,
            mode,
            reason.as_deref(),
            quarantined_until_ms,
            now_ms,
        )
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        applied += 1;
    }
    Ok(applied)
}

pub async fn apply_moderation_list(
    admin: AdminUser,
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ApplyModerationListRequest>,
) -> Result<Json<Value>, ApiError> {
    let source = body.source.trim();
    if source.is_empty() {
        return Err(ApiError::BadRequest(
            "source must be provided for moderation list auditability".to_string(),
        ));
    }
    // Admin-direct apply retains the full capability, including lifting blocks.
    let applied = apply_moderation_entries(&state, source, &body.entries, true).await?;

    let peer_ip = addr.ip().to_string();
    security::log_security_event(
        &state,
        "federation.moderation.apply",
        Some(admin.user_id),
        None,
        None,
        Some(&headers),
        Some(peer_ip.as_str()),
        Some(json!({ "source": source, "applied": applied, "entries": body.entries.len() })),
    )
    .await;

    Ok(Json(json!({
        "source": source,
        "applied": applied,
    })))
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpsertModerationSubscriptionRequest {
    pub source_url: String,
    pub source_server: Option<String>,
    pub enabled: Option<bool>,
}

pub async fn upsert_moderation_subscription(
    admin: AdminUser,
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<UpsertModerationSubscriptionRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let source_url = body.source_url.trim();
    if source_url.is_empty() {
        return Err(ApiError::BadRequest("source_url is required".to_string()));
    }
    let parsed = reqwest::Url::parse(source_url)
        .map_err(|_| ApiError::BadRequest("source_url must be a valid URL".to_string()))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(ApiError::BadRequest(
            "source_url must use http or https".to_string(),
        ));
    }
    paracord_federation::client::validate_public_federation_url_with_dns(source_url)
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    let id = paracord_util::snowflake::generate(1);
    let now_ms = chrono::Utc::now().timestamp_millis();
    let normalized_source_server = body
        .source_server
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    paracord_db::federation::upsert_moderation_subscription(
        &state.db,
        id,
        normalized_source_server.as_deref(),
        source_url,
        body.enabled.unwrap_or(true),
        now_ms,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let peer_ip = addr.ip().to_string();
    security::log_security_event(
        &state,
        "federation.moderation.subscription.add",
        Some(admin.user_id),
        None,
        None,
        Some(&headers),
        Some(peer_ip.as_str()),
        Some(json!({
            "id": id.to_string(),
            "source_url": source_url,
            "source_server": normalized_source_server,
            "enabled": body.enabled.unwrap_or(true),
        })),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": id.to_string(),
            "source_url": source_url,
            "source_server": normalized_source_server,
            "enabled": body.enabled.unwrap_or(true),
        })),
    ))
}

pub async fn list_moderation_subscriptions(
    _admin: AdminUser,
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    let subscriptions = paracord_db::federation::list_moderation_subscriptions(&state.db)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!({
        "subscriptions": subscriptions,
    })))
}

pub async fn delete_moderation_subscription(
    admin: AdminUser,
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(subscription_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let removed =
        paracord_db::federation::delete_moderation_subscription_by_id(&state.db, subscription_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let peer_ip = addr.ip().to_string();
    security::log_security_event(
        &state,
        "federation.moderation.subscription.delete",
        Some(admin.user_id),
        None,
        None,
        Some(&headers),
        Some(peer_ip.as_str()),
        Some(json!({ "subscription_id": subscription_id.to_string(), "removed": removed })),
    )
    .await;

    if removed {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

pub async fn list_peer_trust_state(
    _admin: AdminUser,
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    let states = paracord_db::federation::list_peer_trust_states(&state.db)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!({ "states": states })))
}

/// Maximum accepted size of a subscribed moderation-list response body.
///
/// The sync loop runs periodically against admin-configured (but potentially
/// compromised or hostile) sources, so the body must be read with a hard cap
/// rather than buffered unbounded via `response.json()`. 4 MiB comfortably
/// holds a large blocklist while bounding memory growth on the background sync.
const MODERATION_LIST_RESPONSE_BODY_LIMIT: usize = 4 * 1024 * 1024;

/// Read a moderation-list response into JSON with a hard size cap, aborting as
/// soon as the streamed body (or an advertised `Content-Length`) exceeds
/// [`MODERATION_LIST_RESPONSE_BODY_LIMIT`]. Mirrors the bounded readers used by
/// the federated-discovery and tenor fetchers.
async fn read_moderation_list_json_response(
    response: reqwest::Response,
) -> Result<Value, anyhow::Error> {
    use futures_util::TryStreamExt;

    if response.content_length().is_some_and(|len| {
        len > u64::try_from(MODERATION_LIST_RESPONSE_BODY_LIMIT).unwrap_or(u64::MAX)
    }) {
        return Err(anyhow::anyhow!("moderation list response body too large"));
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    loop {
        let chunk = match stream.try_next().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(err) => return Err(anyhow::anyhow!("request failed: {err}")),
        };
        if body.len().saturating_add(chunk.len()) > MODERATION_LIST_RESPONSE_BODY_LIMIT {
            return Err(anyhow::anyhow!("moderation list response body too large"));
        }
        body.extend_from_slice(&chunk);
    }

    serde_json::from_slice(&body)
        .map_err(|err| anyhow::anyhow!("invalid moderation list payload: {err}"))
}

fn parse_remote_mod_entries(payload: &Value) -> Vec<ModerationListEntry> {
    let entries = payload
        .get("entries")
        .and_then(|v| v.as_array())
        .or_else(|| payload.get("servers").and_then(|v| v.as_array()))
        .cloned()
        .unwrap_or_default();
    entries
        .into_iter()
        .filter_map(|entry| serde_json::from_value::<ModerationListEntry>(entry).ok())
        .collect()
}

pub async fn sync_moderation_lists_once(state: &AppState) {
    let subscriptions =
        match paracord_db::federation::list_moderation_subscriptions(&state.db).await {
            Ok(rows) => rows
                .into_iter()
                .filter(|row| row.enabled)
                .collect::<Vec<_>>(),
            Err(_) => return,
        };
    if subscriptions.is_empty() {
        return;
    }

    for subscription in subscriptions {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let source_label = subscription
            .source_server
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| subscription.source_url.clone());

        let result = async {
            // Resolve + validate the source host and pin the connection to the
            // validated address so a low-TTL DNS rebind between validation and
            // connect cannot redirect the fetch to private infrastructure.
            // Revalidate at fetch time so old subscriptions created before SSRF
            // checks cannot keep targeting private infrastructure.
            let http = paracord_federation::client::ssrf_checked_pinned_client_for_url(
                "Paracord-Federation-Moderation/1.0",
                Duration::from_secs(10),
                &subscription.source_url,
            )
            .await
            .map_err(|err| anyhow::anyhow!(err.to_string()))?;
            let response = http
                .get(&subscription.source_url)
                .send()
                .await
                .map_err(|err| anyhow::anyhow!("request failed: {err}"))?;
            if !response.status().is_success() {
                return Err(anyhow::anyhow!(
                    "source returned status {}",
                    response.status()
                ));
            }
            let payload: Value = read_moderation_list_json_response(response).await?;
            let entries = parse_remote_mod_entries(&payload);
            // Remote subscriptions can add blocks/quarantines but must never
            // lift a locally-applied block (allow/unblock is ignored).
            apply_moderation_entries(state, &source_label, &entries, false).await?;
            Ok::<usize, anyhow::Error>(entries.len())
        }
        .await;

        let last_error = result.err().map(|err| err.to_string());
        let _ = paracord_db::federation::update_moderation_subscription_fetch_status(
            &state.db,
            &subscription.source_url,
            now_ms,
            last_error.as_deref(),
            now_ms,
        )
        .await;
    }
}

// ── Federation file sharing ─────────────────────────────────────────────────

fn federation_file_hmac(key: &str, message: &str) -> Result<Vec<u8>, ApiError> {
    use hmac::{Hmac, Mac};
    type HmacSha256 = Hmac<sha2::Sha256>;

    let mut mac = HmacSha256::new_from_slice(key.as_bytes())
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    mac.update(message.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

/// Mint a short-lived (300s) HMAC-authenticated capability token for a single
/// federated attachment download.
///
/// The token records the peer it was minted for as an `audience` component, and
/// the HMAC covers it, so the audience cannot be *rewritten* by a token holder.
///
/// It does NOT, however, make the token non-transferable. [`file_download`] is a
/// plain unsigned `GET`; it matches the audience against the
/// `x-paracord-origin` request header, which anyone can set — and the audience
/// is right there in cleartext inside the token. Anyone who observes the URL
/// (proxy log, referrer, a peer the URL was forwarded to) can therefore replay
/// it by echoing that value back, so long as the named peer is still trusted.
///
/// Treat this as an **unbound bearer capability**: the real mitigations are the
/// 300s lifetime, the trusted-peer check at download time, and keeping the URL
/// secret — never log, cache, or otherwise expose it. Making the binding real
/// requires a verifiable caller identity on the download request (a signed
/// transport, as every other federation endpoint uses).
fn mint_federation_file_token(
    jwt_secret: &str,
    attachment_id: i64,
    audience_server: &str,
) -> (String, i64) {
    let exp = chrono::Utc::now().timestamp() + 300;
    let payload = format!(
        "v2:{}:{}:{}",
        attachment_id,
        exp,
        audience_server.trim().to_ascii_lowercase()
    );
    let mac = federation_file_hmac(jwt_secret, &payload).unwrap_or_default();
    let mac = paracord_federation::hex_encode(&mac);
    let token = format!("{}.{}", payload, mac);
    (token, exp)
}

fn validate_federation_file_token(
    jwt_secret: &str,
    token: &str,
    expected_attachment_id: i64,
    presented_origin: &str,
) -> Result<(), ApiError> {
    let dot_pos = token.rfind('.').ok_or(ApiError::Unauthorized)?;
    let payload = &token[..dot_pos];
    let mac = &token[dot_pos + 1..];

    let presented_mac = paracord_federation::hex_decode(mac).ok_or(ApiError::Unauthorized)?;
    {
        use hmac::{Hmac, Mac};
        type HmacSha256 = Hmac<sha2::Sha256>;

        let mut verifier = HmacSha256::new_from_slice(jwt_secret.as_bytes())
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        verifier.update(payload.as_bytes());
        verifier
            .verify_slice(&presented_mac)
            .map_err(|_| ApiError::Unauthorized)?;
    }

    // `v2:<attachment_id>:<exp>:<audience>` — the only accepted shape. The
    // unbound v1 form (`<attachment_id>:<exp>`) is deliberately not honored:
    // accepting it would leave the peer binding optional and therefore
    // bypassable.
    let parts: Vec<&str> = payload.split(':').collect();
    if parts.len() != 4 || parts[0] != "v2" {
        return Err(ApiError::Unauthorized);
    }
    let attachment_id: i64 = parts[1].parse().map_err(|_| ApiError::Unauthorized)?;
    let exp: i64 = parts[2].parse().map_err(|_| ApiError::Unauthorized)?;
    let audience = parts[3];

    if attachment_id != expected_attachment_id {
        return Err(ApiError::Unauthorized);
    }
    if chrono::Utc::now().timestamp() > exp {
        return Err(ApiError::Unauthorized);
    }
    if !audience.eq_ignore_ascii_case(presented_origin.trim()) {
        return Err(ApiError::Unauthorized);
    }

    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FederationFileTokenRequest {
    pub origin_server: String,
    pub attachment_id: String,
    pub room_id: String,
    pub user_id: String,
}

pub async fn file_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    raw_body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::Forbidden);
    }

    let body: FederationFileTokenRequest = serde_json::from_slice(&raw_body)
        .map_err(|e| ApiError::BadRequest(format!("invalid request body: {e}")))?;
    verify_transport_request(
        &state,
        &service,
        &headers,
        "POST",
        "/_paracord/federation/v1/file/token",
        &raw_body,
        Some(body.origin_server.as_str()),
        true,
    )
    .await?;

    let identity = FederatedIdentity::parse(&body.user_id)
        .ok_or(ApiError::BadRequest("Invalid user_id".to_string()))?;
    ensure_identity_matches_origin_or_alias(&state, &identity, &body.origin_server).await?;
    let local_user_id = ensure_remote_user_mapping(&state, &identity).await?;

    let attachment_id: i64 = body
        .attachment_id
        .parse()
        .map_err(|_| ApiError::BadRequest("Invalid attachment_id".to_string()))?;
    let attachment = paracord_db::attachments::get_attachment(&state.db, attachment_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    // Attachment must be linked to a message
    let _message_id = attachment.message_id.ok_or(ApiError::NotFound)?;

    let channel_id = attachment.upload_channel_id.ok_or(ApiError::NotFound)?;
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let guild_id = channel.guild_id().ok_or(ApiError::BadRequest(
        "File token requires guild channel".to_string(),
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
    paracord_core::permissions::require_permission(perms, Permissions::READ_MESSAGE_HISTORY)?;

    let (token, _exp) =
        mint_federation_file_token(&state.config.jwt_secret, attachment_id, &body.origin_server);
    let download_url = format!(
        "/_paracord/federation/v1/file/{}?token={}",
        attachment_id, token
    );

    Ok(Json(json!({
        "token": token,
        "download_url": download_url,
        "expires_in_seconds": 300,
    })))
}

#[derive(Debug, Clone, Deserialize)]
pub struct FileDownloadQuery {
    pub token: String,
}

pub async fn file_download(
    State(state): State<AppState>,
    Path(attachment_id): Path<i64>,
    Query(query): Query<FileDownloadQuery>,
    headers: HeaderMap,
) -> Result<impl axum::response::IntoResponse, ApiError> {
    // This endpoint used to serve any holder of the query-string token with
    // federation switched off entirely. Gate it on the service being enabled and
    // on the presented origin matching the audience the token was minted for.
    // NOTE: the origin header is unsigned and the audience is cleartext inside
    // the token, so this narrows *who the token was issued to*, not *who is
    // presenting it* — see [`mint_federation_file_token`].
    let service = federation_service_from_state(&state);
    if !service.is_enabled() {
        return Err(ApiError::NotFound);
    }

    let presented_origin = headers
        .get("x-paracord-origin")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(ApiError::Unauthorized)?;
    validate_federation_file_token(
        &state.config.jwt_secret,
        &query.token,
        attachment_id,
        presented_origin,
    )?;
    // The audience match above proves the token was minted for the named peer;
    // this additionally refuses a peer that has since been blocked/quarantined or
    // untrusted, so a live 5-minute token cannot outlive a block.
    let now_ms = chrono::Utc::now().timestamp_millis();
    if !is_peer_trusted(&state, presented_origin, now_ms).await? {
        return Err(ApiError::Forbidden);
    }

    let attachment = paracord_db::attachments::get_attachment(&state.db, attachment_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let ext = std::path::Path::new(&attachment.filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let storage_key = format!("attachments/{}.{}", attachment.id, ext);
    let stored_data = state
        .storage_backend
        .retrieve(&storage_key)
        .await
        .map_err(|_| ApiError::NotFound)?;
    let data = if let Some(cryptor) = state.config.file_cryptor.as_ref() {
        let aad = format!("attachment:{}", attachment.id);
        cryptor
            .decrypt_with_aad(&stored_data, aad.as_bytes())
            .map_err(|err| ApiError::Internal(anyhow::anyhow!(err.to_string())))?
    } else {
        stored_data
    };

    let content_type = attachment
        .content_type
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let disposition = crate::routes::files::build_content_disposition(&attachment.filename, false);

    Ok((
        crate::routes::files::download_response_headers(&content_type, &disposition),
        data,
    ))
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
    fn federation_guild_allowlist_accepts_explicit_wildcard() {
        let _guard = env_lock().lock().expect("env lock");
        std::env::set_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS", "*");
        assert!(ensure_federation_guild_allowed(99).is_ok());
        std::env::remove_var("PARACORD_FEDERATION_ALLOWED_GUILD_IDS");
    }

    #[test]
    fn mapping_namespace_trusts_room_domain_and_falls_back_to_origin() {
        // L08-02: the mapping namespace is derived from the DOMAIN embedded in the
        // peer-supplied room_id. A trusted origin can therefore name a FOREIGN
        // namespace (e.g. origin B naming A's domain), which is precisely why the
        // ingest guard binds origin_server to the room namespace / participation.
        assert_eq!(
            mapping_namespace_from_room("!42:a.example", "b.example"),
            "a.example"
        );
        // Unparseable room ids fall back to the verified origin, so no cross-origin
        // namespace is reachable in that case.
        assert_eq!(
            mapping_namespace_from_room("not-a-room", "b.example"),
            "b.example"
        );
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
        let ok = Value::Array((0..5_000).map(|idx| Value::Number(idx.into())).collect());
        assert!(validate_federation_content(&ok).is_ok());
    }
}
