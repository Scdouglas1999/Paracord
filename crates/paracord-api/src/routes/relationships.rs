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

    // Check if this is a block request
    let rel_type = body.rel_type.unwrap_or(1);
    if rel_type == 2 {
        // Block: store directly
        paracord_db::relationships::create_relationship(&state.db, auth.user_id, target_id, 2)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        return Ok(StatusCode::NO_CONTENT);
    }

    // Check if the target already sent us a pending request
    let incoming = paracord_db::relationships::get_relationship(&state.db, target_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

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
    // Delete both directions so the relationship is fully cleaned up
    paracord_db::relationships::delete_relationship(&state.db, auth.user_id, target_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    paracord_db::relationships::delete_relationship(&state.db, target_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // Notify both users
    state.event_bus.dispatch_to_users(
        "RELATIONSHIP_REMOVE",
        json!({ "user_id": auth.user_id.to_string() }),
        vec![target_id],
    );
    state.event_bus.dispatch_to_users(
        "RELATIONSHIP_REMOVE",
        json!({ "user_id": target_id.to_string() }),
        vec![auth.user_id],
    );

    Ok(StatusCode::NO_CONTENT)
}
