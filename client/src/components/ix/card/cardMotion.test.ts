import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IX_EASE, IX_SPRING } from '../motion';
import {
  CARD_IN_DELAY_MS,
  CARD_IN_MS,
  CARD_OUT_MS,
  FLY_MS,
  PIN_MS,
  PUSH_UP_MS,
  ROW_IN_MS,
  ROW_OUT_MS,
  contentBelow,
  playEnter,
  playFlight,
  playLeave,
  playPinGhost,
  playPinMove,
  playPush,
  rememberYours,
  takeYours,
} from './cardMotion';

/**
 * The card's moments as Web Animations (docs/index-spec.md §5.4, §5.5, §5.7):
 * transform and opacity only, the spec's durations and curves, an id each, and
 * nothing filling forwards on an element that stays.
 */

const reduced = vi.hoisted(() => ({ on: false }));
vi.mock('../../../lib/motion/reducedMotion', () => ({ prefersReducedMotion: () => reduced.on }));

interface Call {
  element: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  animation: { id: string; cancel: () => void; finished: Promise<void> };
}
let calls: Call[] = [];
const ALLOWED = new Set(['transform', 'opacity', 'offset', 'transformOrigin', 'easing', 'composite']);

beforeEach(() => {
  calls = [];
  reduced.on = false;
  (Element.prototype as unknown as { animate: unknown }).animate = function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    const animation = { id: '', cancel: () => {}, finished: Promise.resolve() };
    calls.push({ element: this, keyframes, options, animation });
    return animation;
  };
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const box = (this as HTMLElement).dataset?.box?.split(',').map(Number) ?? [0, 0, 100, 40];
    return { left: box[0], top: box[1], width: box[2], height: box[3], right: box[0] + box[2], bottom: box[1] + box[3], x: box[0], y: box[1], toJSON: () => ({}) } as DOMRect;
  });
});

