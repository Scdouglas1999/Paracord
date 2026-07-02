use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;

use serde::{Deserialize, Serialize};

use paracord_transport::stream::{
    PublishedTrack, StreamId, TrackId, TrackSubscription, VideoCodecCapability,
};

/// How this participant is connected to the media server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConnectionType {
    /// Media flows through the relay server.
    ServerRelay,
    /// Media flows directly between peers.
    P2P,
}

/// A participant in a media room with connection and subscription state.
#[derive(Debug, Clone)]
pub struct MediaParticipant {
    /// The user's unique ID.
    pub user_id: i64,
    /// Unique session identifier for this connection.
    pub session_id: String,
    /// How this participant is connected.
    pub connection_type: ConnectionType,
    /// Set of user_ids whose media this participant receives.
    pub subscriptions: HashSet<i64>,
    /// Published tracks currently announced by this participant.
    pub published_tracks: HashMap<(StreamId, TrackId), PublishedTrack>,
    /// Latest delivered sender-key payloads per published track/epoch/recipient.
    pub published_track_keys: HashMap<(StreamId, TrackId, u8, i64), Vec<u8>>,
    /// Explicit track subscriptions for stream-aware video delivery.
    pub track_subscriptions: HashMap<(StreamId, TrackId), TrackSubscription>,
    /// Session-level negotiated video codec support for this participant.
    pub video_capabilities: Vec<VideoCodecCapability>,
    /// Whether the participant has muted themselves.
    pub muted: bool,
    /// Whether the participant has deafened themselves.
    pub deafened: bool,
    /// The participant's publicly reachable address (for P2P).
    pub public_addr: Option<SocketAddr>,
}

impl MediaParticipant {
    pub fn new(user_id: i64, session_id: String) -> Self {
        Self {
            user_id,
            session_id,
            connection_type: ConnectionType::ServerRelay,
            subscriptions: HashSet::new(),
            published_tracks: HashMap::new(),
            published_track_keys: HashMap::new(),
            track_subscriptions: HashMap::new(),
            video_capabilities: Vec::new(),
            muted: false,
            deafened: false,
            public_addr: None,
        }
    }

    pub fn set_video_capabilities(&mut self, capabilities: Vec<VideoCodecCapability>) {
        self.video_capabilities = capabilities;
    }

    /// Subscribe to another user's media.
    pub fn subscribe(&mut self, user_id: i64) {
        self.subscriptions.insert(user_id);
    }

    /// Unsubscribe from another user's media.
    pub fn unsubscribe(&mut self, user_id: i64) {
        self.subscriptions.remove(&user_id);
    }

    /// Subscribe to all other participants' media given a list of user IDs.
    pub fn subscribe_all(&mut self, user_ids: &[i64]) {
        for &uid in user_ids {
            if uid != self.user_id {
                self.subscriptions.insert(uid);
            }
        }
    }

    /// Publish or update a stream-aware track announcement.
    pub fn publish_track(&mut self, track: PublishedTrack) {
        self.published_tracks
            .insert((track.stream_id.clone(), track.track_id.clone()), track);
    }

    /// Remove a previously published stream-aware track.
    pub fn unpublish_track(&mut self, stream_id: &StreamId, track_id: &TrackId) {
        self.published_tracks
            .remove(&(stream_id.clone(), track_id.clone()));
        self.published_track_keys
            .retain(|(stored_stream_id, stored_track_id, _, _), _| {
                stored_stream_id != stream_id || stored_track_id != track_id
            });
    }

    pub fn store_track_key(
        &mut self,
        stream_id: &StreamId,
        track_id: &TrackId,
        epoch: u8,
        recipient_user_id: i64,
        ciphertext: Vec<u8>,
    ) {
        self.published_track_keys.insert(
            (
                stream_id.clone(),
                track_id.clone(),
                epoch,
                recipient_user_id,
            ),
            ciphertext,
        );
    }

    pub fn latest_track_key_for_recipient(
        &self,
        stream_id: &StreamId,
        track_id: &TrackId,
        recipient_user_id: i64,
    ) -> Option<(u8, Vec<u8>)> {
        self.published_track_keys
            .iter()
            .filter_map(
                |((stored_stream_id, stored_track_id, epoch, stored_recipient), ciphertext)| {
                    if stored_stream_id == stream_id
                        && stored_track_id == track_id
                        && *stored_recipient == recipient_user_id
                    {
                        Some((*epoch, ciphertext.clone()))
                    } else {
                        None
                    }
                },
            )
            .max_by_key(|(epoch, _)| *epoch)
    }

    /// Subscribe to a specific stream-aware track.
    pub fn subscribe_track(&mut self, subscription: TrackSubscription) {
        self.track_subscriptions.insert(
            (
                subscription.stream_id.clone(),
                subscription.track_id.clone(),
            ),
            subscription,
        );
    }

    /// Remove a specific stream-aware track subscription.
    pub fn unsubscribe_track(&mut self, stream_id: &StreamId, track_id: &TrackId) {
        self.track_subscriptions
            .remove(&(stream_id.clone(), track_id.clone()));
    }

