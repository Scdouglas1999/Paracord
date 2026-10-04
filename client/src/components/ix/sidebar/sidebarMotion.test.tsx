import { act, fireEvent, render } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { configureMotion, resetMotionSwitchForTests } from '../../../lib/motion/reducedMotion';
import { installWaapiStub, type WaapiStub } from '../../../lib/motion/waapiStub';
import { useCollapse, GROUP_ATTRIBUTE, FLIP_ATTRIBUTE } from './useCollapse';
import { usePreviewRoll } from './usePreviewRoll';
import { SELECTED_ATTRIBUTE, useSelectionGlide } from './useSelectionGlide';

/**
 * The sidebar's three motions as unit tests (the visual half is e2e/index-
 * sidebar.spec.ts): what is played, on what, with which keyframes and timing. The
 * Web Animations stub records every `animate()` call, since jsdom has none.
 */

let waapi: WaapiStub;
beforeEach(() => {
  waapi = installWaapiStub();
  resetMotionSwitchForTests();
  configureMotion('full');
});
afterEach(() => {
  waapi.restore();
  resetMotionSwitchForTests();
});

const played = (id: string) => waapi.played.filter((record) => (record.animation as unknown as { id: string }).id === id);
const properties = (keyframes: Keyframe[]) =>
  [...new Set(keyframes.flatMap((frame) => Object.keys(frame).filter((key) => key !== 'offset' && key !== 'easing')))].sort();

/* ---- Preview roll (§5.3) ------------------------------------------------------- */

function Roll({ line, time, enabled = true }: { line: string | null; time: string | null; enabled?: boolean }) {
  const [lineRef, timeRef] = usePreviewRoll(line, time, enabled);
  return (
    <div>
      <time ref={timeRef}>{time}</time>
      <span ref={lineRef}>{line}</span>
    </div>
  );
}

