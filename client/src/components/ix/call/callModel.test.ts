import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureMotion, resetMotionSwitchForTests } from '../../../lib/motion/reducedMotion';
import { installWaapiStub, type WaapiStub } from '../../../lib/motion/waapiStub';
import type { StagePerson } from '../../glass/stage/stageModel';
import { IX_SPRING } from '../motion';
import {
  autoFocusStream,
  callPeople,
  callPlaceLine,
  callRegionLabel,
  controlSet,
  focusBox,
  focusOf,
  gridColumns,
  gridLayout,
  tileFocus,
} from './callModel';
import {
  CALL_CLOSE_MS,
  CALL_CONTENT_FROM,
  CALL_CONTENT_TO,
  CALL_OPEN_MS,
  counterKeyframes,
  findCallCard,
  ghostOf,
  playClose,
  playOpen,
  playTheater,
} from './callMotion';

/** The call view's rules (docs/index-spec.md §7.2) and moves (§5.8, §5.9). */

function person(userId: string, over: Partial<StagePerson> = {}): StagePerson {
  return {
    userId,
    name: userId[0].toUpperCase() + userId.slice(1),
    avatar: null,
    self: false,
    listening: false,
    muted: false,
    sharing: false,
    streamStartedAt: null,
    talking: false,
    camera: false,
    ...over,
  };
}

describe('callModel', () => {
  it('grid columns: 2, 3 above 4 people, 4 above 9', () => {
    expect([1, 2, 4, 5, 9, 10, 20].map(gridColumns)).toEqual([2, 2, 2, 3, 3, 4, 4]);
  });

  it('tall tiles without a camera; 16:9 tiles at the largest size that fits with one', () => {
    expect(gridLayout(2, false, 900, 600)).toEqual({ columns: 2, rows: 1, tile: null });
    // 2 columns in 900 wide: 444 each; one row of 600: 1066 by height. Width wins.
    expect(gridLayout(2, true, 900, 600).tile).toEqual({ width: 444, height: 250 });
    // 5 people: 3 columns, 2 rows in 900x300: by height (300-12)/2*16/9 = 256.
    expect(gridLayout(5, true, 900, 300)).toEqual({ columns: 3, rows: 2, tile: { width: 256, height: 144 } });
  });

  it('a focused picture is 16:9 above the 112px filmstrip', () => {
    expect(focusBox(1000, 800, true)).toEqual({ width: 1000, height: 563 });
    expect(focusBox(1000, 400, true)).toEqual({ width: 490, height: 276 });
    expect(focusBox(1000, 400, false)).toEqual({ width: 711, height: 400 });
  });

  it('people: tiles in join order, listeners and a stage audience in one row', () => {
    const joined = new Map([
      ['jeremy', 1],
      ['me', 3],
      ['maya', 2],
    ]);
    const model = {
      cameras: [person('maya', { camera: true })],
      chips: [person('me', { self: true }), person('jeremy'), person('nick', { listening: true }), person('vincent')],
    };
    const result = callPeople(model, new Set(['vincent']), joined);
    expect(result.tiles.map((p) => p.userId)).toEqual(['jeremy', 'maya', 'me']);
    expect(result.listening.map((p) => p.userId)).toEqual(['nick', 'vincent']);
    expect(result.anyCamera).toBe(true);
  });

  it('focus: the stage target names a stream; else a camera still on; else the grid', () => {
    const people = [person('brendan', { camera: true }), person('nick')];
    expect(focusOf('vincent', 'brendan', people)).toEqual({ kind: 'stream', userId: 'vincent' });
    expect(focusOf(null, 'brendan', people)).toEqual({ kind: 'camera', userId: 'brendan' });
    expect(focusOf(null, 'nick', people)).toEqual({ kind: 'grid' });
    expect(focusOf(null, null, people)).toEqual({ kind: 'grid' });
  });

  it('auto focus: somebody else\'s earliest share, never your own, never one put away', () => {
    const people = [
      person('vincent', { sharing: true, streamStartedAt: 20 }),
      person('brendan', { sharing: true, streamStartedAt: 10 }),
      person('me', { self: true, sharing: true, streamStartedAt: 1 }),
    ];
    expect(autoFocusStream(people, new Set())).toBe('brendan');
    expect(autoFocusStream(people, new Set(['brendan']))).toBe('vincent');
    expect(autoFocusStream(people, new Set(['brendan', 'vincent']))).toBeNull();
  });

  it('controls by state: joined, audience, watching', () => {
    expect(controlSet({ controls: 'joined', audience: false })).toBe('joined');
    expect(controlSet({ controls: 'joined', audience: true })).toBe('audience');
    expect(controlSet({ controls: 'not-joined', audience: false })).toBe('watching');
  });

  it('words: "Call: General", the server or "Direct call"; a tile focuses a stream before a camera', () => {
    expect(callRegionLabel({ channelName: 'General' })).toBe('Call: General');
    expect(callPlaceLine({ dm: false, guildName: 'Fuel' })).toBe('Fuel');
    expect(callPlaceLine({ dm: true, guildName: null })).toBe('Direct call');
    expect(tileFocus(person('v', { sharing: true, camera: true }))).toBe('stream');
    expect(tileFocus(person('b', { camera: true }))).toBe('camera');
    expect(tileFocus(person('n'))).toBeNull();
  });
});

