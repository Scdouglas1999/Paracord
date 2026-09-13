import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bloom,
  configureMotion,
  emitMotion,
  flicker,
  liftOut,
  MOTION_TOKEN_FALLBACKS,
  onMotion,
  parseDuration,
  prefersReducedMotion,
  press,
  relax,
  resetMotionBusForTests,
  resetMotionSwitchForTests,
  RollingNumber,
  scaleShadow,
  settleIn,
  springDuration,
  springEasing,
  springLinearEasing,
  springProgress,
  stagger,
  transitionWith,
} from './index';
import { installWaapiStub, type WaapiStub } from './waapiStub';

/* -------------------------------------------------------------------------- */
/* The media-query seam                                                        */
/* -------------------------------------------------------------------------- */

function stubMatchMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    addListener: (listener: () => void) => listeners.add(listener),
    removeListener: (listener: () => void) => listeners.delete(listener),
    dispatchEvent: () => true,
    onchange: null,
  } as unknown as MediaQueryList;
  vi.stubGlobal('matchMedia', () => query);
  return {
    set(next: boolean) {
      (query as { matches: boolean }).matches = next;
      for (const listener of listeners) listener();
    },
  };
}

let waapi: WaapiStub;

beforeEach(() => {
  document.body.replaceChildren();
  resetMotionSwitchForTests();
  resetMotionBusForTests();
  waapi = installWaapiStub();
});

