use axum::{extract::State, http::StatusCode, Json};
use paracord_core::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::OnceLock;

use crate::error::ApiError;
use crate::middleware::AuthUser;

// In-memory challenge nonce store (nonce -> timestamp). Cleaned up on each request.
static CHALLENGE_STORE: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();

fn challenge_store() -> &'static Mutex<HashMap<String, i64>> {
    CHALLENGE_STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cleanup_expired_challenges(store: &mut HashMap<String, i64>) {
    let now = chrono::Utc::now().timestamp();
    store.retain(|_, ts| (now - *ts).abs() <= 120);
}

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

// --- Public key attachment (migration for existing password-based accounts) ---

#[derive(Deserialize)]
pub struct AttachPublicKeyRequest {
    pub public_key: String,
}

pub async fn attach_public_key(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<AttachPublicKeyRequest>,
) -> Result<Json<AuthResponse>, ApiError> {
    // Validate public key format (64 hex chars = 32 bytes Ed25519 public key)
    if body.public_key.len() != 64 || !body.public_key.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::BadRequest("Invalid public key format (expected 64 hex characters)".into()));
    }

    // Check that this public key isn't already attached to a different account
    let existing = paracord_db::users::get_user_by_public_key(&state.db, &body.public_key)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    if let Some(existing_user) = existing {
        if existing_user.id != auth.user_id {
            return Err(ApiError::Conflict("This public key is already in use by another account".into()));
        }
        // Already attached to this user — just return success
    }

    // Attach the public key to the authenticated user's account
    let user = paracord_db::users::update_user_public_key(&state.db, auth.user_id, &body.public_key)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let token = paracord_core::auth::create_token_with_pubkey(
        user.id,
        &body.public_key,
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
            "public_key": user.public_key,
        }),
    }))
}

// --- Ed25519 challenge-response authentication ---

#[derive(Serialize)]
pub struct ChallengeResponse {
    pub nonce: String,
    pub timestamp: i64,
    pub server_origin: String,
}

pub async fn challenge(
    State(state): State<AppState>,
) -> Result<Json<ChallengeResponse>, ApiError> {
    let (nonce, timestamp) = paracord_core::auth::generate_challenge();

    // Store the nonce
    {
        let mut store = challenge_store()
            .lock()
            .map_err(|_| ApiError::Internal(anyhow::anyhow!("lock error")))?;
        cleanup_expired_challenges(&mut store);
        store.insert(nonce.clone(), timestamp);
    }

    let server_origin = state
        .config
        .public_url
        .clone()
        .unwrap_or_else(|| "localhost".to_string());

    Ok(Json(ChallengeResponse {
        nonce,
        timestamp,
        server_origin,
    }))
}

#[derive(Deserialize)]
pub struct VerifyRequest {
    pub public_key: String,
    pub nonce: String,
    pub timestamp: i64,
    pub signature: String,
    pub username: String,
    pub display_name: Option<String>,
}

pub async fn verify(
    State(state): State<AppState>,
    Json(body): Json<VerifyRequest>,
) -> Result<Json<AuthResponse>, ApiError> {
    // Validate public key format (64 hex chars = 32 bytes)
    if body.public_key.len() != 64 {
        return Err(ApiError::BadRequest("Invalid public key".into()));
    }

    // Consume the nonce (one-time use)
    {
        let mut store = challenge_store()
            .lock()
            .map_err(|_| ApiError::Internal(anyhow::anyhow!("lock error")))?;
        if store.remove(&body.nonce).is_none() {
            return Err(ApiError::Unauthorized);
        }
    }

    let server_origin = state
        .config
        .public_url
        .clone()
        .unwrap_or_else(|| "localhost".to_string());

    // Verify the signature
    let valid = paracord_core::auth::verify_challenge(
        &body.public_key,
        &body.nonce,
        body.timestamp,
        &server_origin,
        &body.signature,
    )
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    if !valid {
        return Err(ApiError::Unauthorized);
    }

    // Look up or create user by public key
    let user = match paracord_db::users::get_user_by_public_key(&state.db, &body.public_key)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    {
        Some(user) => user,
        None => {
            // Auto-register: create new user from public key
            let id = paracord_util::snowflake::generate(1);
            let mut new_user = paracord_db::users::create_user_from_pubkey(
                &state.db,
                id,
                &body.public_key,
                &body.username,
                body.display_name.as_deref(),
            )
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

            // Auto-add as server member
            paracord_db::members::add_server_member(&state.db, new_user.id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

            // Assign @everyone roles for all spaces
            if let Ok(spaces) = paracord_db::guilds::list_all_spaces(&state.db).await {
                for space in &spaces {
                    let _ = paracord_db::roles::add_member_role(
                        &state.db,
                        new_user.id,
                        space.id,
                        space.id,
                    )
                    .await;
                }
            }

            // First user becomes admin
            let user_count = paracord_db::users::count_users(&state.db)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            if user_count == 1 {
                new_user = paracord_db::users::update_user_flags(
                    &state.db,
                    new_user.id,
                    new_user.flags | paracord_core::USER_FLAG_ADMIN,
                )
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            }

            new_user
        }
    };

    let token = paracord_core::auth::create_token_with_pubkey(
        user.id,
        &body.public_key,
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
            "public_key": user.public_key,
        }),
    }))
}
