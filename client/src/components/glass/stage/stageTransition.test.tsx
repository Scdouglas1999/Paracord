import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installWaapiStub, type WaapiStub } from '../../../lib/motion/waapiStub';
import { useGlassStore, type StageTarget } from '../../../stores/glassStore';
import {
  classifyChange,
  settleStageMove,
  STAGE_CROSSFADE_MS,
  STAGE_MOVE_MS,
  useStageTransitions,
  useStreamPoster,
} from './stageTransition';

/**
 * The stage's moves (docs/glass-spec.md §6, §9): which move a change is, and
 * that the frame measures before React touches the DOM and plays after, from
 * whoever changed the store. The pictures are the Playwright filmstrips
 * (e2e/glass-theater.spec.ts); here the boxes come from `data-rect`.
 */

const reduced = vi.hoisted(() => ({ value: false }));
vi.mock('../../../lib/motion/reducedMotion', () => ({ prefersReducedMotion: () => reduced.value }));
const frames = vi.hoisted(() => ({ subscribe: vi.fn(() => () => {}) }));
vi.mock('../../../lib/room/viewFrameSource', () => ({
  createViewFrameSource: () => ({ kind: 'stream', width: 0, height: 0, route: null, subscribe: frames.subscribe }),
}));

const LOUNGE: StageTarget = { serverId: '__local__', guildId: 'g1', channelId: 'lounge', streamerId: 'vincent' };

describe('classifyChange', () => {
  const key = (mode: 'none' | 'side' | 'theater', browse = false, chatHidden = false) => ({ mode, browse, chatHidden });
  it('names each move, and nothing for no change', () => {
    expect(classifyChange(key('none'), key('side'))).toBe('open');
    expect(classifyChange(key('theater'), key('none'))).toBe('close');
    expect(classifyChange(key('side'), key('theater'))).toBe('mode');
    expect(classifyChange(key('side'), key('side', true))).toBe('browse');
    expect(classifyChange(key('theater'), key('theater', false, true))).toBe('chat');
    expect(classifyChange(key('side'), key('side'))).toBeNull();
    expect(classifyChange(key('none'), key('none', false, false))).toBeNull();
  });
});

/* ---- The frame, with boxes from data-rect -------------------------------------- */

const RECTS = {
  pill: '793,22,453,52',
  placesPane: '16,16,316,868',
  convWide: '348,16,1076,868',
  convSide: '1004,16,420,868',
  convTheater: '1044,16,380,868',
  stageSide: '16,16,972,868',
  stageTheater: '0,0,1440,900',
  streamSide: '28,28,948,533',
};

function Frame() {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const overRef = useRef<HTMLDivElement | null>(null);
  const underRef = useRef<HTMLDivElement | null>(null);
  const mode = useGlassStore((s) => s.stage.mode);
  const browse = useGlassStore((s) => s.browseOpen);
  const chatHidden = useGlassStore((s) => s.chatHidden);
  useStageTransitions(frameRef, overRef, underRef, { mode, browse, chatHidden });
  const conv = mode === 'none' ? RECTS.convWide : mode === 'side' ? RECTS.convSide : RECTS.convTheater;
  return (
    <>
      <div ref={underRef} />
      <div ref={frameRef} className="glass-frame" data-layout="wide">
        {mode === 'none' && <div className="glass-frame__places" data-rect={RECTS.placesPane} />}
        {mode !== 'none' && (
          <section className="glass-frame__stage" data-rect={mode === 'side' ? RECTS.stageSide : RECTS.stageTheater}>
            <div className="glass-stage" data-rect={mode === 'side' ? '28,28,948,856' : RECTS.stageTheater}>
              <div className="glass-stage__stream" data-rect={mode === 'side' ? RECTS.streamSide : RECTS.stageTheater}>
                <canvas />
              </div>
            </div>
          </section>
        )}
        <main className="glass-frame__conversation" data-rect={conv} data-away={chatHidden ? 'true' : undefined}>
          <div className="conversation" data-rect={conv}>
            {mode === 'none' && (
              <div className="glass-pill" data-layout="row" data-rect={RECTS.pill}>
                <span className="glass-pill__surface" data-rect={RECTS.pill} />
              </div>
            )}
          </div>
        </main>
      </div>
      <div ref={overRef} />
    </>
  );
}

let waapi: WaapiStub;
const originalRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  reduced.value = false;
  useGlassStore.getState().reset();
  waapi = installWaapiStub();
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const spec = this.getAttribute('data-rect');
    if (!spec) return originalRect.call(this);
    const [x, y, w, h] = spec.split(',').map(Number);
    return { left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON() {} } as DOMRect;
  };
});

