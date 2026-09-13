use super::*;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Serialize)]
pub struct ActionCapability {
    pub supported: bool,
    pub allowed: bool,
    pub reason: Option<String>,
}
#[derive(Serialize)]
pub struct ChannelCapabilities {
    pub version: u8,
    pub channel_id: String,
    pub user_id: String,
    pub encrypted: bool,
    pub own_identity_enrolled: bool,
    pub peers_ready: bool,
    pub actions: BTreeMap<&'static str, ActionCapability>,
}

pub(crate) fn unsupported_action_reason(channel_type: i16, action: &str) -> Option<&'static str> {
    match action {
        "poll" if matches!(channel_type, 1 | 3) => {
            Some("Polls are not available in encrypted direct messages.")
        }
        "summary" if matches!(channel_type, 1 | 3) => {
            Some("Server summaries cannot read encrypted direct messages.")
        }
        "poll" if !matches!(channel_type, 0 | 5 | 6) => {
            Some("Polls are available in text channels and threads.")
        }
        "voice" | "video" | "screen_share" if !matches!(channel_type, 1 | 2 | 3 | 13) => {
            Some("Calls are not available in this channel.")
        }
        _ if matches!(channel_type, 4 | 7) => {
            Some("Open a text channel or forum post to use this action.")
        }
        _ if !matches!(channel_type, 0 | 1 | 2 | 3 | 5 | 6 | 13) => {
            Some("This channel type is not supported.")
        }
        _ => None,
    }
}

pub(crate) fn require_supported_action(channel_type: i16, action: &str) -> Result<(), ApiError> {
    match unsupported_action_reason(channel_type, action) {
        Some(reason) => Err(ApiError::BadRequest(reason.into())),
        None => Ok(()),
    }
}

/// Current moderation restrictions shared by action discovery and scheduling.
/// Delivery must still re-check these restrictions at the time a message sends.
pub(crate) async fn conversation_write_restriction(
    state: &AppState,
    channel: &paracord_db::channels::ChannelRow,
    user_id: i64,
    permissions: Permissions,
) -> Result<Option<&'static str>, ApiError> {
    if let Some(guild_id) = channel.guild_id() {
        if let Some(member) = paracord_db::members::get_member(&state.db, user_id, guild_id).await?
        {
            if member
                .communication_disabled_until
                .is_some_and(|until| until > Utc::now())
            {
                return Ok(Some("You are timed out and cannot send messages."));
            }
        }
    }
    if channel.channel_type == 6
        && channel.thread_state().1
        && !permissions.intersects(Permissions::MANAGE_CHANNELS | Permissions::MANAGE_MESSAGES)
    {
        return Ok(Some("This thread is locked."));
    }
    Ok(None)
}

pub async fn get_channel_capabilities(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<ChannelCapabilities>, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    ensure_channel_permissions(&state, &channel, auth.user_id, &[Permissions::VIEW_CHANNEL])
        .await?;
    let encrypted = matches!(channel.channel_type, 1 | 3);
    let mut blocked = false;
    let permissions = if let Some(guild_id) = channel.guild_id() {
        let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
            .await?
            .ok_or(ApiError::NotFound)?;
        paracord_core::permissions::compute_channel_permissions(
            &state.db,
            guild_id,
            channel.id,
            guild.owner_id,
            auth.user_id,
        )
        .await?
    } else {
        if channel.channel_type == 1 {
            for other in paracord_db::dms::get_dm_recipient_ids(&state.db, channel.id)
                .await?
                .into_iter()
                .filter(|id| *id != auth.user_id)
            {
                blocked |= paracord_db::relationships::is_blocked_either_direction(
                    &state.db,
                    auth.user_id,
                    other,
                )
                .await?;
            }
        }
        Permissions::VIEW_CHANNEL
            | Permissions::READ_MESSAGE_HISTORY
            | Permissions::SEND_MESSAGES
            | Permissions::ATTACH_FILES
            | Permissions::CONNECT
            | Permissions::SPEAK
            | Permissions::STREAM
    };
    let mut peers_ready = true;
    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    if encrypted {
        for other in paracord_db::dms::get_dm_recipient_ids(&state.db, channel.id)
            .await?
            .into_iter()
            .filter(|id| *id != auth.user_id)
        {
            let peer = paracord_db::users::get_user_by_id(&state.db, other)
                .await?
                .ok_or(ApiError::NotFound)?;
            peers_ready &= peer.public_key.is_some();
            if channel.channel_type == 1 {
                peers_ready &= paracord_db::prekeys::get_signed_prekey(&state.db, other)
                    .await?
                    .is_some()
                    && (paracord_db::prekeys::has_last_resort_prekey(&state.db, other).await?
                        || paracord_db::prekeys::count_one_time_prekeys(&state.db, other).await?
                            > 0);
            }
        }
    }
    let write_restriction =
        conversation_write_restriction(&state, &channel, auth.user_id, permissions).await?;
    let mut actions = BTreeMap::new();
    for (action, required) in [
        ("send", Permissions::SEND_MESSAGES),
        ("poll", Permissions::SEND_MESSAGES),
        ("schedule", Permissions::SEND_MESSAGES),
        (
            "attach",
            Permissions::SEND_MESSAGES | Permissions::ATTACH_FILES,
        ),
        ("summary", Permissions::READ_MESSAGE_HISTORY),
        ("voice", Permissions::CONNECT),
        ("video", Permissions::CONNECT | Permissions::STREAM),
        ("screen_share", Permissions::CONNECT | Permissions::STREAM),
    ] {
        let unsupported = unsupported_action_reason(channel.channel_type, action)
            .or_else(|| {
                (action == "summary" && !crate::ai::summaries_configured(&state))
                    .then_some("Summaries are not configured on this server.")
            })
            .or_else(|| {
                (matches!(action, "voice" | "video" | "screen_share")
                    && !state.config.native_media_enabled
                    && !state.config.livekit_available)
                    .then_some("Calls are not configured on this server.")
            });
        let reason = unsupported
            .or_else(|| {
                (!permissions.contains(required))
                    .then_some("You do not have permission to use this action in this channel.")
            })
            .or_else(|| {
                (blocked && action != "summary")
                    .then_some("Messaging and calls are unavailable between these accounts.")
            })
            .or_else(|| {
                if matches!(action, "send" | "poll" | "schedule" | "attach") {
                    write_restriction
                } else {
                    None
                }
            });
        actions.insert(
            action,
            ActionCapability {
                supported: unsupported.is_none(),
                allowed: reason.is_none(),
                reason: reason.map(str::to_string),
            },
        );
    }
    Ok(Json(ChannelCapabilities {
        version: 1,
        channel_id: channel_id.to_string(),
        user_id: auth.user_id.to_string(),
        encrypted,
        own_identity_enrolled: user.public_key.is_some(),
        peers_ready,
        actions,
    }))
}
