// Pure helpers shared by the browser (WebTransport) and Tauri (native IPC)
// media engines. These functions carry no engine instance state so they can be
// unit-tested in isolation and reused verbatim by both implementations.

import type { OperationContext } from '../operationContext';
import type { PublishedLayerDescriptor, PublishedTrackDescriptor } from './mediaEngine';
import { decodeVideoFrameMetadata, type VideoFrameMetadata } from './transport/protocol';
import { UnopenableMediaKeyError, type MediaKeyring } from './mediaKeyring';

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
 * Extract the `view` claim from a media JWT without verifying it: `watch` or
 * `ambient` for a view-session token (G5), null for a call token. The relay
 * admits a token with this claim only as a view session, so an engine that
 * connects it must behave as one.
 */
export function parseViewKindFromToken(token: string): 'watch' | 'ambient' | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      view?: unknown;
    };
    return json.view === 'watch' || json.view === 'ambient' ? json.view : null;
  } catch {
    return null;
  }
}

/**
 * Why the relay closed a media connection
 * (`paracord_transport::control::MediaCloseReason`). A raw QUIC client reads it
 * from the connection close; a browser from the `CLOSE_WEBTRANSPORT_SESSION`
 * capsule (`WebTransport.closed` resolves with its code and words).
 */
export type RelayCloseReason = 'superseded' | 'ended' | 'revoked';

/** The relay's close codes, as `MediaCloseReason::code` writes them. */
const RELAY_CLOSE_CODES: Record<number, RelayCloseReason> = {
  4001: 'superseded',
  4002: 'ended',
  4003: 'revoked',
};

/** The relay's close words, as `MediaCloseReason::reason` writes them. */
const RELAY_CLOSE_WORDS: Array<[string, RelayCloseReason]> = [
  ['superseded by a newer media connection', 'superseded'],
  ['view session ended', 'ended'],
  ['media access revoked', 'revoked'],
];

/** The relay's own words for one of its close reasons. */
export function relayCloseText(reason: RelayCloseReason): string {
  return RELAY_CLOSE_WORDS.find(([, parsed]) => parsed === reason)![0];
}

/**
 * Which of the relay's close reasons a close names, from its code when there
 * is one and otherwise from its words; null for any other close (a network
 * drop, the client's own disconnect). Never inferred from anything else.
 */
export function parseRelayCloseReason(reason: string, closeCode?: number | null): RelayCloseReason | null {
  if (typeof closeCode === 'number' && RELAY_CLOSE_CODES[closeCode]) return RELAY_CLOSE_CODES[closeCode];
  const text = reason.toLowerCase();
  for (const [words, parsed] of RELAY_CLOSE_WORDS) {
    if (text.includes(words)) return parsed;
  }
  return null;
}

/**
 * Whether the relay closed a view session's connection for good: a newer view
 * of the same account replaced it, the view ended (stopped, retired after its
 * connect deadline, or carried over into a call), or its viewer may no longer
 * see the channel. None may be dialed back: the first would take the slot back
 * from the view that replaced it, the others are refused at admission. See
 * docs/design/glass-g5-checkpoint.md and glass-g6b-checkpoint.md.
 */
export function isTerminalViewCloseReason(reason: string): boolean {
  return parseRelayCloseReason(reason) !== null;
}

/**
 * What a relay roster entry is (`paracord_transport::control::SessionParticipantKind`):
 * somebody in the call, or a view session watching one stream without joining.
 */
export type RosterKind = 'member' | 'viewer';

/**
 * Read a roster entry's `kind`. A relay without view sessions sends none, and
 * every entry it sends is a member. Anything else is not a kind this client
 * knows, and null tells the caller to refuse the entry rather than guess: a
 * member is owed the voice key, so an unknown entry must never be taken for one.
 */
export function readRosterKind(raw: unknown): RosterKind | null {
  if (raw === undefined || raw === null) return 'member';
  return raw === 'member' || raw === 'viewer' ? raw : null;
}

/**
 * Whether a published track belongs to a stream a view session may receive: a
 * screen share (`stream:<publisher>:screen`), whose video and own audio a watch
 * gets. Mirrors the relay's `ViewTarget::allows`. A camera, and the voice,
 * never reach a viewer.
 */
export function isViewableStream(streamId: string): boolean {
  return streamId.endsWith(':screen');
}

/**
 * Who one of this publisher's keys may be wrapped to.
 *
 * - The voice key: call members only. A viewer never holds it.
 * - A track key: call members, plus the viewers when the track is on a
 *   viewable stream (the relay also refuses to deliver any other key to a
 *   viewer; the publisher does not rely on that).
 */
