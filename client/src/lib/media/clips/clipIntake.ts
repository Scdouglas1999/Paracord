/**
 * The browser's clip intake: the decoder intake of `BrowserMediaEngine` hands
 * every decrypted encoded frame of a screen share, and every decrypted packet
 * of its own audio, to `clipIntake`, which keeps them in a {@link ClipRing}
 * only while a clip is armed for that engine and that sharer. Otherwise each
 * call is two comparisons and returns.
 *
 * The taps sit after decryption and, for video, after the subscription's
 * decode gate, so the ring sees exactly the keyframe-led chain the decoder
 * decodes. Nothing here ever sees a key or a ciphertext.
 *
 * The desktop app does not use this: its streams are decrypted and decoded in
 * the native process, which keeps the ring there (`nativeClipSource.ts`).
 */
import { ClipRing, type ClipCapture, type ClipCodec } from './clipRing';

/** The screen share's video track, and its own audio (the relay's viewable stream). */
const SCREEN_TRACK = 'screen';

interface ArmedClip {
  engine: object;
  userId: string;
  ring: ClipRing;
}

let armed: ArmedClip | null = null;

/** 'vp9', 'vp09.00.10.08', 'AV1', 'avc1.64002a' … → the codec family, or null. */
export function clipCodecFamily(codec: string): ClipCodec | null {
  const value = codec.trim().toLowerCase();
  if (value.startsWith('vp9') || value.startsWith('vp09')) return 'vp9';
  if (value.startsWith('av1') || value.startsWith('av01')) return 'av1';
  if (value.startsWith('h264') || value.startsWith('avc1') || value.startsWith('avc3')) return 'h264';
  return null;
}

export const clipIntake = {
  /**
   * One whole encoded frame, decrypted, in decode order, as it goes into
   * `userId`'s `trackId` decoder on `engine`.
   */
  video(
    engine: object,
    userId: string,
    trackId: string | undefined,
    codec: string,
    frame: { data: Uint8Array; isKeyframe: boolean; timestampUs: bigint },
  ): void {
    const clip = armed;
    if (!clip || clip.engine !== engine || clip.userId !== userId || trackId !== SCREEN_TRACK) return;
    const family = clipCodecFamily(codec);
    if (!family) return;
    clip.ring.pushVideo({
      arrivalMs: performance.now(),
      senderUs: Number(frame.timestampUs),
      key: frame.isKeyframe,
      codec: family,
      data: frame.data,
    });
  },

  /** One decrypted Opus packet of `userId`'s screen share audio on `engine`. */
  audio(engine: object, userId: string, sequence: number, data: Uint8Array): void {
    const clip = armed;
    if (!clip || clip.engine !== engine || clip.userId !== userId) return;
    clip.ring.pushAudio({ arrivalMs: performance.now(), seq16: sequence & 0xffff, data });
  },
};

/**
 * Keep `userId`'s screen share from `engine`. The same sharer on another
 * engine (the watch moved into or out of the call) keeps what is held and
 * continues from that engine's next keyframe; another sharer starts empty.
 */
export function armBrowserClip(engine: object, userId: string): void {
  if (armed && armed.userId === userId) {
    if (armed.engine !== engine) {
      armed.engine = engine;
      armed.ring.requireKeyframe();
    }
    return;
  }
  armed = { engine, userId, ring: new ClipRing() };
}

/** Stop keeping anything, and free what was kept. */
export function disarmBrowserClip(): void {
  armed?.ring.reset();
  armed = null;
}

export function cutBrowserClip(): ClipCapture {
  if (!armed) throw new Error('No stream is being clipped.');
  return armed.ring.snapshot(performance.now());
}

/** For tests and diagnostics: what is held now. */
export function browserClipBytes(): number {
  return armed?.ring.bytes ?? 0;
}
