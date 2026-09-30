import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasRenderer } from './canvasRenderer';

/** A fake 2d context; the renderer only asks for it once it has decided WebGL
 * is unavailable, so returning it strictly for `getContext('2d')` drives the
 * construction-time capability dispatch down the 2D path. */
function fake2dContext() {
  return {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'high',
    fillStyle: '',
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    putImageData: vi.fn(),
  };
}

/** Make `getContext('webgl2' | 'webgl' | 'experimental-webgl')` return null so
 * the renderer probes WebGL as unavailable (as jsdom itself does), while
 * `getContext('2d')` yields a usable fake. */
function mockNoWebgl(canvas: HTMLCanvasElement, ctx: ReturnType<typeof fake2dContext>): void {
  vi.spyOn(canvas, 'getContext').mockImplementation(((contextId: string) =>
    contextId === '2d'
      ? (ctx as unknown as CanvasRenderingContext2D)
      : null) as typeof canvas.getContext);
}

describe('CanvasRenderer', () => {
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    Object.defineProperty(canvas, 'clientWidth', { value: 64, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 64, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls through cleanly to the 2d path when WebGL is unavailable at construction', () => {
    const ctx = fake2dContext();
    mockNoWebgl(canvas, ctx);

    // No throw: the construction-time probe finds no WebGL and uses the 2D
    // context instead, which is why imageSmoothing was configured on it.
    const renderer = new CanvasRenderer(canvas);

    expect(renderer.isDestroyed).toBe(false);
    expect(ctx.imageSmoothingQuality).toBe('low');
    renderer.destroy();
    expect(renderer.isDestroyed).toBe(true);
  });

  it('uses low image smoothing quality on the 2d context', () => {
    const ctx = fake2dContext();
    mockNoWebgl(canvas, ctx);

    new CanvasRenderer(canvas);

    expect(ctx.imageSmoothingQuality).toBe('low');
    expect(ctx.imageSmoothingEnabled).toBe(true);
  });

  it('skips RAF scheduling while rendering is disabled', () => {
    const ctx = fake2dContext();
    mockNoWebgl(canvas, ctx);
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    const renderer = new CanvasRenderer(canvas);
    const imageData = { width: 2, height: 2, data: new Uint8ClampedArray(16) } as ImageData;

    renderer.setRenderingEnabled(false);
    renderer.renderImageData(imageData);

    expect(rafSpy).not.toHaveBeenCalled();

    renderer.setRenderingEnabled(true);
    expect(rafSpy).toHaveBeenCalled();
    renderer.destroy();
  });
});

/**
 * How a frame sits in a canvas of another shape (`fit`). The numbers are what the
 * renderer asks the backend to draw: a 2D `drawImage` destination rectangle, or a
 * GL `viewport`. A 200x100 canvas at a device pixel ratio of 1 throughout.
 */
