//! Releasing a voice state the media server no longer backs.
//!
//! A voice state is a claim — "this account is in this room right now" — and
//! every client in the space draws the room's light from it: the here-now
//! count, the occupant tiles, the lobby's "2 in", whether the room is lit at
//! all. An explicit leave retires the claim, and so does the LiveKit
//! `participant_left` webhook on a LiveKit deployment.
//!
//! The native transport had neither. A client that simply *vanished* — tab
//! closed, laptop shut, network gone — never sends a leave, and the relay's own
//! teardown is a media-plane event that never reached the voice state. The
//! gateway's disconnect sweep looked like the missing piece but never ran: it
//! filtered the account's voice states down to ones whose `session_id` equalled
//! the *gateway* session id, and a native call's session id is the media
//! receipt the REST join mints, which never matches. The result was a room that
//! stayed lit with a ghost in it until the server was restarted.
//!
//! This module is that missing piece, in one place, for every transport: ask
//! the relay whether the account still holds the media connection its voice
//! state claims, and if it has genuinely let go, retire the claim and tell the
//! space.

use dashmap::DashSet;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;

use crate::AppState;

/// How long to wait for the relay to retire a vanished client's media
/// connection before concluding the call is over.
///
/// A browser that closes its tab ends its WebTransport session at once and the
/// relay lets go within a few hundred milliseconds. A client that is simply
/// gone — power cut, cable pulled — leaves its QUIC connection to expire on the
/// transport's ~30 s idle timeout instead, so this budget has to outlast that
/// with room to spare. An account still publishing when it runs out is somebody
/// genuinely on a call whose signaling connection blipped, and their claim
/// stands.
const RELAY_RETIRE_TIMEOUT: Duration = Duration::from_secs(75);
/// How often that wait re-reads the relay. Short enough that the ordinary case
/// — a closed tab, already retired — settles on the first look.
const RELAY_RETIRE_POLL: Duration = Duration::from_secs(1);

/// Whether the relay still holds a media connection for `user_id` under
/// `session_id`.
///
/// Matching on the session id is what makes this safe to act on: a *new* call
/// started while we were waiting owns a different receipt, and mistaking it for
/// the old one would leave the stale claim standing forever.
#[cfg(feature = "native-media")]
fn relay_holds_session(state: &AppState, user_id: i64, session_id: &str) -> bool {
    state
        .native_media
        .as_ref()
        .and_then(|native| native.relay_forwarder.connection_media_stats(user_id))
        .is_some_and(|stats| stats.session_id == session_id)
}

#[cfg(not(feature = "native-media"))]
fn relay_holds_session(_state: &AppState, _user_id: i64, _session_id: &str) -> bool {
    false
}

/// Retire `user_id`'s voice state if the native media relay has let their
/// call go.
///
/// Call this whenever a client's signaling connection drops. It is safe to
/// call for an account that is not in a call, that reconnected, or that is
/// happily mid-call: the relay decides, and every write is fenced on the media
/// receipt the claim was made under.
///
/// Returns `true` when a claim was actually retired. A no-op on a LiveKit
/// deployment, where the `participant_left` webhook owns this.
pub async fn release_orphaned_native_voice_state(state: &AppState, user_id: i64) -> bool {
    if state.native_media.is_none() {
        return false;
    }
    // A signaling connection that reconnects does so repeatedly, and each drop
    // asks this question about the same account. One watcher per account is
    // enough: a second would only wait on the same relay entry.
    if !in_flight().insert(user_id) {
        return false;
    }
    let released = release_orphaned_native_voice_state_inner(state, user_id).await;
    in_flight().remove(&user_id);
    released
}

/// Accounts with a release attempt already watching the relay.
fn in_flight() -> &'static DashSet<i64> {
    static IN_FLIGHT: OnceLock<DashSet<i64>> = OnceLock::new();
    IN_FLIGHT.get_or_init(DashSet::new)
}

async fn release_orphaned_native_voice_state_inner(state: &AppState, user_id: i64) -> bool {
    let Ok(states) = paracord_db::voice_states::get_all_user_voice_states(&state.db, user_id).await
    else {
        return false;
    };
    let Some(claim) = states.into_iter().next() else {
        return false;
    };

    // Give the relay the chance to notice for itself. Nothing is written while
    // this waits, so a client that comes back mid-call simply keeps its claim.
    let deadline = tokio::time::Instant::now() + RELAY_RETIRE_TIMEOUT;
    while relay_holds_session(state, user_id, &claim.session_id) {
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(RELAY_RETIRE_POLL).await;
    }

    let _membership = state.voice.lock_membership(user_id).await;

    // Re-read under the membership lock: the claim we waited on may have been
    // retired by an explicit leave, or replaced by a fresh call, while we were
    // watching the relay.
    let still_the_same_claim =
        paracord_db::voice_states::get_all_user_voice_states(&state.db, user_id)
            .await
            .map(|current| {
                current.iter().any(|row| {
                    row.session_id == claim.session_id
                        && row.channel_id == claim.channel_id
                        && row.guild_id() == claim.guild_id()
                })
            })
            .unwrap_or(false);
    if !still_the_same_claim {
        return false;
    }

    let removed = paracord_db::voice_states::remove_voice_state_if_session(
        &state.db,
        user_id,
        claim.guild_id(),
        &claim.session_id,
    )
    .await
    .unwrap_or(false);
    if !removed {
        return false;
    }

    if let Some(remaining) = state
        .voice
        .leave_room_if_session(claim.channel_id, user_id, Some(&claim.session_id))
        .await
    {
        if remaining.is_empty() {
            let _ = state.voice.cleanup_room(claim.channel_id).await;
        }
    }
    #[cfg(feature = "native-media")]
    if let Some(native) = state.native_media.as_ref() {
        native.rooms.leave_room_if_session(
            claim.guild_id().unwrap_or(0),
            claim.channel_id,
            user_id,
            Some(&claim.session_id),
        );
    }

    let user = paracord_db::users::get_user_by_id(&state.db, user_id)
        .await
        .ok()
        .flatten();
    // A leave carries a null `channel_id`, so `prior_channel_id` is what keeps
    // the gateway's per-channel VIEW_CHANNEL filter able to scope it — the same
    // shape `leave_voice` dispatches.
    state.event_bus.dispatch(
        "VOICE_STATE_UPDATE",
        json!({
            "user_id": user_id.to_string(),
            "channel_id": Value::Null,
            "prior_channel_id": claim.channel_id.to_string(),
            "guild_id": claim.guild_id().map(|id| id.to_string()),
            "self_mute": false,
            "self_deaf": false,
            "self_stream": false,
            "self_video": false,
            "suppress": false,
            "mute": false,
            "deaf": false,
            "username": user.as_ref().map(|u| u.username.as_str()),
            "avatar_hash": user.as_ref().and_then(|u| u.avatar_hash.as_deref()),
        }),
        claim.guild_id(),
    );

    tracing::info!(
        user_id,
        channel_id = claim.channel_id,
        "voice: released a claim the media relay no longer backs"
    );
    true
}
