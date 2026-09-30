import { afterEach, describe, expect, it, vi } from 'vitest';
import { armBrowserClip, browserClipBytes, clipCodecFamily, clipIntake, cutBrowserClip, disarmBrowserClip } from './clipIntake';
import { createNativeClipSource, parseNativeClip } from './nativeClipSource';

const engineA = {};
const engineB = {};
const frame = (key: boolean, timestampUs: number, size = 4) => ({ data: new Uint8Array(size), isKeyframe: key, timestampUs: BigInt(timestampUs) });

afterEach(() => disarmBrowserClip());

describe('clipIntake (the browser decoder intake)', () => {
  it('keeps nothing until armed, and only the armed sharer’s screen on the armed engine', () => {
    clipIntake.video(engineA, '7', 'screen', 'vp9', frame(true, 0));
    armBrowserClip(engineA, '7');
    expect(browserClipBytes()).toBe(0);
    clipIntake.video(engineA, '7', 'screen', 'vp9', frame(true, 0));
    clipIntake.video(engineA, '7', 'camera', 'vp9', frame(true, 0)); // not the stream
    clipIntake.video(engineA, '8', 'screen', 'vp9', frame(true, 0)); // another sharer
    clipIntake.video(engineB, '7', 'screen', 'vp9', frame(true, 0)); // another connection
    clipIntake.audio(engineA, '7', 3, Uint8Array.of(8, 1));
    clipIntake.audio(engineA, '8', 3, Uint8Array.of(8, 1));
    const cut = cutBrowserClip();
    expect(cut.codec).toBe('vp9');
    expect(cut.video).toHaveLength(1);
    expect(cut.audio).toHaveLength(1);
  });

  it('follows the watch onto another engine without losing what it holds', () => {
    armBrowserClip(engineA, '7');
    clipIntake.video(engineA, '7', 'screen', 'vp09.00.10.08', frame(true, 0));
    clipIntake.video(engineA, '7', 'screen', 'vp9', frame(false, 33_000));
    armBrowserClip(engineB, '7');
    clipIntake.video(engineA, '7', 'screen', 'vp9', frame(false, 66_000)); // the old connection, late
    clipIntake.video(engineB, '7', 'screen', 'vp9', frame(false, 99_000)); // before its first keyframe
    clipIntake.video(engineB, '7', 'screen', 'vp9', frame(true, 132_000));
    expect(cutBrowserClip().video.map((f) => f.senderUs)).toEqual([0, 33_000, 132_000]);
  });

  it('starts empty for another sharer and frees everything on disarm', () => {
    armBrowserClip(engineA, '7');
    clipIntake.video(engineA, '7', 'screen', 'vp9', frame(true, 0, 1_000));
    expect(browserClipBytes()).toBe(1_000);
    armBrowserClip(engineA, '8');
    expect(browserClipBytes()).toBe(0);
    disarmBrowserClip();
    expect(() => cutBrowserClip()).toThrow(/No stream/);
  });

  it('names codec families from decoder labels and codec strings', () => {
    expect(['vp9', 'VP09.00.41.08', 'av1', 'av01.0.08M.08', 'h264', 'avc1.64002a', 'hevc'].map(clipCodecFamily)).toEqual([
      'vp9', 'vp9', 'av1', 'av1', 'h264', 'h264', null,
    ]);
  });
});

/** The layout `ClipRing::cut` writes (see its round-trip test in clip_buffer.rs). */
function nativeCut(): Uint8Array {
  const parts: number[] = [];
  const u8 = (v: number) => parts.push(v);
  const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); parts.push(...b); };
  const u64 = (v: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); parts.push(...b); };
  parts.push(0x50, 0x43, 0x4c, 0x50);
  u8(1); u8(2); u8(0); u8(0);
  u64(300_000);
  u32(2);
  u64(100_000); u64(7_000); u8(1); u32(3); parts.push(1, 2, 3);
  u64(200_000); u64(40_000); u8(0); u32(1); parts.push(4);
  u32(1);
  u64(150_000); u64(65_536); u32(2); parts.push(8, 0xaa);
  return Uint8Array.from(parts);
}

describe('nativeClipSource', () => {
  it('reads what the desktop ring returns, times in ms', () => {
    const capture = parseNativeClip(nativeCut());
    expect(capture.codec).toBe('av1');
    expect(capture.nowMs).toBe(300);
    expect(capture.video.map((f) => [f.arrivalMs, f.senderUs, f.key, [...f.data]])).toEqual([
      [100, 7_000, true, [1, 2, 3]],
      [200, 40_000, false, [4]],
    ]);
    expect(capture.audio.map((p) => [p.arrivalMs, p.seq, [...p.data]])).toEqual([[150, 65_536, [8, 0xaa]]]);
  });

  it('refuses a truncated or foreign layout instead of guessing', () => {
    const bytes = nativeCut();
    expect(() => parseNativeClip(bytes.subarray(0, bytes.length - 1))).toThrow(/cannot read/);
    const wrong = bytes.slice();
    wrong[4] = 2;
    expect(() => parseNativeClip(wrong)).toThrow(/layout version 2/);
  });

  it('drives the three native commands, and reads a number-array response too', async () => {
    const invoke = vi.fn(async (command: string) => (command === 'media_clip_cut' ? Array.from(nativeCut()) : null));
    const source = createNativeClipSource(invoke);
    await source.arm('42');
    expect(invoke).toHaveBeenLastCalledWith('media_clip_arm', { publisherUserId: '42' });
    expect((await source.cut()).video).toHaveLength(2);
    await source.disarm();
    expect(invoke.mock.calls.at(-1)?.[0]).toBe('media_clip_disarm');
  });
});
