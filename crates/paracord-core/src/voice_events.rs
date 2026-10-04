//! Who hears about a call.
//!
//! A server voice or stage channel's call events (`VOICE_STATE_UPDATE`,
//! `VOICE_WATCHERS_UPDATE`) go to the channel's guild; each transport then
//! keeps them from sessions that may not view that channel. A direct message
//! or group DM call has no guild. Its events go to the DM's recipients and to
//! nobody else.
//!
//! An event published with no guild and no recipients reaches every connected
//! session (`EventBus::publish`'s global scope), so a DM call's event must never
//! be dispatched as `dispatch(.., None)`. Every place that announces a call goes
//! through [`dispatch_call_event`] instead.

use serde_json::Value;

use crate::AppState;

/// The guild a call belongs to, from a stored voice state or a relay room key.
/// The relay keys a DM call's room under guild `0`, and some older rows store
/// `0` rather than NULL; both mean "no guild".
pub fn call_guild(guild_id: Option<i64>) -> Option<i64> {
    guild_id.filter(|id| *id != 0)
}

/// Publish `event_type` for the call in `channel_id` to the people who may see
/// that call: the guild (filtered per channel by the transports) for a server
/// channel, the DM's recipients for a DM call (`guild_id` `None` or `0`).
///
/// A DM call whose recipients cannot be read is not announced at all: the error
/// is returned, never widened into a global dispatch.
pub async fn dispatch_call_event(
    state: &AppState,
    event_type: &str,
    payload: Value,
    guild_id: Option<i64>,
    channel_id: i64,
) -> Result<(), paracord_db::DbError> {
    if let Some(guild_id) = call_guild(guild_id) {
        state
            .event_bus
            .dispatch(event_type, payload, Some(guild_id));
        return Ok(());
    }
    let recipients = paracord_db::dms::get_dm_recipient_ids(&state.db, channel_id).await?;
    if recipients.is_empty() {
        tracing::warn!(
            channel_id,
            event_type,
            "voice: a guildless call has no DM recipients; nothing announced"
        );
        return Ok(());
    }
    state
        .event_bus
        .dispatch_to_users(event_type, payload, recipients);
    Ok(())
}

/// [`dispatch_call_event`] for callers with nowhere to return the error (a
/// background task, a gateway opcode): the failure is logged, and the event is
/// not sent to anybody.
pub async fn dispatch_call_event_logged(
    state: &AppState,
    event_type: &str,
    payload: Value,
    guild_id: Option<i64>,
    channel_id: i64,
) {
    if let Err(error) = dispatch_call_event(state, event_type, payload, guild_id, channel_id).await
    {
        tracing::warn!(
            channel_id,
            event_type,
            %error,
            "voice: could not read a DM call's recipients; the event was not sent"
        );
    }
}

/// Whether `channel` is a DM or group DM, whose call has no guild.
pub fn is_dm_call_channel(channel: &paracord_db::channels::ChannelRow) -> bool {
    matches!(channel.channel_type, 1 | 3) && channel.guild_id().is_none()
}

/// One DM call voice state as READY's `dm_voice_states` lists it (the
/// `VoiceStateSnapshot` shape, `guild_id` null).
pub fn ready_dm_voice_state(vs: &paracord_db::voice_states::VoiceStateWithUser) -> Value {
    serde_json::json!({
        "user_id": vs.user_id.to_string(),
        "channel_id": vs.channel_id.to_string(),
        "guild_id": Value::Null,
        "session_id": &vs.session_id,
        "self_mute": vs.self_mute,
        "self_deaf": vs.self_deaf,
        "self_stream": vs.self_stream,
        "self_video": vs.self_video,
        "suppress": vs.suppress,
        "mute": false,
        "deaf": false,
        "mode": vs.mode.as_str(),
        "self_stream_started_at": vs.self_stream_started_at.map(|value| value.to_rfc3339()),
        "joined_at": vs.joined_at.to_rfc3339(),
        "username": &vs.username,
        "avatar_hash": &vs.avatar_hash,
    })
}

