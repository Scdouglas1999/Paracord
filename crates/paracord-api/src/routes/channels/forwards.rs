use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::Deserialize;
use serde_json::{json, Value};

use super::ensure_channel_permissions;
use super::messages::message_content_has_dangerous_markup;
use crate::error::ApiError;

/// Most files one forward may carry, the same cap as an ordinary send.
const MAX_FORWARDED_ATTACHMENTS: usize = 10;

/// What the client says it is forwarding. The server rewrites every field of
/// the stored attribution from the source message after checking the
/// forwarder can read it.
#[derive(Debug, Clone, Deserialize)]
pub struct ForwardedFromRequest {
    pub channel_id: String,
    pub message_id: String,
    /// Plaintext of a direct-message source posted into a server channel. The
    /// server only has ciphertext for those, so the forwarder supplies the
    /// text they chose to post in the clear. Ignored for every other forward.
    pub content: Option<String>,
}

pub struct ResolvedForward {
    /// JSON stored on the new message and returned in message objects.
    pub json: String,
    /// Copies of a server-channel source's files, staged as pending uploads in
    /// the destination. `send_message` links them to the new message.
    pub staged_attachments: Vec<paracord_db::attachments::AttachmentRow>,
}

/// Check a forward and build what the new message stores.
///
/// Files are copied only from a server channel into a server channel. A direct
/// message's files are end-to-end encrypted and never leave it; a forward into
/// a direct message carries its files through the client's encrypted upload
/// path, because the server must not put plaintext files into an encrypted
/// conversation.
///
/// Returns `None` for a forward from one encrypted conversation into another.
/// The attribution for those travels inside the encrypted body, so the
/// instance keeps no record of which conversation or message the text came
/// from. A client from before that change still names the source here; the
/// message is stored without it rather than refused, so those clients can keep
/// forwarding.
pub async fn resolve_forward(
    state: &AppState,
    user_id: i64,
    dest_channel: &paracord_db::channels::ChannelRow,
    request: &ForwardedFromRequest,
) -> Result<Option<ResolvedForward>, ApiError> {
    let channel_id = request.channel_id.parse::<i64>().map_err(|_| {
        ApiError::BadRequest("That forward does not point at a real channel.".into())
    })?;
    let message_id = request.message_id.parse::<i64>().map_err(|_| {
        ApiError::BadRequest("That forward does not point at a real message.".into())
    })?;

    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    // Access first, so a message id in a channel the forwarder cannot read
    // answers the same way whether or not it exists.
    ensure_channel_permissions(
        state,
        &channel,
        user_id,
        &[Permissions::VIEW_CHANNEL, Permissions::READ_MESSAGE_HISTORY],
    )
    .await?;

    let source_is_dm = channel.guild_id().is_none();
    let dest_is_dm = dest_channel.guild_id().is_none();
    if source_is_dm && dest_is_dm {
        return Ok(None);
    }

    let message = paracord_db::messages::get_message(&state.db, message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if message.channel_id != channel_id {
        return Err(ApiError::NotFound);
    }

    let attachments = paracord_db::attachments::get_message_attachments(&state.db, message.id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if source_is_dm && !attachments.is_empty() {
        return Err(ApiError::BadRequest(
            "Attachments from an end-to-end encrypted conversation cannot be forwarded.".into(),
        ));
    }
    if attachments.len() > MAX_FORWARDED_ATTACHMENTS {
        return Err(ApiError::BadRequest(
            "This message has too many attachments to forward.".into(),
        ));
    }

    let json_text = match reforwarded_attribution(&message, source_is_dm) {
        Some(inner) => inner,
        None => {
            let content = forward_content(source_is_dm, &message, request)?;
            let (author_id, author_name) = source_author(state, &message).await?;
            let channel_name = channel_label(&channel, source_is_dm)?;
            let stored = json!({
                "channel_id": channel.id.to_string(),
                "message_id": message.id.to_string(),
                "guild_id": channel.guild_id().map(|id| id.to_string()),
                "author_id": author_id,
                "author_name": author_name,
                "sent_at": message.created_at.to_rfc3339(),
                "channel_name": channel_name,
                "content": content,
            });
            serde_json::to_string(&stored).map_err(|err| {
                ApiError::Internal(anyhow::anyhow!(
                    "forward attribution failed to encode: {err}"
                ))
            })?
        }
    };

    let mut staged_attachments = Vec::new();
    if !source_is_dm && !dest_is_dm && !attachments.is_empty() {
        crate::routes::files::validate_upload_permissions(state, dest_channel.id, user_id).await?;
        for attachment in &attachments {
            match crate::routes::files::stage_forwarded_attachment(
                state,
                attachment,
                dest_channel.id,
                user_id,
            )
            .await
            {
                Ok(copy) => staged_attachments.push(copy),
                Err(err) => {
                    discard_all(state, &staged_attachments).await;
                    return Err(err);
                }
            }
        }
    }

    Ok(Some(ResolvedForward {
        json: json_text,
        staged_attachments,
    }))
}

/// Drop staged copies that will not be linked (a failed or repeated send).
pub async fn discard_all(state: &AppState, staged: &[paracord_db::attachments::AttachmentRow]) {
    for attachment in staged {
        if let Err(err) = crate::routes::files::discard_staged_attachment(state, attachment).await {
            tracing::warn!(
                attachment_id = attachment.id,
                "failed to discard a staged forward copy: {err}"
            );
        }
    }
}

/// Forwarding a forward that added no words of its own points at the original,
/// not at the empty wrapper. Its attribution was checked when it was stored.
fn reforwarded_attribution(
    message: &paracord_db::messages::MessageRow,
    source_is_dm: bool,
) -> Option<String> {
    if source_is_dm {
        return None;
    }
    let inner = message.forwarded_from.as_deref()?;
    let note = message.content.as_deref().unwrap_or("").trim();
    if !note.is_empty() {
        return None;
    }
    serde_json::from_str::<Value>(inner)
        .ok()
        .filter(|value| value.get("error").is_none())
        .map(|_| inner.to_string())
}

fn forward_content(
    source_is_dm: bool,
    message: &paracord_db::messages::MessageRow,
    request: &ForwardedFromRequest,
) -> Result<Option<String>, ApiError> {
    if source_is_dm {
        let text = request.content.clone().unwrap_or_default();
        if text.trim().is_empty() {
            return Err(ApiError::BadRequest(
                "Include the text you are posting. This conversation is end-to-end encrypted, so the server does not have it.".into(),
            ));
        }
        paracord_util::validation::validate_message_content(&text).map_err(|_| {
            ApiError::BadRequest("A forwarded message can carry 1-2000 characters.".into())
        })?;
        if message_content_has_dangerous_markup(&text) {
            return Err(ApiError::BadRequest(
                "Message contains unsafe markup".into(),
            ));
        }
        return Ok(Some(text));
    }
    Ok(Some(message.content.clone().unwrap_or_default()))
}

/// Who the source message says wrote it, as its readers see it.
///
/// The attribution is stored once and shown to everyone who can read the
/// destination, so it must never be more than the source showed its own
/// readers: a post in an anonymous channel is credited to its alias, and a
/// webhook post to the webhook rather than the person who created the hook
/// (both are stored under a real user id).
async fn source_author(
    state: &AppState,
    message: &paracord_db::messages::MessageRow,
) -> Result<(String, String), ApiError> {
    let anonymous =
        paracord_db::messages::get_anonymous_messages_for_message_ids(&state.db, &[message.id])
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if let Some(anonymous) = anonymous.into_iter().next() {
        return Ok((
            format!("anon:{}:{}", anonymous.channel_id, anonymous.alias),
            anonymous.alias,
        ));
    }
    let webhooks = paracord_db::webhooks::get_webhooks_for_message_ids(&state.db, &[message.id])
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if let Some((_, webhook_id, name)) = webhooks.into_iter().next() {
        return Ok((webhook_id.to_string(), name));
    }
    Ok((
        message.author_id.to_string(),
        author_label(state, message.author_id).await?,
    ))
}

async fn author_label(state: &AppState, author_id: i64) -> Result<String, ApiError> {
    let user = paracord_db::users::get_user_by_id(&state.db, author_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let Some(user) = user else {
        return Ok("Deleted user".to_string());
    };
    let display = user
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty());
    Ok(display.unwrap_or(user.username.as_str()).to_string())
}

fn channel_label(
    channel: &paracord_db::channels::ChannelRow,
    source_is_dm: bool,
) -> Result<String, ApiError> {
    if source_is_dm {
        return Ok("Direct message".to_string());
    }
    channel
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("channel {} has no name", channel.id)))
}

/// The quoted text a resolved forward carries into its destination, if any.
pub fn forwarded_content(stored: &str) -> Option<String> {
    serde_json::from_str::<Value>(stored)
        .ok()?
        .get("content")?
        .as_str()
        .map(str::to_string)
}

/// Parse a stored forward so message JSON hands the client an object.
/// A corrupt column is reported in the payload instead of being dropped.
pub fn forwarded_from_json(raw: Option<&str>) -> Value {
    let Some(raw) = raw else {
        return Value::Null;
    };
    serde_json::from_str(raw)
        .unwrap_or_else(|_| json!({ "error": "This forward could not be read." }))
}
