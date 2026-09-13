import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  configureMotion,
  resetMotionSwitchForTests,
  setStreetPaintedForTests,
  useFlipList,
  usePresence,
  useSettleIn,
} from './index';
import { installWaapiStub, type WaapiStub } from './waapiStub';

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
}

let waapi: WaapiStub;
const originalRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  document.body.replaceChildren();
  resetMotionSwitchForTests();
  setStreetPaintedForTests(false);
  waapi = installWaapiStub();
});

afterEach(() => {
  waapi.restore();
  resetMotionSwitchForTests();
  setStreetPaintedForTests(false);
  Element.prototype.getBoundingClientRect = originalRect;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* usePresence — staying mounted for the exit                                  */
/* -------------------------------------------------------------------------- */

function PresenceBox({ open }: { open: boolean }) {
  const presence = usePresence(open);
  if (!presence.mounted) return null;
  return <div data-testid="box" className={presence.exiting ? 'pc-exit' : 'pc-enter'} />;
}

describe('usePresence', () => {
  beforeEach(() => {
    stubMatchMedia(false);
    configureMotion('full');
    vi.useFakeTimers();
  });

  it('keeps a closed element mounted for the leave, then drops it', () => {
    const { rerender, queryByTestId } = render(<PresenceBox open />);
    rerender(<PresenceBox open={false} />);
    // Still in the tree, wearing the exit class.
    expect(queryByTestId('box')?.className).toBe('pc-exit');
    act(() => vi.advanceTimersByTime(200));
    expect(queryByTestId('box')).toBeNull();
  });

  it('is interruptible — reopening mid-leave cancels the exit', () => {
    const { rerender, queryByTestId } = render(<PresenceBox open />);
    rerender(<PresenceBox open={false} />);
    expect(queryByTestId('box')?.className).toBe('pc-exit');
    rerender(<PresenceBox open />);
    expect(queryByTestId('box')?.className).toBe('pc-enter');
    act(() => vi.advanceTimersByTime(500));
    expect(queryByTestId('box')).not.toBeNull();
  });

  it('unmounts on the spot under reduced motion', () => {
    stubMatchMedia(true);
    configureMotion('system');
    const { rerender, queryByTestId } = render(<PresenceBox open />);
    rerender(<PresenceBox open={false} />);
    expect(queryByTestId('box')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* useSettleIn — a plate settling onto a street that is already there          */
/* -------------------------------------------------------------------------- */

function Plate({ children = 'plate' }: { children?: string }) {
  const ref = useSettleIn<HTMLDivElement>();
  return <div ref={ref}>{children}</div>;
}

describe('useSettleIn', () => {
  beforeEach(() => {
    stubMatchMedia(false);
    configureMotion('full');
  });

  it('does not animate the first paint of the street', () => {
    render(<Plate />);
    expect(waapi.played).toHaveLength(0);
  });

  it('rises 14px on the spring when mounting into a painted street', () => {
    setStreetPaintedForTests(true);
    render(<Plate />);
    expect(waapi.played).toHaveLength(1);
    expect(waapi.played[0].keyframes[0].transform).toBe('translate3d(0, 14px, 0)');
    expect(Number(waapi.played[0].options.duration)).toBe(380);
  });
});

/* -------------------------------------------------------------------------- */
/* useFlipList — a list that changes order travels, never snaps                */
/* -------------------------------------------------------------------------- */

const tops = new Map<string, number>();

/** The container's own viewport box — rows outside it have no leave to show. */
const CONTAINER = { top: 0, height: 200 };

function stubRects() {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const key = this.getAttribute?.('data-flip-key');
    const top = key ? (tops.get(key) ?? 0) : CONTAINER.top;
    const height = key ? 10 : CONTAINER.height;
    return {
      left: 0,
      top,
      width: 100,
      height,
      right: 100,
      bottom: top + height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  };
}

function Rows({ keys, enter }: { keys: string[]; enter?: 'rise' | 'pop' }) {
  const ref = useFlipList<HTMLDivElement>({ enter });
  return (
    <div ref={ref}>
      {keys.map((key) => (
        <div key={key} data-flip-key={key}>
          {key}
        </div>
      ))}
    </div>
  );
}

describe('useFlipList', () => {
  beforeEach(() => {
    stubMatchMedia(false);
    configureMotion('full');
    tops.clear();
    CONTAINER.top = 0;
    CONTAINER.height = 200;
    stubRects();
  });

  it('only measures on the first commit — nothing animates on mount', () => {
    tops.set('a', 0);
    tops.set('b', 10);
    render(<Rows keys={['a', 'b']} />);
    expect(waapi.played).toHaveLength(0);
  });

  it('springs a reordered row from where it was to where it landed', () => {
    tops.set('a', 0);
    tops.set('b', 10);
    const { rerender } = render(<Rows keys={['a', 'b']} />);
    // b climbs over a: b goes 10 → 0, a goes 0 → 10.
    tops.set('b', 0);
    tops.set('a', 10);
    rerender(<Rows keys={['b', 'a']} />);
    expect(waapi.played).toHaveLength(2);
    const b = waapi.played.find((record) => (record.target as HTMLElement).dataset.flipKey === 'b')!;
    expect(b.keyframes[0].transform).toBe('translate3d(0px, 10px, 0)');
    expect(b.keyframes[1].transform).toBe('translate3d(0, 0, 0)');
    expect(Number(b.options.duration)).toBe(380);
  });

  it('fades and rises a row that arrived', () => {
    tops.set('a', 0);
    const { rerender } = render(<Rows keys={['a']} />);
    tops.set('c', 10);
    rerender(<Rows keys={['a', 'c']} />);
    const arrived = waapi.played.find((record) => (record.target as HTMLElement).dataset.flipKey === 'c')!;
    expect(arrived.keyframes[0].opacity).toBe(0);
    expect(arrived.keyframes[0].transform).toBe('translate3d(0, 6px, 0)');
  });

  it('paints a leaving row as a falling clone at its old spot', async () => {
    tops.set('a', 0);
    tops.set('b', 10);
    const { rerender } = render(<Rows keys={['a', 'b']} />);
    rerender(<Rows keys={['a']} />);
    const clone = document.body.querySelector('[aria-hidden="true"]') as HTMLElement | null;
    expect(clone).not.toBeNull();
    const leaving = waapi.played.find((record) => record.target === clone)!;
    expect(leaving.keyframes[1].opacity).toBe(0);
    expect(leaving.keyframes[1].transform).toBe('translate3d(0, 4px, 0)');
    leaving.animation.finish();
    await leaving.animation.finished;
    expect(document.body.contains(clone)).toBe(false);
  });

  it('pops a reaction rather than sliding it in', () => {
    tops.set('a', 0);
    const { rerender } = render(<Rows keys={['a']} enter="pop" />);
    tops.set('c', 0);
    rerender(<Rows keys={['a', 'c']} enter="pop" />);
    const arrived = waapi.played.find((record) => (record.target as HTMLElement).dataset.flipKey === 'c')!;
    expect(arrived.keyframes[0].transform).toBe('scale(0.6)');
    expect(arrived.keyframes[1].transform).toBe('scale(1)');
  });

  it('leaves a row that scrolled out of view alone — no clone over the chrome', () => {
    tops.set('a', 0);
    tops.set('b', 10);
    const { rerender } = render(<Rows keys={['a', 'b']} />);
    // b is now below the container's visible box: its leave cannot be seen,
    // and a fixed clone there would fall across whatever sits below the list.
    tops.set('b', 400);
    rerender(<Rows keys={['a', 'b']} />);
    rerender(<Rows keys={['a']} />);
    expect(document.body.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('a scroll is not a reorder — rows measured against the container stay put', () => {
    tops.set('a', 0);
    tops.set('b', 10);
    const { rerender } = render(<Rows keys={['a', 'b']} />);
    // The list scrolls 40px: every row's viewport rect moves, the container's
    // moves with it, and nothing has actually changed order.
    CONTAINER.top = -40;
    tops.set('a', -40);
    tops.set('b', -30);
    rerender(<Rows keys={['a', 'b']} />);
    expect(waapi.played).toHaveLength(0);
  });

  it('plays nothing at all under reduced motion', () => {
    stubMatchMedia(true);
    configureMotion('system');
    tops.set('a', 0);
    tops.set('b', 10);
    const { rerender } = render(<Rows keys={['a', 'b']} />);
    tops.set('b', 0);
    tops.set('a', 10);
    rerender(<Rows keys={['b', 'a']} />);
    expect(waapi.played).toHaveLength(0);
  });
});
