import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Index token contract (docs/index-spec.md §2) as a file-level test: jsdom
 * loads no stylesheet, so the values are read from the sheets. The audits
 * (`npm run test:contrast`, `npm run test:tokens`) check what they mean.
 */
const read = (file: string) => readFileSync(resolve(process.cwd(), 'src/styles', file), 'utf8');
const tokens = read('tokens.css');

/** The Index block: from its banner to the sports field that follows it. */
const indexStart = tokens.indexOf('INDEX (docs/index-spec.md §2)');
const indexEnd = tokens.indexOf('Sports field.');
const indexBlock = tokens.slice(indexStart, indexEnd);

const decl = (name: string, source = indexBlock) => {
  const m = source.match(new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm'));
  return m ? m[1].trim() : null;
};

describe('Index tokens (§2.1)', () => {
  it('has the Index block', () => {
    expect(indexStart).toBeGreaterThan(0);
    expect(indexEnd).toBeGreaterThan(indexStart);
  });

  it('holds ground, ink, fills and bubbles', () => {
    expect(decl('--ix-ground')).toBe('#0c0d0f');
    expect(decl('--ix-main')).toBe('#0e0f11');
    expect(decl('--ix-side-end')).toBe('#111215');
    expect(decl('--ix-ink')).toBe('#f2f3f5');
    expect(decl('--ix-ink-2')).toBe('rgba(235, 238, 242, 0.74)');
    expect(decl('--ix-line')).toBe('rgba(255, 255, 255, 0.08)');
    expect(decl('--ix-fill')).toBe('rgba(255, 255, 255, 0.06)');
    expect(decl('--ix-fill-2')).toBe('rgba(255, 255, 255, 0.1)');
    expect(decl('--ix-bubble')).toBe('#26272b');
    expect(decl('--ix-card')).toBe('#2a2b2f');
  });

  it('raises ink-3 from the prototype .5 to .62, the smallest step the hue sweep passes', () => {
    // docs/index-spec.md §2.1: "raise the alpha for all (never per surface)". At .5 the
    // others' bubble (4.34:1) and an event card (4.23:1) already fail 4.5:1; the selected
    // row near the top of the list needs .615 at hue 60. `npm run test:contrast` proves .62.
    expect(decl('--ix-ink-3')).toBe('rgba(235, 238, 242, 0.62)');
  });

  it('holds the cream, amber, danger, call and focus', () => {
    expect(decl('--ix-cream')).toBe('#f4f2ed');
    expect(decl('--ix-cream-ink')).toBe('#141414');
    expect(decl('--ix-cream-press')).toBe('#e8e3d8');
    expect(decl('--ix-amber')).toBe('#ffc27e');
    expect(decl('--ix-amber-rgb')).toBe('255, 170, 90');
    expect(decl('--ix-danger-ink')).toBe('#ffb3a8');
    expect(decl('--ix-danger-fill')).toBe('rgba(255, 90, 90, 0.14)');
    expect(decl('--ix-call')).toBe('#08080a');
    expect(decl('--ix-focus')).toBe('2px solid rgba(255, 255, 255, 0.85)');
    expect(decl('--ix-focus-offset')).toBe('2px');
  });

  it('holds the shadows of §2.5 and the two curves of §5', () => {
    expect(decl('--ix-shadow-room')).toBe('0 10px 30px rgba(0, 0, 0, 0.25)');
    expect(decl('--ix-shadow-event')).toBe('inset 0 1px 0 rgba(255, 255, 255, 0.07), 0 12px 30px rgba(0, 0, 0, 0.3)');
    expect(decl('--ix-shadow-call')).toBe('0 0 0 1px rgba(255, 255, 255, 0.07), 0 30px 70px rgba(0, 0, 0, 0.55)');
    expect(decl('--ix-spring')).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
    expect(decl('--ix-ease')).toBe('cubic-bezier(0.2, 0.8, 0.2, 1)');
  });

  it('defaults the window hue to People and the tint to full strength', () => {
    expect(decl('--ix-hue')).toBe('210');
    expect(decl('--ix-tint')).toBe('1');
  });

  it('hardens High contrast as §10 says', () => {
    const hcStart = tokens.indexOf("[data-theme='glass-contrast'] {", indexStart);
    expect(hcStart).toBeGreaterThan(indexStart);
    const hc = tokens.slice(hcStart, indexEnd);
    expect(decl('--ix-ink-2', hc)).toBe('rgba(235, 238, 242, 0.9)');
    expect(decl('--ix-ink-3', hc)).toBe('rgba(235, 238, 242, 0.78)');
    expect(decl('--ix-line', hc)).toBe('rgba(255, 255, 255, 0.2)');
    expect(decl('--ix-bubble', hc)).toBe('#303136');
    expect(decl('--ix-focus', hc)).toBe('3px solid #ffffff');
    expect(decl('--ix-tint', hc)).toBe('0.5');
  });

  it('is written once: the Glass semantic tokens point at it', () => {
    expect(decl('--join', tokens)).toBe('var(--ix-cream)');
    expect(decl('--accent-primary', tokens)).toBe('var(--join)');
    expect(decl('--accent-danger', tokens)).toBe('var(--ix-danger-ink)');
    expect(decl('--accent-primary-rgb', tokens)).toBe('244, 242, 237');
    // The Index ink ramp is not the Glass one: the Glass ramp is untouched.
    expect(decl('--ink-3', tokens)).toBe('rgba(240, 243, 243, 0.64)');
  });
});

describe('Index stylesheets', () => {
  const ORDER = [
    'ix-base', 'ix-shell', 'ix-sidebar', 'ix-dock', 'ix-card', 'ix-cards', 'ix-sheets',
    'ix-pages', 'ix-timeline', 'ix-composer', 'ix-conversation', 'ix-call', 'ix-people', 'ix-longtail', 'ix-phone',
  ];

  it('creates every file the plan names', () => {
    for (const name of ORDER) expect(existsSync(resolve(process.cwd(), 'src/styles', `${name}.css`)), name).toBe(true);
  });

  it('imports them in the plan order, after every Glass sheet and before the utilities', () => {
    const globals = read('globals.css');
    const imports = [...globals.matchAll(/^@import '\.\/(ix-[a-z-]+)\.css';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(ORDER);
    const at = (needle: string) => globals.indexOf(needle);
    expect(at("@import './glass-sheets.css'")).toBeGreaterThan(-1);
    expect(at("@import './ix-base.css'")).toBeGreaterThan(at("@import './glass-sheets.css'"));
    expect(at("@import './ix-base.css'")).toBeGreaterThan(at("@import './server-home.css'"));
    expect(at("@import './ix-phone.css'")).toBeLessThan(at("@import './utilities.css'"));
  });
});
