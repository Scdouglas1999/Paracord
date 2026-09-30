/**
 * The room's pixel work (docs/glass-spec.md §4), done on a 32x18 grid in
 * JavaScript so the window never pays for it: the backdrop is one small canvas
 * scaled up to the window, and the blur, saturation and brightness the design
 * asks for (`blur(64px) saturate(1.1) brightness(.6)`) are computed here, in the
 * 576 pixels, instead of as a CSS `filter` on a full-window element (which
 * WebKitGTK repaints at full size on every change).
 *
 * All functions are pure over typed arrays, so they are tested in jsdom; the
 * only browser-bound step (drawing a bitmap into a small canvas and reading it
 * back) lives in `analyzeFrame.ts`.
 */
import { roomColorFromAverage, type Rgb } from './color';

/** The backdrop grid: about 32x18 (spec §4), 16:9 like the streams it shows. */
export const ROOM_GRID_WIDTH = 32;
export const ROOM_GRID_HEIGHT = 18;

/**
 * The grid a frame is first drawn into, four source pixels per grid pixel each
 * way. Box-averaging it down to the grid (rather than letting one bilinear
 * `drawImage` pick 4 of every 100 pixels) keeps a moving picture from
 * sparkling: aliasing is exactly the churn the room must not have.
 */
export const ROOM_SAMPLE_SCALE = 4;
export const ROOM_SAMPLE_WIDTH = ROOM_GRID_WIDTH * ROOM_SAMPLE_SCALE;
export const ROOM_SAMPLE_HEIGHT = ROOM_GRID_HEIGHT * ROOM_SAMPLE_SCALE;

/**
 * The blur, as a Gaussian sigma in grid pixels. `blur(64px)` on a 1440px
 * window is a sigma of 64px; one grid pixel there is 45px, so 1.4 grid pixels,
 * and the grid scales with the window so the look does too.
 */
export const ROOM_BLUR_SIGMA = 1.4;

/**
 * The backdrop never gets brighter than 60% white, whatever it shows. The
 * panes are 94% opaque over it, and `scripts/contrast-audit.mjs` measures ink
 * on them over exactly this worst case.
 */
export const ROOM_BACKDROP_VALUE_MAX = 0.6;

/** How a source is graded. Streams follow spec §4; stills follow the reference renders. */
export interface RoomGrade {
  saturation: number;
  brightness: number;
}

/** A live stream: `saturate(1.1) brightness(.6)` (spec §4). */
export const STREAM_GRADE: RoomGrade = { saturation: 1.1, brightness: 0.6 };
/**
 * A banner or icon: `saturate(1.25) brightness(.85)`, the prototype's grade for
 * the banner-lit room (`GlassV14Quiet`), then held under the same 60% ceiling.
 */
export const STILL_GRADE: RoomGrade = { saturation: 1.25, brightness: 0.85 };

/** One frame, analyzed: the backdrop grid (RGB, 0..255 floats) and the room color. */
export interface RoomAnalysis {
  /** `ROOM_GRID_WIDTH * ROOM_GRID_HEIGHT * 3` values, row-major RGB. */
  grid: Float32Array;
  /** The clamped room color for `--room-rgb`. */
  color: Rgb;
}

/**
 * Average `scale x scale` blocks of an RGBA sample (as `getImageData` returns
 * it) down to an RGB grid. Transparent pixels (a logo's background) count by
 * their alpha, so an icon's own color is what it averages to.
 */
export function boxDownsample(
  rgba: Uint8ClampedArray | Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  width = ROOM_GRID_WIDTH,
  height = ROOM_GRID_HEIGHT,
): Float32Array {
  const out = new Float32Array(width * height * 3);
  const weights = new Float32Array(width * height);
  const xScale = width / sourceWidth;
  const yScale = height / sourceHeight;
  for (let y = 0; y < sourceHeight; y += 1) {
    const gy = Math.min(height - 1, Math.floor(y * yScale));
    for (let x = 0; x < sourceWidth; x += 1) {
      const gx = Math.min(width - 1, Math.floor(x * xScale));
      const i = (y * sourceWidth + x) * 4;
      const a = rgba[i + 3] / 255;
      if (a === 0) continue;
      const cell = gy * width + gx;
      out[cell * 3] += rgba[i] * a;
      out[cell * 3 + 1] += rgba[i + 1] * a;
      out[cell * 3 + 2] += rgba[i + 2] * a;
      weights[cell] += a;
    }
  }
  for (let cell = 0; cell < width * height; cell += 1) {
    const w = weights[cell];
    if (w > 0) {
      out[cell * 3] /= w;
      out[cell * 3 + 1] /= w;
      out[cell * 3 + 2] /= w;
    }
  }
  return out;
}

