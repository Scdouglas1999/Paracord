use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};
use url::Url;

use crate::error::ApiError;
use crate::middleware::AuthUser;
use crate::routes::audit;

const MAX_ACTIVITY_NAME_LEN: usize = 128;

const MAX_BOT_NAME_LEN: usize = 80;
const MAX_BOT_DESCRIPTION_LEN: usize = 400;
const MAX_REDIRECT_URI_LEN: usize = 2_000;

/// Defense-in-depth denylist for obviously dangerous markup in bot metadata.
///
/// XSS safety for these values ultimately rests on React output escaping at the
/// client: every stored string is rendered as text, never as raw HTML. This
/// denylist is a coarse secondary guard to reject blatant injection attempts
/// early; it is intentionally incomplete and MUST NOT be treated as the sole
/// gate for any stored value. Do not rely on it to sanitize output.
fn contains_dangerous_markup(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("<script")
        || lower.contains("javascript:")
        || lower.contains("onerror=")
        || lower.contains("onload=")
        || lower.contains("<iframe")
}

fn parse_permission_bits(raw: &str, field_name: &str) -> Result<i64, ApiError> {
    let parsed = raw
        .trim()
        .parse::<i64>()
        .map_err(|_| ApiError::BadRequest(format!("Invalid {field_name}")))?;
    if parsed < 0 {
        return Err(ApiError::BadRequest(format!(
            "{field_name} must be a non-negative integer"
        )));
    }
    Ok(parsed)
}

fn validate_redirect_uri(raw: &str) -> Result<String, ApiError> {
    let trimmed = raw.trim();
    if trimmed.len() > MAX_REDIRECT_URI_LEN {
        return Err(ApiError::BadRequest("redirect_uri too long".into()));
    }

    let parsed = Url::parse(trimmed)
        .map_err(|_| ApiError::BadRequest("redirect_uri is not a valid URL".into()))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| ApiError::BadRequest("redirect_uri must include a host".into()))?;

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ApiError::BadRequest(
            "redirect_uri must not include userinfo".into(),
        ));
    }
    if parsed.fragment().is_some() {
        return Err(ApiError::BadRequest(
            "redirect_uri must not include URL fragments".into(),
        ));
    }

    match parsed.scheme() {
        "https" => {}
        "http" if matches!(host, "localhost" | "127.0.0.1" | "::1") => {}
        _ => {
            return Err(ApiError::BadRequest(
                "redirect_uri must use https (localhost http allowed for development)".into(),
            ))
        }
    }

    Ok(trimmed.to_string())
}

fn bot_store_row_to_json(
    row: &paracord_db::bot_applications::BotStoreRow,
    verified_developer: bool,
    review_count: i64,
    average_rating: f64,
) -> Value {
    let tags: Vec<String> = row
        .tags
        .as_deref()
        .map(|t| t.split(',').map(|s| s.trim().to_string()).collect())
        .unwrap_or_default();
    json!({
        "id": row.id.to_string(),
        "name": row.name,
        "description": row.description,
        "category": row.category,
        "tags": tags,
        "icon_hash": row.icon_hash,
        "install_count": row.install_count,
        "bot_user_id": row.bot_user_id.to_string(),
        "permissions": row.permissions.to_string(),
        "verified_developer": verified_developer,
        "review_count": review_count,
        "average_rating": average_rating,
    })
}

/// Enrich a page of store rows with owner-verification and review-summary data
/// using two batch queries instead of a per-row lookup (avoids N+1).
async fn enrich_store_rows(
    state: &AppState,
    rows: &[paracord_db::bot_applications::BotStoreRow],
) -> Result<Vec<Value>, ApiError> {
    let app_ids: Vec<i64> = rows.iter().map(|row| row.id).collect();
    let owner_info =
        paracord_db::bot_applications::get_owner_verification_by_app_ids(&state.db, &app_ids)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let review_summaries = paracord_db::bot_reviews::get_review_summaries(&state.db, &app_ids)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(rows
        .iter()
        .map(|row| {
            let verified_developer = owner_info
                .get(&row.id)
                .map(|&(email_verified, flags)| email_verified || paracord_core::is_admin(flags))
                .unwrap_or(false);
            let (review_count, average_rating) =
                review_summaries.get(&row.id).copied().unwrap_or((0, 0.0));
            bot_store_row_to_json(row, verified_developer, review_count, average_rating)
        })
        .collect())
}

