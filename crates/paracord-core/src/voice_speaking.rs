//! Who is talking in a voice channel right now, relayed for people outside the
//! call.
//!
//! Speaking is detected on each client by its own media engine, so without this
//! only the people in a call could see who is talking in it. A client in a voice
//! channel reports its OWN speaking edges (started / stopped); the server keeps
//! the current speakers per channel in memory and broadcasts a slim
//! `VOICE_SPEAKING` to guild members who can view that channel — the same
//! audience that already sees who is in it.
//!
//! The server only accepts "started" from a user whose voice state is in that
//! channel and who is not muted (self, server or stage suppression). A speaker is
//! cleared when they leave, move or mute, and when no refresh arrives within the
//! stale window (clients re-send "started" every 10 s while still talking).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::AppState;

/// Dispatched to the guild, filtered per channel by VIEW_CHANNEL.
pub use paracord_models::gateway::EVENT_VOICE_SPEAKING;

/// A "speaking" with no refresh for this long is dropped.
const DEFAULT_STALE_AFTER: Duration = Duration::from_secs(20);

/// Edge budget per user: a burst of three, then one every 400 ms. An honest
/// client sends at most one edge per 500 ms, so it never meets this.
const EDGE_BURST: u32 = 3;
const EDGE_PERIOD: Duration = Duration::from_millis(400);

struct Speaker {
    guild_id: i64,
    refreshed_at: Instant,
}

#[derive(Default)]
struct Inner {
    /// channel id -> user id -> speaker.
    channels: HashMap<i64, HashMap<i64, Speaker>>,
    /// user id -> theoretical arrival time of their next edge (GCRA).
    budgets: HashMap<i64, Instant>,
}

/// The current speakers of every voice channel, in memory.
pub struct SpeakingTracker {
    inner: Mutex<Inner>,
    stale_after_ms: AtomicU64,
    watcher_started: AtomicBool,
}

impl Default for SpeakingTracker {
    fn default() -> Self {
        Self::new()
    }
}

/// What became of one report. Only `Applied` changed what others see.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpeakingReport {
    /// The speaker set changed and the change was broadcast.
    Applied,
    /// Already in that state (a refresh, or a stop from someone not speaking).
    Unchanged,
    /// Over the per-user edge budget; dropped without a word.
    RateLimited,
    /// The reporter's voice state is not in that channel.
    NotInChannel,
    /// The reporter is self-muted, deafened, server-muted or suppressed.
    Muted,
}

impl SpeakingTracker {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            stale_after_ms: AtomicU64::new(DEFAULT_STALE_AFTER.as_millis() as u64),
            watcher_started: AtomicBool::new(false),
        }
    }

    /// How long a speaker survives without a refresh. Tests shorten it.
    pub fn set_stale_after(&self, stale_after: Duration) {
        self.stale_after_ms
            .store(stale_after.as_millis() as u64, Ordering::Relaxed);
    }

    fn stale_after(&self) -> Duration {
        Duration::from_millis(self.stale_after_ms.load(Ordering::Relaxed))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Whether `user_id` is talking in `channel_id` right now.
    pub fn is_speaking(&self, channel_id: i64, user_id: i64) -> bool {
        self.lock()
            .channels
            .get(&channel_id)
            .is_some_and(|speakers| speakers.contains_key(&user_id))
    }

    /// Everyone talking in `channel_id` right now.
    pub fn speakers(&self, channel_id: i64) -> Vec<i64> {
        self.lock()
            .channels
            .get(&channel_id)
            .map(|speakers| speakers.keys().copied().collect())
            .unwrap_or_default()
    }

    /// Charge one edge to `user_id`'s budget. False when it is spent.
    fn take_edge(&self, user_id: i64, now: Instant) -> bool {
        let mut inner = self.lock();
        let tat = inner.budgets.get(&user_id).copied().unwrap_or(now).max(now);
        let tolerance = EDGE_PERIOD * (EDGE_BURST - 1);
        if tat > now + tolerance {
            return false;
        }
        inner.budgets.insert(user_id, tat + EDGE_PERIOD);
        true
    }

    /// Mark a speaker (or refresh one). True when they were not speaking.
    fn start(&self, guild_id: i64, channel_id: i64, user_id: i64, now: Instant) -> bool {
        let mut inner = self.lock();
        let speakers = inner.channels.entry(channel_id).or_default();
        let fresh = !speakers.contains_key(&user_id);
        speakers.insert(
            user_id,
            Speaker {
                guild_id,
                refreshed_at: now,
            },
        );
        fresh
    }

    /// Remove a speaker. Returns their guild when they were speaking.
    fn stop(&self, channel_id: i64, user_id: i64) -> Option<i64> {
        let mut inner = self.lock();
        let speakers = inner.channels.get_mut(&channel_id)?;
        let removed = speakers.remove(&user_id)?;
        if speakers.is_empty() {
            inner.channels.remove(&channel_id);
        }
        Some(removed.guild_id)
    }

    /// Every `(channel, guild)` the user is currently speaking in.
    fn channels_of(&self, user_id: i64) -> Vec<(i64, i64)> {
        self.lock()
            .channels
            .iter()
            .filter_map(|(channel_id, speakers)| {
                speakers
                    .get(&user_id)
                    .map(|speaker| (*channel_id, speaker.guild_id))
            })
            .collect()
    }

    fn all(&self) -> Vec<(i64, i64, i64)> {
        self.lock()
            .channels
            .iter()
            .flat_map(|(channel_id, speakers)| {
                speakers
                    .iter()
                    .map(|(user_id, speaker)| (*channel_id, *user_id, speaker.guild_id))
            })
            .collect()
    }

    /// Drop speakers not refreshed within the stale window, and spent budgets.
    fn take_stale(&self, now: Instant) -> Vec<(i64, i64, i64)> {
        let stale_after = self.stale_after();
        let mut inner = self.lock();
        let mut stale = Vec::new();
        inner.channels.retain(|channel_id, speakers| {
            speakers.retain(|user_id, speaker| {
                let fresh = now.duration_since(speaker.refreshed_at) < stale_after;
                if !fresh {
                    stale.push((*channel_id, *user_id, speaker.guild_id));
                }
                fresh
            });
            !speakers.is_empty()
        });
        inner.budgets.retain(|_, tat| *tat > now);
        stale
    }
}