afterEach(() => {
  settleStageMove();
  waapi.restore();
  Element.prototype.getBoundingClientRect = originalRect;
  useGlassStore.getState().reset();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const played = (name: string) => waapi.played.filter((record) => record.animation.id === `glass-morph:${name}`);

describe('useStageTransitions', () => {
  it('Watch: the stage grows out of the pill; places and the pill leave as clones; the conversation narrows', async () => {
    render(<Frame />);
    act(() => useGlassStore.getState().openStage(LOUNGE));
    await flush();
    const [stage] = played('stage');
    expect(stage).toBeDefined();
    expect(stage.options.duration).toBe(STAGE_MOVE_MS);
    // The first frame puts the 972x868 pane on the pill: scaled down to 453x52 at 793,22.
    const first = String(stage.keyframes[0].transform);
    const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+), ([-\d.]+)\)/.exec(first)!;
    expect(16 + Number(match[1])).toBeCloseTo(793, 1);
    expect(972 * Number(match[3])).toBeCloseTo(453, 1);
    expect(868 * Number(match[4])).toBeCloseTo(52, 1);
    expect(played('stage-content')).toHaveLength(1);
    expect(played('conversation')).toHaveLength(1);
    expect(played('places-leaving')).toHaveLength(1);
    expect(played('pill-leaving')).toHaveLength(1);
    // The clones are pictures: hidden from assistive tech and unreachable.
    const clones = document.querySelectorAll('.glass-morph__clone');
    expect(clones).toHaveLength(2);
    for (const clone of clones) {
      expect(clone).toHaveAttribute('aria-hidden', 'true');
      expect(clone).toHaveAttribute('inert');
    }
    settleStageMove();
    expect(document.querySelectorAll('.glass-morph__clone')).toHaveLength(0);
  });

  it('Stop watching: the stage clone shrinks into the pill, which fades in as it lands', async () => {
    render(<Frame />);
    act(() => useGlassStore.getState().openStage(LOUNGE));
    await flush();
    settleStageMove();
    waapi.played.length = 0;
    act(() => useGlassStore.getState().closeStage());
    await flush();
    const [leaving] = played('stage-leaving');
    expect(leaving).toBeDefined();
    const last = String(leaving.keyframes[leaving.keyframes.length - 1].transform);
    const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+), ([-\d.]+)\)/.exec(last)!;
    // The clone sits at the stage's box (16,16 972x868) and ends on the pill.
    expect(16 + Number(match[1])).toBeCloseTo(793, 1);
    expect(972 * Number(match[3])).toBeCloseTo(453, 1);
    const [pill] = played('pill');
    expect(pill.keyframes[0].opacity).toBe(0);
    expect(pill.keyframes[pill.keyframes.length - 1].opacity).toBe(1);
  });

  it('T: the stage pane grows to the window and the stream travels with a uniform scale', async () => {
    render(<Frame />);
    act(() => useGlassStore.getState().openStage(LOUNGE));
    await flush();
    settleStageMove();
    waapi.played.length = 0;
    act(() => useGlassStore.getState().setStageMode('theater'));
    await flush();
    expect(played('stage')).toHaveLength(1);
    const [stream] = played('stream');
    for (const frame of stream.keyframes) {
      const match = /scale\(([-\d.]+), ([-\d.]+)\)/.exec(String(frame.transform))!;
      expect(Number(match[1])).toBeCloseTo(Number(match[2]), 5);
    }
    // Its corners go from 18 to 0 on the way (seen), and the conversation moves to 1044.
    expect(played('conversation')).toHaveLength(1);
  });

  it('reduced motion: every move is a 150ms crossfade in place', async () => {
    reduced.value = true;
    render(<Frame />);
    act(() => useGlassStore.getState().openStage(LOUNGE));
    await flush();
    const morphs = waapi.played.filter((record) => record.animation.id.startsWith('glass-morph:'));
    expect(morphs.length).toBeGreaterThan(0);
    for (const record of morphs) {
      expect(record.options.duration).toBe(STAGE_CROSSFADE_MS);
      for (const frame of record.keyframes) {
        expect(frame.transform === undefined || frame.transform === 'translate(0px, 0px) scale(1, 1)' || frame.transform === 'none').toBe(true);
      }
    }
  });

  it('a phone frame does not move (the phone shell is WP-G20)', async () => {
    function PhoneFrame() {
      const frameRef = useRef<HTMLDivElement | null>(null);
      const overRef = useRef<HTMLDivElement | null>(null);
      const underRef = useRef<HTMLDivElement | null>(null);
      const mode = useGlassStore((s) => s.stage.mode);
      useStageTransitions(frameRef, overRef, underRef, { mode, browse: false, chatHidden: false });
      return <div ref={frameRef} className="glass-frame" data-layout="phone" />;
    }
    render(<PhoneFrame />);
    act(() => useGlassStore.getState().openStage(LOUNGE));
    await flush();
    expect(waapi.played).toHaveLength(0);
  });
});

describe('useStreamPoster', () => {
  it('subscribes to nothing on the web, where no stream is drawn under the page', () => {
    function Poster() {
      const ref = useRef<HTMLCanvasElement | null>(null);
      useStreamPoster(ref, 'vincent');
      return <canvas ref={ref} />;
    }
    render(<Poster />);
    expect(frames.subscribe).not.toHaveBeenCalled();
  });
});
