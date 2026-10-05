import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureMotion, resetMotionSwitchForTests } from '../../lib/motion/reducedMotion';
import { installWaapiStub, type WaapiStub } from '../../lib/motion/waapiStub';
import { createResolvedLightboxImage, useLightboxStore } from '../../stores/lightboxStore';
import { ImageLightbox } from './ImageLightbox';

/**
 * The media viewer (docs/index-spec.md §6.10): the picture grows out of the bubble
 * that was pressed (a FLIP, 135ms on the spring) and shrinks back into it on
 * close, then the viewer goes. Transform and opacity only.
 */

let waapi: WaapiStub;

const SOURCE = { left: 400, top: 300, width: 200, height: 120 };
const FULL = { left: 220, top: 90, width: 1000, height: 600 };

function rect(box: { left: number; top: number; width: number; height: number }): DOMRect {
  return { ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => ({}) } as DOMRect;
}

let source: HTMLImageElement;
let bubble: HTMLButtonElement;
let originalRect: typeof Element.prototype.getBoundingClientRect;

beforeEach(() => {
  waapi = installWaapiStub();
  resetMotionSwitchForTests();
  configureMotion('full');
  Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => true });
  originalRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    // The thumbnail in the message is where it was; everything else is the viewer's full size.
    return rect(this === source ? SOURCE : FULL);
  };
  // A message's photo: a button around an image, as the timeline draws it.
  bubble = document.createElement('button');
  source = document.createElement('img');
  source.alt = '';
  bubble.appendChild(source);
  document.body.appendChild(bubble);
});

afterEach(() => {
  act(() => useLightboxStore.getState().close());
  Element.prototype.getBoundingClientRect = originalRect;
  delete (HTMLImageElement.prototype as { complete?: unknown }).complete;
  bubble.remove();
  waapi.restore();
  resetMotionSwitchForTests();
});

const press = () => source.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
const open = () =>
  act(() => useLightboxStore.getState().open([createResolvedLightboxImage('blob:http://localhost/photo', 'photo-1.png')], 0));
const byId = (id: string) => waapi.played.filter((record) => record.animation.id === id);
const properties = (id: string) =>
  new Set(byId(id).flatMap((record) => record.keyframes.flatMap((frame) => Object.keys(frame))));

describe('the media viewer FLIP', () => {
  it('grows out of the pressed bubble: a transform-only move from its rect, 135ms on the spring', () => {
    render(<ImageLightbox />);
    press();
    open();
    const grow = byId('ix-viewer:grow');
    expect(grow).toHaveLength(1);
    expect(grow[0].options.duration).toBe(135);
    expect(grow[0].options.easing).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
    const [first, last] = grow[0].keyframes;
    // translate(dx, dy) scale(sx, sy) from the stage's rect to the thumbnail's.
    expect(first.transform).toBe('translate(180px, 210px) scale(0.2, 0.2)');
    expect(first.transformOrigin).toBe('0 0');
    expect(last.transform).toBe('none');
    expect([...properties('ix-viewer:grow')].filter((p) => !['transformOrigin'].includes(p)).sort()).toEqual(['transform']);
  });

  it('plays on the picture (the stage), not on the scrim, and only once per opening', () => {
    render(<ImageLightbox />);
    press();
    open();
    const picture = screen.getByAltText('photo-1.png');
    // The stage is the picture's scroller: its own travel is never clipped by it.
    expect(byId('ix-viewer:grow')[0].target).toBe(picture.parentElement?.parentElement);
    act(() => useLightboxStore.getState().goTo(0));
    expect(byId('ix-viewer:grow')).toHaveLength(1);
  });

  it('with nothing pressed (a keyboard or a deep link) the viewer just fades in: no move', () => {
    render(<ImageLightbox />);
    open();
    expect(byId('ix-viewer:grow')).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: 'Image viewer' })).toBeInTheDocument();
  });

  it('shrinks back into the bubble on close, then the viewer is removed', async () => {
    render(<ImageLightbox />);
    press();
    open();
    act(() => useLightboxStore.getState().close());
    // The store has dropped its images; the viewer stays for the leave.
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).toHaveAttribute('aria-hidden', 'true');
    const shrink = byId('ix-viewer:shrink');
    expect(shrink).toHaveLength(1);
    expect(shrink[0].options.duration).toBe(135);
    const [first, last] = shrink[0].keyframes;
    expect(first.transform).toBe('none');
    expect(last.transform).toBe('translate(180px, 210px) scale(0.2, 0.2)');
    expect([...properties('ix-viewer:shrink')].filter((p) => p !== 'transformOrigin')).toEqual(['transform']);
    expect(byId('ix-viewer:scrim')).toHaveLength(1);
    // Finishing them removes it.
    await act(async () => {
      for (const record of waapi.played) record.animation.finish();
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('reopening during the leave brings the viewer back', () => {
    render(<ImageLightbox />);
    press();
    open();
    act(() => useLightboxStore.getState().close());
    open();
    expect(screen.getByRole('dialog', { name: 'Image viewer' })).not.toHaveAttribute('aria-hidden');
  });

  it('reduced motion: no move, a 65ms fade', () => {
    configureMotion('reduced');
    render(<ImageLightbox />);
    press();
    open();
    // The reduced path is the helper's own 65ms fade in place.
    const grow = byId('ix-viewer:grow');
    expect(grow).toHaveLength(1);
    expect(grow[0].options.duration).toBe(65);
    expect(grow[0].keyframes.map((frame) => Object.keys(frame).filter((key) => key !== 'offset')).flat()).toEqual(['opacity', 'opacity']);
  });

  it('a press that scrolled out of view is not a source', () => {
    render(<ImageLightbox />);
    press();
    bubble.remove();
    open();
    expect(byId('ix-viewer:grow')).toHaveLength(0);
  });
});