fn bot_app_to_json(
    row: &paracord_db::bot_applications::BotApplicationRow,
    token: Option<&str>,
) -> Value {
    let tags: Vec<String> = row
        .tags
        .as_deref()
        .map(|t| t.split(',').map(|s| s.trim().to_string()).collect())
        .unwrap_or_default();

    let mut value = json!({
        "id": row.id.to_string(),
        "name": row.name,
        "description": row.description,
        "owner_id": row.owner_id.to_string(),
        "bot_user_id": row.bot_user_id.to_string(),
        "redirect_uri": row.redirect_uri,
        "permissions": row.permissions.to_string(),
        "scopes": row.scopes,
        "intents": row.intents,
        "public_listed": row.public_listed,
        "category": row.category,
        "tags": tags,
        "icon_hash": row.icon_hash,
        "install_count": row.install_count,
        "created_at": row.created_at.to_rfc3339(),
        "updated_at": row.updated_at.to_rfc3339(),
    });
    if let Some(token) = token {
        value["token"] = json!(token);
    }
    value
}

async fn ensure_manage_guild(
    state: &AppState,
    guild_id: i64,
    user_id: i64,
) -> Result<(), ApiError> {
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, user_id).await?;

    let roles = paracord_db::roles::get_member_roles(&state.db, user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let perms =
        paracord_core::permissions::compute_permissions_from_roles(&roles, guild.owner_id, user_id);
    paracord_core::permissions::require_permission(perms, Permissions::MANAGE_GUILD)?;
    Ok(())
}

#[derive(Deserialize)]
pub struct CreateBotApplicationRequest {
    pub name: String,
    pub description: Option<String>,
    pub redirect_uri: Option<String>,
    pub permissions: Option<String>,
}