afterEach(() => {
  waapi.restore();
  resetMotionSwitchForTests();
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/* §5.2 — the spring resolves to the spring-settle curve                       */
/* -------------------------------------------------------------------------- */

describe('spring', () => {
  const SPRING = { stiffness: 260, damping: 24, mass: 1 };

  it('starts at rest and travels the whole way', () => {
    expect(springProgress(0, SPRING)).toBeCloseTo(0, 6);
    expect(springProgress(2000, SPRING)).toBeCloseTo(1, 3);
  });

  it('overshoots once, by a little, and never bounces back below the target', () => {
    let peak = 0;
    let peakAt = 0;
    for (let t = 0; t <= 600; t += 1) {
      const p = springProgress(t, SPRING);
      if (p > peak) {
        peak = p;
        peakAt = t;
      }
    }
    // §5.2: "one small overshoot, no bounce".
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(1.08);
    // The cubic-bezier token peaks around a third of the way in; so does this.
    expect(peakAt).toBeGreaterThan(200);
    expect(peakAt).toBeLessThan(400);
    // After the single overshoot it settles from above — it never dips under 1
    // again by anything a person could see.
    let minAfterPeak = Number.POSITIVE_INFINITY;
    for (let t = peakAt; t <= 1200; t += 1) minAfterPeak = Math.min(minAfterPeak, springProgress(t, SPRING));
    expect(minAfterPeak).toBeGreaterThan(0.995);
  });

  it('is critically damped and overdamped without overshoot at higher damping', () => {
    for (const damping of [2 * Math.sqrt(260), 60]) {
      let peak = 0;
      for (let t = 0; t <= 1200; t += 2) peak = Math.max(peak, springProgress(t, { stiffness: 260, damping, mass: 1 }));
      expect(peak).toBeLessThanOrEqual(1.0001);
    }
  });

  it('settles inside §5.3 budget of 500ms', () => {
    const duration = springDuration(SPRING);
    expect(duration).toBeGreaterThan(100);
    expect(duration).toBeLessThanOrEqual(500);
  });

  it('samples a linear() easing that starts at 0 and ends exactly at 1', () => {
    const easing = springLinearEasing(SPRING, { durationMs: 380, samples: 24 });
    expect(easing.startsWith('linear(')).toBe(true);
    const points = easing.slice('linear('.length, -1).split(',').map((n) => Number(n.trim()));
    expect(points).toHaveLength(25);
    expect(points[0]).toBe(0);
    // An easing that does not end at 1 leaves the element off its mark.
    expect(points[points.length - 1]).toBe(1);
    expect(Math.max(...points)).toBeGreaterThan(1);
  });

  it('falls back to the --ease-spring-settle token where linear() is unsupported', () => {
    vi.stubGlobal('CSS', { supports: () => false });
    expect(springEasing(SPRING)).toBe(MOTION_TOKEN_FALLBACKS['--ease-spring-settle']);
  });
});

/* -------------------------------------------------------------------------- */
/* §5.3 — one reduced-motion switch                                            */
/* -------------------------------------------------------------------------- */

describe('the reduced-motion switch', () => {
  it('follows the OS setting on `system` and publishes data-motion', () => {
    stubMatchMedia(true);
    configureMotion('system');
    expect(prefersReducedMotion()).toBe(true);
    expect(document.documentElement.getAttribute('data-motion')).toBe('reduced');
  });

  it('lets the explicit setting override the OS in both directions', () => {
    stubMatchMedia(true);
    configureMotion('full');
    expect(prefersReducedMotion()).toBe(false);
    expect(document.documentElement.getAttribute('data-motion')).toBe('full');

    stubMatchMedia(false);
    configureMotion('reduced');
    expect(prefersReducedMotion()).toBe(true);
    expect(document.documentElement.getAttribute('data-motion')).toBe('reduced');
  });

  it('tracks an OS change while on `system`', () => {
    const media = stubMatchMedia(false);
    configureMotion('system');
    expect(prefersReducedMotion()).toBe(false);
    media.set(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(document.documentElement.getAttribute('data-motion')).toBe('reduced');
  });

  it('makes every recipe land its end state instead of playing', () => {
    stubMatchMedia(true);
    configureMotion('system');
    const el = document.createElement('div');
    document.body.append(el);

    for (const play of [bloom, flicker, settleIn, press, relax, liftOut]) play(el);
    // Each returned a finished no-op, so nothing is left running on the element.
    expect(el.getAnimations()).toHaveLength(0);
    expect(waapi.played.every((record) => record.keyframes.length === 0)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* §5.3 — the animation budget                                                 */
/* -------------------------------------------------------------------------- */

describe('the recipes', () => {
  beforeEach(() => {
    stubMatchMedia(false);
    configureMotion('full');
  });

  const LAYOUT = /^(width|height|top|left|right|bottom|margin|padding|inset)/;

  it('animates transform and opacity only, except on a light element', () => {
    const el = document.createElement('div');
    document.body.append(el);
    settleIn(el);
    press(el);
    relax(el);
    liftOut(el);
    stagger([el, el]);
    for (const record of waapi.played) {
      for (const frame of record.keyframes) {
        for (const property of Object.keys(frame)) {
          if (property === 'offset' || property === 'easing') continue;
          expect(property).not.toMatch(LAYOUT);
          expect(['transform', 'opacity', 'transformOrigin', 'boxShadow', 'background']).toContain(property);
        }
      }
    }
  });

  it('keeps every recipe under the 500ms ceiling', () => {
    const el = document.createElement('div');
    document.body.append(el);
    settleIn(el);
    press(el);
    relax(el);
    liftOut(el);
    flicker(el);
    for (const record of waapi.played) {
      const duration = Number(record.options.duration ?? 0);
      const delay = Number(record.options.delay ?? 0);
      expect(duration + delay).toBeLessThanOrEqual(500);
    }
  });

  it('staggers neighbours by --stagger-light', () => {
    const els = [0, 1, 2].map(() => {
      const el = document.createElement('div');
      document.body.append(el);
      return el;
    });
    stagger(els);
    expect(waapi.played.map((record) => record.options.delay)).toEqual([0, 30, 60]);
  });

  it('cancels the recipe it replaces rather than stacking on it', () => {
    const el = document.createElement('div');
    document.body.append(el);
    settleIn(el);
    expect(el.getAnimations()).toHaveLength(1);
    settleIn(el);
    expect(el.getAnimations()).toHaveLength(1);
    expect(waapi.played[0].cancelled).toBe(true);
  });

  it('turns a resting glow up for the bloom and off for the flicker peaks', () => {
    // The recipes read the element's own resting box-shadow, so the engine
    // never invents a glow that tokens.css did not put there.
    const shadow = '0 0 8px rgba(226, 201, 143, 0.5)';
    expect(scaleShadow(shadow, { spread: 1.8, alpha: 1.7 })).toBe('0 0 14.4px rgba(226, 201, 143, 0.85)');
    expect(scaleShadow(shadow, { spread: 0.6, alpha: 0 })).toBe('0 0 4.8px rgba(226, 201, 143, 0)');
    // Alpha is clamped: a light cannot be brighter than fully opaque.
    expect(scaleShadow('0 0 8px rgba(1, 2, 3, 0.8)', { alpha: 4 })).toContain('rgba(1, 2, 3, 1)');
  });

  it('flickers twice — two peaks, back to rest, inside one beat', () => {
    const el = document.createElement('div');
    el.style.boxShadow = '0 0 8px rgba(226, 201, 143, 0.5)';
    document.body.append(el);
    flicker(el);
    const record = waapi.played.at(-1)!;
    expect(record.keyframes).toHaveLength(5);
    expect(record.keyframes[0].boxShadow).toBe(record.keyframes[4].boxShadow);
    expect(Number(record.options.duration)).toBeLessThanOrEqual(220);
  });
});

/* -------------------------------------------------------------------------- */
/* §5.1 — the shared element                                                   */
/* -------------------------------------------------------------------------- */

describe('transitionWith', () => {
  beforeEach(() => {
    stubMatchMedia(false);
    configureMotion('full');
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  function markedElement(name: string, rect: Partial<DOMRect>) {
    const el = document.createElement('div');
    el.setAttribute('data-motion-shared', name);
    el.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 100, ...rect }) as DOMRect;
    document.body.append(el);
    return el;
  }

  it('FLIPs a marked element from where it was to where it ended up', async () => {
    const el = markedElement('room:2001', { left: 10, top: 20, width: 100, height: 100 });
    const result = await transitionWith(
      () => {
        el.getBoundingClientRect = () =>
          ({ left: 200, top: 300, width: 200, height: 100 }) as DOMRect;
      },
      { engine: 'flip', chrome: false },
    );
    expect(result.engine).toBe('flip');
    const record = waapi.played.find((played) => played.target === el)!;
    expect(record.keyframes[0].transform).toBe('translate3d(-190px, -280px, 0) scale(0.5, 1)');
    expect(record.keyframes[1].transform).toBe('translate3d(0, 0, 0) scale(1, 1)');
    expect(Number(record.options.duration)).toBe(380);
  });

  it('does not animate an element that did not move', async () => {
    markedElement('room:2002', { left: 5, top: 5 });
    await transitionWith(() => {}, { engine: 'flip', chrome: false });
    expect(waapi.played).toHaveLength(0);
  });

  it('rises the supporting chrome 80ms later, staggered', async () => {
    markedElement('room:2003', { left: 0, top: 0 });
    for (const _ of [0, 1]) {
      const chrome = document.createElement('div');
      chrome.setAttribute('data-motion-chrome', '');
      document.body.append(chrome);
    }
    await transitionWith(() => {}, { engine: 'flip' });
    expect(waapi.played.map((record) => record.options.delay)).toEqual([80, 110]);
  });

  it('prefers the View Transitions API where the webview has it, same choreography', async () => {
    const finished = Promise.resolve();
    const start = vi.fn((update: () => void | Promise<void>) => {
      void update();
      return { finished, ready: Promise.resolve() };
    });
    (document as unknown as { startViewTransition?: unknown }).startViewTransition = start;
    try {
      const el = markedElement('room:2004', { left: 0, top: 0 });
      const chrome = document.createElement('div');
      chrome.setAttribute('data-motion-chrome', '');
      document.body.append(chrome);
      const result = await transitionWith(() => {}, {});
      expect(result.engine).toBe('view-transition');
      expect(start).toHaveBeenCalledTimes(1);
      // The chrome rise is the SAME choreography on both paths.
      expect(waapi.played.map((record) => record.options.delay)).toEqual([80]);
      expect(el.style.viewTransitionName).toBe('');
    } finally {
      delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
    }
  });

  it('just runs the update under reduced motion', async () => {
    stubMatchMedia(true);
    configureMotion('system');
    const el = markedElement('room:2005', { left: 0, top: 0 });
    const result = await transitionWith(
      () => {
        el.getBoundingClientRect = () => ({ left: 400, top: 0, width: 100, height: 100 }) as DOMRect;
      },
      { engine: 'flip' },
    );
    expect(result.engine).toBe('none');
    expect(waapi.played).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* §5.1 — numbers re-roll                                                      */
/* -------------------------------------------------------------------------- */

describe('<RollingNumber>', () => {
  beforeEach(() => {
    stubMatchMedia(false);
    configureMotion('full');
  });

  it('does not animate on first paint', () => {
    render(<RollingNumber value={4} />);
    expect(waapi.played).toHaveLength(0);
  });

  it('rolls the old value up and out and the new one up and in, on a change', async () => {
    const { rerender } = render(<RollingNumber value={4} />);
    rerender(<RollingNumber value={5} />);
    await waitFor(() => expect(waapi.played.length).toBe(2));
    const [outgoing, incoming] = waapi.played;
    expect(outgoing.keyframes[1].transform).toBe('translate3d(0, -100%, 0)');
    expect(incoming.keyframes[0].transform).toBe('translate3d(0, 100%, 0)');
    expect(Number(outgoing.options.duration)).toBe(180);
  });

  it('announces the final value once, and the roll itself is hidden from AT', async () => {
    const { rerender, container } = render(<RollingNumber value={4} />);
    rerender(<RollingNumber value={5} />);
    const live = container.querySelector('[aria-live="polite"]')!;
    // One live region, and the value leaving is scenery — so the region's
    // atomic text is "5" while both numbers are on screen.
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);
    expect(live.querySelector('[aria-hidden="true"]')?.textContent).toBe('4');
    expect(
      [...live.childNodes]
        .filter((node) => !(node instanceof HTMLElement && node.getAttribute('aria-hidden')))
        .map((node) => node.textContent)
        .join(''),
    ).toBe('5');
  });

  it('changes the number with no animation under reduced motion', async () => {
    stubMatchMedia(true);
    configureMotion('system');
    const { rerender } = render(<RollingNumber value={4} />);
    rerender(<RollingNumber value={5} />);
    await waitFor(() => expect(screen.getAllByText('5').length).toBeGreaterThan(0));
    expect(waapi.played).toHaveLength(0);
  });

  it('takes a format so a count can read in words', () => {
    render(<RollingNumber value={5} format={(n) => `${n} reading`} />);
    expect(screen.getAllByText('5 reading').length).toBeGreaterThan(0);
  });

  it('keeps the number readable but silent when it is not the one that speaks', () => {
    // Several numbers in one sentence must not each announce themselves; the
    // value still has to be in the accessible name (§9).
    const { container } = render(<RollingNumber value={19} announce={false} />);
    expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(0);
    expect(container.querySelector('[aria-live="off"]')?.textContent).toBe('19');
  });
});

/* -------------------------------------------------------------------------- */
/* The gesture bus and the token reader                                        */
/* -------------------------------------------------------------------------- */

describe('the motion bus', () => {
  it('delivers a gesture and survives a listener that throws', () => {
    const seen: string[] = [];
    onMotion('say:sent', () => {
      throw new Error('a listener with no element to animate');
    });
    const off = onMotion('say:sent', (detail) => seen.push(detail.nonce));
    emitMotion('say:sent', { channelId: '1', nonce: 'a' });
    off();
    emitMotion('say:sent', { channelId: '1', nonce: 'b' });
    expect(seen).toEqual(['a']);
  });
});

describe('the token reader', () => {
  it('parses every duration form', () => {
    expect(parseDuration('220ms')).toBe(220);
    expect(parseDuration('0.38s')).toBe(380);
    expect(parseDuration(' 180 ')).toBe(180);
    expect(parseDuration('nonsense')).toBe(0);
  });

  it('holds the same numbers tokens.css declares', async () => {
    // The fallbacks exist for one case — a renderer with no stylesheet — and a
    // fallback that has drifted from the stylesheet is a second source of truth
    // for a duration. tokens.css is the contract; this is the check.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');
    for (const [name, value] of Object.entries(MOTION_TOKEN_FALLBACKS)) {
      const declared = new RegExp(`^\\s*${name}:\\s*(.+?);`, 'm').exec(css);
      expect(declared, `${name} is not declared in tokens.css`).not.toBeNull();
      expect(declared![1].trim(), name).toBe(value);
    }
  });

  it('names only the two curves §5.2 allows for things that move', () => {
    // `--ease-out` is light and fades; `--ease-spring-settle` is movement.
    // `--ease-in` is the dim and `--ease-in-out` the breath — neither moves
    // anything. A third travelling curve would be a third physical model.
    const curves = Object.entries(MOTION_TOKEN_FALLBACKS).filter(([name]) => name.startsWith('--ease-'));
    expect(curves.map(([name]) => name).sort()).toEqual([
      '--ease-in',
      '--ease-in-out',
      '--ease-out',
      '--ease-spring-settle',
    ]);
  });
});
