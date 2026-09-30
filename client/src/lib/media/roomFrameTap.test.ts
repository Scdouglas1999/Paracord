import { describe, expect, it, vi } from 'vitest';

import {
  AMBIENT_SAMPLE_MAX_FPS,
  createRoomFrameTap,
  stillReasonFor,
  tapEngineFrames,
  type JoinedRoomView,
} from './roomFrameTap';
import type { MediaEngine, MediaStreamCapabilities } from './mediaEngine';

const ROOM = JSON.stringify(['a', 'viewer', 'v1']);
const OTHER = JSON.stringify(['a', 'viewer', 'v2']);

function caps(over: Partial<MediaStreamCapabilities> = {}): MediaStreamCapabilities {
  return {
    video: [],
    nativeDesktopRenderer: false,
    browserInteropProtocolV1: true,
    realMediaE2ee: true,
    simulcastV1: false,
    ...over,
  };
}

function joined(over: Partial<JoinedRoomView> = {}): JoinedRoomView {
  const engine = {
    subscribeVideo: vi.fn(() => () => {}),
  } as unknown as MediaEngine;
  return { roomKey: ROOM, engine, capabilities: caps(), ...over };
}

/** Let the capture promise chain (then → finally) settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function frame(width = 4, height = 3) {
  return {
    bitmap: { close: vi.fn() } as unknown as ImageBitmap,
    width,
    height,
    capturedAt: 0,
  };
}

/**
 * The thumbnail's honesty contract: every non-live state is NAMED. A silent
 * fallback here would be a thumbnail that looks live and is not.
 */
describe('why a room thumbnail is a still', () => {
  const request = { roomKey: ROOM, userId: '1', track: 'screen' } as const;

  it('is live only in the room you are actually in', () => {
    expect(stillReasonFor(request, joined())).toBeNull();
    expect(stillReasonFor(request, joined({ roomKey: OTHER }))).toBe('not-joined');
    expect(stillReasonFor(request, null)).toBe('no-engine');
  });

  it('is a still when the platform composites below the webview', () => {
    expect(stillReasonFor(request, joined({ capabilities: caps({ nativeRenderUnderlay: true }) })))
      .toBe('native-surface');
  });

  it('is a still when nobody is publishing', () => {
    expect(stillReasonFor({ ...request, userId: null }, joined())).toBe('no-publisher');
  });
});

describe('room frame tap', () => {
  const request = { roomKey: ROOM, userId: '1', track: 'screen' } as const;

  it('reports the reason in the model without subscribing', () => {
    const engine = joined({ roomKey: OTHER });
    const tap = createRoomFrameTap({
      resolveJoinedRoom: () => engine,
      createCanvas: () => document.createElement('canvas'),
      captureFrame: async () => null,
      now: () => 0,
    });
    expect(tap.status(request, 'LIVE')).toEqual({
      live: false,
      reason: 'not-joined',
      label: 'LIVE',
    });
    expect(tap.subscribe(request, () => {})()).toBeUndefined();
    expect(engine.engine.subscribeVideo).not.toHaveBeenCalled();
  });

  it('subscribes to the existing engine and samples at no more than 2 fps', async () => {
    const view = joined();
    let clock = 0;
    const captureFrame = vi.fn(async () => frame());
    const tap = createRoomFrameTap({
      resolveJoinedRoom: () => view,
      createCanvas: () => document.createElement('canvas'),
      captureFrame,
      now: () => clock,
    });
    const frames: unknown[] = [];
    tap.subscribe(request, (f) => frames.push(f));

    const subscribe = view.engine.subscribeVideo as unknown as ReturnType<typeof vi.fn>;
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe.mock.calls[0][3]).toEqual({ preferredTrackId: 'screen' });
    const onFrame = subscribe.mock.calls[0][2] as () => void;

    onFrame();
    await flush();
    clock = 100;
    onFrame(); // inside the 500ms window — dropped
    await flush();
    clock = 700;
    onFrame();
    await flush();

    expect(captureFrame).toHaveBeenCalledTimes(2);
    expect(frames).toHaveLength(2);
  });

  it('releases the engine subscription and drops in-flight frames on unsubscribe', async () => {
    const view = joined();
    const release = vi.fn();
    (view.engine.subscribeVideo as unknown as ReturnType<typeof vi.fn>).mockReturnValue(release);
    const pending = frame();
    const tap = createRoomFrameTap({
      resolveJoinedRoom: () => view,
      createCanvas: () => document.createElement('canvas'),
      captureFrame: async () => pending,
      now: () => 0,
    });
    const onFrameSpy = vi.fn();
    const stop = tap.subscribe(request, onFrameSpy);
    const subscribe = view.engine.subscribeVideo as unknown as ReturnType<typeof vi.fn>;
    (subscribe.mock.calls[0][2] as () => void)();
    stop();
    await flush();

    expect(release).toHaveBeenCalledTimes(1);
    expect(onFrameSpy).not.toHaveBeenCalled();
    // A frame that lands after teardown is closed, never leaked.
    expect(pending.bitmap.close).toHaveBeenCalled();
  });

  it('survives a capture failure without tearing the thumbnail down', async () => {
    const view = joined();
    const tap = createRoomFrameTap({
      resolveJoinedRoom: () => view,
      createCanvas: () => document.createElement('canvas'),
      captureFrame: async () => {
        throw new Error('no pixels');
      },
      now: () => 0,
    });
    const stop = tap.subscribe(request, () => {});
    const subscribe = view.engine.subscribeVideo as unknown as ReturnType<typeof vi.fn>;
    expect(() => (subscribe.mock.calls[0][2] as () => void)()).not.toThrow();
    await flush();
    stop();
  });
});

describe('engine frame taps (Glass room light, stage glow)', () => {
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

  it('holds ambient to one a second when asked', async () => {
    const { engine, deliver } = tapEngine();
    let clock = 0;
    const toBitmap = vi.fn(async () => ({ width: 32, height: 18, close: vi.fn() }) as unknown as ImageBitmap);
    tapEngineFrames(engine, '7', 'screen', () => {}, AMBIENT_SAMPLE_MAX_FPS, { now: () => clock, toBitmap });
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
});