fn broadcast(state: &AppState, guild_id: i64, channel_id: i64, user_id: i64, speaking: bool) {
    // Guild-scoped with a `channel_id`: both transports deliver it only to
    // sessions that may view this voice channel.
    state.event_bus.dispatch(
        EVENT_VOICE_SPEAKING,
        json!({
            "guild_id": guild_id.to_string(),
            "channel_id": channel_id.to_string(),
            "user_id": user_id.to_string(),
            "speaking": speaking,
        }),
        Some(guild_id),
    );
}

fn clear(state: &AppState, channel_id: i64, user_id: i64) {
    if let Some(guild_id) = state.speaking.stop(channel_id, user_id) {
        broadcast(state, guild_id, channel_id, user_id, false);
    }
}

/// Apply one speaking edge reported by `user_id` for `channel_id`.
///
/// A stop is always honored (it can only clear the reporter's own flag). A
/// start is charged to the per-user edge budget, then checked against the
/// reporter's current voice state under the same membership lock every join,
/// leave and mute takes, so a start cannot slip in behind a leave.
pub async fn report(
    state: &AppState,
    user_id: i64,
    channel_id: i64,
    speaking: bool,
) -> Result<SpeakingReport, crate::error::CoreError> {
    ensure_watcher(state);

    if !speaking {
        return Ok(match state.speaking.stop(channel_id, user_id) {
            Some(guild_id) => {
                broadcast(state, guild_id, channel_id, user_id, false);
                SpeakingReport::Applied
            }
            None => SpeakingReport::Unchanged,
        });
    }

    if !state.speaking.take_edge(user_id, Instant::now()) {
        return Ok(SpeakingReport::RateLimited);
    }

    let _membership = state.voice.lock_membership(user_id).await;
    let Some(channel) = paracord_db::channels::get_channel(&state.db, channel_id).await? else {
        return Ok(SpeakingReport::NotInChannel);
    };
    let Some(guild_id) = channel.guild_id() else {
        // DM calls have no audience outside the call.
        return Ok(SpeakingReport::NotInChannel);
    };
    let Some(voice_state) =
        paracord_db::voice_states::get_user_voice_state(&state.db, user_id, Some(guild_id)).await?
    else {
        return Ok(SpeakingReport::NotInChannel);
    };
    if voice_state.channel_id != channel_id {
        return Ok(SpeakingReport::NotInChannel);
    }
    let Some(member) = paracord_db::members::get_member(&state.db, user_id, guild_id).await? else {
        return Ok(SpeakingReport::NotInChannel);
    };
    let server_muted = member.mute;
    if voice_state.self_mute || voice_state.self_deaf || voice_state.suppress || server_muted {
        clear(state, channel_id, user_id);
        return Ok(SpeakingReport::Muted);
    }

    if state
        .speaking
        .start(guild_id, channel_id, user_id, Instant::now())
    {
        broadcast(state, guild_id, channel_id, user_id, true);
        Ok(SpeakingReport::Applied)
    } else {
        Ok(SpeakingReport::Unchanged)
    }
}

