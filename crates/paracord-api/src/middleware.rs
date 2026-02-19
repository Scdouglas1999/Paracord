use axum::{
    extract::FromRequestParts,
    http::{header, request::Parts, Uri},
};
use chrono::Utc;
use paracord_core::AppState;

use crate::error::ApiError;

pub struct AuthUser {
    pub user_id: i64,
    pub session_id: Option<String>,
    pub token_jti: Option<String>,
}

const ACCESS_COOKIE_NAME: &str = "paracord_access";

enum AuthScheme<'a> {
    Bearer(&'a str),
    Bot(&'a str),
}

fn extract_auth_scheme(parts: &Parts) -> Option<AuthScheme<'_>> {
    let raw = parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())?;

    if let Some(token) = raw.strip_prefix("Bearer ") {
        return Some(AuthScheme::Bearer(token));
    }
    if let Some(token) = raw.strip_prefix("Bot ") {
        return Some(AuthScheme::Bot(token));
    }
    None
}

fn get_cookie_value(parts: &Parts, cookie_name: &str) -> Option<String> {
    let raw = parts.headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let trimmed = part.trim();
        let Some((name, value)) = trimmed.split_once('=') else {
            continue;
        };
        if name == cookie_name {
            return Some(value.to_string());
        }
    }
    None
}

/// Extract `token` query parameter from the request URI.
fn get_query_token(uri: &Uri) -> Option<String> {
    uri.query().and_then(|q| {
        url::form_urlencoded::parse(q.as_bytes())
            .find(|(key, _)| key == "token")
            .map(|(_, value)| value.into_owned())
            .filter(|v| !v.is_empty())
    })
}

async fn validate_auth(
    parts: &Parts,
    state: &AppState,
) -> Result<paracord_core::auth::Claims, ApiError> {
    let token = match extract_auth_scheme(parts) {
        Some(AuthScheme::Bearer(t)) => t.to_string(),
        _ => get_cookie_value(parts, ACCESS_COOKIE_NAME)
            .or_else(|| get_query_token(&parts.uri))
            .ok_or(ApiError::Unauthorized)?,
    };

    let claims = paracord_core::auth::validate_token(&token, &state.config.jwt_secret)
        .map_err(|_| ApiError::Unauthorized)?;

    let (session_id, jti) = match (claims.sid.as_deref(), claims.jti.as_deref()) {
        (Some(session_id), Some(jti)) => (session_id, jti),
        _ => return Err(ApiError::Unauthorized),
    };

    let active = paracord_db::sessions::is_access_token_active(
        &state.db,
        claims.sub,
        session_id,
        jti,
        Utc::now(),
    )
    .await
    .map_err(|_| ApiError::Internal(anyhow::anyhow!("database error")))?;
    if !active {
        return Err(ApiError::Unauthorized);
    }

    Ok(claims)
}

/// Validate a "Bot <token>" header by looking up the token hash in bot_applications.
async fn validate_bot_auth(parts: &Parts, state: &AppState) -> Result<i64, ApiError> {
    let token = match extract_auth_scheme(parts) {
        Some(AuthScheme::Bot(t)) => t,
        _ => return Err(ApiError::Unauthorized),
    };

    let token_hash = paracord_db::bot_applications::hash_token(token);
    let app =
        paracord_db::bot_applications::get_bot_application_by_token_hash(&state.db, &token_hash)
            .await
            .map_err(|_| ApiError::Internal(anyhow::anyhow!("database error")))?
            .ok_or(ApiError::Unauthorized)?;

    Ok(app.bot_user_id)
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        // Try Bearer JWT first, then Bot token.
        if let Ok(claims) = validate_auth(parts, state).await {
            return Ok(AuthUser {
                user_id: claims.sub,
                session_id: claims.sid,
                token_jti: claims.jti,
            });
        }

        if let Ok(bot_user_id) = validate_bot_auth(parts, state).await {
            return Ok(AuthUser {
                user_id: bot_user_id,
                session_id: None,
                token_jti: None,
            });
        }

        Err(ApiError::Unauthorized)
    }
}

/// Extractor that requires the authenticated user to be a server admin.
pub struct AdminUser {
    pub user_id: i64,
}

impl FromRequestParts<AppState> for AdminUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let claims = validate_auth(parts, state).await?;

        let user = paracord_db::users::get_user_by_id(&state.db, claims.sub)
            .await
            .map_err(|_| ApiError::Internal(anyhow::anyhow!("database error")))?
            .ok_or(ApiError::Unauthorized)?;

        if !paracord_core::is_admin(user.flags) {
            return Err(ApiError::Forbidden);
        }

        Ok(AdminUser {
            user_id: claims.sub,
        })
    }
}
