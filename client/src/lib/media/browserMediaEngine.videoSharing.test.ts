/**
 * One decoder per subscribed track, however many surfaces are watching it.
 *
 * The Stage tile, the share viewer and the sidebar's room thumbnail all ask for
 * the same person's camera or screen. `subscribeVideo` used to tear the running
 * subscription down and build a fresh `VideoDecoder` + WebGL renderer for the
 * newest caller, which (a) took the picture away from every earlier one and
 * (b) turned any upstream re-render into decoder churn — 812 decoders and 812
 * WebGL contexts in 90 seconds of a measured two-party call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const decoders: MockDecoder[] = [];
const renderers: MockRenderer[] = [];

class MockDecoder {
  codec: string;
  closed = false;
  private sinks: Array<(frame: unknown) => void> = [];
  constructor(config: { codec: string }) {
    this.codec = config.codec;
    decoders.push(this);
  }
  onDecoded(cb: (frame: unknown) => void) {
    this.sinks.push(cb);
  }
  onError() {}
  onKeyframeNeeded() {}
  decode() {}
  reset() {}
  close() {
    this.closed = true;
  }
  /** Push a decoded frame the way WebCodecs would. */
  emit(frame: unknown) {
    for (const sink of this.sinks) sink(frame);
  }
}

class MockRenderer {
  destroyed = false;
  cleared = 0;
  rendered: unknown[] = [];
  constructor(public canvas: HTMLCanvasElement) {
    renderers.push(this);
  }
  get canvasElement() {
    return this.canvas;
  }
  renderFrame(frame: { close: () => void }) {
    this.rendered.push(frame);
    frame.close();
  }
  setRenderingEnabled() {}
  clear() {
    this.cleared += 1;
  }
  destroy() {
    this.destroyed = true;
  }
}

vi.mock('./video/videoDecoder', () => ({ MediaVideoDecoder: MockDecoder }));
vi.mock('./video/canvasRenderer', () => ({ CanvasRenderer: MockRenderer }));

const { BrowserMediaEngine } = await import('./browserMediaEngine');

/** A frame that reports how many live references it has, like a VideoFrame. */
function fakeFrame() {
  const state = { closes: 0, clones: 0 };
  const make = (): { close: () => void; clone: () => unknown } => ({
    close: () => {
      state.closes += 1;
    },
    clone: () => {
      state.clones += 1;
      return make();
    },
  });
  return { state, frame: make() };
}

function canvas(width = 320, height = 180): HTMLCanvasElement {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

beforeEach(() => {
  decoders.length = 0;
  renderers.length = 0;
});

describe('BrowserMediaEngine video subscription sharing', () => {
  it('builds one decoder for a track two surfaces are watching', () => {
    const engine = new BrowserMediaEngine();
    const tile = canvas();
    const thumbnail = canvas(64, 36);

    const releaseTile = engine.subscribeVideo('7', tile, undefined, {
      preferredTrackId: 'screen',
    });
    const releaseThumbnail = engine.subscribeVideo('7', thumbnail, undefined, {
      preferredTrackId: 'screen',
    });

    expect(decoders).toHaveLength(1);
    // A surface each, so each keeps its own canvas.
    expect(renderers).toHaveLength(2);
    expect(renderers.every((renderer) => !renderer.destroyed)).toBe(true);

    releaseTile();
    releaseThumbnail();
  });

  it('paints every subscribed surface from the one decoder', () => {
    const engine = new BrowserMediaEngine();
    const releaseA = engine.subscribeVideo('7', canvas(), undefined, {
      preferredTrackId: 'camera',
    });
    const releaseB = engine.subscribeVideo('7', canvas(64, 36), undefined, {
      preferredTrackId: 'camera',
    });

    const { state, frame } = fakeFrame();
    decoders[0].emit(frame);

    expect(renderers[0].rendered).toHaveLength(1);
    expect(renderers[1].rendered).toHaveLength(1);
    // One clone for the extra surface, and both references released.
    expect(state.clones).toBe(1);
    expect(state.closes).toBe(2);

    releaseA();
    releaseB();
  });

  it('signals every surface that a frame landed, not only the first', () => {
    const engine = new BrowserMediaEngine();
    const first = vi.fn();
    const second = vi.fn();
    const releaseA = engine.subscribeVideo('7', canvas(), first, {
      preferredTrackId: 'camera',
    });
    const releaseB = engine.subscribeVideo('7', canvas(), second, {
      preferredTrackId: 'camera',
    });

    decoders[0].emit(fakeFrame().frame);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    releaseA();
    releaseB();
  });

  it('keeps the decoder alive while any surface is left, and retires it with the last', () => {
    const engine = new BrowserMediaEngine();
    const releaseTile = engine.subscribeVideo('7', canvas(), undefined, {
      preferredTrackId: 'screen',
    });
    const releaseThumbnail = engine.subscribeVideo('7', canvas(64, 36), undefined, {
      preferredTrackId: 'screen',
    });

    releaseThumbnail();
    expect(decoders[0].closed).toBe(false);
    expect(renderers[1].destroyed).toBe(true);
    // The surface that is still watching keeps painting.
    decoders[0].emit(fakeFrame().frame);
    expect(renderers[0].rendered).toHaveLength(1);

    releaseTile();
    expect(decoders[0].closed).toBe(true);
    expect(renderers[0].destroyed).toBe(true);
  });

  it('re-subscribing the same surface does not build a second decoder', () => {
    const engine = new BrowserMediaEngine();
    const surface = canvas();
    const first = engine.subscribeVideo('7', surface, undefined, { preferredTrackId: 'camera' });
    first();
    const second = engine.subscribeVideo('7', surface, undefined, { preferredTrackId: 'camera' });
    second();
    // One per subscription generation — never one per render.
    expect(decoders).toHaveLength(2);
    expect(renderers.every((renderer) => renderer.destroyed)).toBe(true);
  });

  it('destroys every renderer when the publisher leaves, rather than clearing it', () => {
    // `clear()` paints the canvas black and keeps the WebGL programs, the four
    // textures, the I420 worker and the animation frame alive: somebody who
    // left on camera *and* sharing took two leaked GL contexts with them.
    const engine = new BrowserMediaEngine();
    engine.subscribeVideo('7', canvas(), undefined, { preferredTrackId: 'camera' });
    engine.subscribeVideo('7', canvas(64, 36), undefined, { preferredTrackId: 'camera' });
    engine.subscribeVideo('7', canvas(), undefined, { preferredTrackId: 'screen' });

    (engine as unknown as { removeRemoteParticipantState(userId: string): void })
      .removeRemoteParticipantState('7');

    expect(renderers).toHaveLength(3);
    expect(renderers.every((renderer) => renderer.destroyed)).toBe(true);
    expect(renderers.every((renderer) => renderer.cleared === 0)).toBe(true);
    expect(decoders.every((decoder) => decoder.closed)).toBe(true);
  });
});
