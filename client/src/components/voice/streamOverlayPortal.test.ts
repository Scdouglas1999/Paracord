import { describe, expect, it } from 'vitest';
import { measureAnchoredOverlay } from './streamOverlayPortal';

describe('measureAnchoredOverlay', () => {
  it('places below-start panels under the anchor and clamps into the viewport', () => {
    const coords = measureAnchoredOverlay(
      { left: 4, right: 40, top: 10, bottom: 30, width: 36, height: 20, x: 4, y: 10, toJSON: () => ({}) },
      { placement: 'below-start', panelWidth: 200 },
    );
    expect(coords).toEqual({ top: 38, left: 8 });
  });

  it('places above-end panels above the anchor using bottom offsets', () => {
    // jsdom window is typically 1024x768
    const coords = measureAnchoredOverlay(
      { left: 800, right: 880, top: 700, bottom: 740, width: 80, height: 40, x: 800, y: 700, toJSON: () => ({}) },
      { placement: 'above-end', panelWidth: 240 },
    );
    expect(coords.bottom).toBe(Math.max(8, window.innerHeight - 700 + 8));
    expect(coords.left).toBeGreaterThanOrEqual(8);
    expect(coords.left + 240).toBeLessThanOrEqual(window.innerWidth - 8);
  });
});
