// Pure helpers shared by the browser (WebTransport) and Tauri (native IPC)
// media engines. These functions carry no engine instance state so they can be
// unit-tested in isolation and reused verbatim by both implementations.

import type { OperationContext } from '../operationContext';
import type { PublishedLayerDescriptor, PublishedTrackDescriptor } from './mediaEngine';
import { decodeVideoFrameMetadata, type VideoFrameMetadata } from './transport/protocol';
import type { MediaKeyring } from './mediaKeyring';

/** In-progress reassembly of a fragmented video frame, keyed per frame. */
export interface VideoReassemblyState {
  streamId: string;
  trackId: string;
  layerId: number;
  timestampUs: bigint;
  codec: number;
  fragmentCount: number;
  isKeyframe: boolean;
  chunks: Array<Uint8Array | null>;
  received: number;
  lastUpdate: number;
}

/** A fully reassembled encoded video frame ready to hand to a decoder. */
export interface ReassembledVideoFrame {
  data: Uint8Array;
  isKeyframe: boolean;
  streamId: string;
  trackId: string;
  /** The simulcast layer this frame was encoded for. */
  layerId: number;
  /** The publisher's capture timestamp, shared by every layer of the track. */
  timestampUs: bigint;
  codec: string;
}

/** Milliseconds after which a stalled reassembly buffer is discarded. */
const REASSEMBLY_TIMEOUT_MS = 3000;

/** Map the on-wire codec id (media packet header) to a decoder codec label. */
export function codecLabelFromHeader(codecId: number): string {
  switch (codecId) {
    case 2:
      return 'av1';
    case 3:
      return 'h264';
    case 1:
    default:
      return 'vp9';
  }
}

/**
 * Reassemble a (possibly fragmented) video datagram payload.
 *
 * Single-fragment frames are returned immediately. Multi-fragment frames are
 * accumulated in `state` (keyed by stream/track/frame) until every fragment has
 * arrived, tolerating out-of-order delivery. Stale partial frames older than
 * {@link REASSEMBLY_TIMEOUT_MS} are evicted. Returns `null` while a frame is
 * still incomplete or if the payload metadata is malformed.
 */
export function reassembleVideoPayload(
  state: Map<string, VideoReassemblyState>,
  payload: Uint8Array,
  now: number = performance.now(),
): ReassembledVideoFrame | null {
  let metadata: VideoFrameMetadata;
  let chunk: Uint8Array;
  try {
    const decoded = decodeVideoFrameMetadata(payload);
    metadata = decoded.metadata;
    chunk = payload.slice(decoded.payloadOffset);
    if (metadata.fragmentCount === 0 || metadata.fragmentIndex >= metadata.fragmentCount) {
      return null;
    }
  } catch {
    return null;
  }

  if (metadata.fragmentCount === 1) {
    return {
      data: chunk,
      isKeyframe: metadata.isKeyframe,
      streamId: metadata.streamId,
      trackId: metadata.trackId,
      layerId: metadata.layerId,
      timestampUs: metadata.timestampUs,
      codec: codecLabelFromHeader(metadata.codec),
    };
  }

  const key = `${metadata.streamId}:${metadata.trackId}:${metadata.frameId.toString()}`;
  for (const [existingKey, existing] of state) {
    if (now - existing.lastUpdate > REASSEMBLY_TIMEOUT_MS) {
      state.delete(existingKey);
    }
  }

  let entry = state.get(key);
  if (
    !entry ||
    entry.fragmentCount !== metadata.fragmentCount ||
    entry.streamId !== metadata.streamId ||
    entry.trackId !== metadata.trackId
  ) {
    entry = {
      streamId: metadata.streamId,
      trackId: metadata.trackId,
      layerId: metadata.layerId,
      timestampUs: metadata.timestampUs,
      codec: metadata.codec,
      fragmentCount: metadata.fragmentCount,
      isKeyframe: metadata.isKeyframe,
      chunks: Array.from({ length: metadata.fragmentCount }, () => null),
      received: 0,
      lastUpdate: now,
    };
    state.set(key, entry);
  }

  if (!entry.chunks[metadata.fragmentIndex]) {
    entry.chunks[metadata.fragmentIndex] = chunk;
    entry.received += 1;
  }
  entry.lastUpdate = now;
  entry.isKeyframe = metadata.isKeyframe;
  entry.codec = metadata.codec;

  if (entry.received < metadata.fragmentCount) {
    return null;
  }

  const totalLength = entry.chunks.reduce((sum, part) => sum + (part?.byteLength ?? 0), 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of entry.chunks) {
    if (!part) {
      return null;
    }
    combined.set(part, offset);
    offset += part.byteLength;
  }
  state.delete(key);
  return {
    data: combined,
    isKeyframe: entry.isKeyframe,
    streamId: entry.streamId,
    trackId: entry.trackId,
    layerId: entry.layerId,
    timestampUs: entry.timestampUs,
    codec: codecLabelFromHeader(entry.codec),
  };
}

/** What {@link VideoDecodeGate.admit} decided for one arriving frame. */
export interface VideoDecodeGateResult<F> {
  /** Frames to hand to the decoder now, in this order. */
  decode: F[];
  /** The chain cannot continue until a keyframe arrives; ask the publisher for one. */
  needKeyframe: boolean;
}

/** How many deltas of a layer whose keyframe is still in flight are held. */
const VIDEO_GATE_MAX_HELD = 60;

