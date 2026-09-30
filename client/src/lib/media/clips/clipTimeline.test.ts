import { describe, expect, it } from 'vitest';
import type { ClipAudioPacket, ClipCapture, ClipVideoFrame } from './clipRing';
import { buildClipTimeline, selectClipFrames } from './clipTimeline';

const opus20 = (marker = 0) => Uint8Array.of(0x08 | 0x00, marker); // SILK 20 ms mono, code 0 (config 1)

function video(count: number, options: { fps?: number; gop?: number; jitter?: (i: number) => number; start?: number } = {}): ClipVideoFrame[] {
  const fps = options.fps ?? 30;
  const gop = options.gop ?? 150;
  return Array.from({ length: count }, (_, i) => {
    const captureMs = (options.start ?? 0) + (i * 1000) / fps;
    return {
      arrivalMs: 10_000 + captureMs + 30 + (options.jitter?.(i) ?? 0),
      senderUs: Math.round((captureMs + 777_000) * 1000), // the publisher's own clock
      key: i % gop === 0,
      data: Uint8Array.of(i & 0xff),
    };
  });
}

function audio(count: number, options: { skip?: Set<number>; jitter?: (i: number) => number; startMs?: number; seq0?: number } = {}): ClipAudioPacket[] {
  const out: ClipAudioPacket[] = [];
  for (let i = 0; i < count; i++) {
    if (options.skip?.has(i)) continue;
    out.push({ arrivalMs: 10_000 + (options.startMs ?? 0) + i * 20 + 30 + (options.jitter?.(i) ?? 0), seq: (options.seq0 ?? 500) + i, data: opus20(i & 0xff) });
  }
  return out;
}

function capture(v: ClipVideoFrame[], a: ClipAudioPacket[], nowMs?: number): ClipCapture {
  return { codec: 'vp9', video: v, audio: a, nowMs: nowMs ?? v[v.length - 1].arrivalMs };
}

describe('selectClipFrames', () => {
  it('starts at the newest keyframe at or before now − 30 s', () => {
    const frames = video(35 * 30); // 35 s, keyframes every 5 s
    const now = frames[frames.length - 1].arrivalMs;
    const picked = selectClipFrames(frames, now);
    expect(picked[0].key).toBe(true);
    expect(picked[0].arrivalMs).toBeLessThanOrEqual(now - 30_000);
    const later = frames.find((f) => f.key && f.arrivalMs > picked[0].arrivalMs)!;
    expect(later.arrivalMs).toBeGreaterThan(now - 30_000);
  });

  it('starts at the oldest keyframe when less than 30 s is held', () => {
    const frames = video(10 * 30).slice(20); // starts mid-GOP
    const picked = selectClipFrames(frames, frames[frames.length - 1].arrivalMs);
    expect(picked[0]).toBe(frames.find((f) => f.key));
  });
});

describe('buildClipTimeline', () => {
  it('covers the last 30 seconds (plus the GOP lead-in) from the first picked keyframe', () => {
    const frames = video(40 * 30);
    const timeline = buildClipTimeline(capture(frames, []));
    expect(timeline.video[0].tMs).toBe(0);
    expect(timeline.video[0].key).toBe(true);
    expect(timeline.durationMs).toBeGreaterThanOrEqual(30_000);
    expect(timeline.durationMs).toBeLessThan(35_000 + 40);
  });

  it('plays video at the sender spacing, not the arrival jitter', () => {
    const frames = video(90, { jitter: (i) => ((i * 37) % 50) });
    const timeline = buildClipTimeline(capture(frames, []));
    for (let i = 1; i < timeline.video.length; i++) {
      expect(timeline.video[i].tMs - timeline.video[i - 1].tMs).toBeCloseTo(1000 / 30, 2);
    }
    expect(timeline.durationMs).toBeCloseTo(90 * (1000 / 30), 1);
  });

  it('lines audio up with video on the arrival clock', () => {
    // Audio starts 500 ms after the first frame, both arriving 30 ms after capture.
    const timeline = buildClipTimeline(capture(video(90), audio(100, { startMs: 500, jitter: (i) => (i % 3) * 15 })));
    expect(timeline.audio[0].tMs).toBeCloseTo(500, 3);
    expect(timeline.audio[1].tMs - timeline.audio[0].tMs).toBe(20);
    expect(timeline.audioChannels).toBe(1);
  });

  it('fills lost audio packets so the track stays continuous', () => {
    const timeline = buildClipTimeline(capture(video(90), audio(50, { skip: new Set([10, 11, 30]) })));
    expect(timeline.audio).toHaveLength(50);
    expect(timeline.audio.filter((p) => p.lost)).toHaveLength(3);
    expect(timeline.audio[10].data).toEqual(Uint8Array.of(0x08)); // TOC only: conceal
    timeline.audio.forEach((p, i) => expect(p.tMs).toBeCloseTo(timeline.audio[0].tMs + i * 20, 3));
  });

  it('keeps a pause in the stream audio (sequence numbers do not advance while nothing is sent)', () => {
    const before = audio(50); // 0–1 s
    // The publisher paused for 2 s: the next packet's sequence follows on, but it arrives 2 s later.
    const after = audio(50, { startMs: 3_000, seq0: 550 });
    const timeline = buildClipTimeline(capture(video(150), [...before, ...after]));
    const firstAfter = timeline.audio.findIndex((p) => p.data === after[0].data);
    expect(timeline.audio[firstAfter].tMs).toBeCloseTo(3_000, 0);
    // The gap is concealed, not dropped: the track is continuous.
    expect(timeline.audio.slice(50, firstAfter).every((p) => p.lost)).toBe(true);
  });

  it('drops audio from before the first picture', () => {
    const timeline = buildClipTimeline(capture(video(90), audio(100, { startMs: -1_000 })));
    expect(timeline.audio[0].tMs).toBeGreaterThanOrEqual(0);
    expect(timeline.audio[0].tMs).toBeLessThan(20);
  });

  it('refuses a capture with no keyframe', () => {
    expect(() => buildClipTimeline({ codec: null, video: [], audio: [], nowMs: 0 })).toThrow(/Nothing from this stream/);
  });
});
