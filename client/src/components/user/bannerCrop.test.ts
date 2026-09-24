import { describe, expect, it } from 'vitest';
import { accentCssColor, clampPan, coverScale, sourceRect } from './bannerCrop';

describe('banner crop', () => {
  it('covers a wide frame with the shorter image edge', () => {
    expect(coverScale(3000, 500, 1500, 500)).toBe(1);
    expect(coverScale(1000, 1000, 1500, 500)).toBe(1.5);
  });

  it('keeps the pan inside the overflow', () => {
    const clamped = clampPan(10_000, -10_000, 1000, 1000, 300, 100, 1);
    expect(clamped.panX).toBe(0);
    expect(clamped.panY).toBe(-100);
  });

  it('maps a centred cover crop back onto the source', () => {
    const rect = sourceRect(1000, 1000, 300, 100, { zoom: 1, panX: 0, panY: 0 });
    expect(rect.sw).toBeCloseTo(1000);
    expect(rect.sh).toBeCloseTo(1000 / 3);
    expect(rect.sx).toBeCloseTo(0);
    expect(rect.sy).toBeCloseTo(1000 / 3);
  });

  it('builds a color from the integer accent and rejects anything else', () => {
    expect(accentCssColor(0x336699)).toBe('#336699');
    expect(accentCssColor(0)).toBe('#000000');
    expect(accentCssColor(null)).toBeNull();
    expect(accentCssColor(0x1000000)).toBeNull();
    expect(accentCssColor(1.5)).toBeNull();
  });
});
