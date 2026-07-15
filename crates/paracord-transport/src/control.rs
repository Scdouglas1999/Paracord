//! Control stream message types sent over QUIC bidirectional streams.
//!
//! Wire format: 4-byte big-endian length prefix + JSON payload.

use bytes::{Buf, BufMut, Bytes, BytesMut};
use serde::{Deserialize, Serialize};

use crate::protocol::TrackType;
use crate::stream::{
    PublishedTrack, StreamId, TrackId, TrackSubscription, VideoCodec, VideoCodecCapability,
    ViewportHint,
};

/// Serializable track type for control messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Audio,
    Video,
}

impl From<TrackType> for TrackKind {
    fn from(t: TrackType) -> Self {
        match t {
            TrackType::Audio => TrackKind::Audio,
            TrackType::Video => TrackKind::Video,
        }
    }
}

impl From<TrackKind> for TrackType {
    fn from(k: TrackKind) -> Self {
        match k {
            TrackKind::Audio => TrackType::Audio,
            TrackKind::Video => TrackType::Video,
        }
    }
}

/// Session-level participant identity announced over the stream control plane.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionParticipant {
    pub user_id: i64,
    pub session_id: String,
    #[serde(default)]
    pub video_capabilities: Vec<VideoCodecCapability>,
}

