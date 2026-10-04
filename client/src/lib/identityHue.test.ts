import { describe, expect, it } from 'vitest';

import { PALETTE_HUES, PEOPLE_HUE, isHue, paletteHue, serverHue } from './identityHue';

/** A snowflake-shaped decimal string (19 digits), from a seed. */
function snowflake(seed: number): string {
  // Mix the seed into 19 decimal digits without leaving safe-integer range.
  const a = (seed * 2654435761) % 1_000_000_000;
  const b = (seed * 40503 + 12345) % 1_000_000_000;
  return `${(a % 9) + 1}${String(a).padStart(9, '0')}${String(b).padStart(9, '0')}`;
}

describe('palette', () => {
  it('is the curated list: eleven hues, none of them purple', () => {
    expect([...PALETTE_HUES]).toEqual([350, 8, 22, 36, 150, 162, 176, 190, 200, 214, 226]);
    for (const hue of PALETTE_HUES) {
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThanOrEqual(359);
      expect(hue < 250 || hue > 320).toBe(true);
    }
    expect(new Set(PALETTE_HUES).size).toBe(PALETTE_HUES.length);
  });

  it('keeps People at 210', () => {
    expect(PEOPLE_HUE).toBe(210);
  });
});

describe('paletteHue', () => {
  it('is index = last nine digits mod 11 onto the list', () => {
    // 0 mod 11 = 0, 1 mod 11 = 1, 10 mod 11 = 10, 11 mod 11 = 0.
    expect(paletteHue('0')).toBe(350);
    expect(paletteHue('1')).toBe(8);
    expect(paletteHue('10')).toBe(226);
    expect(paletteHue('11')).toBe(350);
    // Only the last nine digits count: the leading digits are ignored.
    expect(paletteHue('9000000000000000005')).toBe(paletteHue('000000005'));
    expect(paletteHue('9000000000000000005')).toBe(162);
    // 123456789 = 11 * 11223344 + 5.
    expect(paletteHue('123456789')).toBe(162);
  });

  it('is deterministic', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = snowflake(i);
      expect(paletteHue(id)).toBe(paletteHue(id));
    }
  });

  it('never returns a purple (250 to 320), for decimal and non-decimal ids alike', () => {
    for (let i = 0; i < 5000; i += 1) {
      const decimal = snowflake(i);
      const other = `user-${i}-${(i * 7919).toString(36)}`;
      for (const hue of [paletteHue(decimal), paletteHue(other)]) {
        expect(hue >= 250 && hue <= 320, `${decimal} / ${other} -> ${hue}`).toBe(false);
        expect(PALETTE_HUES).toContain(hue);
      }
    }
  });

  it('uses every hue in the list across a spread of ids', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i += 1) seen.add(paletteHue(snowflake(i)));
    expect([...seen].sort((a, b) => a - b)).toEqual([...PALETTE_HUES].sort((a, b) => a - b));
  });

  it('still answers for an empty or non-decimal id', () => {
    expect(PALETTE_HUES).toContain(paletteHue(''));
    expect(PALETTE_HUES).toContain(paletteHue('me'));
    expect(PALETTE_HUES).toContain(paletteHue('local-account'));
    expect(paletteHue('me')).toBe(paletteHue('me'));
  });
});

describe('isHue', () => {
  it('accepts integers 0 to 359 only', () => {
    expect(isHue(0)).toBe(true);
    expect(isHue(359)).toBe(true);
    expect(isHue(210)).toBe(true);
    for (const bad of [-1, 360, 12.5, Number.NaN, Infinity, '200', null, undefined]) {
      expect(isHue(bad), String(bad)).toBe(false);
    }
  });
});

describe('serverHue', () => {
  it("uses the server's own hue when it has one", () => {
    expect(serverHue({ id: '123', hue: 200 })).toBe(200);
    expect(serverHue({ id: '123', hue: 0 })).toBe(0);
    expect(serverHue({ id: '123', hue: 359 })).toBe(359);
    // A matched icon can land on a purple: an explicit choice is honored.
    expect(serverHue({ id: '123', hue: 280 })).toBe(280);
  });

  it('falls back to the id-derived default when unset, null or invalid', () => {
    const fallback = paletteHue('123');
    expect(serverHue({ id: '123' })).toBe(fallback);
    expect(serverHue({ id: '123', hue: null })).toBe(fallback);
    expect(serverHue({ id: '123', hue: 360 })).toBe(fallback);
    expect(serverHue({ id: '123', hue: -4 })).toBe(fallback);
    expect(serverHue({ id: '123', hue: 12.5 })).toBe(fallback);
  });
});
