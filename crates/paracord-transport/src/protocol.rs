use bytes::{Buf, BufMut, Bytes, BytesMut};
use std::fmt;

use crate::stream::{StreamId, TrackId, VideoCodec};

/// Media packet track type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum TrackType {
    Audio = 0,
    Video = 1,
}

impl TryFrom<u8> for TrackType {
    type Error = ProtocolError;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(TrackType::Audio),
            1 => Ok(TrackType::Video),
            _ => Err(ProtocolError::InvalidTrackType(value)),
        }
    }
}

/// 16-byte media packet header.
///
/// ```text
/// Byte 0:     [V:1][T:1][R:2][SimLyr:4]
/// Bytes 1-2:  Sequence number (u16)
/// Bytes 3-6:  Timestamp (u32, 48kHz audio / 90kHz video)
/// Bytes 7-10: SSRC (u32)
/// Byte 11:    Audio level (u8, dBov 0-127, 127=silence)
/// Byte 12:    Key epoch (u8)
/// Bytes 13-14: Payload length (u16)
/// Byte 15:    Codec id (0 = unspecified / non-video)
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MediaHeader {
    pub version: u8,
    pub track_type: TrackType,
    pub simulcast_layer: u8,
    pub sequence: u16,
    pub timestamp: u32,
    pub ssrc: u32,
    pub audio_level: u8,
    pub key_epoch: u8,
    pub payload_length: u16,
    pub codec: u8,
}

pub const HEADER_SIZE: usize = 16;
pub const PROTOCOL_VERSION: u8 = 1;

/// Rich metadata that can be embedded ahead of a fragmented video access unit.
///
/// This lives above [`MediaHeader`] and provides stable stream/track/frame
/// identity so the relay and receivers do not need to infer publication state
/// from SSRC alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoFrameMetadata {
    pub stream_id: StreamId,
    pub track_id: TrackId,
    pub frame_id: u64,
    pub layer_id: u8,
    pub codec: VideoCodec,
    pub timestamp_us: u64,
    pub is_keyframe: bool,
    pub fragment_index: u16,
    pub fragment_count: u16,
}

impl VideoFrameMetadata {
    pub fn encode(&self, buf: &mut BytesMut) -> Result<(), ProtocolError> {
        let stream_bytes = self.stream_id.0.as_bytes();
        let track_bytes = self.track_id.0.as_bytes();
        let stream_len = u8::try_from(stream_bytes.len())
            .map_err(|_| ProtocolError::IdentifierTooLong("stream_id"))?;
        let track_len = u8::try_from(track_bytes.len())
            .map_err(|_| ProtocolError::IdentifierTooLong("track_id"))?;

        buf.put_u8(stream_len);
        buf.put_slice(stream_bytes);
        buf.put_u8(track_len);
        buf.put_slice(track_bytes);
        buf.put_u64(self.frame_id);
        buf.put_u8(self.layer_id);
        buf.put_u8(self.codec.header_id());
        buf.put_u64(self.timestamp_us);
        buf.put_u8(u8::from(self.is_keyframe));
        buf.put_u16(self.fragment_index);
        buf.put_u16(self.fragment_count);
        Ok(())
    }

    pub fn decode(buf: &mut impl Buf) -> Result<Self, ProtocolError> {
        if buf.remaining() < 1 {
            return Err(ProtocolError::BufferTooShort {
                expected: 1,
                actual: buf.remaining(),
            });
        }
        let stream_len = buf.get_u8() as usize;
        if buf.remaining() < stream_len + 1 {
            return Err(ProtocolError::BufferTooShort {
                expected: stream_len + 1,
                actual: buf.remaining(),
            });
        }
        let stream_id = String::from_utf8(buf.copy_to_bytes(stream_len).to_vec())
            .map_err(|_| ProtocolError::InvalidIdentifier("stream_id"))?;
        let track_len = buf.get_u8() as usize;
        if buf.remaining() < track_len + 22 {
            return Err(ProtocolError::BufferTooShort {
                expected: track_len + 22,
                actual: buf.remaining(),
            });
        }
        let track_id = String::from_utf8(buf.copy_to_bytes(track_len).to_vec())
            .map_err(|_| ProtocolError::InvalidIdentifier("track_id"))?;
        let frame_id = buf.get_u64();
        let layer_id = buf.get_u8();
        let codec =
            VideoCodec::from_header_id(buf.get_u8()).ok_or(ProtocolError::InvalidCodecId)?;
        let timestamp_us = buf.get_u64();
        let is_keyframe = buf.get_u8() != 0;
        let fragment_index = buf.get_u16();
        let fragment_count = buf.get_u16();

        Ok(Self {
            stream_id: StreamId::new(stream_id),
            track_id: TrackId::new(track_id),
            frame_id,
            layer_id,
            codec,
            timestamp_us,
            is_keyframe,
            fragment_index,
            fragment_count,
        })
    }
}