/// Control messages exchanged over QUIC bidirectional streams.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlMessage {
    /// Client authenticates with a JWT token.
    Auth { token: String },

    /// Subscribe to a user's media track.
    Subscribe { user_id: i64, track_type: TrackKind },

    /// Unsubscribe from a user's media track.
    Unsubscribe { user_id: i64, track_type: TrackKind },

    /// Client joins a specific stream-capable media session.
    SessionJoin {
        room_id: String,
        session_id: String,
        #[serde(default)]
        video_capabilities: Vec<VideoCodecCapability>,
    },

    /// Client leaves a specific stream-capable media session.
    SessionLeave { room_id: String, session_id: String },

    /// Snapshot of currently connected media participants in the room.
    SessionState {
        participants: Vec<SessionParticipant>,
    },

    /// One participant joined the active media session.
    SessionParticipantJoin { participant: SessionParticipant },

    /// One participant left the active media session.
    SessionParticipantLeave { user_id: i64 },

    /// Publisher announces a track and its currently available layers.
    TrackPublish { track: PublishedTrack },

    /// Publisher removes a previously announced track.
    TrackUnpublish {
        stream_id: StreamId,
        track_id: TrackId,
    },

    /// Viewer subscribes to a specific published track.
    SubscribeStream { subscription: TrackSubscription },

    /// Viewer unsubscribes from a specific published track.
    UnsubscribeStream {
        stream_id: StreamId,
        track_id: TrackId,
    },

    /// Server confirmation that a viewer's subscription to a track changed.
    /// `active` is `true` after a successful subscribe, `false` after an
    /// unsubscribe. `layer_id` reports the simulcast layer the relay will
    /// forward (when known) and is absent for audio-only or unsubscribe acks.
    SubscriptionAck {
        stream_id: StreamId,
        track_id: TrackId,
        #[serde(skip_serializing_if = "Option::is_none")]
        layer_id: Option<u8>,
        active: bool,
    },

    /// Publisher refreshes layer state without fully unpublishing the track.
    TrackLayers {
        stream_id: StreamId,
        track_id: TrackId,
        layers: Vec<crate::stream::PublishedLayer>,
    },

    /// Announce a new encryption key epoch.
    /// `encrypted_keys` maps (recipient_user_id, ciphertext).
    KeyAnnounce {
        epoch: u8,
        encrypted_keys: Vec<(i64, Vec<u8>)>,
    },

    /// Deliver an encryption key to a subscriber.
    KeyDeliver {
        sender_user_id: i64,
        epoch: u8,
        ciphertext: Vec<u8>,
    },

    /// Announce sender-key state for one published track.
    StreamKeyAnnounce {
        stream_id: StreamId,
        track_id: TrackId,
        codec: Option<VideoCodec>,
        epoch: u8,
        encrypted_keys: Vec<(i64, Vec<u8>)>,
    },

    /// Deliver an announced sender key to one participant.
    StreamKeyDeliver {
        stream_id: StreamId,
        track_id: TrackId,
        sender_user_id: i64,
        epoch: u8,
        ciphertext: Vec<u8>,
    },

    /// Request that the publisher send a sender key for one published track
    /// to a specific recipient.
    RequestStreamKey {
        stream_id: StreamId,
        track_id: TrackId,
        recipient_user_id: i64,
    },

    /// Bandwidth feedback from the server or peer.
    BandwidthFeedback { available_kbps: u32 },

    /// Viewer's current receive conditions for one subscribed track.
    ReceiverReport {
        stream_id: StreamId,
        track_id: TrackId,
        #[serde(skip_serializing_if = "Option::is_none")]
        active_layer: Option<u8>,
        #[serde(skip_serializing_if = "Option::is_none")]
        viewport: Option<ViewportHint>,
        estimated_bitrate_kbps: u32,
        packet_loss_ppm: u32,
    },

    /// Request an immediate keyframe for one published track.
    RequestKeyframe {
        stream_id: StreamId,
        track_id: TrackId,
        #[serde(skip_serializing_if = "Option::is_none")]
        layer_id: Option<u8>,
    },

    /// Keepalive ping.
    Ping,

    /// Keepalive pong.
    Pong,

    // ── File transfer messages ───────────────────────────────────────────
    /// Client initiates a file upload on a dedicated bidi stream.
    FileTransferInit {
        transfer_id: String,
        upload_token: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        resume_offset: Option<u64>,
    },

    /// Server accepts the upload (confirms chunk size and resume offset).
    FileTransferAccept {
        transfer_id: String,
        chunk_size: u32,
        #[serde(default)]
        offset: u64,
    },

    /// Server rejects the upload.
    FileTransferReject { transfer_id: String, reason: String },

    /// Client requests a file download.
    FileDownloadRequest {
        attachment_id: String,
        auth_token: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        range_start: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        range_end: Option<u64>,
    },

    /// Server accepts the download request.
    FileDownloadAccept {
        attachment_id: String,
        filename: String,
        size: u64,
        content_type: String,
        offset: u64,
    },

    /// Progress acknowledgement from server (sent every ~1MB).
    FileTransferProgress {
        transfer_id: String,
        bytes_received: u64,
    },

    /// Transfer completed successfully.
    FileTransferDone {
        transfer_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        attachment_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },

    /// Transfer error.
    FileTransferError {
        transfer_id: String,
        code: u32,
        message: String,
    },

    /// Cancel transfer (either side).
    FileTransferCancel { transfer_id: String },
}