/** A normalized 1-D Gaussian kernel for `sigma` (radius = ceil(3 sigma)). */
export function gaussianKernel(sigma: number): Float32Array {
  if (!(sigma > 0)) return Float32Array.of(1);
  const radius = Math.ceil(sigma * 3);
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i += 1) {
    const value = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = value;
    sum += value;
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] /= sum;
  return kernel;
}

/**
 * Separable Gaussian blur of an RGB grid, edges clamped (the picture extends
 * past the window rather than fading to black at its edge). `sigma <= 0`
 * returns a copy: reduced transparency uses no blur anywhere (spec §4).
 */
export function blurGrid(grid: Float32Array, width: number, height: number, sigma: number): Float32Array {
  if (!(sigma > 0)) return grid.slice();
  const kernel = gaussianKernel(sigma);
  const radius = (kernel.length - 1) / 2;
  const pass = new Float32Array(grid.length);
  const out = new Float32Array(grid.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sx = Math.min(width - 1, Math.max(0, x + k));
        const w = kernel[k + radius];
        const i = (y * width + sx) * 3;
        r += grid[i] * w;
        g += grid[i + 1] * w;
        b += grid[i + 2] * w;
      }
      const o = (y * width + x) * 3;
      pass[o] = r;
      pass[o + 1] = g;
      pass[o + 2] = b;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sy = Math.min(height - 1, Math.max(0, y + k));
        const w = kernel[k + radius];
        const i = (sy * width + x) * 3;
        r += pass[i] * w;
        g += pass[i + 1] * w;
        b += pass[i + 2] * w;
      }
      const o = (y * width + x) * 3;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
    }
  }
  return out;
}

/**
 * CSS `saturate(s) brightness(b)` on every grid pixel (the Filter Effects
 * matrices, in that order), then the 60% ceiling: a pixel brighter than
 * {@link ROOM_BACKDROP_VALUE_MAX} is scaled down, keeping its hue.
 */
export function gradeGrid(grid: Float32Array, grade: RoomGrade): Float32Array {
  const s = grade.saturation;
  const out = new Float32Array(grid.length);
  const cap = ROOM_BACKDROP_VALUE_MAX * 255;
  for (let i = 0; i < grid.length; i += 3) {
    const r = grid[i];
    const g = grid[i + 1];
    const b = grid[i + 2];
    let nr = (0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b;
    let ng = (0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b;
    let nb = (0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b;
    nr = Math.min(255, Math.max(0, nr * grade.brightness));
    ng = Math.min(255, Math.max(0, ng * grade.brightness));
    nb = Math.min(255, Math.max(0, nb * grade.brightness));
    const max = Math.max(nr, ng, nb);
    if (max > cap) {
      const k = cap / max;
      nr *= k;
      ng *= k;
      nb *= k;
    }
    out[i] = nr;
    out[i + 1] = ng;
    out[i + 2] = nb;
  }
  return out;
}

/**
 * The frame's average color, each pixel weighted by how colorful and how lit
 * it is, so the lamp in a dark cave decides the room's color rather than the
 * cave: a plain mean of a mostly dark frame is gray.
 */
export function vividAverage(grid: Float32Array): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  let total = 0;
  for (let i = 0; i < grid.length; i += 3) {
    const pr = grid[i];
    const pg = grid[i + 1];
    const pb = grid[i + 2];
    const max = Math.max(pr, pg, pb);
    const min = Math.min(pr, pg, pb);
    const chroma = (max - min) / 255;
    const value = max / 255;
    const weight = 0.05 + chroma * 2 + value * 0.5;
    r += pr * weight;
    g += pg * weight;
    b += pb * weight;
    total += weight;
  }
  if (total === 0) return [0, 0, 0];
  return [r / total, g / total, b / total];
}

/**
 * Analyze a frame already drawn into an RGBA sample of any size: downsample to
 * the grid, measure the room color on the unblurred grid (the blur only mixes
 * what is there), then blur and grade the grid for the backdrop.
 */
export function analyzeSample(
  rgba: Uint8ClampedArray | Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  options: { grade: RoomGrade; blurSigma: number },
): RoomAnalysis {
  const raw = boxDownsample(rgba, sourceWidth, sourceHeight);
  const color = roomColorFromAverage(vividAverage(raw));
  const blurred = blurGrid(raw, ROOM_GRID_WIDTH, ROOM_GRID_HEIGHT, options.blurSigma);
  return { grid: gradeGrid(blurred, options.grade), color };
}
