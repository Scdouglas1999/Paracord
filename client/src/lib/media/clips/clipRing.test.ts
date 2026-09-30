import { describe, expect, it } from 'vitest';
import { CLIP_BUFFER_MAX_BYTES, CLIP_WINDOW_MS, ClipRing } from './clipRing';

const FPS = 30;
const FRAME_MS = 1000 / FPS;

/** A stream's frames: a keyframe every `gopMs`, arriving 40 ms after capture. */
function feed(ring: ClipRing, fromMs: number, toMs: number, options: { gopMs?: number; bytes?: number; keyBytes?: number } = {}) {
  const gopFrames = Math.round(((options.gopMs ?? 5_000) * FPS) / 1000);
  for (let i = Math.ceil((fromMs * FPS) / 1000); ; i++) {
    const t = Math.round((i * 1000) / FPS);
    if (t >= toMs) break;
    const key = i % gopFrames === 0;
    ring.pushVideo({
      arrivalMs: t + 40,
      senderUs: Math.round(t * 1000),
      key,
      codec: 'vp9',
      data: new Uint8Array(key ? options.keyBytes ?? 2_000 : options.bytes ?? 200),
    });
  }
}

describe('ClipRing', () => {
  it('holds nothing until the first keyframe', () => {
    const ring = new ClipRing();
    ring.pushVideo({ arrivalMs: 0, senderUs: 0, key: false, codec: 'vp9', data: new Uint8Array(10) });
    expect(ring.hasVideo).toBe(false);
    expect(ring.snapshot(10)).toMatchObject({ codec: null, video: [] });
    ring.pushVideo({ arrivalMs: 33, senderUs: 33_000, key: true, codec: 'vp9', data: new Uint8Array(10) });
    ring.pushVideo({ arrivalMs: 66, senderUs: 66_000, key: false, codec: 'vp9', data: new Uint8Array(10) });
    const snap = ring.snapshot(70);
    expect(snap.codec).toBe('vp9');
    expect(snap.video.map((f) => f.key)).toEqual([true, false]);
  });

  it('keeps exactly the newest keyframe at or before now − 30 s, and everything after it', () => {
    const ring = new ClipRing();
    feed(ring, 0, 61_000); // keyframes at 0, 5 s, … 60 s (arrive 40 ms later)
    const now = 61_040;
    const snap = ring.snapshot(now);
    const first = snap.video[0];
    expect(first.key).toBe(true);
    // Newest keyframe that arrived at or before 31.04 s is the one captured at 30 s.
    expect(first.senderUs).toBe(30_000_000);
    expect(first.arrivalMs).toBeLessThanOrEqual(now - CLIP_WINDOW_MS);
    // The next keyframe (35 s) is already inside the window: the 30 s one is needed.
    const nextKey = snap.video.slice(1).find((f) => f.key)!;
    expect(nextKey.arrivalMs).toBeGreaterThan(now - CLIP_WINDOW_MS);
    // Nothing is missing after the start.
    const span = snap.video[snap.video.length - 1].senderUs - first.senderUs;
    expect(snap.video.length).toBe(Math.round(span / 1000 / FRAME_MS) + 1);
  });

  it('drops a GOP as soon as the next keyframe passes the horizon', () => {
    const ring = new ClipRing();
    feed(ring, 0, 35_000);
    // At 35.04 s the 5 s keyframe (arrived 5.04 s) is exactly at the horizon: 0 s GOP is gone.
    expect(ring.snapshot(35_040).video[0].senderUs).toBe(5_000_000);
    // A millisecond earlier the 0 s GOP is still needed.
    const earlier = new ClipRing();
    feed(earlier, 0, 35_000);
    expect(earlier.snapshot(35_039).video[0].senderUs).toBe(0);
  });

  it('drops the oldest GOPs to stay under its memory budget', () => {
    const maxBytes = 50_000;
    const ring = new ClipRing({ maxBytes });
    // 5 s GOPs of ~2 kB + 149 × 200 B ≈ 31.8 kB: two do not fit.
    feed(ring, 0, 20_000);
    expect(ring.bytes).toBeLessThanOrEqual(maxBytes);
    const snap = ring.snapshot(20_040);
    expect(snap.video[0].key).toBe(true);
    expect(snap.video[0].senderUs).toBe(15_000_000);
  });

  it('drops a single GOP larger than the whole budget and waits for the next keyframe', () => {
    const ring = new ClipRing({ maxBytes: 10_000 });
    feed(ring, 0, 4_000, { bytes: 500 }); // one GOP, 2 kB + 119 × 500 B > 10 kB
    expect(ring.hasVideo).toBe(false);
    expect(ring.bytes).toBe(0);
    ring.pushVideo({ arrivalMs: 4_100, senderUs: 4_050_000, key: false, codec: 'vp9', data: new Uint8Array(10) });
    expect(ring.hasVideo).toBe(false);
    ring.pushVideo({ arrivalMs: 5_040, senderUs: 5_000_000, key: true, codec: 'vp9', data: new Uint8Array(10) });
    expect(ring.hasVideo).toBe(true);
  });

  it('has a 64 MiB default budget', () => {
    expect(CLIP_BUFFER_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

  it('starts over on a codec change or when the sender clock goes back', () => {
    const ring = new ClipRing();
    feed(ring, 0, 3_000);
    ring.pushVideo({ arrivalMs: 3_100, senderUs: 3_050_000, key: true, codec: 'av1', data: new Uint8Array(10) });
    expect(ring.snapshot(3_100)).toMatchObject({ codec: 'av1' });
    expect(ring.videoFrameCount).toBe(1);
    ring.pushVideo({ arrivalMs: 3_200, senderUs: 10, key: true, codec: 'av1', data: new Uint8Array(10) }); // restarted share
    expect(ring.snapshot(3_200).video.map((f) => f.senderUs)).toEqual([10]);
  });

  it('after requireKeyframe, ignores deltas until a keyframe and keeps what it held', () => {
    const ring = new ClipRing();
    feed(ring, 0, 1_000);
    const held = ring.videoFrameCount;
    ring.requireKeyframe();
    ring.pushVideo({ arrivalMs: 1_100, senderUs: 1_050_000, key: false, codec: 'vp9', data: new Uint8Array(10) });
    expect(ring.videoFrameCount).toBe(held);
    ring.pushVideo({ arrivalMs: 1_200, senderUs: 1_150_000, key: true, codec: 'vp9', data: new Uint8Array(10) });
    ring.pushVideo({ arrivalMs: 1_230, senderUs: 1_180_000, key: false, codec: 'vp9', data: new Uint8Array(10) });
    expect(ring.videoFrameCount).toBe(held + 2);
  });

  it('orders audio by sequence across the 16-bit wrap and drops duplicates', () => {
    const ring = new ClipRing();
    ring.pushVideo({ arrivalMs: 0, senderUs: 0, key: true, codec: 'vp9', data: new Uint8Array(10) });
    const seqs = [65_533, 65_535, 65_534, 0, 1, 1, 2];
    seqs.forEach((seq16, i) => ring.pushAudio({ arrivalMs: 10 + i * 20, seq16, data: Uint8Array.of(0x08, i) }));
    expect(ring.snapshot(200).audio.map((p) => p.seq)).toEqual([65_533, 65_534, 65_535, 65_536, 65_537, 65_538]);
  });

  it('keeps audio from a second before the oldest video on', () => {
    const ring = new ClipRing();
    for (let i = 0; i < 3_000; i++) ring.pushAudio({ arrivalMs: i * 20, seq16: i & 0xffff, data: Uint8Array.of(0x08) });
    feed(ring, 0, 60_000);
    const snap = ring.snapshot(60_040);
    expect(snap.audio[0].arrivalMs).toBeGreaterThanOrEqual(snap.video[0].arrivalMs - 1_000);
    expect(snap.audio[0].arrivalMs).toBeLessThan(snap.video[0].arrivalMs - 1_000 + 20);
  });

  it('frees everything on reset', () => {
    const ring = new ClipRing();
    feed(ring, 0, 2_000);
    ring.pushAudio({ arrivalMs: 10, seq16: 1, data: Uint8Array.of(8) });
    ring.reset();
    expect(ring.bytes).toBe(0);
    expect(ring.snapshot(3_000)).toMatchObject({ codec: null, video: [], audio: [] });
  });
});
