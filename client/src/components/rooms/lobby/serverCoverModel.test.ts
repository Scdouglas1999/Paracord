import { describe, expect, it } from 'vitest';

import { coverRecipe, coverStyle, identityTone, toneFromPixels } from './serverCoverModel';

function pixels(rgba: [number, number, number, number], count = 16): number[] {
  return Array.from({ length: count }, () => rgba).flat();
}

describe('toneFromPixels', () => {
  it('reads the hue of a coloured icon', () => {
    const red = toneFromPixels(pixels([220, 40, 40, 255]));
    expect(red).not.toBeNull();
    // OKLCH red sits near 25–30°.
    expect(red!.hue).toBeGreaterThan(15);
    expect(red!.hue).toBeLessThan(40);
    const teal = toneFromPixels(pixels([38, 104, 92, 255]));
    expect(teal!.hue).toBeGreaterThan(160);
    expect(teal!.hue).toBeLessThan(200);
  });

  it('lets the logo win over the white it sits on', () => {
    const mixed = [...pixels([255, 255, 255, 255], 48), ...pixels([40, 90, 220, 255], 16)];
    const tone = toneFromPixels(mixed);
    expect(tone!.hue).toBeGreaterThan(240);
    expect(tone!.hue).toBeLessThan(280);
  });

  it('has nothing to say about a grey or empty icon', () => {
    expect(toneFromPixels(pixels([128, 128, 128, 255]))).toBeNull();
    expect(toneFromPixels(pixels([220, 40, 40, 0]))).toBeNull();
    expect(toneFromPixels([])).toBeNull();
  });

  it('keeps chroma soft', () => {
    const loud = toneFromPixels(pixels([255, 0, 255, 255]));
    expect(loud!.chroma).toBeLessThanOrEqual(0.13);
  });
});

describe('coverRecipe', () => {
  it('is the same picture every time for the same server', () => {
    const tone = { hue: 200, chroma: 0.09 };
    expect(coverRecipe('360900378855739392', tone)).toEqual(coverRecipe('360900378855739392', tone));
  });

  it('is a different picture for a different server', () => {
    const tone = { hue: 200, chroma: 0.09 };
    expect(coverRecipe('360900378855739392', tone)).not.toEqual(coverRecipe('360900876207919104', tone));
  });

  it('keeps its lights away from the lower left, where the head sits', () => {
    for (const id of ['1', '42', '360900378855739392', '999999999999999999']) {
      const [first, second, third] = coverRecipe(id, identityTone(id)).lights;
      expect(first.x).toBeGreaterThanOrEqual(60);
      expect(second.y).toBeLessThanOrEqual(15);
      expect(third.x).toBeGreaterThanOrEqual(86);
    }
  });
});

describe('coverStyle', () => {
  it('hands the stylesheet numbers, never a colour', () => {
    const style = coverStyle(coverRecipe('7', { hue: 350, chroma: 0.1 }));
    for (const value of Object.values(style)) {
      expect(value).not.toMatch(/#|rgb|hsl|oklch/);
    }
    expect(style['--cover-hue']).toBe('350');
    // Hue shifts wrap around the circle.
    for (const key of ['--cover-h1', '--cover-h2', '--cover-h3']) {
      const hue = Number(style[key]);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});
