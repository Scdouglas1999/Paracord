import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Glass token contract (docs/glass-spec.md §2, §9) as a file-level test:
 * jsdom does not resolve `color-mix()`, so the numbers are checked in the
 * stylesheet, and the resolved surfaces by `npm run test:contrast`.
 */
const read = (file: string) => readFileSync(resolve(process.cwd(), 'src/styles', file), 'utf8');
const tokens = read('tokens.css');
const glass = read('glass.css');

const decl = (name: string) => {
  const m = tokens.match(new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm'));
  return m ? m[1].trim() : null;
};

describe('Glass tokens', () => {
  it('declares the room channel triplet and the seven surfaces of §2.1', () => {
    expect(decl('--room-rgb')).toMatch(/^\d+, \d+, \d+$/);
    for (const name of ['--pane', '--bub', '--raise', '--sel', '--deep', '--solid', '--glow']) {
      expect(decl(name), name).toMatch(/^color-mix\(in srgb,/);
      expect(decl(name), name).toContain('var(--room-rgb)');
    }
  });

  it('never mixes more than 6% of the room into a surface', () => {
    const cap = 6;
    for (const name of ['--glass-tint-base', '--glass-tint-lift']) {
      const pct = Number.parseFloat(decl(name) ?? 'NaN');
      expect(pct, name).toBeGreaterThan(0);
      expect(pct, name).toBeLessThanOrEqual(cap);
    }
  });

  it('holds the ink ramp of §2.2', () => {
    expect(decl('--ink-1')).toBe('#f3f5f5');
    expect(decl('--ink-2')).toBe('rgba(240, 243, 243, 0.76)');
    expect(decl('--ink-3')).toBe('rgba(240, 243, 243, 0.64)');
  });

  it('holds the fixed colors, with the action and your bubbles remapped onto the Index cream', () => {
    // The 2026-10-03 soft-blue primary is superseded by Index (docs/index-spec.md
    // §2.1): the Glass names stay, their values are the Index block's.
    expect(decl('--own-bub')).toBe('var(--ix-cream)');
    expect(decl('--own-ink')).toBe('var(--ix-cream-ink)');
    expect(decl('--mention-chip')).toBe('#f3f5f5');
    expect(decl('--mention-ink')).toBe('#111214');
    expect(decl('--amber')).toBe('#ffc27e');
    expect(decl('--amber-ink')).toBe('#ffd6a8');
    expect(decl('--join')).toBe('var(--ix-cream)');
    expect(decl('--join-ink')).toBe('var(--ix-cream-ink)');
    expect(decl('--join-hover')).toBe('var(--ix-cream-hover)');
    expect(decl('--join-press')).toBe('var(--ix-cream-press)');
    expect(decl('--accent-danger')).toBe('var(--ix-danger-ink)');
  });

  it('holds the shape and depth of §2.4 and the 40ms timing of §9', () => {
    expect(decl('--r-pane')).toBe('28px');
    expect(decl('--r-bubble')).toBe('20px');
    expect(decl('--r-row')).toBe('16px');
    expect(decl('--r-join')).toBe('6px');
    expect(decl('--sh-content')).toBe('0 1px 2px rgba(0, 0, 0, 0.28)');
    expect(decl('--sh-raised')).toContain('0 10px 28px rgba(0, 0, 0, 0.2)');
    expect(decl('--sh-pane')).toBe('0 40px 90px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.045)');
    expect(decl('--glass-ms')).toBe('40ms');
    expect(decl('--glass-focus-color')).toBe('rgba(255, 255, 255, 0.85)');
    expect(decl('--glass-focus-offset')).toBe('2px');
  });

  it('remaps the Lantern semantic tokens onto Glass', () => {
    expect(decl('--bg-plate')).toBe('var(--solid)');
    expect(decl('--bg-raised')).toBe('var(--bub)');
    expect(decl('--bg-selected')).toBe('var(--sel)');
    expect(decl('--text-primary')).toBe('var(--ink-1)');
    expect(decl('--text-secondary')).toBe('var(--ink-2)');
    expect(decl('--text-faint')).toBe('var(--ink-3)');
    expect(decl('--accent-primary')).toBe('var(--join)');
    expect(decl('--text-on-accent')).toBe('var(--join-ink)');
    expect(decl('--focus-ring-color')).toBe('var(--glass-focus-color)');
  });
});

describe('Glass recipes', () => {
  it('writes no literal color (the token file is the palette)', () => {
    expect(glass).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(/);
  });

  it('never scales on press', () => {
    expect(glass).not.toMatch(/:active[^{]*\{[^}]*transform/);
    expect(glass).not.toMatch(/scale\((?!Y)/);
  });

  it('floors the instrument cut at 12px', () => {
    expect(glass).toMatch(/\.glass-instrument\s*\{[^}]*font-stretch:\s*82%[^}]*font-size:\s*max\(12px/s);
  });

  it('stills nothing through a media query: reduced motion is the data-motion switch', () => {
    expect(glass).not.toMatch(/prefers-reduced-motion/);
  });

  it('draws the focus ring at 2px, offset 2', () => {
    expect(glass).toMatch(/\.glass-focusable:focus-visible\s*\{[^}]*outline:\s*var\(--glass-focus-width\) solid var\(--glass-focus-color\)/s);
  });
});
