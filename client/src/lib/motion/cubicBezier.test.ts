import { describe, expect, it } from 'vitest';

import { cubicBezier } from './cubicBezier';

describe('cubicBezier', () => {
  it('is the CSS curve: ends pinned, and the spring curve front-loaded', () => {
    const ease = cubicBezier(0.32, 0.72, 0, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeGreaterThan(0.85);
    const straight = cubicBezier(0.25, 0.25, 0.75, 0.75);
    expect(straight(0.3)).toBeCloseTo(0.3, 3);
  });
});
