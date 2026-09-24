import { describe, expect, it } from 'vitest';
import type { PublishedLayerDescriptor, PublishedTrackDescriptor } from './mediaEngine';
import { encodeVideoFrameMetadata } from './transport/protocol';
import {
  deriveTrackSsrc,
  reassembleVideoPayload,
  selectPublishedLayer,
  VideoDecodeGate,
  type VideoReassemblyState,
} from './engineShared';

const VP9_CODEC_ID = 1;

function buildFragment(opts: {
  streamId?: string;
  trackId?: string;
  frameId?: bigint;
  layerId?: number;
  timestampUs?: bigint;
  codec?: number;
  isKeyframe?: boolean;
  fragmentIndex: number;
  fragmentCount: number;
  chunk: Uint8Array;
}): Uint8Array {
  const meta = encodeVideoFrameMetadata({
    streamId: opts.streamId ?? 'stream-1',
    trackId: opts.trackId ?? 'camera',
    frameId: opts.frameId ?? 7n,
    layerId: opts.layerId ?? 0,
    codec: opts.codec ?? VP9_CODEC_ID,
    timestampUs: opts.timestampUs ?? 0n,
    isKeyframe: opts.isKeyframe ?? false,
    fragmentIndex: opts.fragmentIndex,
    fragmentCount: opts.fragmentCount,
  });
  const out = new Uint8Array(meta.byteLength + opts.chunk.byteLength);
  out.set(meta, 0);
  out.set(opts.chunk, meta.byteLength);
  return out;
}

function layer(over: Partial<PublishedLayerDescriptor> & { layerId: number }): PublishedLayerDescriptor {
  return {
    layerId: over.layerId,
    ssrc: over.ssrc ?? over.layerId + 1,
    width: over.width ?? null,
    height: over.height ?? null,
    maxBitrateKbps: over.maxBitrateKbps ?? null,
    active: over.active ?? true,
  };
}

function track(layers: PublishedLayerDescriptor[]): PublishedTrackDescriptor {
  return {
    streamId: 'stream-1',
    trackId: 'camera',
    publisherUserId: '42',
    kind: 'video',
    codec: 'vp9',
    layers,
  };
}

