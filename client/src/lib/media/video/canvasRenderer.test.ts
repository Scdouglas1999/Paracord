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
