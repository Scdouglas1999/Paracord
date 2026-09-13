/**
 * When the power goes, and when it comes back (docs/lantern-stage-spec.md §5.1,
 * WP9d).
 *
 * The same shape as `lightsOn.ts`, and for the same reason: "did the gateway
 * actually go away?" has to be answerable somewhere a re-render, a route change
 * or a memo recomputation cannot reach. Pure, injectable, no store, React, DOM
 * or ambient clock.
 *
 * Two things make an outage worth dimming a whole building for, and they are
 * both about not lying:
 *
 *   **It has to have been up first.** A connection that has never been made is
 *   the app starting, not the power going; the building is not lit yet, so
 *   there is nothing to dim.
 *   **It has to still be down a beat later.** A gateway blips — a token
 *   refresh, a laptop lid, a Wi-Fi handover — several times an hour, and a
 *   building that dims and undims for 80ms is exactly the flashing blocker WP9a
 *   spent a commit removing. The grace is the whole difference between "we lost
 *   the server" and "a packet was late".
 */

/** How long the gateway has to stay away before the lights go down. */
export const OUTAGE_GRACE_MS = 600;

export type OutageEdge = 'dim' | 'relight';

export interface OutageObservation {
  /** The gateway has a live stream to at least one server. */
  connected: boolean;
  nowMs: number;
}

export interface OutageTracker {
  /**
   * The edge that just happened, or null — which is the usual answer.
   *
   * `dim` is only returned once the gateway has been away for the whole grace,
   * so a caller must re-observe on a timer as well as on a status change; the
   * answer is deliberately not "it will be an outage in 600ms", because by then
   * it usually is not.
   */
  observe: (observation: OutageObservation) => OutageEdge | null;
  /** How long the gateway has been away, or null while it is here. */
  awayForMs: (nowMs: number) => number | null;
  reset: () => void;
}

interface State {
  everConnected: boolean;
  wasConnected: boolean;
  /** When the gateway went away, or null while it is here. */
  awaySinceMs: number | null;
  /** The lights are down right now. */
  dark: boolean;
}

function initial(): State {
  return { everConnected: false, wasConnected: true, awaySinceMs: null, dark: false };
}

export function createOutageTracker(graceMs = OUTAGE_GRACE_MS): OutageTracker {
  let state = initial();

  return {
    observe({ connected, nowMs }) {
      if (connected) {
        state.everConnected = true;
        state.wasConnected = true;
        state.awaySinceMs = null;
        if (state.dark) {
          state.dark = false;
          return 'relight';
        }
        return null;
      }

      if (state.wasConnected) {
        state.wasConnected = false;
        state.awaySinceMs = nowMs;
      }
      // The app has not been up yet: this is a first connection that has not
      // happened, not a building whose power went.
      if (!state.everConnected || state.dark) return null;
      const away = state.awaySinceMs == null ? 0 : nowMs - state.awaySinceMs;
      if (away < graceMs) return null;
      state.dark = true;
      return 'dim';
    },
    awayForMs(nowMs) {
      if (state.awaySinceMs == null) return null;
      return Math.max(0, nowMs - state.awaySinceMs);
    },
    reset() {
      state = initial();
    },
  };
}

/**
 * The process-wide tracker. One building losing its power is one event, and the
 * sidebar, the Lobby and the Stage cannot be allowed to disagree about it.
 */
export const outageTracker = createOutageTracker();
