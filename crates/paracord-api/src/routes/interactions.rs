use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use url::Url;

use crate::error::ApiError;
use crate::middleware::AuthUser;

const MAX_COMPONENT_URL_LEN: usize = 2_000;
const MAX_COMPONENT_CUSTOM_ID_LEN: usize = 100;
const MAX_SELECT_VALUES: usize = 25;
const MAX_MODAL_INPUTS: usize = 5;
const MAX_MODAL_VALUE_LEN: usize = 4_000;

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

fn collect_custom_id_matches(value: &Value, custom_id: &str, matches: &mut Vec<Value>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_custom_id_matches(item, custom_id, matches);
            }
        }
        Value::Object(map) => {
            if map.get("custom_id").and_then(Value::as_str) == Some(custom_id) {
                matches.push(value.clone());
            }
            if let Some(children) = map.get("components") {
                collect_custom_id_matches(children, custom_id, matches);
            }
        }
        _ => {}
    }
}

/// Bind a component submission to the exact enabled component persisted on the
/// message. This prevents clients from inventing a bot action `custom_id` or
/// supplying values that the rendered control could never produce.
fn validate_component_submission(
    stored_components: Option<&str>,
    custom_id: &str,
    submitted_type: Option<i16>,
    submitted_values: Option<Vec<String>>,
) -> Result<(i16, Vec<String>), ApiError> {
    if custom_id.is_empty() || custom_id.len() > MAX_COMPONENT_CUSTOM_ID_LEN {
        return Err(ApiError::BadRequest(
            "component custom_id is invalid".into(),
        ));
    }
    let submitted_type =
        submitted_type.ok_or_else(|| ApiError::BadRequest("component_type is required".into()))?;
    let stored: Value = serde_json::from_str(
        stored_components
            .ok_or_else(|| ApiError::BadRequest("message has no components".into()))?,
    )
    .map_err(|_| ApiError::BadRequest("message components are invalid".into()))?;

    let mut matches = Vec::new();
    collect_custom_id_matches(&stored, custom_id, &mut matches);
    if matches.len() != 1 {
        return Err(ApiError::BadRequest(
            "component does not exist uniquely on this message".into(),
        ));
    }
    let component = matches
        .pop()
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| ApiError::BadRequest("stored component is invalid".into()))?;
    if component.get("disabled").and_then(Value::as_bool) == Some(true) {
        return Err(ApiError::BadRequest("component is disabled".into()));
    }
    let stored_type = component
        .get("type")
        .and_then(Value::as_i64)
        .and_then(|value| i16::try_from(value).ok())
        .ok_or_else(|| ApiError::BadRequest("stored component type is invalid".into()))?;
    if stored_type != submitted_type || !matches!(stored_type, 2 | 3 | 5 | 6 | 7 | 8) {
        return Err(ApiError::BadRequest(
            "component_type does not match the message".into(),
        ));
    }

    let values = submitted_values.unwrap_or_default();
    if stored_type == 2 {
        if component.get("style").and_then(Value::as_i64) == Some(5) {
            return Err(ApiError::BadRequest(
                "link buttons cannot be invoked".into(),
            ));
        }
        if !values.is_empty() {
            return Err(ApiError::BadRequest("buttons do not accept values".into()));
        }
        return Ok((stored_type, values));
    }

    let min_values = component
        .get("min_values")
        .and_then(Value::as_u64)
        .unwrap_or(1) as usize;
    let max_values = component
        .get("max_values")
        .and_then(Value::as_u64)
        .unwrap_or(1) as usize;
    if min_values > max_values
        || max_values > MAX_SELECT_VALUES
        || values.len() < min_values
        || values.len() > max_values
    {
        return Err(ApiError::BadRequest("invalid select value count".into()));
    }
    let mut unique = HashSet::new();
    if values.iter().any(|value| !unique.insert(value.as_str())) {
        return Err(ApiError::BadRequest(
            "duplicate select values are not allowed".into(),
        ));
    }

    if stored_type == 3 {
        let allowed: HashSet<&str> = component
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|option| option.get("value").and_then(Value::as_str))
            .collect();
        if values.iter().any(|value| !allowed.contains(value.as_str())) {
            return Err(ApiError::BadRequest(
                "select value is not present in the message component".into(),
            ));
        }
    } else if values.iter().any(|value| value.parse::<i64>().is_err()) {
        return Err(ApiError::BadRequest(
            "entity select values must be snowflake IDs".into(),
        ));
    }

    Ok((stored_type, values))
}