/// A `VOICE_STATE_UPDATE` for a member who is in `row.channel_id`, built from
/// the stored row so every field (mode, stream start time, flags) is the one
/// the database holds (`VoiceStateSnapshot` in `paracord-contracts`).
pub fn call_voice_state_payload(
    row: &paracord_db::voice_states::VoiceStateRow,
    user: Option<&paracord_db::users::UserRow>,
) -> Value {
    serde_json::json!({
        "user_id": row.user_id.to_string(),
        "channel_id": row.channel_id.to_string(),
        "guild_id": row.guild_id().map(|id| id.to_string()),
        "session_id": &row.session_id,
        "self_mute": row.self_mute,
        "self_deaf": row.self_deaf,
        "self_stream": row.self_stream,
        "self_video": row.self_video,
        "suppress": row.suppress,
        "request_to_speak_at": row.request_to_speak_at.map(|value| value.to_rfc3339()),
        "mute": false,
        "deaf": false,
        "mode": row.mode.as_str(),
        "self_stream_started_at": row.self_stream_started_at.map(|value| value.to_rfc3339()),
        "joined_at": row.joined_at.to_rfc3339(),
        "username": user.map(|u| u.username.as_str()),
        "display_name": user.and_then(|u| u.display_name.as_deref()),
        "avatar_hash": user.and_then(|u| u.avatar_hash.as_deref()),
    })
}

/// Why [`update_dm_call_flags`] did nothing.
#[derive(Debug)]
pub enum DmCallFlagsError {
    /// The caller is not one of the DM's recipients.
    NotRecipient,
    /// The caller is not in this DM's call. A DM call is joined only through
    /// `POST /api/v1/dms/{channel_id}/voice/join`; a status update never
    /// creates the membership.
    NotInCall,
    /// The receipt names another call, or the call ended meanwhile.
    SessionChanged,
    Db(paracord_db::DbError),
}

impl std::fmt::Display for DmCallFlagsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotRecipient => f.write_str("not a recipient of this DM"),
            Self::NotInCall => f.write_str("not in this DM's call"),
            Self::SessionChanged => f.write_str("voice session changed"),
            Self::Db(error) => write!(f, "{error}"),
        }
    }
}

impl From<paracord_db::DbError> for DmCallFlagsError {
    fn from(error: paracord_db::DbError) -> Self {
        Self::Db(error)
    }
}

/// Record a DM call member's own mute, deafen and camera flags and announce
/// them to the DM's recipients, for both realtime transports (the gateway's
/// voice state opcode and the SSE `voice_state_update` command).
///
/// The caller must be a recipient of `channel` (a DM or group DM) and already
/// in its call. With `expected_session` (the join's receipt) the update applies
/// only to that call. The stream flag is kept as stored: a mute while sharing
/// must not announce that the share stopped. Returns the stored row.
pub async fn update_dm_call_flags(
    state: &AppState,
    user_id: i64,
    channel: &paracord_db::channels::ChannelRow,
    expected_session: Option<&str>,
    self_mute: bool,
    self_deaf: bool,
    self_video: bool,
) -> Result<paracord_db::voice_states::VoiceStateRow, DmCallFlagsError> {
    debug_assert!(is_dm_call_channel(channel));
    if !paracord_db::dms::is_dm_recipient(&state.db, channel.id, user_id).await? {
        return Err(DmCallFlagsError::NotRecipient);
    }
    let existing = paracord_db::voice_states::get_user_voice_state(&state.db, user_id, None)
        .await?
        .filter(|row| row.channel_id == channel.id)
        .ok_or(DmCallFlagsError::NotInCall)?;
    if expected_session.is_some_and(|expected| expected != existing.session_id) {
        return Err(DmCallFlagsError::SessionChanged);
    }
    // The LiveKit path keeps its own copy of the flags; the native path keeps
    // them in the stored voice state alone.
    state
        .voice
        .update_self_mute(channel.id, user_id, self_mute)
        .await;
    state
        .voice
        .update_self_deaf(channel.id, user_id, self_deaf)
        .await;
    state
        .voice
        .update_self_video(channel.id, user_id, self_video)
        .await;
    let self_stream = state
        .voice
        .get_participant_stream_state(channel.id, user_id)
        .await
        || existing.self_stream;
    let stored = paracord_db::voice_states::update_voice_state(
        &state.db,
        user_id,
        None,
        self_mute,
        self_deaf,
        self_stream,
        self_video,
    )
    .await?
    .filter(|row| row.channel_id == channel.id && row.session_id == existing.session_id)
    .ok_or(DmCallFlagsError::SessionChanged)?;
    let user = paracord_db::users::get_user_by_id(&state.db, user_id).await?;
    dispatch_call_event(
        state,
        "VOICE_STATE_UPDATE",
        call_voice_state_payload(&stored, user.as_ref()),
        None,
        channel.id,
    )
    .await?;
    Ok(stored)
}
