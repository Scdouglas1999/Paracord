/**
 * A manual clock for the room's tests (not shipped: only tests import it).
 * `advance(ms)` runs every timer that falls due, in order, moving `now` to each.
 */
import type { TokenWriterClock } from './tokenWriter';

export interface ManualClock extends TokenWriterClock {
  advance(ms: number): void;
  readonly pending: number;
}

export function createManualClock(start = 1_000): ManualClock {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimeout(callback, ms) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), callback });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let due: [number, { at: number; callback: () => void }] | null = null;
        for (const entry of timers) {
          if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
        }
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = end;
    },
    get pending() {
      return timers.size;
    },
  };
}
