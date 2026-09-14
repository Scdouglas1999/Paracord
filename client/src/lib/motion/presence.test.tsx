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
  return (
    <div
      data-testid="box"
      role="dialog"
      className={presence.exiting ? 'pc-exit' : 'pc-enter'}
      {...presence.scenery}
    />
  );
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

  it('a leaving surface is scenery — out of the tree that is read and tabbed', () => {
    const { rerender, queryByTestId, queryByRole } = render(<PresenceBox open />);
    expect(queryByRole('dialog')).not.toBeNull();
    rerender(<PresenceBox open={false} />);
    const box = queryByTestId('box')!;
    expect(box.getAttribute('aria-hidden')).toBe('true');
    expect(box.hasAttribute('inert')).toBe(true);
    // …and a screen reader can no longer reach it, which is the point.
    expect(queryByRole('dialog')).toBeNull();
    act(() => vi.advanceTimersByTime(200));
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

/** A street: the container the plates share, so a plate has neighbours. */
function Street({ keys }: { keys: string[] }) {
  return (
    <div>
      {keys.map((key) => (
        <Plate key={key}>{key}</Plate>
      ))}
    </div>
  );
}

/** Let the two frames the standing mark waits for actually pass. */
async function paintTwoFrames() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
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

  it('rises 14px on the spring when joining a street that is already standing', async () => {
    setStreetPaintedForTests(true);
    const { rerender } = render(<Street keys={['a', 'b']} />);
    // The pair arrived together: neither of them had a street to join.
    expect(waapi.played).toHaveLength(0);
    await paintTwoFrames();

    rerender(<Street keys={['a', 'b', 'c']} />);
    expect(waapi.played).toHaveLength(1);
    expect(waapi.played[0].keyframes[0].transform).toBe('translate3d(0, 14px, 0)');
    expect(Number(waapi.played[0].options.duration)).toBe(380);
  });

  it('does not animate a whole street arriving in one commit', async () => {
    // §5.3: "never animate on first paint what the user did not cause" — and a
    // route change, or a guild's data landing under a screen that is already
    // up, mounts the whole surface at once. That is WP9b's lights-on sequence,
    // which is not this hook's to play a second time.
    setStreetPaintedForTests(true);
    render(<Street keys={['a', 'b', 'c', 'd']} />);
    expect(waapi.played).toHaveLength(0);
    await paintTwoFrames();
    expect(waapi.played).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* useFlipList — a list that changes order travels, never snaps                */
/* -------------------------------------------------------------------------- */

const tops = new Map<string, number>();

/**
 * How far a running animation is currently DRAWING a row from where layout put
 * it. The hook has to tell the two apart: it remembers the layout place and
 * retargets from the drawn one, and reading the drawn one as the row's resting
 * place is the compounding bug this covers.
 */
const drift = new Map<string, number>();

/** The container's own viewport box — rows outside it have no leave to show. */
const CONTAINER = { top: 0, height: 200 };

function stubRects() {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const key = this.getAttribute?.('data-flip-key');
    const top = key ? (tops.get(key) ?? 0) + (drift.get(key) ?? 0) : CONTAINER.top;
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
  // jsdom has no layout, so the offset chain the hook reads its resting boxes
  // from has to be stubbed alongside the rects. Transform-free by definition:
  // `drift` is deliberately absent here.
  const layoutTop = function (this: HTMLElement) {
    const key = this.getAttribute?.('data-flip-key');
    return key ? (tops.get(key) ?? 0) : CONTAINER.top;
  };
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get: layoutTop });
  Object.defineProperty(HTMLElement.prototype, 'offsetLeft', { configurable: true, get: () => 0 });
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get: () => null });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 100 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute?.('data-flip-key') ? 10 : CONTAINER.height;
    },
  });
}

function Rows({ keys, enter, own = [] }: { keys: string[]; enter?: 'rise' | 'pop'; own?: string[] }) {
  const ref = useFlipList<HTMLDivElement>({ enter });
  return (
    <div ref={ref}>
      {keys.map((key) => (
        <div key={key} data-flip-key={key} data-flip-own={own.includes(key) || undefined}>
          <span data-flip-glyph>{key}</span>
        </div>
      ))}
    </div>
  );
}

/** A row inside a marked section — the Buildings column's own shape. */
function Nested() {
  const ref = useFlipList<HTMLDivElement>();
  return (
    <div ref={ref}>
      <div data-flip-key="s">
        <div data-flip-key="r" />
      </div>
    </div>
  );
}

