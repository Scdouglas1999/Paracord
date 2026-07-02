use std::collections::HashMap;

use paracord_transport::stream::{PublishedTrack, StreamId, TrackId, TrackSubscription};

#[derive(Debug, Default, Clone)]
pub struct StreamRegistry {
    published_tracks: HashMap<(StreamId, TrackId), PublishedTrack>,
    subscriptions: HashMap<(StreamId, TrackId), TrackSubscription>,
    delivered_track_keys: HashMap<(StreamId, TrackId, u8), [u8; 16]>,
}

impl StreamRegistry {
    pub fn publish_track(&mut self, track: PublishedTrack) {
        self.published_tracks
            .insert((track.stream_id.clone(), track.track_id.clone()), track);
    }

    pub fn unpublish_track(&mut self, stream_id: &StreamId, track_id: &TrackId) {
        self.published_tracks
            .remove(&(stream_id.clone(), track_id.clone()));
        self.subscriptions
            .remove(&(stream_id.clone(), track_id.clone()));
        self.delivered_track_keys
            .retain(|(stored_stream_id, stored_track_id, _), _| {
                stored_stream_id != stream_id || stored_track_id != track_id
            });
    }

    pub fn subscribe(&mut self, subscription: TrackSubscription) {
        self.subscriptions.insert(
            (
                subscription.stream_id.clone(),
                subscription.track_id.clone(),
            ),
            subscription,
        );
    }

    pub fn unsubscribe(&mut self, stream_id: &StreamId, track_id: &TrackId) {
        self.subscriptions
            .remove(&(stream_id.clone(), track_id.clone()));
    }

    pub fn get_published_track(
        &self,
        stream_id: &StreamId,
        track_id: &TrackId,
    ) -> Option<PublishedTrack> {
        self.published_tracks
            .get(&(stream_id.clone(), track_id.clone()))
            .cloned()
    }

    pub fn store_delivered_track_key(
        &mut self,
        stream_id: &StreamId,
        track_id: &TrackId,
        epoch: u8,
        key: [u8; 16],
    ) {
        self.delivered_track_keys
            .insert((stream_id.clone(), track_id.clone(), epoch), key);
    }

    pub fn delivered_track_keys_for_track(
        &self,
        stream_id: &StreamId,
        track_id: &TrackId,
    ) -> Vec<(u8, [u8; 16])> {
        self.delivered_track_keys
            .iter()
            .filter_map(|((stored_stream_id, stored_track_id, epoch), key)| {
                if stored_stream_id == stream_id && stored_track_id == track_id {
                    Some((*epoch, *key))
                } else {
                    None
                }
            })
            .collect()
    }

    pub fn published_tracks(&self) -> Vec<PublishedTrack> {
        self.published_tracks.values().cloned().collect()
    }

    pub fn subscriptions(&self) -> Vec<TrackSubscription> {
        self.subscriptions.values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use paracord_transport::control::TrackKind;
    use paracord_transport::stream::{PublishedLayer, VideoCodec};

    #[test]
    fn registry_tracks_publish_and_subscribe() {
        let mut registry = StreamRegistry::default();
        let track = PublishedTrack {
            stream_id: StreamId::new("stream-1"),
            track_id: TrackId::new("screen"),
            publisher_user_id: 42,
            kind: TrackKind::Video,
            codec: Some(VideoCodec::H264),
            layers: vec![PublishedLayer {
                layer_id: 0,
                ssrc: 200,
                width: Some(1280),
                height: Some(720),
                max_bitrate_kbps: Some(2500),
                active: true,
            }],
        };
        registry.publish_track(track.clone());
        registry.subscribe(TrackSubscription {
            stream_id: track.stream_id.clone(),
            track_id: track.track_id.clone(),
            requested_layer: Some(0),
            active_layer: Some(0),
            viewport: None,
        });

        assert_eq!(registry.published_tracks().len(), 1);
        assert_eq!(registry.subscriptions().len(), 1);

        registry.unpublish_track(&track.stream_id, &track.track_id);
        assert!(registry.published_tracks().is_empty());
        assert!(registry.subscriptions().is_empty());
    }
}