    pub fn update_track_subscription(
        &mut self,
        stream_id: &StreamId,
        track_id: &TrackId,
        mut update: impl FnMut(&mut TrackSubscription),
    ) -> bool {
        if let Some(subscription) = self
            .track_subscriptions
            .get_mut(&(stream_id.clone(), track_id.clone()))
        {
            update(subscription);
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_participant_defaults() {
        let p = MediaParticipant::new(42, "sess-1".to_string());
        assert_eq!(p.user_id, 42);
        assert_eq!(p.session_id, "sess-1");
        assert_eq!(p.connection_type, ConnectionType::ServerRelay);
        assert!(p.subscriptions.is_empty());
        assert!(p.published_tracks.is_empty());
        assert!(p.published_track_keys.is_empty());
        assert!(p.track_subscriptions.is_empty());
        assert!(!p.muted);
        assert!(!p.deafened);
        assert!(p.public_addr.is_none());
    }

    #[test]
    fn subscribe_unsubscribe() {
        let mut p = MediaParticipant::new(1, "s".to_string());
        p.subscribe(2);
        p.subscribe(3);
        assert!(p.subscriptions.contains(&2));
        assert!(p.subscriptions.contains(&3));

        p.unsubscribe(2);
        assert!(!p.subscriptions.contains(&2));
        assert!(p.subscriptions.contains(&3));
    }

    #[test]
    fn subscribe_all_excludes_self() {
        let mut p = MediaParticipant::new(1, "s".to_string());
        p.subscribe_all(&[1, 2, 3, 4]);
        assert!(!p.subscriptions.contains(&1));
        assert!(p.subscriptions.contains(&2));
        assert!(p.subscriptions.contains(&3));
        assert!(p.subscriptions.contains(&4));
    }

    #[test]
    fn publish_and_subscribe_track() {
        let mut p = MediaParticipant::new(1, "s".to_string());
        let track = PublishedTrack {
            stream_id: StreamId::new("stream-1"),
            track_id: TrackId::new("screen"),
            publisher_user_id: 1,
            kind: paracord_transport::control::TrackKind::Video,
            codec: Some(paracord_transport::stream::VideoCodec::H264),
            layers: vec![],
        };
        p.publish_track(track.clone());
        assert_eq!(p.published_tracks.len(), 1);

        let subscription = TrackSubscription {
            stream_id: StreamId::new("stream-1"),
            track_id: TrackId::new("screen"),
            requested_layer: Some(0),
            active_layer: None,
            viewport: None,
        };
        p.subscribe_track(subscription.clone());
        assert_eq!(p.track_subscriptions.len(), 1);

        p.unpublish_track(&track.stream_id, &track.track_id);
        p.unsubscribe_track(&subscription.stream_id, &subscription.track_id);
        assert!(p.published_tracks.is_empty());
        assert!(p.published_track_keys.is_empty());
        assert!(p.track_subscriptions.is_empty());
    }

    #[test]
    fn update_track_subscription_mutates_existing_state() {
        let mut p = MediaParticipant::new(1, "s".to_string());
        let subscription = TrackSubscription {
            stream_id: StreamId::new("stream-1"),
            track_id: TrackId::new("screen"),
            requested_layer: Some(0),
            active_layer: None,
            viewport: None,
        };
        p.subscribe_track(subscription.clone());

        let updated =
            p.update_track_subscription(&subscription.stream_id, &subscription.track_id, |sub| {
                sub.active_layer = Some(2);
            });

        assert!(updated);
        assert_eq!(
            p.track_subscriptions
                .get(&(
                    subscription.stream_id.clone(),
                    subscription.track_id.clone()
                ))
                .and_then(|sub| sub.active_layer),
            Some(2)
        );
    }

    #[test]
    fn stores_latest_track_key_per_recipient() {
        let mut p = MediaParticipant::new(1, "s".to_string());
        let stream_id = StreamId::new("stream-1");
        let track_id = TrackId::new("screen");

        p.store_track_key(&stream_id, &track_id, 1, 2, vec![1; 16]);
        p.store_track_key(&stream_id, &track_id, 3, 2, vec![3; 16]);
        p.store_track_key(&stream_id, &track_id, 2, 3, vec![2; 16]);

        let latest = p
            .latest_track_key_for_recipient(&stream_id, &track_id, 2)
            .expect("latest track key");
        assert_eq!(latest.0, 3);
        assert_eq!(latest.1, vec![3; 16]);
    }

    #[test]
    fn preserves_wrapped_track_key_payloads_verbatim() {
        let mut p = MediaParticipant::new(1, "s".to_string());
        let stream_id = StreamId::new("stream-1");
        let track_id = TrackId::new("screen");
        let wrapped_payload = b"{\"v\":1,\"nonce\":\"abc\",\"ciphertext\":\"def\"}".to_vec();

        p.store_track_key(&stream_id, &track_id, 4, 2, wrapped_payload.clone());

        let latest = p
            .latest_track_key_for_recipient(&stream_id, &track_id, 2)
            .expect("latest wrapped track key");
        assert_eq!(latest.0, 4);
        assert_eq!(latest.1, wrapped_payload);
    }
}
