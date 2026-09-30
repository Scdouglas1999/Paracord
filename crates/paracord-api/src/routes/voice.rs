use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use paracord_contracts::voice as wire;
use paracord_core::AppState;
use paracord_federation::client::{FederationMediaRelayRequest, FederationMediaTokenRequest};
use paracord_models::permissions::Permissions;
use paracord_models::voice::VoiceMode;
use paracord_relay::participant::{MediaParticipant, ViewKind, ViewTarget};
use paracord_relay::room::RoomError;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::ApiError;
use crate::middleware::AuthUser;

/// A voice route's refusal: an ordinary [`ApiError`], or one with its own
/// machine-readable code that `ApiError` has no variant for. The body has the
/// same shape as every other API error (`code`, `message`, `error`,
/// `details`).
#[derive(Debug)]
pub enum VoiceRouteError {
    Api(ApiError),
    /// 403 `LISTEN_IN_DISABLED`: this voice channel does not admit listeners
    /// (its `listen_in_enabled` feature setting is off). Join it instead.
    ListenInDisabled,
}

impl VoiceRouteError {
    /// The closest plain [`ApiError`], for callers whose signature cannot carry
    /// the code (the legacy `voice_v2` wrappers).
    pub fn into_api_error(self) -> ApiError {
        match self {
            Self::Api(error) => error,
            Self::ListenInDisabled => ApiError::Forbidden,
        }
    }
}

impl From<ApiError> for VoiceRouteError {
    fn from(error: ApiError) -> Self {
        Self::Api(error)
    }
}

impl From<paracord_core::error::CoreError> for VoiceRouteError {
    fn from(error: paracord_core::error::CoreError) -> Self {
        Self::Api(error.into())
    }
}

impl From<paracord_db::DbError> for VoiceRouteError {
    fn from(error: paracord_db::DbError) -> Self {
        Self::Api(error.into())
    }
}

impl IntoResponse for VoiceRouteError {
    fn into_response(self) -> Response {
        match self {
            Self::Api(error) => error.into_response(),
            Self::ListenInDisabled => {
                let message = "Listening in is turned off for this channel";
                (
                    StatusCode::FORBIDDEN,
                    Json(json!({
                        "code": "LISTEN_IN_DISABLED",
                        "message": message,
                        "error": message,
                        "details": Value::Null,
                    })),
                )
                    .into_response()
            }
        }
    }
}

/// Parse the `mode` a join asks for. Absent is a full membership; anything
/// other than `joined` or `listen` is refused, never guessed.
fn parse_join_mode(raw: Option<&str>) -> Result<VoiceMode, ApiError> {
    match raw {
        None => Ok(VoiceMode::Joined),
        Some(value) => VoiceMode::parse(value)
            .ok_or_else(|| ApiError::BadRequest("mode must be \"joined\" or \"listen\"".into())),
    }
}

fn mode_from_wire(mode: wire::VoiceMode) -> VoiceMode {
    match mode {
        wire::VoiceMode::Joined => VoiceMode::Joined,
        wire::VoiceMode::Listen => VoiceMode::Listen,
    }
}

fn mode_to_wire(mode: VoiceMode) -> wire::VoiceMode {
    match mode {
        VoiceMode::Joined => wire::VoiceMode::Joined,
        VoiceMode::Listen => wire::VoiceMode::Listen,
    }
}

/// Listening in is a voice-channel feature (a stage's audience already
/// receives without sending) that each channel can turn off.
async fn ensure_listen_in_allowed(
    state: &AppState,
    channel: &paracord_db::channels::ChannelRow,
) -> Result<(), VoiceRouteError> {
    if channel.channel_type != 2 {
        return Err(ApiError::BadRequest("Listening in is only for voice channels".into()).into());
    }
    if !paracord_db::channel_features::listen_in_enabled(&state.db, channel.id).await? {
        return Err(VoiceRouteError::ListenInDisabled);
    }
    Ok(())
}

/// The wire form of a stream start time (RFC 3339), or null.
fn stream_started_at_wire(value: Option<chrono::DateTime<chrono::Utc>>) -> Value {
    value.map_or(Value::Null, |value| Value::String(value.to_rfc3339()))
}

/// A `VOICE_STATE_UPDATE` for a member who is in `row.channel_id`, built from
/// the stored row so every field (mode, stream start time, flags) is the one
/// the database holds.
pub(crate) fn voice_state_payload(
    row: &paracord_db::voice_states::VoiceStateRow,
    user: Option<&paracord_db::users::UserRow>,
) -> Value {
    json!({
        "user_id": row.user_id.to_string(),
        "channel_id": row.channel_id.to_string(),
        "guild_id": row.guild_id().map(|id| id.to_string()),
        "session_id": &row.session_id,
        "self_mute": row.self_mute,
        "self_deaf": row.self_deaf,
        "self_stream": row.self_stream,
        "self_video": row.self_video,
        "suppress": row.suppress,
        "request_to_speak_at": row.request_to_speak_at.map(|value| value.to_rfc3339()),
        "mute": false,
        "deaf": false,
        "mode": row.mode.as_str(),
        "self_stream_started_at": stream_started_at_wire(row.self_stream_started_at),
        "username": user.map(|u| u.username.as_str()),
        "avatar_hash": user.and_then(|u| u.avatar_hash.as_deref()),
    })
}

pub fn livekit_url_candidates_pub(headers: &HeaderMap, fallback: &str) -> Vec<String> {
    livekit_url_candidates(headers, fallback)
}

fn first_forwarded_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|raw| raw.split(',').next())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
}

fn is_frontend_dev_proxy_host(host: &str) -> bool {
    host.rsplit_once(':')
        .map(|(_, port)| matches!(port, "1420" | "5173"))
        .unwrap_or(false)
}

