import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  arriveIn,
  bloom,
  buildingIsDim,
  captureFlip,
  changeLights,
  clearLightsForTests,
  clearVoiceLevels,
  configureMotion,
  dimBuilding,
  emitMotion,
  flicker,
  lightsOnStep,
  liftOut,
  MOTION_TOKEN_FALLBACKS,
  onMotion,
  parseDuration,
  playArrivals,
  playDepartures,
  playLightsOn,
  playRelight,
  prefersReducedMotion,
  publishVoiceLevels,
  press,
  recede,
  recedeAround,
  relax,
  roomSharedName,
  resetMotionBusForTests,
  resetMotionSwitchForTests,
  RollingNumber,
  scaleShadow,
  settleIn,
  slideOut,
  springDuration,
  springEasing,
  springLinearEasing,
  springProgress,
  stagger,
  stepVoiceLevelsForTests,
  transitionWith,
  levelFromAnalyser,
  levelFromDbov,
  relightBuilding,
  takeDimmedPlates,
  VOICE_LEVEL_VAR,
  voiceLevelsForTests,
} from './index';
import { createOutageTracker, OUTAGE_GRACE_MS } from '../attention/outage';
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
/* §5.2 — the spring never overshoots; a fresh animation is on --ease-out     */
/* -------------------------------------------------------------------------- */

