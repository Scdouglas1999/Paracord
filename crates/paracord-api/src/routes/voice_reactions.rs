//! Reactions on the stream (docs/glass-spec.md §6.5).
//!
//! Flame and heart float up over a stream for everyone watching it. They are
//! ephemeral: nothing is stored. `POST /api/v2/voice/{channel_id}/stream-reactions`
//! takes one reaction from someone in that voice channel's call (joined or
//! listening) or watching it through a view session, and the server sends it
//! on as a `STREAM_REACTIONS` gateway event to the same people: the channel's
//! voice members and its watch viewers. Never guild-wide: a member of the
//! server who is neither in the call nor watching never receives it.
//!
//! Modeled on `SOUNDBOARD_PLAY` (`soundboard.rs`): the durable voice state is
//! the receipt for "in the call", the relay's view record is the receipt for
//! "watching", and recipients are read at send time and targeted with
//! `dispatch_to_users`.
//!
//! Limits: one request a second per person (429 with `Retry-After`). A client
//! merges the taps it could not send into its next request (`count`, at most
//! [`wire::MAX_STREAM_REACTION_COUNT`]). The server coalesces a channel's
//! reactions for [`COALESCE`] and sends them as one event, so a busy channel
//! costs its watchers at most four events a second however many people react.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use paracord_contracts::voice as wire;
use paracord_core::AppState;
use paracord_models::gateway::EVENT_STREAM_REACTIONS;
use paracord_models::permissions::Permissions;
use paracord_relay::participant::ViewKind;

use crate::error::ApiError;
use crate::middleware::AuthUser;

/// One request a second per person.
const PER_USER_INTERVAL: Duration = Duration::from_secs(1);
/// How long a channel's reactions are gathered before they go out as one event.
const COALESCE: Duration = Duration::from_millis(250);
/// Sweep the rate-limit table once it holds this many people.
const SWEEP_AT: usize = 4096;

fn last_sent() -> &'static DashMap<i64, Instant> {
    static LAST: OnceLock<DashMap<i64, Instant>> = OnceLock::new();
    LAST.get_or_init(DashMap::new)
}

struct PendingBatch {
    guild_id: i64,
    reactions: Vec<wire::StreamReaction>,
}

/// channel_id -> the reactions waiting for that channel's next event.
fn pending() -> &'static DashMap<i64, PendingBatch> {
    static PENDING: OnceLock<DashMap<i64, PendingBatch>> = OnceLock::new();
    PENDING.get_or_init(DashMap::new)
}

/// Accept one request from `user_id` now, or say how long to wait. The check
/// and the record are one step, so two requests racing in the same instant
/// cannot both pass.
fn take_rate_slot(user_id: i64, now: Instant) -> Result<(), ApiError> {
    let table = last_sent();
    match table.entry(user_id) {
        Entry::Occupied(mut entry) => {
            let elapsed = now.saturating_duration_since(*entry.get());
            if elapsed < PER_USER_INTERVAL {
                let wait = PER_USER_INTERVAL - elapsed;
                // Whole seconds, rounded up: `Retry-After` has no fractions.
                let secs = wait.as_secs() + u64::from(wait.subsec_nanos() > 0);
                return Err(ApiError::RateLimited(secs.max(1) as i64));
            }
            entry.insert(now);
        }
        Entry::Vacant(entry) => {
            entry.insert(now);
        }
    }
    if table.len() > SWEEP_AT {
        table.retain(|_, at| now.saturating_duration_since(*at) < PER_USER_INTERVAL);
    }
    Ok(())
}

fn validate_nonce(nonce: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(nonce) = nonce else {
        return Ok(None);
    };
    let valid = !nonce.is_empty()
        && nonce.len() <= wire::MAX_STREAM_REACTION_NONCE_LEN
        && nonce
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if !valid {
        return Err(ApiError::BadRequest(
            "nonce must be 1 to 64 letters, digits, '-' or '_'".into(),
        ));
    }
    Ok(Some(nonce))
}

/// Whether `user_id` holds a watch view session in this channel. An ambient
/// view (the room light) is not watching: it is never shown to anybody.
fn watching_through_view(state: &AppState, user_id: i64, guild_id: i64, channel_id: i64) -> bool {
    state
        .native_media
        .as_ref()
        .and_then(|native| native.rooms.view_for_user(user_id))
        .is_some_and(|view| {
            view.guild_id == guild_id
                && view.channel_id == channel_id
                && matches!(view.target.kind, ViewKind::Watch)
        })
}