/// Upper bound on a single stream-delivered video frame message.
///
/// The uni-stream keyframe path carries one whole (encrypted) frame per message.
/// At the highest screen-share preset a keyframe is a few megabytes; this cap
/// bounds a single length-delimited read so a malformed or hostile stream cannot
/// force an unbounded allocation on the relay or a receiver.
pub const MAX_STREAM_FRAME_SIZE: usize = 16 * 1024 * 1024;

/// A whole video frame delivered on a QUIC unidirectional stream — the
/// loss-resilient path for keyframes and any frame too large to survive as
/// hundreds of all-or-nothing datagram fragments.
///
/// One whole frame is carried per uni stream: the stream's FIN delimits the
/// message, so the reader drains the stream to end and parses exactly one frame.
/// The wire layout is:
///
/// ```text
/// [16-byte MediaHeader]   // cleartext; the relay routes on `ssrc` exactly like a datagram
/// [VideoFrameMetadata]    // cleartext; stream/track/frame identity + is_keyframe
/// [payload...]            // AES-GCM ciphertext of the WHOLE frame (one AEAD unit)
/// ```
///
/// The payload is encrypted as a single AEAD unit with the 16-byte MediaHeader
/// as AAD — the same key/nonce scheme as the datagram path, differing only in
/// that the frame is not fragmented. The receiver distinguishes this whole-frame
/// format from the datagram fragment format by which transport it arrived on
/// (uni stream vs datagram), so no separate format tag is needed on the wire.
///
/// The relay forwards this message byte-for-byte without decrypting it: it reads
/// the cleartext [`MediaHeader`] for routing and re-emits the identical bytes to
/// each subscriber on a fresh uni stream (same opaque-ciphertext fan-out as the
/// datagram path).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaStreamFrame {
    pub header: MediaHeader,
    pub metadata: VideoFrameMetadata,
    pub payload: Bytes,
}

impl MediaStreamFrame {
    /// Serialize to the wire layout: header + metadata + ciphertext payload.
    pub fn encode(&self) -> Result<Bytes, ProtocolError> {
        let mut buf = BytesMut::with_capacity(HEADER_SIZE + 64 + self.payload.len());
        self.header.encode(&mut buf);
        self.metadata.encode(&mut buf)?;
        buf.extend_from_slice(&self.payload);
        Ok(buf.freeze())
    }

    /// Parse a whole-frame stream message from a complete message body.
    ///
    /// The caller is responsible for having read exactly one message (the whole
    /// uni stream up to FIN); everything after the header + metadata is treated
    /// as the encrypted payload.
    pub fn decode(buf: &[u8]) -> Result<Self, ProtocolError> {
        let mut cursor = buf;
        let header = MediaHeader::decode(&mut cursor)?;
        let metadata = VideoFrameMetadata::decode(&mut cursor)?;
        let payload = Bytes::copy_from_slice(cursor);
        Ok(Self {
            header,
            metadata,
            payload,
        })
    }
}

impl MediaHeader {
    pub fn new(track_type: TrackType, ssrc: u32) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            track_type,
            simulcast_layer: 0,
            sequence: 0,
            timestamp: 0,
            ssrc,
            audio_level: 127, // silence
            key_epoch: 0,
            payload_length: 0,
            codec: 0,
        }
    }

    /// Serialize header to 16 bytes.
    pub fn encode(&self, buf: &mut BytesMut) {
        // Byte 0: [V:1][T:1][R:2][SimLyr:4]
        let byte0 = ((self.version & 0x01) << 7)
            | (((self.track_type as u8) & 0x01) << 6)
            | (self.simulcast_layer & 0x0F);
        buf.put_u8(byte0);
        buf.put_u16(self.sequence);
        buf.put_u32(self.timestamp);
        buf.put_u32(self.ssrc);
        buf.put_u8(self.audio_level);
        buf.put_u8(self.key_epoch);
        buf.put_u16(self.payload_length);
        buf.put_u8(self.codec);
    }

    /// Deserialize header from bytes.
    pub fn decode(buf: &mut impl Buf) -> Result<Self, ProtocolError> {
        if buf.remaining() < HEADER_SIZE {
            return Err(ProtocolError::BufferTooShort {
                expected: HEADER_SIZE,
                actual: buf.remaining(),
            });
        }

        let byte0 = buf.get_u8();
        let version = (byte0 >> 7) & 0x01;
        let track_type = TrackType::try_from((byte0 >> 6) & 0x01)?;
        let simulcast_layer = byte0 & 0x0F;
        let sequence = buf.get_u16();
        let timestamp = buf.get_u32();
        let ssrc = buf.get_u32();
        let audio_level = buf.get_u8();
        let key_epoch = buf.get_u8();
        let payload_length = buf.get_u16();
        let codec = buf.get_u8();

        Ok(Self {
            version,
            track_type,
            simulcast_layer,
            sequence,
            timestamp,
            ssrc,
            audio_level,
            key_epoch,
            payload_length,
            codec,
        })
    }

    /// Encode header into a new Bytes.
    pub fn to_bytes(&self) -> Bytes {
        let mut buf = BytesMut::with_capacity(HEADER_SIZE);
        self.encode(&mut buf);
        buf.freeze()
    }
}

