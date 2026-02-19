use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use paracord_core::AppState;
use paracord_federation::client::{FederationInviteRequest, FederationJoinRequest};
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;
use crate::routes::audit;

#[derive(Deserialize)]
pub struct CreateInviteRequest {
    #[serde(default = "default_max_uses")]
    pub max_uses: i32,
    #[serde(default = "default_max_age")]
    pub max_age: i32,
}

fn default_max_uses() -> i32 {
    0
}
fn default_max_age() -> i32 {
    86400
}

async fn federation_send_join_rpc_for_mirrored_guild(
    state: &AppState,
    guild_id: i64,
    channel_id: i64,
    user_id: i64,
    max_age_seconds: Option<i64>,
) {
    let service = crate::routes::federation::build_federation_service();
    if !service.is_enabled() {
        return;
    }

    let outbound = crate::routes::federation::resolve_outbound_context(
        state,
        &service,
        guild_id,
        Some(channel_id),
    )
    .await;
    if !outbound.uses_remote_mapping {
        return;
    }

    let Some(peer) =
        crate::routes::federation::resolve_remote_target_for_outbound_context(state, &outbound)
            .await
    else {
        tracing::warn!(
            "federation: no trusted remote origin for mirrored guild {} (namespace {:?})",
            guild_id,
            outbound.origin_server
        );
        return;
    };

    let Some(client) = crate::routes::federation::build_signed_federation_client(&service) else {
        tracing::warn!("federation: signed client unavailable for join rpc");
        return;
    };
    let Some(local_identity) =
        crate::routes::federation::local_federated_user_id(state, &service, user_id).await
    else {
        tracing::warn!(
            "federation: cannot build local federated identity for user {}",
            user_id
        );
        return;
    };

    let mut room_id = outbound.room_id.clone();
    let invite_payload = FederationInviteRequest {
        origin_server: service.server_name().to_string(),
        room_id: room_id.clone(),
        sender: local_identity.clone(),
        max_age_seconds,
    };
    match client
        .send_invite(&peer.federation_endpoint, &invite_payload)
        .await
    {
        Ok(resp) if resp.accepted => {
            if !resp.room_id.trim().is_empty() {
                room_id = resp.room_id;
            }
        }
        Ok(_) => {
            tracing::warn!(
                "federation: mirrored invite for guild {} was not accepted by {}",
                guild_id,
                peer.server_name
            );
        }
        Err(err) => {
            tracing::warn!(
                "federation: invite rpc failed for mirrored guild {} -> {} ({}): {}",
                guild_id,
                peer.server_name,
                peer.domain,
                err
            );
        }
    }

    let join_payload = FederationJoinRequest {
        origin_server: service.server_name().to_string(),
        room_id,
        user_id: local_identity,
    };
    if let Err(err) = client
        .send_join(&peer.federation_endpoint, &join_payload)
        .await
    {
        tracing::warn!(
            "federation: join rpc failed for mirrored guild {} -> {} ({}): {}",
            guild_id,
            peer.server_name,
            peer.domain,
            err
        );
    }
}

pub async fn create_invite(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<CreateInviteRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let space_id = channel
        .guild_id()
        .ok_or(ApiError::BadRequest("Cannot create invite for DM".into()))?;

    paracord_core::permissions::ensure_guild_member(&state.db, space_id, auth.user_id).await?;
    let guild = paracord_db::guilds::get_guild(&state.db, space_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let perms = paracord_core::permissions::compute_channel_permissions(
        &state.db,
        space_id,
        channel_id,
        guild.owner_id,
        auth.user_id,
    )
    .await?;
    paracord_core::permissions::require_permission(perms, Permissions::CREATE_INSTANT_INVITE)?;

    let code = paracord_core::guild::generate_invite_code(8);

    let invite = paracord_db::invites::create_invite(
        &state.db,
        &code,
        space_id,
        channel_id,
        auth.user_id,
        Some(body.max_uses),
        Some(body.max_age),
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    audit::log_action(
        &state,
        space_id,
        auth.user_id,
        audit::ACTION_INVITE_CREATE,
        None,
        None,
        Some(json!({
            "code": invite.code,
            "channel_id": invite.channel_id.to_string(),
        })),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "code": invite.code,
            "guild_id": space_id.to_string(),
            "channel_id": invite.channel_id.to_string(),
            "inviter_id": invite.inviter_id.map(|id| id.to_string()),
            "max_uses": invite.max_uses,
            "uses": invite.uses,
            "max_age": invite.max_age,
            "created_at": invite.created_at.to_rfc3339(),
        })),
    ))
}

pub async fn get_invite(
    State(state): State<AppState>,
    Path(code): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let invite = paracord_db::invites::get_invite(&state.db, &code)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    // Look up the space via the invite's channel
    let channel = paracord_db::channels::get_channel(&state.db, invite.channel_id)
        .await
        .ok()
        .flatten();
    let space_id = channel.and_then(|c| c.guild_id());
    let guild = if let Some(sid) = space_id {
        paracord_db::guilds::get_guild(&state.db, sid)
            .await
            .ok()
            .flatten()
    } else {
        None
    };
    let member_count = paracord_db::members::get_server_member_count(&state.db)
        .await
        .unwrap_or(0);
    let member_count = if let Some(sid) = space_id {
        paracord_db::members::get_member_count(&state.db, sid)
            .await
            .unwrap_or(member_count)
    } else {
        member_count
    };

    Ok(Json(json!({
        "code": invite.code,
        "guild": guild.map(|g| json!({
            "id": g.id.to_string(),
            "name": g.name,
            "icon_hash": g.icon_hash,
            "member_count": member_count,
        })),
    })))
}

