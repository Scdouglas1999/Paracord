import { describe, expect, it } from 'vitest';
import type { PublishedLayerDescriptor, PublishedTrackDescriptor } from './mediaEngine';
import { encodeVideoFrameMetadata } from './transport/protocol';
import {
  deriveTrackSsrc,
  reassembleVideoPayload,
  selectPublishedLayer,
  type VideoReassemblyState,
} from './engineShared';

const VP9_CODEC_ID = 1;

function buildFragment(opts: {
  streamId?: string;
  trackId?: string;
  frameId?: bigint;
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
    layerId: 0,
    codec: opts.codec ?? VP9_CODEC_ID,
    timestampUs: 0n,
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
