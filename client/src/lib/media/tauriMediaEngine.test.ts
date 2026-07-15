import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanvasRenderer } from './video/canvasRenderer';
import { PULLED_VIDEO_FRAME_HEADER_SIZE } from './video/pulledVideoFrame';

const { decodeSpy, closeSpy } = vi.hoisted(() => ({
  decodeSpy: vi.fn(),
  closeSpy: vi.fn(),
}));

vi.mock('./video/videoDecoder', () => ({
  MediaVideoDecoder: vi.fn(function (this: Record<string, unknown>) {
    this.decode = decodeSpy;
    this.close = closeSpy;
    this.onDecoded = vi.fn();
    this.onError = vi.fn();
    this.onKeyframeNeeded = vi.fn();
  }),
  isWebCodecsDecodeSupported: vi.fn(async () => true),
}));

import { MediaVideoDecoder } from './video/videoDecoder';
import { startPulledEncodedVideoSubscription } from './tauriMediaEngine';

type ChannelMessage = ArrayBuffer | Uint8Array | number[];

// Format tags (mirror FORMAT_TAGS in pulledVideoFrame.ts):
//   0 i420 · 1 vp9 · 2 h264 · 3 av1 · 4 raw · 5 bgra · 6 rgba
// Only the encoded tags (vp9/h264/av1) may cross this channel; every raw pixel
// format is a native-route regression and must hard-fail (spec §2).
function packBinaryFrame(
  sequence: number,
  formatTag: number,
  codecTag: number,
  width: number,
  height: number,
  payload: number[],
): Uint8Array {
  const buf = new Uint8Array(PULLED_VIDEO_FRAME_HEADER_SIZE + payload.length);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, BigInt(sequence), true);
  view.setBigUint64(8, BigInt(1000), true);
  view.setUint8(16, 1);
  view.setUint8(17, formatTag);
  view.setUint8(18, codecTag);
  view.setUint8(19, 0);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  buf.set(payload, PULLED_VIDEO_FRAME_HEADER_SIZE);
  return buf;
}

function encodedVp9(sequence: number, payload: number[] = [1, 2, 3, 4]): Uint8Array {
  return packBinaryFrame(sequence, 1, 1, 0, 0, payload);
}

/** The runtime never draws raw pixels on this channel anymore (spec §2), so the
 * renderer stub only needs the encoded-decode surface (`renderFrame`), which the
 * mocked decoder never invokes in these unit tests. */
function fakeRenderer() {
  return {
    renderFrame: vi.fn(),
    setRenderingEnabled: vi.fn(),
  } as unknown as CanvasRenderer & {
    renderFrame: ReturnType<typeof vi.fn>;
    setRenderingEnabled: ReturnType<typeof vi.fn>;
  };
}

/** Stand-in for a Tauri frame channel: the subscription assigns `onmessage`,
 * the test drives frames by invoking it. */
function fakeChannel() {
  return { onmessage: (_message: ChannelMessage) => {} };
}

