use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;

use serde::{Deserialize, Serialize};

use paracord_transport::connection::MediaViewClaim;
use paracord_transport::control::TrackKind;
use paracord_transport::stream::{
    PublishedTrack, StreamId, TrackId, TrackSubscription, VideoCodecCapability,
};

/// The kind of a view session (see [`ViewTarget`]).
pub type ViewKind = MediaViewClaim;

/// Suffix of the stream id every client gives its screen share
/// (`stream:{id}:screen`, carrying the `screen` video track and, when shared,
/// the `screen-audio` track). A camera is `stream:{id}:camera`.
pub const SCREEN_STREAM_SUFFIX: &str = ":screen";

/// What a view session may receive: one publisher's screen share.
///
/// A view session is a receive-only room member that is *not* a call member:
/// it has no voice state, is not in the call roster, never publishes, and
/// receives nothing but the tracks of the stream it watches.
///
/// - `Watch`: the stream's video and its own audio (`screen-audio`), never the
///   voices. Counted as watching.
/// - `Ambient`: the stream's video only, pinned to its lowest simulcast layer
///   and delivered as keyframes at a capped rate. Not counted, not shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ViewTarget {
    pub kind: ViewKind,
    pub publisher_user_id: i64,
}

impl ViewTarget {
    /// Whether a track, identified by its ids and publisher, belongs to the
    /// watched stream. `kind` is checked when known: an ambient view never
    /// receives audio.
    pub fn allows(
        &self,
        publisher_user_id: i64,
        stream_id: &StreamId,
        kind: Option<TrackKind>,
    ) -> bool {
        if publisher_user_id != self.publisher_user_id
            || !stream_id.0.ends_with(SCREEN_STREAM_SUFFIX)
        {
            return false;
        }
        match self.kind {
            ViewKind::Watch => true,
            ViewKind::Ambient => !matches!(kind, Some(TrackKind::Audio)),
        }
    }

    /// [`Self::allows`] for a published track.
    pub fn allows_track(&self, track: &PublishedTrack) -> bool {
        self.allows(track.publisher_user_id, &track.stream_id, Some(track.kind))
    }

    pub fn is_ambient(&self) -> bool {
        matches!(self.kind, ViewKind::Ambient)
    }

    /// The publisher this view counts as watching, if it counts at all.
    pub fn counted_publisher(&self) -> Option<i64> {
        matches!(self.kind, ViewKind::Watch).then_some(self.publisher_user_id)
    }
}

/// Largest number of distinct `(stream_id, track_id)` announcements one
/// participant may have live at once.
///
/// A client publishes at most a handful (microphone, camera, screen, screen
/// audio); the identifiers are attacker-chosen strings, so without a cap a
/// single participant can grow this map — and every structure the relay derives
/// from it — without bound.
const MAX_PUBLISHED_TRACKS_PER_PARTICIPANT: usize = 16;

/// Number of key epochs retained per `(track, recipient)` in
/// [`MediaParticipant::published_track_keys`]. Only the newest is ever read
/// back; the extras cover a rotation that is still in flight.
const MAX_RETAINED_KEY_EPOCHS: usize = 4;