describe('spring', () => {
  const SPRING = { stiffness: 260, damping: 34, mass: 1 };

  it('starts at rest and travels the whole way', () => {
    expect(springProgress(0, SPRING)).toBeCloseTo(0, 6);
    expect(springProgress(2000, SPRING)).toBeCloseTo(1, 3);
  });

  it('never overshoots at the token damping: it only ever approaches the target', () => {
    // §5.2: "no bounce, no overshoot, no spring wobble".
    let previous = 0;
    for (let t = 0; t <= 1200; t += 1) {
      const p = springProgress(t, SPRING);
      expect(p).toBeLessThanOrEqual(1.0001);
      expect(p).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = p;
    }
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

  it('samples a linear() easing that starts at 0, ends exactly at 1, and never passes it', () => {
    const easing = springLinearEasing(SPRING, { durationMs: 240, samples: 24 });
    expect(easing.startsWith('linear(')).toBe(true);
    const points = easing.slice('linear('.length, -1).split(',').map((n) => Number(n.trim()));
    expect(points).toHaveLength(25);
    expect(points[0]).toBe(0);
    // An easing that does not end at 1 leaves the element off its mark.
    expect(points[points.length - 1]).toBe(1);
    expect(Math.max(...points)).toBeLessThanOrEqual(1);
  });

  it('hands a fresh animation the --ease-out token, and a retarget the sampled spring', () => {
    vi.stubGlobal('CSS', { supports: () => true });
    expect(springEasing(SPRING)).toBe(MOTION_TOKEN_FALLBACKS['--ease-out']);
    const carried = springEasing({ ...SPRING, velocity: 4 }, { durationMs: 240 });
    expect(carried.startsWith('linear(')).toBe(true);
    const points = carried.slice('linear('.length, -1).split(',').map((n) => Number(n.trim()));
    // Even a fast retarget is capped under the speed that would cross the mark.
    expect(Math.max(...points)).toBeLessThanOrEqual(1);
    const fast = springEasing({ ...SPRING, velocity: 400 }, { durationMs: 240 });
    const fastPoints = fast.slice('linear('.length, -1).split(',').map((n) => Number(n.trim()));
    expect(Math.max(...fastPoints)).toBeLessThanOrEqual(1);
  });

  it('falls back to --ease-out where linear() is unsupported', () => {
    vi.stubGlobal('CSS', { supports: () => false });
    expect(springEasing({ ...SPRING, velocity: 4 })).toBe(MOTION_TOKEN_FALLBACKS['--ease-out']);
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
    // WP9b's four: the Lobby receding, a face springing into a strip, a face
    // sliding out, and the FLIP that carries whatever they displaced.
    recede(el);
    arriveIn(el);
    slideOut(el);
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
    recede(el);
    arriveIn(el);
    slideOut(el);
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
    expect(Number(record.options.duration)).toBe(320);
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

  it('names one curve for arriving, one for leaving, and the breath', () => {
    // `--ease-out` is everything that arrives or moves; `--ease-in` everything
    // that leaves; `--ease-in-out` the breath, which moves nothing. There is
    // no spring curve: nothing overshoots (§5.2).
    const curves = Object.entries(MOTION_TOKEN_FALLBACKS).filter(([name]) => name.startsWith('--ease-'));
    expect(curves.map(([name]) => name).sort()).toEqual(['--ease-in', '--ease-in-out', '--ease-out']);
  });
});

/* -------------------------------------------------------------------------- */
/* §5.1 — "lights on": the building wakes                                      */
/* -------------------------------------------------------------------------- */

describe('playLightsOn', () => {
  beforeEach(() => {
    stubMatchMedia(false);
    configureMotion('full');
  });

  /** One plate with `lit` windows and one face in the first of them. */
  function street(lit: number, plates = 1) {
    for (let p = 0; p < plates; p += 1) {
      const plate = document.createElement('div');
      plate.setAttribute('data-motion-plate', '');
      const lamp = document.createElement('span');
      lamp.setAttribute('data-motion-lamp', '');
      plate.append(lamp);
      for (let i = 0; i < lit; i += 1) {
        const win = document.createElement('span');
        win.setAttribute('data-motion-window', `room-${p}-${i}`);
        win.setAttribute('data-motion-lit', '');
        plate.append(win);
      }
      const dark = document.createElement('span');
      dark.setAttribute('data-motion-window', `dark-${p}`);
      plate.append(dark);
      document.body.append(plate);
    }
  }

  function personIn(room: string) {
    const person = document.createElement('span');
    person.setAttribute('data-motion-person', 'tomas');
    person.setAttribute('data-motion-lit', '');
    person.setAttribute('data-motion-room', room);
    const rim = document.createElement('span');
    rim.setAttribute('data-motion-rim', '');
    person.append(rim);
    document.body.append(person);
    return { person, rim };
  }

  it('blooms the lit windows in order, one --stagger-light apart, and leaves the dark ones dark', () => {
    street(3);
    const sequence = playLightsOn();
    expect(sequence.windows).toBe(3);
    expect(sequence.stepMs).toBe(30);
    const blooms = waapi.played.filter((record) => record.animation.id === 'data-motion-recipe:bloom');
    // Three lit windows, and nothing for the dark one: no glow without a source.
    expect(blooms).toHaveLength(3);
    const delays = blooms.map((record) => Number(record.options.delay));
    expect(delays[1] - delays[0]).toBe(30);
    expect(delays[2] - delays[1]).toBe(30);
  });

  it('fades the lamp in behind its own first lit window', () => {
    street(2);
    playLightsOn();
    const lamp = waapi.played.find((record) => record.animation.id === 'data-motion-recipe:fade')!;
    const firstWindow = waapi.played.find(
      (record) => record.animation.id === 'data-motion-recipe:bloom',
    )!;
    expect(Number(lamp.options.delay)).toBe(Number(firstWindow.options.delay) + 60);
  });

  it('brings a rim up 120ms after the room it is in', () => {
    street(2);
    const { rim } = personIn('room-0-1');
    playLightsOn();
    const secondWindow = waapi.played.filter(
      (record) => record.animation.id === 'data-motion-recipe:bloom',
    )[1];
    const rimRecord = waapi.played.find((record) => record.target === rim)!;
    expect(Number(rimRecord.options.delay)).toBe(Number(secondWindow.options.delay) + 120);
  });

  it('settles the plates 120ms apart as the street renders', () => {
    street(1, 3);
    playLightsOn();
    const settles = waapi.played.filter((record) => record.animation.id === 'data-motion-recipe:settle');
    expect(settles.map((record) => Number(record.options.delay))).toEqual([0, 120, 240]);
  });

  it('compresses the stagger so a big map still lands inside §5.3s 1.6s', () => {
    // 16 windows at the preferred 30ms would be fine; 200 would not.
    expect(lightsOnStep(16)).toBe(30);
    expect(lightsOnStep(200)).toBeLessThan(30);
    street(120, 2);
    personIn('room-0-0');
    const sequence = playLightsOn();
    expect(sequence.endsAtMs).toBeLessThanOrEqual(1_600);
  });

  it('plays nothing at all under reduced motion — everything is already landed', () => {
    stubMatchMedia(true);
    configureMotion('system');
    street(4);
    personIn('room-0-0');
    expect(playLightsOn().animations).toHaveLength(0);
    expect(waapi.played).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* §5.1 — "someone arrives": one path, one burst                               */
/* -------------------------------------------------------------------------- */

describe('playArrivals / playDepartures', () => {
  beforeEach(() => {
    stubMatchMedia(false);
    configureMotion('full');
  });

  function room(id: string) {
    const win = document.createElement('span');
    win.setAttribute('data-motion-window', id);
    document.body.append(win);
    return win;
  }

  function faceInStrip(userId: string) {
    const strip = document.createElement('span');
    strip.setAttribute('data-motion-strip', '');
    const person = document.createElement('span');
    person.setAttribute('data-motion-person', userId);
    const rim = document.createElement('span');
    rim.setAttribute('data-motion-rim', '');
    person.append(rim);
    strip.append(person);
    document.body.append(strip);
    return { strip, person, rim };
  }

  it('travels one path: window, then the rim 120ms later, then into the strip', () => {
    const win = room('2001');
    const { person, rim } = faceInStrip('tomas');
    playArrivals([{ userId: 'tomas', roomId: '2001' }]);

    const windowBloom = waapi.played.find((record) => record.target === win)!;
    const rimBloom = waapi.played.find((record) => record.target === rim)!;
    const spring = waapi.played.find((record) => record.target === person)!;
    expect(Number(windowBloom.options.delay)).toBe(0);
    expect(Number(rimBloom.options.delay)).toBe(120);
    expect(Number(spring.options.delay)).toBe(120);
    expect(spring.keyframes[0].transform).toContain('scale(0.9)');
  });

  it('fades the inline room event in last', () => {
    room('2001');
    faceInStrip('tomas');
    const event = document.createElement('div');
    event.setAttribute('data-motion-event', '2001');
    document.body.append(event);
    playArrivals([{ userId: 'tomas', roomId: '2001' }]);
    const record = waapi.played.find((played) => played.target === event)!;
    expect(Number(record.options.delay)).toBe(260);
  });

  it('runs ONE choreography for a burst of five, staggered, not five sequences', () => {
    room('2001');
    const people = ['a', 'b', 'c', 'd', 'e'];
    const faces = people.map((id) => faceInStrip(id));
    playArrivals(people.map((userId) => ({ userId, roomId: '2001' })));
    const springs = faces.map(
      (face) => waapi.played.find((record) => record.target === face.person)!,
    );
    expect(springs.map((record) => Number(record.options.delay))).toEqual([120, 150, 180, 210, 240]);
  });

  it('continues a burst already in flight rather than restarting it', () => {
    room('2001');
    const sixth = faceInStrip('f');
    playArrivals([{ userId: 'f', roomId: '2001' }], { startIndex: 5 });
    const spring = waapi.played.find((record) => record.target === sixth.person)!;
    expect(Number(spring.options.delay)).toBe(5 * 30 + 120);
  });

  it('does not spring a face that is not in a strip — a timeline row is not arriving', () => {
    room('2001');
    const person = document.createElement('span');
    person.setAttribute('data-motion-person', 'tomas');
    document.body.append(person);
    playArrivals([{ userId: 'tomas', roomId: '2001' }]);
    expect(waapi.played.some((record) => record.animation.id === 'data-motion-recipe:arrive')).toBe(false);
  });

  it('cools the window on the way out only when the room actually went dark', () => {
    const win = room('2001');
    win.style.boxShadow = '0 0 8px rgba(1, 2, 3, 0.5)';
    faceInStrip('tomas');
    playDepartures([{ userId: 'tomas', roomId: '2001', roomWentDark: false }]);
    expect(waapi.played.some((record) => record.target === win)).toBe(false);

    playDepartures([{ userId: 'tomas', roomId: '2001', roomWentDark: true }]);
    expect(waapi.played.some((record) => record.target === win)).toBe(true);
  });

  it('plays nothing under reduced motion', () => {
    stubMatchMedia(true);
    configureMotion('system');
    room('2001');
    faceInStrip('tomas');
    expect(playArrivals([{ userId: 'tomas', roomId: '2001' }])).toHaveLength(0);
    expect(playDepartures([{ userId: 'tomas', roomId: '2001' }])).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* §5.1 — the FLIP that carries what an arrival displaced                      */
/* -------------------------------------------------------------------------- */

describe('captureFlip', () => {
  beforeEach(() => {
    stubMatchMedia(false);
    configureMotion('full');
  });

  it('plays an element back from where it was, on transform alone', () => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ left: 10, top: 0, width: 20, height: 20 }) as DOMRect;
    document.body.append(el);
    const capture = captureFlip([el]);
    el.getBoundingClientRect = () => ({ left: 28, top: 0, width: 20, height: 20 }) as DOMRect;
    const played = capture.play();
    expect(played).toHaveLength(1);
    const record = waapi.played.at(-1)!;
    expect(record.keyframes[0].transform).toBe('translate3d(-18px, 0px, 0)');
    expect(Object.keys(record.keyframes[0])).toEqual(['transform']);
  });

  it('ignores an element that did not move, and one React removed', () => {
    const still = document.createElement('div');
    still.getBoundingClientRect = () => ({ left: 4, top: 4, width: 10, height: 10 }) as DOMRect;
    const gone = document.createElement('div');
    gone.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10 }) as DOMRect;
    document.body.append(still, gone);
    const capture = captureFlip([still, gone]);
    gone.remove();
    expect(capture.play()).toHaveLength(0);
  });

  it('captures nothing under reduced motion', () => {
    stubMatchMedia(true);
    configureMotion('system');
    const el = document.createElement('div');
    document.body.append(el);
    expect(captureFlip([el]).size).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* §5.1 — "walk into a room": the origin, and what recedes behind it           */
/* -------------------------------------------------------------------------- */

describe('walking into a room', () => {
  beforeEach(() => {
    stubMatchMedia(false);
    configureMotion('full');
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  it('gives a room one name on every surface that draws it', () => {
    expect(roomSharedName('2001')).toBe('room-2001');
  });

  it('recedes a ghost of the surface, with the travelling branch hidden in it', () => {
    document.body.innerHTML = `
      <section id="lobby" data-motion-recede="">
        <header id="header"></header>
        <div id="grid">
          <article id="other"></article>
          <article id="clicked"><button id="join"></button></article>
        </div>
      </section>
      <aside id="sidebar" data-motion-recede=""></aside>
    `;
    // The ghost is cut from a live element, so it needs a live box.
    for (const el of document.querySelectorAll<HTMLElement>('*')) {
      el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
    }
    const clicked = document.getElementById('clicked')!;
    recedeAround(clicked);

    // One recede per marked region, and it is played on a COPY — the real
    // Lobby is unmounted by the route change on the same tick, which is why
    // animating it directly showed nothing at all.
    const receded = waapi.played.filter((record) => record.animation.id === 'data-motion-recipe:recede');
    expect(receded).toHaveLength(2);
    for (const record of receded) {
      expect(record.target.isConnected).toBe(true);
      expect(document.body.contains(record.target) && record.target.closest('#pc-motion-ghosts')).toBeTruthy();
    }

    // The branch that is travelling is not receding: it is hidden in the copy
    // so the real one can fly over the top of it.
    // Queried by attribute, not by id: jsdom resolves a duplicated id through
    // the document's own map, and the ghost is a copy of something still in it.
    const ghosts = document.getElementById('pc-motion-ghosts')!;
    const hidden = ghosts.querySelector<HTMLElement>('[data-motion-travelling]');
    expect(hidden?.style.visibility).toBe('hidden');
    expect(ghosts.querySelectorAll('[style*="visibility: hidden"]')).toHaveLength(1);
    // And the marker it used to find that branch is not left on the real one.
    expect(clicked.hasAttribute('data-motion-travelling')).toBe(false);
  });

  it('recedes a region whole when the origin is somewhere else', () => {
    document.body.innerHTML = `<aside id="sidebar" data-motion-recede=""><span id="row"></span></aside>`;
    for (const el of document.querySelectorAll<HTMLElement>('*')) {
      el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
    }
    recedeAround(null);
    const receded = waapi.played.filter((record) => record.animation.id === 'data-motion-recipe:recede');
    expect(receded).toHaveLength(1);
    // Nothing is travelling, so nothing in the copy is hidden.
    expect(
      document.getElementById('pc-motion-ghosts')?.querySelectorAll('[style*="visibility"]'),
    ).toHaveLength(0);
  });

  it('lets the caller say which element is the origin when a name is on three surfaces', async () => {
    const make = (id: string, left: number) => {
      const el = document.createElement('div');
      el.id = id;
      el.setAttribute('data-motion-shared', 'room-2001');
      el.getBoundingClientRect = () => ({ left, top: 0, width: 10, height: 10 }) as DOMRect;
      document.body.append(el);
      return el;
    };
    // The same room, drawn on the sidebar row and on the Lobby card at once.
    const row = make('row', 0);
    const card = make('card', 500);

    await transitionWith(
      () => {
        // Walking in replaces both with the Stage's dominant tile.
        row.remove();
        card.remove();
        const tile = make('tile', 100);
        void tile;
      },
      { engine: 'flip', chrome: false, names: ['room-2001'], origin: card },
    );

    const record = waapi.played.at(-1)!;
    expect((record.target as HTMLElement).id).toBe('tile');
    // From the CARD (left 500), not the row (left 0) that happened to be first
    // in the document.
    expect(record.keyframes[0].transform).toBe('translate3d(400px, 0px, 0) scale(1, 1)');
  });

  it('stamps the journey on <html> so both engines dress it the same way', async () => {
    const el = document.createElement('div');
    el.setAttribute('data-motion-shared', 'room-2001');
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10 }) as DOMRect;
    document.body.append(el);
    let stampedDuringUpdate: string | null = null;
    await transitionWith(
      () => {
        stampedDuringUpdate = document.documentElement.getAttribute('data-motion-transition');
      },
      { engine: 'flip', chrome: false, kind: 'walk-in' },
    );
    expect(stampedDuringUpdate).toBe('walk-in');
  });

  it('tells beforeUpdate which engine is about to carry it', async () => {
    const seen: string[] = [];
    await transitionWith(() => {}, {
      engine: 'flip',
      chrome: false,
      beforeUpdate: (engine) => seen.push(engine),
    });
    expect(seen).toEqual(['flip']);
  });
});

/* -------------------------------------------------------------------------- */
/* WP9d — "speaking is a breath", and the breath takes the voice (§5.1)        */
/* -------------------------------------------------------------------------- */

describe('the speaking ring takes the voice', () => {
  beforeEach(() => {
    stubMatchMedia(false);
    configureMotion('full');
    clearVoiceLevels();
  });

  afterEach(() => {
    clearVoiceLevels();
  });

  /** A face and a tile, both belonging to the same person. */
  function ringsFor(userId: string) {
    const face = document.createElement('span');
    face.setAttribute('data-motion-person', userId);
    const tile = document.createElement('div');
    tile.setAttribute('data-motion-speaking', userId);
    document.body.append(face, tile);
    return { face, tile };
  }

  const levelOn = (el: HTMLElement) => Number(el.style.getPropertyValue(VOICE_LEVEL_VAR) || '0');

  it('reaches the voice in 60ms and lets go of it over 240ms', () => {
    const { face } = ringsFor('44');
    publishVoiceLevels('room', new Map([['44', 1]]));

    // §5.1: 60ms attack. Half way there after 30ms, on its mark at 60. The
    // first frame after a report is the clock starting, not 16ms of travel.
    stepVoiceLevelsForTests(0);
    stepVoiceLevelsForTests(30);
    expect(levelOn(face)).toBeCloseTo(0.5, 1);
    stepVoiceLevelsForTests(60);
    expect(levelOn(face)).toBe(1);

    // …and 240ms release, which is four times as long on purpose: a ring that
    // let go as fast as it caught would chatter on every syllable.
    publishVoiceLevels('room', new Map());
    // In 60ms steps: a single frame is never allowed to carry more than 64ms of
    // the envelope, so a backgrounded tab coming back cannot snap a ring.
    stepVoiceLevelsForTests(120);
    stepVoiceLevelsForTests(180);
    expect(levelOn(face)).toBeCloseTo(0.5, 1);
    stepVoiceLevelsForTests(240);
    stepVoiceLevelsForTests(300);
    expect(levelOn(face)).toBe(0);
  });

  it('drives every element that draws that person, from one loop', () => {
    const mara = ringsFor('45');
    const ren = ringsFor('46');
    publishVoiceLevels('room', new Map([['45', 1], ['46', 0.5]]));
    stepVoiceLevelsForTests(0);
    stepVoiceLevelsForTests(60);
    // The face and the tile are the same voice; the two people are not.
    expect(levelOn(mara.face)).toBe(1);
    expect(levelOn(mara.tile)).toBe(1);
    expect(levelOn(ren.face)).toBeCloseTo(0.5, 1);
    expect(voiceLevelsForTests().size).toBe(2);
  });

  it('never writes the same step twice — a steady voice stops writing', () => {
    const { face } = ringsFor('44');
    const writes: string[] = [];
    const original = face.style.setProperty.bind(face.style);
    face.style.setProperty = ((name: string, value: string) => {
      if (name === VOICE_LEVEL_VAR) writes.push(value);
      original(name, value);
    }) as typeof face.style.setProperty;

    publishVoiceLevels('room', new Map([['44', 1]]));
    stepVoiceLevelsForTests(0);
    stepVoiceLevelsForTests(60);
    const afterArrival = writes.length;
    // Ten more frames of exactly the same voice.
    for (let i = 1; i <= 10; i += 1) stepVoiceLevelsForTests(60 + i * 16);
    expect(writes.length).toBe(afterArrival);
  });

  it('takes the loudest source, so your own mic can answer before the server does', () => {
    const { face } = ringsFor('42');
    publishVoiceLevels('room', new Map([['42', 0.2]]));
    publishVoiceLevels('self', new Map([['42', 0.9]]));
    stepVoiceLevelsForTests(0);
    stepVoiceLevelsForTests(60);
    expect(levelOn(face)).toBeCloseTo(0.9, 1);
    // The room catching up does not pull the ring back down.
    publishVoiceLevels('room', new Map([['42', 0.9]]));
    stepVoiceLevelsForTests(120);
    expect(levelOn(face)).toBeCloseTo(0.9, 1);
  });

  it('lets a tile that mounted since the last report join without a per-frame selector', () => {
    publishVoiceLevels('room', new Map([['47', 1]]));
    stepVoiceLevelsForTests(0);
    stepVoiceLevelsForTests(60);
    // The tile arrives AFTER the level did. A loop that re-read the DOM every
    // frame would catch it; this one catches it on the engine's next report,
    // which is what keeps the frame free.
    const { face } = ringsFor('47');
    expect(levelOn(face)).toBe(0);
    publishVoiceLevels('room', new Map([['47', 1]]));
    // On the report, not on the next frame: a steady voice would otherwise
    // leave the new tile dark until the level happened to change step.
    expect(levelOn(face)).toBe(1);
  });

  it('does nothing at all under reduced motion', () => {
    const { face } = ringsFor('44');
    stubMatchMedia(true);
    configureMotion('system');
    publishVoiceLevels('room', new Map([['44', 1]]));
    expect(voiceLevelsForTests().size).toBe(0);
    expect(face.style.getPropertyValue(VOICE_LEVEL_VAR)).toBe('');
  });

  it('puts the ring back at rest the moment nobody is talking to us', () => {
    const { face, tile } = ringsFor('44');
    publishVoiceLevels('room', new Map([['44', 1]]));
    stepVoiceLevelsForTests(0);
    stepVoiceLevelsForTests(60);
    clearVoiceLevels();
    // Not a release: a glow asserts something is true RIGHT NOW (§0), and once
    // the call is gone we do not know how loud anybody is.
    expect(face.style.getPropertyValue(VOICE_LEVEL_VAR)).toBe('');
    expect(tile.style.getPropertyValue(VOICE_LEVEL_VAR)).toBe('');
  });

  it('reads the two conventions the engines actually speak', () => {
    // RTP audio level: 0..127 as -dBov, so LOWER is louder.
    expect(levelFromDbov(10)).toBe(1);
    expect(levelFromDbov(45)).toBe(0);
    expect(levelFromDbov(80)).toBe(0);
    expect(levelFromDbov(27.5)).toBeCloseTo(0.5, 2);
    // The local analyser's 0..1 RMS, where an ordinary voice is a quarter.
    expect(levelFromAnalyser(0.25)).toBe(1);
    expect(levelFromAnalyser(0)).toBe(0);
    expect(levelFromAnalyser(0.05)).toBeCloseTo(0.2, 2);
  });
});

/* -------------------------------------------------------------------------- */
/* WP9d — the lights change, and the power goes (§5.1)                         */
/* -------------------------------------------------------------------------- */

describe('the outage edge', () => {
  const tracker = () => createOutageTracker(OUTAGE_GRACE_MS);

  it('never dims a server that has not been up yet', () => {
    const outage = tracker();
    expect(outage.observe({ connected: false, nowMs: 0 })).toBeNull();
    expect(outage.observe({ connected: false, nowMs: 5_000 })).toBeNull();
  });

  it('waits out the grace, because a gateway blips several times an hour', () => {
    const outage = tracker();
    outage.observe({ connected: true, nowMs: 0 });
    expect(outage.observe({ connected: false, nowMs: 100 })).toBeNull();
    expect(outage.observe({ connected: false, nowMs: 400 })).toBeNull();
    // Back before the grace ran out: nothing ever happened.
    expect(outage.observe({ connected: true, nowMs: 500 })).toBeNull();
    expect(outage.observe({ connected: false, nowMs: 600 })).toBeNull();
    expect(outage.observe({ connected: false, nowMs: 600 + OUTAGE_GRACE_MS })).toBe('dim');
  });

  it('dims once and relights once, however often it is asked', () => {
    const outage = tracker();
    outage.observe({ connected: true, nowMs: 0 });
    outage.observe({ connected: false, nowMs: 10 });
    expect(outage.observe({ connected: false, nowMs: 10 + OUTAGE_GRACE_MS })).toBe('dim');
    expect(outage.observe({ connected: false, nowMs: 4_000 })).toBeNull();
    expect(outage.observe({ connected: true, nowMs: 5_000 })).toBe('relight');
    expect(outage.observe({ connected: true, nowMs: 5_100 })).toBeNull();
  });

  it('says how long the gateway has been away', () => {
    const outage = tracker();
    outage.observe({ connected: true, nowMs: 0 });
    expect(outage.awayForMs(0)).toBeNull();
    outage.observe({ connected: false, nowMs: 100 });
    expect(outage.awayForMs(900)).toBe(800);
  });
});

describe('the lights changing', () => {
  /**
   * jsdom has no animation engine, so the stub never finishes anything on its
   * own — and this is the one moment that AWAITS its own animations (the theme
   * is applied between the two halves of the dip). Run the clock by hand.
   */
  async function settleAnimations(rounds = 10) {
    for (let round = 0; round < rounds; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const record of waapi.played) {
        if (!record.finished && !record.cancelled) record.animation.finish();
      }
    }
  }

  beforeEach(() => {
    stubMatchMedia(false);
    configureMotion('full');
    clearLightsForTests();
  });

  afterEach(() => {
    clearLightsForTests();
  });

  function plate(lit = 2) {
    const el = document.createElement('div');
    el.setAttribute('data-motion-plate', '');
    for (let i = 0; i < lit; i += 1) {
      const win = document.createElement('span');
      win.setAttribute('data-motion-window', `room-${i}`);
      win.setAttribute('data-motion-lit', '');
      el.append(win);
    }
    document.body.append(el);
    return el;
  }

  it('crosses the base over and then re-blooms the lights', async () => {
    plate(2);
    let applied = false;
    const running = changeLights(() => { applied = true; }, { engine: 'crossfade' });
    await settleAnimations();
    const result = await running;
    expect(applied).toBe(true);
    expect(result.engine).toBe('crossfade');
    const ids = waapi.played.map((record) => record.animation.id);
    // Down on --ease-in, back up on --ease-out, and the windows last.
    expect(ids).toContain('data-motion-recipe:lights-out');
    expect(ids).toContain('data-motion-recipe:lights-in');
    expect(ids).toContain('data-motion-recipe:bloom');
    const out = waapi.played.find((r) => r.animation.id === 'data-motion-recipe:lights-out')!;
    const back = waapi.played.find((r) => r.animation.id === 'data-motion-recipe:lights-in')!;
    // The two halves add up to --duration-dim and no more (§5.3: 500ms).
    expect(Number(out.options.duration) + Number(back.options.duration)).toBe(400);
    // Opacity alone: the base is never transformed and never relaid out.
    for (const record of [out, back]) {
      for (const frame of record.keyframes) expect(Object.keys(frame)).toEqual(['opacity']);
    }
  });

  it('just changes the theme under reduced motion', async () => {
    stubMatchMedia(true);
    configureMotion('system');
    plate(2);
    let applied = false;
    const result = await changeLights(() => { applied = true; }, { engine: 'crossfade' });
    expect(applied).toBe(true);
    expect(result.engine).toBe('none');
    expect(waapi.played).toHaveLength(0);
  });

  it('dims the whole server 30% and holds it there', () => {
    plate(2);
    expect(buildingIsDim()).toBe(false);
    const result = dimBuilding();
    expect(result.plates).toBe(1);
    expect(buildingIsDim()).toBe(true);
    const record = waapi.played.find((r) => r.animation.id === 'data-motion-recipe:outage-dim')!;
    expect(record.keyframes.at(-1)).toEqual({ opacity: 0.3 });
    // It has to stay dark: an outage is not a pulse.
    expect(record.options.fill).toBe('forwards');
    expect(Number(record.options.duration)).toBe(400);
  });

  it('lifts the scrim on the way back, and hands the dark plates to the sweep', async () => {
    const one = plate(2);
    dimBuilding();
    const lifting = relightBuilding();
    await settleAnimations();
    await lifting;
    expect(buildingIsDim()).toBe(false);
    // The relight itself is NOT played here: a gateway coming back is already
    // §5.1's "lights on", and that path waits for presence to be re-delivered.
    const taken = takeDimmedPlates();
    expect(taken).toEqual([one]);
    // …and only once.
    expect(takeDimmedPlates()).toEqual([]);
  });

  it('relights only the plates that went dark, and never moves them', () => {
    const dark = plate(2);
    const untouched = plate(2);
    const sequence = playRelight({ plates: [dark] });
    // Two windows, from the one plate that was dark.
    expect(sequence.windows).toBe(2);
    const blooms = waapi.played.filter((r) => r.animation.id === 'data-motion-recipe:bloom');
    expect(blooms).toHaveLength(2);
    for (const record of blooms) expect(untouched.contains(record.target)).toBe(false);
    // §5.1: a plate rises when it ENTERS the street. These never left it.
    expect(waapi.played.some((r) => r.animation.id === 'data-motion-recipe:settle')).toBe(false);
  });

  it('does nothing under reduced motion', () => {
    stubMatchMedia(true);
    configureMotion('system');
    plate(2);
    expect(dimBuilding().animations).toHaveLength(0);
    expect(buildingIsDim()).toBe(false);
    expect(playRelight().animations).toHaveLength(0);
  });
});