afterEach(() => {
  delete (Element.prototype as unknown as { animate?: unknown }).animate;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const el = (box = '0,0,100,40') => {
  const element = document.createElement('div');
  element.dataset.box = box;
  document.body.appendChild(element);
  return element;
};

function expectTransformOpacityOnly() {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    for (const frame of call.keyframes) for (const key of Object.keys(frame)) expect(ALLOWED).toContain(key);
    expect(call.animation.id).toMatch(/^ix-card:/);
  }
}

describe('card motion', () => {
  it('enter: the card 600ms and a row 500ms from translateY(-8px) scale(.97), spring', () => {
    playEnter(el(), 'card');
    playEnter(el(), 'row');
    expectTransformOpacityOnly();
    expect(calls[0].keyframes[0]).toEqual({ opacity: 0, transform: 'translateY(-8px) scale(0.97)' });
    // The card waits 120ms behind the push it causes (IX-18), held at its start by `backwards`
    // (which never outlasts the move: nothing fills after it ends).
    expect(calls[0].options).toMatchObject({ duration: CARD_IN_MS, delay: CARD_IN_DELAY_MS, easing: IX_SPRING, fill: 'backwards' });
    expect(calls[1].options).toMatchObject({ duration: ROW_IN_MS, easing: IX_SPRING });
    expect(calls[1].options.fill).toBeUndefined();
    expect(CARD_IN_DELAY_MS).toBe(120);
    expect([CARD_IN_MS, ROW_IN_MS]).toEqual([600, 500]);
  });

  it('leave: the card 300ms (reverse) and a row 250ms (fade and .97), ease; it fills because it is removed after', () => {
    playLeave(el(), 'card');
    playLeave(el(), 'row');
    expectTransformOpacityOnly();
    expect(calls[0].options).toMatchObject({ duration: CARD_OUT_MS, easing: IX_EASE, fill: 'forwards' });
    expect(calls[1].keyframes[1]).toEqual({ opacity: 0, transform: 'scale(0.97)' });
    expect(calls[1].options.duration).toBe(ROW_OUT_MS);
    expect([CARD_OUT_MS, ROW_OUT_MS]).toEqual([300, 250]);
  });

  it('push: displaced content plays back from where it was (translateY only)', () => {
    const a = el();
    playPush([a], -34);
    expectTransformOpacityOnly();
    expect(calls[0].keyframes).toEqual([{ transform: 'translateY(34px)' }, { transform: 'none' }]);
    expect(calls[0].options.duration).toBe(PUSH_UP_MS);
    expect(playPush([a], 0.2)).toEqual([]);
  });

  it('what a card pushes: everything below it up to the pane, never the dock', () => {
    document.body.innerHTML = `
      <nav class="ix-side"><div class="ix-side__pinned"><i id="card"></i></div><div class="ix-panes" id="panes"></div><div class="ix-side__dock"></div></nav>
      <div class="ix-pane"><div class="ix-sb"><div id="search"></div><div id="slot"></div><div id="rows"></div><div id="rooms"></div></div></div>`;
    expect(contentBelow(document.getElementById('slot')).map((e) => e.id)).toEqual(['rows', 'rooms']);
    expect(contentBelow(document.querySelector('.ix-side__pinned')).map((e) => e.id)).toEqual(['panes']);
  });

  it('flight: your face flies from the toolbar avatar as a ghost (translate + one scale, 750ms spring); the rest holds until 45%', () => {
    const face = el('20,200,24,24');
    const name = el();
    const flight = playFlight(face, { left: 1228, top: 13, width: 32, height: 32 }, [name]);
    expectTransformOpacityOnly();
    const ghost = document.querySelector('[data-ix-ghost]');
    expect(ghost).not.toBeNull();
    const fly = calls.find((call) => call.animation.id === 'ix-card:fly')!;
    expect(fly.element).toBe(ghost);
    expect(fly.options).toMatchObject({ duration: FLY_MS, easing: IX_SPRING });
    expect(fly.keyframes[0].transform).toBe('translate(1208px, -187px) scale(1.3333, 1.3333)');
    const hold = calls.find((call) => call.animation.id === 'ix-card:fly-hold')!;
    expect(hold.keyframes).toEqual([{ opacity: 0 }, { opacity: 0, offset: 0.45 }, { opacity: 1 }]);
    expect(face.style.visibility).toBe('hidden');
    flight.done();
    expect(document.querySelector('[data-ix-ghost]')).toBeNull();
    expect(face.style.visibility).toBe('');
  });

  it('pinned and inline: a translate-only move of 550ms, in place or as a copy on the document', () => {
    const card = el('12,124,292,160');
    playPinMove(card, { left: 12, top: 28, width: 292, height: 170 });
    const target = el('12,124,292,160');
    const played = playPinGhost({ clone: document.createElement('section'), rect: { left: 12, top: 28, width: 292, height: 170 } }, target);
    expectTransformOpacityOnly();
    expect(calls.every((call) => call.options.duration === PIN_MS)).toBe(true);
    expect(calls[0].keyframes[0]).toEqual({ transform: 'translate(0px, -96px)' });
    expect(target.style.opacity).toBe('0');
    played.done();
    expect(target.style.opacity).toBe('');
  });

  it('reduced motion: moves are 150ms fades; displaced content does not move; nothing flies', () => {
    reduced.on = true;
    playEnter(el(), 'card');
    expect(playPush([el()], 40)).toEqual([]);
    playFlight(el(), { left: 0, top: 0, width: 32, height: 32 }, []);
    expect(document.querySelector('[data-ix-ghost]')).toBeNull();
    for (const call of calls) {
      expect(call.options.duration).toBe(150);
      for (const frame of call.keyframes) expect(Object.keys(frame)).toEqual(['opacity']);
    }
  });

  it('the snapshot of your card is taken once and only for the slot it left', () => {
    const card = el();
    rememberYours('s:1', 'pinned', card);
    expect(takeYours('s:1', 'inline')).toBeNull();
    rememberYours('s:1', 'pinned', card);
    expect(takeYours('s:1', 'pinned')?.position).toBe('pinned');
    expect(takeYours('s:1', 'pinned')).toBeNull();
  });
});
