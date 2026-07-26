use chrono::{Duration, Utc};
use paracord_models::permissions::Permissions;
use rand::RngCore;
use serde_json::{json, Value};

use crate::error::CoreError;
use crate::AppState;

/// Generate a cryptographically random interaction token (hex-encoded).
fn generate_interaction_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// Create an interaction, store its token, and dispatch INTERACTION_CREATE to the bot.
///
/// Returns `(interaction_json, raw_token)` so the caller can return the token to the invoking user.
pub async fn create_interaction(
    state: &AppState,
    application_id: i64,
    bot_user_id: i64,
    guild_id: Option<i64>,
    channel_id: i64,
    user_id: i64,
    interaction_type: i16,
    data: Value,
) -> Result<(Value, String), CoreError> {
    let interaction_id = paracord_util::snowflake::generate(1);
    let token = generate_interaction_token();
    let token_hash = paracord_db::bot_applications::hash_token(&token);
    let token_row_id = paracord_util::snowflake::generate(1);
    let expires_at = Utc::now() + Duration::minutes(15);

    paracord_db::interaction_tokens::create_interaction_token(
        &state.db,
        token_row_id,
        interaction_id,
        application_id,
        &token_hash,
        channel_id,
        guild_id,
        user_id,
        interaction_type,
        expires_at,
    )
    .await
    .map_err(|e| CoreError::Internal(e.to_string()))?;

    // Build user info
    let invoking_user = paracord_db::users::get_user_by_id(&state.db, user_id)
        .await
        .map_err(|e| CoreError::Internal(e.to_string()))?;

    let user_json = invoking_user
        .map(|u| {
            json!({
                "id": u.id.to_string(),
                "username": u.username,
                "discriminator": u.discriminator,
                "avatar_hash": u.avatar_hash,
            })
        })
        .unwrap_or(json!(null));

    let interaction_payload = json!({
        "id": interaction_id.to_string(),
        "application_id": application_id.to_string(),
        "type": interaction_type,
        "data": data,
        "guild_id": guild_id.map(|id| id.to_string()),
        "channel_id": channel_id.to_string(),
        "user": user_json,
        "token": token,
        "version": 1,
    });

    // Dispatch INTERACTION_CREATE to the bot user only
    state.event_bus.dispatch_to_users(
        "INTERACTION_CREATE",
        interaction_payload.clone(),
        vec![bot_user_id],
    );

    Ok((interaction_payload, token))
}

/// Resolve a slash command by name for a given guild.
/// Looks up guild-scoped commands first, then global commands for the application.
pub async fn resolve_slash_command(
    state: &AppState,
    command_name: &str,
    guild_id: i64,
) -> Result<Option<paracord_db::application_commands::ApplicationCommandRow>, CoreError> {
    let available =
        paracord_db::application_commands::list_guild_available_commands(&state.db, guild_id)
            .await
            .map_err(|e| CoreError::Internal(e.to_string()))?;

    Ok(available.into_iter().find(|cmd| cmd.name == command_name))
}

/// Authorize a bot about to write into an interaction's channel.
///
/// The interaction token is a bearer credential minted 15 minutes earlier; it
/// says nothing about whether the bot is *still* installed, or whether it may
/// speak in `token_row.channel_id` now. Every callback that materializes a
/// message has to clear the same bar `create_followup_message` already does:
///
///  1. the application is still installed in the guild,
///  2. the channel still exists, and
///  3. the bot itself holds VIEW_CHANNEL **and** SEND_MESSAGES there.
///
/// `compute_channel_permissions` applies channel overwrites and caps the result
/// by the bot's install-time grant, so a bot installed with `permissions=0`
/// fails (3) even when its roles would allow it.
///
/// DM interactions (`guild_id == None`) have no guild permissions to evaluate;
/// they still get the channel-existence check.
async fn ensure_bot_can_write_response(
    state: &AppState,
    token_row: &paracord_db::interaction_tokens::InteractionTokenRow,
    bot_user_id: i64,
) -> Result<(), CoreError> {
    if let Some(guild_id) = token_row.guild_id {
        let is_installed = paracord_db::bot_applications::is_bot_in_guild(
            &state.db,
            token_row.application_id,
            guild_id,
        )
        .await
        .map_err(|e| CoreError::Internal(e.to_string()))?;
        if !is_installed {
            return Err(CoreError::Forbidden);
        }
    }

    let _channel = paracord_db::channels::get_channel(&state.db, token_row.channel_id)
        .await
        .map_err(|e| CoreError::Internal(e.to_string()))?
        .ok_or(CoreError::NotFound)?;

    if let Some(guild_id) = token_row.guild_id {
        let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
            .await
            .map_err(|e| CoreError::Internal(e.to_string()))?
            .ok_or(CoreError::NotFound)?;

        let bot_perms = crate::permissions::compute_channel_permissions(
            &state.db,
            guild_id,
            token_row.channel_id,
            guild.owner_id,
            bot_user_id,
        )
        .await?;

        if !bot_perms.contains(Permissions::VIEW_CHANNEL | Permissions::SEND_MESSAGES) {
            return Err(CoreError::MissingPermission);
        }
    }

    Ok(())
}

