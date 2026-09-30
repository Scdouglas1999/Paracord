/**
 * Opus packet facts a container needs, read from the TOC byte (RFC 6716 §3.1):
 * how long a packet plays, whether it is stereo, and the packet that stands in
 * for a lost one.
 */

export const OPUS_SAMPLE_RATE = 48_000;

/** Frame length in ms by TOC config (0..31). */
function frameMs(config: number): number {
  if (config < 12) return [10, 20, 40, 60][config % 4]; // SILK-only
  if (config < 16) return [10, 20][config % 2]; // Hybrid
  return [2.5, 5, 10, 20][config % 4]; // CELT-only
}

/** How long a packet plays, in ms. Throws on a packet too short to say. */
export function opusPacketDurationMs(packet: Uint8Array): number {
  if (packet.length < 1) throw new Error('An empty Opus packet.');
  const toc = packet[0];
  const code = toc & 0x03;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code === 1 || code === 2) frames = 2;
  else {
    if (packet.length < 2) throw new Error('An Opus code 3 packet without its frame count.');
    frames = packet[1] & 0x3f;
    if (frames === 0) throw new Error('An Opus code 3 packet with no frames.');
  }
  return frameMs(toc >> 3) * frames;
}

/** Samples at 48 kHz a packet plays. */
export function opusPacketSamples(packet: Uint8Array): number {
  return Math.round((opusPacketDurationMs(packet) * OPUS_SAMPLE_RATE) / 1000);
}

export function opusPacketIsStereo(packet: Uint8Array): boolean {
  return packet.length > 0 && (packet[0] & 0x04) !== 0;
}

/**
 * A packet with the same mode and length as `like`, carrying no frame data: a
 * decoder treats it as lost and conceals it (RFC 6716 §3.2.1, a zero-length
 * frame). It keeps the audio timeline continuous across a lost packet.
 */
export function opusLostPacket(like: Uint8Array): Uint8Array {
  const toc = like[0];
  const code = toc & 0x03;
  if (code === 0) return Uint8Array.of(toc);
  // Code 3 (arbitrary frame count), CBR, no padding, every frame empty.
  const frames = code === 3 ? like[1] & 0x3f : 2;
  return Uint8Array.of((toc & 0xfc) | 0x03, frames & 0x3f);
}

/** The Ogg/Matroska identification header (RFC 7845 §5.1). */
export function opusHead(channels: 1 | 2): Uint8Array {
  const head = new Uint8Array(19);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // "OpusHead"
  const view = new DataView(head.buffer);
  head[8] = 1; // version
  head[9] = channels;
  view.setUint16(10, 0, true); // pre-skip: the clip starts mid-stream, nothing to skip
  view.setUint32(12, OPUS_SAMPLE_RATE, true);
  view.setInt16(16, 0, true); // output gain
  head[18] = 0; // channel mapping family 0 (mono or stereo)
  return head;
}
