import { describe, expect, it } from 'vitest';

import {
  containedPicture,
  cubicBezier,
  fadeAt,
  GLASS_LAYOUT_CURVE,
  morphFrames,
  type MorphBox,
  type MorphItem,
} from './sharedElement';

/**
 * The morph's math (lib/motion/sharedElement.ts, WP-G15): what each item's
 * keyframes put on screen, read back through the same transforms a browser
 * would apply. The pictures themselves are the Playwright filmstrips
 * (e2e/glass-theater.spec.ts).
 */

const el = () => document.createElement('div');
const linear = (t: number) => t;

interface Parsed {
  tx: number;
  ty: number;
  sx: number;
  sy: number;
}

function parse(frame: Keyframe): Parsed {
  const match = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+), ([-\d.e]+)\)/.exec(String(frame.transform));
  if (!match) throw new Error(`not a morph transform: ${String(frame.transform)}`);
  return { tx: Number(match[1]), ty: Number(match[2]), sx: Number(match[3]), sy: Number(match[4]) };
}

/** Where a layout point lands on screen: the element's own transform (origin at its layout top left), then its ancestors'. */
function project(point: [number, number], chain: Array<{ layout: MorphBox; frame: Keyframe }>): [number, number] {
  let [x, y] = point;
  for (const { layout, frame } of chain) {
    const t = parse(frame);
    x = layout.left + t.sx * (x - layout.left) + t.tx;
    y = layout.top + t.sy * (y - layout.top) + t.ty;
  }
  return [x, y];
}

const box = (left: number, top: number, width: number, height: number): MorphBox => ({ left, top, width, height });

describe('cubicBezier', () => {
  it('is the CSS curve: ends pinned, and the Glass layout curve front-loaded', () => {
    const ease = cubicBezier(...GLASS_LAYOUT_CURVE);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeGreaterThan(0.85);
    const straight = cubicBezier(0.25, 0.25, 0.75, 0.75);
    expect(straight(0.3)).toBeCloseTo(0.3, 3);
  });
});

describe('fadeAt', () => {
  it('holds before its window, eases through it, and holds after', () => {
    const fade = { from: 0, to: 1, start: 0.2, end: 0.6 };
    expect(fadeAt(fade, 0.1)).toBe(0);
    expect(fadeAt(fade, 0.4)).toBeCloseTo(0.5, 5);
    expect(fadeAt(fade, 0.9)).toBe(1);
  });
});

