import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RELAX_MS,
  SEND_FLIGHT,
  captureRoom,
  configureMotion,
  flySend,
  makeRoom,
  pressComposer,
  readSendOrigin,
  releaseSend,
  resetMotionSwitchForTests,
  type SendOrigin,
} from './index';
import { installWaapiStub, type RecordedAnimation, type WaapiStub } from './waapiStub';

/**
 * The send flight (docs/glass-spec.md §9) is the one gesture the quiet motion
 * system does not govern, and these tests are what keeps it that way: they pin
 * the approved prototype's numbers, so a future "one quiet motion system" pass
 * cannot clamp the flight back to an 8px lift without a test saying so.
 */

let waapi: WaapiStub;
const rects = new Map<Element, { left: number; top: number; width: number; height: number }>();

function rect(box: { left: number; top: number; width: number; height: number }) {
  return { ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => box };
}

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', () => ({
    matches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
    onchange: null,
  }));
}

/** A bubble standing where a delivered row's bubble would. */
function bubbleAt(box: { left: number; top: number; width: number; height: number }) {
  const row = document.createElement('div');
  row.className = 'glass-msg';
  const bubble = document.createElement('div');
  bubble.className = 'glass-bubble';
  const text = document.createElement('div');
  text.className = 'glass-bubble__text';
  text.textContent = 'count me in';
  bubble.append(text);
  row.append(bubble);
  document.body.append(row);
  rects.set(bubble, box);
  rects.set(text, { left: box.left + 14, top: box.top + 9, width: box.width - 28, height: box.height - 18 });
  return bubble;
}

const ORIGIN: SendOrigin = { left: 400, top: 800, width: 700, height: 36, inset: 10, color: 'rgb(243, 245, 245)' };

function ghostLayers() {
  const shell = document.querySelector<HTMLElement>('.glass-flight');
  if (!shell) throw new Error('no ghost in the air');
  return {
    shell,
    body: shell.querySelector<HTMLElement>('.glass-flight__body')!,
    shadow: shell.querySelector<HTMLElement>('.glass-flight__shadow')!,
    fill: shell.querySelector<HTMLElement>('.glass-flight__fill')!,
    words: shell.querySelector<HTMLElement>('.glass-flight__words')!,
  };
}

const flight = () => waapi.played.filter((record) => record.animation.id === 'data-motion-recipe:send-flight');
const on = (el: Element) => flight().find((record) => record.target === el)!;

beforeEach(() => {
  document.body.replaceChildren();
  rects.clear();
  resetMotionSwitchForTests();
  stubMatchMedia(false);
  configureMotion('full');
  waapi = installWaapiStub();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return rect(rects.get(this) ?? { left: 0, top: 0, width: 0, height: 0 }) as DOMRect;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  waapi.restore();
  resetMotionSwitchForTests();
});

