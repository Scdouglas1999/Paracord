import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureMotion, resetMotionSwitchForTests } from '../../../lib/motion/reducedMotion';
import { installWaapiStub, type WaapiStub } from '../../../lib/motion/waapiStub';
import {
  IX_EASE,
  IX_SPRING,
  TINT_FADE_MS,
  commit,
  crossfadeLayers,
  flipFromRect,
  flipMoved,
  invertTransform,
  onSettle,
  slidePanes,
} from '.';

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

const el = () => {
  const node = document.createElement('div');
  document.body.appendChild(node);
  return node;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Every property any keyframe of every played animation sets. */
const animatedProperties = () =>
  new Set(waapi.played.flatMap((record) => record.keyframes.flatMap((frame) => Object.keys(frame))));

describe('curves', () => {
  it('match the CSS tokens', () => {
    const tokens = readFileSync(join(__dirname, '../../../styles/tokens.css'), 'utf8');
    const spring = /--ix-spring:\s*([^;]+);/.exec(tokens)?.[1].trim();
    const ease = /--ix-ease:\s*([^;]+);/.exec(tokens)?.[1].trim();
    expect(spring).toBe(IX_SPRING);
    expect(ease).toBe(IX_EASE);
  });
});

describe('onSettle and commit', () => {
  it('runs the cleanup once, after every animation finished or was canceled', async () => {
    const a = el().animate([{ opacity: 0 }, { opacity: 1 }], 100);
    const b = el().animate([{ opacity: 0 }, { opacity: 1 }], 100);
    const done = vi.fn();
    onSettle([a, null, b], done);
    a.finish();
    await flush();
    expect(done).not.toHaveBeenCalled();
    b.cancel();
    await flush();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('runs at once with nothing to wait for, and never after it is disposed', async () => {
    const now = vi.fn();
    onSettle([null, undefined], now);
    expect(now).toHaveBeenCalledTimes(1);

    const a = el().animate([{ opacity: 0 }, { opacity: 1 }], 100);
    const later = vi.fn();
    const dispose = onSettle([a], later);
    dispose();
    commit([a]);
    await flush();
    expect(later).not.toHaveBeenCalled();
    expect(waapi.live()).toHaveLength(0);
  });
});

describe('slidePanes (§5.1)', () => {
  it('slides the old pane out to -dir×40% in 450ms and the new one in from dir×60% in 550ms, on the spring', () => {
    const { outgoing, incoming } = slidePanes(el(), el(), 1);
    expect(outgoing).not.toBeNull();
    expect(incoming).not.toBeNull();
    const [out, into] = waapi.played;
    expect(out.keyframes).toEqual([
      { transform: 'none', opacity: 1 },
      { transform: 'translateX(-40%)', opacity: 0 },
    ]);
    expect(out.options).toMatchObject({ duration: 450, easing: IX_SPRING, fill: 'forwards' });
    expect(into.keyframes).toEqual([
      { transform: 'translateX(60%)', opacity: 0 },
      { transform: 'none', opacity: 1 },
    ]);
    expect(into.options).toMatchObject({ duration: 550, easing: IX_SPRING });
    expect(into.options.fill).toBeUndefined();
  });

  it('mirrors for a place to the left', () => {
    slidePanes(el(), el(), -1);
    expect(waapi.played[0].keyframes[1]).toMatchObject({ transform: 'translateX(40%)' });
    expect(waapi.played[1].keyframes[0]).toMatchObject({ transform: 'translateX(-60%)' });
  });

  it('crossfades in place with reduced motion (150ms) and for an unknown direction', () => {
    configureMotion('reduced');
    slidePanes(el(), el(), 1);
    expect(waapi.played.map((record) => record.options.duration)).toEqual([150, 150]);
    expect(animatedProperties()).toEqual(new Set(['opacity']));
    configureMotion('full');
    waapi.played.length = 0;
    slidePanes(el(), el(), 0);
    expect(animatedProperties()).toEqual(new Set(['opacity']));
  });
});

describe('crossfadeLayers (§5.1 tint)', () => {
  it('fades only the new layer in, 900ms ease; 150ms under reduced motion', () => {
    crossfadeLayers(el());
    expect(waapi.played[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(waapi.played[0].options).toMatchObject({ duration: TINT_FADE_MS, easing: IX_EASE });
    configureMotion('reduced');
    crossfadeLayers(el());
    expect(waapi.played[1].options.duration).toBe(150);
  });

  it('plays nothing without an element (jsdom, an unmounted layer)', () => {
    expect(crossfadeLayers(null)).toBeNull();
  });
});

describe('flipFromRect', () => {
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

  it('inverts a rect as translate and scale from the top-left corner', () => {
    expect(invertTransform(rect(10, 20, 100, 50), rect(110, 220, 200, 400))).toBe(
      'translate(-100px, -200px) scale(0.5, 0.125)',
    );
    expect(invertTransform(rect(10, 20, 100, 50), rect(110, 220, 200, 400), 'uniform')).toBe(
      'translate(-100px, -200px) scale(0.5, 0.5)',
    );
    expect(invertTransform(rect(10, 20, 100, 50), rect(10, 52, 100, 50), 'none')).toBe('translate(0px, -32px)');
    expect(invertTransform(rect(10, 20, 100, 50), rect(10, 20, 100, 50))).toBeNull();
  });

  it('plays from the old rect to the element, transform and opacity only', () => {
    const node = el();
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 400, 300));
    flipFromRect(node, rect(20, 40, 200, 150), { duration: 600, opacityFrom: 0.3 });
    const [played] = waapi.played;
    expect(played.keyframes[0]).toMatchObject({
      transform: 'translate(-80px, -60px) scale(0.5, 0.5)',
      transformOrigin: '0 0',
      opacity: 0.3,
    });
    expect(played.keyframes[1]).toMatchObject({ transform: 'none', opacity: 1 });
    expect(played.options).toMatchObject({ duration: 600, easing: IX_SPRING });
    expect(animatedProperties()).toEqual(new Set(['transform', 'transformOrigin', 'opacity']));
  });

  it('becomes a 150ms fade under reduced motion, or nothing for displaced content', () => {
    configureMotion('reduced');
    const node = el();
    flipFromRect(node, rect(0, 0, 10, 10), { duration: 600 });
    expect(waapi.played[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(waapi.played[0].options.duration).toBe(150);
    const moved = flipMoved(new Map([[node, new DOMRect(0, 0, 10, 10)]]), { duration: 600 });
    expect(moved).toEqual([]);
  });

  it('skips an element that is not in the document', () => {
    const loose = document.createElement('div');
    expect(flipFromRect(loose, rect(0, 0, 10, 10), { duration: 600 })).toBeNull();
  });
});
