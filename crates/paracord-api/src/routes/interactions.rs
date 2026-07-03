use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use paracord_core::AppState;
use serde::Deserialize;
use serde_json::{json, Value};
use url::Url;

use crate::error::ApiError;
use crate::middleware::AuthUser;

const MAX_COMPONENT_URL_LEN: usize = 2_000;

fn contains_dangerous_markup(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("<script")
        || lower.contains("javascript:")
        || lower.contains("onerror=")
        || lower.contains("onload=")
        || lower.contains("<iframe")
}

fn validate_component_url(raw: &str) -> Result<(), ApiError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_COMPONENT_URL_LEN {
        return Err(ApiError::BadRequest("component URL is invalid".into()));
    }

    let parsed =
        Url::parse(trimmed).map_err(|_| ApiError::BadRequest("component URL is invalid".into()))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ApiError::BadRequest(
            "component URL must use http or https".into(),
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ApiError::BadRequest(
            "component URL must not include userinfo".into(),
        ));
    }

    Ok(())
}

fn validate_component_value(value: &Value) -> Result<(), ApiError> {
    match value {
        Value::Object(map) => {
            if let Some(url) = map.get("url") {
                let Some(url) = url.as_str() else {
                    return Err(ApiError::BadRequest(
                        "component URL must be a string".into(),
                    ));
                };
                validate_component_url(url)?;
            }
            if let Some(children) = map.get("components") {
                validate_message_components(children)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                validate_component_value(item)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_message_components(components: &Value) -> Result<(), ApiError> {
    let Some(items) = components.as_array() else {
        return Err(ApiError::BadRequest("components must be an array".into()));
    };
    for item in items {
        validate_component_value(item)?;
    }
    Ok(())
}

// ── Request bodies ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct InvokeInteractionRequest {
    pub command_name: Option<String>,
    pub guild_id: String,
    pub channel_id: String,
    #[serde(default)]
    pub options: Vec<Value>,
    /// Interaction type: 2 = ApplicationCommand (default), 3 = MessageComponent
    #[serde(rename = "type", default = "default_interaction_type")]
    pub interaction_type: i16,
    /// For MessageComponent interactions: the message ID containing the component
    pub message_id: Option<String>,
    /// For MessageComponent interactions
    pub custom_id: Option<String>,
    pub component_type: Option<i16>,
    pub values: Option<Vec<String>>,
}

fn default_interaction_type() -> i16 {
    2
}

#[derive(Deserialize)]
pub struct InteractionCallbackRequest {
    #[serde(rename = "type")]
    pub callback_type: u8,
    pub data: Option<Value>,
}

#[derive(Deserialize)]
pub struct EditOriginalRequest {
    pub content: Option<String>,
    pub embeds: Option<Vec<Value>>,
    pub components: Option<Vec<Value>>,
}

#[derive(Deserialize)]
pub struct FollowupMessageRequest {
    pub content: Option<String>,
    pub embeds: Option<Vec<Value>>,
    pub components: Option<Vec<Value>>,
    pub flags: Option<u32>,
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Validate an interaction token by hashing it and comparing to the stored hash.
async fn validate_interaction_token(
    state: &AppState,
    interaction_id: i64,
    raw_token: &str,
) -> Result<paracord_db::interaction_tokens::InteractionTokenRow, ApiError> {
    let token_row =
        paracord_db::interaction_tokens::get_interaction_token(&state.db, interaction_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::NotFound)?;

    // Check expiry
    if token_row.expires_at < chrono::Utc::now() {
        return Err(ApiError::BadRequest("Interaction token expired".into()));
    }

    // Verify the token using constant-time comparison (M12)
    if !paracord_db::bot_applications::verify_token_hash(raw_token, &token_row.token_hash) {
        return Err(ApiError::Unauthorized);
    }

    Ok(token_row)
}

/// Validate a webhook-style token for followup/edit endpoints.
/// The token is looked up by matching the app_id and token hash against interaction tokens.
async fn validate_webhook_token(
    state: &AppState,
    app_id: i64,
    raw_token: &str,
) -> Result<paracord_db::interaction_tokens::InteractionTokenRow, ApiError> {
    // We need to try both HMAC and legacy SHA-256 hashes since we can't know which was used
    // Try HMAC first if the secret is available
    let token_hash = paracord_db::bot_applications::hash_token(raw_token);

    let mut row = paracord_db::interaction_tokens::get_interaction_token_by_app_and_hash(
        &state.db,
        app_id,
        &token_hash,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // If not found with new hash, try legacy SHA-256 hash
    if row.is_none() {
        // Compute legacy hash (without HMAC)
        let legacy_hash = crate::secure_tokens::hash_token_sha256_hex(raw_token);
        row = paracord_db::interaction_tokens::get_interaction_token_by_app_and_hash(
            &state.db,
            app_id,
            &legacy_hash,
        )
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    }

    let row = row.ok_or(ApiError::NotFound)?;

    if row.expires_at < chrono::Utc::now() {
        return Err(ApiError::BadRequest("Interaction token expired".into()));
    }

    Ok(row)
}

// ── Endpoints ───────────────────────────────────────────────────────────────

/// POST /api/v1/interactions
///
/// Client invokes a slash command. The server looks up the command,
/// creates an Interaction + token, dispatches INTERACTION_CREATE to the bot,
/// and returns the interaction to the client.
pub async fn invoke_interaction(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<InvokeInteractionRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let guild_id = body
        .guild_id
        .parse::<i64>()
        .map_err(|_| ApiError::BadRequest("Invalid guild_id".into()))?;
    let channel_id = body
        .channel_id
        .parse::<i64>()
        .map_err(|_| ApiError::BadRequest("Invalid channel_id".into()))?;

    // Verify the user is a member of this guild
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    match body.interaction_type {
        // ApplicationCommand (2)
        2 => {
            let command_name = body.command_name.as_deref().ok_or_else(|| {
                ApiError::BadRequest("command_name required for slash commands".into())
            })?;

            // Resolve the command
            let cmd =
                paracord_core::interactions::resolve_slash_command(&state, command_name, guild_id)
                    .await
                    .map_err(ApiError::from)?
                    .ok_or_else(|| ApiError::NotFound)?;

            // Look up the bot application to get the bot_user_id
            let bot_app =
                paracord_db::bot_applications::get_bot_application(&state.db, cmd.application_id)
                    .await
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                    .ok_or(ApiError::NotFound)?;

            // Build interaction data
            let interaction_data = json!({
                "id": cmd.id.to_string(),
                "name": cmd.name,
                "type": cmd.cmd_type,
                "options": body.options,
            });

            let (interaction, _token) = paracord_core::interactions::create_interaction(
                &state,
                cmd.application_id,
                bot_app.bot_user_id,
                Some(guild_id),
                channel_id,
                auth.user_id,
                2, // ApplicationCommand
                interaction_data,
            )
            .await
            .map_err(ApiError::from)?;

            Ok((StatusCode::CREATED, Json(interaction)))
        }
        // MessageComponent (3)
        3 => {
            let message_id_str = body.message_id.as_deref().ok_or_else(|| {
                ApiError::BadRequest("message_id required for component interactions".into())
            })?;
            let message_id = message_id_str
                .parse::<i64>()
                .map_err(|_| ApiError::BadRequest("Invalid message_id".into()))?;
            let custom_id = body.custom_id.as_deref().ok_or_else(|| {
                ApiError::BadRequest("custom_id required for component interactions".into())
            })?;

            // Look up the message to find the bot author
            let msg = paracord_db::messages::get_message(&state.db, message_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                .ok_or(ApiError::NotFound)?;

            // Find the bot application by bot_user_id (the message author)
            let bot_app = paracord_db::bot_applications::get_bot_application_by_user_id(
                &state.db,
                msg.author_id,
            )
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or_else(|| ApiError::BadRequest("message was not sent by a bot".into()))?;

            let interaction_data = json!({
                "custom_id": custom_id,
                "component_type": body.component_type.unwrap_or(2),
                "values": body.values,
                "message": {
                    "id": msg.id.to_string(),
                    "channel_id": msg.channel_id.to_string(),
                },
            });

            let (interaction, _token) = paracord_core::interactions::create_interaction(
                &state,
                bot_app.id,
                bot_app.bot_user_id,
                Some(guild_id),
                channel_id,
                auth.user_id,
                3, // MessageComponent
                interaction_data,
            )
            .await
            .map_err(ApiError::from)?;

            Ok((StatusCode::CREATED, Json(interaction)))
        }
        _ => Err(ApiError::BadRequest(format!(
            "unsupported interaction type: {}",
            body.interaction_type
        ))),
    }
}

/// POST /api/v1/interactions/{interaction_id}/{token}/callback
///
/// Bot responds to an interaction.
pub async fn interaction_callback(
    State(state): State<AppState>,
    Path((interaction_id, token)): Path<(i64, String)>,
    Json(body): Json<InteractionCallbackRequest>,
) -> Result<Json<Value>, ApiError> {
    let token_row = validate_interaction_token(&state, interaction_id, &token).await?;

    // M18: Validate callback content for dangerous markup
    if let Some(data) = body.data.as_ref() {
        if let Some(content) = data.get("content").and_then(|v| v.as_str()) {
            if contains_dangerous_markup(content) {
                return Err(ApiError::BadRequest(
                    "Content contains unsafe markup".into(),
                ));
            }
        }
        if let Some(components) = data.get("components") {
            validate_message_components(components)?;
        }
    }

    let result = paracord_core::interactions::process_interaction_response(
        &state,
        interaction_id,
        &token_row,
        body.callback_type,
        body.data.as_ref(),
    )
    .await
    .map_err(ApiError::from)?;

    Ok(Json(result.unwrap_or(json!({"type": body.callback_type}))))
}

/// PATCH /api/v1/interactions/{app_id}/{token}/messages/@original
///
/// Edit original interaction response message.
pub async fn edit_original_response(
    State(state): State<AppState>,
    Path((app_id, token)): Path<(i64, String)>,
    Json(body): Json<EditOriginalRequest>,
) -> Result<Json<Value>, ApiError> {
    let token_row = validate_webhook_token(&state, app_id, &token).await?;

    // M14: Verify bot is still installed in the guild before allowing edit
    if let Some(guild_id) = token_row.guild_id {
        let is_installed =
            paracord_db::bot_applications::is_bot_in_guild(&state.db, app_id, guild_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        if !is_installed {
            return Err(ApiError::Forbidden);
        }
    }

    let content = body.content.as_deref().unwrap_or("");

    // M18: Validate edited content for dangerous markup
    if !content.is_empty() && contains_dangerous_markup(content) {
        return Err(ApiError::BadRequest(
            "Content contains unsafe markup".into(),
        ));
    }
    if let Some(components) = body.components.as_ref() {
        validate_message_components(&Value::Array(components.clone()))?;
    }

    // H12: Use the stored response_message_id to find the original message.
    // This ensures we only edit the message created by this specific interaction,
    // preventing bots from editing arbitrary messages via token reuse.
    let msg_id = token_row
        .response_message_id
        .ok_or_else(|| ApiError::NotFound)?;

    let mut updated = if body.content.is_some() {
        paracord_db::messages::update_message(&state.db, msg_id, content)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    } else {
        paracord_db::messages::get_message(&state.db, msg_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::NotFound)?
    };

    if let Some(components) = body.components.as_ref() {
        let components_json = serde_json::to_string(components)
            .map_err(|_| ApiError::BadRequest("Invalid components payload".into()))?;
        paracord_db::messages::update_message_components(&state.db, msg_id, &components_json)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    }
    if let Some(embeds) = body.embeds.as_ref() {
        let embeds_json = serde_json::to_string(embeds)
            .map_err(|_| ApiError::BadRequest("Invalid embeds payload".into()))?;
        paracord_db::messages::update_message_embeds(&state.db, msg_id, &embeds_json)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    }
    if body.components.is_some() || body.embeds.is_some() {
        updated = paracord_db::messages::get_message(&state.db, msg_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::NotFound)?;
    }

    let components_value: Value = updated
        .components
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(json!([]));
    let embeds_value: Value = updated
        .embeds
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(json!([]));

    let msg_json = json!({
        "id": updated.id.to_string(),
        "channel_id": updated.channel_id.to_string(),
        "author_id": updated.author_id.to_string(),
        "content": updated.content,
        "message_type": updated.message_type,
        "flags": updated.flags,
        "components": components_value,
        "embeds": embeds_value,
        "edited_at": updated.edited_at.map(|t| t.to_rfc3339()),
        "created_at": updated.created_at.to_rfc3339(),
    });

    // Dispatch MESSAGE_UPDATE
    state
        .event_bus
        .dispatch("MESSAGE_UPDATE", msg_json.clone(), token_row.guild_id);

    Ok(Json(msg_json))
}

/// DELETE /api/v1/interactions/{app_id}/{token}/messages/@original
///
/// Delete original interaction response message.
pub async fn delete_original_response(
    State(state): State<AppState>,
    Path((app_id, token)): Path<(i64, String)>,
) -> Result<StatusCode, ApiError> {
    let token_row = validate_webhook_token(&state, app_id, &token).await?;

    // M14: Verify bot is still installed in the guild before allowing delete
    if let Some(guild_id) = token_row.guild_id {
        let is_installed =
            paracord_db::bot_applications::is_bot_in_guild(&state.db, app_id, guild_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        if !is_installed {
            return Err(ApiError::Forbidden);
        }
    }

    // Use the stored response_message_id to find the original message
    let msg_id = token_row
        .response_message_id
        .ok_or_else(|| ApiError::NotFound)?;

    paracord_db::messages::delete_message(&state.db, msg_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // Dispatch MESSAGE_DELETE
    state.event_bus.dispatch(
        "MESSAGE_DELETE",
        json!({
            "id": msg_id.to_string(),
            "channel_id": token_row.channel_id.to_string(),
            "guild_id": token_row.guild_id.map(|id| id.to_string()),
        }),
        token_row.guild_id,
    );

    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/interactions/{app_id}/{token}/followup
///
/// Send a followup message for an interaction.
pub async fn create_followup_message(
    State(state): State<AppState>,
    Path((app_id, token)): Path<(i64, String)>,
    Json(body): Json<FollowupMessageRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let token_row = validate_webhook_token(&state, app_id, &token).await?;

    // M14: Verify the bot is still installed in the guild before allowing a
    // followup (mirrors edit_original_response / delete_original_response).
    if let Some(guild_id) = token_row.guild_id {
        let is_installed =
            paracord_db::bot_applications::is_bot_in_guild(&state.db, app_id, guild_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        if !is_installed {
            return Err(ApiError::Forbidden);
        }
    }

    // Look up the bot application to get the real bot_user_id for message authorship
    let bot_app = paracord_db::bot_applications::get_bot_application(&state.db, app_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let content = body.content.as_deref().unwrap_or("");

    // M18: Validate followup content for dangerous markup
    if !content.is_empty() && contains_dangerous_markup(content) {
        return Err(ApiError::BadRequest(
            "Content contains unsafe markup".into(),
        ));
    }

    let components = body.components.unwrap_or_default();
    validate_message_components(&Value::Array(components.clone()))?;
    let embeds = body.embeds.unwrap_or_default();
    let flags = body.flags.unwrap_or(0) as i32;
    let message_id = paracord_util::snowflake::generate(1);

    let components_json = serde_json::to_string(&components)
        .map_err(|_| ApiError::BadRequest("Invalid components payload".into()))?;
    let embeds_json = serde_json::to_string(&embeds)
        .map_err(|_| ApiError::BadRequest("Invalid embeds payload".into()))?;

    let msg = paracord_db::messages::create_message_with_payload(
        &state.db,
        message_id,
        token_row.channel_id,
        bot_app.bot_user_id,
        content,
        20, // APPLICATION_COMMAND message type
        None,
        flags,
        None,
        None,
        Some(&components_json),
        Some(&embeds_json),
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let msg_json = json!({
        "id": msg.id.to_string(),
        "channel_id": msg.channel_id.to_string(),
        "author_id": msg.author_id.to_string(),
        "content": msg.content,
        "message_type": msg.message_type,
        "flags": msg.flags,
        "components": msg.components.as_deref().and_then(|s| serde_json::from_str::<Value>(s).ok()).unwrap_or(json!([])),
        "embeds": msg.embeds.as_deref().and_then(|s| serde_json::from_str::<Value>(s).ok()).unwrap_or(json!([])),
        "interaction": {
            "id": token_row.interaction_id.to_string(),
            "type": token_row.interaction_type,
        },
        "created_at": msg.created_at.to_rfc3339(),
    });

    state
        .event_bus
        .dispatch("MESSAGE_CREATE", msg_json.clone(), token_row.guild_id);

    Ok((StatusCode::CREATED, Json(msg_json)))
}