describe('reassembleVideoPayload', () => {
  it('returns a single-fragment frame immediately with codec label', () => {
    const state = new Map<string, VideoReassemblyState>();
    const chunk = new Uint8Array([10, 20, 30]);
    const result = reassembleVideoPayload(
      state,
      buildFragment({ fragmentIndex: 0, fragmentCount: 1, isKeyframe: true, chunk }),
      0,
    );
    expect(result).not.toBeNull();
    expect(Array.from(result!.data)).toEqual([10, 20, 30]);
    expect(result!.isKeyframe).toBe(true);
    expect(result!.codec).toBe('vp9');
    expect(state.size).toBe(0);
  });

  it('reassembles multi-fragment frames delivered in order', () => {
    const state = new Map<string, VideoReassemblyState>();
    const first = reassembleVideoPayload(
      state,
      buildFragment({ fragmentIndex: 0, fragmentCount: 2, chunk: new Uint8Array([1, 2]) }),
      0,
    );
    expect(first).toBeNull();
    const second = reassembleVideoPayload(
      state,
      buildFragment({ fragmentIndex: 1, fragmentCount: 2, chunk: new Uint8Array([3, 4]) }),
      1,
    );
    expect(second).not.toBeNull();
    expect(Array.from(second!.data)).toEqual([1, 2, 3, 4]);
    expect(state.size).toBe(0);
  });

  it('reassembles multi-fragment frames delivered out of order', () => {
    const state = new Map<string, VideoReassemblyState>();
    const first = reassembleVideoPayload(
      state,
      buildFragment({ fragmentIndex: 2, fragmentCount: 3, chunk: new Uint8Array([5, 6]) }),
      0,
    );
    expect(first).toBeNull();
    const second = reassembleVideoPayload(
      state,
      buildFragment({ fragmentIndex: 0, fragmentCount: 3, chunk: new Uint8Array([1, 2]) }),
      1,
    );
    expect(second).toBeNull();
    const third = reassembleVideoPayload(
      state,
      buildFragment({ fragmentIndex: 1, fragmentCount: 3, chunk: new Uint8Array([3, 4]) }),
      2,
    );
    expect(third).not.toBeNull();
    expect(Array.from(third!.data)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('stays null while a fragment is missing', () => {
    const state = new Map<string, VideoReassemblyState>();
    const only = reassembleVideoPayload(
      state,
      buildFragment({ fragmentIndex: 0, fragmentCount: 3, chunk: new Uint8Array([1]) }),
      0,
    );
    expect(only).toBeNull();
    expect(state.size).toBe(1);
    // A duplicate of the same fragment does not complete the frame.
    const dup = reassembleVideoPayload(
      state,
      buildFragment({ fragmentIndex: 0, fragmentCount: 3, chunk: new Uint8Array([9]) }),
      1,
    );
    expect(dup).toBeNull();
  });

  it('evicts stalled partial frames after the reassembly timeout', () => {
    const state = new Map<string, VideoReassemblyState>();
    reassembleVideoPayload(
      state,
      buildFragment({ frameId: 1n, fragmentIndex: 0, fragmentCount: 2, chunk: new Uint8Array([1]) }),
      0,
    );
    expect(state.size).toBe(1);
    // A later fragment for a different frame, past the 3s window, sweeps the stale one.
    reassembleVideoPayload(
      state,
      buildFragment({ frameId: 2n, fragmentIndex: 0, fragmentCount: 2, chunk: new Uint8Array([2]) }),
      4000,
    );
    expect(state.size).toBe(1);
    expect(state.has('stream-1:camera:1')).toBe(false);
    expect(state.has('stream-1:camera:2')).toBe(true);
  });

  it('returns null for malformed payloads', () => {
    const state = new Map<string, VideoReassemblyState>();
    expect(reassembleVideoPayload(state, new Uint8Array([]), 0)).toBeNull();
    expect(reassembleVideoPayload(state, new Uint8Array([0xff, 0x00]), 0)).toBeNull();
  });
});

describe('selectPublishedLayer', () => {
  it('returns null for a track with no layers', () => {
    expect(selectPublishedLayer(track([]), 640, 360)).toBeNull();
  });

  it('picks the lowest layer that covers the viewport', () => {
    const selected = selectPublishedLayer(
      track([
        layer({ layerId: 2, width: 1280, height: 720 }),
        layer({ layerId: 0, width: 320, height: 180 }),
        layer({ layerId: 1, width: 640, height: 360 }),
      ]),
      640,
      360,
    );
    expect(selected?.layerId).toBe(1);
  });

  it('falls back to the highest layer when none cover the viewport', () => {
    const selected = selectPublishedLayer(
      track([
        layer({ layerId: 0, width: 320, height: 180 }),
        layer({ layerId: 1, width: 640, height: 360 }),
      ]),
      4000,
      4000,
    );
    expect(selected?.layerId).toBe(1);
  });
});

describe('deriveTrackSsrc', () => {
  it('is deterministic for the same user and kind', async () => {
    const a = await deriveTrackSsrc('42', 'audio');
    const b = await deriveTrackSsrc('42', 'audio');
    expect(a).toBe(b);
  });

  it('produces distinct, non-zero ssrcs for distinct inputs', async () => {
    const audio = await deriveTrackSsrc('42', 'audio');
    const video = await deriveTrackSsrc('42', 'video');
    const otherUser = await deriveTrackSsrc('43', 'audio');
    expect(audio).not.toBe(video);
    expect(audio).not.toBe(otherUser);
    for (const ssrc of [audio, video, otherUser]) {
      expect(ssrc).toBeGreaterThan(0);
      expect(ssrc).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('reassembleVideoPayload layer and capture time', () => {
  it('carries the layer and capture timestamp through single and fragmented frames', () => {
    const state = new Map<string, VideoReassemblyState>();
    const whole = reassembleVideoPayload(
      state,
      buildFragment({
        fragmentIndex: 0,
        fragmentCount: 1,
        layerId: 2,
        timestampUs: 1_000n,
        chunk: new Uint8Array([1]),
      }),
      0,
    );
    expect(whole).toMatchObject({ layerId: 2, timestampUs: 1_000n });

    reassembleVideoPayload(
      state,
      buildFragment({
        frameId: 9n,
        fragmentIndex: 0,
        fragmentCount: 2,
        layerId: 1,
        timestampUs: 2_000n,
        chunk: new Uint8Array([1]),
      }),
      0,
    );
    const joined = reassembleVideoPayload(
      state,
      buildFragment({
        frameId: 9n,
        fragmentIndex: 1,
        fragmentCount: 2,
        layerId: 1,
        timestampUs: 2_000n,
        chunk: new Uint8Array([2]),
      }),
      0,
    );
    expect(joined).toMatchObject({ layerId: 1, timestampUs: 2_000n });
  });
});

describe('VideoDecodeGate', () => {
  type Frame = { id: string; isKeyframe: boolean; layerId: number; timestampUs: bigint };
  const key = (id: string, layerId: number, timestampUs: number): Frame => ({
    id,
    isKeyframe: true,
    layerId,
    timestampUs: BigInt(timestampUs),
  });
  const delta = (id: string, layerId: number, timestampUs: number): Frame => ({
    id,
    isKeyframe: false,
    layerId,
    timestampUs: BigInt(timestampUs),
  });
  const ids = (frames: Frame[]) => frames.map((frame) => frame.id);

  it('decodes a keyframe and the deltas of its layer that follow it', () => {
    const gate = new VideoDecodeGate<Frame>();
    expect(ids(gate.admit(key('k0', 0, 100)).decode)).toEqual(['k0']);
    expect(ids(gate.admit(delta('d1', 0, 200)).decode)).toEqual(['d1']);
    expect(ids(gate.admit(delta('d2', 0, 300)).decode)).toEqual(['d2']);
  });

  it('holds deltas that arrive before any keyframe and asks for one', () => {
    const gate = new VideoDecodeGate<Frame>();
    const early = gate.admit(delta('d1', 0, 200));
    expect(early).toEqual({ decode: [], needKeyframe: true });
  });

  it('drops a delta older than the keyframe it would be decoded after', () => {
    // The shape measured in CI: a keyframe on the reliable stream overtook the
    // datagram carrying the delta captured 100 ms before it.
    const gate = new VideoDecodeGate<Frame>();
    gate.admit(key('k0', 0, 0));
    gate.admit(delta('d1', 0, 100_000));
    gate.admit(key('k2', 0, 300_000));
    expect(gate.admit(delta('late', 0, 200_000))).toEqual({ decode: [], needKeyframe: false });
    expect(ids(gate.admit(delta('d3', 0, 400_000)).decode)).toEqual(['d3']);
  });

  it('never feeds another layer’s delta into the current chain', () => {
    const gate = new VideoDecodeGate<Frame>();
    gate.admit(key('low-k', 0, 0));
    gate.admit(delta('low-d', 0, 100_000));
    const stray = gate.admit(delta('high-d', 1, 150_000));
    expect(stray.decode).toEqual([]);
    expect(stray.needKeyframe).toBe(true);
    // The old layer carries on until the switch lands.
    expect(ids(gate.admit(delta('low-d2', 0, 200_000)).decode)).toEqual(['low-d2']);
  });

  it('replays the new layer’s early deltas behind its keyframe, in capture order', () => {
    const gate = new VideoDecodeGate<Frame>();
    gate.admit(key('low-k', 0, 0));
    gate.admit(delta('low-d', 0, 100_000));
    // After the relay switched this viewer to layer 1: its deltas raced ahead
    // of its keyframe, and one of them overtook another.
    gate.admit(delta('high-d3', 1, 300_000));
    gate.admit(delta('high-d2', 1, 250_000));
    const landed = gate.admit(key('high-k', 1, 200_000));
    expect(ids(landed.decode)).toEqual(['high-k', 'high-d2', 'high-d3']);
    // Anything from the old layer is now behind the chain.
    expect(gate.admit(delta('low-late', 0, 150_000)).decode).toEqual([]);
    expect(ids(gate.admit(delta('high-d4', 1, 350_000)).decode)).toEqual(['high-d4']);
  });

  it('starts over from a keyframe whose clock went backwards (a restarted publisher)', () => {
    const gate = new VideoDecodeGate<Frame>();
    gate.admit(key('k0', 0, 5_000_000));
    gate.admit(delta('d1', 0, 5_100_000));
    expect(ids(gate.admit(key('restart', 0, 0)).decode)).toEqual(['restart']);
    expect(ids(gate.admit(delta('d-after', 0, 33_000)).decode)).toEqual(['d-after']);
  });

  it('keeps decoding a publisher that stamps every frame zero', () => {
    const gate = new VideoDecodeGate<Frame>();
    gate.admit(key('k0', 0, 0));
    expect(ids(gate.admit(delta('d1', 0, 0)).decode)).toEqual(['d1']);
    expect(ids(gate.admit(delta('d2', 0, 0)).decode)).toEqual(['d2']);
  });

  it('forgets the chain on reset', () => {
    const gate = new VideoDecodeGate<Frame>();
    gate.admit(key('k0', 0, 0));
    gate.reset();
    expect(gate.admit(delta('d1', 0, 100)).needKeyframe).toBe(true);
  });
});