describe('morphFrames', () => {
  const pill = box(793, 22, 453, 52);
  const pane = box(16, 16, 972, 868);

  it('a box starts exactly on its first box and ends at rest', () => {
    const item: MorphItem = { el: el(), kind: 'box', layout: pane, from: pill, to: pane, radius: { from: 26, to: 28 } };
    const frames = morphFrames([item], { duration: 650, easing: linear, samples: 10 }).get(item)!;
    const first = parse(frames[0]);
    expect(pane.left + first.tx).toBeCloseTo(pill.left, 2);
    expect(pane.top + first.ty).toBeCloseTo(pill.top, 2);
    expect(pane.width * first.sx).toBeCloseTo(pill.width, 2);
    expect(pane.height * first.sy).toBeCloseTo(pill.height, 2);
    // Seen with the pill's radius: the style radius is divided by the scale it is drawn under.
    const [rx, ry] = String(frames[0].borderRadius).split(' / ').map((value) => Number.parseFloat(value));
    expect(rx * first.sx).toBeCloseTo(26, 1);
    expect(ry * first.sy).toBeCloseTo(26, 1);
    const last = parse(frames[frames.length - 1]);
    expect(last).toEqual({ tx: 0, ty: 0, sx: 1, sy: 1 });
    expect(frames[frames.length - 1].borderRadius).toBe('28px / 28px');
  });

  it("content riding a box keeps its size and its distance to the box's corner at every moment", () => {
    const paneItem: MorphItem = { el: el(), kind: 'box', layout: pane, from: pill, to: pane };
    const content = box(28, 28, 948, 533);
    const ride: MorphItem = { el: el(), kind: 'ride', layout: content, parent: paneItem, anchor: [0, 0] };
    const frames = morphFrames([paneItem, ride], { duration: 650, easing: linear, samples: 8 });
    const paneFrames = frames.get(paneItem)!;
    const rideFrames = frames.get(ride)!;
    for (let i = 0; i < paneFrames.length; i += 1) {
      const chain = [
        { layout: content, frame: rideFrames[i] },
        { layout: pane, frame: paneFrames[i] },
      ];
      const [x0, y0] = project([content.left, content.top], chain);
      const [x1, y1] = project([content.left + content.width, content.top + content.height], chain);
      // Unscaled on screen.
      expect(x1 - x0).toBeCloseTo(content.width, 2);
      expect(y1 - y0).toBeCloseTo(content.height, 2);
      // 12px in from the pane's seen top left.
      const [px, py] = project([pane.left, pane.top], [{ layout: pane, frame: paneFrames[i] }]);
      expect(x0 - px).toBeCloseTo(12, 3);
      expect(y0 - py).toBeCloseTo(12, 3);
    }
  });

  it('a stream fits: its picture travels with one uniform scale, never stretched', () => {
    const side = box(28, 28, 948, 533);
    const theater = box(0, 0, 1440, 900);
    const picture = containedPicture(theater);
    expect(picture).toEqual({ left: 0, top: 45, width: 1440, height: 810 });
    const item: MorphItem = { el: el(), kind: 'fit', layout: theater, picture, from: containedPicture(side), to: picture };
    const frames = morphFrames([item], { duration: 650, easing: linear, samples: 6 }).get(item)!;
    for (const frame of frames) {
      const t = parse(frame);
      expect(t.sx).toBeCloseTo(t.sy, 6);
    }
    // At the start the picture is exactly where side by side showed it.
    const start = containedPicture(side);
    const [x, y] = project([picture.left, picture.top], [{ layout: theater, frame: frames[0] }]);
    expect(x).toBeCloseTo(start.left, 2);
    expect(y).toBeCloseTo(start.top, 2);
    expect(parse(frames[0]).sx).toBeCloseTo(start.width / 1440, 5);
  });

  it('rigid chrome inside a scaled parent is counter-scaled and travels by the point it aligns on', () => {
    const stream = box(0, 0, 1440, 900);
    const streamItem: MorphItem = {
      el: el(),
      kind: 'fit',
      layout: stream,
      picture: containedPicture(stream),
      from: box(28, 28, 948, 533),
      to: containedPicture(stream),
    };
    // The buttons: a group that gained a button, aligned on its right edge.
    const was = box(840, 42, 122, 40);
    const now = box(1266, 14, 160, 40);
    const actions: MorphItem = { el: el(), kind: 'rigid', layout: now, from: was, to: now, align: [1, 0], parent: streamItem };
    const frames = morphFrames([streamItem, actions], { duration: 650, easing: linear, samples: 6 });
    const chain = (i: number) => [
      { layout: now, frame: frames.get(actions)![i] },
      { layout: stream, frame: frames.get(streamItem)![i] },
    ];
    const [left0, top0] = project([now.left, now.top], chain(0));
    const [right0] = project([now.left + now.width, now.top], chain(0));
    expect(right0 - left0).toBeCloseTo(now.width, 2);
    expect(right0).toBeCloseTo(was.left + was.width, 2);
    expect(top0).toBeCloseTo(was.top, 2);
  });

  it('an item that never moves, never fades and keeps its corners gets no animation at all', () => {
    const item: MorphItem = { el: el(), kind: 'rigid', layout: pane };
    expect(morphFrames([item], { duration: 650, easing: linear }).has(item)).toBe(false);
    const fading: MorphItem = { el: el(), kind: 'rigid', layout: pane, fade: { from: 0, to: 1 } };
    const frames = morphFrames([fading], { duration: 150, easing: linear, samples: 4 }).get(fading)!;
    expect(frames.map((frame) => frame.opacity)).toEqual([0, 0.156, 0.5, 0.844, 1]);
    expect(frames.every((frame) => frame.transform === 'translate(0px, 0px) scale(1, 1)')).toBe(true);
  });
});
