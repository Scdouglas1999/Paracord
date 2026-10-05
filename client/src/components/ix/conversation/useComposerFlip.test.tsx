import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emitMotion, resetMotionBusForTests } from '../../../lib/motion/bus';
import { configureMotion, resetMotionSwitchForTests } from '../../../lib/motion/reducedMotion';
import { installWaapiStub, type WaapiStub } from '../../../lib/motion/waapiStub';
import { IX_SPRING } from '../motion';
import { FEED_GROW_MS, FEED_SHRINK_MS, planFeedMoves, useComposerFlip } from './useComposerFlip';

/**
 * The feed follows the message box (docs/index-spec.md §5.12): 500ms growing, 350ms
 * shrinking, transform only, from where the content was. jsdom lays nothing out, so
 * the scroller's numbers are set by hand and the ResizeObserver is the test's.
 */

let waapi: WaapiStub;
let observers: Array<(entries: unknown[]) => void> = [];

class FakeResizeObserver {
  constructor(callback: (entries: unknown[]) => void) {
    observers.push(callback);
  }
  observe() {}
  disconnect() {
    observers = [];
  }
}

beforeEach(() => {
  waapi = installWaapiStub();
  resetMotionSwitchForTests();
  configureMotion('full');
  observers = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  waapi.restore();
  resetMotionSwitchForTests();
  resetMotionBusForTests();
  vi.unstubAllGlobals();
});

function dom(options: { overflow?: boolean; empty?: 'center' | 'end' } = {}) {
  const column = document.createElement('div');
  const scroller = document.createElement('div');
  const header = document.createElement('div');
  header.className = 'ix-timeline__header';
  scroller.appendChild(header);
  let content: HTMLElement | null = null;
  let welcome: HTMLElement | null = null;
  if (options.empty) {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-timeline-empty', '');
    welcome = document.createElement('div');
    welcome.setAttribute('data-ix-anchor', options.empty);
    wrapper.appendChild(welcome);
    scroller.appendChild(wrapper);
  } else {
    content = document.createElement('div');
    content.className = 'ix-timeline__content';
    scroller.appendChild(content);
  }
  // The scroller after the box changed: 600px tall content in a 500px viewport, or all of it fitting.
  const metrics = { scrollHeight: options.overflow ? 600 : 400, clientHeight: 500, scrollTop: 0 };
  for (const key of Object.keys(metrics) as Array<keyof typeof metrics>) {
    Object.defineProperty(scroller, key, { get: () => metrics[key], set: (value: number) => void (metrics[key] = value), configurable: true });
  }
  return { column, scroller, header, content, welcome, metrics };
}

const resize = (height: number) => observers.forEach((callback) => callback([{ borderBoxSize: [{ blockSize: height }] }]));
const animatedBy = (element: Element | null) => waapi.played.filter((record) => record.target === element);

describe('planFeedMoves', () => {
  const a = document.createElement('div');
  const b = document.createElement('div');
  const c = document.createElement('div');
  it('moves what sits on the box by the whole change, the title only when the scroller moved', () => {
    const moves = planFeedMoves({ delta: 46, header: a, content: b, receipt: c, empty: null, emptyShare: 0.5, overflow: false, atEnd: true });
    expect(moves.map((move) => [move.element, move.from])).toEqual([[b, 46], [c, 46]]);
    const scrolled = planFeedMoves({ delta: 46, header: a, content: b, receipt: null, empty: null, emptyShare: 0.5, overflow: true, atEnd: true });
    expect(scrolled.map((move) => move.element)).toEqual([b, a]);
  });

  it('moves nothing for a feed the reader scrolled away from', () => {
    expect(planFeedMoves({ delta: 46, header: a, content: b, receipt: c, empty: null, emptyShare: 0.5, overflow: true, atEnd: false })).toEqual([]);
  });

  it('moves a welcome by its share', () => {
    const empty = document.createElement('div');
    const inner = document.createElement('div');
    empty.appendChild(inner);
    expect(planFeedMoves({ delta: 46, header: a, content: null, receipt: null, empty, emptyShare: 0.5, overflow: false, atEnd: true })).toEqual([
      { element: inner, from: 23 },
    ]);
  });
});

