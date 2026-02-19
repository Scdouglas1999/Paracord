use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use url::Url;

use crate::error::ApiError;
use crate::middleware::AuthUser;

const MAX_BOT_NAME_LEN: usize = 80;
const MAX_BOT_DESCRIPTION_LEN: usize = 400;
const MAX_REDIRECT_URI_LEN: usize = 2_000;

fn contains_dangerous_markup(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("<script")
        || lower.contains("javascript:")
        || lower.contains("onerror=")
        || lower.contains("onload=")
        || lower.contains("<iframe")
}

fn generate_secure_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
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

fn bot_app_to_json(
    row: &paracord_db::bot_applications::BotApplicationRow,
    token: Option<&str>,
) -> Value {
    let mut value = json!({
        "id": row.id.to_string(),
        "name": row.name,
        "description": row.description,
        "owner_id": row.owner_id.to_string(),
        "bot_user_id": row.bot_user_id.to_string(),
        "redirect_uri": row.redirect_uri,
        "permissions": row.permissions.to_string(),
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
    let bot_password = generate_secure_token();
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

    let token = generate_secure_token();
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
    _auth: AuthUser,
    Path(bot_app_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let app = paracord_db::bot_applications::get_bot_application(&state.db, bot_app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

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

    let updated = paracord_db::bot_applications::update_bot_application(
        &state.db,
        bot_app_id,
        body.name.as_deref().map(str::trim),
        body.description.as_deref().map(str::trim),
        redirect_uri.as_deref(),
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
        state.member_index.remove_member(install.guild_id, app.bot_user_id);
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

    let token = generate_secure_token();
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

    let effective_permissions = requested_permissions.unwrap_or(app.permissions);
    let _ = paracord_db::bot_applications::add_bot_to_guild(
        &state.db,
        app_id,
        guild_id,
        auth.user_id,
        effective_permissions,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
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

    Ok(Json(json!({
        "authorized": true,
        "application_id": app_id.to_string(),
        "guild_id": guild_id.to_string(),
        "permissions": effective_permissions.to_string(),
        "state": body.state,
        "redirect_uri": app.redirect_uri,
    })))
}
