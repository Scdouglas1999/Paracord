import { useSyncExternalStore } from 'react';

/**
 * One shared minute tick (docs/index-spec.md §4.3: "live N min" updates on one
 * shared minute tick). Every card reads the same clock; one interval runs while
 * at least one card is mounted and none runs otherwise.
 *
 * The interval is exactly 60 000 ms on purpose: the review harness pins `Date`
 * and fires every `setInterval(fn, 60_000)` when it moves its clock
 * (docs/design/index-checkpoints/IX-0.md, "Clock").
 */
export const MINUTE_TICK_MS = 60_000;

let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function tick(): void {
  now = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    // A card mounting after a quiet spell reads the time it mounted at.
    now = Date.now();
    timer = setInterval(tick, MINUTE_TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const read = () => now;

/** The time, refreshed once a minute (and whenever a card first mounts). */
export function useMinuteTick(): number {
  return useSyncExternalStore(subscribe, read, read);
}

/** For tests: read the clock again now, as the interval would. */
export function tickMinuteForTests(): void {
  tick();
}