pub async fn create_bot_application(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<CreateBotApplicationRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let name = body.name.trim();
    if name.is_empty() || name.len() > MAX_BOT_NAME_LEN {
        return Err(ApiError::BadRequest(
            "Bot name must be between 1 and 80 characters".into(),
        ));
    }
    if contains_dangerous_markup(name) {
        return Err(ApiError::BadRequest(
            "Bot name contains unsafe markup".into(),
        ));
    }
    if let Some(description) = body.description.as_deref() {
        if description.len() > MAX_BOT_DESCRIPTION_LEN {
            return Err(ApiError::BadRequest("Description too long".into()));
        }
        if contains_dangerous_markup(description) {
            return Err(ApiError::BadRequest(
                "Description contains unsafe markup".into(),
            ));
        }
    }
    let redirect_uri = body
        .redirect_uri
        .as_deref()
        .map(validate_redirect_uri)
        .transpose()?;

    let permissions = body
        .permissions
        .as_deref()
        .map(|v| parse_permission_bits(v, "permissions"))
        .transpose()?
        .unwrap_or(0);

    let app_id = paracord_util::snowflake::generate(1);
    let bot_user_id = paracord_util::snowflake::generate(1);
    let bot_username = format!("bot-{}", app_id);
    let bot_email = format!("bot-{}@bots.paracord.local", bot_user_id);
    let discriminator = ((bot_user_id % 9000) + 1000) as i16;
    let bot_password = crate::secure_tokens::generate_secure_token();
    let bot_password_hash = paracord_core::auth::hash_password(&bot_password)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let created_bot_user = paracord_db::users::create_user(
        &state.db,
        bot_user_id,
        &bot_username,
        discriminator,
        &bot_email,
        &bot_password_hash,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let _ = paracord_db::users::update_user_flags(
        &state.db,
        bot_user_id,
        created_bot_user.flags | paracord_core::USER_FLAG_BOT,
    )
    .await;

    let token = crate::secure_tokens::generate_secure_token();
    let token_hash = paracord_db::bot_applications::hash_token(&token);
    let app = paracord_db::bot_applications::create_bot_application(
        &state.db,
        app_id,
        name,
        body.description.as_deref(),
        auth.user_id,
        bot_user_id,
        &token_hash,
        redirect_uri.as_deref(),
        permissions,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok((
        StatusCode::CREATED,
        Json(bot_app_to_json(&app, Some(&token))),
    ))
}

pub async fn list_bot_applications(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let rows = paracord_db::bot_applications::list_user_bot_applications(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!(rows
        .iter()
        .map(|row| bot_app_to_json(row, None))
        .collect::<Vec<Value>>())))
}

pub async fn get_bot_application(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(bot_app_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let app = paracord_db::bot_applications::get_bot_application(&state.db, bot_app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if app.owner_id != auth.user_id {
        return Err(ApiError::Forbidden);
    }

    Ok(Json(bot_app_to_json(&app, None)))
}

pub async fn get_public_bot_application(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(bot_app_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let app = paracord_db::bot_applications::get_bot_application(&state.db, bot_app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    // Only publicly listed applications are discoverable by non-owners. A
    // private/unlisted app's metadata (name, description, bot_user_id,
    // permissions, redirect_uri, bot profile) must not leak to arbitrary callers.
    // Return NotFound rather than Forbidden so the endpoint does not even confirm
    // the app exists, mirroring the store-review visibility gate.
    if !app.public_listed && app.owner_id != auth.user_id {
        return Err(ApiError::NotFound);
    }

    let bot_user = paracord_db::users::get_user_by_id(&state.db, app.bot_user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(json!({
        "id": app.id.to_string(),
        "name": app.name,
        "description": app.description,
        "bot_user_id": app.bot_user_id.to_string(),
        "permissions": app.permissions.to_string(),
        "redirect_uri": app.redirect_uri,
        "created_at": app.created_at.to_rfc3339(),
        "updated_at": app.updated_at.to_rfc3339(),
        "bot_user": bot_user.map(|user| json!({
            "id": user.id.to_string(),
            "username": user.username,
            "discriminator": user.discriminator,
            "avatar_hash": user.avatar_hash,
            "bot": paracord_core::is_bot(user.flags),
        })),
    })))
}

#[derive(Deserialize)]
pub struct UpdateBotApplicationRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub redirect_uri: Option<String>,
    pub permissions: Option<String>,
    pub intents: Option<i64>,
}

pub async fn update_bot_application(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(bot_app_id): Path<i64>,
    Json(body): Json<UpdateBotApplicationRequest>,
) -> Result<Json<Value>, ApiError> {
    let app = paracord_db::bot_applications::get_bot_application(&state.db, bot_app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if app.owner_id != auth.user_id {
        return Err(ApiError::Forbidden);
    }

    if let Some(name) = body.name.as_deref() {
        let trimmed = name.trim();
        if trimmed.is_empty() || trimmed.len() > MAX_BOT_NAME_LEN {
            return Err(ApiError::BadRequest(
                "Bot name must be between 1 and 80 characters".into(),
            ));
        }
        if contains_dangerous_markup(trimmed) {
            return Err(ApiError::BadRequest(
                "Bot name contains unsafe markup".into(),
            ));
        }
    }
    if let Some(description) = body.description.as_deref() {
        if description.len() > MAX_BOT_DESCRIPTION_LEN {
            return Err(ApiError::BadRequest("Description too long".into()));
        }
        if contains_dangerous_markup(description) {
            return Err(ApiError::BadRequest(
                "Description contains unsafe markup".into(),
            ));
        }
    }
    let redirect_uri = body
        .redirect_uri
        .as_deref()
        .map(validate_redirect_uri)
        .transpose()?;
    let permissions = body
        .permissions
        .as_deref()
        .map(|v| parse_permission_bits(v, "permissions"))
        .transpose()?;
    if let Some(intents) = body.intents {
        if intents < 0 {
            return Err(ApiError::BadRequest(
                "intents must be a non-negative integer".into(),
            ));
        }
    }

    let updated = paracord_db::bot_applications::update_bot_application(
        &state.db,
        bot_app_id,
        body.name.as_deref().map(str::trim),
        body.description.as_deref().map(str::trim),
        redirect_uri.as_deref(),
        permissions,
        body.intents,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(bot_app_to_json(&updated, None)))
}

pub async fn delete_bot_application(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(bot_app_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let app = paracord_db::bot_applications::get_bot_application(&state.db, bot_app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if app.owner_id != auth.user_id {
        return Err(ApiError::Forbidden);
    }

    let installs = paracord_db::bot_applications::list_bot_guild_installs(&state.db, bot_app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    for install in installs {
        let _ =
            paracord_db::members::remove_member(&state.db, app.bot_user_id, install.guild_id).await;
        let _ = paracord_db::bot_reviews::record_metric_event(
            &state.db,
            paracord_util::snowflake::generate(1),
            bot_app_id,
            Some(install.guild_id),
            "guild_uninstall",
            Some("{\"source\":\"delete_application\"}"),
        )
        .await;
        state
            .member_index
            .remove_member(install.guild_id, app.bot_user_id);
        state.event_bus.dispatch(
            "GUILD_MEMBER_REMOVE",
            json!({
                "guild_id": install.guild_id.to_string(),
                "user": { "id": app.bot_user_id.to_string() },
                "user_id": app.bot_user_id.to_string(),
            }),
            Some(install.guild_id),
        );
    }

    paracord_db::bot_applications::delete_bot_application(&state.db, bot_app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    paracord_db::users::delete_user(&state.db, app.bot_user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn regenerate_bot_token(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(bot_app_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let app = paracord_db::bot_applications::get_bot_application(&state.db, bot_app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if app.owner_id != auth.user_id {
        return Err(ApiError::Forbidden);
    }

    let token = crate::secure_tokens::generate_secure_token();
    let token_hash = paracord_db::bot_applications::hash_token(&token);
    let updated =
        paracord_db::bot_applications::regenerate_bot_token(&state.db, bot_app_id, &token_hash)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(bot_app_to_json(&updated, Some(&token))))
}

pub async fn list_bot_application_installs(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(bot_app_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let app = paracord_db::bot_applications::get_bot_application(&state.db, bot_app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if app.owner_id != auth.user_id {
        return Err(ApiError::Forbidden);
    }

    let installs = paracord_db::bot_applications::list_bot_guild_installs(&state.db, bot_app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!(installs
        .iter()
        .map(|install| json!({
            "bot_app_id": install.bot_app_id.to_string(),
            "guild_id": install.guild_id.to_string(),
            "added_by": install.added_by.map(|id| id.to_string()),
            "permissions": install.permissions.to_string(),
            "created_at": install.created_at.to_rfc3339(),
        }))
        .collect::<Vec<Value>>())))
}

pub async fn list_guild_bots(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    ensure_manage_guild(&state, guild_id, auth.user_id).await?;

    let installs = paracord_db::bot_applications::list_guild_bots(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let mut rows = Vec::with_capacity(installs.len());
    for install in installs {
        let app = paracord_db::bot_applications::get_bot_application(&state.db, install.bot_app_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        if let Some(app) = app {
            rows.push(json!({
                "application": bot_app_to_json(&app, None),
                "install": {
                    "bot_app_id": install.bot_app_id.to_string(),
                    "guild_id": install.guild_id.to_string(),
                    "added_by": install.added_by.map(|id| id.to_string()),
                    "permissions": install.permissions.to_string(),
                    "created_at": install.created_at.to_rfc3339(),
                }
            }));
        }
    }

    Ok(Json(json!(rows)))
}

pub async fn remove_guild_bot(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((guild_id, bot_app_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    ensure_manage_guild(&state, guild_id, auth.user_id).await?;

    let app = paracord_db::bot_applications::get_bot_application(&state.db, bot_app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    // The uninstall never checked that the bot was installed here, so any
    // MANAGE_GUILD holder could name an arbitrary application id and have the
    // server write a `guild_uninstall` metric row and broadcast a fabricated
    // GUILD_MEMBER_REMOVE for a bot that was never in the guild.
    let is_installed =
        paracord_db::bot_applications::is_bot_in_guild(&state.db, bot_app_id, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !is_installed {
        return Err(ApiError::NotFound);
    }

    paracord_db::bot_applications::remove_bot_from_guild(&state.db, bot_app_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let _ = paracord_db::members::remove_member(&state.db, app.bot_user_id, guild_id).await;

    state.member_index.remove_member(guild_id, app.bot_user_id);
    state.event_bus.dispatch(
        "GUILD_MEMBER_REMOVE",
        json!({
            "guild_id": guild_id.to_string(),
            "user": { "id": app.bot_user_id.to_string() },
            "user_id": app.bot_user_id.to_string(),
        }),
        Some(guild_id),
    );

    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_BOT_REMOVE,
        Some(bot_app_id),
        None,
        Some(json!({"bot_user_id": app.bot_user_id.to_string()})),
    )
    .await;
    let _ = paracord_db::bot_reviews::record_metric_event(
        &state.db,
        paracord_util::snowflake::generate(1),
        bot_app_id,
        Some(guild_id),
        "guild_uninstall",
        Some("{\"source\":\"remove_guild_bot\"}"),
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct OAuth2AuthorizeRequest {
    pub application_id: String,
    pub guild_id: String,
    pub permissions: Option<String>,
    pub redirect_uri: Option<String>,
    pub state: Option<String>,
}

pub async fn oauth2_authorize(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<OAuth2AuthorizeRequest>,
) -> Result<Json<Value>, ApiError> {
    let app_id = body
        .application_id
        .parse::<i64>()
        .map_err(|_| ApiError::BadRequest("Invalid application_id".into()))?;
    let guild_id = body
        .guild_id
        .parse::<i64>()
        .map_err(|_| ApiError::BadRequest("Invalid guild_id".into()))?;
    let requested_permissions = body
        .permissions
        .as_deref()
        .map(|v| parse_permission_bits(v, "permissions"))
        .transpose()?;
    let redirect_uri = body
        .redirect_uri
        .as_deref()
        .map(validate_redirect_uri)
        .transpose()?;

    let app = paracord_db::bot_applications::get_bot_application(&state.db, app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    ensure_manage_guild(&state, guild_id, auth.user_id).await?;

    // A private/unlisted application may only be installed by its owner. Without
    // this, anyone holding MANAGE_GUILD could force-install a never-listed bot
    // into their guild — the bot would then start receiving interaction events
    // from a guild that never consented to it. Public store apps and the app's
    // own owner remain installable.
    if !app.public_listed && app.owner_id != auth.user_id {
        return Err(ApiError::Forbidden);
    }

    if let Some(ref redirect_uri) = redirect_uri {
        if app.redirect_uri.as_deref() != Some(redirect_uri.as_str()) {
            return Err(ApiError::BadRequest(
                "redirect_uri does not match application configuration".into(),
            ));
        }
    }

    if let Some(requested) = requested_permissions {
        let requested_bits = Permissions::from_bits_truncate(requested);
        let allowed_bits = Permissions::from_bits_truncate(app.permissions);
        if requested_bits.bits() & !allowed_bits.bits() != 0 {
            return Err(ApiError::BadRequest(
                "Requested permissions exceed the application default permissions".into(),
            ));
        }
    }

    // Cap the granted permissions to the intersection of what was requested (or
    // the application default) and what the authorizing user actually holds in
    // this guild. A user must never be able to grant a bot more power than they
    // possess themselves.
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let authorizer_roles = paracord_db::roles::get_member_roles(&state.db, auth.user_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let authorizer_bits = paracord_core::permissions::compute_permissions_from_roles(
        &authorizer_roles,
        guild.owner_id,
        auth.user_id,
    )
    .bits();
    let effective_permissions = requested_permissions.unwrap_or(app.permissions) & authorizer_bits;
    let _ = paracord_db::bot_applications::add_bot_to_guild(
        &state.db,
        app_id,
        guild_id,
        auth.user_id,
        effective_permissions,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let _ = paracord_db::bot_reviews::record_metric_event(
        &state.db,
        paracord_util::snowflake::generate(1),
        app_id,
        Some(guild_id),
        "guild_install",
        Some("{\"source\":\"oauth2_authorize\"}"),
    )
    .await;
    let _ = paracord_db::members::add_member(&state.db, app.bot_user_id, guild_id).await;
    state.member_index.add_member(guild_id, app.bot_user_id);

    let user_row = paracord_db::users::get_user_by_id(&state.db, app.bot_user_id)
        .await
        .ok()
        .flatten();

    if let Some(user_row) = user_row {
        state.event_bus.dispatch(
            "GUILD_MEMBER_ADD",
            json!({
                "guild_id": guild_id.to_string(),
                "user": {
                    "id": user_row.id.to_string(),
                    "username": user_row.username,
                    "discriminator": user_row.discriminator,
                    "avatar_hash": user_row.avatar_hash,
                    "flags": user_row.flags,
                    "bot": true,
                }
            }),
            Some(guild_id),
        );
    }

    audit::log_action(
        &state,
        guild_id,
        auth.user_id,
        audit::ACTION_BOT_ADD,
        Some(app_id),
        None,
        Some(json!({"bot_user_id": app.bot_user_id.to_string(), "permissions": effective_permissions.to_string()})),
    )
    .await;

    Ok(Json(json!({
        "authorized": true,
        "application_id": app_id.to_string(),
        "guild_id": guild_id.to_string(),
        "permissions": effective_permissions.to_string(),
        "state": body.state,
        "redirect_uri": app.redirect_uri,
    })))
}

// ---------------------------------------------------------------------------
// Bot store endpoints
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct BotStoreSearchParams {
    pub q: Option<String>,
    pub category: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

pub async fn store_search(
    State(state): State<AppState>,
    Query(params): Query<BotStoreSearchParams>,
) -> Result<Json<Value>, ApiError> {
    let limit = params.limit.unwrap_or(20).clamp(1, 100);
    let offset = params.offset.unwrap_or(0).max(0);

    let (rows, total) = paracord_db::bot_applications::list_store_bots(
        &state.db,
        params.q.as_deref(),
        params.category.as_deref(),
        limit,
        offset,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let bots = enrich_store_rows(&state, &rows).await?;
    Ok(Json(json!({ "bots": bots, "total": total })))
}

pub async fn store_featured(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let rows = paracord_db::bot_applications::list_featured_bots(&state.db, 12)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let bots = enrich_store_rows(&state, &rows).await?;
    Ok(Json(json!({ "bots": bots })))
}

pub async fn store_categories(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let categories = paracord_db::bot_applications::list_store_categories(&state.db)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(json!({ "categories": categories })))
}

#[derive(Deserialize)]
pub struct BotStoreReviewListParams {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Deserialize)]
pub struct UpsertBotReviewRequest {
    pub rating: i16,
    pub title: Option<String>,
    pub body: Option<String>,
}

fn review_to_json(review: &paracord_db::bot_reviews::BotReviewRow) -> Value {
    json!({
        "id": review.id.to_string(),
        "bot_app_id": review.bot_app_id.to_string(),
        "user_id": review.user_id.to_string(),
        "rating": review.rating,
        "title": review.title,
        "body": review.body,
        "created_at": review.created_at.to_rfc3339(),
        "updated_at": review.updated_at.to_rfc3339(),
    })
}

pub async fn list_store_bot_reviews(
    State(state): State<AppState>,
    Path(bot_app_id): Path<i64>,
    Query(params): Query<BotStoreReviewListParams>,
) -> Result<Json<Value>, ApiError> {
    let app = paracord_db::bot_applications::get_bot_application(&state.db, bot_app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if !app.public_listed {
        return Err(ApiError::NotFound);
    }

    let limit = params.limit.unwrap_or(25).clamp(1, 100);
    let offset = params.offset.unwrap_or(0).max(0);
    let reviews = paracord_db::bot_reviews::list_reviews(&state.db, bot_app_id, limit, offset)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let (review_count, average_rating) =
        paracord_db::bot_reviews::get_review_summary(&state.db, bot_app_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(json!({
        "reviews": reviews.iter().map(review_to_json).collect::<Vec<_>>(),
        "summary": {
            "review_count": review_count,
            "average_rating": average_rating,
        }
    })))
}

pub async fn upsert_store_bot_review(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(bot_app_id): Path<i64>,
    Json(body): Json<UpsertBotReviewRequest>,
) -> Result<Json<Value>, ApiError> {
    let app = paracord_db::bot_applications::get_bot_application(&state.db, bot_app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if !app.public_listed {
        return Err(ApiError::NotFound);
    }
    if !(1..=5).contains(&body.rating) {
        return Err(ApiError::BadRequest(
            "rating must be an integer between 1 and 5".into(),
        ));
    }
    let title = body
        .title
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let text = body
        .body
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    if title.is_some_and(|v| v.len() > 120) {
        return Err(ApiError::BadRequest(
            "title must be <= 120 characters".into(),
        ));
    }
    if text.is_some_and(|v| v.len() > 2_000) {
        return Err(ApiError::BadRequest(
            "body must be <= 2000 characters".into(),
        ));
    }

    let review = paracord_db::bot_reviews::upsert_review(
        &state.db,
        paracord_util::snowflake::generate(1),
        bot_app_id,
        auth.user_id,
        body.rating,
        title,
        text,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let _ = paracord_db::bot_reviews::record_metric_event(
        &state.db,
        paracord_util::snowflake::generate(1),
        bot_app_id,
        None,
        "review_submitted",
        Some("{\"source\":\"store_review\"}"),
    )
    .await;
    let (review_count, average_rating) =
        paracord_db::bot_reviews::get_review_summary(&state.db, bot_app_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!({
        "review": review_to_json(&review),
        "summary": {
            "review_count": review_count,
            "average_rating": average_rating,
        }
    })))
}

pub async fn get_bot_application_metrics(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(bot_app_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let app = paracord_db::bot_applications::get_bot_application(&state.db, bot_app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if app.owner_id != auth.user_id {
        return Err(ApiError::Forbidden);
    }
    let installs = paracord_db::bot_applications::list_bot_guild_installs(&state.db, bot_app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let (review_count, average_rating) =
        paracord_db::bot_reviews::get_review_summary(&state.db, bot_app_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let buckets = paracord_db::bot_reviews::list_metric_buckets_30d(&state.db, bot_app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(json!({
        "application_id": bot_app_id.to_string(),
        "install_count": app.install_count,
        "active_guild_count": installs.len(),
        "review_count": review_count,
        "average_rating": average_rating,
        "metrics_30d": buckets.iter().map(|bucket| json!({
            "event_type": bucket.event_type,
            "count": bucket.count,
        })).collect::<Vec<_>>(),
    })))
}

// ---------------------------------------------------------------------------
// Bot presence endpoint
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct UpdateBotPresenceRequest {
    pub status: Option<String>,
    pub activity: Option<BotActivity>,
}

#[derive(Deserialize)]
pub struct BotActivity {
    pub name: String,
    #[serde(rename = "type", default)]
    pub activity_type: i64,
}

fn normalize_status(raw: &str) -> &'static str {
    match raw {
        "online" => "online",
        "idle" => "idle",
        "dnd" => "dnd",
        "offline" => "offline",
        _ => "online",
    }
}

pub async fn update_bot_presence(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<UpdateBotPresenceRequest>,
) -> Result<Json<Value>, ApiError> {
    // Verify this is actually a bot user
    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::Unauthorized)?;
    if !paracord_core::is_bot(user.flags) {
        return Err(ApiError::Forbidden);
    }

    let effective_status = normalize_status(body.status.as_deref().unwrap_or("online"));

    let activities: Vec<Value> = if let Some(ref activity) = body.activity {
        let name: String = activity.name.chars().take(MAX_ACTIVITY_NAME_LEN).collect();
        let activity_type = activity.activity_type.clamp(0, 5);
        vec![json!({
            "name": name,
            "type": activity_type,
        })]
    } else {
        vec![]
    };

    let presence_payload = json!({
        "user_id": auth.user_id.to_string(),
        "status": effective_status,
        "custom_status": Value::Null,
        "activities": activities,
    });

    state
        .user_presences
        .insert(auth.user_id, presence_payload.clone());

    // Find guilds the bot is in and dispatch to their members
    let guilds = paracord_db::guilds::get_user_guilds(&state.db, auth.user_id.into())
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let guild_ids: Vec<i64> = guilds.iter().map(|g| g.id).collect();

    let mut recipients = state
        .member_index
        .get_presence_recipients(auth.user_id, &guild_ids);
    recipients.insert(auth.user_id);

    state.event_bus.dispatch_to_users(
        "PRESENCE_UPDATE",
        presence_payload.clone(),
        recipients.into_iter().collect(),
    );

    Ok(Json(presence_payload))
}
