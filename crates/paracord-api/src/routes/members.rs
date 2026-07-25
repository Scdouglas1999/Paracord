use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use paracord_core::AppState;
use paracord_federation::client::FederationLeaveRequest;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;
use crate::routes::audit;
use crate::routes::mod_log;

/// Reject a role the actor is not allowed to hand out: never ADMINISTRATOR, and
/// never a role carrying a permission bit the actor does not already hold.
///
/// Shared with every other surface that can cause a role to be granted (e.g.
/// the economy level-role mapping), so a lesser-privileged moderator cannot use
/// an indirect grant path to escalate themselves or others.
pub(crate) fn validate_member_role_assignment(
    guild_owner_id: i64,
    actor_user_id: i64,
    actor_perms: paracord_models::permissions::Permissions,
    role: &paracord_db::roles::RoleRow,
) -> Result<(), ApiError> {
    if actor_user_id == guild_owner_id || actor_perms.contains(Permissions::ADMINISTRATOR) {
        return Ok(());
    }
    if role.permissions & Permissions::ADMINISTRATOR.bits() != 0 {
        return Err(ApiError::Forbidden);
    }
    let disallowed = role.permissions & !actor_perms.bits();
    if disallowed != 0 {
        return Err(ApiError::Forbidden);
    }
    Ok(())
}

pub async fn list_members(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    let members = paracord_db::members::get_guild_members(&state.db, guild_id, 1000, None)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let roles_by_user = paracord_db::roles::get_member_roles_for_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let mut result: Vec<Value> = Vec::with_capacity(members.len());
    for m in members {
        let role_ids: Vec<String> = roles_by_user
            .get(&m.user_id)
            .map(|roles| roles.iter().map(|r| r.id.to_string()).collect())
            .unwrap_or_default();
        result.push(json!({
            "user_id": m.user_id.to_string(),
            "guild_id": guild_id.to_string(),
            "nick": m.nick,
            "joined_at": m.joined_at.to_rfc3339(),
            "deaf": m.deaf,
            "mute": m.mute,
            "communication_disabled_until": m.communication_disabled_until.map(|v| v.to_rfc3339()),
            "roles": role_ids,
            "user": {
                "id": m.user_id.to_string(),
                "username": m.username,
                "display_name": m.user_display_name,
                "discriminator": m.discriminator,
                "avatar_hash": m.user_avatar_hash,
                "flags": m.user_flags,
                "bot": paracord_core::is_bot(m.user_flags),
                "system": false,
            }
        }));
    }

    Ok(Json(json!(result)))
}

#[derive(Deserialize)]
pub struct UpdateMemberRequest {
    pub nick: Option<String>,
    pub roles: Option<Vec<String>>,
    pub communication_disabled_until: Option<String>,
}

