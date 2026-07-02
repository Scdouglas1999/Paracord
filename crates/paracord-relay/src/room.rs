use std::collections::HashMap;

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
}

impl MediaRoomManager {
    fn make_room_id(guild_id: i64, channel_id: i64) -> String {
        format!("{}:{}", guild_id, channel_id)
    }

    pub fn new() -> Self {
        Self {
            rooms: DashMap::new(),
        }
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

        Ok(room.participants.values().cloned().collect())
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

        // If the room is empty, remove it from the map.
        if result.is_none() {
            self.rooms.remove(&room_id);
            tracing::info!(room_id = %room_id, "room destroyed (last participant left)");
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
        Ok(
            participant.update_track_subscription(stream_id, track_id, |subscription| {
                subscription.viewport = viewport.clone();
                if active_layer.is_some() {
                    subscription.active_layer = active_layer;
                } else if resolved_active_layer.is_some() {
                    subscription.active_layer = resolved_active_layer;
                }
            }),
        )
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
                hardware_accelerated: true,
            }],
        )
        .unwrap();

        let room = mgr.get_room(&room_id).unwrap();
        let participant = room.participants.get(&1).unwrap();
        assert_eq!(participant.session_id, "native-1b");
        assert_eq!(participant.video_capabilities.len(), 1);
        assert_eq!(participant.video_capabilities[0].codec, VideoCodec::H264);
        assert!(participant.video_capabilities[0].hardware_accelerated);
    }
}
