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

const MAX_COMMAND_NAME_LEN: usize = 32;
const MAX_COMMAND_DESCRIPTION_LEN: usize = 100;
const MAX_OPTIONS: usize = 25;
const MAX_CHOICES_PER_OPTION: usize = 25;
const MAX_COMMANDS_PER_SCOPE: usize = 100;

/// Validate command name: must match ^[\w-]{1,32}$
fn validate_command_name(name: &str) -> Result<(), ApiError> {
    if name.is_empty() || name.len() > MAX_COMMAND_NAME_LEN {
        return Err(ApiError::BadRequest(
            "Command name must be between 1 and 32 characters".into(),
        ));
    }
    let valid = name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-');
    if !valid {
        return Err(ApiError::BadRequest(
            "Command name must match ^[\\w-]{1,32}$".into(),
        ));
    }
    Ok(())
}

fn validate_command_description(desc: &str) -> Result<(), ApiError> {
    if desc.is_empty() || desc.len() > MAX_COMMAND_DESCRIPTION_LEN {
        return Err(ApiError::BadRequest(
            "Command description must be between 1 and 100 characters".into(),
        ));
    }
    Ok(())
}

fn validate_options(options: &[serde_json::Value]) -> Result<(), ApiError> {
    if options.len() > MAX_OPTIONS {
        return Err(ApiError::BadRequest(format!(
            "Maximum {MAX_OPTIONS} options allowed"
        )));
    }
    for opt in options {
        // Validate option name
        if let Some(name) = opt.get("name").and_then(|v| v.as_str()) {
            if name.is_empty() || name.len() > MAX_COMMAND_NAME_LEN {
                return Err(ApiError::BadRequest(
                    "Option name must be between 1 and 32 characters".into(),
                ));
            }
            let valid = name
                .chars()
                .all(|c| c.is_alphanumeric() || c == '_' || c == '-');
            if !valid {
                return Err(ApiError::BadRequest(
                    "Option name must match ^[\\w-]{1,32}$".into(),
                ));
            }
        }
        if let Some(choices) = opt.get("choices").and_then(|v| v.as_array()) {
            if choices.len() > MAX_CHOICES_PER_OPTION {
                return Err(ApiError::BadRequest(format!(
                    "Maximum {MAX_CHOICES_PER_OPTION} choices per option"
                )));
            }
        }
        // Recursively validate nested options (sub-commands)
        if let Some(nested) = opt.get("options").and_then(|v| v.as_array()) {
            validate_options(nested)?;
        }
    }
    Ok(())
}

/// Verify that the authenticated user is the owner of the bot application,
/// or is the bot user itself (for Bot token auth).
async fn ensure_app_owner(
    state: &AppState,
    app_id: i64,
    auth_user_id: i64,
) -> Result<paracord_db::bot_applications::BotApplicationRow, ApiError> {
    let app = paracord_db::bot_applications::get_bot_application(&state.db, app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    // Allow access if auth user is the owner OR the bot user itself (Bot token auth)
    if app.owner_id != auth_user_id && app.bot_user_id != auth_user_id {
        return Err(ApiError::Forbidden);
    }
    Ok(app)
}

fn command_row_to_json(row: &paracord_db::application_commands::ApplicationCommandRow) -> Value {
    let options: Value = row
        .options
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(json!([]));

    json!({
        "id": row.id.to_string(),
        "application_id": row.application_id.to_string(),
        "guild_id": row.guild_id.map(|id| id.to_string()),
        "name": row.name,
        "description": row.description,
        "options": options,
        "type": row.cmd_type,
        "default_member_permissions": row.default_member_permissions.map(|p| p.to_string()),
        "dm_permission": row.dm_permission,
        "nsfw": row.nsfw,
        "version": row.version,
        "created_at": row.created_at.to_rfc3339(),
        "updated_at": row.updated_at.to_rfc3339(),
    })
}

// ── Request bodies ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateCommandRequest {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub options: Vec<serde_json::Value>,
    #[serde(rename = "type")]
    pub cmd_type: Option<i16>,
    pub default_member_permissions: Option<String>,
    pub dm_permission: Option<bool>,
    pub nsfw: Option<bool>,
}

