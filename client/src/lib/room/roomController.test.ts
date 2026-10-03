import { afterEach, describe, expect, it } from 'vitest';
import type { FrameAnalyzer } from './analyzeFrame';
import { insideClampBox, ROOM_DEFAULT, roomColorFromAverage, type Rgb } from './color';
import type { FrameSource } from './frameSource';
import { ROOM_GRID_HEIGHT, ROOM_GRID_WIDTH } from './pixels';
import {
  createRoomController,
  ROOM_HOLD_MS,
  ROOM_TICK_HZ,
  type RoomLayer,
} from './roomController';
import { createManualClock, type ManualClock } from './testClock';
import { createRoomTokenWriter, ROOM_TOKEN_PROPERTY } from './tokenWriter';

const GRID = ROOM_GRID_WIDTH * ROOM_GRID_HEIGHT * 3;

interface FakeFrame {
  width: number;
  height: number;
  value: number;
  closed: boolean;
  close(): void;
}

function fakeFrame(value: number): FakeFrame {
  return { width: 320, height: 180, value, closed: false, close() { this.closed = true; } };
}

/** A stream that makes a new, very different frame `rate` times a second. */
function fakeStream(clock: ManualClock, rate: number) {
  const frames: FakeFrame[] = [];
  let subscribers = 0;
  let counter = 0;
  const source: FrameSource = {
    kind: 'stream',
    width: 320,
    height: 180,
    subscribe(onFrame) {
      subscribers += 1;
      let live = true;
      const loop = () => {
        if (!live) return;
        const frame = fakeFrame(counter++);
        frames.push(frame);
        onFrame(frame as unknown as ImageBitmap);
        clock.setTimeout(loop, 1000 / rate);
      };
      clock.setTimeout(loop, 0);
      return () => {
        live = false;
        subscribers -= 1;
      };
    },
    getLatestFrame: async () => fakeFrame(counter++) as unknown as ImageBitmap,
  };
  return { source, frames, get subscribers() { return subscribers; } };
}

/** Each frame is a different flat color, so every frame moves the room. */
const analyze: FrameAnalyzer = (frame) => {
  const value = (frame as unknown as FakeFrame).value;
  const rgb: Rgb = [(value * 83) % 256, (value * 151) % 256, (value * 29) % 256];
  return { grid: new Float32Array(GRID).fill(rgb[0] * 0.6), color: roomColorFromAverage(rgb) };
};

function fakeLayers() {
  const log = { paints: [0, 0], lit: [false, false] };
  const layer = (index: 0 | 1): RoomLayer => ({
    paint: () => { log.paints[index] += 1; },
    setLit: (lit) => { log.lit[index] = lit; },
  });
  return { layers: [layer(0), layer(1)] as const, log };
}