describe('the approved flight, pinned', () => {
  it('is the prototype\'s: 280ms, an arc on two curves, a 3px overshoot at 70%', () => {
    expect(SEND_FLIGHT.duration).toBe(280);
    expect(SEND_FLIGHT.easeX).toBe('cubic-bezier(0.3, 0.05, 0.2, 1)');
    expect(SEND_FLIGHT.easeY).toBe('cubic-bezier(0.22, 1, 0.36, 1)');
    expect(SEND_FLIGHT.glide).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
    expect(SEND_FLIGHT.fromScale).toBe(0.95);
    expect(SEND_FLIGHT.overshoot).toEqual({ y: -3, scale: 1.01, at: 0.7 });
    expect([SEND_FLIGHT.fillFrom, SEND_FLIGHT.fillTo]).toEqual([0.12, 0.24]);
    expect(RELAX_MS).toBe(135);
  });

  it('does not obey the quiet system\'s ceilings, and says so: more than 8px, longer than 225ms', () => {
    // §5.2 ("4-8px", "225ms") governs every other recipe. The flight is a
    // protected signature gesture (docs/glass-spec.md §9) and must not be
    // clamped back to the lift it was.
    const bubble = bubbleAt({ left: 900, top: 700, width: 254, height: 40 });
    flySend({ text: 'count me in', origin: ORIGIN, bubble: () => bubble, onLand: () => {} });
    const { body, shell } = ghostLayers();
    const lift = on(body);
    const start = String(lift.keyframes[0].transform);
    const travelled = Math.abs(Number(/translate3d\(0(?:px)?, (-?[\d.]+)px/.exec(start)?.[1]));
    expect(travelled).toBeGreaterThan(8);
    expect(travelled).toBeCloseTo(800 + 18 - (700 + 20), 5);
    expect(Number(on(shell).options.duration)).toBe(280);
    expect(Number(on(shell).options.duration)).toBeGreaterThan(225);
  });
});

describe('takeoff', () => {
  it('is null under reduced motion, where the text clears and the row appears', () => {
    stubMatchMedia(true);
    configureMotion('system');
    const bubble = bubbleAt({ left: 900, top: 700, width: 254, height: 40 });
    expect(flySend({ text: 'x', origin: ORIGIN, bubble: () => bubble, onLand: () => {} })).toBeNull();
    expect(readSendOrigin(document.createElement('textarea'))).toBeNull();
    expect(document.querySelector('.glass-flight')).toBeNull();
  });

  it('is null with no bubble to land on, and leaves nothing behind', () => {
    expect(flySend({ text: 'x', origin: ORIGIN, bubble: () => null, onLand: () => {} })).toBeNull();
    const empty = bubbleAt({ left: 0, top: 0, width: 0, height: 0 });
    expect(flySend({ text: 'x', origin: ORIGIN, bubble: () => empty, onLand: () => {} })).toBeNull();
    expect(document.querySelector('.glass-flight')).toBeNull();
  });

  it('reads where the words sit, and how the composer paints them', () => {
    const textarea = document.createElement('textarea');
    textarea.style.paddingLeft = '10px';
    textarea.style.color = 'rgb(1, 2, 3)';
    document.body.append(textarea);
    rects.set(textarea, { left: 420, top: 812, width: 640, height: 36 });
    expect(readSendOrigin(textarea)).toEqual({ left: 420, top: 812, width: 640, height: 36, inset: 10, color: 'rgb(1, 2, 3)' });
  });

  it('plays one 280ms flight on five layers, and only transform, opacity and color move', () => {
    const bubble = bubbleAt({ left: 900, top: 700, width: 254, height: 40 });
    flySend({ text: 'count me in', origin: ORIGIN, bubble: () => bubble, onLand: () => {} });
    const layers = ghostLayers();
    expect(flight()).toHaveLength(5);
    const allowed = new Set(['transform', 'opacity', 'color', 'offset', 'easing', 'composite']);
    for (const record of flight()) {
      expect(Number(record.options.duration)).toBe(280);
      for (const frame of record.keyframes) for (const property of Object.keys(frame)) expect(allowed.has(property), property).toBe(true);
    }
    // x on its curve, y and scale on another.
    expect(on(layers.shell).options.easing).toBe(SEND_FLIGHT.easeX);
    expect(on(layers.body).options.easing).toBe(SEND_FLIGHT.easeY);
    const lift = on(layers.body).keyframes;
    expect(lift.map((frame) => frame.offset)).toEqual([0, 0.7, 1]);
    expect(lift[0].transform).toContain('scale(0.95)');
    expect(lift[1].transform).toBe('translate3d(0, -3px, 0) scale(1.01)');
    expect(lift[2].transform).toBe('translate3d(0, 0, 0) scale(1)');
  });

  it('starts as plain words, in the composer\'s color, and becomes the bubble early', () => {
    const bubble = bubbleAt({ left: 900, top: 700, width: 254, height: 40 });
    bubble.style.color = 'rgb(20, 21, 22)';
    flySend({ text: 'count me in', origin: ORIGIN, bubble: () => bubble, onLand: () => {} });
    const { fill, words, shadow } = ghostLayers();
    expect(words.textContent).toBe('count me in');
    expect(words.style.color).toBe('rgb(243, 245, 245)');
    expect(on(fill).keyframes.map((frame) => [frame.offset, frame.opacity])).toEqual([[0, 0], [0.12, 0], [0.24, 1], [1, 1]]);
    expect(on(words).keyframes.map((frame) => [frame.offset, frame.color])).toEqual([
      [0, 'rgb(243, 245, 245)'],
      [0.12, 'rgb(243, 245, 245)'],
      [0.24, 'rgb(20, 21, 22)'],
      [1, 'rgb(20, 21, 22)'],
    ]);
    // A soft shadow while airborne, on its own layer, that settles away.
    expect(on(shadow).keyframes.map((frame) => [frame.offset, frame.opacity])).toEqual([[0, 0], [0.24, 1], [0.4, 1], [1, 0]]);
  });

  it('carries a reply\'s chip as a picture that comes in with the fill, and puts the words below it', () => {
    const bubble = bubbleAt({ left: 900, top: 700, width: 400, height: 60 });
    const chip = document.createElement('button');
    chip.className = 'glass-tl-reply';
    chip.textContent = 'Nick new personal best';
    bubble.prepend(chip);
    rects.set(chip, { left: 914, top: 709, width: 370, height: 17 });
    // The words sit under the chip, not at the bubble's top-left corner.
    rects.set(bubble.querySelector('.glass-bubble__text')!, { left: 914, top: 730, width: 372, height: 22 });
    flySend({ text: 'it was great', origin: ORIGIN, bubble: () => bubble, onLand: () => {} });
    const { words } = ghostLayers();
    const picture = document.querySelector<HTMLElement>('.glass-flight__chip');
    expect(picture).not.toBeNull();
    expect(picture?.hasAttribute('inert')).toBe(true);
    expect(picture?.querySelector('.glass-tl-reply')?.textContent).toBe('Nick new personal best');
    expect(picture?.style.top).toBe('9px');
    expect(words.style.top).toBe('30px');
    expect(on(picture!).keyframes.map((frame) => [frame.offset, frame.opacity])).toEqual([[0, 0], [0.12, 0], [0.24, 1], [1, 1]]);
  });

  it('carries the Index reply line that sits above the bubble, in the row, with the row\'s own inks', () => {
    const bubble = bubbleAt({ left: 900, top: 700, width: 254, height: 40 });
    const row = bubble.parentElement!;
    row.id = 'msg-sending:n1';
    const line = document.createElement('button');
    line.className = 'glass-tl-reply';
    line.textContent = 'Jeremy: who is up for a run';
    row.prepend(line);
    rects.set(line, { left: 950, top: 680, width: 204, height: 17 });
    flySend({ text: 'count me in', origin: ORIGIN, bubble: () => bubble, onLand: () => {} });
    const picture = document.querySelector<HTMLElement>('.glass-flight__chip');
    expect(picture).not.toBeNull();
    // Above the bubble (a negative top inside the ghost), and not wrapped in the bubble's inks.
    expect(picture?.style.top).toBe('-20px');
    expect(picture?.style.left).toBe('50px');
    expect(picture?.querySelector('.glass-bubble')).toBeNull();
    expect(picture?.querySelector('.glass-tl-reply')?.textContent).toBe('Jeremy: who is up for a run');
    expect(on(picture!).keyframes.map((frame) => [frame.offset, frame.opacity])).toEqual([[0, 0], [0.12, 0], [0.24, 1], [1, 1]]);
  });

  it('leaves from the words\' own left edge and the box\'s middle', () => {
    const bubble = bubbleAt({ left: 900, top: 700, width: 254, height: 40 });
    flySend({ text: 'count me in', origin: ORIGIN, bubble: () => bubble, onLand: () => {} });
    const { shell, body } = ghostLayers();
    // Landed text starts at 900 + 14; typed text starts at 400 + 10.
    expect(on(shell).keyframes[0].transform).toBe(`translate3d(${400 + 10 - 914}px, 0, 0)`);
    expect(body.style.transformOrigin).toBe('14px 50%');
  });
});

describe('landing', () => {
  it('reveals the row and removes the ghost in the same task, once', async () => {
    const bubble = bubbleAt({ left: 900, top: 700, width: 254, height: 40 });
    const seen: Array<{ ghostStillThere: boolean }> = [];
    flySend({
      text: 'count me in',
      origin: ORIGIN,
      bubble: () => bubble,
      onLand: () => seen.push({ ghostStillThere: document.querySelector('.glass-flight') !== null }),
    });
    expect(seen).toHaveLength(0);
    const { body } = ghostLayers();
    on(body).animation.finish();
    await Promise.resolve();
    await Promise.resolve();
    // The row is revealed while the ghost is still over it, and the ghost is gone straight after,
    // so the two changes paint together: no frame with neither, and none with both.
    expect(seen).toEqual([{ ghostStillThere: true }]);
    expect(document.querySelector('.glass-flight')).toBeNull();
  });

  it('walks to where the row is NOW, when it moved while the bubble was in the air', async () => {
    const bubble = bubbleAt({ left: 900, top: 700, width: 254, height: 40 });
    let landed = false;
    flySend({ text: 'count me in', origin: ORIGIN, bubble: () => bubble, onLand: () => { landed = true; } });
    const { shell, body } = ghostLayers();
    // Another message arrived above it: the row is 46px higher than the flight aimed.
    rects.set(bubble, { left: 900, top: 654, width: 254, height: 40 });
    on(body).animation.finish();
    await Promise.resolve();
    await Promise.resolve();
    const walk = waapi.played.filter((record) => record.target === shell && record.options.fill === 'forwards');
    expect(walk).toHaveLength(1);
    expect(walk[0].keyframes[1].transform).toBe('translate3d(0px, -46px, 0)');
    expect(Number(walk[0].options.duration)).toBe(SEND_FLIGHT.correctMs);
    expect(landed).toBe(false);
    walk[0].animation.finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(landed).toBe(true);
    expect(document.querySelector('.glass-flight')).toBeNull();
  });

  it('can be landed at once (a channel change, an unmount), which reveals the row', () => {
    const bubble = bubbleAt({ left: 900, top: 700, width: 254, height: 40 });
    let landed = 0;
    const handle = flySend({ text: 'x', origin: ORIGIN, bubble: () => bubble, onLand: () => { landed += 1; } });
    expect(handle?.airborne).toBe(true);
    handle?.land();
    handle?.land();
    expect(landed).toBe(1);
    expect(handle?.airborne).toBe(false);
    expect(document.querySelector('.glass-flight')).toBeNull();
    expect(flight().every((record) => record.canceled)).toBe(true);
  });

  it('lets go of a bubble that never landed: it freezes where it is and fades, and nothing is revealed', async () => {
    const bubble = bubbleAt({ left: 900, top: 700, width: 254, height: 40 });
    let landed = 0;
    const handle = flySend({ text: 'x', origin: ORIGIN, bubble: () => bubble, onLand: () => { landed += 1; } });
    handle?.retire();
    expect(handle?.airborne).toBe(false);
    expect(flight().filter((record) => record.paused)).toHaveLength(5);
    const { shell } = ghostLayers();
    const fade = waapi.played.find((record) => record.target === shell && record.keyframes[1]?.opacity === 0);
    expect(fade).toBeDefined();
    expect(Number(fade?.options.duration)).toBe(SEND_FLIGHT.retireMs);
    fade?.animation.finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector('.glass-flight')).toBeNull();
    expect(landed).toBe(0);
  });
});

