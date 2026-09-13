import { useEffect, useRef } from 'react';

import { useWindowIsVisible } from '../../hooks/useLights';
import {
  diffOccupancy,
  lightsOnTracker,
  mergeBurst,
  noCrossings,
  occupancyOf,
  type Occupancy,
  type RoomCrossing,
} from '../../lib/attention/light';
import {
  BURST_WINDOW_MS,
  captureArrival,
  facesFor,
  playArrivals,
  playDepartures,
  playLightsOn,
  type FlipCapture,
} from '../../lib/motion';
import { useAuthStore } from '../../stores/authStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';

/**
 * The two moments nobody clicks (docs/lantern-stage-spec.md §5.1).
 *
 * "Say something" belongs to the composer and "walk into a room" belongs to the
 * door you clicked — both have an owner, and WP9a's rule that a gesture starts
 * on the frame of the input holds them together. **Lights on** and **someone
 * arrives** have no owner: they are things the world did, and the surfaces they
 * touch (the sidebar's window map, the Lobby's cards, a room header's strip, a
 * timeline's event line) are in four different subtrees that must not each grow
 * their own copy of the choreography.
 *
 * So they are directed from one place, mounted once inside the app shell:
 *
 *   - **the edge** is decided by pure models in `lib/attention` —
 *     `lightsOnTracker` and `diffOccupancy` — which have no DOM and no React,
 *     so "did this really just happen?" is a thing a unit test can hold;
 *   - **the choreography** is `lib/motion`'s, played over the marks the
 *     components put in the DOM (`marks.ts`);
 *   - **this component renders nothing.** It is a subscription and two effects.
 *
 * The arrival half deliberately subscribes to the voice store rather than
 * reading a hook: a Zustand listener runs **synchronously inside the update**,
 * while the DOM is still the one without the newcomer in it, which is the only
 * moment a FLIP capture of the faces they are about to displace can be taken
 * and the only moment the face of somebody leaving still exists to be ghosted.
 */
export function MotionDirector() {
  useLightsOn();
  useArrivals();
  return null;
}

/* -------------------------------------------------------------------------- */
/* Moment 1 — the building wakes                                               */
/* -------------------------------------------------------------------------- */

function useLightsOn() {
  // The three things the tracker weighs. Subscribing to `presences` by size
  // keeps this out of the re-render path of every presence tick.
  const presenceCount = usePresenceStore((state) => state.presences.size);
  const connected = useUIStore((state) => state.connectionStatus) === 'connected';
  const visible = useWindowIsVisible();
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const reason = lightsOnTracker.observe({
      presenceResolved: presenceCount > 0,
      connected,
      visible,
      nowMs: Date.now(),
    });
    if (!reason) return;
    // One frame, so the windows this render lit are in the document before the
    // sweep looks for them. Never more than one: the moment belongs to the
    // frame presence landed on, and a second frame is a stutter the eye reads
    // as the app hesitating.
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      playLightsOn();
    });
  }, [connected, presenceCount, visible]);

  useEffect(
    () => () => {
      if (frame.current != null) cancelAnimationFrame(frame.current);
    },
    [],
  );
}

/* -------------------------------------------------------------------------- */
/* Moment 3 — someone arrives, someone leaves                                  */
/* -------------------------------------------------------------------------- */

interface Burst {
  arrivals: RoomCrossing[];
  startedAtMs: number;
  /** How many arrivals the sequence has already staggered. */
  played: number;
  flip: FlipCapture | null;
}

function useArrivals() {
  useEffect(() => {
    let previous: Occupancy | null = null;
    let baseline = true;
    let burst: Burst | null = null;
    let frame: number | null = null;

    const flush = () => {
      frame = null;
      const pending = burst;
      if (!pending) return;
      const fresh = pending.arrivals.slice(pending.played);
      if (fresh.length === 0) return;
      pending.played = pending.arrivals.length;
      playArrivals(fresh, { flip: pending.flip, startIndex: pending.played - fresh.length });
      pending.flip = null;
    };

    const unsubscribe = useVoiceStore.subscribe((state) => {
      const next = occupancyOf(state.channelParticipants);
      const selfUserId = useAuthStore.getState().user?.id ?? null;
      const delta = diffOccupancy(previous, next, { selfUserId, baseline });
      previous = next;
      baseline = false;
      if (noCrossings(delta)) return;

      // Everything below happens while the DOM is still the old one.
      const flip = captureArrival();

      if (delta.departures.length > 0) {
        // The mirror runs now, not next frame: the faces it animates are about
        // to be taken out of the tree by the render this update causes, and a
        // ghost has to be cut from something that is still there.
        playDepartures(delta.departures, { ghosts: facesFor(delta.departures) });
      }

      if (delta.arrivals.length > 0) {
        const now = Date.now();
        // Five people arriving in the same beat is ONE thing happening (§5.1).
        // Anybody inside the burst window joins the sequence already running,
        // staggered behind whoever is in it, rather than starting a second one.
        if (burst && now - burst.startedAtMs <= BURST_WINDOW_MS) {
          burst.arrivals = mergeBurst(burst.arrivals, delta.arrivals);
          burst.flip = burst.flip ?? flip;
        } else {
          burst = { arrivals: [...delta.arrivals], startedAtMs: now, played: 0, flip };
        }
        if (frame == null) frame = requestAnimationFrame(flush);
      } else {
        // A departure closes the gap it left on the same curve.
        if (frame == null) {
          frame = requestAnimationFrame(() => {
            frame = null;
            flip.play();
          });
        }
      }
    });

    return () => {
      unsubscribe();
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, []);
}
