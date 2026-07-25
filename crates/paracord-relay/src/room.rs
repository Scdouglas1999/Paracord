use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use dashmap::DashMap;

use crate::participant::MediaParticipant;
use paracord_transport::stream::{
    PublishedTrack, StreamId, TrackId, TrackSubscription, VideoCodecCapability,
};

/// Maximum number of participants per room.
const MAX_PARTICIPANTS: usize = 50;

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

    /// Returns whether the room is full.
    pub fn is_full(&self) -> bool {
        self.participants.len() >= self.max_participants
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
}

impl MediaRoomManager {
    fn make_room_id(guild_id: i64, channel_id: i64) -> String {
        format!("{}:{}", guild_id, channel_id)
    }

    pub fn new() -> Self {
        Self {
            rooms: DashMap::new(),
            room_generations: DashMap::new(),
        }
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
    pub fn join_room(
        &self,
        guild_id: i64,
        channel_id: i64,
        participant: MediaParticipant,
    ) -> Result<Vec<MediaParticipant>, RoomError> {
        let room_id = self.get_or_create_room(guild_id, channel_id);
        let user_id = participant.user_id;

        let mut room = self
            .rooms
            .get_mut(&room_id)
            .ok_or_else(|| RoomError::NotFound(room_id.clone()))?;

        if room.is_full() {
            return Err(RoomError::RoomFull(room.max_participants));
        }

        room.participants.insert(user_id, participant);

        // Auto-subscribe the new participant to everyone else and vice versa.
        let other_ids: Vec<i64> = room
            .participants
            .keys()
            .copied()
            .filter(|&id| id != user_id)
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
        self.bump_generation(&room_id);
        Ok(participants)
    }

    /// Remove a participant from a room.
    /// Returns the remaining participants, or None if the room was destroyed.
    pub fn leave_room(
        &self,
        guild_id: i64,
        channel_id: i64,
        user_id: i64,
    ) -> Option<Vec<MediaParticipant>> {
        let room_id = Self::make_room_id(guild_id, channel_id);

        let result = {
            let mut room = self.rooms.get_mut(&room_id)?;
            room.participants.remove(&user_id);

            // Remove subscriptions to the leaving user.
            for (_, p) in room.participants.iter_mut() {
                p.unsubscribe(user_id);
            }

            if room.is_empty() {
                None
            } else {
                Some(room.participants.values().cloned().collect())
            }
        };

        // If the room is empty, remove it from the map. Drop its generation
        // counter with it so the per-room map cannot grow without bound across
        // the lifetime of the process.
        if result.is_none() {
            self.rooms.remove(&room_id);
            self.room_generations.remove(&room_id);
            tracing::info!(room_id = %room_id, "room destroyed (last participant left)");
        } else {
            self.bump_generation(&room_id);
        }

        result
    }

    /// Get a snapshot of a room.
    pub fn get_room(&self, room_id: &str) -> Option<MediaRoom> {
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
    pub fn subscribe_track(
        &self,
        room_id: &str,
        user_id: i64,
        mut subscription: TrackSubscription,
    ) -> Result<(), RoomError> {
        let mut room = self
            .rooms
            .get_mut(room_id)
            .ok_or_else(|| RoomError::NotFound(room_id.to_string()))?;
        if let Some(track) = room
            .participants
            .values()
            .flat_map(|participant| participant.published_tracks.values())
            .find(|track| {
                track.stream_id == subscription.stream_id && track.track_id == subscription.track_id
            })
            .cloned()
        {
            subscription.active_layer = subscription.resolved_layer_id(&track);
        }
        let participant = room
            .participants
            .get_mut(&user_id)
            .ok_or_else(|| RoomError::UserNotInRoom(user_id, room_id.to_string()))?;
        participant.subscribe_track(subscription);
        self.bump_generation(room_id);
        Ok(())
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
}
