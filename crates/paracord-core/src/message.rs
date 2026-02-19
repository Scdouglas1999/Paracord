use crate::error::CoreError;
use crate::permissions;
use crate::MESSAGE_FLAG_DM_E2EE;
use paracord_db::DbPool;
use paracord_models::permissions::Permissions;

const MAX_DM_E2EE_NONCE_LEN: usize = 128;
const MAX_DM_E2EE_CIPHERTEXT_LEN: usize = 16_384;
const MAX_DM_E2EE_HEADER_LEN: usize = 2_048;

#[derive(Debug, Clone)]
pub struct DmE2eePayload {
    pub version: u8,
    pub nonce: String,
    pub ciphertext: String,
    /// Signal protocol header (JSON), present for v2 messages.
    pub header: Option<String>,
}

impl DmE2eePayload {
    fn validate(&self) -> Result<(), CoreError> {
        match self.version {
            1 => {
                // v1: no header allowed
                if self.header.is_some() {
                    return Err(CoreError::BadRequest(
                        "v1 DM E2EE payloads must not include a header".into(),
                    ));
                }
            }
            2 => {
                // v2: header is required and must be valid JSON
                let header = self.header.as_deref().ok_or_else(|| {
                    CoreError::BadRequest("v2 DM E2EE payloads require a header".into())
                })?;
                if header.is_empty() || header.len() > MAX_DM_E2EE_HEADER_LEN {
                    return Err(CoreError::BadRequest("Invalid DM E2EE header length".into()));
                }
                if serde_json::from_str::<serde_json::Value>(header).is_err() {
                    return Err(CoreError::BadRequest("DM E2EE header must be valid JSON".into()));
                }
            }
            _ => {
                return Err(CoreError::BadRequest(
                    "Unsupported DM E2EE payload version".into(),
                ));
            }
        }
        if self.nonce.is_empty() || self.nonce.len() > MAX_DM_E2EE_NONCE_LEN {
            return Err(CoreError::BadRequest("Invalid DM E2EE nonce".into()));
        }
        if self.ciphertext.is_empty() || self.ciphertext.len() > MAX_DM_E2EE_CIPHERTEXT_LEN {
            return Err(CoreError::BadRequest("Invalid DM E2EE ciphertext".into()));
        }
        let valid_base64_char = |c: char| {
            c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=' || c == '-' || c == '_'
        };
        if !self.nonce.chars().all(valid_base64_char) {
            return Err(CoreError::BadRequest("Invalid DM E2EE nonce".into()));
        }
        if !self.ciphertext.chars().all(valid_base64_char) {
            return Err(CoreError::BadRequest("Invalid DM E2EE ciphertext".into()));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct CreateMessageOptions {
    pub message_type: i16,
    pub reference_id: Option<i64>,
    pub allow_empty_content: bool,
    pub dm_e2ee: Option<DmE2eePayload>,
    pub nonce: Option<String>,
}

impl Default for CreateMessageOptions {
    fn default() -> Self {
        Self {
            message_type: 0,
            reference_id: None,
            allow_empty_content: false,
            dm_e2ee: None,
            nonce: None,
        }
    }
}

/// Create a message, requires SEND_MESSAGES and VIEW_CHANNEL.
pub async fn create_message(
    pool: &DbPool,
    msg_id: i64,
    channel_id: i64,
    author_id: i64,
    content: &str,
    reference_id: Option<i64>,
) -> Result<paracord_db::messages::MessageRow, CoreError> {
    create_message_with_options(
        pool,
        msg_id,
        channel_id,
        author_id,
        content,
        CreateMessageOptions {
            message_type: 0,
            reference_id,
            allow_empty_content: false,
            dm_e2ee: None,
            nonce: None,
        },
    )
    .await
}

/// Create a message with an explicit message type, requires SEND_MESSAGES and VIEW_CHANNEL.
pub async fn create_message_with_type(
    pool: &DbPool,
    msg_id: i64,
    channel_id: i64,
    author_id: i64,
    content: &str,
    message_type: i16,
    reference_id: Option<i64>,
) -> Result<paracord_db::messages::MessageRow, CoreError> {
    create_message_with_options(
        pool,
        msg_id,
        channel_id,
        author_id,
        content,
        CreateMessageOptions {
            message_type,
            reference_id,
            allow_empty_content: false,
            dm_e2ee: None,
            nonce: None,
        },
    )
    .await
}

/// Create a message with explicit options (message type, attachment-only allowance, DM E2EE payload).
pub async fn create_message_with_options(
    pool: &DbPool,
    msg_id: i64,
    channel_id: i64,
    author_id: i64,
    content: &str,
    options: CreateMessageOptions,
) -> Result<paracord_db::messages::MessageRow, CoreError> {
    let mut stored_content = content.to_string();
    let mut flags = 0_i32;
    let mut nonce = options
        .nonce
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(candidate) = nonce.as_ref() {
        if candidate.len() > 64 {
            return Err(CoreError::BadRequest("Invalid message nonce".into()));
        }
    }

    let channel = paracord_db::channels::get_channel(pool, channel_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    // Check permissions if guild channel
    if let Some(guild_id) = channel.guild_id() {
        if options.dm_e2ee.is_some() {
            return Err(CoreError::BadRequest(
                "DM E2EE payloads are only valid for direct messages".into(),
            ));
        }
        if !content.trim().is_empty() {
            paracord_util::validation::validate_message_content(content).map_err(|_| {
                CoreError::BadRequest("Content must be between 1 and 2000 characters".into())
            })?;
        } else if !options.allow_empty_content {
            return Err(CoreError::BadRequest(
                "Content must be between 1 and 2000 characters".into(),
            ));
        }

        permissions::ensure_guild_member(pool, guild_id, author_id).await?;
        if let Some(member) = paracord_db::members::get_member(pool, author_id, guild_id).await? {
            if let Some(until) = member.communication_disabled_until {
                if until > chrono::Utc::now() {
                    return Err(CoreError::BadRequest(
                        "You are timed out and cannot send messages".into(),
                    ));
                }
            }
        }
        let guild = paracord_db::guilds::get_guild(pool, guild_id)
            .await?
            .ok_or(CoreError::NotFound)?;

        let perms = permissions::compute_channel_permissions(
            pool,
            guild_id,
            channel_id,
            guild.owner_id,
            author_id,
        )
        .await?;
        permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;
        permissions::require_permission(perms, Permissions::SEND_MESSAGES)?;
    } else {
        if !paracord_db::dms::is_dm_recipient(pool, channel_id, author_id).await? {
            return Err(CoreError::Forbidden);
        }
        let recipients = paracord_db::dms::get_dm_recipient_ids(pool, channel_id).await?;
        for recipient_id in recipients {
            if recipient_id == author_id {
                continue;
            }
            if paracord_db::relationships::is_blocked_either_direction(
                pool,
                author_id,
                recipient_id,
            )
            .await?
            {
                return Err(CoreError::Forbidden);
            }
        }

        if let Some(dm_e2ee) = options.dm_e2ee.as_ref() {
            dm_e2ee.validate()?;
            if !content.trim().is_empty() {
                return Err(CoreError::BadRequest(
                    "Plaintext content is not allowed for encrypted DMs".into(),
                ));
            }
            stored_content = dm_e2ee.ciphertext.clone();
            nonce = Some(dm_e2ee.nonce.clone());
            flags |= MESSAGE_FLAG_DM_E2EE;
        } else if !content.trim().is_empty() {
            return Err(CoreError::BadRequest(
                "Plaintext DM messages are disabled; update your client for encrypted DMs".into(),
            ));
        } else if !options.allow_empty_content {
            return Err(CoreError::BadRequest(
                "Message content must be between 1 and 2000 characters".into(),
            ));
        }
    }

    let e2ee_header = options
        .dm_e2ee
        .as_ref()
        .and_then(|p| p.header.clone());

    let msg = paracord_db::messages::create_message_with_meta(
        pool,
        msg_id,
        channel_id,
        author_id,
        &stored_content,
        options.message_type,
        options.reference_id,
        flags,
        nonce.as_deref(),
        e2ee_header.as_deref(),
    )
    .await?;

    Ok(msg)
}

/// Edit a message. Only the author can edit, unless user has MANAGE_MESSAGES.
pub async fn edit_message(
    pool: &DbPool,
    channel_id: i64,
    message_id: i64,
    user_id: i64,
    content: &str,
) -> Result<paracord_db::messages::MessageRow, CoreError> {
    edit_message_with_options(pool, channel_id, message_id, user_id, content, None).await
}

/// Edit a message with optional DM E2EE payload.
pub async fn edit_message_with_options(
    pool: &DbPool,
    channel_id: i64,
    message_id: i64,
    user_id: i64,
    content: &str,
    dm_e2ee: Option<DmE2eePayload>,
) -> Result<paracord_db::messages::MessageRow, CoreError> {
    let mut stored_content = content.to_string();
    let mut nonce: Option<String> = None;
    let mut flags: Option<i32> = None;

    let msg = paracord_db::messages::get_message(pool, message_id)
        .await?
        .ok_or(CoreError::NotFound)?;
    if msg.channel_id != channel_id {
        return Err(CoreError::NotFound);
    }
    let channel = paracord_db::channels::get_channel(pool, channel_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    if channel.guild_id().is_some() {
        if dm_e2ee.is_some() {
            return Err(CoreError::BadRequest(
                "DM E2EE payloads are only valid for direct messages".into(),
            ));
        }
        paracord_util::validation::validate_message_content(content).map_err(|_| {
            CoreError::BadRequest("Content must be between 1 and 2000 characters".into())
        })?;
    } else {
        if !paracord_db::dms::is_dm_recipient(pool, channel_id, user_id).await? {
            return Err(CoreError::Forbidden);
        }
        if let Some(payload) = dm_e2ee.as_ref() {
            payload.validate()?;
            if !content.trim().is_empty() {
                return Err(CoreError::BadRequest(
                    "Plaintext content is not allowed for encrypted DMs".into(),
                ));
            }
            stored_content = payload.ciphertext.clone();
            nonce = Some(payload.nonce.clone());
            flags = Some(MESSAGE_FLAG_DM_E2EE);
        } else if !content.trim().is_empty() {
            return Err(CoreError::BadRequest(
                "Plaintext DM messages are disabled; update your client for encrypted DMs".into(),
            ));
        } else {
            return Err(CoreError::BadRequest(
                "Content must be between 1 and 2000 characters".into(),
            ));
        }
    }

    let updated = paracord_db::messages::update_message_authorized_with_meta(
        pool,
        message_id,
        channel_id,
        user_id,
        &stored_content,
        nonce.as_deref(),
        flags,
    )
    .await?;
    if let Some(updated) = updated {
        return Ok(updated);
    }

    if msg.author_id == user_id {
        return Err(CoreError::Internal(
            "message update failed unexpectedly".to_string(),
        ));
    }

    if channel.guild_id().is_none() {
        return Err(CoreError::Forbidden);
    }
    Err(CoreError::MissingPermission)
}

/// Delete a message. Author can delete own, or MANAGE_MESSAGES can delete any.
pub async fn delete_message(
    pool: &DbPool,
    message_id: i64,
    channel_id: i64,
    user_id: i64,
) -> Result<(), CoreError> {
    let msg = paracord_db::messages::get_message(pool, message_id)
        .await?
        .ok_or(CoreError::NotFound)?;

    if msg.channel_id != channel_id {
        return Err(CoreError::NotFound);
    }

    let deleted =
        paracord_db::messages::delete_message_authorized(pool, message_id, channel_id, user_id)
            .await?;
    if deleted {
        return Ok(());
    }

    if msg.author_id == user_id {
        return Err(CoreError::Internal(
            "message delete failed unexpectedly".to_string(),
        ));
    }

    let channel = paracord_db::channels::get_channel(pool, channel_id)
        .await?
        .ok_or(CoreError::NotFound)?;
    if channel.guild_id().is_none() {
        return Err(CoreError::Forbidden);
    }
    Err(CoreError::MissingPermission)
}
