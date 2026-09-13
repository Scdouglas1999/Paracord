import { describe, expect, it } from 'vitest';
import {
  createPacket,
  decodeHeader,
  HEADER_SIZE,
  headerAad,
  parsePacket,
  PROTOCOL_VERSION,
  TrackType,
  type MediaHeader,
} from './protocol';

function header(): MediaHeader {
  return {
    version: PROTOCOL_VERSION,
    trackType: TrackType.Audio,
    simulcastLayer: 0,
    sequence: 7,
    timestamp: 1_234,
    ssrc: 0xdeadbeef,
    audioLevel: 42,
    keyEpoch: 3,
    payloadLength: 0,
    codec: 0,
  };
}

describe('headerAad', () => {
  it('ignores the length a sender could not have signed', () => {
    // A sender seals the frame before it knows how long the ciphertext is, so
    // the header it binds as AAD still has payloadLength 0 — and then the real
    // length is stamped onto the wire copy. A receiver that authenticated the
    // wire bytes verbatim was authenticating a header nobody had signed, and
    // rejected every datagram it was ever sent.
    const sealed = createPacket(header(), new Uint8Array(0)).slice(0, HEADER_SIZE);
    const wire = createPacket(header(), new Uint8Array(960)).slice(0, HEADER_SIZE);

    expect(Array.from(wire)).not.toEqual(Array.from(sealed));
    expect(Array.from(headerAad(wire))).toEqual(Array.from(headerAad(sealed)));
    expect(Array.from(headerAad(wire))).toEqual(Array.from(sealed));
  });

  it('still authenticates every other field', () => {
    const wire = createPacket(header(), new Uint8Array(48));
    for (const offset of [0, 1, 3, 7, 11, 12, 15]) {
      const tampered = wire.slice(0, HEADER_SIZE);
      tampered[offset] ^= 0xff;
      expect(
        Array.from(headerAad(tampered)),
        `byte ${offset} must stay inside the authenticated header`,
      ).not.toEqual(Array.from(headerAad(wire)));
    }
  });

  it('reads the same bytes the wire header decodes to', () => {
    const packet = createPacket(header(), new Uint8Array([1, 2, 3, 4]));
    const parsed = parsePacket(packet);
    expect(parsed.payload.byteLength).toBe(4);
    expect(decodeHeader(new DataView(packet.buffer, 0, HEADER_SIZE)).payloadLength).toBe(4);
    // The AAD copy is independent of the packet it came from.
    const aad = headerAad(packet);
    aad[0] = 0;
    expect(packet[0]).not.toBe(0);
  });
});
