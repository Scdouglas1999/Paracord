// Packet header serialization (matches Rust paracord-transport::protocol).

export const HEADER_SIZE = 16;
export const PROTOCOL_VERSION = 1;

export const enum TrackType {
  Audio = 0,
  Video = 1,
}

export interface MediaHeader {
  version: number;
  trackType: TrackType;
  simulcastLayer: number;
  sequence: number;
  timestamp: number;
  ssrc: number;
  audioLevel: number;
  keyEpoch: number;
  payloadLength: number;
  codec: number;
}

/**
 * A video frame pulled from the native media engine over Tauri IPC.
 *
 * Native commands return a packed binary buffer (see `pulledVideoFrame.ts`).
 * The legacy JSON shape below remains for tests and backward compatibility.
 */
export interface PulledFrame {
  timestampUs: number;
  sequence: number;
  isKeyframe: boolean;
  codec: 'vp9' | 'av1' | 'h264' | string;
  dataBase64: string;
  format?: 'i420' | 'vp9' | 'h264';
  width?: number;
  height?: number;
}

export interface VideoFrameMetadata {
  streamId: string;
  trackId: string;
  frameId: bigint;
  layerId: number;
  codec: number;
  timestampUs: bigint;
  isKeyframe: boolean;
  fragmentIndex: number;
  fragmentCount: number;
}

export function encodeHeader(header: MediaHeader): DataView {
  const buf = new DataView(new ArrayBuffer(HEADER_SIZE));
  const byte0 =
    ((header.version & 0x01) << 7) |
    ((header.trackType & 0x01) << 6) |
    (header.simulcastLayer & 0x0f);
  buf.setUint8(0, byte0);
  buf.setUint16(1, header.sequence, false);
  buf.setUint32(3, header.timestamp, false);
  buf.setUint32(7, header.ssrc, false);
  buf.setUint8(11, header.audioLevel);
  buf.setUint8(12, header.keyEpoch);
  buf.setUint16(13, header.payloadLength, false);
  buf.setUint8(15, header.codec & 0xff);
  return buf;
}

export function decodeHeader(buf: DataView): MediaHeader {
  if (buf.byteLength < HEADER_SIZE) {
    throw new Error(
      `Buffer too short: expected ${HEADER_SIZE}, got ${buf.byteLength}`
    );
  }
  const byte0 = buf.getUint8(0);
  return {
    version: (byte0 >> 7) & 0x01,
    trackType: ((byte0 >> 6) & 0x01) as TrackType,
    simulcastLayer: byte0 & 0x0f,
    sequence: buf.getUint16(1, false),
    timestamp: buf.getUint32(3, false),
    ssrc: buf.getUint32(7, false),
    audioLevel: buf.getUint8(11),
    keyEpoch: buf.getUint8(12),
    payloadLength: buf.getUint16(13, false),
    codec: buf.getUint8(15),
  };
}

/** Create a complete media packet: 16-byte header + payload. */
export function createPacket(header: MediaHeader, payload: Uint8Array): Uint8Array {
  const headerView = encodeHeader({ ...header, payloadLength: payload.byteLength });
  const packet = new Uint8Array(HEADER_SIZE + payload.byteLength);
  packet.set(new Uint8Array(headerView.buffer), 0);
  packet.set(payload, HEADER_SIZE);
  return packet;
}

/** Parse a complete packet into header + payload. */
export function parsePacket(data: Uint8Array): { header: MediaHeader; payload: Uint8Array } {
  if (data.byteLength < HEADER_SIZE) {
    throw new Error(`Packet too short: expected at least ${HEADER_SIZE}, got ${data.byteLength}`);
  }
  const headerView = new DataView(data.buffer, data.byteOffset, HEADER_SIZE);
  const header = decodeHeader(headerView);
  const payload = data.slice(HEADER_SIZE, HEADER_SIZE + header.payloadLength);
  return { header, payload };
}

export function encodeVideoFrameMetadata(metadata: VideoFrameMetadata): Uint8Array {
  const encoder = new TextEncoder();
  const streamBytes = encoder.encode(metadata.streamId);
  const trackBytes = encoder.encode(metadata.trackId);
  if (streamBytes.byteLength > 0xff) {
    throw new Error('streamId too long');
  }
  if (trackBytes.byteLength > 0xff) {
    throw new Error('trackId too long');
  }
  const buf = new Uint8Array(1 + streamBytes.byteLength + 1 + trackBytes.byteLength + 8 + 1 + 1 + 8 + 1 + 2 + 2);
  const view = new DataView(buf.buffer);
  let offset = 0;
  view.setUint8(offset, streamBytes.byteLength);
  offset += 1;
  buf.set(streamBytes, offset);
  offset += streamBytes.byteLength;
  view.setUint8(offset, trackBytes.byteLength);
  offset += 1;
  buf.set(trackBytes, offset);
  offset += trackBytes.byteLength;
  view.setBigUint64(offset, metadata.frameId, false);
  offset += 8;
  view.setUint8(offset, metadata.layerId & 0xff);
  offset += 1;
  view.setUint8(offset, metadata.codec & 0xff);
  offset += 1;
  view.setBigUint64(offset, metadata.timestampUs, false);
  offset += 8;
  view.setUint8(offset, metadata.isKeyframe ? 1 : 0);
  offset += 1;
  view.setUint16(offset, metadata.fragmentIndex, false);
  offset += 2;
  view.setUint16(offset, metadata.fragmentCount, false);
  return buf;
}

export function decodeVideoFrameMetadata(
  data: Uint8Array,
): { metadata: VideoFrameMetadata; payloadOffset: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  if (data.byteLength < 1) {
    throw new Error('video metadata buffer too short');
  }
  const streamLen = view.getUint8(offset);
  offset += 1;
  if (data.byteLength < offset + streamLen + 1) {
    throw new Error('video metadata stream id truncated');
  }
  const decoder = new TextDecoder();
  const streamId = decoder.decode(data.slice(offset, offset + streamLen));
  offset += streamLen;
  const trackLen = view.getUint8(offset);
  offset += 1;
  if (data.byteLength < offset + trackLen + 22) {
    throw new Error('video metadata track id truncated');
  }
  const trackId = decoder.decode(data.slice(offset, offset + trackLen));
  offset += trackLen;
  const frameId = view.getBigUint64(offset, false);
  offset += 8;
  const layerId = view.getUint8(offset);
  offset += 1;
  const codec = view.getUint8(offset);
  offset += 1;
  const timestampUs = view.getBigUint64(offset, false);
  offset += 8;
  const isKeyframe = view.getUint8(offset) !== 0;
  offset += 1;
  const fragmentIndex = view.getUint16(offset, false);
  offset += 2;
  const fragmentCount = view.getUint16(offset, false);
  offset += 2;
  return {
    metadata: {
      streamId,
      trackId,
      frameId,
      layerId,
      codec,
      timestampUs,
      isKeyframe,
      fragmentIndex,
      fragmentCount,
    },
    payloadOffset: offset,
  };
}
