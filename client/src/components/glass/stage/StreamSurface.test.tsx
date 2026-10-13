import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { MediaEngine } from '../../../lib/media/mediaEngine';
import { StreamSurface } from './StreamSurface';

// A watch that stays connected while the streamer stops and shares again
// (stream audit B1, docs/design/index-checkpoints/stream-fix-v2.md): the box
// must not keep claiming the last share's frozen frame as a picture, and the
// next share is a picture only once its first frame arrives.

function fakeEngine() {
  let frame: (() => void) | undefined;
  const engine = {
    subscribeVideo: vi.fn((_user: string, _canvas: HTMLCanvasElement, onFrame?: () => void) => {
      frame = onFrame;
      return () => {};
    }),
    listPublishedTracks: vi.fn(async () => []),
    registerTrackSubscription: vi.fn(async () => {}),
  } as unknown as MediaEngine;
  return { engine, firstFrame: () => act(() => frame?.()) };
}

const picture = (container: HTMLElement) =>
  container.querySelector('.glass-stage__stream')?.getAttribute('data-picture') ?? null;

describe('StreamSurface across a stopped and restarted share', () => {
  it('drops the picture when the share stops and waits for the next share\'s first frame', () => {
    const { engine, firstFrame } = fakeEngine();
    const onPicture = vi.fn();
    const view = render(<StreamSurface engine={engine} streamerId="200" notice={null} onPicture={onPicture} sharing />);
    expect(picture(view.container)).toBeNull();
    firstFrame();
    expect(picture(view.container)).toBe('true');

    // Stopped: the frozen last frame is not a picture.
    view.rerender(<StreamSurface engine={engine} streamerId="200" notice={null} onPicture={onPicture} sharing={false} />);
    expect(picture(view.container)).toBeNull();
    expect(onPicture).toHaveBeenLastCalledWith(false);

    // Sharing again, the same subscription: nothing until the new first frame.
    view.rerender(<StreamSurface engine={engine} streamerId="200" notice={null} onPicture={onPicture} sharing />);
    expect(picture(view.container)).toBeNull();
    firstFrame();
    expect(picture(view.container)).toBe('true');
    expect(onPicture).toHaveBeenLastCalledWith(true);
    // The watch was never subscribed again by the box: the engine rebinds it.
    expect(engine.subscribeVideo).toHaveBeenCalledTimes(1);
  });
});
