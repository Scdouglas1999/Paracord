use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use paracord_core::AppState;
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
        paracord_db::guilds::get_guild(&state.db, sid).await.ok().flatten()
    } else {
        None
    };
    let member_count = paracord_db::members::get_server_member_count(&state.db)
        .await
        .unwrap_or(0);

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
    let space_id = channel.guild_id().unwrap_or(0);

    let already_member = paracord_db::members::get_server_member(&state.db, auth.user_id)
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
        // Add user as server member
        paracord_db::members::add_server_member(&state.db, auth.user_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

        // Assign @everyone role (role id = space id)
        if let Err(e) = paracord_db::roles::add_member_role(
            &state.db,
            auth.user_id,
            space_id,
            space_id,
        )
        .await
        {
            tracing::warn!("Failed to assign @everyone role: {e}");
        }
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

    let member_count = paracord_db::members::get_server_member_count(&state.db)
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
        state.event_bus.dispatch(
            "GUILD_MEMBER_ADD",
            json!({"guild_id": guild.id.to_string(), "user_id": auth.user_id.to_string()}),
            Some(guild.id),
        );
    }

    Ok(Json(json!({ "guild": guild_json })))
}

pub async fn list_guild_invites(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

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
    let space_id = channel.guild_id().unwrap_or(0);
    let guild = paracord_db::guilds::get_guild(&state.db, space_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let roles = paracord_db::roles::get_member_roles(&state.db, auth.user_id, space_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let perms =
        paracord_core::permissions::compute_permissions_from_roles(&roles, guild.owner_id, auth.user_id);
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