/// Maximum control message size (256 KiB).
pub const MAX_MESSAGE_SIZE: u32 = 256 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ControlError {
    #[error("message too large: {size} bytes (max {MAX_MESSAGE_SIZE})")]
    MessageTooLarge { size: u32 },
    #[error("incomplete frame: need {needed} more bytes")]
    IncompleteFrame { needed: usize },
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl ControlMessage {
    /// Encode a control message into a length-prefixed frame.
    pub fn encode(&self) -> Result<Bytes, ControlError> {
        let json = serde_json::to_vec(self)?;
        let len = json.len() as u32;
        if len > MAX_MESSAGE_SIZE {
            return Err(ControlError::MessageTooLarge { size: len });
        }
        let mut buf = BytesMut::with_capacity(4 + json.len());
        buf.put_u32(len);
        buf.put_slice(&json);
        Ok(buf.freeze())
    }

    /// Try to decode a control message from a buffer.
    ///
    /// Returns `Ok(Some((message, consumed)))` if a complete frame was decoded,
    /// `Ok(None)` if more data is needed, or `Err` on protocol/parse errors.
    pub fn decode(buf: &[u8]) -> Result<Option<(Self, usize)>, ControlError> {
        if buf.len() < 4 {
            return Ok(None);
        }
        let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        if len as u32 > MAX_MESSAGE_SIZE {
            return Err(ControlError::MessageTooLarge { size: len as u32 });
        }
        let total = 4 + len;
        if buf.len() < total {
            return Ok(None);
        }
        let msg: ControlMessage = serde_json::from_slice(&buf[4..total])?;
        Ok(Some((msg, total)))
    }
}

/// Codec for reading/writing length-prefixed control messages on a stream.
pub struct ControlCodec {
    read_buf: BytesMut,
}

impl ControlCodec {
    pub fn new() -> Self {
        Self {
            read_buf: BytesMut::with_capacity(4096),
        }
    }

    /// Feed incoming bytes into the codec buffer.
    pub fn feed(&mut self, data: &[u8]) {
        self.read_buf.extend_from_slice(data);
    }

    /// Try to decode the next message from the buffer.
    pub fn decode_next(&mut self) -> Result<Option<ControlMessage>, ControlError> {
        match ControlMessage::decode(&self.read_buf)? {
            Some((msg, consumed)) => {
                self.read_buf.advance(consumed);
                Ok(Some(msg))
            }
            None => Ok(None),
        }
    }
}

impl Default for ControlCodec {
    fn default() -> Self {
        Self::new()
    }
}

// ── Stream frame codec for file transfer ─────────────────────────────────

/// Frame types on a file-transfer bidirectional stream.
///
/// A 1-byte discriminator distinguishes control JSON from raw data:
///   0x00 → Control message (JSON): [4B length][JSON]
///   0x01 → File data chunk: [4B length][raw bytes]
///   0x02 → End of data (no payload)
#[derive(Debug, Clone, PartialEq)]
pub enum StreamFrame {
    /// A JSON control message.
    Control(ControlMessage),
    /// Raw file data chunk.
    Data(Bytes),
    /// Signals the end of file data.
    EndOfData,
}

const FRAME_TYPE_CONTROL: u8 = 0x00;
const FRAME_TYPE_DATA: u8 = 0x01;
const FRAME_TYPE_END: u8 = 0x02;

/// Maximum data chunk size (512 KiB).
const MAX_DATA_CHUNK_SIZE: u32 = 512 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum StreamFrameError {
    #[error("unknown frame type: 0x{0:02x}")]
    UnknownFrameType(u8),
    #[error("data chunk too large: {size} bytes (max {MAX_DATA_CHUNK_SIZE})")]
    ChunkTooLarge { size: u32 },
    #[error("control error: {0}")]
    Control(#[from] ControlError),
    #[error("incomplete frame")]
    Incomplete,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl StreamFrame {
    /// Encode a stream frame into bytes with the discriminator prefix.
    pub fn encode(&self) -> Result<Bytes, StreamFrameError> {
        match self {
            StreamFrame::Control(msg) => {
                let json = serde_json::to_vec(msg).map_err(ControlError::Json)?;
                let len = json.len() as u32;
                if len > MAX_MESSAGE_SIZE {
                    return Err(StreamFrameError::Control(ControlError::MessageTooLarge {
                        size: len,
                    }));
                }
                let mut buf = BytesMut::with_capacity(1 + 4 + json.len());
                buf.put_u8(FRAME_TYPE_CONTROL);
                buf.put_u32(len);
                buf.put_slice(&json);
                Ok(buf.freeze())
            }
            StreamFrame::Data(data) => {
                let len = data.len() as u32;
                if len > MAX_DATA_CHUNK_SIZE {
                    return Err(StreamFrameError::ChunkTooLarge { size: len });
                }
                let mut buf = BytesMut::with_capacity(1 + 4 + data.len());
                buf.put_u8(FRAME_TYPE_DATA);
                buf.put_u32(len);
                buf.put_slice(data);
                Ok(buf.freeze())
            }
            StreamFrame::EndOfData => {
                let mut buf = BytesMut::with_capacity(1);
                buf.put_u8(FRAME_TYPE_END);
                Ok(buf.freeze())
            }
        }
    }

    /// Try to decode a stream frame from a buffer.
    ///
    /// Returns `Ok(Some((frame, consumed)))` on success,
    /// `Ok(None)` if more data is needed.
    pub fn decode(buf: &[u8]) -> Result<Option<(Self, usize)>, StreamFrameError> {
        if buf.is_empty() {
            return Ok(None);
        }
        match buf[0] {
            FRAME_TYPE_CONTROL => {
                if buf.len() < 5 {
                    return Ok(None);
                }
                let len = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]) as usize;
                if len as u32 > MAX_MESSAGE_SIZE {
                    return Err(StreamFrameError::Control(ControlError::MessageTooLarge {
                        size: len as u32,
                    }));
                }
                let total = 1 + 4 + len;
                if buf.len() < total {
                    return Ok(None);
                }
                let msg: ControlMessage =
                    serde_json::from_slice(&buf[5..total]).map_err(ControlError::Json)?;
                Ok(Some((StreamFrame::Control(msg), total)))
            }
            FRAME_TYPE_DATA => {
                if buf.len() < 5 {
                    return Ok(None);
                }
                let len = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]) as usize;
                if len as u32 > MAX_DATA_CHUNK_SIZE {
                    return Err(StreamFrameError::ChunkTooLarge { size: len as u32 });
                }
                let total = 1 + 4 + len;
                if buf.len() < total {
                    return Ok(None);
                }
                let data = Bytes::copy_from_slice(&buf[5..total]);
                Ok(Some((StreamFrame::Data(data), total)))
            }
            FRAME_TYPE_END => Ok(Some((StreamFrame::EndOfData, 1))),
            other => Err(StreamFrameError::UnknownFrameType(other)),
        }
    }
}

