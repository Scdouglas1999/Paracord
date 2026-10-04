import { describe, expect, it } from 'vitest';

import { PALETTE_HUES } from '../../lib/identityHue';
import { ICON_SAMPLE } from './iconPixels';
import { SERVER_COLOR_SWATCHES, dominantHue, swatchName } from './serverColor';

/**
 * A fixture icon at the size the field reads (32x32 RGBA): a field color, a disc of
 * a logo color on it, and a white letter's worth of pixels on the disc. The same
 * thing a real icon is, without a decoder: jsdom has no canvas.
 */
function icon(options: {
  field: [number, number, number, number];
  disc?: [number, number, number, number];
  discShare?: number;
  letter?: [number, number, number, number];
}): Uint8ClampedArray {
  const size = ICON_SAMPLE;
  const data = new Uint8ClampedArray(size * size * 4);
  const center = (size - 1) / 2;
  const radius = (size / 2) * Math.sqrt(options.discShare ?? 0.6);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inDisc = options.disc && Math.hypot(x - center, y - center) <= radius;
      const inLetter = inDisc && options.letter && Math.abs(x - center) < 2 && Math.abs(y - center) < 6;
      const px = (inLetter ? options.letter : inDisc ? options.disc : options.field) as number[];
      data.set(px, (y * size + x) * 4);
    }
  }
  return data;
}

const hueNear = (actual: number | null, expected: number, tolerance = 6) => {
  expect(actual).not.toBeNull();
  const away = Math.abs((((actual as number) - expected + 540) % 360) - 180);
  expect(away).toBeLessThanOrEqual(tolerance);
};

describe('the swatches', () => {
  it('are the eleven palette hues, in order, each named', () => {
    expect(SERVER_COLOR_SWATCHES.map((s) => s.hue)).toEqual([...PALETTE_HUES]);
    expect(SERVER_COLOR_SWATCHES).toHaveLength(11);
    expect(new Set(SERVER_COLOR_SWATCHES.map((s) => s.name)).size).toBe(11);
  });

  it('name a hue, and say nothing for one that is not on the palette', () => {
    expect(swatchName(176)).toBe('Teal');
    expect(swatchName(195)).toBeNull();
    expect(swatchName(null)).toBeNull();
  });
});

describe('dominantHue', () => {
  it('reads the color of a logo disc on a transparent field', () => {
    // hsl(176 70% 40%): a teal logo.
    const data = icon({ field: [0, 0, 0, 0], disc: [31, 173, 161, 255], letter: [255, 255, 255, 255] });
    hueNear(dominantHue(data), 176);
  });

  it('prefers the logo to the white field it sits on', () => {
    const data = icon({ field: [255, 255, 255, 255], disc: [214, 66, 66, 255], discShare: 0.3 });
    hueNear(dominantHue(data), 0, 4);
  });

  it('takes the stronger of two colors, never their blend', () => {
    // A mostly-blue logo with a red stripe: the answer is blue, not the purple between them.
    const data = icon({ field: [38, 98, 214, 255] });
    for (let i = 0; i < 200; i += 1) data.set([214, 44, 44, 255], i * 4);
    const hue = dominantHue(data) as number;
    hueNear(hue, 219, 6);
    expect(hue).not.toBeGreaterThan(260);
  });

  it('wraps around the red end of the wheel', () => {
    const data = icon({ field: [0, 0, 0, 0], disc: [220, 60, 90, 255] }); // about 348
    hueNear(dominantHue(data), 348, 6);
  });

  it('has nothing to give a gray, white, black or fully transparent icon', () => {
    expect(dominantHue(icon({ field: [128, 128, 128, 255] }))).toBeNull();
    expect(dominantHue(icon({ field: [255, 255, 255, 255] }))).toBeNull();
    expect(dominantHue(icon({ field: [0, 0, 0, 255] }))).toBeNull();
    expect(dominantHue(icon({ field: [200, 30, 30, 0] }))).toBeNull();
    expect(dominantHue(new Uint8ClampedArray(0))).toBeNull();
  });

  it('is deterministic', () => {
    const data = icon({ field: [20, 20, 24, 255], disc: [40, 180, 90, 255] });
    expect(dominantHue(data)).toBe(dominantHue(data));
  });
});