/// Process a bot's interaction response (callback).
/// Returns a message JSON if the callback creates or updates a message.
pub async fn process_interaction_response(
    state: &AppState,
    interaction_id: i64,
    token_row: &paracord_db::interaction_tokens::InteractionTokenRow,
    callback_type: u8,
    callback_data: Option<&serde_json::Value>,
) -> Result<Option<Value>, CoreError> {
    // Look up the bot application to get the real bot_user_id for message authorship
    let bot_app =
        paracord_db::bot_applications::get_bot_application(&state.db, token_row.application_id)
            .await
            .map_err(|e| CoreError::Internal(e.to_string()))?
            .ok_or_else(|| CoreError::Internal("bot application not found".into()))?;
    let author_id = bot_app.bot_user_id;

    match callback_type {
        // CHANNEL_MESSAGE_WITH_SOURCE (4)
        4 => {
            // H4-H5: install + channel + bot-permission checks before writing.
            ensure_bot_can_write_response(state, token_row, author_id).await?;

            let data = callback_data.ok_or_else(|| {
                CoreError::BadRequest("callback data required for message response".into())
            })?;
            let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");

            // 3. Validate content length (same limits as regular messages)
            const MAX_MESSAGE_CONTENT_LEN: usize = 4_000;
            if content.len() > MAX_MESSAGE_CONTENT_LEN {
                return Err(CoreError::BadRequest(format!(
                    "Message content exceeds {} characters",
                    MAX_MESSAGE_CONTENT_LEN
                )));
            }

            let components_json = data
                .get("components")
                .map(serde_json::to_string)
                .transpose()
                .map_err(|e| CoreError::Internal(format!("serialize components: {e}")))?;
            let embeds_json = data
                .get("embeds")
                .map(serde_json::to_string)
                .transpose()
                .map_err(|e| CoreError::Internal(format!("serialize embeds: {e}")))?;
            let flags = data.get("flags").and_then(|v| v.as_i64()).unwrap_or(0) as i32;

            let message_id = paracord_util::snowflake::generate(1);
            // Message type 20 = ChatInputCommand (interaction response)
            let msg = paracord_db::messages::create_message_with_payload(
                &state.db,
                message_id,
                token_row.channel_id,
                author_id,
                content,
                20, // APPLICATION_COMMAND message type
                None,
                flags,
                None,
                None,
                components_json.as_deref(),
                embeds_json.as_deref(),
            )
            .await
            .map_err(|e| CoreError::Internal(e.to_string()))?;

            // Store the response message ID on the token for edit/delete later
            let _ = paracord_db::interaction_tokens::update_response_message_id(
                &state.db,
                interaction_id,
                msg.id,
            )
            .await;

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
                    "id": interaction_id.to_string(),
                    "type": token_row.interaction_type,
                    "name": "command",
                },
                "created_at": msg.created_at.to_rfc3339(),
            });

            // Dispatch MESSAGE_CREATE
            let guild_id = token_row.guild_id;
            state
                .event_bus
                .dispatch("MESSAGE_CREATE", msg_json.clone(), guild_id);

            Ok(Some(msg_json))
        }
        // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (5) - acknowledge, bot will edit later
        5 => {
            // A deferral is not a no-op: it writes a (blank) bot message into
            // `token_row.channel_id` and broadcasts MESSAGE_CREATE for it. This
            // branch used to do no install check, no channel check and no
            // permission compute at all, making it the cheapest way for a
            // token-holding bot to place a message somewhere it may not speak.
            ensure_bot_can_write_response(state, token_row, author_id).await?;

            // Create a placeholder message (type 20) so there's something to edit later
            let message_id = paracord_util::snowflake::generate(1);
            let msg = paracord_db::messages::create_message(
                &state.db,
                message_id,
                token_row.channel_id,
                author_id,
                "",
                20, // APPLICATION_COMMAND message type
                None,
            )
            .await
            .map_err(|e| CoreError::Internal(e.to_string()))?;

            // Store the response message ID on the token for edit/delete later
            let _ = paracord_db::interaction_tokens::update_response_message_id(
                &state.db,
                interaction_id,
                msg.id,
            )
            .await;

            let msg_json = json!({
                "id": msg.id.to_string(),
                "channel_id": msg.channel_id.to_string(),
                "author_id": msg.author_id.to_string(),
                "content": "",
                "message_type": 20,
                "flags": 0,
                "interaction": {
                    "id": interaction_id.to_string(),
                    "type": token_row.interaction_type,
                    "name": "command",
                },
                "created_at": msg.created_at.to_rfc3339(),
            });

            state
                .event_bus
                .dispatch("MESSAGE_CREATE", msg_json.clone(), token_row.guild_id);

            Ok(Some(msg_json))
        }
        // DEFERRED_UPDATE_MESSAGE (6)
        6 => Ok(None),
        // UPDATE_MESSAGE (7)
        7 => {
            // H4-H5: install + channel + bot-permission checks before writing.
            ensure_bot_can_write_response(state, token_row, author_id).await?;

            let data = callback_data.ok_or_else(|| {
                CoreError::BadRequest("callback data required for update message response".into())
            })?;
            let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");

            // 3. Validate content length (same limits as regular messages)
            const MAX_MESSAGE_CONTENT_LEN: usize = 4_000;
            if content.len() > MAX_MESSAGE_CONTENT_LEN {
                return Err(CoreError::BadRequest(format!(
                    "Message content exceeds {} characters",
                    MAX_MESSAGE_CONTENT_LEN
                )));
            }

            // Find the original response message
            let msg_id = token_row.response_message_id.ok_or_else(|| {
                CoreError::BadRequest("no original response message to update".into())
            })?;

            let updated = paracord_db::messages::update_message(&state.db, msg_id, content)
                .await
                .map_err(|e| CoreError::Internal(e.to_string()))?;

            let msg_json = json!({
                "id": updated.id.to_string(),
                "channel_id": updated.channel_id.to_string(),
                "author_id": updated.author_id.to_string(),
                "content": updated.content,
                "message_type": updated.message_type,
                "edited_at": updated.edited_at.map(|t| t.to_rfc3339()),
                "created_at": updated.created_at.to_rfc3339(),
            });

            state
                .event_bus
                .dispatch("MESSAGE_UPDATE", msg_json.clone(), token_row.guild_id);

            Ok(Some(msg_json))
        }
        // AUTOCOMPLETE_RESULT (8)
        8 => {
            let data = callback_data.ok_or_else(|| {
                CoreError::BadRequest("callback data required for autocomplete response".into())
            })?;
            // Dispatch autocomplete choices back to the invoking user.
            // Include channel/guild/application so the client can stamp context
            // even when it never recorded a pending interaction.
            let autocomplete_payload = json!({
                "interaction_id": interaction_id.to_string(),
                "type": 8,
                "application_id": token_row.application_id.to_string(),
                "channel_id": token_row.channel_id.to_string(),
                "guild_id": token_row.guild_id.map(|id| id.to_string()),
                "data": data,
            });
            state.event_bus.dispatch_to_users(
                "INTERACTION_CREATE",
                autocomplete_payload.clone(),
                vec![token_row.user_id],
            );
            Ok(Some(autocomplete_payload))
        }
        // MODAL (9)
        9 => {
            let data = callback_data.ok_or_else(|| {
                CoreError::BadRequest("callback data required for modal response".into())
            })?;
            let modal_data = serde_json::to_string(data)
                .map_err(|e| CoreError::Internal(format!("serialize modal: {e}")))?;
            let issued = paracord_db::interaction_tokens::mark_modal_issued(
                &state.db,
                interaction_id,
                &modal_data,
                Utc::now(),
            )
            .await
            .map_err(|e| CoreError::Internal(e.to_string()))?;
            if !issued {
                return Err(CoreError::BadRequest(
                    "a modal was already issued for this interaction".into(),
                ));
            }
            // Dispatch a modal event to the invoking user (with channel/guild stamp).
            let modal_payload = json!({
                "interaction_id": interaction_id.to_string(),
                "type": 9,
                "application_id": token_row.application_id.to_string(),
                "channel_id": token_row.channel_id.to_string(),
                "guild_id": token_row.guild_id.map(|id| id.to_string()),
                "data": data,
            });
            state.event_bus.dispatch_to_users(
                "INTERACTION_CREATE",
                modal_payload.clone(),
                vec![token_row.user_id],
            );
            Ok(Some(modal_payload))
        }
        _ => Err(CoreError::BadRequest(format!(
            "unsupported callback type: {callback_type}"
        ))),
    }
}
