/**
 * When the lights come on (docs/lantern-stage-spec.md §5.1, §5.3).
 *
 * §5.3's last line is the hard one: *"never animate on first paint what the
 * user did not cause or presence did not cause"*. A building waking up is the
 * most conspicuous motion in the product, so the question "did the lights
 * actually just come on?" has to be answered somewhere that a re-render, a
 * route change or a memo recomputation cannot reach.
 *
 * This is that place: a small state machine, pure and injectable, with no
 * store, React, DOM or ambient clock. `observe()` returns a reason the FIRST
 * time each real transition happens and `null` every other time it is called —
 * including every time it is called with exactly the state it was already in.
 *
 * Three transitions count, and nothing else does:
 *
 *   `first`     presence resolved for the first time since the app opened.
 *               Not "the component mounted": mounting with presence already in
 *               hand is the return of a route, not the lights coming on.
 *   `reconnect` the gateway came back after being away. The whole picture is
 *               re-delivered, and the building really is lighting up again.
 *   `return`    the window came back after being hidden longer than the grace
 *               period. A glance at another app is not a return; going away for
 *               an afternoon is.
 */

/** How long the window has to have been away for coming back to be a return. */
export const RETURN_AFTER_HIDDEN_MS = 5 * 60_000;

export type LightsOnReason = 'first' | 'reconnect' | 'return';

/** What the world looks like right now. */
export interface LightsOnObservation {
  /** Presence has actually resolved — we know who has their lights on. */
  presenceResolved: boolean;
  /** The gateway is connected. */
  connected: boolean;
  /** The window is being looked at. */
  visible: boolean;
  nowMs: number;
}

export interface LightsOnTracker {
  /** The reason the lights just came on, or null — which is the usual answer. */
  observe: (observation: LightsOnObservation) => LightsOnReason | null;
  /** Forget everything. Called with the rest of the session on logout. */
  reset: () => void;
}

interface TrackerState {
  /** Have we ever seen presence resolve in this run? */
  everResolved: boolean;
  /** Was the gateway connected the last time we looked? */
  wasConnected: boolean;
  /** Was the window visible the last time we looked? */
  wasVisible: boolean;
  /** When the window went away, or null while it is here. */
  hiddenSinceMs: number | null;
  /** A gateway that came back but has not re-delivered presence yet. */
  awaitingReconnect: boolean;
  /** A window that came back after a long absence, same. */
  awaitingReturn: boolean;
}

function initial(): TrackerState {
  return {
    everResolved: false,
    wasConnected: false,
    wasVisible: true,
    hiddenSinceMs: null,
    awaitingReconnect: false,
    awaitingReturn: false,
  };
}

/**
 * Build a tracker.
 *
 * The two "awaiting" flags are the whole subtlety. A reconnect and a return are
 * both *promises* that a fresh picture is coming, not the picture itself — the
 * gateway reconnects a beat before it re-delivers presence. Firing on the
 * promise would light the building up over the stale data that is still on
 * screen. So the transition is armed, and it fires on the next observation that
 * has presence in hand, which is when there is actually something to light.
 */
export function createLightsOnTracker(returnAfterMs = RETURN_AFTER_HIDDEN_MS): LightsOnTracker {
  let state = initial();

  return {
    observe({ presenceResolved, connected, visible, nowMs }) {
      let reason: LightsOnReason | null = null;

      // The gateway coming back arms a reconnect — but only if we had already
      // been connected once. The first connection of a run is `first`, not a
      // reconnect, and calling it one would play the sequence twice.
      if (connected && !state.wasConnected && state.everResolved) {
        state.awaitingReconnect = true;
      }
      state.wasConnected = connected;

      // The window leaving starts the clock; coming back stops it and arms a
      // return if it ran long enough.
      if (!visible && state.wasVisible) {
        state.hiddenSinceMs = nowMs;
      } else if (visible && !state.wasVisible) {
        const away = state.hiddenSinceMs == null ? 0 : nowMs - state.hiddenSinceMs;
        state.hiddenSinceMs = null;
        if (away >= returnAfterMs && state.everResolved) state.awaitingReturn = true;
      }
      state.wasVisible = visible;

      if (!presenceResolved) {
        // Presence going away does not un-happen the first one: a building that
        // empties is not a building that was never lit.
        return null;
      }

      if (!state.everResolved) {
        state.everResolved = true;
        // A run that opened with everything already in hand still counts once:
        // this IS the app opening, which is what the moment is for.
        reason = 'first';
        state.awaitingReconnect = false;
        state.awaitingReturn = false;
      } else if (state.awaitingReconnect) {
        reason = 'reconnect';
        state.awaitingReconnect = false;
        state.awaitingReturn = false;
      } else if (state.awaitingReturn) {
        reason = 'return';
        state.awaitingReturn = false;
      }

      return reason;
    },
    reset() {
      state = initial();
    },
  };
}

/**
 * The process-wide tracker, so the sidebar, the Lobby and Home cannot disagree
 * about whether the lights just came on. One building waking up is one event.
 */
export const lightsOnTracker = createLightsOnTracker();
