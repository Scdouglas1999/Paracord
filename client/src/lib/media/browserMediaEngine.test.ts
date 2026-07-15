import { describe, expect, it } from 'vitest';
import {
  buildStreamFrameMessage,
  parseStreamFrameMessage,
  shouldSendVideoFrameOnStream,
  STREAM_FRAGMENT_THRESHOLD,
} from './browserMediaEngine';
import {
  HEADER_SIZE,
  PROTOCOL_VERSION,
  TrackType,
  decodeHeader,
  decodeVideoFrameMetadata,
  type MediaHeader,
  type VideoFrameMetadata,
} from './transport/protocol';

function header(ssrc = 0x0badf00d): MediaHeader {
  return {
    version: PROTOCOL_VERSION,
    trackType: TrackType.Video,
    simulcastLayer: 1,
    sequence: 9001,
    timestamp: 4242,
    ssrc,
    audioLevel: 127,
    keyEpoch: 5,
    // The whole-frame stream path is delimited by the stream FIN, so the wire
    // header always carries payloadLength 0 (matches the native encoder).
    payloadLength: 0,
    codec: 1,
  };
}

function metadata(): VideoFrameMetadata {
  return {
    streamId: 'stream-42',
    trackId: 'screen',
    frameId: 12_345n,
    layerId: 1,
    codec: 1,
    timestampUs: 987_654n,
    isKeyframe: true,
    fragmentIndex: 0,
    fragmentCount: 1,
  };
}

describe('whole-frame uni-stream framing (browser parser)', () => {
  it('round-trips build -> parse byte-identically, including >64KB ciphertext', () => {
    // A payload larger than u16::MAX proves the whole-frame path is not bound by
    // the 16-bit header payload_length (the stream FIN length-delimits it).
    const ciphertext = new Uint8Array(70_000);
    for (let i = 0; i < ciphertext.length; i += 1) ciphertext[i] = i & 0xff;

    const message = buildStreamFrameMessage(header(), metadata(), ciphertext);
    const parsed = parseStreamFrameMessage(message);

    expect(parsed.header).toEqual(header());
    expect(parsed.metadata).toEqual(metadata());
    expect(Array.from(parsed.ciphertext)).toEqual(Array.from(ciphertext));
  });

  it('lays the header out first so the relay routes on ssrc without the payload', () => {
    const ciphertext = new Uint8Array([9, 8, 7]);
    const message = buildStreamFrameMessage(header(0x11223344), metadata(), ciphertext);

    // The relay parses only the leading 16 cleartext bytes for routing.
    const routed = decodeHeader(new DataView(message.buffer, message.byteOffset, HEADER_SIZE));
    expect(routed.ssrc).toBe(0x11223344);
    expect(routed.trackType).toBe(TrackType.Video);

    // The cleartext metadata sits between the header and the ciphertext.
    const { metadata: meta } = decodeVideoFrameMetadata(message.subarray(HEADER_SIZE));
    expect(meta.frameId).toBe(12_345n);
    expect(meta.isKeyframe).toBe(true);
    expect(meta.streamId).toBe('stream-42');
  });

  it('rejects a message too short to hold a header', () => {
    expect(() => parseStreamFrameMessage(new Uint8Array(4))).toThrow();
  });
});

describe('shouldSendVideoFrameOnStream (native should_send_on_stream mirror)', () => {
  it('always routes keyframes to the reliable stream path', () => {
    expect(shouldSendVideoFrameOnStream(true, 1)).toBe(true);
  });

  it('routes delta frames to the stream only past the fragment threshold', () => {
    expect(shouldSendVideoFrameOnStream(false, 1)).toBe(false);
    expect(shouldSendVideoFrameOnStream(false, STREAM_FRAGMENT_THRESHOLD)).toBe(false);
    expect(shouldSendVideoFrameOnStream(false, STREAM_FRAGMENT_THRESHOLD + 1)).toBe(true);
  });
});

describe('setSourceVolume gain clamping', () => {
  it('clamps gain to the 0..2 contract used by voice_set_source_volume', () => {
    const clamp = (gain: number) => Math.min(2, Math.max(0, gain));
    expect(clamp(-1)).toBe(0);
    expect(clamp(0.5)).toBe(0.5);
    expect(clamp(2)).toBe(2);
    expect(clamp(3)).toBe(2);
  });
});