#[derive(Deserialize)]
pub struct UpdateCommandRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub options: Option<Vec<serde_json::Value>>,
    pub default_member_permissions: Option<String>,
    pub dm_permission: Option<bool>,
    pub nsfw: Option<bool>,
}

#[derive(Deserialize)]
pub struct BulkOverwriteCommandRequest {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub options: Vec<serde_json::Value>,
    #[serde(rename = "type")]
    pub cmd_type: Option<i16>,
    pub default_member_permissions: Option<String>,
    pub dm_permission: Option<bool>,
    pub nsfw: Option<bool>,
}

// ── Global command endpoints ────────────────────────────────────────────────

pub async fn list_global_commands(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(app_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    ensure_app_owner(&state, app_id, auth.user_id).await?;

    let rows = paracord_db::application_commands::list_global_commands(&state.db, app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(json!(rows
        .iter()
        .map(command_row_to_json)
        .collect::<Vec<Value>>())))
}

pub async fn create_global_command(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(app_id): Path<i64>,
    Json(body): Json<CreateCommandRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    ensure_app_owner(&state, app_id, auth.user_id).await?;

    // Enforce max commands per scope
    let existing = paracord_db::application_commands::list_global_commands(&state.db, app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if existing.len() >= MAX_COMMANDS_PER_SCOPE {
        return Err(ApiError::BadRequest(format!(
            "Maximum {MAX_COMMANDS_PER_SCOPE} commands per scope"
        )));
    }

    let name = body.name.trim().to_lowercase();
    validate_command_name(&name)?;
    validate_command_description(&body.description)?;
    validate_options(&body.options)?;

    let cmd_type = body.cmd_type.unwrap_or(1); // default ChatInput
    let options_json = if body.options.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&body.options).map_err(|e| {
            ApiError::Internal(anyhow::anyhow!("Failed to serialize options: {}", e))
        })?)
    };
    let default_member_permissions = body
        .default_member_permissions
        .as_deref()
        .map(|v| {
            v.parse::<i64>()
                .map_err(|_| ApiError::BadRequest("Invalid default_member_permissions".into()))
        })
        .transpose()?;

    let id = paracord_util::snowflake::generate(1);
    let row = paracord_db::application_commands::create_command(
        &state.db,
        id,
        app_id,
        None, // global command
        &name,
        &body.description,
        options_json.as_deref(),
        cmd_type,
        default_member_permissions,
        body.dm_permission.unwrap_or(true),
        body.nsfw.unwrap_or(false),
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok((StatusCode::CREATED, Json(command_row_to_json(&row))))
}