describe('room controller', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style');
  });

  it('starts with the default tint when Home has no room source and stays idle on repeated selection', () => {
    const clock = createManualClock();
    const { layers, log } = fakeLayers();
    const writer = createRoomTokenWriter(document.documentElement, clock);
    const controller = createRoomController({ layers, writer, analyze, clock });
    controller.setSource(null);
    expect(writer.written).toEqual(ROOM_DEFAULT);
    controller.setSource(null);
    clock.advance(5_000);
    expect(writer.writes).toBe(1);
    expect(log.paints).toEqual([0, 0]);
    expect(controller.phase).toBe('idle');
    controller.dispose();
  });

  it('keeps to its budget with a busy stream: no per-frame style writes, token and paints at most 4 Hz', () => {
    const clock = createManualClock();
    const { layers, log } = fakeLayers();
    const root = document.documentElement;
    const writer = createRoomTokenWriter(root, clock);
    const controller = createRoomController({ layers, writer, analyze, clock });
    const stream = fakeStream(clock, 30);

    const styleMutations: string[] = [];
    const originalSet = root.style.setProperty.bind(root.style);
    root.style.setProperty = (property: string, value: string | null) => {
      styleMutations.push(property);
      originalSet(property, value);
    };

    controller.setSource({ key: 'stream', source: stream.source, grade: 'stream', hz: 30 });
    clock.advance(10_000);

    // 300 frames arrived; the room did not follow them one by one.
    expect(stream.frames.length).toBeGreaterThanOrEqual(299);
    expect(stream.frames.every((frame) => frame.closed)).toBe(true);
    expect(writer.writes).toBeLessThanOrEqual(10 * 4 + 2);
    expect(new Set(styleMutations)).toEqual(new Set([ROOM_TOKEN_PROPERTY]));
    // One paint on the first frame, then at most one per tick.
    expect(log.paints[0] + log.paints[1]).toBeLessThanOrEqual(10 * ROOM_TICK_HZ + 2);
    expect(insideClampBox(writer.written!)).toBe(true);
    controller.dispose();
  });

  it('lights the first layer on the first frame and lands the first color directly', () => {
    const clock = createManualClock();
    const { layers, log } = fakeLayers();
    const element = document.createElement('div');
    const writer = createRoomTokenWriter(element, clock);
    const phases: string[] = [];
    const controller = createRoomController({ layers, writer, analyze, clock, onPhase: (p) => phases.push(p) });
    const stream = fakeStream(clock, 1);
    controller.setSource({ key: 'a', source: stream.source, grade: 'stream', hz: 1 });
    expect(controller.phase).toBe('waiting');
    clock.advance(1);
    expect(log.lit).toEqual([true, false]);
    expect(controller.phase).toBe('lit');
    expect(writer.writes).toBe(1);
    expect(phases).toEqual(['waiting', 'lit']);
    controller.dispose();
  });

  it('crossfades: the old layer stays lit until the new source has a frame', () => {
    const clock = createManualClock();
    const { layers, log } = fakeLayers();
    const writer = createRoomTokenWriter(document.createElement('div'), clock);
    const controller = createRoomController({ layers, writer, analyze, clock });
    const first = fakeStream(clock, 2);
    controller.setSource({ key: 'a', source: first.source, grade: 'stream', hz: 2 });
    clock.advance(10);
    expect(log.lit).toEqual([true, false]);

    // The next source is slow to start: the first room holds.
    let deliver: ((frame: ImageBitmap) => void) | null = null;
    const slow: FrameSource = {
      kind: 'image', width: 1, height: 1,
      subscribe: (onFrame) => { deliver = onFrame; return () => { deliver = null; }; },
      getLatestFrame: async () => null,
    };
    controller.setSource({ key: 'b', source: slow, grade: 'still', hz: 1 });
    expect(first.subscribers).toBe(0);
    clock.advance(ROOM_HOLD_MS / 2);
    expect(log.lit).toEqual([true, false]);
    deliver!(fakeFrame(5) as unknown as ImageBitmap);
    // Both flip together: CSS fades one out while the other fades in.
    expect(log.lit).toEqual([false, true]);
    controller.dispose();
  });

  it('crossfades even through a moment of nothing (a route that resolves in two renders)', () => {
    const clock = createManualClock();
    const { layers, log } = fakeLayers();
    const writer = createRoomTokenWriter(document.createElement('div'), clock);
    const controller = createRoomController({ layers, writer, analyze, clock });
    controller.setSource({ key: 'a', source: fakeStream(clock, 2).source, grade: 'stream', hz: 2 });
    clock.advance(10);
    expect(log.lit).toEqual([true, false]);
    const paintsOnA = log.paints[0];
    controller.setSource(null);
    controller.setSource({ key: 'b', source: fakeStream(clock, 2).source, grade: 'still', hz: 2 });
    clock.advance(10);
    // The picture that was on screen is never repainted with the next one.
    expect(log.paints[0]).toBe(paintsOnA);
    expect(log.lit).toEqual([false, true]);
    controller.dispose();
  });

  it('lets the old light go and rests on the default room when the new source never delivers', () => {
    const clock = createManualClock();
    const { layers, log } = fakeLayers();
    const element = document.createElement('div');
    const writer = createRoomTokenWriter(element, clock);
    const controller = createRoomController({ layers, writer, analyze, clock });
    const first = fakeStream(clock, 2);
    controller.setSource({ key: 'a', source: first.source, grade: 'stream', hz: 2 });
    clock.advance(10);
    const silent: FrameSource = {
      kind: 'stream', width: 1, height: 1, subscribe: () => () => {}, getLatestFrame: async () => null,
    };
    controller.setSource({ key: 'b', source: silent, grade: 'stream', hz: 1 });
    clock.advance(ROOM_HOLD_MS + 5_000);
    expect(log.lit).toEqual([false, false]);
    expect(controller.phase).toBe('waiting');
    expect(writer.written).toEqual(ROOM_DEFAULT);
    controller.dispose();
  });

  it('uses the default tint with nothing to light it, and asks for no frames while hidden', () => {
    const clock = createManualClock();
    const { layers, log } = fakeLayers();
    const writer = createRoomTokenWriter(document.createElement('div'), clock);
    const controller = createRoomController({ layers, writer, analyze, clock });
    const stream = fakeStream(clock, 4);
    controller.setSource({ key: 'a', source: stream.source, grade: 'stream', hz: 4 });
    clock.advance(1_000);
    controller.setVisible(false);
    expect(stream.subscribers).toBe(0);
    const paintsWhileHidden = log.paints[0];
    clock.advance(5_000);
    expect(log.paints[0]).toBe(paintsWhileHidden);
    controller.setVisible(true);
    expect(stream.subscribers).toBe(1);

    controller.setSource(null);
    expect(stream.subscribers).toBe(0);
    expect(log.lit).toEqual([false, false]);
    clock.advance(5_000);
    expect(writer.written).toEqual(ROOM_DEFAULT);
    expect(controller.phase).toBe('idle');
    controller.dispose();
  });

  it('asks the analyzer for no blur under reduced transparency', () => {
    const clock = createManualClock();
    const { layers } = fakeLayers();
    const sigmas: number[] = [];
    let reduced = false;
    const controller = createRoomController({
      layers,
      writer: createRoomTokenWriter(document.createElement('div'), clock),
      analyze: (frame, options) => {
        sigmas.push(options.blurSigma);
        return analyze(frame, options);
      },
      clock,
      reducedTransparency: () => reduced,
    });
    const stream = fakeStream(clock, 1);
    controller.setSource({ key: 'a', source: stream.source, grade: 'stream', hz: 1 });
    clock.advance(1);
    reduced = true;
    clock.advance(1_000);
    expect(sigmas[0]).toBeGreaterThan(1);
    expect(sigmas[sigmas.length - 1]).toBe(0);
    controller.dispose();
  });
});