describe('callMotion', () => {
  let waapi: WaapiStub;
  beforeEach(() => {
    waapi = installWaapiStub();
    resetMotionSwitchForTests();
    configureMotion('full');
  });
  afterEach(() => {
    waapi.restore();
    resetMotionSwitchForTests();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const box = (left: number, top: number, width: number, height: number) => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(el);
    return el;
  };

  it('open grows the surface out of the card (translate + non-uniform scale, .3 -> 1, 600ms spring); content fades from 40%', () => {
    const surface = box(326, 10, 944, 780);
    const content = document.createElement('div');
    surface.appendChild(content);
    const played = playOpen(surface, content, { left: 12, top: 124, width: 292, height: 165 });
    expect(played.map((a) => a.id)).toEqual(['ix-call:open', 'ix-call:open-content']);
    const [grow, counter] = waapi.played;
    expect(grow.options).toMatchObject({ duration: CALL_OPEN_MS, easing: IX_SPRING });
    expect(grow.keyframes[0]).toMatchObject({ transform: 'translate(-314px, 114px) scale(0.3093, 0.2115)', transformOrigin: '0 0', opacity: 0.3 });
    expect(grow.keyframes[1]).toMatchObject({ transform: 'none', opacity: 1 });
    // The counter-layer undoes the scale at every sample and holds at 0 until 40%.
    expect(counter.keyframes[0]).toMatchObject({ transform: 'scale(3.2329, 4.7273)', opacity: 0 });
    expect(counter.keyframes.at(-1)).toMatchObject({ transform: 'none', opacity: 1 });
    expect(counter.keyframes.filter((frame) => (frame.offset as number) <= CALL_CONTENT_FROM).every((frame) => frame.opacity === 0)).toBe(true);
    // Exactly at 40% (a keyframe of its own, not the sample before it), and whole by 75% (IX-18).
    expect(counter.keyframes.some((frame) => frame.offset === CALL_CONTENT_FROM && frame.opacity === 0)).toBe(true);
    expect(counter.keyframes.filter((frame) => (frame.offset as number) >= CALL_CONTENT_TO).every((frame) => frame.opacity === 1)).toBe(true);
    // Transform and opacity only.
    const props = new Set(waapi.played.flatMap((record) => record.keyframes.flatMap((frame) => Object.keys(frame))));
    expect([...props].sort()).toEqual(['offset', 'opacity', 'transform', 'transformOrigin']);
  });

  it('theater FLIPs the surface from where it was; reduced motion fades in place', () => {
    const surface = box(10, 10, 1260, 780);
    expect(playTheater(surface, null, { left: 326, top: 10, width: 944, height: 780 }).map((a) => a.id)).toEqual(['ix-call:theater']);
    expect(waapi.played[0].keyframes[0]).toMatchObject({ transform: 'translate(316px, 0px) scale(0.7492, 1)' });
    configureMotion('reduced');
    playTheater(surface, null, { left: 326, top: 10, width: 944, height: 780 });
    expect(waapi.played[1].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(waapi.played[1].options.duration).toBe(150);
  });

  it('counter keyframes end at rest and invert the start scale', () => {
    const frames = counterKeyframes({ left: 0, top: 0, width: 100, height: 50 }, { left: 0, top: 0, width: 200, height: 200 });
    expect(frames[0].transform).toBe('scale(2, 4)');
    expect(frames.at(-1)?.transform).toBe('none');
    expect(frames.every((frame) => frame.opacity === undefined)).toBe(true);
  });

  it('close: a still copy (no ids, no test ids, no hole) shrinks into the card in 450ms, then goes', async () => {
    const surface = box(326, 10, 944, 780);
    surface.setAttribute('data-testid', 'ix-call');
    surface.setAttribute('data-native-underlay-clear', '');
    surface.innerHTML = '<div><span id="x" data-native-surface-boundary="">in</span></div>';
    const ghost = ghostOf(surface);
    expect(ghost.getAttribute('data-testid')).toBeNull();
    expect(ghost.hasAttribute('data-native-underlay-clear')).toBe(false);
    expect(ghost.querySelector('[id], [data-native-surface-boundary]')).toBeNull();
    expect(ghost).toHaveAttribute('aria-hidden', 'true');
    ghost.getBoundingClientRect = surface.getBoundingClientRect;
    const done = vi.fn();
    const played = playClose(ghost, { left: 12, top: 124, width: 292, height: 165 }, done);
    expect(played.map((a) => a.id)).toEqual(['ix-call:close', 'ix-call:close-content']);
    expect(waapi.played[0].options).toMatchObject({ duration: CALL_CLOSE_MS, easing: IX_SPRING });
    expect(waapi.played[0].keyframes[1]).toMatchObject({ transform: 'translate(-314px, 114px) scale(0.3093, 0.2115)', opacity: 0.3 });
    for (const animation of played) animation.finish();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(done).toHaveBeenCalledTimes(1);
    expect(ghost.isConnected).toBe(false);
  });

  it('finds the card the call grows out of: yours for the channel, not one sliding out', () => {
    const leaving = document.createElement('div');
    leaving.setAttribute('data-leaving', '');
    leaving.appendChild(Object.assign(box(0, 0, 10, 10), {}));
    const sliding = leaving.firstElementChild as HTMLElement;
    sliding.setAttribute('data-testid', 'ix-room-card');
    sliding.dataset.cardKey = 'local:general';
    sliding.setAttribute('data-ix-call-card', '');
    document.body.appendChild(leaving);
    const live = box(12, 124, 292, 165);
    live.setAttribute('data-testid', 'ix-room-card');
    live.dataset.cardKey = 'local:general';
    const yours = box(12, 28, 292, 165);
    yours.setAttribute('data-testid', 'ix-room-card');
    yours.dataset.cardKey = 'local:general';
    yours.setAttribute('data-ix-call-card', '');
    expect(findCallCard('general')).toBe(yours);
    yours.remove();
    expect(findCallCard('general')).toBe(live);
    expect(findCallCard('lounge')).toBeNull();
  });
});