pub async fn get_global_command(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((app_id, cmd_id)): Path<(i64, i64)>,
) -> Result<Json<Value>, ApiError> {
    ensure_app_owner(&state, app_id, auth.user_id).await?;

    let row = paracord_db::application_commands::get_command(&state.db, cmd_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    // Verify the command belongs to this application and is global
    if row.application_id != app_id || row.guild_id.is_some() {
        return Err(ApiError::NotFound);
    }

    Ok(Json(command_row_to_json(&row)))
}

pub async fn update_global_command(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((app_id, cmd_id)): Path<(i64, i64)>,
    Json(body): Json<UpdateCommandRequest>,
) -> Result<Json<Value>, ApiError> {
    ensure_app_owner(&state, app_id, auth.user_id).await?;

    let existing = paracord_db::application_commands::get_command(&state.db, cmd_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if existing.application_id != app_id || existing.guild_id.is_some() {
        return Err(ApiError::NotFound);
    }

    let name = body
        .name
        .as_deref()
        .map(|n| {
            let trimmed = n.trim().to_lowercase();
            validate_command_name(&trimmed)?;
            Ok::<String, ApiError>(trimmed)
        })
        .transpose()?;

    if let Some(ref desc) = body.description {
        validate_command_description(desc)?;
    }

    if let Some(ref opts) = body.options {
        validate_options(opts)?;
    }

    let options_json = body
        .options
        .as_ref()
        .map(|opts| {
            serde_json::to_string(opts)
                .map_err(|e| ApiError::Internal(anyhow::anyhow!("serialize options: {}", e)))
        })
        .transpose()?;
    let default_member_permissions = body
        .default_member_permissions
        .as_deref()
        .map(|v| {
            v.parse::<i64>()
                .map_err(|_| ApiError::BadRequest("Invalid default_member_permissions".into()))
        })
        .transpose()?;

    let row = paracord_db::application_commands::update_command(
        &state.db,
        cmd_id,
        name.as_deref(),
        body.description.as_deref(),
        options_json.as_deref(),
        default_member_permissions,
        body.dm_permission,
        body.nsfw,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(command_row_to_json(&row)))
}

pub async fn delete_global_command(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((app_id, cmd_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    ensure_app_owner(&state, app_id, auth.user_id).await?;

    let existing = paracord_db::application_commands::get_command(&state.db, cmd_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if existing.application_id != app_id || existing.guild_id.is_some() {
        return Err(ApiError::NotFound);
    }

    paracord_db::application_commands::delete_command(&state.db, cmd_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn bulk_overwrite_global_commands(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(app_id): Path<i64>,
    Json(body): Json<Vec<BulkOverwriteCommandRequest>>,
) -> Result<Json<Value>, ApiError> {
    ensure_app_owner(&state, app_id, auth.user_id).await?;

    // Validate all commands first
    let mut prepared = Vec::with_capacity(body.len());
    for cmd in &body {
        let name = cmd.name.trim().to_lowercase();
        validate_command_name(&name)?;
        validate_command_description(&cmd.description)?;
        validate_options(&cmd.options)?;

        let cmd_type = cmd.cmd_type.unwrap_or(1);
        let options_json = if cmd.options.is_empty() {
            None
        } else {
            Some(
                serde_json::to_string(&cmd.options)
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!("serialize options: {}", e)))?,
            )
        };
        let default_member_permissions = cmd
            .default_member_permissions
            .as_deref()
            .map(|v| {
                v.parse::<i64>()
                    .map_err(|_| ApiError::BadRequest("Invalid default_member_permissions".into()))
            })
            .transpose()?;

        let id = paracord_util::snowflake::generate(1);
        prepared.push((
            id,
            name,
            cmd.description.clone(),
            options_json,
            cmd_type,
            default_member_permissions,
            cmd.dm_permission.unwrap_or(true),
            cmd.nsfw.unwrap_or(false),
        ));
    }

    // Build tuple refs for the DB call
    let refs: Vec<(i64, &str, &str, Option<&str>, i16, Option<i64>, bool, bool)> = prepared
        .iter()
        .map(|(id, name, desc, opts, cmd_type, perms, dm, nsfw)| {
            (
                *id,
                name.as_str(),
                desc.as_str(),
                opts.as_deref(),
                *cmd_type,
                *perms,
                *dm,
                *nsfw,
            )
        })
        .collect();

    let rows =
        paracord_db::application_commands::bulk_overwrite_global_commands(&state.db, app_id, &refs)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(json!(rows
        .iter()
        .map(command_row_to_json)
        .collect::<Vec<Value>>())))
}

// ── Guild available commands (for regular users) ────────────────────────────

/// GET /api/v1/guilds/{guild_id}/commands
///
/// List all commands available in a guild (global + guild-scoped from installed bots).
/// Available to any guild member.
pub async fn list_guild_available_commands_handler(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    // Verify the user is a member of this guild
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let member_perms = paracord_core::permissions::compute_guild_permissions(
        &state.db,
        guild_id,
        guild.owner_id,
        auth.user_id,
    )
    .await?;

    let rows =
        paracord_db::application_commands::list_guild_available_commands(&state.db, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // Hide commands the caller cannot invoke. `default_member_permissions` is
    // enforced per channel at invoke time (see
    // `routes::interactions::ensure_command_invocable`); this list has no
    // channel context, so it filters on the caller's guild-level permissions —
    // enough to keep an admin-only command out of a default member's picker.
    // `Some(0)` is the "disabled for everyone but administrators" encoding.
    let visible: Vec<Value> = rows
        .iter()
        .filter(|row| match row.default_member_permissions {
            None => true,
            Some(bits) => {
                let required = Permissions::from_bits_truncate(bits);
                if required.is_empty() {
                    member_perms.contains(Permissions::ADMINISTRATOR)
                } else {
                    member_perms.contains(required)
                }
            }
        })
        .map(command_row_to_json)
        .collect();

    Ok(Json(json!(visible)))
}

// ── Guild command endpoints ─────────────────────────────────────────────────

pub async fn list_guild_commands(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((app_id, guild_id)): Path<(i64, i64)>,
) -> Result<Json<Value>, ApiError> {
    ensure_app_owner(&state, app_id, auth.user_id).await?;

    let rows = paracord_db::application_commands::list_guild_commands(&state.db, app_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(json!(rows
        .iter()
        .map(command_row_to_json)
        .collect::<Vec<Value>>())))
}

pub async fn create_guild_command(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((app_id, guild_id)): Path<(i64, i64)>,
    Json(body): Json<CreateCommandRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    ensure_app_owner(&state, app_id, auth.user_id).await?;

    // Verify bot is installed in this guild
    let installed = paracord_db::bot_applications::is_bot_in_guild(&state.db, app_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !installed {
        return Err(ApiError::BadRequest(
            "Bot is not installed in this guild".into(),
        ));
    }

    // Enforce max commands per scope
    let existing =
        paracord_db::application_commands::list_guild_commands(&state.db, app_id, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if existing.len() >= MAX_COMMANDS_PER_SCOPE {
        return Err(ApiError::BadRequest(format!(
            "Maximum {MAX_COMMANDS_PER_SCOPE} commands per scope"
        )));
    }

    let name = body.name.trim().to_lowercase();
    validate_command_name(&name)?;
    validate_command_description(&body.description)?;
    validate_options(&body.options)?;

    let cmd_type = body.cmd_type.unwrap_or(1);
    let options_json = if body.options.is_empty() {
        None
    } else {
        Some(
            serde_json::to_string(&body.options)
                .map_err(|e| ApiError::Internal(anyhow::anyhow!("serialize options: {}", e)))?,
        )
    };
    let default_member_permissions = body
        .default_member_permissions
        .as_deref()
        .map(|v| {
            v.parse::<i64>()
                .map_err(|_| ApiError::BadRequest("Invalid default_member_permissions".into()))
        })
        .transpose()?;

    let id = paracord_util::snowflake::generate(1);
    let row = paracord_db::application_commands::create_command(
        &state.db,
        id,
        app_id,
        Some(guild_id),
        &name,
        &body.description,
        options_json.as_deref(),
        cmd_type,
        default_member_permissions,
        body.dm_permission.unwrap_or(true),
        body.nsfw.unwrap_or(false),
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok((StatusCode::CREATED, Json(command_row_to_json(&row))))
}

pub async fn get_guild_command(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((app_id, guild_id, cmd_id)): Path<(i64, i64, i64)>,
) -> Result<Json<Value>, ApiError> {
    ensure_app_owner(&state, app_id, auth.user_id).await?;

    let row = paracord_db::application_commands::get_command(&state.db, cmd_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if row.application_id != app_id || row.guild_id != Some(guild_id) {
        return Err(ApiError::NotFound);
    }

    Ok(Json(command_row_to_json(&row)))
}

pub async fn update_guild_command(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((app_id, guild_id, cmd_id)): Path<(i64, i64, i64)>,
    Json(body): Json<UpdateCommandRequest>,
) -> Result<Json<Value>, ApiError> {
    ensure_app_owner(&state, app_id, auth.user_id).await?;

    // Verify bot is installed in this guild
    let installed = paracord_db::bot_applications::is_bot_in_guild(&state.db, app_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !installed {
        return Err(ApiError::BadRequest(
            "Bot is not installed in this guild".into(),
        ));
    }

    let existing = paracord_db::application_commands::get_command(&state.db, cmd_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if existing.application_id != app_id || existing.guild_id != Some(guild_id) {
        return Err(ApiError::NotFound);
    }

    let name = body
        .name
        .as_deref()
        .map(|n| {
            let trimmed = n.trim().to_lowercase();
            validate_command_name(&trimmed)?;
            Ok::<String, ApiError>(trimmed)
        })
        .transpose()?;

    if let Some(ref desc) = body.description {
        validate_command_description(desc)?;
    }

    if let Some(ref opts) = body.options {
        validate_options(opts)?;
    }

    let options_json = body
        .options
        .as_ref()
        .map(|opts| {
            serde_json::to_string(opts)
                .map_err(|e| ApiError::Internal(anyhow::anyhow!("serialize options: {}", e)))
        })
        .transpose()?;
    let default_member_permissions = body
        .default_member_permissions
        .as_deref()
        .map(|v| {
            v.parse::<i64>()
                .map_err(|_| ApiError::BadRequest("Invalid default_member_permissions".into()))
        })
        .transpose()?;

    let row = paracord_db::application_commands::update_command(
        &state.db,
        cmd_id,
        name.as_deref(),
        body.description.as_deref(),
        options_json.as_deref(),
        default_member_permissions,
        body.dm_permission,
        body.nsfw,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(command_row_to_json(&row)))
}

pub async fn delete_guild_command(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((app_id, guild_id, cmd_id)): Path<(i64, i64, i64)>,
) -> Result<StatusCode, ApiError> {
    ensure_app_owner(&state, app_id, auth.user_id).await?;

    // Verify bot is installed in this guild
    let installed = paracord_db::bot_applications::is_bot_in_guild(&state.db, app_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !installed {
        return Err(ApiError::BadRequest(
            "Bot is not installed in this guild".into(),
        ));
    }

    let existing = paracord_db::application_commands::get_command(&state.db, cmd_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if existing.application_id != app_id || existing.guild_id != Some(guild_id) {
        return Err(ApiError::NotFound);
    }

    paracord_db::application_commands::delete_command(&state.db, cmd_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn bulk_overwrite_guild_commands(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((app_id, guild_id)): Path<(i64, i64)>,
    Json(body): Json<Vec<BulkOverwriteCommandRequest>>,
) -> Result<Json<Value>, ApiError> {
    ensure_app_owner(&state, app_id, auth.user_id).await?;

    // Verify bot is installed in this guild
    let installed = paracord_db::bot_applications::is_bot_in_guild(&state.db, app_id, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !installed {
        return Err(ApiError::BadRequest(
            "Bot is not installed in this guild".into(),
        ));
    }

    let mut prepared = Vec::with_capacity(body.len());
    for cmd in &body {
        let name = cmd.name.trim().to_lowercase();
        validate_command_name(&name)?;
        validate_command_description(&cmd.description)?;
        validate_options(&cmd.options)?;

        let cmd_type = cmd.cmd_type.unwrap_or(1);
        let options_json = if cmd.options.is_empty() {
            None
        } else {
            Some(
                serde_json::to_string(&cmd.options)
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!("serialize options: {}", e)))?,
            )
        };
        let default_member_permissions = cmd
            .default_member_permissions
            .as_deref()
            .map(|v| {
                v.parse::<i64>()
                    .map_err(|_| ApiError::BadRequest("Invalid default_member_permissions".into()))
            })
            .transpose()?;

        let id = paracord_util::snowflake::generate(1);
        prepared.push((
            id,
            name,
            cmd.description.clone(),
            options_json,
            cmd_type,
            default_member_permissions,
            cmd.dm_permission.unwrap_or(true),
            cmd.nsfw.unwrap_or(false),
        ));
    }

    let refs: Vec<(i64, &str, &str, Option<&str>, i16, Option<i64>, bool, bool)> = prepared
        .iter()
        .map(|(id, name, desc, opts, cmd_type, perms, dm, nsfw)| {
            (
                *id,
                name.as_str(),
                desc.as_str(),
                opts.as_deref(),
                *cmd_type,
                *perms,
                *dm,
                *nsfw,
            )
        })
        .collect();

    let rows = paracord_db::application_commands::bulk_overwrite_guild_commands(
        &state.db, app_id, guild_id, &refs,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(json!(rows
        .iter()
        .map(command_row_to_json)
        .collect::<Vec<Value>>())))
}