/// `POST /api/v2/voice/{channel_id}/stream-reactions`
///
/// Needs VIEW_CHANNEL, and a place in that voice channel: a voice state there
/// (joined or listening in), or a watch view session there. The streamer must
/// be sharing in the channel now. 204 on success; the reaction reaches
/// everyone (the sender included, with its nonce) in the next
/// `STREAM_REACTIONS` for the channel.
pub async fn send_stream_reaction(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(body): Json<wire::SendStreamReactionRequest>,
) -> Result<StatusCode, ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    if channel.channel_type != 2 && channel.channel_type != 13 {
        return Err(ApiError::BadRequest("Not a voice channel".into()));
    }
    let guild_id = channel.guild_id().ok_or(ApiError::BadRequest(
        "Reactions on a stream are only for server voice channels".into(),
    ))?;
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let perms = paracord_core::permissions::compute_channel_permissions(
        &state.db,
        guild_id,
        channel_id,
        guild.owner_id,
        auth.user_id,
    )
    .await?;
    paracord_core::permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;

    if body.count == 0 || body.count > wire::MAX_STREAM_REACTION_COUNT {
        return Err(ApiError::BadRequest(format!(
            "count must be between 1 and {}",
            wire::MAX_STREAM_REACTION_COUNT
        )));
    }
    let nonce = validate_nonce(body.nonce)?;
    let streamer_id: i64 = body
        .stream_user_id
        .trim()
        .parse()
        .map_err(|_| ApiError::BadRequest("Invalid stream_user_id".into()))?;

    let members =
        paracord_db::voice_states::get_channel_voice_states(&state.db, channel_id).await?;
    let in_call = members.iter().any(|row| row.user_id == auth.user_id);
    if !in_call && !watching_through_view(&state, auth.user_id, guild_id, channel_id) {
        return Err(ApiError::Forbidden);
    }
    if !members
        .iter()
        .any(|row| row.user_id == streamer_id && row.self_stream)
    {
        return Err(ApiError::Conflict(
            "That person is not streaming in this channel".into(),
        ));
    }

    take_rate_slot(auth.user_id, Instant::now())?;

    let sender = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    enqueue(
        &state,
        guild_id,
        channel_id,
        wire::StreamReaction {
            user_id: auth.user_id.to_string(),
            stream_user_id: streamer_id.to_string(),
            kind: body.kind,
            count: body.count,
            nonce,
            username: sender.username,
            display_name: sender.display_name,
            avatar_hash: sender.avatar_hash,
        },
    );
    Ok(StatusCode::NO_CONTENT)
}

/// Add a reaction to its channel's next event, and schedule that event when
/// this is the first reaction waiting.
fn enqueue(state: &AppState, guild_id: i64, channel_id: i64, reaction: wire::StreamReaction) {
    let first = match pending().entry(channel_id) {
        Entry::Occupied(mut entry) => {
            entry.get_mut().reactions.push(reaction);
            false
        }
        Entry::Vacant(entry) => {
            entry.insert(PendingBatch {
                guild_id,
                reactions: vec![reaction],
            });
            true
        }
    };
    if first {
        let state = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(COALESCE).await;
            flush(&state, channel_id).await;
        });
    }
}

/// Send a channel's waiting reactions to the people there now: its voice
/// members (joined or listening) and its watch viewers.
async fn flush(state: &AppState, channel_id: i64) {
    let Some((_, batch)) = pending().remove(&channel_id) else {
        return;
    };
    let members = match paracord_db::voice_states::get_channel_voice_states(&state.db, channel_id)
        .await
    {
        Ok(members) => members,
        Err(error) => {
            tracing::warn!(
                channel_id,
                reactions = batch.reactions.len(),
                %error,
                "stream reactions: could not read the channel's members; these reactions were not sent"
            );
            return;
        }
    };
    let mut recipients: Vec<i64> = members.iter().map(|row| row.user_id).collect();
    recipients.extend(stream_viewers(state, batch.guild_id, channel_id));
    recipients.sort_unstable();
    recipients.dedup();
    if recipients.is_empty() {
        return;
    }
    let payload = wire::StreamReactions {
        guild_id: batch.guild_id.to_string(),
        channel_id: channel_id.to_string(),
        reactions: batch.reactions,
    };
    let payload = match serde_json::to_value(&payload) {
        Ok(payload) => payload,
        Err(error) => {
            tracing::error!(channel_id, %error, "stream reactions: could not encode the event");
            return;
        }
    };
    state
        .event_bus
        .dispatch_to_users(EVENT_STREAM_REACTIONS, payload, recipients);
}

/// Everyone watching a stream in this channel through a view session.
fn stream_viewers(state: &AppState, guild_id: i64, channel_id: i64) -> Vec<i64> {
    let Some(native) = state.native_media.as_ref() else {
        return Vec::new();
    };
    native
        .rooms
        .views_snapshot()
        .into_iter()
        .filter(|(_, view)| {
            view.guild_id == guild_id
                && view.channel_id == channel_id
                && matches!(view.target.kind, ViewKind::Watch)
        })
        .map(|(user_id, _)| user_id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_request_a_second_per_person() {
        let user = 9_000_000_000_001;
        let start = Instant::now();
        assert!(take_rate_slot(user, start).is_ok());
        match take_rate_slot(user, start + Duration::from_millis(400)) {
            Err(ApiError::RateLimited(secs)) => assert_eq!(secs, 1),
            other => panic!("expected a rate limit, got {other:?}"),
        }
        // The refused request did not move the window.
        assert!(take_rate_slot(user, start + PER_USER_INTERVAL).is_ok());
        // Someone else is not limited by this person.
        assert!(take_rate_slot(user + 1, start + Duration::from_millis(1)).is_ok());
    }

    #[test]
    fn nonces_are_short_and_plain() {
        assert_eq!(
            validate_nonce(Some("a-1_B".into())).unwrap(),
            Some("a-1_B".into())
        );
        assert!(validate_nonce(None).unwrap().is_none());
        assert!(validate_nonce(Some(String::new())).is_err());
        assert!(validate_nonce(Some("x".repeat(65))).is_err());
        assert!(validate_nonce(Some("<b>".into())).is_err());
    }
}