fn env_bool(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|raw| {
            matches!(
                raw.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn env_trimmed(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
}

fn should_use_configured_livekit_url(fallback: &str) -> bool {
    if env_bool("PARACORD_FORCE_LIVEKIT_PUBLIC_URL") {
        return true;
    }
    // If the configured public URL is not using the reverse-proxy path,
    // treat it as an explicit direct LiveKit endpoint and preserve it.
    if let Ok(parsed) = url::Url::parse(fallback) {
        let path = parsed.path().trim_end_matches('/');
        return !path.is_empty() && path != "/livekit";
    }
    false
}

fn resolve_livekit_client_url(headers: &HeaderMap, fallback: &str) -> String {
    if should_use_configured_livekit_url(fallback) {
        return fallback.to_string();
    }

    let host = first_forwarded_value(headers, "x-forwarded-host")
        .or_else(|| first_forwarded_value(headers, "host"));
    let forwarded_proto = first_forwarded_value(headers, "x-forwarded-proto")
        .or_else(|| first_forwarded_value(headers, "x-forwarded-scheme"))
        .or_else(|| first_forwarded_value(headers, "x-forwarded-protocol"));

    if let Some(host) = host {
        // When requests are proxied through a frontend dev server (for example
        // localhost:1420/5173), the host points to Vite instead of the real
        // backend. Returning that host here can route LiveKit signaling through
        // the wrong proxy target and break voice. In that case, keep the server
        // configured fallback URL.
        if is_frontend_dev_proxy_host(&host) {
            return fallback.to_string();
        }

        let ws_scheme = if matches!(forwarded_proto.as_deref(), Some("https") | Some("wss")) {
            "wss"
        } else {
            "ws"
        };
        return format!("{ws_scheme}://{host}/livekit");
    }

    fallback.to_string()
}

fn push_unique_url(candidates: &mut Vec<String>, raw: String) {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return;
    }
    if candidates.iter().any(|existing| existing == trimmed) {
        return;
    }
    candidates.push(trimmed.to_string());
}

/// Build the browser-facing native media endpoint plus its ordered candidate
/// list. The optional LAN candidate is preferred (avoids hairpin NAT), followed
/// by the Host-derived endpoint. Shared by guild and DM voice joins so both
/// return the identical native contract.
pub fn native_media_endpoints(headers: &HeaderMap, media_port: u16) -> (String, Vec<String>) {
    let host = first_forwarded_value(headers, "x-forwarded-host")
        .or_else(|| first_forwarded_value(headers, "host"))
        .unwrap_or_else(|| format!("localhost:{}", media_port));
    let host_no_port = host.split(':').next().unwrap_or(&host);
    // Browser clients connect via WebTransport (HTTPS/HTTP3) on the unified
    // media port (same UDP port as raw QUIC, ALPN-routed).
    let media_endpoint = format!("https://{}:{}/media", host_no_port, media_port);

    let mut candidates: Vec<String> = Vec::new();
    if let Some(local) = env_trimmed("PARACORD_NATIVE_MEDIA_LOCAL_CANDIDATE") {
        push_unique_url(&mut candidates, local);
    }
    push_unique_url(&mut candidates, media_endpoint.clone());
    (media_endpoint, candidates)
}

/// Forcibly evict a user from every voice/media session in a guild.
///
/// Called from the moderation paths (kick/ban) and self-leave so that removing
/// a member also terminates any in-progress native voice/video (or LiveKit)
/// call they are part of. Without this, authorization for a live native-media
/// connection is only checked at connection establishment, so a kicked/banned
/// participant would keep receiving every other participant's audio/video and
/// keep publishing their own until they voluntarily disconnect. It also deletes
/// the persisted `voice_state`, which is what re-authorizes a fresh QUIC /
/// WebTransport media connection — so a removed member cannot simply reconnect
/// within their media token's lifetime.
///
/// Best-effort and idempotent: safe when native media is disabled or the user
/// is not currently in any call.
pub async fn evict_user_from_guild_media(state: &AppState, guild_id: i64, user_id: i64) {
    let _membership = state.voice.lock_membership(user_id).await;
    // Snapshot the channels the user currently occupies in this guild *before*
    // deleting their voice state, so we can evict them from the matching media
    // rooms and refresh other clients' UIs.
    let channels: Vec<i64> =
        match paracord_db::voice_states::get_all_user_voice_states(&state.db, user_id).await {
            Ok(states) => states
                .into_iter()
                .filter(|s| s.guild_id() == Some(guild_id))
                .map(|s| s.channel_id)
                .collect(),
            Err(_) => Vec::new(),
        };

    // Drop the persisted voice state so any still-valid media token cannot be
    // re-authorized against a stale voice_state row on reconnect (fail closed).
    let _ = paracord_db::voice_states::remove_voice_state(&state.db, user_id, Some(guild_id)).await;

    // Tear down LiveKit in-memory membership for each channel (best-effort).
    for channel_id in &channels {
        let _ = state.voice.leave_room(*channel_id, user_id).await;
    }

    if let Some(native_media) = state.native_media.as_ref() {
        // Remove the user from each native media room in this guild.
        for channel_id in &channels {
            let _ = native_media
                .rooms
                .leave_room(guild_id, *channel_id, user_id);
        }
        // A view session in this guild ends too (it has no voice state, so
        // the snapshot above does not name it). The watcher-count listener
        // announces the change.
        native_media.rooms.end_view_in_guild(user_id, guild_id);
        // Actively close the live QUIC/WebTransport media connection so the
        // removed member immediately stops receiving and can no longer inject
        // media, regardless of which channel it was bound to.
        native_media.relay_forwarder.disconnect_user(user_id);
    }

    if channels.is_empty() {
        return;
    }

    // Notify remaining members that the user left voice so their UIs update.
    //
    // One event per departed channel, each carrying `prior_channel_id`: a leave
    // has a null `channel_id`, so that is the only field the gateway's
    // per-channel VIEW_CHANNEL filter can key on
    // (`extract_channel_id_from_event`). Without it the leave fans out
    // guild-wide and discloses presence in a hidden voice channel that the
    // matching join was correctly filtered out of.
    for channel_id in &channels {
        state.event_bus.dispatch(
            "VOICE_STATE_UPDATE",
            json!({
                "user_id": user_id.to_string(),
                "channel_id": null,
                "prior_channel_id": channel_id.to_string(),
                "guild_id": guild_id.to_string(),
                "self_mute": false,
                "self_deaf": false,
                "self_stream": false,
                "self_video": false,
                "suppress": false,
                "mute": false,
                "deaf": false,
            }),
            Some(guild_id),
        );
    }
}

fn livekit_url_candidates(headers: &HeaderMap, fallback: &str) -> Vec<String> {
    let mut candidates = Vec::new();

    // Optional direct endpoint override, useful to bypass /livekit proxy for
    // diagnostics or deployment topologies that expose LiveKit separately.
    if let Some(direct) = env_trimmed("PARACORD_LIVEKIT_DIRECT_PUBLIC_URL") {
        push_unique_url(&mut candidates, direct);
    }

    // Optional LAN candidate injected by the server process. Useful when
    // clients are on the same network and the public WAN URL requires
    // hairpin NAT that may be unstable or unsupported.
    if let Some(local_candidate) = env_trimmed("PARACORD_LIVEKIT_LOCAL_CANDIDATE_URL") {
        push_unique_url(&mut candidates, local_candidate);
    }

    push_unique_url(
        &mut candidates,
        resolve_livekit_client_url(headers, fallback),
    );
    push_unique_url(&mut candidates, fallback.to_string());

    candidates
}

#[derive(Deserialize)]
struct LiveKitWebhookAuthClaims {
    _iss: Option<String>,
    sha256: Option<String>,
}

fn verify_livekit_webhook_auth(
    headers: &HeaderMap,
    body: &[u8],
    livekit_api_key: &str,
    livekit_api_secret: &str,
) -> Result<(), ApiError> {
    let auth_header = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;
    let token = auth_header
        .strip_prefix("Bearer ")
        .ok_or(ApiError::Unauthorized)?;

    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;
    validation.required_spec_claims =
        std::collections::HashSet::from([String::from("exp"), String::from("iss")]);
    validation.set_issuer(&[livekit_api_key]);

    let decoded = decode::<LiveKitWebhookAuthClaims>(
        token,
        &DecodingKey::from_secret(livekit_api_secret.as_bytes()),
        &validation,
    )
    .map_err(|_| ApiError::Unauthorized)?;

    // Body-hash binding is mandatory: a webhook token that omits the sha256
    // claim cannot be tied to a specific payload, so a captured token could be
    // replayed against a forged body. Reject any token missing the claim.
    let expected_hash = decoded
        .claims
        .sha256
        .as_deref()
        .ok_or(ApiError::Unauthorized)?;
    let mut hasher = Sha256::new();
    hasher.update(body);
    let digest = hasher.finalize();
    let actual_hash = digest
        .iter()
        .fold(String::with_capacity(64), |mut out, byte| {
            use std::fmt::Write;
            let _ = write!(out, "{:02x}", byte);
            out
        });
    if actual_hash != expected_hash {
        return Err(ApiError::Unauthorized);
    }

    Ok(())
}

#[derive(Deserialize, Default)]
pub struct VoiceJoinQuery {
    pub fallback: Option<String>,
    pub session_id: Option<String>,
    /// `joined` (default) or `listen` (receive only, shown as listening in).
    /// Read by the join routes only.
    pub mode: Option<String>,
}

#[derive(Deserialize, Default)]
pub struct VoiceLeaveQuery {
    pub session_id: Option<String>,
}

#[derive(Deserialize)]
pub struct StartStreamRequest {
    pub title: Option<String>,
    pub quality_preset: Option<String>,
}

#[derive(Deserialize)]
pub struct LiveKitWebhookPayload {
    pub event: String,
    pub room: Option<LiveKitRoom>,
    pub participant: Option<LiveKitParticipant>,
}

#[derive(Deserialize)]
pub struct LiveKitRoom {
    pub name: String,
}

#[derive(Deserialize)]
pub struct LiveKitParticipant {
    pub identity: String,
    pub metadata: Option<String>,
}

/// Commit durable native membership before discarding a previous room. On a
/// failed room admission/DB commit the old DB row and participant survive.
pub(crate) async fn commit_native_membership(
    state: &AppState,
    user_id: i64,
    guild_id: Option<i64>,
    channel_id: i64,
    session_id: &str,
    suppress: bool,
    can_publish: bool,
) -> Result<(), ApiError> {
    commit_native_membership_with_mode(
        state,
        user_id,
        guild_id,
        channel_id,
        session_id,
        suppress,
        can_publish,
        VoiceMode::Joined,
    )
    .await
}

/// [`commit_native_membership`] for a given [`VoiceMode`]. A listener's relay
/// membership is receive-only (`can_publish` must be false for `listen`).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn commit_native_membership_with_mode(
    state: &AppState,
    user_id: i64,
    guild_id: Option<i64>,
    channel_id: i64,
    session_id: &str,
    suppress: bool,
    can_publish: bool,
    mode: VoiceMode,
) -> Result<(), ApiError> {
    debug_assert!(!(mode.is_listen() && can_publish));
    let transaction = paracord_db::voice_states::begin_voice_state_transition_with_mode(
        &state.db, user_id, guild_id, channel_id, session_id, suppress, mode,
    )
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    let native = state.native_media.as_ref();
    let previous = native
        .and_then(|native| {
            native
                .rooms
                .get_room_by_channel(guild_id.unwrap_or(0), channel_id)
        })
        .and_then(|room| room.participants.get(&user_id).cloned());
    if let Some(native) = native {
        native
            .rooms
            .join_room(
                guild_id.unwrap_or(0),
                channel_id,
                MediaParticipant::new(user_id, session_id.to_owned()).with_can_publish(can_publish),
            )
            .map_err(|error| match error {
                paracord_relay::room::RoomError::RoomFull(_) => {
                    ApiError::BadRequest("Voice channel is full".into())
                }
                other => ApiError::Internal(other.into()),
            })?;
    }
    if let Err(error) = transaction.commit().await {
        if let Some(native) = native {
            native.rooms.restore_participant_if_session(
                guild_id.unwrap_or(0),
                channel_id,
                user_id,
                session_id,
                previous,
            );
        }
        return Err(ApiError::Internal(error.into()));
    }
    Ok(())
}

pub(crate) async fn release_previous_memberships(
    state: &AppState,
    user_id: i64,
    previous: &[paracord_db::voice_states::VoiceStateRow],
) {
    for membership in previous {
        state
            .voice
            .leave_room_if_session(membership.channel_id, user_id, Some(&membership.session_id))
            .await;
        if let Some(native) = state.native_media.as_ref() {
            native.rooms.leave_room_if_session(
                membership.guild_id().unwrap_or(0),
                membership.channel_id,
                user_id,
                Some(&membership.session_id),
            );
        }
    }
    // LiveKit empty_timeout owns empty-room removal. A delayed DeleteRoom can
    // otherwise remove a new call that reused this room name.
}

/// Join a voice channel (`GET /api/v1/voice/{id}/join`,
/// `POST /api/v2/voice/{id}/join`), as a full member or, with `?mode=listen`,
/// listening in: receive only, never sends, and shown to everyone as
/// listening in. A listen join answers 403 `LISTEN_IN_DISABLED` when the
/// channel has turned listening in off.
pub async fn join_voice_with_mode(
    State(state): State<AppState>,
    auth: AuthUser,
    headers: HeaderMap,
    Path(channel_id): Path<i64>,
    Query(query): Query<VoiceJoinQuery>,
) -> Result<Json<Value>, VoiceRouteError> {
    join_voice_inner(state, auth, headers, channel_id, query).await
}

/// `POST /api/v2/voice/recover`: rejoin after a media failure. The mode is
/// whatever `?mode=` says (absent is a full membership), exactly as a join.
pub async fn recover_voice_with_mode(
    State(state): State<AppState>,
    auth: AuthUser,
    headers: HeaderMap,
    Query(query): Query<VoiceJoinQuery>,
    Json(req): Json<super::voice_v2::VoiceRecoverRequest>,
) -> Result<Json<Value>, VoiceRouteError> {
    join_voice_inner(state, auth, headers, req.channel_id, query).await
}

/// The join as an [`ApiError`]-typed handler, for callers that cannot carry
/// [`VoiceRouteError`]'s code (a refused listen join becomes a plain 403).
pub async fn join_voice(
    State(state): State<AppState>,
    auth: AuthUser,
    headers: HeaderMap,
    Path(channel_id): Path<i64>,
    Query(query): Query<VoiceJoinQuery>,
) -> Result<Json<Value>, ApiError> {
    join_voice_inner(state, auth, headers, channel_id, query)
        .await
        .map_err(VoiceRouteError::into_api_error)
}

async fn join_voice_inner(
    state: AppState,
    auth: AuthUser,
    headers: HeaderMap,
    channel_id: i64,
    query: VoiceJoinQuery,
) -> Result<Json<Value>, VoiceRouteError> {
    let mode = parse_join_mode(query.mode.as_deref())?;
    let _membership = state.voice.lock_membership(auth.user_id).await;
    if !state.config.livekit_available
        && !state.config.native_media_enabled
        && !paracord_federation::is_enabled()
    {
        return Err(
            ApiError::ServiceUnavailable("Voice is not available on this server".into()).into(),
        );
    }

    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if channel.channel_type != 2 && channel.channel_type != 13 {
        return Err(ApiError::BadRequest("Not a voice channel".into()).into());
    }

    let guild_id = channel.guild_id().ok_or(ApiError::BadRequest(
        "Voice is only supported in guild channels".into(),
    ))?;
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let perms = paracord_core::permissions::compute_channel_permissions(
        &state.db,
        guild_id,
        channel_id,
        guild.owner_id,
        auth.user_id,
    )
    .await?;
    paracord_core::permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;
    paracord_core::permissions::require_permission(perms, Permissions::CONNECT)?;
    // Checked after the permissions, so the channel's settings are never
    // revealed to someone who may not see or enter it.
    if mode.is_listen() {
        ensure_listen_in_allowed(&state, &channel).await?;
    }
    // SPEAK gates whether the issued media credential may publish audio/video.
    // A member with CONNECT but denied SPEAK (e.g. a listen-only / muted role)
    // joins as a subscriber only. Applied to both the LiveKit token grant and
    // the native-media participant below.
    let can_speak = perms.contains(Permissions::SPEAK);
    let is_stage = channel.channel_type == 13;
    if is_stage {
        paracord_db::stage_instances::get_stage_instance_by_channel(&state.db, channel_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or_else(|| ApiError::BadRequest("This stage is not live".into()))?;
    }
    // Stage moderators enter on stage. Everyone else enters as an audience
    // member and receives a subscriber-only media credential until promoted.
    let stage_moderator = is_stage && can_speak && perms.contains(Permissions::MANAGE_CHANNELS);
    let suppress = is_stage && !stage_moderator;
    // A listener never sends, whatever its permissions.
    let can_publish = can_speak && !suppress && !mode.is_listen();

    // Enforce user_limit: count current participants; 0 means unlimited.
    if let Some(limit) = channel.user_limit {
        if limit > 0 {
            let participants = state.voice.get_room_participants(channel_id).await;
            // The joining user may already be tracked (re-join); don't count them twice.
            let already_in = participants.iter().any(|p| p.user_id == auth.user_id);
            let effective_count = if already_in {
                participants.len()
            } else {
                participants.len() + 1
            };
            if effective_count > limit as usize {
                return Err(ApiError::BadRequest("Voice channel is full".into()).into());
            }
        }
    }

    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let previous_memberships =
        paracord_db::voice_states::get_all_user_voice_states(&state.db, auth.user_id)
            .await
            .map_err(|error| ApiError::Internal(error.into()))?;

    let federation_service = crate::routes::federation::build_federation_service();
    if federation_service.is_enabled() {
        let outbound = crate::routes::federation::resolve_outbound_context(
            &state,
            &federation_service,
            guild_id,
            Some(channel_id),
        )
        .await;
        if outbound.uses_remote_mapping && mode.is_listen() {
            // The remote server issues the media credential and would not know
            // to make it receive-only; refuse rather than hand out a
            // publishing membership that is labeled as listening.
            return Err(ApiError::Conflict(
                "Listening in is not available for a channel hosted on another server".into(),
            )
            .into());
        }
        if outbound.uses_remote_mapping {
            if let (Some(remote_channel_id), Some(peer), Some(client), Some(local_identity)) = (
                outbound.payload_channel_id.clone(),
                crate::routes::federation::resolve_remote_target_for_outbound_context(
                    &state, &outbound,
                )
                .await,
                crate::routes::federation::build_signed_federation_client(&federation_service),
                crate::routes::federation::local_federated_user_id(
                    &state,
                    &federation_service,
                    auth.user_id,
                )
                .await,
            ) {
                let payload = FederationMediaTokenRequest {
                    origin_server: federation_service.server_name().to_string(),
                    channel_id: remote_channel_id,
                    user_id: local_identity,
                };
                let target = paracord_federation::client::FederationTarget::new(
                    &peer.federation_endpoint,
                    &peer.server_name,
                );
                match client.request_media_token(target, &payload).await {
                    Ok(remote) => {
                        paracord_db::voice_states::begin_voice_state_transition(
                            &state.db,
                            auth.user_id,
                            channel.guild_id(),
                            channel_id,
                            &remote.session_id,
                            suppress,
                        )
                        .await
                        .map_err(|error| ApiError::Internal(error.into()))?
                        .commit()
                        .await
                        .map_err(|error| ApiError::Internal(error.into()))?;
                        release_previous_memberships(&state, auth.user_id, &previous_memberships)
                            .await;
                        state.event_bus.dispatch(
                            "VOICE_STATE_UPDATE",
                            json!({
                                "user_id": auth.user_id.to_string(),
                                "channel_id": channel_id.to_string(),
                                "guild_id": channel.guild_id().map(|id| id.to_string()),
                                "session_id": remote.session_id,
                                "self_mute": false,
                                "self_deaf": false,
                                "self_stream": false,
                                "self_video": false,
                                "suppress": suppress,
                                "request_to_speak_at": Value::Null,
                                "mute": false,
                                "deaf": false,
                                "mode": VoiceMode::Joined.as_str(),
                                "self_stream_started_at": Value::Null,
                                "username": &user.username,
                                "avatar_hash": user.avatar_hash,
                            }),
                            channel.guild_id(),
                        );
                        tracing::info!(
                            "Federated voice join issued for user={} channel={} via {}",
                            auth.user_id,
                            channel_id,
                            peer.server_name
                        );
                        let mut url_candidates = Vec::new();
                        push_unique_url(&mut url_candidates, remote.url.clone());
                        for candidate in
                            livekit_url_candidates(&headers, &state.config.livekit_public_url)
                        {
                            push_unique_url(&mut url_candidates, candidate);
                        }
                        let livekit_url = url_candidates
                            .first()
                            .cloned()
                            .unwrap_or_else(|| state.config.livekit_public_url.clone());
                        return Ok(Json(json!({
                            "token": remote.token,
                            "url": livekit_url,
                            "url_candidates": url_candidates,
                            "room_name": remote.room_name,
                            "session_id": remote.session_id,
                            "suppress": suppress,
                            "mode": VoiceMode::Joined.as_str(),
                        })));
                    }
                    Err(err) => {
                        tracing::warn!(
                            "federation: media token rpc failed for channel {} -> {} ({}): {}",
                            channel_id,
                            peer.server_name,
                            peer.domain,
                            err
                        );
                    }
                }
            } else {
                tracing::warn!(
                    "federation: mirrored voice channel {} missing remote mapping/client/identity; falling back local",
                    channel_id
                );
            }
        }
    }

    // ── Native media path ──────────────────────────────────────────────
    // When native media is enabled, use it by default unless the client
    // explicitly requests LiveKit as a fallback (after a native failure).
    let requesting_livekit_fallback = query.fallback.as_deref() == Some("livekit");
    if state.config.native_media_enabled && !requesting_livekit_fallback {
        let session_id = uuid::Uuid::new_v4().to_string();
        commit_native_membership_with_mode(
            &state,
            auth.user_id,
            channel.guild_id(),
            channel_id,
            &session_id,
            suppress,
            can_publish,
            mode,
        )
        .await?;
        release_previous_memberships(&state, auth.user_id, &previous_memberships).await;

        state.event_bus.dispatch(
            "VOICE_STATE_UPDATE",
            json!({
                "user_id": auth.user_id.to_string(),
                "channel_id": channel_id.to_string(),
                "guild_id": channel.guild_id().map(|id| id.to_string()),
                "session_id": &session_id,
                "self_mute": false,
                "self_deaf": false,
                "self_stream": false,
                "self_video": false,
                "suppress": suppress,
                "request_to_speak_at": Value::Null,
                "mute": false,
                "deaf": false,
                "mode": mode.as_str(),
                "self_stream_started_at": Value::Null,
                "username": &user.username,
                "avatar_hash": user.avatar_hash,
            }),
            channel.guild_id(),
        );

        let (media_endpoint, media_endpoint_candidates) =
            native_media_endpoints(&headers, state.config.native_media_port);

        let room_name = format!("{}:{}", guild_id, channel_id);

        let issued_at = chrono::Utc::now().timestamp();
        let media_claims = json!({
            // A snowflake is past 2^53, so it crosses the wire as a string:
            // `JSON.parse` on a bare number silently rounds it, and the browser
            // engine compares this `sub` against the participant ids the media
            // control plane sends. A rounded one made the client treat its own
            // seat in the room as somebody else's. `MediaClaims` and the
            // WebTransport auth path both read either shape.
            "sub": auth.user_id.to_string(),
            // Keep canonical claim names used by the transport layer.
            "sid": &session_id,
            "auth_sid": auth.session_id.as_deref(),
            "iat": issued_at,
            "exp": issued_at + 86400,
            // Extra claims are tolerated by serde and help with diagnostics.
            "session_id": &session_id,
            "auth_session_id": auth.session_id.as_deref(),
            "room": &room_name,
        });
        let media_token = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(Algorithm::HS256),
            &media_claims,
            &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
        )
        .unwrap_or_default();

        // Include the cert hash so browsers can trust self-signed certs
        let cert_hash = state.native_media.as_ref().map(|nm| nm.cert_hash.get());

        tracing::info!(
            "Native media voice join issued for user={} channel={}",
            auth.user_id,
            channel_id
        );

        return Ok(Json(json!({
            "native_media": true,
            "media_endpoint": media_endpoint,
            "media_endpoint_candidates": media_endpoint_candidates,
            "media_token": media_token,
            "cert_hash": cert_hash,
            "room_name": room_name,
            "session_id": session_id,
            "suppress": suppress,
            "mode": mode.as_str(),
            "livekit_available": state.config.livekit_available,
        })));
    }

    if !state.config.livekit_available {
        return Err(ApiError::ServiceUnavailable(
            "LiveKit voice is not available on this server".into(),
        )
        .into());
    }

    let session_id = uuid::Uuid::new_v4().to_string();

    let join_resp = state
        .voice
        .prepare_channel_join(
            channel_id,
            guild_id,
            auth.user_id,
            &user.username,
            &session_id,
            can_publish,
            paracord_media::AudioBitrate::default(),
        )
        .await
        .map_err(ApiError::Internal)?;

    paracord_db::voice_states::begin_voice_state_transition_with_mode(
        &state.db,
        auth.user_id,
        channel.guild_id(),
        channel_id,
        &session_id,
        suppress,
        mode,
    )
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .commit()
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    state.voice.install_channel_participant(
        channel_id,
        guild_id,
        auth.user_id,
        &session_id,
        paracord_media::AudioBitrate::default(),
    );
    release_previous_memberships(&state, auth.user_id, &previous_memberships).await;

    state.event_bus.dispatch(
        "VOICE_STATE_UPDATE",
        json!({
            "user_id": auth.user_id.to_string(),
            "channel_id": channel_id.to_string(),
            "guild_id": channel.guild_id().map(|id| id.to_string()),
            "session_id": &session_id,
            "self_mute": false,
            "self_deaf": false,
            "self_stream": false,
            "self_video": false,
            "suppress": suppress,
            "request_to_speak_at": Value::Null,
            "mute": false,
            "deaf": false,
            "mode": mode.as_str(),
            "self_stream_started_at": Value::Null,
            "username": &user.username,
            "avatar_hash": user.avatar_hash,
        }),
        channel.guild_id(),
    );

    let url_candidates = livekit_url_candidates(&headers, &state.config.livekit_public_url);
    let livekit_url = url_candidates
        .first()
        .cloned()
        .unwrap_or_else(|| resolve_livekit_client_url(&headers, &state.config.livekit_public_url));
    tracing::info!(
        "Voice join issued for user={} channel={}",
        auth.user_id,
        channel_id
    );

    Ok(Json(json!({
        "token": join_resp.token,
        "url": livekit_url,
        "url_candidates": url_candidates,
        "room_name": join_resp.room_name,
        "session_id": session_id,
        "suppress": suppress,
        "mode": mode.as_str(),
    })))
}

async fn require_stream_receipt(
    state: &AppState,
    user_id: i64,
    guild_id: Option<i64>,
    channel_id: i64,
    expected: Option<&str>,
) -> Result<(), ApiError> {
    if let Some(expected) = expected {
        let current =
            paracord_db::voice_states::get_user_voice_session(&state.db, user_id, guild_id)
                .await
                .map_err(|error| ApiError::Internal(error.into()))?;
        if !current.is_some_and(|membership| {
            membership.channel_id == channel_id && membership.session_id == expected
        }) {
            return Err(ApiError::Conflict(
                "The voice session for this stream has ended".into(),
            ));
        }
    }
    Ok(())
}

/// The voice flags a stream start or stop must leave as they are.
struct HeldVoiceFlags {
    self_mute: bool,
    self_deaf: bool,
    self_video: bool,
}

/// The caller's voice state in this call (every mute, deafen and camera change
/// writes its flags), or `None` when the caller is not in this channel.
async fn current_voice_state(
    state: &AppState,
    channel_id: i64,
    user_id: i64,
    guild_id: Option<i64>,
) -> Result<Option<paracord_db::voice_states::VoiceStateRow>, ApiError> {
    Ok(
        paracord_db::voice_states::get_user_voice_state(&state.db, user_id, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .filter(|row| row.channel_id == channel_id),
    )
}

fn held_flags(row: &paracord_db::voice_states::VoiceStateRow) -> HeldVoiceFlags {
    HeldVoiceFlags {
        self_mute: row.self_mute,
        self_deaf: row.self_deaf,
        self_video: row.self_video,
    }
}

/// Record the stream flag (keeping every other flag as it is) and return the
/// stored row, whose `self_stream_started_at` the database stamps on a start
/// and clears on a stop.
async fn record_stream_flag(
    state: &AppState,
    user_id: i64,
    guild_id: i64,
    held: &HeldVoiceFlags,
    streaming: bool,
) -> Result<paracord_db::voice_states::VoiceStateRow, ApiError> {
    paracord_db::voice_states::update_voice_state(
        &state.db,
        user_id,
        Some(guild_id),
        held.self_mute,
        held.self_deaf,
        streaming,
        held.self_video,
    )
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or_else(|| ApiError::Conflict("The voice session for this stream has ended".into()))
}

pub async fn start_stream(
    State(state): State<AppState>,
    auth: AuthUser,
    headers: HeaderMap,
    Path(channel_id): Path<i64>,
    Query(query): Query<VoiceJoinQuery>,
    body: Option<Json<StartStreamRequest>>,
) -> Result<Json<Value>, ApiError> {
    let _membership = state.voice.lock_membership(auth.user_id).await;
    if !state.config.livekit_available
        && !state.config.native_media_enabled
        && !paracord_federation::is_enabled()
    {
        return Err(ApiError::ServiceUnavailable(
            "Streaming is not available on this server".into(),
        ));
    }

    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if channel.channel_type != 2 && channel.channel_type != 13 {
        return Err(ApiError::BadRequest("Not a voice channel".into()));
    }

    let guild_id = channel.guild_id().ok_or(ApiError::BadRequest(
        "Streaming is only supported in guild channels".into(),
    ))?;
    require_stream_receipt(
        &state,
        auth.user_id,
        Some(guild_id),
        channel_id,
        query.session_id.as_deref(),
    )
    .await?;
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let perms = paracord_core::permissions::compute_channel_permissions(
        &state.db,
        guild_id,
        channel_id,
        guild.owner_id,
        auth.user_id,
    )
    .await?;
    paracord_core::permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;
    paracord_core::permissions::require_permission(perms, Permissions::CONNECT)?;
    if !perms.contains(Permissions::STREAM) {
        tracing::warn!(
            "start_stream forbidden: missing STREAM permission (user_id={}, guild_id={}, channel_id={}, perms={})",
            auth.user_id,
            guild_id,
            channel_id,
            perms.bits()
        );
        return Err(ApiError::Forbidden);
    }

    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    // Sharing a screen changes only the stream flag. The person's mute,
    // deafen and camera stay as they are, or everyone else sees a muted
    // streamer as unmuted until their next change. Only someone in the call
    // can stream into it, and a listener never sends.
    let current = current_voice_state(&state, channel_id, auth.user_id, Some(guild_id))
        .await?
        .ok_or_else(|| ApiError::Conflict("Join the voice channel before streaming".into()))?;
    if current.mode.is_listen() {
        return Err(ApiError::Conflict(
            "Listening in never sends; join the call to share a screen".into(),
        ));
    }
    let held = held_flags(&current);

    let requested_quality = body
        .as_ref()
        .and_then(|b| b.quality_preset.clone())
        .unwrap_or_else(|| "1080p60".to_string());
    if paracord_media::ScreenCaptureConfig::from_preset(&requested_quality).is_none() {
        return Err(ApiError::BadRequest("Invalid quality_preset".into()));
    }
    let stream_title = body.as_ref().and_then(|b| b.title.as_deref());

    let federation_service = crate::routes::federation::build_federation_service();
    if federation_service.is_enabled() {
        let outbound = crate::routes::federation::resolve_outbound_context(
            &state,
            &federation_service,
            guild_id,
            Some(channel_id),
        )
        .await;
        if outbound.uses_remote_mapping {
            if let (Some(remote_channel_id), Some(peer), Some(client), Some(local_identity)) = (
                outbound.payload_channel_id.clone(),
                crate::routes::federation::resolve_remote_target_for_outbound_context(
                    &state, &outbound,
                )
                .await,
                crate::routes::federation::build_signed_federation_client(&federation_service),
                crate::routes::federation::local_federated_user_id(
                    &state,
                    &federation_service,
                    auth.user_id,
                )
                .await,
            ) {
                let payload = FederationMediaRelayRequest {
                    origin_server: federation_service.server_name().to_string(),
                    channel_id: remote_channel_id,
                    user_id: local_identity,
                    action: "start_stream".to_string(),
                    title: stream_title.map(ToOwned::to_owned),
                };
                let target = paracord_federation::client::FederationTarget::new(
                    &peer.federation_endpoint,
                    &peer.server_name,
                );
                match client.relay_media_action(target, &payload).await {
                    Ok(remote) => {
                        if let (Some(token), Some(room_name)) = (remote.token, remote.room_name) {
                            let row =
                                record_stream_flag(&state, auth.user_id, guild_id, &held, true)
                                    .await?;
                            state.event_bus.dispatch(
                                "VOICE_STATE_UPDATE",
                                voice_state_payload(&row, Some(&user)),
                                Some(guild_id),
                            );

                            let mut url_candidates = Vec::new();
                            if let Some(remote_url) = remote.url.clone() {
                                push_unique_url(&mut url_candidates, remote_url);
                            }
                            for candidate in
                                livekit_url_candidates(&headers, &state.config.livekit_public_url)
                            {
                                push_unique_url(&mut url_candidates, candidate);
                            }
                            let livekit_url = url_candidates
                                .first()
                                .cloned()
                                .unwrap_or_else(|| state.config.livekit_public_url.clone());
                            return Ok(Json(json!({
                                "token": token,
                                "url": livekit_url,
                                "url_candidates": url_candidates,
                                "room_name": room_name,
                                "quality_preset": requested_quality,
                            })));
                        }
                        tracing::warn!(
                            "federation: mirrored start_stream returned incomplete payload for channel {} from {}",
                            channel_id,
                            peer.server_name
                        );
                    }
                    Err(err) => {
                        tracing::warn!(
                            "federation: media relay rpc failed for channel {} -> {} ({}): {}",
                            channel_id,
                            peer.server_name,
                            peer.domain,
                            err
                        );
                    }
                }
            } else {
                tracing::warn!(
                    "federation: mirrored stream channel {} missing remote mapping/client/identity; falling back local",
                    channel_id
                );
            }
        }
    }

    // ── Native media path ──────────────────────────────────────────────
    // When native media is enabled, use it by default unless the client
    // explicitly requests LiveKit as a fallback.
    let requesting_livekit_fallback = query.fallback.as_deref() == Some("livekit");
    if state.config.native_media_enabled && !requesting_livekit_fallback {
        let row = record_stream_flag(&state, auth.user_id, guild_id, &held, true).await?;

        state.event_bus.dispatch(
            "VOICE_STATE_UPDATE",
            voice_state_payload(&row, Some(&user)),
            Some(guild_id),
        );

        tracing::info!(
            "Native media stream started for user={} channel={}",
            auth.user_id,
            channel_id
        );

        return Ok(Json(json!({
            "native_media": true,
            "quality_preset": requested_quality,
        })));
    }

    if !state.config.livekit_available {
        return Err(ApiError::ServiceUnavailable(
            "LiveKit streaming is not available on this server".into(),
        ));
    }

    let stream_resp = state
        .voice
        .start_stream(
            channel_id,
            guild_id,
            auth.user_id,
            &user.username,
            stream_title,
        )
        .await
        .map_err(ApiError::Internal)?;

    // Persist stream state in DB and notify all guild members.
    let row = record_stream_flag(&state, auth.user_id, guild_id, &held, true).await?;

    state.event_bus.dispatch(
        "VOICE_STATE_UPDATE",
        voice_state_payload(&row, Some(&user)),
        Some(guild_id),
    );

    let url_candidates = livekit_url_candidates(&headers, &state.config.livekit_public_url);
    let livekit_url = url_candidates
        .first()
        .cloned()
        .unwrap_or_else(|| resolve_livekit_client_url(&headers, &state.config.livekit_public_url));

    Ok(Json(json!({
        "token": stream_resp.token,
        "url": livekit_url,
        "url_candidates": url_candidates,
        "room_name": stream_resp.room_name,
        "quality_preset": requested_quality,
    })))
}

pub async fn stop_stream(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(query): Query<VoiceLeaveQuery>,
) -> Result<StatusCode, ApiError> {
    let _membership = state.voice.lock_membership(auth.user_id).await;
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if channel.channel_type != 2 && channel.channel_type != 13 {
        return Err(ApiError::BadRequest("Not a voice channel".into()));
    }

    let guild_id = channel.guild_id();
    require_stream_receipt(
        &state,
        auth.user_id,
        guild_id,
        channel_id,
        query.session_id.as_deref(),
    )
    .await?;

    // Stopping a stream ends with a guild-wide VOICE_STATE_UPDATE naming the
    // caller in this channel. With only the channel-type check above, any
    // authenticated account -- member or not -- could forge that voice state
    // for a channel it cannot see. Mirror `start_stream`'s gate.
    if let Some(guild_id) = guild_id {
        paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
        let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::NotFound)?;
        let perms = paracord_core::permissions::compute_channel_permissions(
            &state.db,
            guild_id,
            channel_id,
            guild.owner_id,
            auth.user_id,
        )
        .await?;
        paracord_core::permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;
    }

    if let Some(guild_id) = guild_id {
        let federation_service = crate::routes::federation::build_federation_service();
        if federation_service.is_enabled() {
            let outbound = crate::routes::federation::resolve_outbound_context(
                &state,
                &federation_service,
                guild_id,
                Some(channel_id),
            )
            .await;
            if outbound.uses_remote_mapping {
                if let (Some(remote_channel_id), Some(peer), Some(client), Some(local_identity)) = (
                    outbound.payload_channel_id.clone(),
                    crate::routes::federation::resolve_remote_target_for_outbound_context(
                        &state, &outbound,
                    )
                    .await,
                    crate::routes::federation::build_signed_federation_client(&federation_service),
                    crate::routes::federation::local_federated_user_id(
                        &state,
                        &federation_service,
                        auth.user_id,
                    )
                    .await,
                ) {
                    let payload = FederationMediaRelayRequest {
                        origin_server: federation_service.server_name().to_string(),
                        channel_id: remote_channel_id,
                        user_id: local_identity,
                        action: "stop_stream".to_string(),
                        title: None,
                    };
                    let target = paracord_federation::client::FederationTarget::new(
                        &peer.federation_endpoint,
                        &peer.server_name,
                    );
                    if let Err(err) = client.relay_media_action(target, &payload).await {
                        tracing::warn!(
                            "federation: stop_stream rpc failed for channel {} -> {} ({}): {}",
                            channel_id,
                            peer.server_name,
                            peer.domain,
                            err
                        );
                    }
                }
            }
        }
    }

    // Clear stream state in the voice manager.
    state.voice.stop_stream(channel_id, auth.user_id).await;

    // Someone not in this channel has no stream here to stop, and announcing
    // one would place them in a channel they are not in.
    let (Some(gid), Some(current)) = (
        guild_id,
        current_voice_state(&state, channel_id, auth.user_id, guild_id).await?,
    ) else {
        return Ok(StatusCode::NO_CONTENT);
    };
    let held = held_flags(&current);
    let row = record_stream_flag(&state, auth.user_id, gid, &held, false).await?;

    // Notify all guild members that the stream ended.
    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .ok()
        .flatten();
    state.event_bus.dispatch(
        "VOICE_STATE_UPDATE",
        voice_state_payload(&row, user.as_ref()),
        guild_id,
    );

    Ok(StatusCode::NO_CONTENT)
}

pub async fn leave_voice(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(query): Query<VoiceLeaveQuery>,
) -> Result<StatusCode, ApiError> {
    let _membership = state.voice.lock_membership(auth.user_id).await;
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if channel.channel_type != 2 && channel.channel_type != 13 {
        return Err(ApiError::BadRequest("Not a voice channel".into()));
    }

    let guild_id = channel.guild_id();
    let current =
        paracord_db::voice_states::get_user_voice_session(&state.db, auth.user_id, guild_id)
            .await
            .map_err(|error| ApiError::Internal(error.into()))?;
    // A receipt names a call, not a channel. Without this, a leave holding the
    // *right* receipt but naming a channel the caller has since moved on from
    // would tear down the call they are actually in.
    if current
        .as_ref()
        .is_some_and(|membership| membership.channel_id != channel_id)
    {
        tracing::info!(
            "Ignoring leave_voice for a channel the caller no longer occupies (user={} channel={} session_id={:?})",
            auth.user_id,
            channel_id,
            query.session_id
        );
        return Ok(StatusCode::NO_CONTENT);
    }
    // `current == None` is a leave with nothing to unwind (the caller was never
    // admitted, or a previous leave already landed). Skip the state changes but
    // still announce it below, so a client whose local state drifted is
    // corrected rather than left showing a call it is not in.
    if current.is_some() {
        let removed = if let Some(expected_session_id) = query.session_id.as_deref() {
            paracord_db::voice_states::remove_voice_state_if_session(
                &state.db,
                auth.user_id,
                guild_id,
                expected_session_id,
            )
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        } else {
            paracord_db::voice_states::remove_voice_state(&state.db, auth.user_id, guild_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            true
        };
        if !removed {
            tracing::info!(
                "Ignoring stale leave_voice request for user={} channel={} session_id={:?}",
                auth.user_id,
                channel_id,
                query.session_id
            );
            return Ok(StatusCode::NO_CONTENT);
        }
        let _participants = state
            .voice
            .leave_room_if_session(channel_id, auth.user_id, query.session_id.as_deref())
            .await;
        if let (Some(native_media), Some(guild_id)) = (state.native_media.as_ref(), guild_id) {
            let _ = native_media.rooms.leave_room_if_session(
                guild_id,
                channel_id,
                auth.user_id,
                query.session_id.as_deref(),
            );
        }
    }
    // Don't eagerly delete the LiveKit room when the last participant leaves.
    // Rapid leave→rejoin cycles cause a race between the delete_room API call
    // and the subsequent create_room, leading to "could not establish pc
    // connection" errors because LiveKit is still tearing down WebRTC resources
    // from the old room.  Instead, let LiveKit's empty_timeout (300s) handle
    // cleanup.  The active_livekit_rooms entry persists so the next join
    // reuses the existing room without needing to re-create it.

    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .ok()
        .flatten();
    // `prior_channel_id` is the only handle the gateway's per-channel
    // VIEW_CHANNEL filter has on a leave (its `channel_id` is null); omitting it
    // fans the leave out guild-wide and leaks presence in hidden voice channels.
    state.event_bus.dispatch(
        "VOICE_STATE_UPDATE",
        json!({
            "user_id": auth.user_id.to_string(),
            "channel_id": null,
            "prior_channel_id": channel_id.to_string(),
            "guild_id": guild_id.map(|id| id.to_string()),
            "self_mute": false,
            "self_deaf": false,
            "self_stream": false,
            "self_video": false,
            "suppress": false,
            "mute": false,
            "deaf": false,
            "username": user.as_ref().map(|u| u.username.as_str()),
            "avatar_hash": user.as_ref().and_then(|u| u.avatar_hash.as_deref()),
        }),
        guild_id,
    );
    Ok(StatusCode::NO_CONTENT)
}

pub async fn livekit_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    verify_livekit_webhook_auth(
        &headers,
        &body,
        &state.config.livekit_api_key,
        &state.config.livekit_api_secret,
    )?;
    let payload: LiveKitWebhookPayload =
        serde_json::from_slice(&body).map_err(|e| ApiError::BadRequest(e.to_string()))?;

    if payload.event != "participant_left" {
        return Ok(StatusCode::NO_CONTENT);
    }
    let room_name = if let Some(room) = payload.room {
        room.name
    } else {
        return Ok(StatusCode::NO_CONTENT);
    };
    let expected_session = payload
        .participant
        .as_ref()
        .and_then(|participant| participant.metadata.as_deref())
        .and_then(|metadata| serde_json::from_str::<Value>(metadata).ok())
        .and_then(|metadata| {
            metadata
                .get("voice_session_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    // Older unsigned-to-session metadata cannot identify a replacement safely.
    let Some(expected_session) = expected_session else {
        return Ok(StatusCode::NO_CONTENT);
    };
    let user_id = if let Some(participant) = payload.participant {
        participant.identity.parse::<i64>().ok()
    } else {
        None
    };
    let Some(user_id) = user_id else {
        return Ok(StatusCode::NO_CONTENT);
    };

    let parts: Vec<&str> = room_name.split('_').collect();
    if parts.len() < 4 {
        return Ok(StatusCode::NO_CONTENT);
    }
    let guild_id = parts[1].parse::<i64>().ok();
    let channel_id = parts[3].parse::<i64>().ok();
    let Some(channel_id) = channel_id else {
        return Ok(StatusCode::NO_CONTENT);
    };

    // Grace period: LiveKit fires participant_left during transient reconnects.
    // Wait 5 seconds before acting — if the participant has re-joined by then,
    // skip the removal so their icon stays in the sidebar.
    tracing::debug!(
        "LiveKit participant_left for user {} in channel {}, starting 5s grace period",
        user_id,
        channel_id
    );
    let state_clone = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;

        let _membership = state_clone.voice.lock_membership(user_id).await;
        // Check if the participant actually reconnected to the LiveKit room.
        // Query LiveKit directly — this is the ground truth for connection status.
        match state_clone
            .voice
            .is_participant_in_livekit_room(channel_id, guild_id, user_id)
            .await
        {
            Some(true) => {
                tracing::debug!(
                    "LiveKit participant_left grace period expired: user {} still in LiveKit room for channel {}, skipping removal",
                    user_id, channel_id
                );
                return;
            }
            None => {
                tracing::warn!(
                    "LiveKit participant_left grace period expired: presence unknown for user {} channel {}, skipping removal",
                    user_id, channel_id
                );
                return;
            }
            Some(false) => {}
        }

        tracing::info!(
            "LiveKit participant_left confirmed: removing user {} from channel {}",
            user_id,
            channel_id
        );

        let guild_id = guild_id.filter(|id| *id != 0);
        let removed = paracord_db::voice_states::remove_voice_state_if_session(
            &state_clone.db,
            user_id,
            guild_id,
            &expected_session,
        )
        .await;
        if !matches!(removed, Ok(true)) {
            return;
        }
        let _ = state_clone
            .voice
            .leave_room_if_session(channel_id, user_id, Some(&expected_session))
            .await;

        let user = paracord_db::users::get_user_by_id(&state_clone.db, user_id)
            .await
            .ok()
            .flatten();
        // See `leave_voice`: a leave's `channel_id` is null, so
        // `prior_channel_id` is what keeps the gateway's per-channel
        // VIEW_CHANNEL filter able to scope it.
        state_clone.event_bus.dispatch(
            "VOICE_STATE_UPDATE",
            json!({
                "user_id": user_id.to_string(),
                "channel_id": null,
                "prior_channel_id": channel_id.to_string(),
                "guild_id": guild_id.map(|id| id.to_string()),
                "self_mute": false,
                "self_deaf": false,
                "self_stream": false,
                "self_video": false,
                "suppress": false,
                "mute": false,
                "deaf": false,
                "username": user.as_ref().map(|u| u.username.as_str()),
                "avatar_hash": user.as_ref().and_then(|u| u.avatar_hash.as_deref()),
            }),
            guild_id,
        );
    });

    Ok(StatusCode::NO_CONTENT)
}

// ── Listen in: switching mode in place ─────────────────────────────────────

/// `POST /api/v2/voice/{channel_id}/mode`: switch the caller's membership of
/// this voice channel between listening in and joined, in place.
///
/// The call keeps its receipt and its media connection: the relay flips the
/// member's publish permission (receive-only ↔ SPEAK-gated), the stored voice
/// state changes mode, and everyone who can see the channel gets a
/// `VOICE_STATE_UPDATE`. Entering `listen` also ends any screen share or
/// camera (a listener never sends). Switching to `listen` answers 403
/// `LISTEN_IN_DISABLED` when the channel has listening in turned off.
pub async fn update_voice_mode(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<wire::UpdateVoiceModeRequest>,
) -> Result<Json<wire::VoiceModeResponse>, VoiceRouteError> {
    let _membership = state.voice.lock_membership(auth.user_id).await;
    let mode = mode_from_wire(body.mode);
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if channel.channel_type != 2 {
        return Err(ApiError::BadRequest("Listening in is only for voice channels".into()).into());
    }
    let guild_id = channel.guild_id().ok_or(ApiError::BadRequest(
        "Voice is only supported in guild channels".into(),
    ))?;
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let perms = paracord_core::permissions::compute_channel_permissions(
        &state.db,
        guild_id,
        channel_id,
        guild.owner_id,
        auth.user_id,
    )
    .await?;
    paracord_core::permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;
    paracord_core::permissions::require_permission(perms, Permissions::CONNECT)?;

    let current = current_voice_state(&state, channel_id, auth.user_id, Some(guild_id))
        .await?
        .ok_or_else(|| ApiError::Conflict("You are not in this voice channel".into()))?;
    if body
        .session_id
        .as_deref()
        .is_some_and(|expected| expected != current.session_id)
    {
        return Err(ApiError::Conflict("The voice session for this call has ended".into()).into());
    }
    if mode.is_listen() {
        ensure_listen_in_allowed(&state, &channel).await?;
    }

    let can_speak = perms.contains(Permissions::SPEAK);
    let can_publish = !mode.is_listen() && can_speak;
    if current.mode == mode {
        return Ok(Json(wire::VoiceModeResponse {
            channel_id: channel_id.to_string(),
            session_id: current.session_id,
            mode: mode_to_wire(mode),
            can_publish,
        }));
    }
    let previous_can_publish = !current.mode.is_listen() && can_speak;

    // Flip the relay first: until the stored mode says `joined`, nobody else
    // is told the member may speak, and a failed write below puts the relay
    // back. A call on the native relay is switched there; a LiveKit call
    // through its participant permission; a call on neither cannot switch.
    let switched_native = match state.native_media.as_ref() {
        Some(native) => match native
            .rooms
            .update_participant_publish_permission_if_session(
                guild_id,
                channel_id,
                auth.user_id,
                &current.session_id,
                can_publish,
            ) {
            Ok(()) => true,
            Err(RoomError::NotFound(_) | RoomError::UserNotInRoom(..)) => false,
            Err(error) => return Err(ApiError::Internal(error.into()).into()),
        },
        None => false,
    };
    if !switched_native {
        if !state.config.livekit_available {
            return Err(ApiError::Conflict(
                "This call has no media session to switch; rejoin in the mode you want".into(),
            )
            .into());
        }
        state
            .voice
            .set_participant_can_publish(channel_id, auth.user_id, can_publish)
            .await
            .map_err(ApiError::Internal)?;
    }
    let revert = |state: &AppState| {
        if switched_native {
            if let Some(native) = state.native_media.as_ref() {
                let _ = native
                    .rooms
                    .update_participant_publish_permission_if_session(
                        guild_id,
                        channel_id,
                        auth.user_id,
                        &current.session_id,
                        previous_can_publish,
                    );
            }
        }
    };

    let row = match paracord_db::voice_states::set_voice_mode(
        &state.db,
        auth.user_id,
        Some(guild_id),
        channel_id,
        &current.session_id,
        mode,
    )
    .await
    {
        Ok(Some(row)) => row,
        Ok(None) => {
            revert(&state);
            return Err(
                ApiError::Conflict("The voice session for this call has ended".into()).into(),
            );
        }
        Err(error) => {
            revert(&state);
            return Err(ApiError::Internal(error.into()).into());
        }
    };
    if mode.is_listen() && current.self_stream {
        state.voice.stop_stream(channel_id, auth.user_id).await;
    }

    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .ok()
        .flatten();
    state.event_bus.dispatch(
        "VOICE_STATE_UPDATE",
        voice_state_payload(&row, user.as_ref()),
        Some(guild_id),
    );
    tracing::info!(
        user_id = auth.user_id,
        channel_id,
        mode = mode.as_str(),
        "voice: switched call mode in place"
    );
    Ok(Json(wire::VoiceModeResponse {
        channel_id: channel_id.to_string(),
        session_id: row.session_id,
        mode: mode_to_wire(mode),
        can_publish,
    }))
}

// ── View sessions: watch without joining, ambient room light ───────────────

/// How long a view-session media token stays valid for connecting. A view
/// that has not connected within [`VIEW_CONNECT_GRACE`] is retired anyway.
const VIEW_TOKEN_TTL_SECS: i64 = 10 * 60;
/// How long a view may go without a live media connection (before its first
/// connect, or after a drop) before the relay retires it.
const VIEW_CONNECT_GRACE: std::time::Duration = std::time::Duration::from_secs(20);
/// How often unbacked views are swept.
const VIEW_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);
/// Watcher-count changes arriving within this window go out as one event.
const WATCHERS_COALESCE: std::time::Duration = std::time::Duration::from_millis(250);

fn view_kind_from_wire(kind: wire::VoiceViewKind) -> ViewKind {
    match kind {
        wire::VoiceViewKind::Watch => ViewKind::Watch,
        wire::VoiceViewKind::Ambient => ViewKind::Ambient,
    }
}

fn watchers_payload(
    guild_id: i64,
    channel_id: i64,
    counts: &std::collections::BTreeMap<i64, u32>,
) -> wire::VoiceWatchers {
    wire::VoiceWatchers {
        guild_id: guild_id.to_string(),
        channel_id: channel_id.to_string(),
        streams: counts
            .iter()
            .map(|(user_id, watchers)| wire::VoiceStreamWatchers {
                user_id: user_id.to_string(),
                watchers: *watchers,
            })
            .collect(),
    }
}

/// Start (once per server state) the task that keeps view sessions honest:
/// it broadcasts `VOICE_WATCHERS_UPDATE` whenever a channel's watcher counts
/// change, however the change happened (a view started, ended or expired, a
/// watching member left the call by any path), and retires views that have
/// no live media connection.
fn ensure_view_housekeeping(state: &AppState) {
    let Some(native) = state.native_media.as_ref() else {
        return;
    };
    let Some(signal) = native.rooms.claim_watch_listener() else {
        return;
    };
    let state = state.clone();
    tokio::spawn(async move {
        let Some(native) = state.native_media.as_ref() else {
            return;
        };
        let mut sweep = tokio::time::interval(VIEW_SWEEP_INTERVAL);
        sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut announced: std::collections::HashMap<
            (i64, i64),
            std::collections::BTreeMap<i64, u32>,
        > = std::collections::HashMap::new();
        loop {
            tokio::select! {
                _ = signal.notified() => tokio::time::sleep(WATCHERS_COALESCE).await,
                _ = sweep.tick() => {
                    native.relay_forwarder.sweep_views(VIEW_CONNECT_GRACE);
                    revoke_views_without_access(&state).await;
                }
            }
            for (guild_id, channel_id) in native.rooms.drain_watch_dirty() {
                let counts = native.rooms.watcher_counts(guild_id, channel_id);
                let key = (guild_id, channel_id);
                let unchanged = match announced.get(&key) {
                    Some(previous) => *previous == counts,
                    None => counts.is_empty(),
                };
                if unchanged {
                    continue;
                }
                // Guild-scoped with a `channel_id`: both transports deliver it
                // only to sessions that may view this channel.
                state.event_bus.dispatch(
                    paracord_models::gateway::EVENT_VOICE_WATCHERS_UPDATE,
                    json!(watchers_payload(guild_id, channel_id, &counts)),
                    Some(guild_id),
                );
                if counts.is_empty() {
                    announced.remove(&key);
                } else {
                    announced.insert(key, counts);
                }
            }
        }
    });
}

/// End every view whose viewer may no longer have it, and close its media
/// connection as revoked.
///
/// A view is authorized once, when it starts (VIEW_CHANNEL, plus CONNECT for a
/// watch). Losing either afterwards (a channel overwrite, a role change, the
/// channel deleted, the account removed from the server) must end it, or the
/// viewer would keep receiving a stream it may no longer see. Every change
/// that can take the permission away invalidates the permission cache, so the
/// sweep re-reads it cheaply; the delay is at most one sweep
/// ([`VIEW_SWEEP_INTERVAL`]). A database error leaves that view for the next
/// sweep rather than ending views on a transient fault. Returns how many views
/// it ended.
pub async fn revoke_views_without_access(state: &AppState) -> usize {
    let Some(native) = state.native_media.as_ref() else {
        return 0;
    };
    let mut revoked = 0;
    for (user_id, view) in native.rooms.views_snapshot() {
        let allowed = match view_still_allowed(state, user_id, &view).await {
            Ok(allowed) => allowed,
            Err(error) => {
                tracing::warn!(
                    user_id,
                    channel_id = view.channel_id,
                    %error,
                    "voice: could not re-check a viewer's access; checking again next sweep"
                );
                continue;
            }
        };
        if allowed {
            continue;
        }
        if native
            .rooms
            .end_view_if_session(user_id, Some(&view.session_id))
            .is_some()
        {
            native
                .relay_forwarder
                .revoke_view_connection(user_id, &view.session_id);
            tracing::info!(
                user_id,
                channel_id = view.channel_id,
                "voice: ended a view its viewer may no longer see"
            );
            revoked += 1;
        }
    }
    revoked
}

/// Whether `user_id` may still hold `view`: the channel exists in the view's
/// server, and the viewer has VIEW_CHANNEL there (and CONNECT, for a watch).
async fn view_still_allowed(
    state: &AppState,
    user_id: i64,
    view: &paracord_relay::room::ViewRecord,
) -> anyhow::Result<bool> {
    let Some(channel) = paracord_db::channels::get_channel(&state.db, view.channel_id).await?
    else {
        return Ok(false);
    };
    if channel.guild_id() != Some(view.guild_id) {
        return Ok(false);
    }
    let Some(guild) = paracord_db::guilds::get_guild(&state.db, view.guild_id).await? else {
        return Ok(false);
    };
    let perms = paracord_core::permissions::compute_channel_permissions_cached(
        &state.permission_cache,
        &state.db,
        view.guild_id,
        view.channel_id,
        guild.owner_id,
        user_id,
    )
    .await?;
    let needed = match view.target.kind {
        ViewKind::Watch => Permissions::VIEW_CHANNEL | Permissions::CONNECT,
        ViewKind::Ambient => Permissions::VIEW_CHANNEL,
    };
    Ok(perms.contains(needed))
}

/// The channel, guild and permissions a view route acts under.
async fn view_channel_context(
    state: &AppState,
    user_id: i64,
    channel_id: i64,
) -> Result<(paracord_db::channels::ChannelRow, i64, Permissions), ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if channel.channel_type != 2 && channel.channel_type != 13 {
        return Err(ApiError::BadRequest("Not a voice channel".into()));
    }
    let guild_id = channel.guild_id().ok_or(ApiError::BadRequest(
        "Voice is only supported in guild channels".into(),
    ))?;
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, user_id).await?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let perms = paracord_core::permissions::compute_channel_permissions(
        &state.db,
        guild_id,
        channel_id,
        guild.owner_id,
        user_id,
    )
    .await?;
    paracord_core::permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;
    Ok((channel, guild_id, perms))
}