/// Codec for reading/writing stream frames on a bidirectional stream.
pub struct StreamFrameCodec {
    read_buf: BytesMut,
}

impl StreamFrameCodec {
    pub fn new() -> Self {
        Self {
            read_buf: BytesMut::with_capacity(8192),
        }
    }

    /// Feed incoming bytes into the codec buffer.
    pub fn feed(&mut self, data: &[u8]) {
        self.read_buf.extend_from_slice(data);
    }

    /// Try to decode the next frame from the buffer.
    pub fn decode_next(&mut self) -> Result<Option<StreamFrame>, StreamFrameError> {
        match StreamFrame::decode(&self.read_buf)? {
            Some((frame, consumed)) => {
                self.read_buf.advance(consumed);
                Ok(Some(frame))
            }
            None => Ok(None),
        }
    }
}

impl Default for StreamFrameCodec {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stream::VideoCodecCapability;

    #[test]
    fn auth_round_trip() {
        let msg = ControlMessage::Auth {
            token: "eyJhbGciOiJIUzI1NiJ9.test.sig".to_string(),
        };
        let encoded = msg.encode().unwrap();
        let (decoded, consumed) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(consumed, encoded.len());
        assert_eq!(msg, decoded);
    }

    #[test]
    fn subscribe_round_trip() {
        let msg = ControlMessage::Subscribe {
            user_id: 123456789,
            track_type: TrackKind::Audio,
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn unsubscribe_round_trip() {
        let msg = ControlMessage::Unsubscribe {
            user_id: 987654321,
            track_type: TrackKind::Video,
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn session_join_round_trip() {
        let msg = ControlMessage::SessionJoin {
            room_id: "1:2".to_string(),
            session_id: "browser-42".to_string(),
            video_capabilities: vec![],
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn session_state_round_trip() {
        let msg = ControlMessage::SessionState {
            participants: vec![
                SessionParticipant {
                    user_id: 42,
                    session_id: "native-42".to_string(),
                    video_capabilities: vec![],
                },
                SessionParticipant {
                    user_id: 99,
                    session_id: "browser-99".to_string(),
                    video_capabilities: vec![],
                },
            ],
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn session_participant_join_round_trip() {
        let msg = ControlMessage::SessionParticipantJoin {
            participant: SessionParticipant {
                user_id: 77,
                session_id: "native-77".to_string(),
                video_capabilities: vec![],
            },
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn session_join_round_trip_with_video_capabilities() {
        let msg = ControlMessage::SessionJoin {
            room_id: "1:2".to_string(),
            session_id: "native-42".to_string(),
            video_capabilities: vec![VideoCodecCapability {
                codec: VideoCodec::H264,
                encode: true,
                decode: true,
                encode_hardware: true,
                decode_hardware: true,
            }],
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn session_state_round_trip_with_video_capabilities() {
        let msg = ControlMessage::SessionState {
            participants: vec![SessionParticipant {
                user_id: 42,
                session_id: "native-42".to_string(),
                video_capabilities: vec![VideoCodecCapability {
                    codec: VideoCodec::Av1,
                    encode: false,
                    decode: true,
                    encode_hardware: false,
                    decode_hardware: true,
                }],
            }],
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn session_participant_leave_round_trip() {
        let msg = ControlMessage::SessionParticipantLeave { user_id: 77 };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn track_publish_round_trip() {
        let msg = ControlMessage::TrackPublish {
            track: PublishedTrack {
                stream_id: StreamId::new("stream-1"),
                track_id: TrackId::new("screen"),
                publisher_user_id: 42,
                kind: TrackKind::Video,
                codec: Some(VideoCodec::H264),
                layers: vec![crate::stream::PublishedLayer {
                    layer_id: 0,
                    ssrc: 101,
                    width: Some(1280),
                    height: Some(720),
                    max_bitrate_kbps: Some(2500),
                    active: true,
                }],
            },
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn subscribe_stream_round_trip() {
        let msg = ControlMessage::SubscribeStream {
            subscription: TrackSubscription {
                stream_id: StreamId::new("stream-1"),
                track_id: TrackId::new("screen"),
                requested_layer: Some(1),
                active_layer: None,
                viewport: Some(ViewportHint {
                    width: 1280,
                    height: 720,
                }),
            },
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn subscription_ack_round_trip() {
        for (layer_id, active) in [(Some(2u8), true), (None, false)] {
            let msg = ControlMessage::SubscriptionAck {
                stream_id: StreamId::new("stream-1"),
                track_id: TrackId::new("screen"),
                layer_id,
                active,
            };
            let encoded = msg.encode().unwrap();
            let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
            assert_eq!(msg, decoded);
        }
    }

    #[test]
    fn request_keyframe_round_trip() {
        let msg = ControlMessage::RequestKeyframe {
            stream_id: StreamId::new("stream-1"),
            track_id: TrackId::new("screen"),
            layer_id: Some(2),
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn request_stream_key_round_trip() {
        let msg = ControlMessage::RequestStreamKey {
            stream_id: StreamId::new("stream-1"),
            track_id: TrackId::new("screen"),
            recipient_user_id: 42,
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn key_announce_round_trip() {
        let msg = ControlMessage::KeyAnnounce {
            epoch: 5,
            encrypted_keys: vec![(100, vec![0xDE, 0xAD]), (200, vec![0xBE, 0xEF])],
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn key_deliver_round_trip() {
        let msg = ControlMessage::KeyDeliver {
            sender_user_id: 42,
            epoch: 3,
            ciphertext: vec![1, 2, 3, 4, 5],
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn bandwidth_feedback_round_trip() {
        let msg = ControlMessage::BandwidthFeedback {
            available_kbps: 2500,
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn ping_pong_round_trip() {
        for msg in [ControlMessage::Ping, ControlMessage::Pong] {
            let encoded = msg.encode().unwrap();
            let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
            assert_eq!(msg, decoded);
        }
    }

    #[test]
    fn incomplete_frame_returns_none() {
        let msg = ControlMessage::Ping;
        let encoded = msg.encode().unwrap();
        // Feed only partial data
        assert!(ControlMessage::decode(&encoded[..2]).unwrap().is_none());
        assert!(ControlMessage::decode(&encoded[..4]).unwrap().is_none());
    }

    #[test]
    fn codec_incremental_feed() {
        let msg1 = ControlMessage::Ping;
        let msg2 = ControlMessage::Pong;
        let e1 = msg1.encode().unwrap();
        let e2 = msg2.encode().unwrap();

        let mut codec = ControlCodec::new();

        // Feed first message in two parts
        codec.feed(&e1[..3]);
        assert!(codec.decode_next().unwrap().is_none());
        codec.feed(&e1[3..]);
        assert_eq!(codec.decode_next().unwrap().unwrap(), msg1);

        // Feed second message all at once
        codec.feed(&e2);
        assert_eq!(codec.decode_next().unwrap().unwrap(), msg2);

        // No more messages
        assert!(codec.decode_next().unwrap().is_none());
    }

    #[test]
    fn track_kind_converts_to_track_type() {
        assert_eq!(TrackType::from(TrackKind::Audio), TrackType::Audio);
        assert_eq!(TrackType::from(TrackKind::Video), TrackType::Video);
        assert_eq!(TrackKind::from(TrackType::Audio), TrackKind::Audio);
        assert_eq!(TrackKind::from(TrackType::Video), TrackKind::Video);
    }

    // ── File transfer ControlMessage round-trip tests ────────────────────

    #[test]
    fn file_transfer_init_round_trip() {
        let msg = ControlMessage::FileTransferInit {
            transfer_id: "xfer-001".into(),
            upload_token: "tok.abc.def".into(),
            resume_offset: Some(4096),
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn file_transfer_init_no_resume_round_trip() {
        let msg = ControlMessage::FileTransferInit {
            transfer_id: "xfer-002".into(),
            upload_token: "tok.xyz".into(),
            resume_offset: None,
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn file_transfer_accept_round_trip() {
        let msg = ControlMessage::FileTransferAccept {
            transfer_id: "xfer-001".into(),
            chunk_size: 262144,
            offset: 4096,
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn file_transfer_reject_round_trip() {
        let msg = ControlMessage::FileTransferReject {
            transfer_id: "xfer-001".into(),
            reason: "file too large".into(),
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn file_download_request_round_trip() {
        let msg = ControlMessage::FileDownloadRequest {
            attachment_id: "att-123".into(),
            auth_token: "bearer-tok".into(),
            range_start: Some(1024),
            range_end: Some(8192),
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn file_download_accept_round_trip() {
        let msg = ControlMessage::FileDownloadAccept {
            attachment_id: "att-123".into(),
            filename: "photo.png".into(),
            size: 4096000,
            content_type: "image/png".into(),
            offset: 0,
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn file_transfer_progress_round_trip() {
        let msg = ControlMessage::FileTransferProgress {
            transfer_id: "xfer-001".into(),
            bytes_received: 1048576,
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn file_transfer_done_round_trip() {
        let msg = ControlMessage::FileTransferDone {
            transfer_id: "xfer-001".into(),
            attachment_id: Some("att-456".into()),
            url: Some("/files/att-456".into()),
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn file_transfer_done_minimal_round_trip() {
        let msg = ControlMessage::FileTransferDone {
            transfer_id: "xfer-002".into(),
            attachment_id: None,
            url: None,
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn file_transfer_error_round_trip() {
        let msg = ControlMessage::FileTransferError {
            transfer_id: "xfer-001".into(),
            code: 413,
            message: "payload too large".into(),
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn file_transfer_cancel_round_trip() {
        let msg = ControlMessage::FileTransferCancel {
            transfer_id: "xfer-001".into(),
        };
        let encoded = msg.encode().unwrap();
        let (decoded, _) = ControlMessage::decode(&encoded).unwrap().unwrap();
        assert_eq!(msg, decoded);
    }

    // ── StreamFrame codec tests ──────────────────────────────────────────

    #[test]
    fn stream_frame_control_round_trip() {
        let msg = ControlMessage::FileTransferProgress {
            transfer_id: "xfer-001".into(),
            bytes_received: 2048,
        };
        let frame = StreamFrame::Control(msg.clone());
        let encoded = frame.encode().unwrap();
        let (decoded, consumed) = StreamFrame::decode(&encoded).unwrap().unwrap();
        assert_eq!(consumed, encoded.len());
        assert_eq!(decoded, StreamFrame::Control(msg));
    }

    #[test]
    fn stream_frame_data_round_trip() {
        let data = Bytes::from(vec![0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE]);
        let frame = StreamFrame::Data(data.clone());
        let encoded = frame.encode().unwrap();
        let (decoded, consumed) = StreamFrame::decode(&encoded).unwrap().unwrap();
        assert_eq!(consumed, encoded.len());
        assert_eq!(decoded, StreamFrame::Data(data));
    }

    #[test]
    fn stream_frame_end_of_data_round_trip() {
        let frame = StreamFrame::EndOfData;
        let encoded = frame.encode().unwrap();
        assert_eq!(encoded.len(), 1);
        let (decoded, consumed) = StreamFrame::decode(&encoded).unwrap().unwrap();
        assert_eq!(consumed, 1);
        assert_eq!(decoded, StreamFrame::EndOfData);
    }

    #[test]
    fn stream_frame_codec_incremental_feed() {
        let frame1 = StreamFrame::Data(Bytes::from(vec![1, 2, 3]));
        let frame2 = StreamFrame::Control(ControlMessage::Ping);
        let frame3 = StreamFrame::EndOfData;

        let e1 = frame1.encode().unwrap();
        let e2 = frame2.encode().unwrap();
        let e3 = frame3.encode().unwrap();

        let mut codec = StreamFrameCodec::new();

        // Feed frame1 in two parts
        let split = e1.len() / 2;
        codec.feed(&e1[..split]);
        assert!(codec.decode_next().unwrap().is_none());
        codec.feed(&e1[split..]);
        assert_eq!(codec.decode_next().unwrap().unwrap(), frame1);

        // Feed frames 2 and 3 together
        codec.feed(&e2);
        codec.feed(&e3);
        assert_eq!(codec.decode_next().unwrap().unwrap(), frame2);
        assert_eq!(codec.decode_next().unwrap().unwrap(), frame3);

        // No more frames
        assert!(codec.decode_next().unwrap().is_none());
    }

    #[test]
    fn stream_frame_unknown_type_error() {
        let buf = [0xFF, 0x00, 0x00, 0x00, 0x01, 0x00];
        let result = StreamFrame::decode(&buf);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(matches!(err, StreamFrameError::UnknownFrameType(0xFF)));
    }

    #[test]
    fn stream_frame_data_too_large_error() {
        // Craft a frame header claiming 1 MiB data (exceeds MAX_DATA_CHUNK_SIZE)
        let size: u32 = 1024 * 1024;
        let mut buf = vec![FRAME_TYPE_DATA];
        buf.extend_from_slice(&size.to_be_bytes());
        buf.extend_from_slice(&vec![0u8; size as usize]);
        let result = StreamFrame::decode(&buf);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            StreamFrameError::ChunkTooLarge { .. }
        ));
    }

    #[test]
    fn stream_frame_incomplete_returns_none() {
        // Empty buffer
        assert!(StreamFrame::decode(&[]).unwrap().is_none());

        // Just a discriminator byte with no length for data
        assert!(StreamFrame::decode(&[FRAME_TYPE_DATA]).unwrap().is_none());

        // Control frame with partial length
        assert!(StreamFrame::decode(&[FRAME_TYPE_CONTROL, 0x00, 0x00])
            .unwrap()
            .is_none());
    }
}
