use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use paracord_core::AppState;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;

#[derive(Deserialize)]
pub struct CreateRelationshipRequest {
    pub user_id: Option<String>,
    pub username: Option<String>,
    #[serde(rename = "type")]
    pub rel_type: Option<i16>,
}

pub async fn list_relationships(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let rels = paracord_db::relationships::get_relationships(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let result: Vec<Value> = rels
        .iter()
        .map(|r| {
            json!({
                "id": format!("{}:{}", r.user_id, r.target_id),
                "user_id": r.user_id.to_string(),
                "target_id": r.target_id.to_string(),
                "type": r.rel_type,
                "rel_type": r.rel_type,
                "created_at": r.created_at.to_rfc3339(),
                "user": {
                    "id": r.target_id.to_string(),
                    "username": r.target_username,
                    "display_name": r.target_display_name,
                    "discriminator": r.target_discriminator,
                    "avatar_hash": r.target_avatar_hash,
                }
            })
        })
        .collect();

    Ok(Json(json!(result)))
}

pub async fn add_friend(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<CreateRelationshipRequest>,
) -> Result<StatusCode, ApiError> {
    let target_id: i64 = if let Some(user_id) = body.user_id.as_deref() {
        user_id
            .parse()
            .map_err(|_| ApiError::BadRequest("Invalid user ID".into()))?
    } else if let Some(username) = body.username.as_deref() {
        let user = paracord_db::users::get_user_by_username_only(&state.db, username)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        let Some(user) = user else {
            // Return an indistinguishable success response to reduce account enumeration.
            return Ok(StatusCode::NO_CONTENT);
        };
        user.id
    } else {
        return Err(ApiError::BadRequest(
            "Either user_id or username must be provided".into(),
        ));
    };

    if target_id == auth.user_id {
        return Err(ApiError::BadRequest(
            "Cannot add yourself as a friend".into(),
        ));
    }

    // Only "friend" (1) and "block" (2) are valid request types. Friend requests
    // are represented internally as an outgoing-pending row (type=4); callers must
    // not be able to inject arbitrary rel_type values.
    let rel_type = body.rel_type.unwrap_or(1);
    if !matches!(rel_type, 1 | 2) {
        return Err(ApiError::BadRequest("Invalid relationship type".into()));
    }

    if rel_type == 2 {
        // Block: normalize the reverse direction (drop any friend/pending row the
        // target had toward us) before recording the block for our direction.
        paracord_db::relationships::delete_relationship(&state.db, target_id, auth.user_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        paracord_db::relationships::create_relationship(&state.db, auth.user_id, target_id, 2)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

        // Tell the (now ex-)friend to drop us from their relationship list.
        state.event_bus.dispatch_to_users(
            "RELATIONSHIP_REMOVE",
            json!({ "user_id": auth.user_id.to_string() }),
            vec![target_id],
        );
        return Ok(StatusCode::NO_CONTENT);
    }

    // Friend request. Load the target's row toward us first: if they blocked the
    // requester, refuse and create no row.
    let incoming = paracord_db::relationships::get_relationship(&state.db, target_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if incoming.as_ref().map(|r| r.rel_type) == Some(2) {
        return Err(ApiError::Forbidden);
    }

    // Short-circuit when a relationship already exists in our direction so the
    // request is idempotent (and cannot silently overwrite a block we placed).
    let outgoing = paracord_db::relationships::get_relationship(&state.db, auth.user_id, target_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if let Some(rel) = outgoing {
        match rel.rel_type {
            // Already friends, or an outgoing request is already pending.
            1 | 4 => return Ok(StatusCode::NO_CONTENT),
            // We have the target blocked — they must be unblocked via DELETE first.
            2 => return Err(ApiError::Forbidden),
            _ => {}
        }
    }

    if let Some(rel) = incoming {
        if rel.rel_type == 4 {
            // They already sent us a request — auto-accept: make both friends
            paracord_db::relationships::update_relationship(&state.db, target_id, auth.user_id, 1)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            paracord_db::relationships::create_relationship(&state.db, auth.user_id, target_id, 1)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

            // Notify both users
            let target_user = paracord_db::users::get_user_by_id(&state.db, target_id)
                .await
                .ok()
                .flatten();
            let self_user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
                .await
                .ok()
                .flatten();

            if let Some(tu) = &target_user {
                state.event_bus.dispatch_to_users(
                    "RELATIONSHIP_ADD",
                    json!({
                        "type": 1,
                        "user": {
                            "id": tu.id.to_string(),
                            "username": tu.username,
                            "display_name": tu.display_name,
                            "discriminator": tu.discriminator,
                            "avatar_hash": tu.avatar_hash,
                        }
                    }),
                    vec![auth.user_id],
                );
            }
            if let Some(su) = &self_user {
                state.event_bus.dispatch_to_users(
                    "RELATIONSHIP_ADD",
                    json!({
                        "type": 1,
                        "user": {
                            "id": su.id.to_string(),
                            "username": su.username,
                            "display_name": su.display_name,
                            "discriminator": su.discriminator,
                            "avatar_hash": su.avatar_hash,
                        }
                    }),
                    vec![target_id],
                );
            }

            return Ok(StatusCode::NO_CONTENT);
        }
    }

    // No incoming request — create outgoing pending (type=4)
    paracord_db::relationships::create_relationship(&state.db, auth.user_id, target_id, 4)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // Notify target of incoming request
    let self_user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .ok()
        .flatten();
    if let Some(su) = &self_user {
        state.event_bus.dispatch_to_users(
            "RELATIONSHIP_ADD",
            json!({
                "type": 3,
                "user": {
                    "id": su.id.to_string(),
                    "username": su.username,
                    "display_name": su.display_name,
                    "discriminator": su.discriminator,
                    "avatar_hash": su.avatar_hash,
                }
            }),
            vec![target_id],
        );
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Accept an incoming friend request.
pub async fn accept_friend(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(user_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    // Verify there is a pending incoming request (user_id sent type=4 to us)
    let rel = paracord_db::relationships::get_relationship(&state.db, user_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    match rel {
        Some(r) if r.rel_type == 4 => {}
        _ => {
            return Err(ApiError::BadRequest(
                "No pending friend request from this user".into(),
            ));
        }
    }

    // Accept: update their row to friend, create our row as friend
    paracord_db::relationships::update_relationship(&state.db, user_id, auth.user_id, 1)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    paracord_db::relationships::create_relationship(&state.db, auth.user_id, user_id, 1)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // Notify both users
    let target_user = paracord_db::users::get_user_by_id(&state.db, user_id)
        .await
        .ok()
        .flatten();
    let self_user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .ok()
        .flatten();

    if let Some(tu) = &target_user {
        state.event_bus.dispatch_to_users(
            "RELATIONSHIP_ADD",
            json!({
                "type": 1,
                "user": {
                    "id": tu.id.to_string(),
                    "username": tu.username,
                    "display_name": tu.display_name,
                    "discriminator": tu.discriminator,
                    "avatar_hash": tu.avatar_hash,
                }
            }),
            vec![auth.user_id],
        );
    }
    if let Some(su) = &self_user {
        state.event_bus.dispatch_to_users(
            "RELATIONSHIP_ADD",
            json!({
                "type": 1,
                "user": {
                    "id": su.id.to_string(),
                    "username": su.username,
                    "display_name": su.display_name,
                    "discriminator": su.discriminator,
                    "avatar_hash": su.avatar_hash,
                }
            }),
            vec![user_id],
        );
    }

    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove_relationship(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(target_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    // Always clear our own row toward the target. This covers unfriend,
    // cancel-outgoing-request, and unblock-our-own-block.
    paracord_db::relationships::delete_relationship(&state.db, auth.user_id, target_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // The reverse row (target -> us) may only be cleared when it is a mutual
    // friendship (type=1) or a pending request (type=4) — the housekeeping half
    // of a mutual unfriend / decline / cancel. A block the target placed on us
    // (type=2) must be preserved: a blocked user must not be able to clear the
    // blocker's block by "removing" the relationship.
    let reverse =
        paracord_db::relationships::get_relationship(&state.db, target_id, auth.user_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let reverse_removed = matches!(reverse.as_ref().map(|r| r.rel_type), Some(1) | Some(4));
    if reverse_removed {
        paracord_db::relationships::delete_relationship(&state.db, target_id, auth.user_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    }

    // Notify the target only if their own relationship state actually changed.
    if reverse_removed {
        state.event_bus.dispatch_to_users(
            "RELATIONSHIP_REMOVE",
            json!({ "user_id": auth.user_id.to_string() }),
            vec![target_id],
        );
    }
    // Our own row was deleted, so always notify us.
    state.event_bus.dispatch_to_users(
        "RELATIONSHIP_REMOVE",
        json!({ "user_id": target_id.to_string() }),
        vec![auth.user_id],
    );

    Ok(StatusCode::NO_CONTENT)
}