async fn validate_entity_select_values(
    state: &AppState,
    guild_id: i64,
    user_id: i64,
    component_type: i16,
    values: &[String],
) -> Result<(), ApiError> {
    for raw in values {
        let id = raw
            .parse::<i64>()
            .map_err(|_| ApiError::BadRequest("invalid entity select value".into()))?;
        let valid = match component_type {
            5 => paracord_db::members::get_member(&state.db, id, guild_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                .is_some(),
            6 => paracord_db::roles::get_role(&state.db, id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                .is_some_and(|role| role.space_id == guild_id),
            7 => {
                let member = paracord_db::members::get_member(&state.db, id, guild_id)
                    .await
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                    .is_some();
                let role = paracord_db::roles::get_role(&state.db, id)
                    .await
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                    .is_some_and(|role| role.space_id == guild_id);
                member || role
            }
            8 => {
                let Some(channel) = paracord_db::channels::get_channel(&state.db, id)
                    .await
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                else {
                    return Err(ApiError::BadRequest(
                        "selected channel does not exist".into(),
                    ));
                };
                if channel.guild_id() != Some(guild_id) {
                    false
                } else {
                    ensure_channel_access(state, guild_id, id, user_id, Permissions::VIEW_CHANNEL)
                        .await
                        .is_ok()
                }
            }
            _ => true,
        };
        if !valid {
            return Err(ApiError::BadRequest(
                "selected entity is not available in this guild".into(),
            ));
        }
    }
    Ok(())
}

#[derive(Clone)]
struct ModalInputDefinition {
    custom_id: String,
    required: bool,
    min_length: usize,
    max_length: usize,
}

fn modal_input_definitions(data: &Value) -> Result<Vec<ModalInputDefinition>, ApiError> {
    let title = data
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let custom_id = data
        .get("custom_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if title.is_empty() || title.chars().count() > 45 {
        return Err(ApiError::BadRequest("modal title is invalid".into()));
    }
    if custom_id.is_empty() || custom_id.len() > MAX_COMPONENT_CUSTOM_ID_LEN {
        return Err(ApiError::BadRequest("modal custom_id is invalid".into()));
    }
    let rows = data
        .get("components")
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::BadRequest("modal components must be an array".into()))?;
    if rows.is_empty() || rows.len() > MAX_MODAL_INPUTS {
        return Err(ApiError::BadRequest(
            "modal must contain 1 to 5 inputs".into(),
        ));
    }

    let mut definitions = Vec::with_capacity(rows.len());
    let mut ids = HashSet::new();
    for row in rows {
        if row.get("type").and_then(Value::as_i64) != Some(1) {
            return Err(ApiError::BadRequest(
                "modal inputs must be in action rows".into(),
            ));
        }
        let children = row
            .get("components")
            .and_then(Value::as_array)
            .ok_or_else(|| ApiError::BadRequest("modal action row is invalid".into()))?;
        if children.len() != 1 || children[0].get("type").and_then(Value::as_i64) != Some(4) {
            return Err(ApiError::BadRequest(
                "each modal row must contain one text input".into(),
            ));
        }
        let input = &children[0];
        let id = input
            .get("custom_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let label = input
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if id.is_empty()
            || id.len() > MAX_COMPONENT_CUSTOM_ID_LEN
            || label.is_empty()
            || label.chars().count() > 45
            || !ids.insert(id.to_owned())
        {
            return Err(ApiError::BadRequest("modal text input is invalid".into()));
        }
        let min_length = input.get("min_length").and_then(Value::as_u64).unwrap_or(0) as usize;
        let max_length = input
            .get("max_length")
            .and_then(Value::as_u64)
            .unwrap_or(MAX_MODAL_VALUE_LEN as u64) as usize;
        if min_length > max_length || max_length > MAX_MODAL_VALUE_LEN {
            return Err(ApiError::BadRequest(
                "modal input length limits are invalid".into(),
            ));
        }
        definitions.push(ModalInputDefinition {
            custom_id: id.to_owned(),
            required: input
                .get("required")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            min_length,
            max_length,
        });
    }
    Ok(definitions)
}

fn collect_submitted_modal_values(
    components: &[Value],
) -> Result<HashMap<String, String>, ApiError> {
    if components.len() > MAX_MODAL_INPUTS {
        return Err(ApiError::BadRequest("too many modal inputs".into()));
    }
    let mut values = HashMap::new();
    for row in components {
        if row.get("type").and_then(Value::as_i64) != Some(1) {
            return Err(ApiError::BadRequest("invalid modal submission row".into()));
        }
        let children = row
            .get("components")
            .and_then(Value::as_array)
            .ok_or_else(|| ApiError::BadRequest("invalid modal submission row".into()))?;
        if children.len() != 1 || children[0].get("type").and_then(Value::as_i64) != Some(4) {
            return Err(ApiError::BadRequest(
                "invalid modal submission input".into(),
            ));
        }
        let id = children[0]
            .get("custom_id")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::BadRequest("modal input custom_id is required".into()))?;
        let value = children[0]
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if values.insert(id.to_owned(), value.to_owned()).is_some() {
            return Err(ApiError::BadRequest("duplicate modal input".into()));
        }
    }
    Ok(values)
}

fn normalize_modal_submission(
    issued_data: &Value,
    submitted: &[Value],
) -> Result<Vec<Value>, ApiError> {
    let definitions = modal_input_definitions(issued_data)?;
    let mut values = collect_submitted_modal_values(submitted)?;
    let mut normalized = Vec::with_capacity(definitions.len());
    for definition in definitions {
        let value = values.remove(&definition.custom_id).unwrap_or_default();
        let length = value.chars().count();
        if (definition.required && value.is_empty())
            || length < definition.min_length
            || length > definition.max_length
        {
            return Err(ApiError::BadRequest("modal input value is invalid".into()));
        }
        normalized.push(json!({
            "type": 1,
            "components": [{
                "type": 4,
                "custom_id": definition.custom_id,
                "value": value,
            }],
        }));
    }
    if !values.is_empty() {
        return Err(ApiError::BadRequest(
            "modal contains an unknown input".into(),
        ));
    }
    Ok(normalized)
}

// ── Request bodies ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct InvokeInteractionRequest {
    pub command_name: Option<String>,
    pub guild_id: String,
    pub channel_id: String,
    #[serde(default)]
    pub options: Vec<Value>,
    /// Interaction type: 2 = ApplicationCommand (default), 3 = MessageComponent,
    /// 4 = ApplicationCommandAutocomplete, 5 = ModalSubmit
    #[serde(rename = "type", default = "default_interaction_type")]
    pub interaction_type: i16,
    /// For MessageComponent interactions: the message ID containing the component
    pub message_id: Option<String>,
    /// For MessageComponent / ModalSubmit interactions
    pub custom_id: Option<String>,
    pub component_type: Option<i16>,
    pub values: Option<Vec<String>>,
    /// Nested payload used by some clients (custom_id / component_type / values / components).
    pub data: Option<Value>,
    /// ModalSubmit text-input rows (also accepted via `data.components`).
    pub components: Option<Vec<Value>>,
    /// Bot application that opened the modal (ModalSubmit).
    pub application_id: Option<String>,
    /// Original interaction for which the bot issued this modal (ModalSubmit).
    pub source_interaction_id: Option<String>,
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

/// Ensure `channel_id` is a real channel that belongs to `guild_id` and that
/// the invoking `user_id` actually holds `required` permissions on it.
///
/// L04-05: interaction invocation previously trusted the client-supplied
/// `guild_id`/`channel_id`/`message_id` after only a guild-membership check,
/// letting a member forge component clicks against messages in channels they
/// cannot see and steer the bot's response into an arbitrary channel. This
/// binds the channel to the claimed guild and enforces the caller's own
/// channel-level permissions before an interaction is created.
async fn ensure_channel_access(
    state: &AppState,
    guild_id: i64,
    channel_id: i64,
    user_id: i64,
    required: Permissions,
) -> Result<(), ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    // The channel must actually live in the guild the caller claims.
    if channel.guild_id() != Some(guild_id) {
        return Err(ApiError::Forbidden);
    }

    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let perms = paracord_core::permissions::compute_channel_permissions(
        &state.db,
        guild_id,
        channel_id,
        guild.owner_id,
        user_id,
    )
    .await
    .map_err(ApiError::from)?;

    if !perms.contains(required) {
        return Err(ApiError::Forbidden);
    }

    Ok(())
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
            // L04-05: the channel must belong to the claimed guild and the
            // caller must be able to view it before we let them run a command
            // there (and steer the bot's response into it).
            ensure_channel_access(
                &state,
                guild_id,
                channel_id,
                auth.user_id,
                Permissions::VIEW_CHANNEL,
            )
            .await?;

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
            let nested = body.data.as_ref();
            let custom_id = body
                .custom_id
                .as_deref()
                .or_else(|| nested.and_then(|d| d.get("custom_id").and_then(|v| v.as_str())))
                .ok_or_else(|| {
                    ApiError::BadRequest("custom_id required for component interactions".into())
                })?;
            let component_type = body.component_type.or_else(|| {
                nested
                    .and_then(|d| d.get("component_type"))
                    .and_then(|v| v.as_i64())
                    .map(|n| n as i16)
            });
            let values = body.values.clone().or_else(|| {
                nested.and_then(|d| {
                    d.get("values").and_then(|v| v.as_array()).map(|arr| {
                        arr.iter()
                            .filter_map(|item| item.as_str().map(str::to_owned))
                            .collect::<Vec<_>>()
                    })
                })
            });

            // Look up the message to find the bot author
            let msg = paracord_db::messages::get_message(&state.db, message_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                .ok_or(ApiError::NotFound)?;

            // L04-05: bind the interaction to the message's real channel and
            // require the caller to actually be able to see that message.
            // Without this a guild member could forge a component click against
            // any message id (including admin-only control panels in channels
            // they cannot access) and redirect the bot's response elsewhere.
            if msg.channel_id != channel_id {
                return Err(ApiError::Forbidden);
            }
            ensure_channel_access(
                &state,
                guild_id,
                channel_id,
                auth.user_id,
                Permissions::VIEW_CHANNEL | Permissions::READ_MESSAGE_HISTORY,
            )
            .await?;

            // Find the bot application by bot_user_id (the message author)
            let bot_app = paracord_db::bot_applications::get_bot_application_by_user_id(
                &state.db,
                msg.author_id,
            )
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or_else(|| ApiError::BadRequest("message was not sent by a bot".into()))?;

            let (component_type, values) = validate_component_submission(
                msg.components.as_deref(),
                custom_id,
                component_type,
                values,
            )?;
            if matches!(component_type, 5..=8) {
                validate_entity_select_values(
                    &state,
                    guild_id,
                    auth.user_id,
                    component_type,
                    &values,
                )
                .await?;
            }

            let interaction_data = json!({
                "custom_id": custom_id,
                "component_type": component_type,
                "values": values,
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
        // ApplicationCommandAutocomplete (4)
        4 => {
            ensure_channel_access(
                &state,
                guild_id,
                channel_id,
                auth.user_id,
                Permissions::VIEW_CHANNEL,
            )
            .await?;

            let command_name = body.command_name.as_deref().ok_or_else(|| {
                ApiError::BadRequest("command_name required for autocomplete".into())
            })?;

            let cmd =
                paracord_core::interactions::resolve_slash_command(&state, command_name, guild_id)
                    .await
                    .map_err(ApiError::from)?
                    .ok_or(ApiError::NotFound)?;

            let bot_app =
                paracord_db::bot_applications::get_bot_application(&state.db, cmd.application_id)
                    .await
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                    .ok_or(ApiError::NotFound)?;

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
                4, // ApplicationCommandAutocomplete
                interaction_data,
            )
            .await
            .map_err(ApiError::from)?;

            Ok((StatusCode::CREATED, Json(interaction)))
        }
        // ModalSubmit (5)
        5 => {
            ensure_channel_access(
                &state,
                guild_id,
                channel_id,
                auth.user_id,
                Permissions::VIEW_CHANNEL,
            )
            .await?;

            let nested = body.data.as_ref();
            let custom_id = body
                .custom_id
                .as_deref()
                .or_else(|| nested.and_then(|d| d.get("custom_id").and_then(|v| v.as_str())))
                .ok_or_else(|| {
                    ApiError::BadRequest("custom_id required for modal submit".into())
                })?;

            let components = body
                .components
                .clone()
                .or_else(|| {
                    nested
                        .and_then(|d| d.get("components"))
                        .and_then(|v| v.as_array())
                        .cloned()
                })
                .unwrap_or_default();

            let source_interaction_id = body
                .source_interaction_id
                .as_deref()
                .ok_or_else(|| {
                    ApiError::BadRequest("source_interaction_id required for modal submit".into())
                })?
                .parse::<i64>()
                .map_err(|_| ApiError::BadRequest("Invalid source_interaction_id".into()))?;

            let source = paracord_db::interaction_tokens::get_interaction_token(
                &state.db,
                source_interaction_id,
            )
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::NotFound)?;
            if source.user_id != auth.user_id
                || source.guild_id != Some(guild_id)
                || source.channel_id != channel_id
                || source.expires_at <= chrono::Utc::now()
                || source.modal_issued_at.is_none()
                || source.modal_consumed_at.is_some()
            {
                return Err(ApiError::Forbidden);
            }
            let issued_data: Value = serde_json::from_str(
                source
                    .modal_data
                    .as_deref()
                    .ok_or_else(|| ApiError::BadRequest("modal was not issued".into()))?,
            )
            .map_err(|_| ApiError::BadRequest("issued modal is invalid".into()))?;
            if issued_data.get("custom_id").and_then(Value::as_str) != Some(custom_id) {
                return Err(ApiError::Forbidden);
            }
            let components = normalize_modal_submission(&issued_data, &components)?;

            let application_id = body
                .application_id
                .as_deref()
                .ok_or_else(|| {
                    ApiError::BadRequest("application_id required for modal submit".into())
                })?
                .parse::<i64>()
                .map_err(|_| ApiError::BadRequest("Invalid application_id".into()))?;
            if application_id != source.application_id {
                return Err(ApiError::Forbidden);
            }

            let bot_app =
                paracord_db::bot_applications::get_bot_application(&state.db, application_id)
                    .await
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
                    .ok_or(ApiError::NotFound)?;

            // Ensure the bot is still installed in this guild.
            let is_installed =
                paracord_db::bot_applications::is_bot_in_guild(&state.db, application_id, guild_id)
                    .await
                    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            if !is_installed {
                return Err(ApiError::Forbidden);
            }

            let consumed = paracord_db::interaction_tokens::consume_modal(
                &state.db,
                source_interaction_id,
                chrono::Utc::now(),
            )
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            if !consumed {
                return Err(ApiError::BadRequest(
                    "modal has expired or was already submitted".into(),
                ));
            }

            let interaction_data = json!({
                "custom_id": custom_id,
                "components": components,
            });

            let (interaction, _token) = paracord_core::interactions::create_interaction(
                &state,
                bot_app.id,
                bot_app.bot_user_id,
                Some(guild_id),
                channel_id,
                auth.user_id,
                5, // ModalSubmit
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
        if body.callback_type == 9 {
            modal_input_definitions(data)?;
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