pub async fn update_member(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, user_id)): Path<(i64, i64)>,
    Json(body): Json<UpdateMemberRequest>,
) -> Result<Json<Value>, ApiError> {
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let actor_roles = paracord_db::roles::get_member_roles(&state.db, auth.user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let actor_perms = paracord_core::permissions::compute_permissions_from_roles(
        &actor_roles,
        guild.owner_id,
        auth.user_id,
    );

    // The actor must be a member of the guild, and the target must exist as a
    // member (404 otherwise) — mutating a non-member would silently insert a
    // row for a user who never joined.
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
    let target_member = paracord_db::members::get_member(&state.db, user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if body.nick.is_some() && auth.user_id != user_id {
        paracord_core::permissions::require_permission(
            actor_perms,
            paracord_models::permissions::Permissions::MANAGE_NICKNAMES,
        )?;
        // Renaming another member is a moderation action and must obey the same
        // owner immunity and role hierarchy as kick/ban/timeout. The bare
        // MANAGE_NICKNAMES check let a junior moderator rename the guild owner
        // or anyone ranked above them.
        paracord_core::admin::ensure_actor_can_moderate_target(
            &state.db,
            guild_id,
            auth.user_id,
            user_id,
        )
        .await?;
    }

    let mut role_ids: Vec<String> =
        paracord_db::roles::get_member_roles(&state.db, user_id, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .iter()
            .map(|role| role.id.to_string())
            .collect();

    if let Some(raw_roles) = body.roles {
        paracord_core::permissions::require_permission(actor_perms, Permissions::MANAGE_ROLES)?;

        let guild_roles = paracord_db::roles::get_guild_roles(&state.db, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        let role_by_id: std::collections::HashMap<i64, paracord_db::roles::RoleRow> = guild_roles
            .iter()
            .cloned()
            .map(|role| (role.id, role))
            .collect();
        let requested_role_ids: Vec<i64> = raw_roles
            .iter()
            .map(|r| {
                r.parse::<i64>()
                    .map_err(|_| ApiError::BadRequest("Invalid role id".into()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if requested_role_ids
            .iter()
            .any(|role_id| !role_by_id.contains_key(role_id))
        {
            return Err(ApiError::BadRequest(
                "One or more roles do not belong to this guild".into(),
            ));
        }

        let existing_roles = paracord_db::roles::get_member_roles(&state.db, user_id, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

        let mut requested_ids: std::collections::HashSet<i64> =
            requested_role_ids.iter().copied().collect();
        requested_ids.insert(guild_id); // Member role is always required
        let existing_ids: std::collections::HashSet<i64> =
            existing_roles.iter().map(|r| r.id).collect();

        if auth.user_id != guild.owner_id {
            let actor_top_role_pos = actor_roles.iter().map(|r| r.position).max().unwrap_or(0);
            // Hierarchy is enforced on both the roles being added/kept AND the
            // roles being removed: a non-owner may not manage (assign or strip)
            // a role at or above their own top position. Checking only the
            // add/keep set would let a lower-ranked MANAGE_ROLES actor demote a
            // higher-ranked member by omitting their superior role.
            for role_id in requested_ids
                .iter()
                .chain(existing_ids.difference(&requested_ids))
            {
                if *role_id == guild_id {
                    continue;
                }
                let Some(role) = role_by_id.get(role_id) else {
                    continue;
                };
                if role.position >= actor_top_role_pos {
                    return Err(ApiError::Forbidden);
                }
                validate_member_role_assignment(guild.owner_id, auth.user_id, actor_perms, role)?;
            }
        }

        for role_id in requested_ids.difference(&existing_ids) {
            paracord_db::roles::add_member_role(&state.db, user_id, guild_id, *role_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        }
        for role_id in existing_ids.difference(&requested_ids) {
            if *role_id != guild_id {
                paracord_db::roles::remove_member_role(&state.db, user_id, guild_id, *role_id)
                    .await
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            }
        }

        // Invalidate permission cache when a user's roles change
        paracord_core::permissions::invalidate_user(&state.permission_cache, user_id).await;

        role_ids = paracord_db::roles::get_member_roles(&state.db, user_id, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .iter()
            .map(|role| role.id.to_string())
            .collect();
    }

    let mut timed_out_until = target_member.communication_disabled_until;
    let touched_timeout = body.communication_disabled_until.is_some();
    if let Some(raw_until) = body.communication_disabled_until {
        let parsed = if raw_until.trim().is_empty() {
            None
        } else {
            Some(
                chrono::DateTime::parse_from_rfc3339(&raw_until)
                    .map_err(|_| {
                        ApiError::BadRequest("Invalid communication_disabled_until".into())
                    })?
                    .with_timezone(&chrono::Utc),
            )
        };
        let member = paracord_core::admin::timeout_member(
            &state.db,
            guild_id,
            auth.user_id,
            user_id,
            parsed,
        )
        .await?;
        timed_out_until = member.communication_disabled_until;
    }

    // Apply the nickname change only after every authorization branch above has
    // passed, so a rejected role/timeout/nickname request never leaves a
    // partially-applied nick mutation behind.
    let updated = paracord_db::members::update_member(
        &state.db,
        user_id,
        guild_id,
        body.nick.as_deref(),
        None,
        None,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let member_json = json!({
        "guild_id": guild_id.to_string(),
        "user_id": updated.user_id.to_string(),
        "nick": updated.nick,
        "deaf": updated.deaf,
        "mute": updated.mute,
        "communication_disabled_until": timed_out_until.map(|v| v.to_rfc3339()),
        "joined_at": updated.joined_at.to_rfc3339(),
        "roles": role_ids.clone(),
    });

    state.event_bus.dispatch(
        "GUILD_MEMBER_UPDATE",
        json!({
            "guild_id": guild_id.to_string(),
            "user_id": user_id.to_string(),
            "nick": updated.nick,
            "communication_disabled_until": timed_out_until.map(|v| v.to_rfc3339()),
            "roles": role_ids.clone(),
        }),
        Some(guild_id),
    );
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_MEMBER_UPDATE,
        Some(user_id),
        None,
        Some(json!({
            "nick": updated.nick,
            "communication_disabled_until": timed_out_until.map(|v| v.to_rfc3339()),
            "roles": role_ids,
        })),
    )
    .await;

    if touched_timeout {
        mod_log::emit_mod_log(
            &state,
            guild_id,
            "Member Timeout Updated",
            "A member timeout/mute state was changed.",
            &[
                ("Actor", auth.user_id.to_string()),
                ("Target", user_id.to_string()),
                (
                    "Timeout Until",
                    timed_out_until
                        .map(|v| v.to_rfc3339())
                        .unwrap_or_else(|| "cleared".to_string()),
                ),
            ],
        )
        .await;
    }

    Ok(Json(member_json))
}

pub async fn kick_member(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, user_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    paracord_core::admin::kick_member(&state.db, guild_id, auth.user_id, user_id).await?;

    // Terminate any in-progress voice/video call the kicked member is part of so
    // they stop eavesdropping on and injecting into the call.
    crate::routes::voice::evict_user_from_guild_media(&state, guild_id, user_id).await;

    // Evict the removed member's cached channel permissions so a stale cache hit
    // cannot keep granting access for the remainder of the cache TTL.
    paracord_core::permissions::invalidate_user(&state.permission_cache, user_id).await;

    state.member_index.remove_member(guild_id, user_id);
    state.event_bus.dispatch(
        "GUILD_MEMBER_REMOVE",
        json!({
            "guild_id": guild_id.to_string(),
            "user_id": user_id.to_string(),
        }),
        Some(guild_id),
    );
    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_MEMBER_KICK,
        Some(user_id),
        None,
        None,
    )
    .await;

    mod_log::emit_mod_log(
        &state,
        guild_id,
        "Member Kicked",
        "A member was removed from the server.",
        &[
            ("Actor", auth.user_id.to_string()),
            ("Target", user_id.to_string()),
        ],
    )
    .await;

    if paracord_federation::is_enabled() {
        let fed_state = state.clone();
        tokio::spawn(async move {
            federation_send_leave_rpc_for_mirrored_guild(&fed_state, guild_id, user_id).await;
            federation_forward_member_event(&fed_state, "m.member.leave", guild_id, user_id).await;
        });
    }

    Ok(StatusCode::NO_CONTENT)
}

pub async fn leave_guild(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    // Check that user is not the owner
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if guild.owner_id == auth.user_id {
        return Err(ApiError::BadRequest(
            "Cannot leave a guild you own. Transfer ownership or delete the guild.".into(),
        ));
    }

    paracord_db::members::remove_member(&state.db, auth.user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // Terminate any in-progress voice/video call the leaving member is part of.
    crate::routes::voice::evict_user_from_guild_media(&state, guild_id, auth.user_id).await;

    // Evict the leaving member's cached channel permissions so a stale cache hit
    // cannot keep granting access for the remainder of the cache TTL.
    paracord_core::permissions::invalidate_user(&state.permission_cache, auth.user_id).await;

    state.member_index.remove_member(guild_id, auth.user_id);
    state.event_bus.dispatch(
        "GUILD_MEMBER_REMOVE",
        json!({
            "guild_id": guild_id.to_string(),
            "user_id": auth.user_id.to_string(),
        }),
        Some(guild_id),
    );

    if paracord_federation::is_enabled() {
        let fed_state = state.clone();
        let leaving_user_id = auth.user_id;
        tokio::spawn(async move {
            federation_send_leave_rpc_for_mirrored_guild(&fed_state, guild_id, leaving_user_id)
                .await;
            federation_forward_member_event(
                &fed_state,
                "m.member.leave",
                guild_id,
                leaving_user_id,
            )
            .await;
        });
    }

    Ok(StatusCode::NO_CONTENT)
}

/// PUT /guilds/{guild_id}/members/@me — invite-less join for public discoverable guilds.
pub async fn join_public_guild(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if !guild.visibility.eq_ignore_ascii_case("public") {
        return Err(ApiError::Forbidden);
    }
    if !paracord_db::guilds::parse_allowed_role_ids(&guild.allowed_roles).is_empty() {
        return Err(ApiError::Forbidden);
    }

    if paracord_db::members::get_member(&state.db, auth.user_id, guild_id)
        .await
        .ok()
        .flatten()
        .is_some()
    {
        let member_count = paracord_db::members::get_member_count(&state.db, guild_id)
            .await
            .unwrap_or(0);
        return Ok(Json(crate::routes::guilds::guild_json(
            &guild,
            Some(member_count),
        )));
    }

    // Block users currently banned from this guild from silently rejoining. A
    // ban removes the member row, so a banned user reaches this non-member path;
    // without this check they could evade the ban by self-joining the public
    // guild. Mirrors the invite-accept path (invites.rs::accept_invite).
    let banned = paracord_db::bans::get_ban(&state.db, auth.user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .is_some();
    if banned {
        return Err(ApiError::Forbidden);
    }

    // Honor an active anti-raid lockdown, matching accept_invite parity so the
    // invite-less join path can't be used to slip past a lockdown.
    let now_ms = chrono::Utc::now().timestamp_millis();
    let bot_settings_json: Value = guild
        .bot_settings
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_else(|| json!({}));
    let anti_raid_config = bot_settings_json
        .get("auto_mod")
        .and_then(|value| value.get("anti_raid"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let anti_raid_enabled = anti_raid_config
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if anti_raid_enabled {
        let locked_until_ms = match anti_raid_config.get("lockdown_until_ms") {
            Some(Value::Number(raw)) => raw.as_i64().unwrap_or(0),
            Some(Value::String(raw)) => raw.parse::<i64>().unwrap_or(0),
            _ => 0,
        };
        if locked_until_ms > now_ms {
            return Err(ApiError::BadRequest(
                "Server is temporarily in raid lockdown".into(),
            ));
        }
    }

    paracord_db::members::add_member(&state.db, auth.user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let _ = paracord_db::roles::add_member_role(&state.db, auth.user_id, guild_id, guild_id).await;

    state.member_index.add_member(guild_id, auth.user_id);

    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .ok()
        .flatten();
    if let Some(user) = user {
        state.event_bus.dispatch(
            "GUILD_MEMBER_ADD",
            json!({
                "guild_id": guild_id.to_string(),
                "user": {
                    "id": user.id.to_string(),
                    "username": user.username,
                    "display_name": user.display_name,
                    "discriminator": user.discriminator,
                    "avatar_hash": user.avatar_hash,
                }
            }),
            Some(guild_id),
        );
    }

    let member_count = paracord_db::members::get_member_count(&state.db, guild_id)
        .await
        .unwrap_or(0);
    Ok(Json(crate::routes::guilds::guild_json(
        &guild,
        Some(member_count),
    )))
}

pub(crate) async fn federation_forward_member_event(
    state: &AppState,
    event_type: &str,
    guild_id: i64,
    user_id: i64,
) {
    let user = match paracord_db::users::get_user_by_id(&state.db, user_id).await {
        Ok(Some(user)) => user,
        _ => return,
    };

    let service = crate::routes::federation::build_federation_service();
    if !service.is_enabled() {
        return;
    }

    let outbound =
        crate::routes::federation::resolve_outbound_context(state, &service, guild_id, None).await;
    let content = json!({
        "guild_id": outbound.payload_guild_id.clone(),
        "user_id": user_id.to_string(),
    });
    let envelope = match service.build_custom_envelope(
        event_type,
        outbound.room_id.clone(),
        &user.username,
        &content,
        chrono::Utc::now().timestamp_millis(),
        None,
        Some(&format!("{}:{}", outbound.payload_guild_id, user_id)),
    ) {
        Ok(env) => env,
        Err(_) => return,
    };

    let _ = service.persist_event(&state.db, &envelope).await;
    service
        .forward_envelope_to_peers(&state.db, &envelope)
        .await;
}

pub(crate) async fn federation_send_leave_rpc_for_mirrored_guild(
    state: &AppState,
    guild_id: i64,
    user_id: i64,
) {
    let service = crate::routes::federation::build_federation_service();
    if !service.is_enabled() {
        return;
    }

    let outbound =
        crate::routes::federation::resolve_outbound_context(state, &service, guild_id, None).await;
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
        tracing::warn!("federation: signed client unavailable for leave rpc");
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

    let payload = FederationLeaveRequest {
        origin_server: service.server_name().to_string(),
        room_id: outbound.room_id,
        user_id: local_identity,
    };
    if let Err(err) = client.send_leave(&peer.federation_endpoint, &payload).await {
        tracing::warn!(
            "federation: leave rpc failed for mirrored guild {} -> {} ({}): {}",
            guild_id,
            peer.server_name,
            peer.domain,
            err
        );
    }
}
