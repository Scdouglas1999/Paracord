import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanvasRenderer } from './video/canvasRenderer';
import type { PulledFrame } from './transport/protocol';

const { decodeSpy, closeSpy } = vi.hoisted(() => ({
  decodeSpy: vi.fn(),
  closeSpy: vi.fn(),
}));

vi.mock('./video/videoDecoder', () => ({
  MediaVideoDecoder: vi.fn(function (this: Record<string, unknown>) {
    this.decode = decodeSpy;
    this.close = closeSpy;
    this.onDecoded = vi.fn();
  }),
}));

import { MediaVideoDecoder } from './video/videoDecoder';
import { startPulledEncodedVideoSubscription } from './tauriMediaEngine';

function base64Of(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

function fakeRenderer() {
  return {
    drawI420: vi.fn(),
    renderFrame: vi.fn(),
  } as unknown as CanvasRenderer & { drawI420: ReturnType<typeof vi.fn>; renderFrame: ReturnType<typeof vi.fn> };
}

/** Yields a pullFrame that returns each frame once, then null forever. */
function sequencedPuller(frames: PulledFrame[]) {
  let index = 0;
  return vi.fn(async () => {
    if (index < frames.length) {
      return frames[index++];
    }
    return null;
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('startPulledEncodedVideoSubscription i420 routing', () => {
  it('draws native i420 frames directly and never touches the WebCodecs decoder', async () => {
    const renderer = fakeRenderer();
    // 2x2 I420: 4 Y bytes + 1 U + 1 V = 6 bytes.
    const i420Frame: PulledFrame = {
      timestampUs: 1000,
      sequence: 1,
      isKeyframe: true,
      codec: 'vp9',
      format: 'i420',
      width: 2,
      height: 2,
      dataBase64: base64Of([16, 16, 16, 16, 128, 128]),
    };
    const onFrame = vi.fn();
    const decoderRef = { current: null as InstanceType<typeof MediaVideoDecoder> | null, codec: null as string | null };

    const stop = startPulledEncodedVideoSubscription(
      'test:i420',
      sequencedPuller([i420Frame]),
      decoderRef,
      renderer,
      onFrame,
    );

    await vi.waitFor(() => expect(renderer.drawI420).toHaveBeenCalledTimes(1));
    stop();

    const [pixels, width, height] = renderer.drawI420.mock.calls[0];
    expect(width).toBe(2);
    expect(height).toBe(2);
    expect(pixels).toBeInstanceOf(Uint8Array);
    expect(onFrame).toHaveBeenCalled();

    // The native path bypasses WebCodecs entirely.
    expect(MediaVideoDecoder).not.toHaveBeenCalled();
    expect(decodeSpy).not.toHaveBeenCalled();
    expect(decoderRef.current).toBeNull();
  });

  it('routes encoded frames through the WebCodecs decoder, not drawI420', async () => {
    const renderer = fakeRenderer();
    const encodedFrame: PulledFrame = {
      timestampUs: 2000,
      sequence: 1,
      isKeyframe: true,
      codec: 'vp9',
      dataBase64: base64Of([1, 2, 3, 4]),
    };
    const decoderRef = { current: null as InstanceType<typeof MediaVideoDecoder> | null, codec: null as string | null };

    const stop = startPulledEncodedVideoSubscription(
      'test:encoded',
      sequencedPuller([encodedFrame]),
      decoderRef,
      renderer,
    );

    await vi.waitFor(() => expect(decodeSpy).toHaveBeenCalledTimes(1));
    stop();

    expect(MediaVideoDecoder).toHaveBeenCalledTimes(1);
    expect(renderer.drawI420).not.toHaveBeenCalled();
  });
});
