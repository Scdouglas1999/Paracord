/**
 * The generated cover for a server with no banner (docs/server-home-spec.md,
 * "Cover").
 *
 * This is the designed look for "no banner", not an error state. It is layered
 * soft light over a ground, and every part of it is fixed by two facts about
 * the server: the color of its icon, and its id. Open the page a hundred times
 * and it is the same picture; open a different server and it is a different
 * one. No randomness, no clock.
 *
 * The color is a hue and a chroma, never a literal: the lightness of each
 * layer comes from the theme (`--cover-*` in `tokens.css`), so the same server
 * reads as a dusk sky on Slate and a watercolour wash on Daylight.
 *
 * Pure: no DOM, no React. `useIconTone` does the pixel reading.
 */

import { identityIndex } from '../../../lib/colors';

/** Hue (OKLCH degrees) and chroma of a server's color. */
export interface CoverTone {
  hue: number;
  chroma: number;
}

/** One soft light on the cover, placed by the id. Percentages of the cover box. */
export interface CoverLight {
  x: number;
  y: number;
  /** Radius, as a percentage of the cover's width. */
  size: number;
  /** Degrees away from the server's own hue, so the lights are a family. */
  hueShift: number;
}

export interface CoverRecipe {
  hue: number;
  chroma: number;
  /** Direction of the ground's gradient. */
  angle: number;
  lights: [CoverLight, CoverLight, CoverLight];
}

/**
 * The OKLCH hues of the eight identity colors (`--color-avatar-1…8`), in
 * palette order. A server with no icon wears its identity color as its mark,
 * so that is the color its cover is made of.
 */
const IDENTITY_HUES = [66, 258, 168, 32, 309, 97, 212, 349] as const;
const IDENTITY_CHROMA = 0.09;

/** Chroma is kept in a band that stays soft on every theme. */
const MIN_CHROMA = 0.025;
const MAX_CHROMA = 0.13;

export function identityTone(guildId: string): CoverTone {
  return { hue: IDENTITY_HUES[identityIndex(guildId)], chroma: IDENTITY_CHROMA };
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** sRGB (0–255) → OKLab. Björn Ottosson's matrices. */
function toOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/**
 * The color of an icon, from its pixels (RGBA, row-major, as a canvas hands
 * them back).
 *
 * Averaged in OKLab and weighted by each pixel's own chroma and opacity, so a
 * logo's color wins over the white or black it sits on, and transparent
 * corners count for nothing. Returns null when the icon has no color to give:
 * fully transparent, or gray all the way through.
 */
export function toneFromPixels(data: ArrayLike<number>): CoverTone | null {
  let sumA = 0;
  let sumB = 0;
  let weight = 0;
  let chromaSum = 0;
  let opaque = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    if (alpha < 0.1) continue;
    const [, a, b] = toOklab(data[i], data[i + 1], data[i + 2]);
    const chroma = Math.hypot(a, b);
    opaque += alpha;
    chromaSum += chroma * alpha;
    const w = chroma * alpha;
    sumA += a * w;
    sumB += b * w;
    weight += w;
  }
  if (opaque === 0 || weight < 1e-6) return null;
  const meanChroma = chromaSum / opaque;
  if (meanChroma < 0.012) return null;
  let hue = (Math.atan2(sumB / weight, sumA / weight) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  const chroma = Math.min(MAX_CHROMA, Math.max(MIN_CHROMA, meanChroma * 0.9));
  return { hue: Math.round(hue), chroma: Number(chroma.toFixed(3)) };
}

/**
 * A small, stable integer stream from a snowflake (FNV-1a, then xorshift).
 * Not for anything secret: it only has to spread positions evenly and be the
 * same on every machine.
 */
function seedStream(id: string): () => number {
  let state = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    state ^= id.charCodeAt(i);
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

function between(next: () => number, low: number, high: number): number {
  return Math.round(low + next() * (high - low));
}

/**
 * The cover's recipe: the tone, plus where its three lights sit.
 *
 * The lights are kept out of the lower-left, where the server's icon and name
 * overlap the cover, so the brightest part of the picture never sits behind
 * the text.
 */
export function coverRecipe(guildId: string, tone: CoverTone): CoverRecipe {
  const next = seedStream(guildId);
  const angle = between(next, 150, 210);
  const lights: [CoverLight, CoverLight, CoverLight] = [
    { x: between(next, 60, 90), y: between(next, 5, 40), size: between(next, 34, 48), hueShift: between(next, -44, -22) },
    { x: between(next, 26, 52), y: between(next, -15, 15), size: between(next, 30, 40), hueShift: between(next, 22, 48) },
    { x: between(next, 86, 104), y: between(next, 50, 85), size: between(next, 20, 30), hueShift: between(next, -8, 8) },
  ];
  return { hue: tone.hue, chroma: tone.chroma, angle, lights };
}

/**
 * The recipe as custom properties for the `.pc-home-cover-made` recipe in
 * `styles/server-home.css`. Numbers and percentages only; the colors are
 * assembled there, out of theme tokens.
 */
export function coverStyle(recipe: CoverRecipe): Record<string, string> {
  const style: Record<string, string> = {
    '--cover-hue': String(recipe.hue),
    '--cover-chroma': String(recipe.chroma),
    '--cover-angle': `${recipe.angle}deg`,
  };
  recipe.lights.forEach((light, index) => {
    const n = index + 1;
    style[`--cover-x${n}`] = `${light.x}%`;
    style[`--cover-y${n}`] = `${light.y}%`;
    style[`--cover-r${n}`] = `${light.size}%`;
    style[`--cover-h${n}`] = String((recipe.hue + light.hueShift + 360) % 360);
  });
  return style;
}