/**
 * Puts one subscription's frames into a single chain a decoder can follow.
 *
 * A decoder is only ever fed a keyframe and then deltas of the SAME simulcast
 * layer that come after it. Two things break that on the wire, and each one
 * throws a WebCodecs decoder into its terminal `closed` state with "Decoding
 * error":
 *
 * - **A layer switch.** The relay flips a viewer to another layer at that
 *   layer's keyframe, but the keyframe rides a reliable unidirectional stream
 *   while the deltas behind it ride datagrams, so the new layer's first deltas
 *   routinely arrive before its keyframe. Fed straight in, a 704x360 delta lands
 *   on a 384x180 picture.
 * - **Late frames.** A delta from before the latest keyframe (a datagram that
 *   lost the race with the stream) references a picture the decoder no longer
 *   holds.
 *
 * So: a keyframe always starts a new chain (it decodes on its own, and a
 * publisher that restarts its clock starts over from one); a delta of the
 * chain's layer is decoded unless it is older than what was already decoded; a
 * newer delta of another layer is held until that layer's keyframe arrives and
 * is then replayed behind it in capture order; everything else is dropped.
 *
 * Every layer of a track is stamped from the same capture clock, which is what
 * makes `timestampUs` comparable across a switch.
 */
export class VideoDecodeGate<
  F extends { isKeyframe: boolean; layerId: number; timestampUs: bigint },
> {
  private layerId: number | null = null;
  private lastTimestampUs = 0n;
  private held: F[] = [];

  /** Forget the chain, e.g. when the decoder behind it was rebuilt. */
  reset(): void {
    this.layerId = null;
    this.lastTimestampUs = 0n;
    this.held = [];
  }

  admit(frame: F): VideoDecodeGateResult<F> {
    if (frame.isKeyframe) {
      const behind = this.held
        .filter(
          (held) =>
            held.layerId === frame.layerId && held.timestampUs > frame.timestampUs,
        )
        .sort((a, b) => (a.timestampUs < b.timestampUs ? -1 : a.timestampUs > b.timestampUs ? 1 : 0));
      this.held = [];
      this.layerId = frame.layerId;
      this.lastTimestampUs =
        behind.length > 0 ? behind[behind.length - 1].timestampUs : frame.timestampUs;
      return { decode: [frame, ...behind], needKeyframe: false };
    }

    if (this.layerId !== null && frame.timestampUs < this.lastTimestampUs) {
      // Older than the picture already decoded: whichever layer it is from,
      // nothing after it in the chain can use it.
      return { decode: [], needKeyframe: false };
    }

    if (this.layerId === frame.layerId) {
      this.lastTimestampUs = frame.timestampUs;
      return { decode: [frame], needKeyframe: false };
    }

    this.held.push(frame);
    if (this.held.length > VIDEO_GATE_MAX_HELD) {
      this.held.shift();
    }
    return { decode: [], needKeyframe: true };
  }
}

/**
 * Pick the simulcast layer to subscribe to for a given viewport. Returns the
 * lowest-id layer whose width or height covers the viewport, falling back to the
 * highest-resolution layer when none is large enough, or `null` for an empty
 * track.
 */
export function selectPublishedLayer(
  track: PublishedTrackDescriptor,
  viewportWidth: number,
  viewportHeight: number,
): PublishedLayerDescriptor | null {
  if (!track.layers.length) {
    return null;
  }
  const sortedLayers = [...track.layers].sort((a, b) => (a.layerId ?? 0) - (b.layerId ?? 0));
  const fittingLayer = sortedLayers.find((layer) => {
    const width = Number(layer.width ?? 0);
    const height = Number(layer.height ?? 0);
    return width >= viewportWidth || height >= viewportHeight;
  });
  return fittingLayer ?? sortedLayers[sortedLayers.length - 1] ?? null;
}

/**
 * Deterministically derive a 32-bit SSRC from a user id and track kind. The
 * same (userId, kind) pair always yields the same non-zero SSRC; distinct pairs
 * effectively never collide (SHA-256 prefix).
 */
export async function deriveTrackSsrc(userId: string, kind: string): Promise<number> {
  const input = new TextEncoder().encode(`paracord-native-ssrc-v1:${kind}:${userId}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  const bytes = new Uint8Array(digest);
  const ssrc = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
  return ssrc === 0 ? 1 : ssrc;
}

/** Extract the `sub` (user id) claim from a media JWT without verifying it. */
export function parseUserIdFromToken(token: string): string | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      sub?: string | number;
    };
    return json.sub != null ? String(json.sub) : null;
  } catch {
    return null;
  }
}

/** Extract the `room` claim from a media JWT without verifying it. */
export function parseRoomIdFromToken(token: string): string | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      room?: string;
    };
    return typeof json.room === 'string' ? json.room : null;
  } catch {
    return null;
  }
}

/**
 * Wrap a raw sender key once per recipient, using the call keys the media
 * control plane published (see `./mediaKeyring`).
 *
 * A recipient whose key is missing or unusable is not silently skipped: media
 * has exactly one path and it is encrypted, so a peer nobody can wrap for is an
 * error the caller surfaces and the call ends. Callers adapt the returned
 * entries to their own on-wire payload shape.
 */
export async function wrapSenderKeyForRecipients(
  scope: string,
  rawKey: Uint8Array,
  epoch: number,
  recipientUserIds: string[],
  keyring: MediaKeyring,
  account?: OperationContext,
): Promise<Array<{ recipientUserId: string; wrapped: Uint8Array }>> {
  if (!account) throw new Error('An owned account context is required for encrypted media.');
  account.assertCurrent();
  const wrappedEntries = await Promise.all(
    recipientUserIds.map(async (recipientUserId) => ({
      recipientUserId,
      wrapped: await keyring.wrapSenderKey(scope, rawKey, epoch, recipientUserId),
    })),
  );
  account.assertCurrent();
  return wrappedEntries;
}
