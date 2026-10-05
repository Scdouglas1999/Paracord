import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useRef } from 'react';
import { configureMotion, resetMotionSwitchForTests } from '../../lib/motion';
import { COMPOSER_GROW_MS, COMPOSER_SHRINK_MS, composerShapeMove, useComposerShape } from './composerShape';

describe('the three-slice move', () => {
  it('opens from 52 to 98: the top starts 46px lower and the middle from 4/50 of its height', () => {
    expect(composerShapeMove(52, 98)).toEqual({ offset: 46, midFrom: 4 / 50, duration: COMPOSER_GROW_MS });
  });

  it('closes from 98 to 52 in 160ms: the top starts 46px higher, the middle 12.5 times taller', () => {
    expect(composerShapeMove(98, 52)).toEqual({ offset: -46, midFrom: 50 / 4, duration: COMPOSER_SHRINK_MS });
  });

  it('has nothing to play for no change, or for a box shorter than its two caps', () => {
    expect(composerShapeMove(52, 52)).toBeNull();
    expect(composerShapeMove(52, 52.3)).toBeNull();
    expect(composerShapeMove(52, 40)).toBeNull();
    expect(composerShapeMove(Number.NaN, 98)).toBeNull();
  });
});

type Played = { target: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; animation: Animation };

describe('useComposerShape', () => {
  let observers: Array<() => void> = [];
  let played: Played[] = [];

  beforeEach(() => {
    observers = [];
    played = [];
    resetMotionSwitchForTests();
    configureMotion('full');
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
        }
        observe() {
          observers.push(this.callback);
        }
        disconnect() {}
        unobserve() {}
      },
    );
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function animate(
      this: Element,
      keyframes: Keyframe[],
      options: KeyframeAnimationOptions,
    ) {
      const animation = {
        id: '',
        cancel: vi.fn(),
        finished: new Promise(() => {}),
      } as unknown as Animation;
      played.push({ target: this, keyframes, options, animation });
      return animation;
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
    resetMotionSwitchForTests();
  });

  function Box({ open, hold = false }: { open: boolean; hold?: boolean }) {
    const box = useRef<HTMLDivElement>(null);
    const top = useRef<HTMLSpanElement>(null);
    const mid = useRef<HTMLSpanElement>(null);
    const head = useRef<HTMLDivElement>(null);
    const tools = useRef<HTMLDivElement>(null);
    const openRef = useRef(open);
    openRef.current = open;
    const holdRef = useRef(hold);
    holdRef.current = hold;
    const tops = useRef([top]).current;
    const mids = useRef([mid]).current;
    useComposerShape({ box, top: tops, mid: mids, head, tools }, { open: openRef, hold: holdRef, active: true });
    return (
      <div ref={box} data-testid="box">
        <span ref={top} data-part="top" />
        <span ref={mid} data-part="mid" />
        <div ref={head} data-part="head" />
        <div ref={tools} data-part="tools" />
      </div>
    );
  }

  const setHeight = (element: HTMLElement, height: number) =>
    Object.defineProperty(element, 'offsetHeight', { configurable: true, value: height });
  const part = (name: string) => played.find((entry) => (entry.target as HTMLElement).dataset.part === name);

  it('plays a growth on the top cap, the head and the middle, transform only, never forwards', () => {
    const view = render(<Box open={false} />);
    const box = view.getByTestId('box');
    setHeight(box, 52);
    view.rerender(<Box open={false} />);
    // The first observation is the box as it mounted: nothing plays.
    observers[0]();
    expect(played).toHaveLength(0);

    view.rerender(<Box open />);
    setHeight(box, 98);
    observers[0]();
    expect(part('top')?.keyframes).toEqual([{ transform: 'translateY(46px)' }, { transform: 'none' }]);
    expect(part('head')?.keyframes).toEqual([{ transform: 'translateY(46px)' }, { transform: 'none' }]);
    expect(part('mid')?.keyframes).toEqual([{ transform: `scaleY(${4 / 50})` }, { transform: 'none' }]);
    expect(part('tools')).toBeUndefined();
    for (const entry of played) {
      expect(entry.options).toMatchObject({ duration: 225, fill: 'none' });
      expect(entry.animation.id).toMatch(/^ix-composer:shape:/);
    }
  });

  it('pushes the tools row out through the foot when the box closes', () => {
    const view = render(<Box open />);
    const box = view.getByTestId('box');
    setHeight(box, 98);
    // The mount observation, at 98: nothing plays.
    observers[0]();
    view.rerender(<Box open={false} />);
    setHeight(box, 52);
    observers[0]();
    expect(part('tools')?.keyframes).toEqual([{ transform: 'none' }, { transform: 'translateY(46px)' }]);
    expect(part('top')?.options.duration).toBe(160);
  });

  it('snaps a change the send flight makes, and under reduced motion', () => {
    const view = render(<Box open hold />);
    const box = view.getByTestId('box');
    setHeight(box, 120);
    observers[0]();
    setHeight(box, 98);
    observers[0]();
    expect(played).toHaveLength(0);

    configureMotion('reduced');
    view.rerender(<Box open />);
    setHeight(box, 140);
    observers[0]();
    expect(played).toHaveLength(0);
  });
});