impl fmt::Display for MediaHeader {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "MediaHeader(v={}, {:?}, layer={}, seq={}, ts={}, ssrc={:#x}, level={}, epoch={}, len={}, codec={})",
            self.version, self.track_type, self.simulcast_layer,
            self.sequence, self.timestamp, self.ssrc,
            self.audio_level, self.key_epoch, self.payload_length, self.codec
        )
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("buffer too short: expected {expected}, got {actual}")]
    BufferTooShort { expected: usize, actual: usize },
    #[error("invalid track type: {0}")]
    InvalidTrackType(u8),
    #[error("unsupported protocol version: {0}")]
    UnsupportedVersion(u8),
    #[error("identifier too long: {0}")]
    IdentifierTooLong(&'static str),
    #[error("invalid identifier bytes: {0}")]
    InvalidIdentifier(&'static str),
    #[error("invalid codec id in video frame metadata")]
    InvalidCodecId,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_round_trip() {
        let header = MediaHeader {
            version: 1,
            track_type: TrackType::Audio,
            simulcast_layer: 0,
            sequence: 1234,
            timestamp: 567890,
            ssrc: 0xDEADBEEF,
            audio_level: 42,
            key_epoch: 3,
            payload_length: 960,
            codec: 0,
        };

        let bytes = header.to_bytes();
        assert_eq!(bytes.len(), HEADER_SIZE);

        let decoded = MediaHeader::decode(&mut bytes.as_ref()).unwrap();
        assert_eq!(header, decoded);
    }

    #[test]
    fn header_video_simulcast() {
        let header = MediaHeader {
            version: 1,
            track_type: TrackType::Video,
            simulcast_layer: 2,
            sequence: 100,
            timestamp: 9000,
            ssrc: 0x12345678,
            audio_level: 127,
            key_epoch: 1,
            payload_length: 4096,
            codec: 1,
        };

        let bytes = header.to_bytes();
        let decoded = MediaHeader::decode(&mut bytes.as_ref()).unwrap();
        assert_eq!(header, decoded);
    }

    #[test]
    fn buffer_too_short() {
        let buf = vec![0u8; 8];
        let result = MediaHeader::decode(&mut buf.as_slice());
        assert!(matches!(result, Err(ProtocolError::BufferTooShort { .. })));
    }

    #[test]
    fn video_frame_metadata_round_trip() {
        let metadata = VideoFrameMetadata {
            stream_id: StreamId::new("stream-1"),
            track_id: TrackId::new("screen"),
            frame_id: 77,
            layer_id: 2,
            codec: VideoCodec::H264,
            timestamp_us: 123_456,
            is_keyframe: true,
            fragment_index: 0,
            fragment_count: 3,
        };

        let mut buf = BytesMut::new();
        metadata.encode(&mut buf).unwrap();
        let decoded = VideoFrameMetadata::decode(&mut buf.freeze()).unwrap();
        assert_eq!(metadata, decoded);
    }

    #[test]
    fn media_stream_frame_round_trip() {
        let header = MediaHeader {
            version: 1,
            track_type: TrackType::Video,
            simulcast_layer: 1,
            sequence: 9001,
            timestamp: 4242,
            ssrc: 0x0BADF00D,
            audio_level: 127,
            key_epoch: 5,
            payload_length: 0,
            codec: VideoCodec::Vp9.header_id(),
        };
        let metadata = VideoFrameMetadata {
            stream_id: StreamId::new("stream-42"),
            track_id: TrackId::new("screen"),
            frame_id: 12_345,
            layer_id: 1,
            codec: VideoCodec::Vp9,
            timestamp_us: 987_654,
            is_keyframe: true,
            fragment_index: 0,
            fragment_count: 1,
        };
        // A payload longer than u16::MAX proves the whole-frame path is not bound
        // by the 16-bit header payload_length field (it is length-delimited by the
        // uni stream itself).
        let payload = Bytes::from(vec![0xABu8; 70_000]);
        let frame = MediaStreamFrame {
            header,
            metadata,
            payload: payload.clone(),
        };

        let encoded = frame.encode().unwrap();
        let decoded = MediaStreamFrame::decode(&encoded).unwrap();
        assert_eq!(decoded.header, header);
        assert_eq!(decoded.metadata, frame.metadata);
        assert_eq!(decoded.payload, payload);

        // The relay routes on the cleartext header alone; it must be parseable
        // from the front of the message without touching the payload.
        let routed = MediaHeader::decode(&mut &encoded[..HEADER_SIZE]).unwrap();
        assert_eq!(routed.ssrc, header.ssrc);
        assert_eq!(routed.track_type, TrackType::Video);
    }
}
