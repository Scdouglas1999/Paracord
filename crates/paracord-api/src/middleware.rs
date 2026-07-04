use axum::{
    extract::FromRequestParts,
    http::{header, request::Parts, Method, Uri},
};
use chrono::Utc;
use paracord_core::AppState;

use crate::download_ticket::validate_download_ticket;
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

/// Extract `ticket` query parameter from the request URI.
fn get_query_download_ticket(uri: &Uri) -> Option<String> {
    uri.query().and_then(|q| {
        url::form_urlencoded::parse(q.as_bytes())
            .find(|(key, _)| key == "ticket")
            .map(|(_, value)| value.into_owned())
            .filter(|v| !v.is_empty())
    })
}

fn allows_query_download_ticket(parts: &Parts) -> bool {
    let path = parts.uri.path();
    if parts.method == Method::GET && path.starts_with("/api/v1/federated-files/") {
        return true;
    }
    if parts.method == Method::GET
        && path.starts_with("/api/v1/guilds/")
        && path.ends_with("/image")
        && (path.contains("/emojis/") || path.contains("/stickers/"))
    {
        return true;
    }
    false
}

async fn validate_auth(
    parts: &Parts,
    state: &AppState,
) -> Result<paracord_core::auth::Claims, ApiError> {
    let token = match extract_auth_scheme(parts) {
        Some(AuthScheme::Bearer(t)) => t.to_string(),
        _ => get_cookie_value(parts, ACCESS_COOKIE_NAME).ok_or(ApiError::Unauthorized)?,
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
///
/// Hardening mirrors the password/MFA auth guards: presenting an unknown or
/// revoked token is a rate-limited failure keyed on the token hash (so a leaked
/// or stale token that keeps being replayed is throttled), while a successful
/// authentication clears any prior failures and best-effort records `last_used_at`.
async fn validate_bot_auth(parts: &Parts, state: &AppState) -> Result<i64, ApiError> {
    let token = match extract_auth_scheme(parts) {
        Some(AuthScheme::Bot(t)) => t,
        _ => return Err(ApiError::Unauthorized),
    };

    let token_hash = paracord_db::bot_applications::hash_token(token);
    let guard_key = format!("bot:{token_hash}");
    let now = Utc::now();
    let now_epoch = now.timestamp();

    // Reject early if this token hash is currently locked out from repeated
    // failures, before touching the bot_applications table.
    let guard_states = paracord_db::rate_limits::get_auth_guard_states(
        &state.db,
        std::slice::from_ref(&guard_key),
    )
    .await
    .map_err(|_| ApiError::Internal(anyhow::anyhow!("database error")))?;
    if guard_states.iter().any(|row| row.locked_until > now_epoch) {
        return Err(ApiError::Unauthorized);
    }

    let app =
        paracord_db::bot_applications::get_bot_application_by_token_hash(&state.db, &token_hash)
            .await
            .map_err(|_| ApiError::Internal(anyhow::anyhow!("database error")))?;

    let app = match app {
        Some(app) if !app.revoked => app,
        // Unknown or revoked token: record a failure so replayed bad tokens
        // eventually lock out. Best-effort — never block the rejection on it.
        _ => {
            let _ = paracord_db::rate_limits::record_auth_guard_failure(
                &state.db, &guard_key, now_epoch,
            )
            .await;
            return Err(ApiError::Unauthorized);
        }
    };

    // Success: clear any accumulated failures for this token and record usage.
    if !guard_states.is_empty() {
        let _ = paracord_db::rate_limits::clear_auth_guard_keys(
            &state.db,
            std::slice::from_ref(&guard_key),
        )
        .await;
    }
    let db = state.db.clone();
    let app_id = app.id;
    tokio::spawn(async move {
        if let Err(err) = paracord_db::bot_applications::touch_bot_last_used(&db, app_id, now).await
        {
            tracing::debug!("failed to update bot last_used_at for {}: {}", app_id, err);
        }
    });

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

        if allows_query_download_ticket(parts) {
            if let Some(ticket) = get_query_download_ticket(&parts.uri) {
                if let Some(user_id) = validate_download_ticket(&ticket) {
                    return Ok(AuthUser {
                        user_id,
                        session_id: None,
                        token_jti: None,
                    });
                }
            }
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

#[cfg(test)]
mod tests {
    use super::allows_query_download_ticket;
    use axum::http::Request;

    #[test]
    fn rejects_query_download_ticket_for_realtime_events() {
        let request = Request::builder()
            .method("GET")
            .uri("/api/v2/rt/events?ticket=abc")
            .body(())
            .expect("request");
        let (parts, _) = request.into_parts();
        assert!(!allows_query_download_ticket(&parts));
    }

    #[test]
    fn rejects_query_download_ticket_for_attachment_downloads() {
        let get_request = Request::builder()
            .method("GET")
            .uri("/api/v1/attachments/123?ticket=abc")
            .body(())
            .expect("request");
        let (get_parts, _) = get_request.into_parts();
        assert!(!allows_query_download_ticket(&get_parts));
    }

    #[test]
    fn allows_query_download_ticket_for_federated_file_downloads_only() {
        let get_request = Request::builder()
            .method("GET")
            .uri("/api/v1/federated-files/123?ticket=abc")
            .body(())
            .expect("request");
        let (get_parts, _) = get_request.into_parts();
        assert!(allows_query_download_ticket(&get_parts));

        let delete_request = Request::builder()
            .method("DELETE")
            .uri("/api/v1/federated-files/123?ticket=abc")
            .body(())
            .expect("request");
        let (delete_parts, _) = delete_request.into_parts();
        assert!(!allows_query_download_ticket(&delete_parts));
    }

    #[test]
    fn allows_query_download_ticket_for_guild_image_assets_only() {
        let emoji_request = Request::builder()
            .method("GET")
            .uri("/api/v1/guilds/1/emojis/2/image?ticket=abc")
            .body(())
            .expect("request");
        let (emoji_parts, _) = emoji_request.into_parts();
        assert!(allows_query_download_ticket(&emoji_parts));

        let sticker_request = Request::builder()
            .method("GET")
            .uri("/api/v1/guilds/1/stickers/2/image?ticket=abc")
            .body(())
            .expect("request");
        let (sticker_parts, _) = sticker_request.into_parts();
        assert!(allows_query_download_ticket(&sticker_parts));

        let list_request = Request::builder()
            .method("GET")
            .uri("/api/v1/guilds/1/emojis?ticket=abc")
            .body(())
            .expect("request");
        let (list_parts, _) = list_request.into_parts();
        assert!(!allows_query_download_ticket(&list_parts));
    }

    #[test]
    fn rejects_query_download_ticket_for_unlisted_paths() {
        let request = Request::builder()
            .method("GET")
            .uri("/api/v1/channels/1/messages?ticket=abc")
            .body(())
            .expect("request");
        let (parts, _) = request.into_parts();
        assert!(!allows_query_download_ticket(&parts));
    }
}
