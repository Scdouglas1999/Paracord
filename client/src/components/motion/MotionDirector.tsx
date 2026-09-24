import { useEffect, useRef } from 'react';

import { useWindowIsVisible } from '../../hooks/useLights';
import {
  diffOccupancy,
  lightsOnTracker,
  mergeBurst,
  noCrossings,
  occupancyOf,
  OUTAGE_GRACE_MS,
  outageTracker,
  type Occupancy,
  type RoomCrossing,
} from '../../lib/attention/light';
import {
  BURST_WINDOW_MS,
  captureArrival,
  dimBuilding,
  facesFor,
  playArrivals,
  playDepartures,
  playLightsOn,
  playRelight,
  relightBuilding,
  takeDimmedPlates,
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
  useConnection();
  return null;
}

/* -------------------------------------------------------------------------- */
/* Moment 1 — the building wakes                                               */
/* -------------------------------------------------------------------------- */

/**
 * Presence arrives in a breath, not an instant.
 *
 * The gateway's READY sets the local account's own light before it has said a
 * word about anybody else, and the building's channels, members and voice
 * states follow over the next couple of hundred milliseconds. Sweeping on the
 * first of those would wake a building that has not finished arriving: the
 * plates would settle over a street with no windows lit in it, and every window
 * that lit a beat later would look like somebody walking in.
 *
 * So the edge arms the moment and this is how long it waits for the rest of the
 * picture. It is not part of the animation and not inside §5.3's 1.6s — nothing
 * is moving while it runs.
 */
const GATHER_MS = 250;

function useLightsOn() {
  // The three things the tracker weighs. Subscribing to `presences` by size
  // keeps this out of the re-render path of every presence tick.
  const presenceCount = usePresenceStore((state) => state.presences.size);
  const connected = useUIStore((state) => state.connectionStatus) === 'connected';
  const visible = useWindowIsVisible();
  const pending = useRef<number | null>(null);

  useEffect(() => {
    const reason = lightsOnTracker.observe({
      presenceResolved: presenceCount > 0,
      connected,
      visible,
      nowMs: Date.now(),
    });
    if (!reason) return;
    if (pending.current != null) clearTimeout(pending.current);
    pending.current = window.setTimeout(() => {
      pending.current = null;
      // One frame on top, so whatever the gather brought in is in the document
      // before the sweep looks for it.
      requestAnimationFrame(() => {
        // WP9d: a gateway that was away long enough to take the building's
        // lights down relights exactly the plates that went dark, and they do
        // not travel — a plate rises when it ENTERS the street, and these never
        // left it. Anything else (the app opening, a return from an afternoon
        // away) is the street arriving, which is the whole of WP9b's moment.
        const dark = reason === 'reconnect' ? takeDimmedPlates() : [];
        if (dark.length > 0) playRelight({ plates: dark });
        else playLightsOn();
      });
    }, GATHER_MS);
  }, [connected, presenceCount, visible]);

  useEffect(
    () => () => {
      if (pending.current != null) clearTimeout(pending.current);
    },
    [],
  );
}

/* -------------------------------------------------------------------------- */
/* Moment 4 — the power goes, and comes back (WP9d)                            */
/* -------------------------------------------------------------------------- */

/**
 * The gateway being away is the one piece of app state that is about the whole
 * building rather than anything in it, so it is drawn on the whole building:
 * the lights go down 30% and stay down until it is back. **Never a spinner on
 * the street** — a spinner says "wait"; a building with its power out says what
 * is actually true, which is that nothing on screen is answerable for right now
 * and you can keep reading it.
 *
 * The edge is `lib/attention/outage.ts`, and the grace it enforces is the whole
 * point: a gateway blips several times an hour, and a building that dims and
 * undims for 80 ms is the flashing blocker WP9a spent a commit removing.
 *
 * The relight is deliberately NOT played here. A gateway coming back is already
 * §5.1's second "lights on" trigger, and `useLightsOn` above waits for presence
 * to actually be re-delivered before it sweeps — so this half lifts the scrim
 * and lets that moment be the moment. What it does own is the SCOPE: the plates
 * that were under the scrim are the ones with any lights to turn on.
 */
function useConnection() {
  const status = useUIStore((state) => state.connectionStatus);

  useEffect(() => {
    let canceled = false;
    let timer: number | null = null;

    const look = () => {
      if (canceled) return;
      const edge = outageTracker.observe({ connected: status === 'connected', nowMs: Date.now() });
      if (edge === 'dim') dimBuilding();
      else if (edge === 'relight') void relightBuilding();
    };

    look();
    // The grace has to be re-observed on a clock as well as on a change: the
    // interesting answer is "it is STILL away", and nothing else will ask.
    if (status !== 'connected') timer = window.setTimeout(look, OUTAGE_GRACE_MS + 20);

    return () => {
      canceled = true;
      if (timer != null) clearTimeout(timer);
    };
  }, [status]);
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
    // The world as it is the moment this starts watching — not "whatever the
    // next update happens to carry". The app shell is a lazy route, so the
    // gateway's READY usually lands before this effect ever runs; treating the
    // first update it sees as the baseline swallowed the first real arrival
    // after it, which is how the gate found this.
    const start = useVoiceStore.getState();
    let previous: Occupancy | null = occupancyOf(start.channelParticipants);
    let snapshotSeq = start.voiceSnapshotSeq;
    let baseline = false;
    let baselineUserId = useAuthStore.getState().user?.id ?? null;
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
      // Two things re-baseline, and both are the picture arriving rather than
      // people moving (§5.3): a gateway snapshot replacing a whole guild's
      // membership, and the account underneath changing.
      if (state.voiceSnapshotSeq !== snapshotSeq) {
        snapshotSeq = state.voiceSnapshotSeq;
        baseline = true;
      }
      if (selfUserId !== baselineUserId) {
        baselineUserId = selfUserId;
        baseline = true;
      }
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