/// Largest number of explicit track subscriptions one participant may hold.
/// Bounded for the same reason as [`MAX_PUBLISHED_TRACKS_PER_PARTICIPANT`]: the
/// `(stream_id, track_id)` key comes straight off the wire.
const MAX_TRACK_SUBSCRIPTIONS_PER_PARTICIPANT: usize = 256;

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
    /// Whether the participant is authorized to publish media (derived from the
    /// SPEAK permission at join time). When `false`, the participant joins as a
    /// listen-only subscriber and any published-track announcements are ignored.
    pub can_publish: bool,
    /// The participant's publicly reachable address (for P2P).
    pub public_addr: Option<SocketAddr>,
    /// `Some` when this member is a view session rather than a call member.
    pub view: Option<ViewTarget>,
    /// For a call member: the publisher whose stream it is watching through
    /// its call (counted as watching). Always `None` for a view session, whose
    /// target is in `view`.
    pub watching: Option<i64>,
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
            can_publish: true,
            public_addr: None,
            view: None,
            watching: None,
        }
    }

    /// A view session: receive-only, subscribed to nobody's audio, and limited
    /// by the relay to the tracks `target` allows.
    pub fn viewer(user_id: i64, session_id: String, target: ViewTarget) -> Self {
        Self {
            can_publish: false,
            view: Some(target),
            ..Self::new(user_id, session_id)
        }
    }

    pub fn is_viewer(&self) -> bool {
        self.view.is_some()
    }

    pub fn is_ambient_viewer(&self) -> bool {
        self.view.is_some_and(|view| view.is_ambient())
    }

    /// The publisher this member counts as watching: a watch view's target, or
    /// the stream a call member watches through its call.
    pub fn watched_publisher(&self) -> Option<i64> {
        match self.view {
            Some(view) => view.counted_publisher(),
            None => self.watching,
        }
    }

    /// Set whether this participant may publish media (SPEAK). Chainable so the
    /// join site can express the authorization inline with construction.
    pub fn with_can_publish(mut self, can_publish: bool) -> Self {
        self.can_publish = can_publish;
        self
    }

    pub fn set_video_capabilities(&mut self, capabilities: Vec<VideoCodecCapability>) {
        self.video_capabilities = capabilities;
    }

    /// Subscribe to another user's media. A view session never takes the
    /// voices, so it holds no participant-level subscription at all.
    pub fn subscribe(&mut self, user_id: i64) {
        if self.is_viewer() {
            return;
        }
        self.subscriptions.insert(user_id);
    }

    /// Unsubscribe from another user's media.
    pub fn unsubscribe(&mut self, user_id: i64) {
        self.subscriptions.remove(&user_id);
    }

    /// Subscribe to all other participants' media given a list of user IDs.
    pub fn subscribe_all(&mut self, user_ids: &[i64]) {
        if self.is_viewer() {
            return;
        }
        for &uid in user_ids {
            if uid != self.user_id {
                self.subscriptions.insert(uid);
            }
        }
    }

    /// Publish or update a stream-aware track announcement.
    ///
    /// A participant lacking publish rights (SPEAK denied) is not allowed to
    /// announce tracks: video/screen-share fan-out in the relay requires a
    /// resolved published track, so dropping the announcement here fails the
    /// publish closed without needing to trust the client.
    pub fn publish_track(&mut self, track: PublishedTrack) {
        if !self.can_publish {
            return;
        }
        let key = (track.stream_id.clone(), track.track_id.clone());
        // `(stream_id, track_id)` is entirely attacker-chosen, so an *update* to
        // an existing track is always allowed but a *new* track is refused once
        // this participant is at the cap. Otherwise one client could mint
        // unbounded track entries (each of which the relay clones into every
        // recipient snapshot rebuild and re-broadcasts to the room).
        if !self.published_tracks.contains_key(&key)
            && self.published_tracks.len() >= MAX_PUBLISHED_TRACKS_PER_PARTICIPANT
        {
            tracing::warn!(
                user_id = self.user_id,
                stream_id = %key.0 .0,
                track_id = %key.1 .0,
                "participant at published-track cap; ignoring announcement"
            );
            return;
        }
        self.published_tracks.insert(key, track);
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

    /// Forget every stored key addressed to `recipient_user_id`.
    ///
    /// A wrapped track key is sealed to the call key the recipient held when it
    /// was announced. When that participant rejoins it mints a new one, and
    /// every stored envelope becomes an envelope nobody can open — replaying it
    /// would hand the rejoiner a key exchange it can only fail. Dropping them
    /// makes the relay ask the publisher for a fresh one instead.
    pub fn forget_track_keys_for_recipient(&mut self, recipient_user_id: i64) {
        self.published_track_keys
            .retain(|(_, _, _, stored_recipient), _| *stored_recipient != recipient_user_id);
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

        // Only the newest epochs are ever read back
        // (`latest_track_key_for_recipient` takes the max epoch), but the key
        // includes a caller-supplied `epoch`, so re-announcing across all 256
        // epoch values would otherwise pin 256 ciphertexts per
        // (track, recipient) forever. Keep a small rotation window so a key
        // rotation in flight is still resolvable, and drop the rest.
        let mut epochs: Vec<u8> = self
            .published_track_keys
            .keys()
            .filter(|(s, t, _, r)| s == stream_id && t == track_id && *r == recipient_user_id)
            .map(|(_, _, e, _)| *e)
            .collect();
        if epochs.len() > MAX_RETAINED_KEY_EPOCHS {
            epochs.sort_unstable();
            let drop_below = epochs[epochs.len() - MAX_RETAINED_KEY_EPOCHS];
            self.published_track_keys.retain(|(s, t, e, r), _| {
                !(s == stream_id && t == track_id && *r == recipient_user_id && *e < drop_below)
            });
        }
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
        let key = (
            subscription.stream_id.clone(),
            subscription.track_id.clone(),
        );
        // Updates to an existing subscription always apply; a *new* key is
        // refused at the cap. See MAX_TRACK_SUBSCRIPTIONS_PER_PARTICIPANT.
        if !self.track_subscriptions.contains_key(&key)
            && self.track_subscriptions.len() >= MAX_TRACK_SUBSCRIPTIONS_PER_PARTICIPANT
        {
            tracing::warn!(
                user_id = self.user_id,
                stream_id = %key.0 .0,
                track_id = %key.1 .0,
                "participant at track-subscription cap; ignoring subscription"
            );
            return;
        }
        self.track_subscriptions.insert(key, subscription);
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
    fn listen_only_participant_cannot_publish_tracks() {
        // SPEAK denied at join → can_publish=false → track announcements dropped.
        let mut p = MediaParticipant::new(1, "s".to_string()).with_can_publish(false);
        assert!(!p.can_publish);
        let track = PublishedTrack {
            stream_id: StreamId::new("stream-1"),
            track_id: TrackId::new("screen"),
            publisher_user_id: 1,
            kind: paracord_transport::control::TrackKind::Video,
            codec: Some(paracord_transport::stream::VideoCodec::H264),
            layers: vec![],
        };
        p.publish_track(track);
        assert!(p.published_tracks.is_empty());
    }

    fn screen_track(publisher: i64, track_id: &str, kind: TrackKind) -> PublishedTrack {
        PublishedTrack {
            stream_id: StreamId::new(format!("stream:{publisher}:screen")),
            track_id: TrackId::new(track_id),
            publisher_user_id: publisher,
            kind,
            codec: None,
            layers: vec![],
        }
    }

    #[test]
    fn a_viewer_is_receive_only_and_takes_no_voices() {
        let target = ViewTarget {
            kind: ViewKind::Watch,
            publisher_user_id: 7,
        };
        let mut viewer = MediaParticipant::viewer(1, "view-1".into(), target);
        assert!(!viewer.can_publish);
        assert!(viewer.is_viewer());
        viewer.subscribe(7);
        viewer.subscribe_all(&[2, 3, 7]);
        assert!(
            viewer.subscriptions.is_empty(),
            "a viewer never takes voices"
        );
        viewer.publish_track(screen_track(1, "screen", TrackKind::Video));
        assert!(viewer.published_tracks.is_empty());
        assert_eq!(viewer.watched_publisher(), Some(7));
    }

    #[test]
    fn view_targets_allow_only_the_watched_stream() {
        let watch = ViewTarget {
            kind: ViewKind::Watch,
            publisher_user_id: 7,
        };
        let ambient = ViewTarget {
            kind: ViewKind::Ambient,
            publisher_user_id: 7,
        };
        let screen = screen_track(7, "screen", TrackKind::Video);
        let screen_audio = screen_track(7, "screen-audio", TrackKind::Audio);
        let camera = PublishedTrack {
            stream_id: StreamId::new("stream:7:camera"),
            ..screen.clone()
        };
        let someone_else = screen_track(8, "screen", TrackKind::Video);

        assert!(watch.allows_track(&screen));
        assert!(watch.allows_track(&screen_audio));
        assert!(!watch.allows_track(&camera));
        assert!(!watch.allows_track(&someone_else));

        assert!(ambient.allows_track(&screen));
        assert!(
            !ambient.allows_track(&screen_audio),
            "ambient is video only"
        );
        assert!(!ambient.allows_track(&camera));

        assert_eq!(watch.counted_publisher(), Some(7));
        assert_eq!(
            ambient.counted_publisher(),
            None,
            "ambient is never counted"
        );
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