function newDecoderRef() {
  return { current: null as InstanceType<typeof MediaVideoDecoder> | null, codec: null as string | null };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('startPulledEncodedVideoSubscription channel routing', () => {
  it('hard-fails an i420 frame on the encoded-passthrough channel and never decodes it', () => {
    const renderer = fakeRenderer();
    const channel = fakeChannel();
    const decoderRef = newDecoderRef();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Raw I420 no longer crosses this channel — the native-surface route owns
    // decoded frames (spec §2). Seeing one here is a native-route regression:
    // fail loudly and drop, never paint a multi-MB frame.
    const stop = startPulledEncodedVideoSubscription('test:i420', channel, decoderRef, renderer);
    channel.onmessage(packBinaryFrame(1, 0, 1, 2, 2, [16, 16, 16, 16, 128, 128]));
    stop();

    expect(consoleError).toHaveBeenCalled();
    expect(MediaVideoDecoder).not.toHaveBeenCalled();
    expect(decodeSpy).not.toHaveBeenCalled();
    expect(decoderRef.current).toBeNull();
    consoleError.mockRestore();
  });

  it('hard-fails bgra and generic raw preview frames instead of drawing them', () => {
    const decoderRef = newDecoderRef();
    for (const formatTag of [5 /* bgra */, 4 /* raw */, 6 /* rgba */]) {
      const renderer = fakeRenderer();
      const channel = fakeChannel();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const stop = startPulledEncodedVideoSubscription('test:raw', channel, decoderRef, renderer);
      channel.onmessage(packBinaryFrame(1, formatTag, 4, 1, 1, [10, 20, 30, 255]));
      stop();

      expect(consoleError).toHaveBeenCalled();
      expect(decodeSpy).not.toHaveBeenCalled();
      consoleError.mockRestore();
      vi.clearAllMocks();
    }
    expect(MediaVideoDecoder).not.toHaveBeenCalled();
  });

  it('hard-fails a RAW frame delivered over the JSON transport instead of converting it', () => {
    const renderer = fakeRenderer();
    const channel = fakeChannel();
    const decoderRef = newDecoderRef();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    // An i420 (raw) frame as a JSON number array is the 3MB-per-frame incident:
    // it must be dropped and surfaced, never drawn (W2).
    const stop = startPulledEncodedVideoSubscription('test:raw-json', channel, decoderRef, renderer);
    channel.onmessage(Array.from(packBinaryFrame(1, 0, 1, 2, 2, [16, 16, 16, 16, 128, 128])));
    stop();

    expect(MediaVideoDecoder).not.toHaveBeenCalled();
    expect(decodeSpy).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('still decodes ENCODED frames delivered over the JSON transport, with a loud warning', () => {
    const renderer = fakeRenderer();
    const channel = fakeChannel();
    const decoderRef = newDecoderRef();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // An encoded vp9 frame survives the JSON tax (a few KB), so it is decoded.
    const stop = startPulledEncodedVideoSubscription('test:enc-json', channel, decoderRef, renderer);
    channel.onmessage(Array.from(encodedVp9(1)));
    stop();

    expect(decodeSpy).toHaveBeenCalledTimes(1);
    expect(MediaVideoDecoder).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it('requests a keyframe (debounced) when the decoder reports it needs one', () => {
    const renderer = fakeRenderer();
    const channel = fakeChannel();
    const decoderRef = newDecoderRef();
    const requestKeyframe = vi.fn();

    const stop = startPulledEncodedVideoSubscription(
      'test:keyframe',
      channel,
      decoderRef,
      renderer,
      undefined,
      undefined,
      undefined,
      requestKeyframe,
    );
    // Feed an encoded frame so a decoder is created and attachDecoder wires the
    // keyframe-needed callback; then fire that callback as the decoder would.
    channel.onmessage(encodedVp9(1));
    const decoderInstance = (MediaVideoDecoder as unknown as { mock: { instances: Array<{ onKeyframeNeeded: ReturnType<typeof vi.fn> }> } }).mock.instances[0];
    const onKeyframeNeeded = decoderInstance.onKeyframeNeeded.mock.calls[0][0] as () => void;
    onKeyframeNeeded();
    stop();

    expect(requestKeyframe).toHaveBeenCalledTimes(1);
  });

  it('routes encoded frames through the WebCodecs decoder', () => {
    const renderer = fakeRenderer();
    const channel = fakeChannel();
    const decoderRef = newDecoderRef();

    const stop = startPulledEncodedVideoSubscription('test:encoded', channel, decoderRef, renderer);
    channel.onmessage(encodedVp9(1));
    stop();

    expect(decodeSpy).toHaveBeenCalledTimes(1);
    expect(MediaVideoDecoder).toHaveBeenCalledTimes(1);
  });

  it('drops pushed frames while rendering is disabled and decodes once enabled', () => {
    const renderer = fakeRenderer();
    const channel = fakeChannel();
    const decoderRef = newDecoderRef();
    let renderingEnabled = false;

    const stop = startPulledEncodedVideoSubscription(
      'test:hidden',
      channel,
      decoderRef,
      renderer,
      undefined,
      undefined,
      () => renderingEnabled,
    );

    channel.onmessage(encodedVp9(1));
    expect(decodeSpy).not.toHaveBeenCalled();

    // A newer frame after re-enabling decodes (the hidden frame never advanced
    // lastSequence, so nothing is spuriously dropped as stale).
    renderingEnabled = true;
    channel.onmessage(encodedVp9(2));
    expect(decodeSpy).toHaveBeenCalledTimes(1);
    stop();
  });

  it('drops replayed/duplicate sequences and decodes only strictly-newer frames', () => {
    const renderer = fakeRenderer();
    const channel = fakeChannel();
    const decoderRef = newDecoderRef();

    const stop = startPulledEncodedVideoSubscription('test:stale', channel, decoderRef, renderer);

    channel.onmessage(encodedVp9(1));
    expect(decodeSpy).toHaveBeenCalledTimes(1);

    // A replayed/duplicate sequence (as a re-register pushes) is ignored.
    channel.onmessage(encodedVp9(1));
    expect(decodeSpy).toHaveBeenCalledTimes(1);

    // A strictly-newer sequence decodes.
    channel.onmessage(encodedVp9(2));
    expect(decodeSpy).toHaveBeenCalledTimes(2);
    stop();
  });

  it('ignores frames pushed after the subscription is stopped', () => {
    const renderer = fakeRenderer();
    const channel = fakeChannel();
    const decoderRef = newDecoderRef();

    const stop = startPulledEncodedVideoSubscription('test:stopped', channel, decoderRef, renderer);
    stop();
    channel.onmessage(encodedVp9(1));

    expect(decodeSpy).not.toHaveBeenCalled();
  });
});
