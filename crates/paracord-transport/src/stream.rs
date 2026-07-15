use serde::{Deserialize, Serialize};

use crate::control::TrackKind;

/// Stable identifier for one published media stream.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct StreamId(pub String);

impl StreamId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
}

impl From<&str> for StreamId {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

impl From<String> for StreamId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

/// Stable identifier for one published media track within a stream.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TrackId(pub String);

impl TrackId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
}

impl From<&str> for TrackId {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

impl From<String> for TrackId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

/// Wire-level codec identity used by the media transport.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoCodec {
    Vp9,
    Av1,
    H264,
}

/// Advertised encode/decode support for a given video codec.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCodecCapability {
    pub codec: VideoCodec,
    #[serde(default)]
    pub encode: bool,
    #[serde(default)]
    pub decode: bool,
    /// Whether encoding for this codec is hardware-accelerated. Codec
    /// negotiation's hardware-first pass keys only on this flag.
    #[serde(default)]
    pub encode_hardware: bool,
    /// Whether decoding for this codec is hardware-accelerated. Webview-
    /// contributed decode support is unknown and therefore not hardware.
    #[serde(default)]
    pub decode_hardware: bool,
}

impl VideoCodec {
    pub fn header_id(self) -> u8 {
        match self {
            Self::Vp9 => 1,
            Self::Av1 => 2,
            Self::H264 => 3,
        }
    }

    pub fn from_header_id(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Vp9),
            2 => Some(Self::Av1),
            3 => Some(Self::H264),
            _ => None,
        }
    }
}

/// Advertised properties of one simulcast layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedLayer {
    pub layer_id: u8,
    pub ssrc: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_bitrate_kbps: Option<u32>,
    #[serde(default)]
    pub active: bool,
}

/// Descriptor for a published media track.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedTrack {
    pub stream_id: StreamId,
    pub track_id: TrackId,
    pub publisher_user_id: i64,
    pub kind: TrackKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec: Option<VideoCodec>,
    #[serde(default)]
    pub layers: Vec<PublishedLayer>,
}

/// Client hint used when selecting a simulcast layer for a viewer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewportHint {
    pub width: u32,
    pub height: u32,
}

/// Subscription state for a viewer receiving a published media track.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSubscription {
    pub stream_id: StreamId,
    pub track_id: TrackId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_layer: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_layer: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewport: Option<ViewportHint>,
}

impl TrackSubscription {
    pub fn resolved_layer_id(&self, track: &PublishedTrack) -> Option<u8> {
        if self.stream_id != track.stream_id || self.track_id != track.track_id {
            return None;
        }

        if let Some(layer_id) = self.active_layer.or(self.requested_layer) {
            return track
                .layers
                .iter()
                .any(|layer| layer.layer_id == layer_id)
                .then_some(layer_id);
        }

        if let Some(viewport) = &self.viewport {
            let mut sorted_layers = track.layers.clone();
            sorted_layers.sort_by_key(|layer| layer.layer_id);
            if let Some(layer) = sorted_layers.iter().find(|layer| {
                let width = u32::from(layer.width.unwrap_or(0));
                let height = u32::from(layer.height.unwrap_or(0));
                width >= viewport.width || height >= viewport.height
            }) {
                return Some(layer.layer_id);
            }
            return sorted_layers.last().map(|layer| layer.layer_id);
        }

        track
            .layers
            .iter()
            .find(|layer| layer.active)
            .or_else(|| track.layers.last())
            .map(|layer| layer.layer_id)
    }

    pub fn matches_layer_ssrc(&self, track: &PublishedTrack, ssrc: u32) -> bool {
        if self.stream_id != track.stream_id || self.track_id != track.track_id {
            return false;
        }

        match self.resolved_layer_id(track) {
            Some(layer_id) => track
                .layers
                .iter()
                .any(|layer| layer.layer_id == layer_id && layer.ssrc == ssrc),
            // The requested/active layer id is not published on this track (e.g.
            // a client asked for layer 2 but the ladder deduped to [0,1]). Do NOT
            // fan out EVERY layer's ssrc — that forwards all simulcast layers of
            // the track to this viewer at once, interleaving independent frame_id
            // streams into one decoder (corruption + constant keyframe requests)
            // and multiplying the downlink. Match only the lowest published layer
            // so the viewer still receives a single decodable bitstream.
            None => match track.layers.iter().map(|layer| layer.layer_id).min() {
                Some(lowest) => track
                    .layers
                    .iter()
                    .any(|layer| layer.layer_id == lowest && layer.ssrc == ssrc),
                None => false,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codec_header_round_trip() {
        for codec in [VideoCodec::Vp9, VideoCodec::Av1, VideoCodec::H264] {
            assert_eq!(VideoCodec::from_header_id(codec.header_id()), Some(codec));
        }
        assert_eq!(VideoCodec::from_header_id(0), None);
    }

    #[test]
    fn subscription_matches_active_layer_ssrc() {
        let track = PublishedTrack {
            stream_id: StreamId::new("stream-1"),
            track_id: TrackId::new("screen"),
            publisher_user_id: 7,
            kind: TrackKind::Video,
            codec: Some(VideoCodec::H264),
            layers: vec![
                PublishedLayer {
                    layer_id: 0,
                    ssrc: 100,
                    width: Some(640),
                    height: Some(360),
                    max_bitrate_kbps: Some(800),
                    active: true,
                },
                PublishedLayer {
                    layer_id: 1,
                    ssrc: 101,
                    width: Some(1280),
                    height: Some(720),
                    max_bitrate_kbps: Some(2500),
                    active: true,
                },
            ],
        };
        let subscription = TrackSubscription {
            stream_id: StreamId::new("stream-1"),
            track_id: TrackId::new("screen"),
            requested_layer: Some(1),
            active_layer: Some(1),
            viewport: None,
        };

        assert!(subscription.matches_layer_ssrc(&track, 101));
        assert!(!subscription.matches_layer_ssrc(&track, 100));
    }

    #[test]
    fn subscription_resolves_layer_from_viewport() {
        let track = PublishedTrack {
            stream_id: StreamId::new("stream-1"),
            track_id: TrackId::new("screen"),
            publisher_user_id: 7,
            kind: TrackKind::Video,
            codec: Some(VideoCodec::H264),
            layers: vec![
                PublishedLayer {
                    layer_id: 0,
                    ssrc: 100,
                    width: Some(320),
                    height: Some(180),
                    max_bitrate_kbps: Some(300),
                    active: false,
                },
                PublishedLayer {
                    layer_id: 1,
                    ssrc: 101,
                    width: Some(640),
                    height: Some(360),
                    max_bitrate_kbps: Some(1000),
                    active: false,
                },
                PublishedLayer {
                    layer_id: 2,
                    ssrc: 102,
                    width: Some(1280),
                    height: Some(720),
                    max_bitrate_kbps: Some(2500),
                    active: true,
                },
            ],
        };
        let subscription = TrackSubscription {
            stream_id: StreamId::new("stream-1"),
            track_id: TrackId::new("screen"),
            requested_layer: None,
            active_layer: None,
            viewport: Some(ViewportHint {
                width: 500,
                height: 300,
            }),
        };

        assert_eq!(subscription.resolved_layer_id(&track), Some(1));
        assert!(subscription.matches_layer_ssrc(&track, 101));
    }
}