describe('useFlipList', () => {
  beforeEach(() => {
    stubMatchMedia(false);
    configureMotion('full');
    tops.clear();
    drift.clear();
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

  it('pops an incoming reaction smaller — 0.8 to 1, no glyph flourish', () => {
    tops.set('a', 0);
    const { rerender } = render(<Rows keys={['a']} enter="pop" />);
    tops.set('c', 0);
    rerender(<Rows keys={['a', 'c']} enter="pop" />);
    const arrived = waapi.played.find((record) => (record.target as HTMLElement).dataset.flipKey === 'c')!;
    expect(arrived.keyframes[0].transform).toBe('scale(0.8)');
    expect(arrived.keyframes[1].transform).toBe('scale(1)');
    expect(arrived.animation.id).toBe('data-motion-recipe:pop');
    // Somebody else's: the row pops, the emoji does not over-rotate.
    expect(
      waapi.played.filter(
        (record) => (record.target as HTMLElement).dataset.flipGlyph !== undefined,
      ),
    ).toHaveLength(0);
  });

  it('pops your own reaction the full 0.6 and over-rotates the emoji', () => {
    tops.set('a', 0);
    const { rerender } = render(<Rows keys={['a']} enter="pop" />);
    tops.set('c', 0);
    rerender(<Rows keys={['a', 'c']} enter="pop" own={['c']} />);
    const arrived = waapi.played.find((record) => (record.target as HTMLElement).dataset.flipKey === 'c')!;
    expect(arrived.keyframes[0].transform).toBe('scale(0.6)');
    expect(arrived.keyframes[1].transform).toBe('scale(1)');
    const glyph = waapi.played.find((record) => (record.target as HTMLElement).dataset.flipGlyph !== undefined)!;
    expect(glyph.keyframes[0].transform).toBe('rotate(-8deg)');
    expect(glyph.keyframes[1].transform).toBe('rotate(0deg)');
    expect(glyph.animation.id).toBe('data-motion-recipe:pop');
  });

  it('shrinks a leaving pop row back out rather than dropping it', () => {
    tops.set('a', 0);
    tops.set('b', 0);
    const { rerender } = render(<Rows keys={['a', 'b']} enter="pop" />);
    rerender(<Rows keys={['a']} enter="pop" />);
    const clone = document.body.querySelector('[aria-hidden="true"]') as HTMLElement | null;
    expect(clone).not.toBeNull();
    const leaving = waapi.played.find((record) => record.target === clone)!;
    expect(leaving.keyframes[1].opacity).toBe(0);
    expect(leaving.keyframes[1].transform).toBe('scale(0.6)');
    expect(leaving.animation.id).toBe('data-motion-recipe:exit');
  });

  it('names every animation it plays, so the frame gate can blame a recipe', () => {
    tops.set('a', 0);
    tops.set('b', 10);
    const { rerender } = render(<Rows keys={['a', 'b']} />);
    tops.set('b', 0);
    tops.set('a', 10);
    tops.set('c', 20);
    rerender(<Rows keys={['b', 'a', 'c']} />);
    expect(waapi.played.length).toBeGreaterThan(0);
    for (const record of waapi.played) {
      expect(record.animation.id).toMatch(/^data-motion-recipe:/);
    }
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

  it('a commit landing mid-move does not read the move as a reorder', () => {
    // The bug the desktop client shipped with. A reorder starts; a burst of
    // store updates commits again 6ms later while the row is still travelling;
    // the hook measured the row where the ANIMATION had it, kept that as its
    // resting place, and the next commit read the difference as a fresh move.
    // The error compounded — 383px, 466, 849, 1315, 2176 … 28 300 — and the
    // sidebar's rows flew in from off screen. Nothing moved in layout here, so
    // nothing may be played, however far the transform has the row.
    tops.set('a', 0);
    tops.set('b', 10);
    const { rerender } = render(<Rows keys={['a', 'b']} />);
    tops.set('b', 0);
    tops.set('a', 10);
    rerender(<Rows keys={['b', 'a']} />);
    expect(waapi.played).toHaveLength(2);
    waapi.played.length = 0;
    // Mid-flight: both rows are drawn most of the way back to where they were.
    drift.set('a', -8);
    drift.set('b', 8);
    rerender(<Rows keys={['b', 'a']} />);
    expect(waapi.played).toHaveLength(0);
  });

  it('an interrupted move retargets from where the row is drawn', () => {
    tops.set('a', 0);
    tops.set('b', 10);
    tops.set('c', 20);
    const { rerender } = render(<Rows keys={['a', 'b', 'c']} />);
    // c climbs to the top: it travels 20px.
    tops.set('c', 0);
    tops.set('a', 10);
    tops.set('b', 20);
    rerender(<Rows keys={['c', 'a', 'b']} />);
    waapi.played.length = 0;
    // Half way through that climb, c is sent back down to the middle. It must
    // start from where it is being DRAWN (10px of its 20px climb left, so 10px
    // above the row it is heading for) — not restart from the full 20.
    drift.set('c', 10);
    tops.set('a', 0);
    tops.set('c', 10);
    rerender(<Rows keys={['a', 'c', 'b']} />);
    const c = waapi.played.find((record) => (record.target as HTMLElement).dataset.flipKey === 'c')!;
    // layout delta (0 - 10 = -10) + the 10px the old move still had it above
    // its new row = 0: it is already exactly there, and simply settles.
    expect(c.keyframes[0].transform).toBe('translate3d(0px, 0px, 0)');
  });

  it('a press is not a journey half-finished — only this engine\'s own drift counts', () => {
    // `.pc-pressable` holds a row at `scale(.96)` while the finger is down and
    // lifts it 1px on hover, so a row can be drawn off its layout box with no
    // move in flight at all. Folding that into a reorder's start would make the
    // row jump by the press.
    tops.set('a', 0);
    tops.set('b', 10);
    const { rerender } = render(<Rows keys={['a', 'b']} />);
    drift.set('a', 6);
    tops.set('a', 36);
    rerender(<Rows keys={['a', 'b']} />);
    const a = waapi.played.find((record) => (record.target as HTMLElement).dataset.flipKey === 'a')!;
    expect(a.keyframes[0].transform).toBe('translate3d(0px, -36px, 0)');
  });

  it('a plate that travels carries its own rows — one journey, not two', () => {
    // Layout offsets are whole pixels, so a section and the rows inside it can
    // report deltas a pixel apart while making the same journey. Animating both
    // composes the two transforms and the row travels twice as far as the list
    // did — which is the same off-screen flight, one level down.
    tops.set('s', 0);
    tops.set('r', 10);
    const { rerender } = render(<Nested />);
    tops.set('s', -200);
    tops.set('r', -191);
    rerender(<Nested />);
    expect(waapi.played).toHaveLength(1);
    expect((waapi.played[0].target as HTMLElement).dataset.flipKey).toBe('s');
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