/// `POST /api/v2/voice/{channel_id}/view`: watch a stream without joining the
/// call (`watch`: the stream's video and its own audio, counted), or light the
/// room with it (`ambient`: lowest layer, capped frame rate, not counted).
///
/// Needs VIEW_CHANNEL, and CONNECT for `watch`. The streamer must be sharing
/// in this channel (409 otherwise). A caller already in this channel's call
/// watches through it (`via_membership`); anyone else gets a separate view
/// session with its own media credentials, replacing any view session the
/// account already holds. Never creates a voice state and never shows the
/// viewer in the call.
pub async fn start_voice_view(
    State(state): State<AppState>,
    auth: AuthUser,
    headers: HeaderMap,
    Path(channel_id): Path<i64>,
    Json(body): Json<wire::StartVoiceViewRequest>,
) -> Result<Json<wire::VoiceViewSession>, ApiError> {
    let _membership = state.voice.lock_membership(auth.user_id).await;
    let native = state.native_media.as_ref().ok_or_else(|| {
        ApiError::NotConfigured(
            "Watching without joining needs native media, which this server has not enabled".into(),
        )
    })?;
    let (_, guild_id, perms) = view_channel_context(&state, auth.user_id, channel_id).await?;
    let kind = view_kind_from_wire(body.kind);
    if matches!(kind, ViewKind::Watch) {
        paracord_core::permissions::require_permission(perms, Permissions::CONNECT)?;
    }
    let streamer_id: i64 = body
        .user_id
        .parse()
        .map_err(|_| ApiError::BadRequest("Invalid user_id".into()))?;
    if streamer_id == auth.user_id {
        return Err(ApiError::BadRequest(
            "Your own stream is already on your screen".into(),
        ));
    }
    let streaming = current_voice_state(&state, channel_id, streamer_id, Some(guild_id))
        .await?
        .is_some_and(|row| row.self_stream);
    if !streaming {
        return Err(ApiError::Conflict(
            "That person is not streaming in this channel".into(),
        ));
    }
    let target = ViewTarget {
        kind,
        publisher_user_id: streamer_id,
    };
    ensure_view_housekeeping(&state);

    // Already in this call (joined or listening): the view rides the call.
    if let Some(own) = current_voice_state(&state, channel_id, auth.user_id, Some(guild_id)).await?
    {
        if let Some(publisher) = target.counted_publisher() {
            native
                .rooms
                .set_watching(
                    guild_id,
                    channel_id,
                    auth.user_id,
                    &own.session_id,
                    Some(publisher),
                )
                .map_err(|error| match error {
                    RoomError::NotFound(_) | RoomError::UserNotInRoom(..) => ApiError::Conflict(
                        "Your call in this channel has no native media session".into(),
                    ),
                    other => ApiError::Internal(other.into()),
                })?;
        }
        return Ok(Json(wire::VoiceViewSession {
            guild_id: guild_id.to_string(),
            channel_id: channel_id.to_string(),
            kind: body.kind,
            user_id: streamer_id.to_string(),
            via_membership: true,
            session_id: None,
            media: None,
        }));
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let replaced = native
        .rooms
        .join_view(
            guild_id,
            channel_id,
            MediaParticipant::viewer(auth.user_id, session_id.clone(), target),
        )
        .map_err(|error| match error {
            RoomError::ViewersFull(_) => {
                ApiError::Conflict("This stream has as many viewers as it can take".into())
            }
            RoomError::AlreadyInRoom(..) => {
                ApiError::Conflict("You are already in this call; watch through it".into())
            }
            other => ApiError::Internal(other.into()),
        })?;
    if let Some(previous) = replaced {
        // One view per account: the view this one replaces (another device's,
        // or this client's own earlier one) is told it was superseded.
        native
            .relay_forwarder
            .supersede_view_connection(auth.user_id, &previous.session_id);
    }

    let (media_endpoint, media_endpoint_candidates) =
        native_media_endpoints(&headers, state.config.native_media_port);
    let room_name = format!("{}:{}", guild_id, channel_id);
    let issued_at = chrono::Utc::now().timestamp();
    // The same claims a call token carries, plus `view`: the claim that makes
    // the media endpoint admit this receipt as a view session (and only as
    // one). See `paracord_transport::connection::MediaViewClaim`.
    let media_claims = json!({
        "sub": auth.user_id.to_string(),
        "sid": &session_id,
        "auth_sid": auth.session_id.as_deref(),
        "iat": issued_at,
        "exp": issued_at + VIEW_TOKEN_TTL_SECS,
        "session_id": &session_id,
        "auth_session_id": auth.session_id.as_deref(),
        "room": &room_name,
        "view": kind.as_str(),
    });
    let media_token = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(Algorithm::HS256),
        &media_claims,
        &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .map_err(|error| {
        native
            .rooms
            .end_view_if_session(auth.user_id, Some(&session_id));
        ApiError::Internal(error.into())
    })?;
    tracing::info!(
        user_id = auth.user_id,
        channel_id,
        streamer_id,
        kind = kind.as_str(),
        "voice: view session issued"
    );
    Ok(Json(wire::VoiceViewSession {
        guild_id: guild_id.to_string(),
        channel_id: channel_id.to_string(),
        kind: body.kind,
        user_id: streamer_id.to_string(),
        via_membership: false,
        session_id: Some(session_id),
        media: Some(wire::VoiceViewMedia {
            media_endpoint,
            media_endpoint_candidates,
            media_token,
            cert_hash: Some(native.cert_hash.get()),
            room_name,
        }),
    }))
}

/// `DELETE /api/v2/voice/{channel_id}/view[?session_id=…]`: stop viewing.
///
/// Ends the caller's view session in this channel (only the one `session_id`
/// names, when given) and stops a watch the caller holds through its call
/// here. Idempotent: nothing to stop is still 204.
pub async fn stop_voice_view(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(query): Query<VoiceLeaveQuery>,
) -> Result<StatusCode, ApiError> {
    let _membership = state.voice.lock_membership(auth.user_id).await;
    let Some(native) = state.native_media.as_ref() else {
        return Ok(StatusCode::NO_CONTENT);
    };
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let Some(guild_id) = channel.guild_id() else {
        return Ok(StatusCode::NO_CONTENT);
    };
    let expected = query.session_id.as_deref();

    if let Some(view) = native
        .rooms
        .view_for_user(auth.user_id)
        .filter(|view| view.channel_id == channel_id)
        .filter(|view| expected.is_none_or(|expected| expected == view.session_id))
    {
        native
            .rooms
            .end_view_if_session(auth.user_id, Some(&view.session_id));
        native
            .relay_forwarder
            .close_view_connection(auth.user_id, &view.session_id);
    }
    if let Some(own) = current_voice_state(&state, channel_id, auth.user_id, Some(guild_id))
        .await?
        .filter(|own| expected.is_none_or(|expected| expected == own.session_id))
    {
        // No native membership (or already not watching) is nothing to stop.
        let _ =
            native
                .rooms
                .set_watching(guild_id, channel_id, auth.user_id, &own.session_id, None);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/v2/voice/{channel_id}/watchers`: the channel's watcher counts
/// now (the same snapshot `VOICE_WATCHERS_UPDATE` carries). Needs
/// VIEW_CHANNEL. Empty when nobody watches (or native media is off).
pub async fn get_voice_watchers(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<wire::VoiceWatchers>, ApiError> {
    let (_, guild_id, _) = view_channel_context(&state, auth.user_id, channel_id).await?;
    let counts = state
        .native_media
        .as_ref()
        .map(|native| native.rooms.watcher_counts(guild_id, channel_id))
        .unwrap_or_default();
    Ok(Json(watchers_payload(guild_id, channel_id, &counts)))
}

#[cfg(test)]
mod tests {
    use super::verify_livekit_webhook_auth;
    use axum::http::{header, HeaderMap, HeaderValue};
    use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
    use serde::Serialize;
    use sha2::{Digest, Sha256};

    #[derive(Serialize)]
    struct Claims {
        iss: String,
        exp: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        sha256: Option<String>,
    }

    fn bearer_header(secret: &str, issuer: &str, sha256: Option<String>) -> HeaderMap {
        let claims = Claims {
            iss: issuer.to_string(),
            exp: (chrono::Utc::now().timestamp() + 300) as usize,
            sha256,
        };
        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .expect("encode token");

        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).expect("header"),
        );
        headers
    }

    fn sha256_hex(body: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(body);
        hasher
            .finalize()
            .iter()
            .fold(String::with_capacity(64), |mut out, byte| {
                use std::fmt::Write;
                let _ = write!(out, "{:02x}", byte);
                out
            })
    }

    #[test]
    fn webhook_auth_accepts_valid_bearer_with_body_hash() {
        let body = br#"{"event":"room_started"}"#;
        let headers = bearer_header("secret-1", "api-key-1", Some(sha256_hex(body)));
        let result = verify_livekit_webhook_auth(&headers, body, "api-key-1", "secret-1");
        assert!(result.is_ok());
    }

    #[test]
    fn webhook_auth_rejects_missing_body_hash() {
        // Body-hash binding is mandatory; a token without the sha256 claim is
        // rejected even if it is otherwise valid.
        let headers = bearer_header("secret-1", "api-key-1", None);
        let result = verify_livekit_webhook_auth(&headers, b"{}", "api-key-1", "secret-1");
        assert!(matches!(result, Err(crate::error::ApiError::Unauthorized)));
    }

    #[test]
    fn webhook_auth_rejects_wrong_issuer() {
        let headers = bearer_header("secret-1", "other-key", None);
        let result = verify_livekit_webhook_auth(&headers, b"{}", "api-key-1", "secret-1");
        assert!(matches!(result, Err(crate::error::ApiError::Unauthorized)));
    }

    #[test]
    fn webhook_auth_rejects_body_hash_mismatch() {
        let mut hasher = Sha256::new();
        hasher.update(b"expected-body");
        let digest = hasher.finalize();
        let expected_hash = digest
            .iter()
            .fold(String::with_capacity(64), |mut out, byte| {
                use std::fmt::Write;
                let _ = write!(out, "{:02x}", byte);
                out
            });
        let headers = bearer_header("secret-1", "api-key-1", Some(expected_hash));
        let result =
            verify_livekit_webhook_auth(&headers, b"different-body", "api-key-1", "secret-1");
        assert!(matches!(result, Err(crate::error::ApiError::Unauthorized)));
    }
}