describe('useComposerFlip', () => {
  it('does nothing for the first measurement and for a change under a pixel', () => {
    const { column, scroller, content } = dom();
    renderHook(() => useComposerFlip(column, scroller, 'c1'));
    resize(52);
    resize(52.4);
    expect(animatedBy(content)).toHaveLength(0);
  });

  it('opening: the content on the box starts 46px low and glides up, 500ms on the spring, adding', () => {
    const { column, scroller, content, header } = dom();
    renderHook(() => useComposerFlip(column, scroller, 'c1'));
    resize(52);
    resize(98);
    const [played] = animatedBy(content);
    expect(played.keyframes).toEqual([{ transform: 'translateY(46px)' }, { transform: 'translateY(0)' }]);
    expect(played.options).toMatchObject({ duration: FEED_GROW_MS, easing: IX_SPRING, composite: 'add' });
    expect(played.animation.id).toBe('ix-conversation:feed');
    // The title is at the top of a feed that fits: it does not move.
    expect(animatedBy(header)).toHaveLength(0);
    // Only transform animates.
    expect(new Set(waapi.played.flatMap((record) => record.keyframes.flatMap((frame) => Object.keys(frame))))).toEqual(new Set(['transform']));
  });

  it('closing: 350ms, from above', () => {
    const { column, scroller, content } = dom();
    renderHook(() => useComposerFlip(column, scroller, 'c1'));
    resize(98);
    resize(52);
    const [played] = animatedBy(content);
    expect(played.keyframes[0]).toEqual({ transform: 'translateY(-46px)' });
    expect(played.options.duration).toBe(FEED_SHRINK_MS);
  });

  it('keeps the newest message above a growing box: the scroller moves with it, and everything glides', () => {
    const { column, scroller, content, header, metrics } = dom({ overflow: true });
    // The viewport shrank by 46 with the scroller at its old end (scrollTop was 100 of 100): now 46 short.
    metrics.scrollTop = 54;
    renderHook(() => useComposerFlip(column, scroller, 'c1'));
    resize(52);
    resize(98);
    expect(metrics.scrollTop).toBe(100);
    expect(animatedBy(content)).toHaveLength(1);
    expect(animatedBy(header)).toHaveLength(1);
  });

  it('leaves a reader who scrolled up alone', () => {
    const { column, scroller, content, header, metrics } = dom({ overflow: true });
    metrics.scrollTop = 0; // 100px from the end after the change, so 54px from it before
    renderHook(() => useComposerFlip(column, scroller, 'c1'));
    resize(52);
    resize(98);
    expect(metrics.scrollTop).toBe(0);
    expect(animatedBy(content)).toHaveLength(0);
    expect(animatedBy(header)).toHaveLength(0);
  });

  it('a centered welcome moves half as far; a draft on the box moves all of it', () => {
    const center = dom({ empty: 'center' });
    const { unmount } = renderHook(() => useComposerFlip(center.column, center.scroller, 'c1'));
    resize(52);
    resize(98);
    expect(animatedBy(center.welcome)[0].keyframes[0]).toEqual({ transform: 'translateY(23px)' });
    unmount();
    waapi.played.length = 0;
    const end = dom({ empty: 'end' });
    renderHook(() => useComposerFlip(end.column, end.scroller, 'c1'));
    resize(52);
    resize(98);
    expect(animatedBy(end.welcome)[0].keyframes[0]).toEqual({ transform: 'translateY(46px)' });
  });

  it('snaps under reduced motion, but still keeps the end in view', () => {
    configureMotion('reduced');
    const { column, scroller, content, metrics } = dom({ overflow: true });
    metrics.scrollTop = 54;
    renderHook(() => useComposerFlip(column, scroller, 'c1'));
    resize(52);
    resize(98);
    expect(metrics.scrollTop).toBe(100);
    expect(animatedBy(content)).toHaveLength(0);
  });

  it('leaves the send’s own change to the send flight', () => {
    const { column, scroller, content } = dom();
    renderHook(() => useComposerFlip(column, scroller, 'c1'));
    resize(98);
    emitMotion('say:sent', { channelId: 'c1', nonce: 'n', text: 'hi', origin: null });
    resize(52);
    expect(animatedBy(content)).toHaveLength(0);
  });

  it('a send in another conversation is not this one’s business', () => {
    const { column, scroller, content } = dom();
    renderHook(() => useComposerFlip(column, scroller, 'c1'));
    resize(98);
    emitMotion('say:sent', { channelId: 'other', nonce: 'n', text: 'hi', origin: null });
    resize(52);
    expect(animatedBy(content)).toHaveLength(1);
  });
});