describe('CanvasRenderer fit', () => {
  const WIDTH = 200;
  const HEIGHT = 100;

  /** Frames wait for an animation frame; the test runs them when it says so. */
  let pendingFrames: FrameRequestCallback[];
  const flush = () => {
    const due = pendingFrames;
    pendingFrames = [];
    for (const callback of due) callback(0);
  };

  function sizedCanvas(width = WIDTH, height = HEIGHT): HTMLCanvasElement {
    const el = document.createElement('canvas');
    Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
    return el;
  }

  /** The frame as a raw pixel image; both backends take the same bytes. */
  function pixels(width: number, height: number): ImageData {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) } as ImageData;
  }

  beforeEach(() => {
    pendingFrames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('on the 2d backend', () => {
    function draw(fit: 'contain' | 'cover' | undefined, frameWidth: number, frameHeight: number, canvasSize: [number, number] = [WIDTH, HEIGHT]) {
      const ctx = fake2dContext();
      // Every canvas the renderer makes (its own, and the buffer it blits from) gets the fake.
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((contextId: string) =>
        contextId === '2d' ? (ctx as unknown as CanvasRenderingContext2D) : null) as typeof HTMLCanvasElement.prototype.getContext);
      const el = sizedCanvas(...canvasSize);
      const renderer = new CanvasRenderer(el, fit === undefined ? undefined : { fit });
      renderer.renderImageData(pixels(frameWidth, frameHeight));
      flush();
      expect(ctx.drawImage).toHaveBeenCalledTimes(1);
      const [, sx, sy, sw, sh, dx, dy, dw, dh] = ctx.drawImage.mock.calls[0] as number[];
      renderer.destroy();
      return { source: { sx, sy, sw, sh }, dest: { dx, dy, dw, dh }, canvas: { width: el.width, height: el.height } };
    }

    it('contains by default: the whole frame, centered, with bars where the shapes differ', () => {
      // 4:3 in 2:1. The height sets the scale: 133x100, 33px of bar either side.
      const { source, dest, canvas } = draw(undefined, 80, 60);
      expect(canvas).toEqual({ width: WIDTH, height: HEIGHT });
      expect(source).toEqual({ sx: 0, sy: 0, sw: 80, sh: 60 });
      expect(dest).toEqual({ dx: 33, dy: 0, dw: 133, dh: 100 });
    });

    it('says contain when asked to, and draws what the default draws', () => {
      expect(draw('contain', 80, 60).dest).toEqual(draw(undefined, 80, 60).dest);
    });

    it('covers: a 4:3 camera fills a 2:1 tile, and the top and bottom are cropped', () => {
      // The width sets the scale: 200x150 drawn, 25px cropped off the top and the bottom.
      const { source, dest, canvas } = draw('cover', 80, 60);
      expect(canvas).toEqual({ width: WIDTH, height: HEIGHT });
      // The whole frame is the source; the crop is the destination running past the canvas.
      expect(source).toEqual({ sx: 0, sy: 0, sw: 80, sh: 60 });
      expect(dest).toEqual({ dx: 0, dy: -25, dw: 200, dh: 150 });
    });

    it('covers a wide frame in a square tile by cropping its sides', () => {
      // 16:9 in 1:1. The height sets the scale: 178x100, 39px cropped off the left and 39 off the right.
      const { dest } = draw('cover', 160, 90, [100, 100]);
      expect(dest).toEqual({ dx: -39, dy: 0, dw: 178, dh: 100 });
    });

    it('is the same as contain for a frame already the canvas’s shape', () => {
      expect(draw('cover', 100, 50).dest).toEqual({ dx: 0, dy: 0, dw: 200, dh: 100 });
      expect(draw('contain', 100, 50).dest).toEqual({ dx: 0, dy: 0, dw: 200, dh: 100 });
    });

    it('never leaves a bar, or a gap of a pixel, whatever the shapes', () => {
      for (const [canvasWidth, canvasHeight] of [[200, 100], [101, 57], [333, 187], [57, 101], [1, 1], [640, 360]] as const) {
        for (const [frameWidth, frameHeight] of [[80, 60], [160, 90], [640, 480], [90, 160], [7, 5], [1920, 1080]] as const) {
          const { dest } = draw('cover', frameWidth, frameHeight, [canvasWidth, canvasHeight]);
          expect(dest.dx, `${frameWidth}x${frameHeight} in ${canvasWidth}x${canvasHeight}`).toBeLessThanOrEqual(0);
          expect(dest.dy).toBeLessThanOrEqual(0);
          expect(dest.dx + dest.dw).toBeGreaterThanOrEqual(canvasWidth);
          expect(dest.dy + dest.dh).toBeGreaterThanOrEqual(canvasHeight);
          // It keeps the frame's shape, to the pixel of rounding on each side (cross-multiplied).
          expect(Math.abs(dest.dw * frameHeight - dest.dh * frameWidth)).toBeLessThanOrEqual(frameWidth + frameHeight);
        }
      }
    });

    it('contain still fits inside the canvas, always', () => {
      for (const [canvasWidth, canvasHeight] of [[200, 100], [101, 57], [57, 101]] as const) {
        for (const [frameWidth, frameHeight] of [[80, 60], [160, 90], [90, 160]] as const) {
          const { dest } = draw('contain', frameWidth, frameHeight, [canvasWidth, canvasHeight]);
          expect(dest.dx).toBeGreaterThanOrEqual(0);
          expect(dest.dy).toBeGreaterThanOrEqual(0);
          expect(dest.dx + dest.dw).toBeLessThanOrEqual(canvasWidth);
          expect(dest.dy + dest.dh).toBeLessThanOrEqual(canvasHeight);
        }
      }
    });

    it('exposes the fit it was built with', () => {
      const ctx = fake2dContext();
      const el = sizedCanvas();
      mockNoWebgl(el, ctx);
      expect(new CanvasRenderer(el).fit).toBe('contain');
      expect(new CanvasRenderer(el, {}).fit).toBe('contain');
      expect(new CanvasRenderer(el, { fit: 'contain' }).fit).toBe('contain');
      expect(new CanvasRenderer(el, { fit: 'cover' }).fit).toBe('cover');
    });
  });

  describe('on the WebGL backend', () => {
    /** A context that accepts every call and remembers where the picture was told to go. */
    function fakeGl() {
      const viewport = vi.fn();
      const target = { viewport } as Record<string, unknown>;
      const gl = new Proxy(target, {
        get(obj, prop: string) {
          if (prop in obj) return obj[prop];
          // Constants (gl.TRIANGLE_STRIP, gl.COMPILE_STATUS...) are numbers; everything else is a call that succeeds.
          if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return 1;
          return () => true;
        },
      });
      return { gl: gl as unknown as WebGLRenderingContext, viewport };
    }

    function draw(fit: 'contain' | 'cover' | undefined, frameWidth: number, frameHeight: number) {
      const { gl, viewport } = fakeGl();
      const el = sizedCanvas();
      vi.spyOn(el, 'getContext').mockImplementation(((contextId: string) =>
        contextId === 'webgl2' || contextId === 'webgl' ? gl : null) as typeof el.getContext);
      const renderer = new CanvasRenderer(el, fit === undefined ? undefined : { fit });
      renderer.drawRgba(new Uint8Array(frameWidth * frameHeight * 4), frameWidth, frameHeight);
      flush();
      renderer.destroy();
      return { calls: viewport.mock.calls as number[][], canvas: { width: el.width, height: el.height } };
    }

    it('contains by default: the viewport is the fitted picture, centered', () => {
      const { calls, canvas } = draw(undefined, 80, 60);
      expect(canvas).toEqual({ width: WIDTH, height: HEIGHT });
      // The bars are cleared over the whole canvas, then the picture goes into the fitted viewport.
      expect(calls).toEqual([[0, 0, 200, 100], [33, 0, 133, 100]]);
    });

    it('covers: the viewport runs past the canvas, which crops it', () => {
      const { calls } = draw('cover', 80, 60);
      // 200x150 drawn, 25px over the top and 25 over the bottom (GL's origin is the bottom: y = 100 - 150 + 25).
      expect(calls).toEqual([[0, 0, 200, 100], [0, -25, 200, 150]]);
    });

    it('is the same as contain for a frame already the canvas’s shape', () => {
      expect(draw('cover', 100, 50).calls).toEqual(draw('contain', 100, 50).calls);
    });
  });
});