describe('following the row', () => {
  it('re-aims its end at where the row is, keeping its start where the words were', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const bubble = bubbleAt({ left: 900, top: 700, width: 254, height: 40 });
    flySend({ text: 'x', origin: ORIGIN, bubble: () => bubble, onLand: () => {} });
    const { shell, body } = ghostLayers();
    const startY = String(on(body).keyframes[0].transform);
    // The virtualizer measured the row: it is 17px higher than the estimate laid it.
    rects.set(bubble, { left: 900, top: 683, width: 254, height: 40 });
    frames.shift()?.(0);
    expect(shell.style.top).toBe('683px');
    // The start moved by exactly as much, so the first frame is where it was.
    const next = String(on(body).keyframes[0].transform);
    expect(next).not.toBe(startY);
    expect(Number(/translate3d\(0(?:px)?, (-?[\d.]+)px/.exec(next)?.[1]) - Number(/translate3d\(0(?:px)?, (-?[\d.]+)px/.exec(startY)?.[1])).toBeCloseTo(17, 5);
    // …and it keeps following until it lands.
    expect(frames.length).toBe(1);
  });
});

describe('the rows that make room, and the composer', () => {
  it('glides the conversation on the flight\'s own curve, ending a beat before it lands', () => {
    const row = document.createElement('div');
    document.body.append(row);
    rects.set(row, { left: 100, top: 400, width: 500, height: 40 });
    const capture = captureRoom([row]);
    rects.set(row, { left: 100, top: 340, width: 500, height: 40 });
    const played = makeRoom(capture);
    expect(played).toHaveLength(1);
    const record = waapi.played.find((entry) => entry.target === row)!;
    expect(record.keyframes[0].transform).toBe('translate3d(0px, 60px, 0)');
    expect(Number(record.options.duration)).toBe(255);
    expect(record.options.easing).toBe(SEND_FLIGHT.glide);
    expect(record.animation.id).toBe('data-motion-recipe:send-room');
  });

  it('presses the composer: .992 and back over 135ms', () => {
    const capsule = document.createElement('div');
    document.body.append(capsule);
    pressComposer(capsule);
    const record = waapi.played.find((entry) => entry.target === capsule)!;
    expect(record.keyframes.map((frame) => frame.transform)).toEqual(['scale(1)', 'scale(0.992)', 'scale(1)']);
    expect(Number(record.options.duration)).toBe(135);
  });

  it('releases the send control from the cream look to the quiet one, in colors only', () => {
    const button = document.createElement('button');
    button.style.backgroundColor = 'rgb(199, 218, 237)';
    button.style.color = 'rgb(16, 19, 20)';
    // The Index message box declares its quiet look on the control (ix-composer.css).
    button.style.setProperty('--ix-send-quiet', 'rgba(255, 255, 255, 0.08)');
    button.style.setProperty('--ix-send-quiet-ink', 'rgba(235, 238, 242, 0.62)');
    document.body.append(button);
    releaseSend(button);
    const record = waapi.played.find((entry) => entry.target === button)!;
    expect(Object.keys(record.keyframes[0]).sort()).toEqual(['backgroundColor', 'color']);
    expect(record.keyframes[1]).toEqual({ backgroundColor: 'rgba(255, 255, 255, 0.08)', color: 'rgba(235, 238, 242, 0.62)' });
    expect(Number(record.options.duration)).toBe(190);
    expect(record.animation.id).toBe('data-motion-recipe:send-release');
  });

  it('leaves a control that declares no quiet look alone (the old Glass tokens no longer count)', () => {
    const button = document.createElement('button');
    button.style.setProperty('--glass-fill-quiet', 'rgba(255, 255, 255, 0.08)');
    button.style.setProperty('--ink-1', 'rgb(243, 245, 245)');
    document.body.append(button);
    expect(releaseSend(button)).toBeNull();
  });

  it('does neither under reduced motion', () => {
    stubMatchMedia(true);
    configureMotion('system');
    const button = document.createElement('button');
    document.body.append(button);
    expect(releaseSend(button)).toBeNull();
    const before = waapi.played.length;
    pressComposer(button);
    // A finished no-op, not a press.
    expect(waapi.played.slice(before).every((record: RecordedAnimation) => record.keyframes.length === 0)).toBe(true);
  });
});
