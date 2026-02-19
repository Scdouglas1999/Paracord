use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    Json,
};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use paracord_core::AppState;
use paracord_federation::client::{FederationMediaRelayRequest, FederationMediaTokenRequest};
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::ApiError;
use crate::middleware::AuthUser;

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
        .map(|raw| matches!(raw.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
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

    if let Some(expected_hash) = decoded.claims.sha256.as_deref() {
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
    }

    Ok(())
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
}

pub async fn join_voice(
    State(state): State<AppState>,
    auth: AuthUser,
    headers: HeaderMap,
    Path(channel_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    if !state.config.livekit_available && !paracord_federation::is_enabled() {
        return Err(ApiError::ServiceUnavailable(
            "Voice chat is not available — LiveKit server binary not found. Place livekit-server next to the Paracord server executable.".into(),
        ));
    }

    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if channel.channel_type != 2 {
        return Err(ApiError::BadRequest("Not a voice channel".into()));
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

    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    // If the user was tracked in any other voice room, remove that stale
    // in-memory membership before joining the new channel.
    // Room cleanup (LiveKit DeleteRoom API) is spawned in the background so
    // it does not block the join response — the API call can take up to 10s
    // and stacking multiple cleanup calls easily exceeds the client timeout.
    if let Ok(existing_states) =
        paracord_db::voice_states::get_all_user_voice_states(&state.db, auth.user_id).await
    {
        let mut empty_channels = Vec::new();
        for existing in existing_states {
            if existing.channel_id == channel_id {
                continue;
            }
            if let Some(current) = state
                .voice
                .leave_room(existing.channel_id, auth.user_id)
                .await
            {
                if current.is_empty() {
                    empty_channels.push(existing.channel_id);
                }
            }
        }
        if !empty_channels.is_empty() {
            let voice = state.voice.clone();
            tokio::spawn(async move {
                for ch_id in empty_channels {
                    let _ = voice.cleanup_room(ch_id).await;
                }
            });
        }
    }

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
                let payload = FederationMediaTokenRequest {
                    origin_server: federation_service.server_name().to_string(),
                    channel_id: remote_channel_id,
                    user_id: local_identity,
                };
                match client
                    .request_media_token(&peer.federation_endpoint, &payload)
                    .await
                {
                    Ok(remote) => {
                        let _ = paracord_db::voice_states::upsert_voice_state(
                            &state.db,
                            auth.user_id,
                            channel.guild_id(),
                            channel_id,
                            &remote.session_id,
                        )
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
                                "suppress": false,
                                "mute": false,
                                "deaf": false,
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

    if !state.config.livekit_available {
        return Err(ApiError::ServiceUnavailable(
            "Voice chat is not available - LiveKit server binary not found. Place livekit-server next to the Paracord server executable.".into(),
        ));
    }

    let session_id = uuid::Uuid::new_v4().to_string();

    let join_resp = state
        .voice
        .join_channel(
            channel_id,
            guild_id,
            auth.user_id,
            &user.username,
            &session_id,
            true, // can_speak
            paracord_media::AudioBitrate::default(),
        )
        .await
        .map_err(ApiError::Internal)?;

    let _ = paracord_db::voice_states::upsert_voice_state(
        &state.db,
        auth.user_id,
        channel.guild_id(),
        channel_id,
        &session_id,
    )
    .await;

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
            "suppress": false,
            "mute": false,
            "deaf": false,
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
    })))
}

pub async fn start_stream(
    State(state): State<AppState>,
    auth: AuthUser,
    headers: HeaderMap,
    Path(channel_id): Path<i64>,
    body: Option<Json<StartStreamRequest>>,
) -> Result<Json<Value>, ApiError> {
    if !state.config.livekit_available && !paracord_federation::is_enabled() {
        return Err(ApiError::ServiceUnavailable(
            "Streaming is not available — LiveKit server binary not found.".into(),
        ));
    }

    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if channel.channel_type != 2 {
        return Err(ApiError::BadRequest("Not a voice channel".into()));
    }

    let guild_id = channel.guild_id().ok_or(ApiError::BadRequest(
        "Streaming is only supported in guild channels".into(),
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
                match client
                    .relay_media_action(&peer.federation_endpoint, &payload)
                    .await
                {
                    Ok(remote) => {
                        if let (Some(token), Some(room_name)) = (remote.token, remote.room_name) {
                            let _ = paracord_db::voice_states::update_voice_state(
                                &state.db,
                                auth.user_id,
                                Some(guild_id),
                                false,
                                false,
                                true,
                                false,
                            )
                            .await;
                            state.event_bus.dispatch(
                                "VOICE_STATE_UPDATE",
                                json!({
                                    "user_id": auth.user_id.to_string(),
                                    "channel_id": channel_id.to_string(),
                                    "guild_id": Some(guild_id.to_string()),
                                    "self_mute": false,
                                    "self_deaf": false,
                                    "self_stream": true,
                                    "self_video": false,
                                    "suppress": false,
                                    "mute": false,
                                    "deaf": false,
                                    "username": &user.username,
                                    "avatar_hash": user.avatar_hash,
                                }),
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

    if !state.config.livekit_available {
        return Err(ApiError::ServiceUnavailable(
            "Streaming is not available - LiveKit server binary not found.".into(),
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
    let _ = paracord_db::voice_states::update_voice_state(
        &state.db,
        auth.user_id,
        Some(guild_id),
        false,
        false,
        true,
        false,
    )
    .await;

    state.event_bus.dispatch(
        "VOICE_STATE_UPDATE",
        json!({
            "user_id": auth.user_id.to_string(),
            "channel_id": channel_id.to_string(),
            "guild_id": Some(guild_id.to_string()),
            "self_mute": false,
            "self_deaf": false,
            "self_stream": true,
            "self_video": false,
            "suppress": false,
            "mute": false,
            "deaf": false,
            "username": &user.username,
            "avatar_hash": user.avatar_hash,
        }),
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
) -> Result<StatusCode, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if channel.channel_type != 2 {
        return Err(ApiError::BadRequest("Not a voice channel".into()));
    }

    let guild_id = channel.guild_id();

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
                    if let Err(err) = client
                        .relay_media_action(&peer.federation_endpoint, &payload)
                        .await
                    {
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

    // Update DB voice state.
    if let Some(gid) = guild_id {
        let _ = paracord_db::voice_states::update_voice_state(
            &state.db,
            auth.user_id,
            Some(gid),
            false,
            false,
            false,
            false,
        )
        .await;
    }

    // Notify all guild members that the stream ended.
    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .ok()
        .flatten();
    state.event_bus.dispatch(
        "VOICE_STATE_UPDATE",
        json!({
            "user_id": auth.user_id.to_string(),
            "channel_id": channel_id.to_string(),
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

pub async fn leave_voice(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if channel.channel_type != 2 {
        return Err(ApiError::BadRequest("Not a voice channel".into()));
    }

    let guild_id = channel.guild_id();
    let _ = paracord_db::voice_states::remove_voice_state(&state.db, auth.user_id, guild_id).await;
    let _participants = state.voice.leave_room(channel_id, auth.user_id).await;
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
    state.event_bus.dispatch(
        "VOICE_STATE_UPDATE",
        json!({
            "user_id": auth.user_id.to_string(),
            "channel_id": null,
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

        // Check if the participant actually reconnected to the LiveKit room.
        // Query LiveKit directly — this is the ground truth for connection status.
        if state_clone
            .voice
            .is_participant_in_livekit_room(channel_id, guild_id, user_id)
            .await
        {
            tracing::debug!(
                "LiveKit participant_left grace period expired: user {} still in LiveKit room for channel {}, skipping removal",
                user_id, channel_id
            );
            return;
        }

        tracing::info!(
            "LiveKit participant_left confirmed: removing user {} from channel {}",
            user_id,
            channel_id
        );

        let _ =
            paracord_db::voice_states::remove_voice_state(&state_clone.db, user_id, guild_id).await;
        let participants = state_clone.voice.leave_room(channel_id, user_id).await;
        if let Some(current) = participants {
            if current.is_empty() {
                let _ = state_clone.voice.cleanup_room(channel_id).await;
            }
        }

        let user = paracord_db::users::get_user_by_id(&state_clone.db, user_id)
            .await
            .ok()
            .flatten();
        state_clone.event_bus.dispatch(
            "VOICE_STATE_UPDATE",
            json!({
                "user_id": user_id.to_string(),
                "channel_id": null,
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

    #[test]
    fn webhook_auth_accepts_valid_bearer() {
        let headers = bearer_header("secret-1", "api-key-1", None);
        let result = verify_livekit_webhook_auth(&headers, b"{}", "api-key-1", "secret-1");
        assert!(result.is_ok());
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
