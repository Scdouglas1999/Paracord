import { describe, expect, it, vi } from 'vitest';

import { tapEngineFrames } from './engineFrameTap';
import type { MediaEngine } from './mediaEngine';

/** Let the capture promise chain (then → finally) settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('engine frame taps', () => {
  function tapEngine() {
    let deliver!: (frame: VideoFrame) => void;
    const release = vi.fn();
    const engine = {
      tapVideoFrames: vi.fn((_user: string, _track: string, onFrame: (frame: VideoFrame) => void) => {
        deliver = onFrame;
        return { route: Promise.resolve('frames' as const), release };
      }),
    } as unknown as MediaEngine;
    return { engine, release, deliver: (frame: VideoFrame) => deliver(frame) };
  }
  const videoFrame = () => ({ close: vi.fn(), displayWidth: 32, displayHeight: 18 }) as unknown as VideoFrame;

  it('samples at no more than the asked rate, capped at 4 a second, closing every frame it skips', async () => {
    const { engine, deliver } = tapEngine();
    let clock = 0;
    const toBitmap = vi.fn(async () => ({ width: 32, height: 18, close: vi.fn() }) as unknown as ImageBitmap);
    const frames: unknown[] = [];
    tapEngineFrames(engine, '7', 'screen', (f) => frames.push(f), 60, { now: () => clock, toBitmap });
    const first = videoFrame();
    deliver(first);
    await flush();
    clock = 100;
    const skipped = videoFrame();
    deliver(skipped); // inside the 250ms window of the 4 Hz cap
    expect(skipped.close).toHaveBeenCalled();
    clock = 300;
    deliver(videoFrame());
    await flush();
    expect(toBitmap).toHaveBeenCalledTimes(2);
    expect(frames).toHaveLength(2);
    expect(first.close).toHaveBeenCalled();
  });

  it('holds a slow sampler to its rate when asked', async () => {
    const { engine, deliver } = tapEngine();
    let clock = 0;
    const toBitmap = vi.fn(async () => ({ width: 32, height: 18, close: vi.fn() }) as unknown as ImageBitmap);
    tapEngineFrames(engine, '7', 'screen', () => {}, 1, { now: () => clock, toBitmap });
    deliver(videoFrame()); await flush();
    clock = 900; deliver(videoFrame()); await flush();
    clock = 1000; deliver(videoFrame()); await flush();
    expect(toBitmap).toHaveBeenCalledTimes(2);
  });

  it('releases the engine tap and closes a bitmap that lands after release', async () => {
    const { engine, release, deliver } = tapEngine();
    const bitmap = { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
    let resolveBitmap!: (value: ImageBitmap) => void;
    const toBitmap = vi.fn(() => new Promise<ImageBitmap>((resolve) => { resolveBitmap = resolve; }));
    const onFrame = vi.fn();
    const tap = tapEngineFrames(engine, '7', 'screen', onFrame, 4, { now: () => 0, toBitmap });
    deliver(videoFrame());
    tap.release();
    resolveBitmap(bitmap);
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
    expect(onFrame).not.toHaveBeenCalled();
    expect(bitmap.close).toHaveBeenCalled();
    await expect(tap.route).resolves.toBe('frames');
  });

  describe('on the desktop app (native-surface)', () => {
    function nativeEngine(stills: Array<{ seq: number } | null | Error>) {
      const release = vi.fn();
      const asked: Array<[number, number, number | undefined]> = [];
      const engine = {
        tapVideoFrames: vi.fn(() => ({ route: Promise.resolve('native-surface' as const), release })),
        readVideoStill: vi.fn(async (_user: string, _track: string, w: number, h: number, after?: number) => {
          asked.push([w, h, after]);
          const next = stills.shift() ?? null;
          if (next instanceof Error) throw next;
          return next ? { seq: next.seq, bitmap: { width: w, height: h, close: vi.fn() } as unknown as ImageBitmap } : null;
        }),
      } as unknown as MediaEngine;
      return { engine, release, asked };
    }
    function timers() {
      const pending: Array<() => void> = [];
      return {
        pending,
        deps: {
          now: () => 0,
          toBitmap: vi.fn(),
          setTimeout: (callback: () => void) => {
            pending.push(callback);
            return pending.length as unknown as ReturnType<typeof setTimeout>;
          },
          clearTimeout: vi.fn(),
        },
        tick: async () => {
          pending.shift()?.();
          await flush();
        },
      };
    }

    it('reads stills at the size asked, skipping one it already has', async () => {
      const { engine, asked } = nativeEngine([{ seq: 1 }, null, { seq: 2 }]);
      const clock = timers();
      const frames: Array<{ width: number }> = [];
      tapEngineFrames(engine, '7', 'screen', (f) => frames.push(f), 4, clock.deps, { width: 64, height: 36 });
      await flush();
      await clock.tick();
      await clock.tick();
      expect(asked).toEqual([[64, 36, undefined], [64, 36, 1], [64, 36, 1]]);
      expect(frames.map((f) => f.width)).toEqual([64, 64]);
    });

    it('stops loudly when the shell cannot read a still, and releases cleanly', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { engine, release } = nativeEngine([new Error('GPU-resident')]);
      const clock = timers();
      const tap = tapEngineFrames(engine, '7', 'screen', () => {}, 1, clock.deps);
      await flush();
      expect(error).toHaveBeenCalledWith(
        '[media] the native video still could not be read; sampling stops',
        expect.objectContaining({ error: 'GPU-resident' }),
      );
      expect(clock.pending).toHaveLength(0);
      tap.release();
      expect(release).toHaveBeenCalledTimes(1);
      error.mockRestore();
    });
  });
});
