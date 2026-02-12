use axum::{extract::State, http::StatusCode, Json};
use paracord_core::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub username: String,
    pub password: String,
    pub display_name: Option<String>,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: Value,
}

pub async fn register(
    State(state): State<AppState>,
    Json(body): Json<RegisterRequest>,
) -> Result<(StatusCode, Json<AuthResponse>), ApiError> {
    // Check runtime settings for registration status
    if !state.runtime.read().await.registration_enabled {
        return Err(ApiError::Forbidden);
    }

    if body.username.len() < 2 || body.username.len() > 32 {
        return Err(ApiError::BadRequest(
            "Username must be between 2 and 32 characters".into(),
        ));
    }

    if body.password.len() < 8 {
        return Err(ApiError::BadRequest(
            "Password must be at least 8 characters".into(),
        ));
    }

    let existing = paracord_db::users::get_user_by_email(&state.db, &body.email)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    if existing.is_some() {
        return Err(ApiError::Conflict("Email already registered".into()));
    }

    let password_hash = paracord_core::auth::hash_password(&body.password)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let id = paracord_util::snowflake::generate(1);
    let mut user = paracord_db::users::create_user(
        &state.db,
        id,
        &body.username,
        0,
        &body.email,
        &password_hash,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // Auto-add as server-wide member + assign @everyone roles for all spaces
    paracord_db::members::add_server_member(&state.db, user.id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if let Ok(spaces) = paracord_db::guilds::list_all_spaces(&state.db).await {
        for space in &spaces {
            // @everyone role ID == space ID
            let _ = paracord_db::roles::add_member_role(&state.db, user.id, space.id, space.id).await;
        }
    }

    // First registered user becomes server admin
    let user_count = paracord_db::users::count_users(&state.db)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if user_count == 1 {
        user = paracord_db::users::update_user_flags(
            &state.db,
            user.id,
            user.flags | paracord_core::USER_FLAG_ADMIN,
        )
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    }

    if let Some(display_name) = body.display_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        user = paracord_db::users::update_user(
            &state.db,
            user.id,
            Some(display_name),
            None,
            None,
        )
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    }

    let token = paracord_core::auth::create_token(
        user.id,
        &state.config.jwt_secret,
        state.config.jwt_expiry_seconds,
    )
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok((
        StatusCode::CREATED,
        Json(AuthResponse {
            token,
            user: json!({
                "id": user.id.to_string(),
                "username": user.username,
                "email": user.email,
                "avatar_hash": user.avatar_hash,
                "display_name": user.display_name,
                "discriminator": user.discriminator,
                "flags": user.flags,
            }),
        }),
    ))
}

pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginRequest>,
) -> Result<Json<AuthResponse>, ApiError> {
    let user = paracord_db::users::get_user_by_email(&state.db, &body.email)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::Unauthorized)?;

    let valid = paracord_core::auth::verify_password(&body.password, &user.password_hash)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    if !valid {
        return Err(ApiError::Unauthorized);
    }

    let token = paracord_core::auth::create_token(
        user.id,
        &state.config.jwt_secret,
        state.config.jwt_expiry_seconds,
    )
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(AuthResponse {
        token,
        user: json!({
            "id": user.id.to_string(),
            "username": user.username,
            "email": user.email,
            "avatar_hash": user.avatar_hash,
            "display_name": user.display_name,
            "discriminator": user.discriminator,
            "flags": user.flags,
        }),
    }))
}

pub async fn refresh(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let token = paracord_core::auth::create_token(
        auth.user_id,
        &state.config.jwt_secret,
        state.config.jwt_expiry_seconds,
    )
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!({ "token": token })))
}
