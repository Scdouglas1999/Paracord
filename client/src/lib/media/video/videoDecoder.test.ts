import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MediaVideoDecoder } from './videoDecoder';

/**
 * A stand-in for WebCodecs' `VideoDecoder` with its one behavior that matters
 * here: after it reports an error it is `closed`, for good.
 */
class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = [];
  state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
  decodeQueueSize = 0;
  decoded: Array<{ type: string; timestamp: number }> = [];

  constructor(readonly init: { output: (frame: unknown) => void; error: (err: unknown) => void }) {
    FakeVideoDecoder.instances.push(this);
  }

  configure(): void {
    this.state = 'configured';
  }

  decode(chunk: { type: string; timestamp: number }): void {
    if (this.state !== 'configured') throw new DOMException('not configured', 'InvalidStateError');
    this.decoded.push(chunk);
  }

  /** What Chromium does with a chunk it cannot decode. */
  fail(): void {
    this.state = 'closed';
    this.init.error(new DOMException('Decoding error.', 'EncodingError'));
  }

  reset(): void {}

  close(): void {
    this.state = 'closed';
  }
}

class FakeEncodedVideoChunk {
  readonly type: string;
  readonly timestamp: number;
  constructor(init: { type: string; timestamp: number }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
  }
}

describe('MediaVideoDecoder', () => {
  beforeEach(() => {
    FakeVideoDecoder.instances = [];
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('comes back from a decode error at the next keyframe instead of staying closed', () => {
    const decoder = new MediaVideoDecoder({ codec: 'vp9' });
    const keyframeNeeded = vi.fn();
    decoder.onKeyframeNeeded(keyframeNeeded);
    const data = new Uint8Array([1]);

    decoder.decode(data, 0, true);
    decoder.decode(data, 1, false);
    FakeVideoDecoder.instances[0].fail();

    expect(keyframeNeeded).toHaveBeenCalled();
    expect(FakeVideoDecoder.instances).toHaveLength(2);
    const rebuilt = FakeVideoDecoder.instances[1];
    expect(rebuilt.state).toBe('configured');

    // Deltas cannot restart a chain; the keyframe does.
    decoder.decode(data, 2, false);
    expect(rebuilt.decoded).toEqual([]);
    decoder.decode(data, 3, true);
    decoder.decode(data, 4, false);
    expect(rebuilt.decoded.map((chunk) => chunk.timestamp)).toEqual([3, 4]);
  });

  it('does not rebuild a decoder that was closed on purpose', () => {
    const decoder = new MediaVideoDecoder({ codec: 'vp9' });
    const first = FakeVideoDecoder.instances[0];
    decoder.close();
    first.init.error(new DOMException('Aborted', 'AbortError'));
    expect(FakeVideoDecoder.instances).toHaveLength(1);
  });
});