pub async fn accept_invite(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(code): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let preview = paracord_db::invites::get_invite(&state.db, &code)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    // Resolve the space from the invite's channel
    let channel = paracord_db::channels::get_channel(&state.db, preview.channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let space_id = channel.guild_id().ok_or(ApiError::BadRequest(
        "Invite target must be a guild/space channel".into(),
    ))?;

    let already_member = paracord_db::members::get_member(&state.db, auth.user_id, space_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .is_some();

    let invite_state = if already_member {
        Some(preview.clone())
    } else {
        paracord_db::invites::use_invite(&state.db, &code)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    };
    let _invite = if let Some(invite) = invite_state {
        invite
    } else {
        let existing = paracord_db::invites::get_invite(&state.db, &code)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        if existing.is_none() {
            return Err(ApiError::NotFound);
        }
        return Err(ApiError::BadRequest(
            "Invite is expired or has reached max uses".into(),
        ));
    };

    if !already_member {
        // Add user membership only for the invited space.
        paracord_db::members::add_member(&state.db, auth.user_id, space_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    }

    // Ensure default Member role assignment for this space.
    if let Err(e) =
        paracord_db::roles::add_member_role(&state.db, auth.user_id, space_id, space_id).await
    {
        tracing::warn!("Failed to assign Member role: {e}");
    }

    let guild = paracord_db::guilds::get_guild(&state.db, space_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let channels = paracord_db::channels::get_guild_channels(&state.db, space_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let default_channel_id = channels
        .iter()
        .find(|c| c.channel_type == 0)
        .or_else(|| channels.first())
        .map(|c| c.id.to_string());

    let member_count = paracord_db::members::get_member_count(&state.db, space_id)
        .await
        .unwrap_or(0);

    let guild_json = json!({
        "id": guild.id.to_string(),
        "name": guild.name,
        "description": guild.description,
        "icon_hash": guild.icon_hash,
        "owner_id": guild.owner_id.to_string(),
        "created_at": guild.created_at.to_rfc3339(),
        "default_channel_id": default_channel_id,
        "member_count": member_count,
    });

    // Only dispatch GUILD_MEMBER_ADD for genuinely new members
    if !already_member {
        state.member_index.add_member(guild.id, auth.user_id);
        state.event_bus.dispatch(
            "GUILD_MEMBER_ADD",
            json!({"guild_id": guild.id.to_string(), "user_id": auth.user_id.to_string()}),
            Some(guild.id),
        );

        if paracord_federation::is_enabled() {
            let fed_state = state.clone();
            let joined_user_id = auth.user_id;
            let joined_channel_id = preview.channel_id;
            let invite_max_age = _invite.max_age.map(i64::from);
            tokio::spawn(async move {
                federation_send_join_rpc_for_mirrored_guild(
                    &fed_state,
                    guild.id,
                    joined_channel_id,
                    joined_user_id,
                    invite_max_age,
                )
                .await;
                crate::routes::members::federation_forward_member_event(
                    &fed_state,
                    "m.member.join",
                    guild.id,
                    joined_user_id,
                )
                .await;
            });
        }
    }

    Ok(Json(json!({ "guild": guild_json })))
}

pub async fn list_guild_invites(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let roles = paracord_db::roles::get_member_roles(&state.db, auth.user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let perms = paracord_core::permissions::compute_permissions_from_roles(
        &roles,
        guild.owner_id,
        auth.user_id,
    );
    paracord_core::permissions::require_permission(perms, Permissions::MANAGE_GUILD)?;

    let invites = paracord_db::invites::get_guild_invites(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let result: Vec<Value> = invites
        .iter()
        .map(|i| {
            json!({
                "code": i.code,
                "guild_id": guild_id.to_string(),
                "channel_id": i.channel_id.to_string(),
                "inviter_id": i.inviter_id.map(|id| id.to_string()),
                "max_uses": i.max_uses,
                "uses": i.uses,
                "max_age": i.max_age,
                "created_at": i.created_at.to_rfc3339(),
            })
        })
        .collect();

    Ok(Json(json!(result)))
}

pub async fn delete_invite(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(code): Path<String>,
) -> Result<StatusCode, ApiError> {
    let invite = paracord_db::invites::get_invite(&state.db, &code)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    // Resolve space from channel
    let channel = paracord_db::channels::get_channel(&state.db, invite.channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let space_id = channel.guild_id().ok_or(ApiError::BadRequest(
        "Invite target must be a guild/space channel".into(),
    ))?;
    let guild = paracord_db::guilds::get_guild(&state.db, space_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let roles = paracord_db::roles::get_member_roles(&state.db, auth.user_id, space_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let perms = paracord_core::permissions::compute_permissions_from_roles(
        &roles,
        guild.owner_id,
        auth.user_id,
    );
    paracord_core::permissions::require_permission(perms, Permissions::MANAGE_GUILD)?;
    paracord_db::invites::delete_invite(&state.db, &code)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    state.event_bus.dispatch(
        "INVITE_DELETE",
        json!({
            "code": code,
            "guild_id": space_id.to_string(),
            "channel_id": invite.channel_id.to_string(),
        }),
        Some(space_id),
    );
    audit::log_action(
        &state,
        space_id,
        auth.user_id,
        audit::ACTION_INVITE_DELETE,
        None,
        None,
        Some(json!({ "code": invite.code })),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}