fn id_at(payload: &Value, key: &str) -> Option<i64> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .and_then(|raw| raw.parse::<i64>().ok())
}

fn flag(payload: &Value, key: &str) -> bool {
    payload.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// Clear whatever a voice state change ends: a leave, a move, or a mute.
fn on_voice_state_update(state: &AppState, payload: &Value) {
    let Some(user_id) = id_at(payload, "user_id") else {
        return;
    };
    let now_in = id_at(payload, "channel_id");
    let left = id_at(payload, "prior_channel_id");
    let guild = id_at(payload, "guild_id");
    let muted = ["self_mute", "self_deaf", "suppress", "mute"]
        .iter()
        .any(|key| flag(payload, key));
    for (channel_id, guild_id) in state.speaking.channels_of(user_id) {
        let ends = match now_in {
            Some(current) if current == channel_id => muted,
            // Moved to another channel of the same server.
            Some(_) => guild == Some(guild_id),
            None => left.map_or(guild == Some(guild_id), |left| left == channel_id),
        };
        if ends {
            clear(state, channel_id, user_id);
        }
    }
}

/// A server mute applied to a member ends their speaking in that server.
fn on_member_update(state: &AppState, payload: &Value) {
    if !flag(payload, "mute") {
        return;
    }
    let (Some(user_id), Some(guild)) = (id_at(payload, "user_id"), id_at(payload, "guild_id"))
    else {
        return;
    };
    for (channel_id, guild_id) in state.speaking.channels_of(user_id) {
        if guild_id == guild {
            clear(state, channel_id, user_id);
        }
    }
}

/// After missed events, re-check every speaker against the stored voice state.
async fn revalidate_all(state: &AppState) {
    for (channel_id, user_id, guild_id) in state.speaking.all() {
        let still_in =
            paracord_db::voice_states::get_user_voice_state(&state.db, user_id, Some(guild_id))
                .await
                .ok()
                .flatten()
                .is_some_and(|vs| {
                    vs.channel_id == channel_id && !vs.self_mute && !vs.self_deaf && !vs.suppress
                });
        if !still_in {
            clear(state, channel_id, user_id);
        }
    }
}

fn sweep_interval(stale_after: Duration) -> Duration {
    (stale_after / 4).clamp(Duration::from_millis(50), Duration::from_secs(2))
}

/// Start the voice-state watcher and stale sweep once per process.
fn ensure_watcher(state: &AppState) {
    if state.speaking.watcher_started.swap(true, Ordering::SeqCst) {
        return;
    }
    // Subscribe before spawning so no event published after this call is missed.
    let mut events = state.event_bus.subscribe_system();
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            let tick = sweep_interval(state.speaking.stale_after());
            tokio::select! {
                event = events.recv() => match event {
                    Ok(event) => match event.event_type.as_str() {
                        "VOICE_STATE_UPDATE" => on_voice_state_update(&state, &event.payload),
                        "GUILD_MEMBER_UPDATE" => on_member_update(&state, &event.payload),
                        _ => {}
                    },
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        revalidate_all(&state).await;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
                _ = tokio::time::sleep(tick) => {
                    for (channel_id, user_id, guild_id) in state.speaking.take_stale(Instant::now()) {
                        broadcast(&state, guild_id, channel_id, user_id, false);
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edge_budget_allows_a_burst_then_one_per_period() {
        let tracker = SpeakingTracker::new();
        let t0 = Instant::now();
        assert!(tracker.take_edge(7, t0));
        assert!(tracker.take_edge(7, t0));
        assert!(tracker.take_edge(7, t0));
        assert!(!tracker.take_edge(7, t0));
        // Another user has their own budget.
        assert!(tracker.take_edge(8, t0));
        // One period later, one more edge.
        assert!(tracker.take_edge(7, t0 + EDGE_PERIOD));
        assert!(!tracker.take_edge(7, t0 + EDGE_PERIOD));
        // An honest client's pace (one edge per 500 ms) never runs dry.
        let mut at = t0 + Duration::from_secs(5);
        for _ in 0..50 {
            assert!(tracker.take_edge(9, at));
            at += Duration::from_millis(500);
        }
    }

    #[test]
    fn stale_speakers_are_swept() {
        let tracker = SpeakingTracker::new();
        tracker.set_stale_after(Duration::from_millis(100));
        let t0 = Instant::now();
        assert!(tracker.start(1, 10, 7, t0));
        assert!(!tracker.start(1, 10, 7, t0), "a refresh is not a new edge");
        assert!(tracker
            .take_stale(t0 + Duration::from_millis(50))
            .is_empty());
        assert_eq!(
            tracker.take_stale(t0 + Duration::from_millis(150)),
            vec![(10, 7, 1)]
        );
        assert!(!tracker.is_speaking(10, 7));
    }
}
