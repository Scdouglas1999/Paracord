/**
 * Wire a room's thumbnail to the media pipeline
 * (docs/lantern-stage-spec.md §5, §8 RoomThumbnail).
 *
 * The rules and the honest live/still table live in
 * `src/lib/media/roomFrameTap.ts`; this hook only resolves "which room am I
 * actually in, on which engine" from `voiceStore` and hands the tap over.
 *
 * It **adds nothing to the delivery path**. It opens no session, changes no
 * subscription the Stage depends on, and never touches the decoder, transport
 * or relay: it calls the engine's existing `subscribeVideo` with its own
 * offscreen canvas and samples at the tap's ≤ 2 fps ceiling.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { useVoiceStore } from '../stores/voiceStore';
import { entityScopeKey } from '../lib/serverScope';
import type { RoomLight, RoomThumbnailState } from '../lib/attention/light';
import type { MediaStreamCapabilities } from '../lib/media/mediaEngine';
import {
  captureCanvasFrame,
  createRoomFrameTap,
  type JoinedRoomView,
  type RoomFrame,
} from '../lib/media/roomFrameTap';

export interface RoomThumbnailFeed {
  /** What this room's thumbnail can show — `live`, or why it cannot be. */
  state: RoomThumbnailState;
  /** The newest sampled frame, or null when the thumbnail is a still. */
  frame: RoomFrame | null;
}

export function useRoomThumbnail(room: RoomLight | null): RoomThumbnailFeed {
  const engine = useVoiceStore((state) => state.mediaEngine);
  const callChannelId = useVoiceStore((state) => state.channelId);
  const callScope = useVoiceStore((state) => state.callScope);
  const connected = useVoiceStore((state) => state.connected);
  const [capabilities, setCapabilities] = useState<MediaStreamCapabilities | null>(null);
  const [frame, setFrame] = useState<RoomFrame | null>(null);
  const latest = useRef<RoomFrame | null>(null);

  // The engine's capabilities decide whether DOM frames exist at all (a Linux
  // GTK underlay composites below the webview). Read once per engine.
  useEffect(() => {
    if (!engine) {
      setCapabilities(null);
      return;
    }
    let canceled = false;
    void engine
      .getStreamCapabilities()
      .then((caps) => {
        if (!canceled) setCapabilities(caps);
      })
      .catch(() => {
        if (!canceled) setCapabilities(null);
      });
    return () => {
      canceled = true;
    };
  }, [engine]);

  const joinedKey =
    callScope && callChannelId ? entityScopeKey(callScope, callChannelId) : null;

  const tap = useMemo(() => {
    // No view until the engine has reported its capabilities: whether DOM
    // frames exist at all is one of them, and subscribing before the answer
    // arrives would open a subscription only to drop it a tick later.
    const joined: JoinedRoomView | null =
      engine && joinedKey && connected && capabilities
        ? { roomKey: joinedKey, engine, capabilities }
        : null;
    return createRoomFrameTap({
      resolveJoinedRoom: () => joined,
      createCanvas: () => document.createElement('canvas'),
      captureFrame: captureCanvasFrame,
      now: () => Date.now(),
    });
  }, [engine, joinedKey, connected, capabilities]);

  const publisher = room?.screenSharer ?? room?.cameraSharer ?? null;
  const track: 'screen' | 'camera' = room?.screenSharer ? 'screen' : 'camera';
  // Keyed on the three PRIMITIVES the request is made of, never on the
  // `RoomLight` it was read from.
  //
  // A `RoomLight` is rebuilt from scratch every time any light input moves —
  // the 1 Hz call clock, a speaking change, a presence tick — so keying this
  // memo on the object handed it a new `request` several times a second, the
  // subscribe effect below re-ran on every one, and each re-run released the
  // engine subscription and opened another. Measured on a real two-party call
  // with a camera and a screen share: 812 `VideoDecoder`s and 812 WebGL
  // contexts built and thrown away in 90 seconds, per browser, ~9 per second,
  // for a thumbnail that is allowed two frames a second.
  const roomKey = room?.key ?? null;
  const publisherUserId = publisher?.person.userId ?? null;
  const request = useMemo(
    () => (roomKey ? { roomKey, userId: publisherUserId, track } : null),
    [roomKey, publisherUserId, track],
  );

  const state = useMemo(
    () => (room && request ? tap.status(request, room.thumbnail.label) : null),
    [tap, request, room],
  );

  useEffect(() => {
    if (!request || !state?.live) {
      setFrame(null);
      return;
    }
    const release = tap.subscribe(request, (next) => {
      // Exactly one bitmap is held at a time; the previous one is closed the
      // moment it is replaced, so a 2 fps feed cannot accumulate frames.
      latest.current?.bitmap.close();
      latest.current = next;
      setFrame(next);
    });
    return () => {
      release();
      latest.current?.bitmap.close();
      latest.current = null;
      setFrame(null);
    };
  }, [tap, request, state?.live]);

  return {
    state: state ?? { live: false, reason: 'no-engine', label: room?.thumbnail.label ?? '' },
    frame,
  };
}
