import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSwipeGesture } from './useSwipeGesture';

/** A touch event on `target`, with the fingers given (jsdom has no Touch). */
function touch(
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  points: Array<[number, number]>,
  target: EventTarget = document.body,
) {
  const list = points.map(([clientX, clientY]) => ({ clientX, clientY }));
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    touches: type === 'touchend' || type === 'touchcancel' ? [] : list,
    changedTouches: list,
  });
  target.dispatchEvent(event);
}

function swipe(from: [number, number], to: [number, number], target?: EventTarget) {
  touch('touchstart', [from], target);
  touch('touchmove', [[(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]], target);
  touch('touchend', [to], target);
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useSwipeGesture', () => {
  it('a swipe right from the left edge is "back"', () => {
    const onSwipeRight = vi.fn();
    renderHook(() => useSwipeGesture({ onSwipeRight }));
    swipe([4, 400], [140, 410]);
    expect(onSwipeRight).toHaveBeenCalledTimes(1);
  });

  it('a swipe left from the right edge is the other one', () => {
    const onSwipeLeft = vi.fn();
    const onSwipeRight = vi.fn();
    renderHook(() => useSwipeGesture({ onSwipeLeft, onSwipeRight }));
    swipe([386, 400], [250, 400]);
    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it('takes nothing that starts inside the screen: that is a scroll or a drag', () => {
    const onSwipeRight = vi.fn();
    renderHook(() => useSwipeGesture({ onSwipeRight }));
    swipe([150, 400], [290, 400]);
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it('takes nothing too short, or too far off the horizontal', () => {
    const onSwipeRight = vi.fn();
    renderHook(() => useSwipeGesture({ onSwipeRight }));
    swipe([4, 400], [40, 400]);
    swipe([4, 400], [140, 520]);
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it('drops a drag that turned vertical on the way, even if it ended level', () => {
    const onSwipeRight = vi.fn();
    renderHook(() => useSwipeGesture({ onSwipeRight }));
    touch('touchstart', [[4, 400]]);
    touch('touchmove', [[70, 520]]);
    touch('touchend', [[140, 405]]);
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it('takes no second finger, and lets go when the system takes the touch', () => {
    const onSwipeRight = vi.fn();
    renderHook(() => useSwipeGesture({ onSwipeRight }));
    touch('touchstart', [[4, 400], [200, 400]]);
    touch('touchend', [[140, 400]]);
    expect(onSwipeRight).not.toHaveBeenCalled();

    touch('touchstart', [[4, 400]]);
    touch('touchcancel', [[70, 400]]);
    touch('touchend', [[140, 400]]);
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it('leaves fields and opted-out elements alone', () => {
    const onSwipeRight = vi.fn();
    renderHook(() => useSwipeGesture({ onSwipeRight }));
    const field = document.createElement('textarea');
    const optedOut = document.createElement('div');
    optedOut.setAttribute('data-no-swipe', '');
    const inner = document.createElement('span');
    optedOut.append(inner);
    document.body.append(field, optedOut);
    swipe([4, 400], [140, 400], field);
    swipe([4, 400], [140, 400], inner);
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it('leaves a scroller that has been scrolled sideways to the scroller', () => {
    const onSwipeRight = vi.fn();
    renderHook(() => useSwipeGesture({ onSwipeRight }));
    const scroller = document.createElement('div');
    Object.defineProperties(scroller, {
      scrollLeft: { configurable: true, value: 40 },
      scrollWidth: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 300 },
    });
    const child = document.createElement('code');
    scroller.append(child);
    document.body.append(scroller);
    swipe([4, 400], [140, 400], child);
    expect(onSwipeRight).not.toHaveBeenCalled();

    // At its start it has nothing to scroll back to, so the edge swipe is the gesture's.
    Object.defineProperty(scroller, 'scrollLeft', { configurable: true, value: 0 });
    swipe([4, 400], [140, 400], child);
    expect(onSwipeRight).toHaveBeenCalledTimes(1);
  });

  it('listens to nothing while it is turned off, and to the newest handler when it is on', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ handler, enabled }) => useSwipeGesture({ onSwipeRight: handler }, enabled), {
      initialProps: { handler: first, enabled: false },
    });
    swipe([4, 400], [140, 400]);
    expect(first).not.toHaveBeenCalled();

    rerender({ handler: second, enabled: true });
    swipe([4, 400], [140, 400]);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('removes its listeners when it unmounts', () => {
    const onSwipeRight = vi.fn();
    const view = renderHook(() => useSwipeGesture({ onSwipeRight }));
    view.unmount();
    swipe([4, 400], [140, 400]);
    expect(onSwipeRight).not.toHaveBeenCalled();
  });
});
