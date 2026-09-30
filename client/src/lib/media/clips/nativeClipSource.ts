/**
 * The desktop app's clip ring lives in the native process
 * (`client/src-tauri/src/native_media/clip_buffer.rs`), where the stream is
 * decrypted and, on the native-surface route, decoded; its own audio always
 * plays natively. These are the three commands that drive it, and the reader
 * for what `media_clip_cut` returns.
 */
import type { ClipAudioPacket, ClipCapture, ClipCodec, ClipVideoFrame } from './clipRing';

export type NativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const tauriInvoke: NativeInvoke = async (command, args) => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, args);
};

const CODECS: Record<number, ClipCodec | null> = { 0: null, 1: 'vp9', 2: 'av1', 3: 'h264' };

/** Read the `PCLP` layout (little-endian; see `ClipRing::cut` in clip_buffer.rs). Times become ms. */
export function parseNativeClip(bytes: Uint8Array): ClipCapture {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (why: string): never => {
    throw new Error(`The desktop app returned a clip this version cannot read (${why}).`);
  };
  if (bytes.length < 20 || bytes[0] !== 0x50 || bytes[1] !== 0x43 || bytes[2] !== 0x4c || bytes[3] !== 0x50) fail('no PCLP header');
  if (bytes[4] !== 1) fail(`layout version ${bytes[4]}`);
  if (!(bytes[5] in CODECS)) fail(`codec ${bytes[5]}`);
  const codec = CODECS[bytes[5]];
  const nowMs = Number(view.getBigUint64(8, true)) / 1000;
  let at = 16;
  const need = (length: number) => {
    if (at + length > bytes.length) fail('truncated');
  };
  need(4);
  const videoCount = view.getUint32(at, true);
  at += 4;
  const video: ClipVideoFrame[] = [];
  for (let i = 0; i < videoCount; i++) {
    need(21);
    const arrivalMs = Number(view.getBigUint64(at, true)) / 1000;
    const senderUs = Number(view.getBigUint64(at + 8, true));
    const key = bytes[at + 16] === 1;
    const length = view.getUint32(at + 17, true);
    at += 21;
    need(length);
    video.push({ arrivalMs, senderUs, key, data: bytes.subarray(at, at + length) });
    at += length;
  }
  need(4);
  const audioCount = view.getUint32(at, true);
  at += 4;
  const audio: ClipAudioPacket[] = [];
  for (let i = 0; i < audioCount; i++) {
    need(20);
    const arrivalMs = Number(view.getBigUint64(at, true)) / 1000;
    const seq = Number(view.getBigInt64(at + 8, true));
    const length = view.getUint32(at + 16, true);
    at += 20;
    need(length);
    audio.push({ arrivalMs, seq, data: bytes.subarray(at, at + length) });
    at += length;
  }
  if (at !== bytes.length) fail('trailing bytes');
  return { codec: video.length > 0 ? codec : null, video, audio, nowMs };
}

/** Tauri hands binary responses back as an ArrayBuffer, or as a number array over its JSON transport. */
function asBytes(raw: unknown): Uint8Array {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]);
  throw new Error('The desktop app returned no clip.');
}

export function createNativeClipSource(invoke: NativeInvoke = tauriInvoke) {
  return {
    arm: (streamerId: string) => invoke('media_clip_arm', { publisherUserId: streamerId }).then(() => undefined),
    disarm: () => invoke('media_clip_disarm').then(() => undefined),
    cut: async (): Promise<ClipCapture> => parseNativeClip(asBytes(await invoke('media_clip_cut'))),
  };
}
