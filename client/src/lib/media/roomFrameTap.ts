/**
 * A read-only tap on the media pipeline for room thumbnails
 * (docs/lantern-stage-spec.md §5 "Live thumbnail", §8 RoomThumbnail).
 *
 * The spec asks for real frames at **≤ 2 fps** for a room's screen share or
 * focused camera, and a still plus the LIVE dot whenever that is not possible.
 * This module is the whole of that contract. It **adds nothing to the delivery
 * path**: it calls the existing public `MediaEngine.subscribeVideo` with its own
 * offscreen canvas, samples that canvas on a timer, and never touches the
 * decoder, the transport, the relay, or the tile the Stage renders.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS LIVE AND WHAT IS A STILL — the honest table
 * ---------------------------------------------------------------------------
 * | Situation                                       | Thumbnail | Reason |
 * |-------------------------------------------------|-----------|--------|
 * | Room you are **in**, publisher's frames land in a DOM canvas | **live ≤ 2 fps** | — |
 * | Room you are in, platform composites **below** the webview (Linux GTK underlay) | still + LIVE | `native-surface` |
 * | Room you are in, nobody is publishing video      | still     | `no-publisher` |
 * | Room you are **not** in                          | still + LIVE | `not-joined` |
 * | No call at all                                   | still     | `no-engine` |
 *
 * The two "still + LIVE" rows are not a degraded video path — they are the
 * absence of one. A room you have not joined has **no decoder running** for it
 * anywhere on this device; frames for it do not exist to be sampled, and
 * fabricating a subscription to make a thumbnail move would be a second media
 * session opened behind the user's back. On the Linux underlay the frames exist
 * but are composited by GTK *below* the webview, so the DOM canvas is a
 * transparent hole with nothing to read back. In both cases the model says so
 * (`RoomThumbnailState.reason`) and the component draws the still and the LIVE
 * dot rather than pretending. There is no silent fallback here: every
 * non-live state is named.
 */

import type { MediaEngine, MediaStreamCapabilities } from './mediaEngine';
import type { RoomThumbnailState, ThumbnailStillReason } from '../attention/lightModel';

/** §5: real frames at **≤ 2 fps**. This is a ceiling, never a target. */
export const MAX_THUMBNAIL_FPS = 2;
const MIN_INTERVAL_MS = 1000 / MAX_THUMBNAIL_FPS;

/** Which publisher in which room the thumbnail wants. */
export interface RoomFrameRequest {
  /** `entityScopeKey(scope, channelId)` — the room's key, as `RoomLight.key`. */
  roomKey: string;
  /** The publisher to sample: the screen sharer, or the focused camera. */
  userId: string | null;
  track: 'screen' | 'camera';
}

/** One sampled still. The caller owns the bitmap and must `close()` it. */
export interface RoomFrame {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  capturedAt: number;
}

/** The joined call, as the tap needs to see it. */
export interface JoinedRoomView {
  roomKey: string;
  engine: MediaEngine;
  capabilities: MediaStreamCapabilities | null;
}

export interface RoomFrameTapDeps {
  /** The room the local account is in right now, or null when idle. */
  resolveJoinedRoom: () => JoinedRoomView | null;
  /** Offscreen canvas factory — injected so the tap is testable in jsdom. */
  createCanvas: () => HTMLCanvasElement;
  /** Snapshot the canvas. Returns null when the canvas has no pixels yet. */
  captureFrame: (canvas: HTMLCanvasElement) => Promise<RoomFrame | null>;
  now: () => number;
}

export interface RoomFrameTap {
  /** What this room's thumbnail can show right now, without subscribing. */
  status: (request: RoomFrameRequest, label: string) => RoomThumbnailState;
  /**
   * Start sampling. Returns an unsubscribe function; calling it releases the
   * engine subscription and stops every pending capture. When the room cannot
   * produce live frames nothing is subscribed and the returned function is a
   * no-op — `status` already said why.
   */
  subscribe: (
    request: RoomFrameRequest,
    onFrame: (frame: RoomFrame) => void,
    fps?: number,
  ) => () => void;
}

/** Why this room cannot be sampled, or null when it can. */
export function stillReasonFor(
  request: RoomFrameRequest,
  joined: JoinedRoomView | null,
): ThumbnailStillReason | null {
  if (!joined) return 'no-engine';
  if (joined.roomKey !== request.roomKey) return 'not-joined';
  // Linux GTK underlay: the surface composites BELOW the webview, so the DOM
  // canvas is a deliberate transparent hole. There are no pixels to read back.
  if (joined.capabilities?.nativeRenderUnderlay) return 'native-surface';
  if (!request.userId) return 'no-publisher';
  return null;
}

/** Create a tap over the injected view of the media layer. */
export function createRoomFrameTap(deps: RoomFrameTapDeps): RoomFrameTap {
  function status(request: RoomFrameRequest, label: string): RoomThumbnailState {
    const reason = stillReasonFor(request, deps.resolveJoinedRoom());
    return { live: reason === null, reason, label };
  }

  function subscribe(
    request: RoomFrameRequest,
    onFrame: (frame: RoomFrame) => void,
    fps = MAX_THUMBNAIL_FPS,
  ): () => void {
    const joined = deps.resolveJoinedRoom();
    if (stillReasonFor(request, joined) !== null || !joined || !request.userId) return () => {};

    const interval = Math.max(MIN_INTERVAL_MS, 1000 / Math.max(0.1, Math.min(fps, MAX_THUMBNAIL_FPS)));
    const canvas = deps.createCanvas();
    let stopped = false;
    let capturing = false;
    let lastAt = -Infinity;

    const sample = () => {
      if (stopped || capturing) return;
      const at = deps.now();
      if (at - lastAt < interval) return;
      lastAt = at;
      capturing = true;
      void deps
        .captureFrame(canvas)
        .then((frame) => {
          // A frame that lands after unsubscribe is dropped, not delivered —
          // otherwise a closed thumbnail leaks a bitmap into a dead component.
          if (stopped || !frame) {
            frame?.bitmap.close();
            return;
          }
          onFrame(frame);
        })
        .catch(() => {
          /* a dropped sample is a dropped sample; the still stays on screen */
        })
        .finally(() => {
          capturing = false;
        });
    };

    const release = joined.engine.subscribeVideo(request.userId, canvas, sample, {
      preferredTrackId: request.track,
    });

    return () => {
      stopped = true;
      release();
    };
  }

  return { status, subscribe };
}

/** The default canvas snapshot: `createImageBitmap` on the live canvas. */
export async function captureCanvasFrame(canvas: HTMLCanvasElement): Promise<RoomFrame | null> {
  if (!canvas.width || !canvas.height) return null;
  if (typeof createImageBitmap !== 'function') return null;
  const bitmap = await createImageBitmap(canvas);
  return { bitmap, width: bitmap.width, height: bitmap.height, capturedAt: Date.now() };
}