export function keyRecipients(
  key: { kind: 'voice' } | { kind: 'track'; streamId: string },
  recipientUserIds: Iterable<string>,
  isViewer: (userId: string) => boolean,
): string[] {
  const viewersAllowed = key.kind === 'track' && isViewableStream(key.streamId);
  return Array.from(recipientUserIds).filter((userId) => viewersAllowed || !isViewer(userId));
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

/** Whether two publishes of a track describe the same codec and layers. */
export function samePublishedTrack(a: PublishedTrackDescriptor, b: PublishedTrackDescriptor): boolean {
  if ((a.codec ?? null) !== (b.codec ?? null) || a.layers.length !== b.layers.length) return false;
  return a.layers.every((layer, index) => {
    const other = b.layers[index];
    return layer.layerId === other.layerId && layer.ssrc === other.ssrc && layer.active === other.active
      && (layer.width ?? null) === (other.width ?? null) && (layer.height ?? null) === (other.height ?? null)
      && (layer.maxBitrateKbps ?? null) === (other.maxBitrateKbps ?? null);
  });
}


/**
 * How long a stream key this device could not open may wait for one it can.
 * See {@link TrackKeyGrace}.
 */
export const STALE_TRACK_KEY_GRACE_MS = 8_000;

/**
 * Stream keys that arrived sealed to a call key this device no longer holds.
 *
 * A relay from before 2026-09-29 (Paracord 3.3 and older) pushes the stream
 * keys it stored for an account the moment that account connects, before its
 * `session_join` has published the new call key: a rejoiner is handed keys
 * sealed to the call key it held last time, which it cannot open. Every
 * publisher then wraps a fresh key to the new call key on the rejoiner's
 * arrival (a member arriving rotates every key), and that one opens. So an
 * unopenable stream key ends the call only when no key for that track that
 * this device can open follows within {@link STALE_TRACK_KEY_GRACE_MS}: still
 * loud, never silent, but a rejoin into a running call on an older server
 * works. A current relay sends stored keys only after the join, having dropped
 * the stale ones, so there this never waits. Only stream keys are covered: an
 * unopenable voice key still ends the call at once.
 */
export class TrackKeyGrace {
  private readonly waiting = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly fail: (error: unknown) => void, private readonly graceMs = STALE_TRACK_KEY_GRACE_MS) {}

  /** A stream key for `track` was refused; anything but a stale seal fails now. */
  refused(track: string, error: unknown): void {
    if (!(error instanceof UnopenableMediaKeyError)) {
      this.fail(error);
      return;
    }
    if (this.waiting.has(track)) return;
    this.waiting.set(track, setTimeout(() => {
      this.waiting.delete(track);
      this.fail(error);
    }, this.graceMs));
  }

  /** A key for `track` opened: whatever was refused before it is moot. */
  opened(track: string): void {
    const timer = this.waiting.get(track);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.waiting.delete(track);
  }

  dispose(): void {
    for (const timer of this.waiting.values()) clearTimeout(timer);
    this.waiting.clear();
  }
}

/**
 * The native side's `media_decrypt_failing`: packets of one SSRC keep failing
 * to open (stream-fix-v2). `keyProblem` is true when a key would cure it (none
 * installed for the packets' epoch, or a stale one), false for replays and
 * malformed packets. `streamId`/`trackId` name the video track when the native
 * side knows it; an audio SSRC is found by {@link publishedTrackForSsrc}.
 */
export interface DecryptFailing {
  ssrc: number;
  epoch: number;
  reason: string;
  keyProblem: boolean;
  streamId: string | null;
  trackId: string | null;
  consecutiveFailures: number;
}

/** Read a `media_decrypt_failing` payload; null for anything malformed. */
export function readDecryptFailing(raw: unknown): DecryptFailing | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.ssrc !== 'number' || !Number.isInteger(value.ssrc)) return null;
  const text = (key: string) => (typeof value[key] === 'string' && value[key] ? (value[key] as string) : null);
  return {
    ssrc: value.ssrc,
    epoch: typeof value.epoch === 'number' ? value.epoch : 0,
    reason: text('reason') ?? 'unknown',
    keyProblem: value.keyProblem === true,
    streamId: text('streamId'),
    trackId: text('trackId'),
    consecutiveFailures: typeof value.consecutiveFailures === 'number' ? value.consecutiveFailures : 0,
  };
}

/** The published track one of whose layers is `ssrc`, if any. */
export function publishedTrackForSsrc(
  tracks: Iterable<PublishedTrackDescriptor>,
  ssrc: number,
): PublishedTrackDescriptor | null {
  for (const track of tracks) {
    if (track.layers.some((layer) => layer.ssrc === ssrc)) return track;
  }
  return null;
}
