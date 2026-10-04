/**
 * Server color (docs/index-spec.md §2.2, §8.3): the model behind the field in
 * Server settings › Overview. An admin picks one of the eleven palette hues, or
 * asks for the one an icon is already wearing ("Match icon"); the number is what
 * the server stores (`spaces.hue`, 0–359) and every window tint is built from it.
 *
 * Pure except `readIconHue`, which asks `iconPixels.ts` (a browser's decoder and a canvas) for the icon's pixels.
 */
import { PALETTE_HUES } from '../../lib/identityHue';
import { readIconPixels } from './iconPixels';

/**
 * The eleven swatches, in the palette's own order (rose, through the warm reds
 * and oranges, the greens and teals, to the blues). The names are what a screen
 * reader says: a color is never the only cue.
 */
export const SERVER_COLOR_SWATCHES: readonly { hue: number; name: string }[] = [
  { hue: PALETTE_HUES[0], name: 'Rose' },
  { hue: PALETTE_HUES[1], name: 'Coral' },
  { hue: PALETTE_HUES[2], name: 'Orange' },
  { hue: PALETTE_HUES[3], name: 'Gold' },
  { hue: PALETTE_HUES[4], name: 'Green' },
  { hue: PALETTE_HUES[5], name: 'Jade' },
  { hue: PALETTE_HUES[6], name: 'Teal' },
  { hue: PALETTE_HUES[7], name: 'Cyan' },
  { hue: PALETTE_HUES[8], name: 'Sky' },
  { hue: PALETTE_HUES[9], name: 'Blue' },
  { hue: PALETTE_HUES[10], name: 'Cobalt' },
];

/** The swatch's name for a hue, or null for one that is not on the palette (a matched icon's). */
export function swatchName(hue: number | null | undefined): string | null {
  return SERVER_COLOR_SWATCHES.find((swatch) => swatch.hue === hue)?.name ?? null;
}

/** Hue histogram bin, in degrees. */
const BIN = 5;
const BINS = 360 / BIN;
/** A pixel counts only with this much opacity... */
const MIN_ALPHA = 0.4;
/** ...and this much chroma (max - min over 255): grays, whites and blacks carry no hue. */
const MIN_CHROMA = 0.1;
/** The icon must have at least this share of its opaque pixels in color, or it has no color to match. */
const MIN_COLORFUL_SHARE = 0.04;

/** Hue (0–359), chroma (0–1) and lightness (0–1) of an sRGB triplet, in HSL. */
function hslOf(r: number, g: number, b: number): { hue: number; chroma: number; lightness: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = (max - min) / 255;
  const lightness = (max + min) / 510;
  if (chroma === 0) return { hue: 0, chroma: 0, lightness };
  const d = max - min;
  let hue: number;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { hue, chroma, lightness };
}

/**
 * The dominant hue of an icon, from its pixels (RGBA, row-major, as a canvas
 * hands them back); null when it has none to give (transparent, or gray, white
 * or black all the way through).
 *
 * A pixel votes for its hue with a weight of its chroma, its opacity and how far
 * it is from white and black, so a logo's color beats the field it sits on and
 * antialiased edges count for little. The votes go in a 5-degree histogram that is
 * smoothed over its neighbors; the answer is the heaviest bin, refined to the
 * weighted mean of the votes within 20 degrees of it. A mean over the whole wheel
 * would turn a red and blue logo purple (no one's color); the peak does not.
 */
export function dominantHue(data: ArrayLike<number>): number | null {
  const votes = new Float64Array(BINS);
  let opaque = 0;
  let colorful = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    if (alpha < MIN_ALPHA) continue;
    opaque += 1;
    const { hue, chroma, lightness } = hslOf(data[i], data[i + 1], data[i + 2]);
    if (chroma < MIN_CHROMA) continue;
    colorful += 1;
    // Mid lightness votes most; near-white and near-black tints are mostly the field.
    const weight = chroma * alpha * (1 - Math.abs(2 * lightness - 1) ** 2);
    if (weight <= 0) continue;
    votes[Math.floor(hue / BIN) % BINS] += weight;
  }
  if (opaque === 0 || colorful / opaque < MIN_COLORFUL_SHARE) return null;

  let best = -1;
  let bestScore = 0;
  for (let bin = 0; bin < BINS; bin += 1) {
    const score = votes[bin] * 2 + votes[(bin + BINS - 1) % BINS] + votes[(bin + 1) % BINS];
    if (score > bestScore) {
      bestScore = score;
      best = bin;
    }
  }
  if (best < 0) return null;

  // Refine: the circular mean of every vote within 20 degrees of the peak.
  const center = best * BIN + BIN / 2;
  let sin = 0;
  let cos = 0;
  for (let bin = 0; bin < BINS; bin += 1) {
    const at = bin * BIN + BIN / 2;
    const away = Math.abs(((at - center + 540) % 360) - 180);
    if (away > 20) continue;
    const radians = (at * Math.PI) / 180;
    sin += votes[bin] * Math.sin(radians);
    cos += votes[bin] * Math.cos(radians);
  }
  let hue = Math.round((Math.atan2(sin, cos) * 180) / Math.PI);
  if (hue < 0) hue += 360;
  return hue % 360;
}

export type IconHueResult =
  | { ok: true; hue: number }
  | { ok: false; reason: 'unreadable' | 'colorless' };

/**
 * "Match icon": the dominant hue of the icon, computed here, once, on the admin's
 * client; the number is what gets saved. A failure says which kind it was, so the
 * field can tell the admin (never a silent fallback to some other color).
 */
export async function readIconHue(src: string): Promise<IconHueResult> {
  const pixels = await readIconPixels(src);
  if (!pixels) return { ok: false, reason: 'unreadable' };
  const hue = dominantHue(pixels);
  return hue === null ? { ok: false, reason: 'colorless' } : { ok: true, hue };
}