describe('the preview roll', () => {
  it('rolls the new line up from 9px and fades the time in, when a line that was there changes', () => {
    const { rerender } = render(<Roll line="Jeremy: hey" time="9:41 PM" />);
    expect(waapi.played).toHaveLength(0);
    rerender(<Roll line="Nick: yep" time="10:02 PM" />);
    const [line] = played('ix-preview:line');
    expect(line.keyframes).toEqual([
      { transform: 'translateY(9px)', opacity: 0 },
      { transform: 'none', opacity: 1 },
    ]);
    expect(line.options).toMatchObject({ duration: 520, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
    expect(line.target.textContent).toBe('Nick: yep');
    const [time] = played('ix-preview:time');
    expect(time.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(time.options.duration).toBe(400);
  });

  it('plays nothing when a line first arrives (there was none), when it is the same, or in a pane that is sliding out', () => {
    const { rerender } = render(<Roll line={null} time={null} />);
    rerender(<Roll line="Jeremy: hey" time="9:41 PM" />);
    expect(waapi.played).toHaveLength(0);
    rerender(<Roll line="Jeremy: hey" time="9:41 PM" />);
    expect(waapi.played).toHaveLength(0);
    rerender(<Roll line="Nick: yep" time="10:02 PM" enabled={false} />);
    expect(waapi.played).toHaveLength(0);
  });

  it('only moves transform and opacity, and under reduced motion only fades (150ms)', () => {
    const { rerender } = render(<Roll line="a" time="1" />);
    rerender(<Roll line="b" time="2" />);
    for (const record of waapi.played) expect(properties(record.keyframes).every((key) => key === 'transform' || key === 'opacity')).toBe(true);
    waapi.played.length = 0;
    configureMotion('reduced');
    rerender(<Roll line="c" time="3" />);
    const [line] = played('ix-preview:line');
    expect(line.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(line.options.duration).toBe(150);
  });
});

/* ---- Selection glide (§5.2) ---------------------------------------------------- */

function Glide({ y, selected = true, suspended = false }: { y: number; selected?: boolean; suspended?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const selection = useSelectionGlide(container, suspended);
  return (
    <div ref={container}>
      <span ref={selection} data-testid="sel" data-on="false" />
      {selected && (
        <a
          {...{ [SELECTED_ATTRIBUTE]: '' }}
          href="#row"
          ref={(element) => {
            if (element) Object.defineProperty(element, 'offsetTop', { value: y, configurable: true });
          }}
        >
          row
        </a>
      )}
    </div>
  );
}

describe('the selection glide', () => {
  it('puts the highlight at the open row on first sight, with no motion', () => {
    const { getByTestId } = render(<Glide y={37} />);
    expect(getByTestId('sel').style.transform).toBe('translateY(37px)');
    expect(getByTestId('sel')).toHaveAttribute('data-on', 'true');
    expect(waapi.played).toHaveLength(0);
  });

  it('glides to the next row by translateY alone: 450ms on the spring curve', () => {
    const { getByTestId, rerender } = render(<Glide y={37} />);
    rerender(<Glide y={90} />);
    const [glide] = played('ix-select:glide');
    expect(glide.keyframes).toEqual([{ transform: 'translateY(37px)' }, { transform: 'translateY(90px)' }]);
    expect(glide.options).toMatchObject({ duration: 450, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
    expect(properties(glide.keyframes)).toEqual(['transform']);
    expect(getByTestId('sel').style.transform).toBe('translateY(90px)');
    expect(getByTestId('sel').style.height).toBe('');
  });

  it('cuts a glide short when a newer one starts (no queueing)', () => {
    const { rerender } = render(<Glide y={37} />);
    rerender(<Glide y={90} />);
    rerender(<Glide y={143} />);
    const [first, second] = played('ix-select:glide');
    expect(first.finished).toBe(true);
    expect(second.keyframes[0]).toEqual({ transform: 'translateY(90px)' });
  });

  it('does not move for a render that leaves the row where it was', () => {
    const { rerender } = render(<Glide y={37} />);
    rerender(<Glide y={37} />);
    expect(waapi.played).toHaveLength(0);
  });

  it('fades out when nothing is selected, and comes back in place, not gliding from where it was', () => {
    const { getByTestId, rerender } = render(<Glide y={37} />);
    rerender(<Glide y={37} selected={false} />);
    expect(getByTestId('sel')).toHaveAttribute('data-on', 'false');
    rerender(<Glide y={143} />);
    expect(getByTestId('sel')).toHaveAttribute('data-on', 'true');
    expect(getByTestId('sel').style.transform).toBe('translateY(143px)');
    expect(waapi.played).toHaveLength(0);
  });

  it('moves in place while the pane is sliding out', () => {
    const { getByTestId, rerender } = render(<Glide y={37} suspended />);
    rerender(<Glide y={90} suspended />);
    expect(getByTestId('sel').style.transform).toBe('translateY(90px)');
    expect(waapi.played).toHaveLength(0);
  });

  it('crossfades in place under reduced motion (150ms), with no travel', () => {
    configureMotion('reduced');
    const { rerender } = render(<Glide y={37} />);
    rerender(<Glide y={90} />);
    const [fade] = played('ix-select:fade');
    expect(fade.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(fade.options.duration).toBe(150);
    expect(played('ix-select:glide')).toHaveLength(0);
  });
});

/* ---- Category collapse (§5.20) ---------------------------------------------------- */

/**
 * A server with a category of two rows above "Rooms". jsdom measures nothing, so
 * the rectangles are the page's own, read from data attributes by the state the
 * container is in: what each element's top was open, and what it is closed.
 */
function Collapse() {
  const container = useRef<HTMLDivElement>(null);
  const ghosts = useRef<HTMLDivElement>(null);
  const { collapsed, toggle } = useCollapse('g1', container, ghosts, false);
  const closed = collapsed.has('category:cat');
  const [, force] = useState(0);
  return (
    <div ref={container} data-state={closed ? 'closed' : 'open'}>
      <div ref={ghosts} data-testid="ghosts" />
      <button type="button" onClick={() => toggle('category:cat')}>
        fold
      </button>
      <a href="#a" data-testid="row-a" data-open="100" data-closed="100" {...{ [FLIP_ATTRIBUTE]: '', [GROUP_ATTRIBUTE]: 'category:cat' }} data-keep>
        a
      </a>
      {!closed && (
        <a href="#b" data-testid="row-b" data-open="153" data-closed="153" {...{ [FLIP_ATTRIBUTE]: '', [GROUP_ATTRIBUTE]: 'category:cat' }}>
          b
        </a>
      )}
      <h2 data-testid="rooms" data-open="206" data-closed="153" {...{ [FLIP_ATTRIBUTE]: '' }}>
        Rooms
      </h2>
      <button type="button" onClick={() => force((n) => n + 1)}>
        rerender
      </button>
    </div>
  );
}

function stubRects() {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function rect(this: Element) {
    const state = (this.closest('[data-state]') as HTMLElement | null)?.dataset.state === 'closed' ? 'closed' : 'open';
    const top = Number((this as HTMLElement).dataset[state] ?? 0);
    return { x: 0, y: top, left: 0, top, right: 292, bottom: top + 51, width: 292, height: 51, toJSON: () => ({}) } as DOMRect;
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

describe('closing a category', () => {
  let restore: () => void;
  beforeEach(() => {
    window.localStorage.clear();
    restore = stubRects();
  });
  afterEach(() => restore());

  it('fades the row that leaves (a ghost, 150ms) and moves the rest up by FLIP (450ms spring)', () => {
    const { getByText, getByTestId } = render(<Collapse />);
    fireEvent.click(getByText('fold'));
    expect(getByTestId('rooms').closest('[data-state]')).toHaveAttribute('data-state', 'closed');
    // Rooms was at 206 and is at 153: it plays from where it was, as a translate only.
    const [move] = played('ix-collapse:move').filter((record) => record.target === getByTestId('rooms'));
    expect(move.keyframes).toEqual([{ transform: 'translate(0px, 53px)', transformOrigin: '0 0' }, { transform: 'none', transformOrigin: '0 0' }]);
    expect(move.options).toMatchObject({ duration: 450, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
    // The row that left is gone, and a copy of it fades where it was.
    expect(document.querySelector('[data-testid="row-b"]')).toBeNull();
    const ghost = getByTestId('ghosts').firstElementChild as HTMLElement;
    expect(ghost).toHaveTextContent('b');
    expect(ghost).toHaveAttribute('aria-hidden', 'true');
    expect(ghost).toHaveAttribute('inert');
    expect(ghost).not.toHaveAttribute('data-testid');
    const [fade] = played('ix-collapse:fade');
    expect(fade.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(fade.options.duration).toBe(150);
    // Settled: the ghost is removed, and only transform and opacity ever moved.
    act(() => fade.animation.finish());
    return Promise.resolve().then(() => {
      expect(getByTestId('ghosts').childElementCount).toBe(0);
      for (const record of waapi.played) expect(properties(record.keyframes).every((key) => ['transform', 'transformOrigin', 'opacity'].includes(key))).toBe(true);
    });
  });

  it('keeps the rows marked to stay (unread, mentioned, open), so there is no ghost for them', () => {
    const { getByText, getByTestId } = render(<Collapse />);
    fireEvent.click(getByText('fold'));
    expect(getByTestId('row-a')).toBeInTheDocument();
    expect(getByTestId('ghosts').childElementCount).toBe(1);
  });

  it('opens again: the rows fade in and the rest moves down', () => {
    const { getByText, getByTestId } = render(<Collapse />);
    fireEvent.click(getByText('fold'));
    waapi.played.length = 0;
    fireEvent.click(getByText('fold'));
    const rooms = played('ix-collapse:move').find((record) => record.target === getByTestId('rooms'));
    expect(rooms?.keyframes[0]).toMatchObject({ transform: 'translate(0px, -53px)' });
    const fade = played('ix-collapse:fade').find((record) => record.target === getByTestId('row-b'));
    expect(fade?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });

  it('remembers which categories are closed, per server', () => {
    const first = render(<Collapse />);
    fireEvent.click(first.getByText('fold'));
    expect(JSON.parse(window.localStorage.getItem('paracord:ix-collapsed:g1') ?? '[]')).toEqual(['category:cat']);
    first.unmount();
    const second = render(<Collapse />);
    expect(second.getByTestId('rooms').closest('[data-state]')).toHaveAttribute('data-state', 'closed');
  });

  it('moves nothing under reduced motion except the fade', () => {
    configureMotion('reduced');
    const { getByText } = render(<Collapse />);
    fireEvent.click(getByText('fold'));
    expect(played('ix-collapse:move')).toHaveLength(0);
    expect(played('ix-collapse:fade')).toHaveLength(1);
  });
});
