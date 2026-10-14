use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use chrono::{DateTime, Utc};
use dashmap::DashMap;
use tokio::sync::Notify;

use crate::participant::{MediaParticipant, ViewTarget};
use paracord_transport::stream::{
    PublishedTrack, StreamId, TrackId, TrackSubscription, VideoCodecCapability,
};

/// Maximum number of call members (joined or listening) per room.
const MAX_PARTICIPANTS: usize = 50;

/// Maximum number of view sessions per room, on top of its call members.
///
/// A viewer costs the relay one fan-out copy of the stream it watches (an
/// ambient one only a keyframe a second of the lowest layer), so this is sized
/// for "everyone in a busy server looking at the same stream" while still
/// bounding what one room can make the relay send.
pub const MAX_VIEWERS_PER_ROOM: usize = 200;

/// A user's current view session. Each account holds at most one.
#[derive(Debug, Clone)]
pub struct ViewRecord {
    pub guild_id: i64,
    pub channel_id: i64,
    pub room_id: String,
    pub session_id: String,
    pub target: ViewTarget,
    /// Last time the view was known to be backed by a live media connection
    /// (or, until it first connects, when it was created). The idle sweep
    /// retires a view that has been unbacked for longer than its grace.
    pub last_live: Instant,
}

// Count of whole-room deep clones taken via `MediaRoomManager::get_room` on the
// *current thread*.
//
// Test-only instrumentation: the control plane must never deep-clone a room, so
// the availability regression tests drive control messages and assert this
// counter does not move. It is deliberately thread-local — a process-wide
// counter is moved by every other test running in parallel, which makes the
// assertion measure test scheduling rather than the control plane.
#[cfg(test)]
thread_local! {
    static GET_ROOM_CLONES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Zero this thread's deep-clone counter before driving a control path.
#[cfg(test)]
pub(crate) fn reset_get_room_clones() {
    GET_ROOM_CLONES.with(|clones| clones.set(0));
}

/// Whole-room deep clones taken on this thread since the last reset.
#[cfg(test)]
pub(crate) fn get_room_clones() -> u64 {
    GET_ROOM_CLONES.with(std::cell::Cell::get)
}

/// A media room containing participants who can exchange audio/video.
#[derive(Debug, Clone)]
pub struct MediaRoom {
    pub room_id: String,
    pub guild_id: i64,
    pub channel_id: i64,
    pub participants: HashMap<i64, MediaParticipant>,
    pub max_participants: usize,
    pub created_at: DateTime<Utc>,
}

impl MediaRoom {
    pub fn new(room_id: String, guild_id: i64, channel_id: i64) -> Self {
        Self {
            room_id,
            guild_id,
            channel_id,
            participants: HashMap::new(),
            max_participants: MAX_PARTICIPANTS,
            created_at: Utc::now(),
        }
    }

    /// Returns the list of user IDs currently in the room.
    pub fn user_ids(&self) -> Vec<i64> {
        self.participants.keys().copied().collect()
    }

    /// Returns whether the room is empty.
    pub fn is_empty(&self) -> bool {
        self.participants.is_empty()
    }

    /// Returns whether the room's call seats are full. View sessions do not
    /// take call seats; they have their own cap ([`MAX_VIEWERS_PER_ROOM`]).
    pub fn is_full(&self) -> bool {
        self.member_count() >= self.max_participants
    }

    /// Call members (joined or listening), excluding view sessions.
    pub fn member_count(&self) -> usize {
        self.participants
            .values()
            .filter(|participant| !participant.is_viewer())
            .count()
    }

    /// View sessions in this room.
    pub fn viewer_count(&self) -> usize {
        self.participants
            .values()
            .filter(|participant| participant.is_viewer())
            .count()
    }

    /// How many members watch each publisher's stream, keyed by publisher.
    /// Publishers nobody watches are absent. Ambient views never count.
    pub fn watcher_counts(&self) -> BTreeMap<i64, u32> {
        let mut counts = BTreeMap::new();
        for participant in self.participants.values() {
            if let Some(publisher) = participant.watched_publisher() {
                *counts.entry(publisher).or_insert(0) += 1;
            }
        }
        counts
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RoomError {
    #[error("room is full (max {0} participants)")]
    RoomFull(usize),
    #[error("room not found: {0}")]
    NotFound(String),
    #[error("user {0} not in room {1}")]
    UserNotInRoom(i64, String),
    #[error("user {0} already in room {1}")]
    AlreadyInRoom(i64, String),
    #[error("room has too many viewers (max {0})")]
    ViewersFull(usize),
    #[error("a view session may not do that")]
    NotAllowedForViewer,
}

/// Thread-safe manager for media rooms.
pub struct MediaRoomManager {
    rooms: DashMap<String, MediaRoom>,
    /// Per-room monotonic counter bumped on every mutation that can change that
    /// room's relay routing (membership, publish/subscribe, layer, session
    /// metadata). The relay uses it to invalidate its per-`(sender, ssrc)`
    /// recipient snapshot cache without recomputing on every forwarded datagram.
    ///
    /// This is deliberately **per room**, not one server-wide counter. A single
    /// global generation meant any control message from any participant in any
    /// room — `ReceiverReport` and `SubscribeStream` are reachable from the
    /// control channel with no rate limit — invalidated the recipient cache for
    /// every sender in every room on the server, forcing a full rebuild (and,
    /// before this change, a deep clone of the entire room) for every media
    /// packet server-wide.
    room_generations: DashMap<String, Arc<AtomicU64>>,
    membership_gates: std::sync::Mutex<HashMap<i64, std::sync::Weak<std::sync::Mutex<()>>>>,
    /// Each account's current view session (at most one), by user id.
    views: DashMap<i64, ViewRecord>,
    /// Rooms (as `(guild_id, channel_id)`) whose watcher counts may have
    /// changed since the listener last drained them.
    watch_dirty: std::sync::Mutex<HashSet<(i64, i64)>>,
    /// Wakes the watcher-count listener after `watch_dirty` gains an entry.
    watch_notify: Arc<Notify>,
    /// Whether a listener has claimed `watch_notify` (one per manager).
    watch_listener_claimed: AtomicBool,
}

impl MediaRoomManager {
    fn make_room_id(guild_id: i64, channel_id: i64) -> String {
        format!("{}:{}", guild_id, channel_id)
    }

    pub fn new() -> Self {
        Self {
            rooms: DashMap::new(),
            room_generations: DashMap::new(),
            membership_gates: std::sync::Mutex::new(HashMap::new()),
            views: DashMap::new(),
            watch_dirty: std::sync::Mutex::new(HashSet::new()),
            watch_notify: Arc::new(Notify::new()),
            watch_listener_claimed: AtomicBool::new(false),
        }
    }

    // ── Watcher-count change signaling ──────────────────────────────────────
    //
    // Every membership mutation that can change who counts as watching a
    // stream (a watch view arriving or leaving, a call member that watches
    // leaving the call by any path, `set_watching`) marks the room dirty here.
    // The API layer drains the set and broadcasts the new counts, so the count
    // is right whichever code path removed the member.

    fn mark_watch_dirty(&self, guild_id: i64, channel_id: i64) {
        self.watch_dirty
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert((guild_id, channel_id));
        self.watch_notify.notify_one();
    }

    /// Claim the watcher-count change signal. Returns `Some` exactly once per
    /// manager; the caller owns draining [`Self::drain_watch_dirty`].
    pub fn claim_watch_listener(&self) -> Option<Arc<Notify>> {
        (!self.watch_listener_claimed.swap(true, Ordering::AcqRel))
            .then(|| Arc::clone(&self.watch_notify))
    }

    /// Rooms whose watcher counts may have changed, as `(guild_id, channel_id)`.
    pub fn drain_watch_dirty(&self) -> Vec<(i64, i64)> {
        let mut dirty = self
            .watch_dirty
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut drained: Vec<_> = dirty.drain().collect();
        drained.sort_unstable();
        drained
    }

    /// Current watcher counts for one room, keyed by publisher. Empty when the
    /// room does not exist or nobody watches anything.
    pub fn watcher_counts(&self, guild_id: i64, channel_id: i64) -> BTreeMap<i64, u32> {
        let room_id = Self::make_room_id(guild_id, channel_id);
        self.with_room(&room_id, MediaRoom::watcher_counts)
            .unwrap_or_default()
    }

    /// Per-account membership gate.
    ///
    /// Every mutation that can change *which* session owns a user's membership
    /// (join, leave, restore) takes this gate, and so does every relay mutation
    /// performed on behalf of one connection ([`Self::with_participant_session`]).
    /// A late cleanup from a superseded session therefore cannot interleave with
    /// its replacement's join.
    ///
    /// The map holds `Weak` handles and is swept on every miss, so it cannot grow
    /// past the set of accounts that currently hold a gate. Callers that take the
    /// gate repeatedly (the relay's per-datagram fence) must cache the returned
    /// `Arc` rather than re-resolving it: resolving takes a process-wide lock.
    pub(crate) fn membership_gate(&self, user_id: i64) -> Arc<std::sync::Mutex<()>> {
        let mut gates = self
            .membership_gates
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(gate) = gates.get(&user_id).and_then(std::sync::Weak::upgrade) {
            return gate;
        }
        gates.retain(|_, gate| gate.strong_count() > 0);
        let gate = Arc::new(std::sync::Mutex::new(()));
        gates.insert(user_id, Arc::downgrade(&gate));
        gate
    }

    /// Lock-free check that `expected` is still the session that owns `user_id`'s
    /// membership of `room_id`.
    ///
    /// This is the read-only half of [`Self::with_participant_session`], for hot
    /// paths that only need to stop (not to mutate) once a connection has been
    /// superseded.
    pub fn participant_session_matches(&self, room_id: &str, user_id: i64, expected: &str) -> bool {
        self.rooms.get(room_id).is_some_and(|room| {
            room.participants
                .get(&user_id)
                .is_some_and(|participant| participant.session_id == expected)
        })
    }

    /// Runs synchronous relay mutations only while the authenticated membership
    /// receipt still owns this participant. The closure must not join/leave
    /// (the gate is not reentrant) and must not block.
    pub fn with_participant_session<R>(
        &self,
        room_id: &str,
        user_id: i64,
        expected: &str,
        run: impl FnOnce() -> R,
    ) -> Option<R> {
        let gate = self.membership_gate(user_id);
        self.with_held_membership_gate(&gate, room_id, user_id, expected, run)
    }

    /// [`Self::with_participant_session`] against an already-resolved gate.
    ///
    /// `gate` **must** be the gate [`Self::membership_gate`] returns for
    /// `user_id`; callers cache it so the hot path never takes the process-wide
    /// gate-registry lock.
    pub(crate) fn with_held_membership_gate<R>(
        &self,
        gate: &std::sync::Mutex<()>,
        room_id: &str,
        user_id: i64,
        expected: &str,
        run: impl FnOnce() -> R,
    ) -> Option<R> {
        let _membership = gate.lock().unwrap_or_else(|error| error.into_inner());
        self.participant_session_matches(room_id, user_id, expected)
            .then(run)
    }

    /// Current routing generation for one room. Changes whenever that room's
    /// state affecting fan-out is mutated. Cheap (one map read plus an atomic
    /// load) so the relay hot path can gate its recipient cache on it.
    pub fn generation(&self, room_id: &str) -> u64 {
        self.room_generations
            .get(room_id)
            .map(|g| g.load(Ordering::Acquire))
            .unwrap_or(0)
    }

    /// Bump one room's routing generation after a mutation.
    fn bump_generation(&self, room_id: &str) {
        self.room_generations
            .entry(room_id.to_string())
            .or_insert_with(|| Arc::new(AtomicU64::new(0)))
            .fetch_add(1, Ordering::Release);
    }

    /// Run `f` against a room **without cloning it**.
    ///
    /// [`get_room`] deep-clones the entire `MediaRoom` (every participant, its
    /// published tracks, subscriptions and stored key ciphertexts). That is
    /// acceptable for the cold, occasional callers but not for the relay's
    /// recipient-snapshot rebuild, which a hostile peer can drive at control
    /// message rate. The closure must not re-enter the room map (it holds a
    /// `DashMap` read guard) and must not `.await`.
    pub fn with_room<R>(&self, room_id: &str, f: impl FnOnce(&MediaRoom) -> R) -> Option<R> {
        self.rooms.get(room_id).map(|room| f(room.value()))
    }

    /// Get or create a room for the given guild/channel combination.
    /// Returns the room_id.
    pub fn get_or_create_room(&self, guild_id: i64, channel_id: i64) -> String {
        let room_id = Self::make_room_id(guild_id, channel_id);
        self.rooms
            .entry(room_id.clone())
            .or_insert_with(|| MediaRoom::new(room_id.clone(), guild_id, channel_id));
        room_id
    }

    /// Join a participant to a room. Creates the room if it doesn't exist.
    /// Returns the current list of participants (including the new one).
    ///
    /// This admits a *call member* (joined or listening). A view session is
    /// admitted through [`Self::join_view`] instead and is refused here.
    ///
    /// A call member that replaces this user's view session in the same room
    /// keeps watching what the view watched (the stage does not stop because
    /// the viewer joined the call), and a rejoin keeps the member's watch.
    pub fn join_room(
        &self,
        guild_id: i64,
        channel_id: i64,
        mut participant: MediaParticipant,
    ) -> Result<Vec<MediaParticipant>, RoomError> {
        if participant.is_viewer() {
            return Err(RoomError::NotAllowedForViewer);
        }
        let gate = self.membership_gate(participant.user_id);
        let _membership = gate.lock().unwrap_or_else(|error| error.into_inner());
        let room_id = self.get_or_create_room(guild_id, channel_id);
        let user_id = participant.user_id;

        let mut room = self
            .rooms
            .get_mut(&room_id)
            .ok_or_else(|| RoomError::NotFound(room_id.clone()))?;

        let previous = room.participants.get(&user_id);
        let previously_member = previous.is_some_and(|previous| !previous.is_viewer());
        if room.is_full() && !previously_member {
            return Err(RoomError::RoomFull(room.max_participants));
        }
        let previous_watch = previous.and_then(MediaParticipant::watched_publisher);
        let replaced_view_session = previous
            .filter(|previous| previous.is_viewer())
            .map(|previous| previous.session_id.clone());
        if participant.watching.is_none() {
            participant.watching = previous_watch;
        }
        let watch_changed = previous_watch != participant.watching;

        room.participants.insert(user_id, participant);

        // Auto-subscribe the new member to every other call member and vice
        // versa. View sessions take no voices and publish none.
        let other_ids: Vec<i64> = room
            .participants
            .values()
            .filter(|other| other.user_id != user_id && !other.is_viewer())
            .map(|other| other.user_id)
            .collect();

        if let Some(p) = room.participants.get_mut(&user_id) {
            p.subscribe(user_id);
            p.subscribe_all(&other_ids);
        }
        for &other_id in &other_ids {
            if let Some(other) = room.participants.get_mut(&other_id) {
                other.subscribe(user_id);
            }
        }

        let participants = room.participants.values().cloned().collect();
        drop(room);
        if let Some(session_id) = replaced_view_session {
            self.views
                .remove_if(&user_id, |_, view| view.session_id == session_id);
        }
        self.bump_generation(&room_id);
        if watch_changed {
            self.mark_watch_dirty(guild_id, channel_id);
        }
        Ok(participants)
    }

    /// Admit a view session (see [`crate::participant::ViewTarget`]).
    ///
    /// Each account holds at most one view session: this one replaces any
    /// other the account holds, in this room or another. A user who is a call
    /// member of this room watches through the call instead
    /// (`AlreadyInRoom`), so a user is never both a member and a viewer of one
    /// room. Returns the view this one replaced, if any.
    pub fn join_view(
        &self,
        guild_id: i64,
        channel_id: i64,
        participant: MediaParticipant,
    ) -> Result<Option<ViewRecord>, RoomError> {
        let Some(target) = participant.view else {
            return Err(RoomError::UserNotInRoom(
                participant.user_id,
                Self::make_room_id(guild_id, channel_id),
            ));
        };
        let user_id = participant.user_id;
        let session_id = participant.session_id.clone();
        let gate = self.membership_gate(user_id);
        let _membership = gate.lock().unwrap_or_else(|error| error.into_inner());
        let room_id = self.get_or_create_room(guild_id, channel_id);

        {
            let room = self
                .rooms
                .get(&room_id)
                .ok_or_else(|| RoomError::NotFound(room_id.clone()))?;
            match room.participants.get(&user_id) {
                Some(existing) if !existing.is_viewer() => {
                    return Err(RoomError::AlreadyInRoom(user_id, room_id.clone()));
                }
                Some(_) => {}
                None if room.viewer_count() >= MAX_VIEWERS_PER_ROOM => {
                    return Err(RoomError::ViewersFull(MAX_VIEWERS_PER_ROOM));
                }
                None => {}
            }
        }

        // Retire the account's previous view wherever it is. Removing it can
        // empty (and so drop) this very room, hence the second get-or-create.
        let replaced = self.views.remove(&user_id).map(|(_, view)| view);
        if let Some(previous) = replaced.as_ref() {
            self.remove_participant_locked(&previous.room_id, user_id, Some(&previous.session_id));
        }

        let room_id = self.get_or_create_room(guild_id, channel_id);
        let mut room = self
            .rooms
            .get_mut(&room_id)
            .ok_or_else(|| RoomError::NotFound(room_id.clone()))?;
        room.participants.insert(user_id, participant);
        drop(room);
        self.views.insert(
            user_id,
            ViewRecord {
                guild_id,
                channel_id,
                room_id: room_id.clone(),
                session_id,
                target,
                last_live: Instant::now(),
            },
        );
        self.bump_generation(&room_id);
        if target.counted_publisher().is_some() {
            self.mark_watch_dirty(guild_id, channel_id);
        }
        Ok(replaced)
    }

    /// End `user_id`'s view session, if it is still the one `expected` names
    /// (any view when `expected` is `None`). Returns the view that ended.
    pub fn end_view_if_session(&self, user_id: i64, expected: Option<&str>) -> Option<ViewRecord> {
        let gate = self.membership_gate(user_id);
        let _membership = gate.lock().unwrap_or_else(|error| error.into_inner());
        let (_, view) = self.views.remove_if(&user_id, |_, view| {
            expected.is_none_or(|expected| view.session_id == expected)
        })?;
        self.remove_participant_locked(&view.room_id, user_id, Some(&view.session_id));
        Some(view)
    }

    /// End `user_id`'s view session if it is in `guild_id` (a member removed
    /// from a server loses the view of it too).
    pub fn end_view_in_guild(&self, user_id: i64, guild_id: i64) -> Option<ViewRecord> {
        let session = self
            .views
            .get(&user_id)
            .filter(|view| view.guild_id == guild_id)
            .map(|view| view.session_id.clone())?;
        self.end_view_if_session(user_id, Some(&session))
    }

    /// `user_id`'s current view session.
    pub fn view_for_user(&self, user_id: i64) -> Option<ViewRecord> {
        self.views.get(&user_id).map(|view| view.clone())
    }

    /// Every current view session, as `(user_id, view)`.
    pub fn views_snapshot(&self) -> Vec<(i64, ViewRecord)> {
        self.views
            .iter()
            .map(|entry| (*entry.key(), entry.value().clone()))
            .collect()
    }

    /// Record that `user_id`'s view `session_id` is backed by a live connection.
    pub fn touch_view(&self, user_id: i64, session_id: &str, now: Instant) {
        if let Some(mut view) = self.views.get_mut(&user_id) {
            if view.session_id == session_id {
                view.last_live = now;
            }
        }
    }

    /// The room a view-session media token admits, or `None` when the token's
    /// receipt is not this account's current view session (ended, replaced,
    /// or never issued) or names another room.
    pub fn resolve_view_admission(
        &self,
        user_id: i64,
        session_id: &str,
        claimed_room_id: Option<&str>,
    ) -> Option<String> {
        let view = self.views.get(&user_id)?;
        if view.session_id != session_id
            || claimed_room_id.is_some_and(|claimed| claimed != view.room_id)
        {
            return None;
        }
        let room_id = view.room_id.clone();
        drop(view);
        self.participant_session_matches(&room_id, user_id, session_id)
            .then_some(room_id)
    }

    /// Whether `session_id` is `user_id`'s view session in `room_id` (as
    /// opposed to a call membership there).
    pub fn is_view_session(&self, room_id: &str, user_id: i64, session_id: &str) -> bool {
        self.rooms.get(room_id).is_some_and(|room| {
            room.participants.get(&user_id).is_some_and(|participant| {
                participant.is_viewer() && participant.session_id == session_id
            })
        })
    }

    /// The view target of `user_id` in `room_id`, when it is a view session.
    pub fn view_target(&self, room_id: &str, user_id: i64) -> Option<ViewTarget> {
        self.rooms
            .get(room_id)
            .and_then(|room| room.participants.get(&user_id).and_then(|p| p.view))
    }

    /// Set (or clear) the stream a call member watches through its call.
    /// Scoped to the member's receipt; returns whether anything changed.
    pub fn set_watching(
        &self,
        guild_id: i64,
        channel_id: i64,
        user_id: i64,
        session_id: &str,
        publisher_user_id: Option<i64>,
    ) -> Result<bool, RoomError> {
        let gate = self.membership_gate(user_id);
        let _membership = gate.lock().unwrap_or_else(|error| error.into_inner());
        let room_id = Self::make_room_id(guild_id, channel_id);
        let mut room = self
            .rooms
            .get_mut(&room_id)
            .ok_or_else(|| RoomError::NotFound(room_id.clone()))?;
        let participant = room
            .participants
            .get_mut(&user_id)
            .filter(|participant| participant.session_id == session_id)
            .ok_or_else(|| RoomError::UserNotInRoom(user_id, room_id.clone()))?;
        if participant.is_viewer() {
            return Err(RoomError::NotAllowedForViewer);
        }
        if participant.watching == publisher_user_id {
            return Ok(false);
        }
        participant.watching = publisher_user_id;
        drop(room);
        self.mark_watch_dirty(guild_id, channel_id);
        Ok(true)
    }

    /// Remove `user_id` from `room_id` when `expected` still names its
    /// receipt. The caller must hold `user_id`'s membership gate.
    fn remove_participant_locked(
        &self,
        room_id: &str,
        user_id: i64,
        expected: Option<&str>,
    ) -> Option<Vec<MediaParticipant>> {
        use dashmap::mapref::entry::Entry;
        let Entry::Occupied(mut entry) = self.rooms.entry(room_id.to_string()) else {
            return None;
        };
        if expected.is_some_and(|id| {
            entry
                .get()
                .participants
                .get(&user_id)
                .is_none_or(|participant| participant.session_id != id)
        }) {
            return None;
        }
        let room = entry.get_mut();
        let removed = room.participants.remove(&user_id);
        for participant in room.participants.values_mut() {
            participant.unsubscribe(user_id);
        }
        let (guild_id, channel_id) = (room.guild_id, room.channel_id);
        if let Some(removed) = removed.as_ref() {
            if removed.is_viewer() {
                let session_id = removed.session_id.clone();
                self.views
                    .remove_if(&user_id, |_, view| view.session_id == session_id);
            }
            if removed.watched_publisher().is_some() {
                self.mark_watch_dirty(guild_id, channel_id);
            }
        }
        if room.is_empty() {
            // Keep removal atomic with the emptiness check. A new join cannot
            // be inserted between that check and removal of the map entry.
            self.room_generations.remove(room_id);
            entry.remove();
            None
        } else {
            let remaining = room.participants.values().cloned().collect();
            self.bump_generation(room_id);
            Some(remaining)
        }
    }

    /// Undo an uncommitted replacement without touching a later receipt.
    pub fn restore_participant_if_session(
        &self,
        guild_id: i64,
        channel_id: i64,
        user_id: i64,
        expected: &str,
        previous: Option<MediaParticipant>,
    ) {
        // A displaced view session is not restored: its view record is gone,
        // and a viewer participant without one would be an orphan. The client
        // opens a new view if it still wants one.
        if let Some(previous) = previous.filter(|previous| !previous.is_viewer()) {
            let gate = self.membership_gate(user_id);
            let _membership = gate.lock().unwrap_or_else(|error| error.into_inner());
            let room_id = Self::make_room_id(guild_id, channel_id);
            if let Some(mut room) = self.rooms.get_mut(&room_id) {
                if room
                    .participants
                    .get(&user_id)
                    .is_some_and(|participant| participant.session_id == expected)
                {
                    room.participants.insert(user_id, previous);
                    drop(room);
                    self.bump_generation(&room_id);
                }
            }
        } else {
            self.leave_room_if_session(guild_id, channel_id, user_id, Some(expected));
        }
    }

    /// Remove a participant from a room.
    /// Returns the remaining participants, or None if the room was destroyed.
    pub fn leave_room(
        &self,
        guild_id: i64,
        channel_id: i64,
        user_id: i64,
    ) -> Option<Vec<MediaParticipant>> {
        self.leave_room_if_session(guild_id, channel_id, user_id, None)
    }

    /// Preserve a replacement participant when an earlier connection/REST leave arrives late.
    ///
    /// Removes a view session the same way (its view record goes with it), so
    /// every leave path keeps the watcher counts right.
    pub fn leave_room_if_session(
        &self,
        guild_id: i64,
        channel_id: i64,
        user_id: i64,
        expected: Option<&str>,
    ) -> Option<Vec<MediaParticipant>> {
        let gate = self.membership_gate(user_id);
        let _membership = gate.lock().unwrap_or_else(|error| error.into_inner());
        let room_id = Self::make_room_id(guild_id, channel_id);
        self.remove_participant_locked(&room_id, user_id, expected)
    }

    /// Get a snapshot of a room.
    ///
    /// This is a **deep clone** of every participant, published track,
    /// subscription and stored key ciphertext. Only cold callers may use it; any
    /// path a peer can drive (media forwarding, the control channel) must use
    /// [`Self::with_room`] instead. `GET_ROOM_CLONES` lets the availability
    /// regression tests assert that.
    pub fn get_room(&self, room_id: &str) -> Option<MediaRoom> {
        #[cfg(test)]
        GET_ROOM_CLONES.with(|clones| clones.set(clones.get() + 1));
        self.rooms.get(room_id).map(|r| r.clone())
    }

    /// Publish or update a track in an existing room.
    pub fn publish_track(
        &self,
        room_id: &str,
        user_id: i64,
        track: PublishedTrack,
    ) -> Result<(), RoomError> {
        let mut room = self
            .rooms
            .get_mut(room_id)
            .ok_or_else(|| RoomError::NotFound(room_id.to_string()))?;
        let participant = room
            .participants
            .get_mut(&user_id)
            .ok_or_else(|| RoomError::UserNotInRoom(user_id, room_id.to_string()))?;
        participant.publish_track(track);
        self.bump_generation(room_id);
        Ok(())
    }

    pub fn store_track_key(
        &self,
        room_id: &str,
        publisher_user_id: i64,
        stream_id: &StreamId,
        track_id: &TrackId,
        epoch: u8,
        recipient_user_id: i64,
        ciphertext: Vec<u8>,
    ) -> Result<(), RoomError> {
        let mut room = self
            .rooms
            .get_mut(room_id)
            .ok_or_else(|| RoomError::NotFound(room_id.to_string()))?;
        let participant = room
            .participants
            .get_mut(&publisher_user_id)
            .ok_or_else(|| RoomError::UserNotInRoom(publisher_user_id, room_id.to_string()))?;
        participant.store_track_key(stream_id, track_id, epoch, recipient_user_id, ciphertext);
        Ok(())
    }

    /// Forget every stored track key in `room_id` addressed to this recipient.
    ///
    /// Called when a participant (re)joins a media session, because the call
    /// key those envelopes were sealed to has just been replaced.
    pub fn forget_track_keys_for_recipient(&self, room_id: &str, recipient_user_id: i64) {
        let Some(mut room) = self.rooms.get_mut(room_id) else {
            return;
        };
        for participant in room.participants.values_mut() {
            participant.forget_track_keys_for_recipient(recipient_user_id);
        }
    }

    pub fn latest_track_key_for_recipient(
        &self,
        room_id: &str,
        publisher_user_id: i64,
        stream_id: &StreamId,
        track_id: &TrackId,
        recipient_user_id: i64,
    ) -> Result<Option<(u8, Vec<u8>)>, RoomError> {
        let room = self
            .rooms
            .get(room_id)
            .ok_or_else(|| RoomError::NotFound(room_id.to_string()))?;
        let participant = room
            .participants
            .get(&publisher_user_id)
            .ok_or_else(|| RoomError::UserNotInRoom(publisher_user_id, room_id.to_string()))?;
        Ok(participant.latest_track_key_for_recipient(stream_id, track_id, recipient_user_id))
    }

    /// Remove a published track from a room.
    pub fn unpublish_track(
        &self,
        room_id: &str,
        user_id: i64,
        stream_id: &StreamId,
        track_id: &TrackId,
    ) -> Result<(), RoomError> {
        let mut room = self
            .rooms
            .get_mut(room_id)
            .ok_or_else(|| RoomError::NotFound(room_id.to_string()))?;
        let participant = room
            .participants
            .get_mut(&user_id)
            .ok_or_else(|| RoomError::UserNotInRoom(user_id, room_id.to_string()))?;
        participant.unpublish_track(stream_id, track_id);
        self.bump_generation(room_id);
        Ok(())
    }

    /// Subscribe a participant to another user's media at the participant
    /// (audio) level. This drives the audio fan-out fallback used when no
    /// explicit per-track subscription exists.
    pub fn subscribe_participant(
        &self,
        room_id: &str,
        user_id: i64,
        target_user_id: i64,
    ) -> Result<(), RoomError> {
        let mut room = self
            .rooms
            .get_mut(room_id)
            .ok_or_else(|| RoomError::NotFound(room_id.to_string()))?;
        let participant = room
            .participants
            .get_mut(&user_id)
            .ok_or_else(|| RoomError::UserNotInRoom(user_id, room_id.to_string()))?;
        participant.subscribe(target_user_id);
        self.bump_generation(room_id);
        Ok(())
    }

    /// Remove a participant-level (audio) subscription to another user.
    pub fn unsubscribe_participant(
        &self,
        room_id: &str,
        user_id: i64,
        target_user_id: i64,
    ) -> Result<(), RoomError> {
        let mut room = self
            .rooms
            .get_mut(room_id)
            .ok_or_else(|| RoomError::NotFound(room_id.to_string()))?;
        let participant = room
            .participants
            .get_mut(&user_id)
            .ok_or_else(|| RoomError::UserNotInRoom(user_id, room_id.to_string()))?;
        participant.unsubscribe(target_user_id);
        self.bump_generation(room_id);
        Ok(())
    }

    /// Subscribe a participant to a specific published track.
    ///
    /// A view session may subscribe only to a published track of the stream it
    /// watches (`NotAllowedForViewer` otherwise), and an ambient view is
    /// pinned to the track's lowest simulcast layer whatever it asks for.
    /// Register (or replace) a viewer's subscription to one track.
    ///
    /// Returns `Some(layer)` when the viewer was already receiving this track
    /// on another layer: the forwarded layer is then left where it was, and
    /// `layer` is where the new subscription resolves. The caller stages that
    /// switch for the target layer's next keyframe (spec §4.2), because a
    /// viewer flipped to another layer mid-GOP receives deltas it cannot decode
    /// (the green picture of stream audit B4).
    pub fn subscribe_track(
        &self,
        room_id: &str,
        user_id: i64,
        mut subscription: TrackSubscription,
    ) -> Result<Option<u8>, RoomError> {
        let mut room = self
            .rooms
            .get_mut(room_id)
            .ok_or_else(|| RoomError::NotFound(room_id.to_string()))?;
        let track = room
            .participants
            .values()
            .flat_map(|participant| participant.published_tracks.values())
            .find(|track| {
                track.stream_id == subscription.stream_id && track.track_id == subscription.track_id
            })
            .cloned();
        let view = room
            .participants
            .get(&user_id)
            .ok_or_else(|| RoomError::UserNotInRoom(user_id, room_id.to_string()))?
            .view;
        if let Some(view) = view {
            let Some(track) = track.as_ref().filter(|track| view.allows_track(track)) else {
                return Err(RoomError::NotAllowedForViewer);
            };
            if view.is_ambient() {
                let lowest = lowest_layer(track);
                subscription.requested_layer = Some(lowest);
                subscription.active_layer = Some(lowest);
                subscription.viewport = None;
            }
        }
        let participant = room
            .participants
            .get_mut(&user_id)
            .ok_or_else(|| RoomError::UserNotInRoom(user_id, room_id.to_string()))?;
        let mut staged = None;
        if let Some(track) = track {
            // Resolve the request afresh (a viewer's own `active_layer` is not
            // authoritative), then keep forwarding the layer it already gets.
            subscription.active_layer = None;
            let resolved = subscription.resolved_layer_id(&track);
            let previous = participant
                .track_subscriptions
                .get(&(
                    subscription.stream_id.clone(),
                    subscription.track_id.clone(),
                ))
                .and_then(|existing| existing.active_layer)
                .filter(|layer| track.layers.iter().any(|l| l.layer_id == *layer));
            subscription.active_layer = match (previous, resolved) {
                (Some(previous), Some(resolved)) if previous != resolved => {
                    staged = Some(resolved);
                    Some(previous)
                }
                _ => resolved,
            };
        }
        participant.subscribe_track(subscription);
        self.bump_generation(room_id);
        Ok(staged)
    }

    /// Remove a participant's explicit track subscription.
    pub fn unsubscribe_track(
        &self,
        room_id: &str,
        user_id: i64,
        stream_id: &StreamId,
        track_id: &TrackId,
    ) -> Result<(), RoomError> {
        let mut room = self
            .rooms
            .get_mut(room_id)
            .ok_or_else(|| RoomError::NotFound(room_id.to_string()))?;
        let participant = room
            .participants
            .get_mut(&user_id)
            .ok_or_else(|| RoomError::UserNotInRoom(user_id, room_id.to_string()))?;
        participant.unsubscribe_track(stream_id, track_id);
        self.bump_generation(room_id);
        Ok(())
    }

    pub fn update_track_subscription(
        &self,
        room_id: &str,
        user_id: i64,
        stream_id: &StreamId,
        track_id: &TrackId,
        active_layer: Option<u8>,
        viewport: Option<paracord_transport::stream::ViewportHint>,
    ) -> Result<bool, RoomError> {
        let mut room = self
            .rooms
            .get_mut(room_id)
            .ok_or_else(|| RoomError::NotFound(room_id.to_string()))?;
        let resolved_active_layer = room
            .participants
            .values()
            .flat_map(|participant| participant.published_tracks.values())
            .find(|track| track.stream_id == *stream_id && track.track_id == *track_id)
            .and_then(|track| {
                let mut preview = TrackSubscription {
                    stream_id: stream_id.clone(),
                    track_id: track_id.clone(),
                    requested_layer: None,
                    active_layer,
                    viewport: viewport.clone(),
                };
                if preview.active_layer.is_none() {
                    preview.active_layer = preview.resolved_layer_id(track);
                }
                preview.active_layer
            })
            .or(active_layer);
        let participant = room
            .participants
            .get_mut(&user_id)
            .ok_or_else(|| RoomError::UserNotInRoom(user_id, room_id.to_string()))?;
        if participant.is_ambient_viewer() {
            // Pinned at subscribe time; nothing a viewer reports moves it.
            return Ok(participant
                .track_subscriptions
                .contains_key(&(stream_id.clone(), track_id.clone())));
        }
        let updated = participant.update_track_subscription(stream_id, track_id, |subscription| {
            subscription.viewport = viewport.clone();
            if active_layer.is_some() {
                subscription.active_layer = active_layer;
            } else if resolved_active_layer.is_some() {
                subscription.active_layer = resolved_active_layer;
            }
        });
        self.bump_generation(room_id);
        Ok(updated)
    }

    /// Update ONLY a viewer's viewport hint for a track, leaving the relay-owned
    /// `active_layer` untouched (spec §4.2: the relay's per-viewer selection owns
    /// the forwarded layer; a viewport update just re-caps future selections).
    /// Returns whether the subscription existed. Bumps the routing generation so
    /// the viewport-derived cap is picked up on the next selection pass.
    pub fn update_subscription_viewport(
        &self,
        room_id: &str,
        user_id: i64,
        stream_id: &StreamId,
        track_id: &TrackId,
        viewport: Option<paracord_transport::stream::ViewportHint>,
    ) -> Result<bool, RoomError> {
        let mut room = self
            .rooms
            .get_mut(room_id)
            .ok_or_else(|| RoomError::NotFound(room_id.to_string()))?;
        let participant = room
            .participants
            .get_mut(&user_id)
            .ok_or_else(|| RoomError::UserNotInRoom(user_id, room_id.to_string()))?;
        if participant.is_ambient_viewer() {
            return Ok(false);
        }
        let updated = participant.update_track_subscription(stream_id, track_id, |subscription| {
            subscription.viewport = viewport.clone();
        });
        self.bump_generation(room_id);
        Ok(updated)
    }

    /// Commit a relay-driven layer switch by setting ONLY a viewer's forwarded
    /// (`active_layer`) layer for a track (spec §4.2). Called at the target
    /// layer's keyframe boundary so the datagram/uni-stream fan-out flips
    /// atomically. Returns whether the subscription existed. Bumps the routing
    /// generation so the recipient-snapshot cache rebuilds against the new layer.
    pub fn set_subscription_active_layer(
        &self,
        room_id: &str,
        user_id: i64,
        stream_id: &StreamId,
        track_id: &TrackId,
        active_layer: u8,
    ) -> Result<bool, RoomError> {
        let mut room = self
            .rooms
            .get_mut(room_id)
            .ok_or_else(|| RoomError::NotFound(room_id.to_string()))?;
        let participant = room
            .participants
            .get_mut(&user_id)
            .ok_or_else(|| RoomError::UserNotInRoom(user_id, room_id.to_string()))?;
        if participant.is_ambient_viewer() {
            // An ambient view stays on the lowest layer.
            return Ok(false);
        }
        let updated = participant.update_track_subscription(stream_id, track_id, |subscription| {
            subscription.active_layer = Some(active_layer);
        });
        self.bump_generation(room_id);
        Ok(updated)
    }

    pub fn update_participant_session_metadata(
        &self,
        room_id: &str,
        user_id: i64,
        session_id: String,
        video_capabilities: Vec<VideoCodecCapability>,
    ) -> Result<(), RoomError> {
        let mut room = self
            .rooms
            .get_mut(room_id)
            .ok_or_else(|| RoomError::NotFound(room_id.to_string()))?;
        let participant = room
            .participants
            .get_mut(&user_id)
            .ok_or_else(|| RoomError::UserNotInRoom(user_id, room_id.to_string()))?;
        participant.session_id = session_id;
        participant.set_video_capabilities(video_capabilities);
        self.bump_generation(room_id);
        Ok(())
    }

    /// Change whether a participant may announce and publish media tracks.
    /// Stage promotion/demotion uses this to enforce the role at the relay,
    /// rather than relying on a client-side muted state.
    pub fn update_participant_publish_permission(
        &self,
        guild_id: i64,
        channel_id: i64,
        user_id: i64,
        can_publish: bool,
    ) -> Result<(), RoomError> {
        let room_id = Self::make_room_id(guild_id, channel_id);
        let mut room = self
            .rooms
            .get_mut(&room_id)
            .ok_or_else(|| RoomError::NotFound(room_id.clone()))?;
        let participant = room
            .participants
            .get_mut(&user_id)
            .ok_or_else(|| RoomError::UserNotInRoom(user_id, room_id.clone()))?;
        participant.can_publish = can_publish;
        drop(room);
        self.bump_generation(&room_id);
        Ok(())
    }

    /// [`Self::update_participant_publish_permission`] scoped to a call
    /// receipt, for the in-place listen ↔ joined switch. A view session can
    /// never be granted publish rights.
    pub fn update_participant_publish_permission_if_session(
        &self,
        guild_id: i64,
        channel_id: i64,
        user_id: i64,
        session_id: &str,
        can_publish: bool,
    ) -> Result<(), RoomError> {
        let gate = self.membership_gate(user_id);
        let _membership = gate.lock().unwrap_or_else(|error| error.into_inner());
        let room_id = Self::make_room_id(guild_id, channel_id);
        let mut room = self
            .rooms
            .get_mut(&room_id)
            .ok_or_else(|| RoomError::NotFound(room_id.clone()))?;
        let participant = room
            .participants
            .get_mut(&user_id)
            .filter(|participant| participant.session_id == session_id)
            .ok_or_else(|| RoomError::UserNotInRoom(user_id, room_id.clone()))?;
        if participant.is_viewer() {
            return Err(RoomError::NotAllowedForViewer);
        }
        participant.can_publish = can_publish;
        drop(room);
        self.bump_generation(&room_id);
        Ok(())
    }

    /// Get a room by guild/channel.
    pub fn get_room_by_channel(&self, guild_id: i64, channel_id: i64) -> Option<MediaRoom> {
        let room_id = Self::make_room_id(guild_id, channel_id);
        self.get_room(&room_id)
    }

    /// List all active room IDs.
    pub fn list_rooms(&self) -> Vec<String> {
        self.rooms.iter().map(|r| r.key().clone()).collect()
    }

    /// Get the number of active rooms.
    pub fn room_count(&self) -> usize {
        self.rooms.len()
    }
}

/// Lowest published layer id of a track (0 for a track without layers).
fn lowest_layer(track: &PublishedTrack) -> u8 {
    track
        .layers
        .iter()
        .map(|layer| layer.layer_id)
        .min()
        .unwrap_or(0)
}

impl Default for MediaRoomManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use paracord_transport::stream::{VideoCodec, VideoCodecCapability};

    fn make_participant(user_id: i64) -> MediaParticipant {
        MediaParticipant::new(user_id, format!("session-{}", user_id))
    }

    #[test]
    fn create_and_join_room() {
        let mgr = MediaRoomManager::new();
        let participants = mgr.join_room(1, 100, make_participant(42)).unwrap();
        assert_eq!(participants.len(), 1);
        assert_eq!(participants[0].user_id, 42);
        assert_eq!(mgr.room_count(), 1);
    }

    #[test]
    fn join_multiple_participants() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, make_participant(1)).unwrap();
        let participants = mgr.join_room(1, 100, make_participant(2)).unwrap();
        assert_eq!(participants.len(), 2);

        // User 2 should be subscribed to user 1
        let p2 = participants.iter().find(|p| p.user_id == 2).unwrap();
        assert!(p2.subscriptions.contains(&1));

        // User 1 should be subscribed to user 2
        let p1 = participants.iter().find(|p| p.user_id == 1).unwrap();
        assert!(p1.subscriptions.contains(&2));
    }

    #[test]
    fn leave_room_removes_subscriptions() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, make_participant(1)).unwrap();
        mgr.join_room(1, 100, make_participant(2)).unwrap();
        mgr.join_room(1, 100, make_participant(3)).unwrap();

        let remaining = mgr.leave_room(1, 100, 2).unwrap();
        assert_eq!(remaining.len(), 2);

        // Remaining participants should not be subscribed to user 2
        for p in &remaining {
            assert!(!p.subscriptions.contains(&2));
        }
    }

    /// The routing generation must be per room. With one server-wide counter,
    /// a single peer spamming `ReceiverReport`/`SubscribeStream` invalidated the
    /// relay's recipient cache for every sender in every other call on the
    /// server, forcing a full fan-out rebuild per media packet server-wide.
    #[test]
    fn routing_generation_is_scoped_to_one_room() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, make_participant(1)).unwrap();
        mgr.join_room(1, 100, make_participant(2)).unwrap();
        mgr.join_room(2, 200, make_participant(3)).unwrap();

        let room_a = "1:100".to_string();
        let room_b = "2:200".to_string();
        let a_before = mgr.generation(&room_a);
        let b_before = mgr.generation(&room_b);

        // A control-channel-reachable mutation in room A.
        mgr.subscribe_participant(&room_a, 1, 2).unwrap();

        assert!(
            mgr.generation(&room_a) > a_before,
            "room A's own generation must advance"
        );
        assert_eq!(
            mgr.generation(&room_b),
            b_before,
            "a mutation in room A must not invalidate room B's routing cache"
        );
    }

    /// The per-room generation map must not outlive its rooms.
    #[test]
    fn destroying_a_room_drops_its_generation_entry() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, make_participant(1)).unwrap();
        let room_id = "1:100".to_string();
        assert!(mgr.generation(&room_id) > 0);

        assert!(mgr.leave_room(1, 100, 1).is_none());
        assert_eq!(mgr.room_count(), 0);
        assert_eq!(
            mgr.generation(&room_id),
            0,
            "the destroyed room's generation entry must be reclaimed"
        );
    }

    /// `with_room` is the hot-path accessor; it must observe the same state
    /// `get_room` clones, without cloning.
    #[test]
    fn with_room_observes_live_state_without_cloning() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, make_participant(7)).unwrap();
        let room_id = "1:100".to_string();

        let seen = mgr
            .with_room(&room_id, |room| room.participants.contains_key(&7))
            .unwrap();
        assert!(seen);
        assert!(mgr.with_room("nope", |_| true).is_none());
    }

    #[test]
    fn leave_last_participant_destroys_room() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, make_participant(1)).unwrap();
        let result = mgr.leave_room(1, 100, 1);
        assert!(result.is_none());
        assert_eq!(mgr.room_count(), 0);
    }

    #[test]
    fn get_room_returns_none_for_missing() {
        let mgr = MediaRoomManager::new();
        assert!(mgr.get_room("nonexistent").is_none());
    }

    #[test]
    fn get_or_create_is_idempotent() {
        let mgr = MediaRoomManager::new();
        let id1 = mgr.get_or_create_room(1, 100);
        let id2 = mgr.get_or_create_room(1, 100);
        assert_eq!(id1, id2);
        assert_eq!(mgr.room_count(), 1);
    }

    #[test]
    fn list_rooms() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, make_participant(1)).unwrap();
        mgr.join_room(1, 200, make_participant(2)).unwrap();
        let rooms = mgr.list_rooms();
        assert_eq!(rooms.len(), 2);
    }

    #[test]
    fn publish_and_subscribe_track_in_room() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, make_participant(1)).unwrap();
        mgr.join_room(1, 100, make_participant(2)).unwrap();
        let room_id = mgr.get_or_create_room(1, 100);

        let track = PublishedTrack {
            stream_id: StreamId::new("stream-1"),
            track_id: TrackId::new("screen"),
            publisher_user_id: 1,
            kind: paracord_transport::control::TrackKind::Video,
            codec: Some(paracord_transport::stream::VideoCodec::H264),
            layers: vec![],
        };
        mgr.publish_track(&room_id, 1, track.clone()).unwrap();
        mgr.subscribe_track(
            &room_id,
            2,
            TrackSubscription {
                stream_id: track.stream_id.clone(),
                track_id: track.track_id.clone(),
                requested_layer: Some(0),
                active_layer: Some(0),
                viewport: None,
            },
        )
        .unwrap();

        let room = mgr.get_room(&room_id).unwrap();
        assert_eq!(room.participants.get(&1).unwrap().published_tracks.len(), 1);
        assert_eq!(
            room.participants.get(&2).unwrap().track_subscriptions.len(),
            1
        );
    }

    #[test]
    fn stores_latest_track_key_for_recipient() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, make_participant(1)).unwrap();
        mgr.join_room(1, 100, make_participant(2)).unwrap();
        let room_id = mgr.get_or_create_room(1, 100);
        let stream_id = StreamId::new("stream-1");
        let track_id = TrackId::new("screen");

        mgr.publish_track(
            &room_id,
            1,
            PublishedTrack {
                stream_id: stream_id.clone(),
                track_id: track_id.clone(),
                publisher_user_id: 1,
                kind: paracord_transport::control::TrackKind::Video,
                codec: Some(paracord_transport::stream::VideoCodec::H264),
                layers: vec![],
            },
        )
        .unwrap();

        mgr.store_track_key(&room_id, 1, &stream_id, &track_id, 1, 2, vec![1; 16])
            .unwrap();
        mgr.store_track_key(&room_id, 1, &stream_id, &track_id, 2, 2, vec![2; 16])
            .unwrap();

        let latest = mgr
            .latest_track_key_for_recipient(&room_id, 1, &stream_id, &track_id, 2)
            .unwrap()
            .expect("recipient key");
        assert_eq!(latest.0, 2);
        assert_eq!(latest.1, vec![2; 16]);
    }

    #[test]
    fn subscribe_track_resolves_active_layer_from_viewport() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, make_participant(1)).unwrap();
        mgr.join_room(1, 100, make_participant(2)).unwrap();
        let room_id = mgr.get_or_create_room(1, 100);

        let track = PublishedTrack {
            stream_id: StreamId::new("stream-1"),
            track_id: TrackId::new("screen"),
            publisher_user_id: 1,
            kind: paracord_transport::control::TrackKind::Video,
            codec: Some(paracord_transport::stream::VideoCodec::H264),
            layers: vec![
                paracord_transport::stream::PublishedLayer {
                    layer_id: 0,
                    ssrc: 100,
                    width: Some(320),
                    height: Some(180),
                    max_bitrate_kbps: Some(300),
                    active: false,
                },
                paracord_transport::stream::PublishedLayer {
                    layer_id: 1,
                    ssrc: 101,
                    width: Some(640),
                    height: Some(360),
                    max_bitrate_kbps: Some(1000),
                    active: false,
                },
                paracord_transport::stream::PublishedLayer {
                    layer_id: 2,
                    ssrc: 102,
                    width: Some(1280),
                    height: Some(720),
                    max_bitrate_kbps: Some(2500),
                    active: true,
                },
            ],
        };
        mgr.publish_track(&room_id, 1, track.clone()).unwrap();
        mgr.subscribe_track(
            &room_id,
            2,
            TrackSubscription {
                stream_id: track.stream_id.clone(),
                track_id: track.track_id.clone(),
                requested_layer: None,
                active_layer: None,
                viewport: Some(paracord_transport::stream::ViewportHint {
                    width: 500,
                    height: 300,
                }),
            },
        )
        .unwrap();

        let room = mgr.get_room(&room_id).unwrap();
        let participant = room.participants.get(&2).unwrap();
        let subscription = participant
            .track_subscriptions
            .get(&(track.stream_id.clone(), track.track_id.clone()))
            .unwrap();
        assert_eq!(subscription.active_layer, Some(1));

        // Asking for another layer while receiving one does not flip the
        // forwarded layer mid-GOP: it stays, and the new layer is returned to
        // be switched to at its next keyframe (stream audit B4).
        let staged = mgr
            .subscribe_track(
                &room_id,
                2,
                TrackSubscription {
                    stream_id: track.stream_id.clone(),
                    track_id: track.track_id.clone(),
                    requested_layer: Some(paracord_transport::stream::SOURCE_LAYER),
                    active_layer: None,
                    viewport: None,
                },
            )
            .unwrap();
        assert_eq!(staged, Some(2), "Source resolves to the top layer");
        let room = mgr.get_room(&room_id).unwrap();
        let subscription = room.participants[&2]
            .track_subscriptions
            .get(&(track.stream_id.clone(), track.track_id.clone()))
            .unwrap()
            .clone();
        assert_eq!(
            subscription.active_layer,
            Some(1),
            "still forwarding layer 1"
        );
    }

    #[test]
    fn receiver_report_updates_subscription_viewport_and_layer() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, make_participant(1)).unwrap();
        mgr.join_room(1, 100, make_participant(2)).unwrap();
        let room_id = mgr.get_or_create_room(1, 100);

        let track = PublishedTrack {
            stream_id: StreamId::new("stream-1"),
            track_id: TrackId::new("screen"),
            publisher_user_id: 1,
            kind: paracord_transport::control::TrackKind::Video,
            codec: Some(paracord_transport::stream::VideoCodec::H264),
            layers: vec![
                paracord_transport::stream::PublishedLayer {
                    layer_id: 0,
                    ssrc: 100,
                    width: Some(320),
                    height: Some(180),
                    max_bitrate_kbps: Some(300),
                    active: false,
                },
                paracord_transport::stream::PublishedLayer {
                    layer_id: 1,
                    ssrc: 101,
                    width: Some(640),
                    height: Some(360),
                    max_bitrate_kbps: Some(1000),
                    active: false,
                },
                paracord_transport::stream::PublishedLayer {
                    layer_id: 2,
                    ssrc: 102,
                    width: Some(1280),
                    height: Some(720),
                    max_bitrate_kbps: Some(2500),
                    active: true,
                },
            ],
        };
        mgr.publish_track(&room_id, 1, track.clone()).unwrap();
        mgr.subscribe_track(
            &room_id,
            2,
            TrackSubscription {
                stream_id: track.stream_id.clone(),
                track_id: track.track_id.clone(),
                requested_layer: Some(2),
                active_layer: Some(2),
                viewport: None,
            },
        )
        .unwrap();

        let updated = mgr
            .update_track_subscription(
                &room_id,
                2,
                &track.stream_id,
                &track.track_id,
                None,
                Some(paracord_transport::stream::ViewportHint {
                    width: 500,
                    height: 300,
                }),
            )
            .unwrap();
        assert!(updated);

        let room = mgr.get_room(&room_id).unwrap();
        let participant = room.participants.get(&2).unwrap();
        let subscription = participant
            .track_subscriptions
            .get(&(track.stream_id.clone(), track.track_id.clone()))
            .unwrap();
        assert_eq!(subscription.active_layer, Some(1));
        assert_eq!(
            subscription.viewport,
            Some(paracord_transport::stream::ViewportHint {
                width: 500,
                height: 300,
            })
        );
    }

    #[test]
    fn update_participant_session_metadata_persists_video_capabilities() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, make_participant(1)).unwrap();
        let room_id = mgr.get_or_create_room(1, 100);

        mgr.update_participant_session_metadata(
            &room_id,
            1,
            "native-1b".to_string(),
            vec![VideoCodecCapability {
                codec: VideoCodec::H264,
                encode: true,
                decode: true,
                encode_hardware: true,
                decode_hardware: true,
            }],
        )
        .unwrap();

        let room = mgr.get_room(&room_id).unwrap();
        let participant = room.participants.get(&1).unwrap();
        assert_eq!(participant.session_id, "native-1b");
        assert_eq!(participant.video_capabilities.len(), 1);
        assert_eq!(participant.video_capabilities[0].codec, VideoCodec::H264);
        assert!(participant.video_capabilities[0].encode_hardware);
    }

    // ── Receipt-scoped membership ───────────────────────────────────────────
    //
    // A user's membership is owned by exactly one call receipt. A leave or a
    // rollback that names an older receipt is a message from a call that no
    // longer exists, and must not touch the call that replaced it.

    #[test]
    fn leave_room_if_session_preserves_a_replacement_receipt() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, MediaParticipant::new(7, "call-1".into()))
            .unwrap();
        mgr.join_room(1, 100, MediaParticipant::new(8, "other".into()))
            .unwrap();
        // The user rejoins: a new receipt takes over the same membership.
        mgr.join_room(1, 100, MediaParticipant::new(7, "call-2".into()))
            .unwrap();

        // The first call's delayed leave names its own receipt and is ignored.
        assert!(mgr
            .leave_room_if_session(1, 100, 7, Some("call-1"))
            .is_none());
        assert!(mgr.participant_session_matches("1:100", 7, "call-2"));

        // The receipt that owns the membership can still end it.
        let remaining = mgr
            .leave_room_if_session(1, 100, 7, Some("call-2"))
            .expect("the owning receipt ends the membership");
        assert_eq!(remaining.len(), 1);
        assert!(!mgr.participant_session_matches("1:100", 7, "call-2"));
    }

    #[test]
    fn an_unreceipted_leave_still_removes_whoever_is_current() {
        // The legacy path (an old client that sends no receipt, and every
        // account-scoped eviction) must keep working.
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, MediaParticipant::new(7, "call-1".into()))
            .unwrap();
        assert!(mgr.leave_room(1, 100, 7).is_none());
        assert!(mgr.get_room("1:100").is_none());
    }

    #[test]
    fn restore_participant_if_session_never_clobbers_a_newer_receipt() {
        let mgr = MediaRoomManager::new();
        let previous = MediaParticipant::new(7, "call-1".into());
        mgr.join_room(1, 100, previous.clone()).unwrap();

        // An admission that has not committed replaces the participant...
        mgr.join_room(1, 100, MediaParticipant::new(7, "call-2".into()))
            .unwrap();
        // ...and then loses its durable write, so it rolls itself back.
        mgr.restore_participant_if_session(1, 100, 7, "call-2", Some(previous.clone()));
        assert!(
            mgr.participant_session_matches("1:100", 7, "call-1"),
            "a rolled-back admission restores the receipt it displaced"
        );

        // A third call arrives before the rollback runs: the rollback must not
        // resurrect the receipt that call replaced.
        mgr.join_room(1, 100, MediaParticipant::new(7, "call-3".into()))
            .unwrap();
        mgr.restore_participant_if_session(1, 100, 7, "call-2", Some(previous));
        assert!(
            mgr.participant_session_matches("1:100", 7, "call-3"),
            "a late rollback must not displace a newer receipt"
        );
    }

    #[test]
    fn restoring_no_previous_membership_removes_only_the_uncommitted_receipt() {
        let mgr = MediaRoomManager::new();
        // A first-time join that fails to commit leaves nothing behind.
        mgr.join_room(1, 100, MediaParticipant::new(7, "call-1".into()))
            .unwrap();
        mgr.restore_participant_if_session(1, 100, 7, "call-1", None);
        assert!(mgr.get_room("1:100").is_none());

        // The same rollback arriving after a newer join leaves it alone.
        mgr.join_room(1, 100, MediaParticipant::new(7, "call-2".into()))
            .unwrap();
        mgr.restore_participant_if_session(1, 100, 7, "call-1", None);
        assert!(mgr.participant_session_matches("1:100", 7, "call-2"));
    }

    // ── View sessions and watcher counts ────────────────────────────────────

    use crate::participant::{ViewKind, ViewTarget};

    fn watch(publisher: i64) -> ViewTarget {
        ViewTarget {
            kind: ViewKind::Watch,
            publisher_user_id: publisher,
        }
    }

    fn ambient(publisher: i64) -> ViewTarget {
        ViewTarget {
            kind: ViewKind::Ambient,
            publisher_user_id: publisher,
        }
    }

    fn viewer(user_id: i64, session: &str, target: ViewTarget) -> MediaParticipant {
        MediaParticipant::viewer(user_id, session.into(), target)
    }

    #[test]
    fn a_view_session_takes_no_voices_and_no_call_seat() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, make_participant(1)).unwrap();
        mgr.join_view(1, 100, viewer(9, "view-9", watch(1)))
            .unwrap();
        mgr.join_room(1, 100, make_participant(2)).unwrap();

        let room = mgr.get_room("1:100").unwrap();
        let view = room.participants.get(&9).unwrap();
        assert!(
            view.subscriptions.is_empty(),
            "a viewer is subscribed to no voice"
        );
        assert!(!view.can_publish);
        for member in [1, 2] {
            assert!(
                !room.participants[&member].subscriptions.contains(&9),
                "members do not subscribe to a viewer"
            );
        }
        assert_eq!(room.member_count(), 2);
        assert_eq!(room.viewer_count(), 1);

        // A viewer is never admitted through the call path.
        assert!(matches!(
            mgr.join_room(1, 100, viewer(10, "v", watch(1))),
            Err(RoomError::NotAllowedForViewer)
        ));
    }

    #[test]
    fn watcher_counts_count_watch_views_and_watching_members_but_never_ambient() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, make_participant(1)).unwrap();
        mgr.join_room(1, 100, make_participant(2)).unwrap();
        mgr.join_view(1, 100, viewer(8, "view-8", watch(1)))
            .unwrap();
        mgr.join_view(1, 100, viewer(9, "view-9", ambient(1)))
            .unwrap();
        assert!(mgr.set_watching(1, 100, 2, "session-2", Some(1)).unwrap());

        let counts = mgr.watcher_counts(1, 100);
        assert_eq!(
            counts.get(&1),
            Some(&2),
            "a watch view and a watching member"
        );
        assert_eq!(counts.len(), 1);

        // Setting the same watch again changes nothing.
        assert!(!mgr.set_watching(1, 100, 2, "session-2", Some(1)).unwrap());
        // A viewer cannot use the member path, and a stale receipt is refused.
        assert!(mgr.set_watching(1, 100, 8, "view-8", None).is_err());
        assert!(mgr.set_watching(1, 100, 2, "old", None).is_err());
    }

    #[test]
    fn every_change_to_who_watches_marks_the_room_dirty() {
        let mgr = MediaRoomManager::new();
        let signal = mgr.claim_watch_listener().expect("first claim");
        assert!(
            mgr.claim_watch_listener().is_none(),
            "one listener per manager"
        );
        drop(signal);

        mgr.join_room(1, 100, make_participant(1)).unwrap();
        mgr.join_room(1, 100, make_participant(2)).unwrap();
        assert!(
            mgr.drain_watch_dirty().is_empty(),
            "joining is not watching"
        );

        mgr.join_view(1, 100, viewer(9, "view-9", ambient(1)))
            .unwrap();
        assert!(
            mgr.drain_watch_dirty().is_empty(),
            "ambient is never counted"
        );

        mgr.join_view(1, 100, viewer(8, "view-8", watch(1)))
            .unwrap();
        assert_eq!(mgr.drain_watch_dirty(), vec![(1, 100)]);

        mgr.set_watching(1, 100, 2, "session-2", Some(1)).unwrap();
        assert_eq!(mgr.drain_watch_dirty(), vec![(1, 100)]);

        // A watching member leaving by *any* path (here the plain room leave
        // every call teardown uses) changes the count.
        mgr.leave_room_if_session(1, 100, 2, Some("session-2"));
        assert_eq!(mgr.drain_watch_dirty(), vec![(1, 100)]);
        assert_eq!(mgr.watcher_counts(1, 100).get(&1), Some(&1));

        mgr.end_view_if_session(8, Some("view-8")).unwrap();
        assert_eq!(mgr.drain_watch_dirty(), vec![(1, 100)]);
        assert!(mgr.watcher_counts(1, 100).is_empty());
    }

    #[test]
    fn an_account_holds_one_view_and_a_new_one_replaces_it_anywhere() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, make_participant(1)).unwrap();
        mgr.join_room(2, 200, make_participant(3)).unwrap();

        mgr.join_view(1, 100, viewer(9, "view-a", watch(1)))
            .unwrap();
        let replaced = mgr
            .join_view(2, 200, viewer(9, "view-b", ambient(3)))
            .unwrap()
            .expect("the first view is replaced");
        assert_eq!(replaced.session_id, "view-a");
        assert!(!mgr.get_room("1:100").unwrap().participants.contains_key(&9));
        assert!(mgr.watcher_counts(1, 100).is_empty());
        let current = mgr.view_for_user(9).unwrap();
        assert_eq!((current.guild_id, current.channel_id), (2, 200));
        assert_eq!(current.session_id, "view-b");

        // Ending with a stale receipt does nothing; the current one ends it.
        assert!(mgr.end_view_if_session(9, Some("view-a")).is_none());
        assert!(mgr.end_view_if_session(9, Some("view-b")).is_some());
        assert!(mgr.view_for_user(9).is_none());
        assert!(!mgr.get_room("2:200").unwrap().participants.contains_key(&9));
    }

    #[test]
    fn a_call_member_watches_through_its_call_not_a_view() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, make_participant(1)).unwrap();
        mgr.join_room(1, 100, make_participant(2)).unwrap();
        assert!(matches!(
            mgr.join_view(1, 100, viewer(2, "view-2", watch(1))),
            Err(RoomError::AlreadyInRoom(2, _))
        ));
        assert!(mgr.view_for_user(2).is_none());
    }

    #[test]
    fn joining_the_call_from_a_watch_view_keeps_watching() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, make_participant(1)).unwrap();
        mgr.join_view(1, 100, viewer(9, "view-9", watch(1)))
            .unwrap();
        mgr.drain_watch_dirty();

        mgr.join_room(1, 100, MediaParticipant::new(9, "call-9".into()))
            .unwrap();
        let room = mgr.get_room("1:100").unwrap();
        let member = &room.participants[&9];
        assert!(!member.is_viewer());
        assert_eq!(member.watching, Some(1), "the stage does not stop");
        assert!(
            member.subscriptions.contains(&1),
            "and now it hears the call"
        );
        assert!(mgr.view_for_user(9).is_none(), "the view record is gone");
        assert_eq!(mgr.watcher_counts(1, 100).get(&1), Some(&1));
        assert!(
            mgr.drain_watch_dirty().is_empty(),
            "the count did not change, so nothing is re-announced"
        );
    }

    #[test]
    fn view_admission_needs_the_current_view_receipt_and_its_room() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, make_participant(1)).unwrap();
        mgr.join_view(1, 100, viewer(9, "view-9", watch(1)))
            .unwrap();

        assert_eq!(
            mgr.resolve_view_admission(9, "view-9", Some("1:100")),
            Some("1:100".to_string())
        );
        assert_eq!(
            mgr.resolve_view_admission(9, "view-9", None),
            Some("1:100".to_string())
        );
        assert_eq!(mgr.resolve_view_admission(9, "view-9", Some("1:101")), None);
        assert_eq!(mgr.resolve_view_admission(9, "other", Some("1:100")), None);
        // A call receipt is never a view receipt.
        assert_eq!(mgr.resolve_view_admission(1, "session-1", None), None);
        assert!(mgr.is_view_session("1:100", 9, "view-9"));
        assert!(!mgr.is_view_session("1:100", 1, "session-1"));

        mgr.end_view_if_session(9, None);
        assert_eq!(mgr.resolve_view_admission(9, "view-9", None), None);
    }

    #[test]
    fn ambient_subscriptions_are_pinned_to_the_lowest_layer() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, make_participant(1)).unwrap();
        mgr.join_view(1, 100, viewer(9, "view-9", ambient(1)))
            .unwrap();
        let room_id = "1:100";
        let layer = |layer_id: u8, ssrc: u32| paracord_transport::stream::PublishedLayer {
            layer_id,
            ssrc,
            width: None,
            height: None,
            max_bitrate_kbps: None,
            active: true,
        };
        let screen = PublishedTrack {
            stream_id: StreamId::new("stream:1:screen"),
            track_id: TrackId::new("screen"),
            publisher_user_id: 1,
            kind: paracord_transport::control::TrackKind::Video,
            codec: Some(VideoCodec::Vp9),
            layers: vec![layer(0, 10), layer(1, 11), layer(2, 12)],
        };
        mgr.publish_track(room_id, 1, screen.clone()).unwrap();

        mgr.subscribe_track(
            room_id,
            9,
            TrackSubscription {
                stream_id: screen.stream_id.clone(),
                track_id: screen.track_id.clone(),
                requested_layer: Some(2),
                active_layer: Some(2),
                viewport: Some(paracord_transport::stream::ViewportHint {
                    width: 1920,
                    height: 1080,
                }),
            },
        )
        .unwrap();
        let active = |mgr: &MediaRoomManager| {
            mgr.get_room(room_id).unwrap().participants[&9].track_subscriptions
                [&(screen.stream_id.clone(), screen.track_id.clone())]
                .active_layer
        };
        assert_eq!(active(&mgr), Some(0));

        // Nothing the viewer or the relay's selection does moves it.
        mgr.update_track_subscription(
            room_id,
            9,
            &screen.stream_id,
            &screen.track_id,
            Some(2),
            None,
        )
        .unwrap();
        assert!(!mgr
            .set_subscription_active_layer(room_id, 9, &screen.stream_id, &screen.track_id, 2)
            .unwrap());
        assert_eq!(active(&mgr), Some(0));

        // A camera, or a track that is not published, is refused.
        let camera = PublishedTrack {
            stream_id: StreamId::new("stream:1:camera"),
            ..screen.clone()
        };
        mgr.publish_track(room_id, 1, camera.clone()).unwrap();
        for (stream_id, track_id) in [
            (camera.stream_id.clone(), camera.track_id.clone()),
            (StreamId::new("stream:1:screen"), TrackId::new("nope")),
        ] {
            assert!(matches!(
                mgr.subscribe_track(
                    room_id,
                    9,
                    TrackSubscription {
                        stream_id,
                        track_id,
                        requested_layer: None,
                        active_layer: None,
                        viewport: None,
                    }
                ),
                Err(RoomError::NotAllowedForViewer)
            ));
        }
    }

    #[test]
    fn a_room_holds_a_bounded_number_of_viewers() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(1, 100, make_participant(1)).unwrap();
        for user_id in 0..MAX_VIEWERS_PER_ROOM as i64 {
            mgr.join_view(1, 100, viewer(1_000 + user_id, "v", watch(1)))
                .unwrap();
        }
        assert!(matches!(
            mgr.join_view(1, 100, viewer(99_999, "v", watch(1))),
            Err(RoomError::ViewersFull(MAX_VIEWERS_PER_ROOM))
        ));
        // Viewers do not take call seats.
        mgr.join_room(1, 100, make_participant(2)).unwrap();
    }

    #[test]
    fn publish_permission_flips_in_place_under_the_receipt() {
        let mgr = MediaRoomManager::new();
        mgr.join_room(
            1,
            100,
            MediaParticipant::new(1, "call-1".into()).with_can_publish(false),
        )
        .unwrap();
        mgr.update_participant_publish_permission_if_session(1, 100, 1, "call-1", true)
            .unwrap();
        let room = mgr.get_room("1:100").unwrap();
        assert!(room.participants[&1].can_publish);
        assert_eq!(room.participants[&1].session_id, "call-1", "no reconnect");
        assert!(mgr
            .update_participant_publish_permission_if_session(1, 100, 1, "stale", false)
            .is_err());
        mgr.join_view(1, 100, viewer(9, "view-9", watch(1)))
            .unwrap();
        assert!(matches!(
            mgr.update_participant_publish_permission_if_session(1, 100, 9, "view-9", true),
            Err(RoomError::NotAllowedForViewer)
        ));
    }

    #[test]
    fn rejoining_a_full_room_with_a_new_receipt_is_not_rejected_as_full() {
        let mgr = MediaRoomManager::new();
        for user_id in 1..=MAX_PARTICIPANTS as i64 {
            mgr.join_room(1, 100, make_participant(user_id)).unwrap();
        }
        // A participant already in the room re-admits under a new receipt.
        mgr.join_room(1, 100, MediaParticipant::new(1, "call-2".into()))
            .unwrap();
        assert!(mgr.participant_session_matches("1:100", 1, "call-2"));
        // A genuinely new participant is still refused.
        assert!(matches!(
            mgr.join_room(1, 100, make_participant(9_999)),
            Err(RoomError::RoomFull(_))
        ));
    }
}
