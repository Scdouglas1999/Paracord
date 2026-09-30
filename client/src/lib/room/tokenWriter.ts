/**
 * The one style write the room makes: `--room-rgb` on the app root.
 *
 * Writing a custom property on `<html>` restyles the whole document, so this
 * writer is the budget (docs/design/glass-plan.md §6, "Room token churn"):
 *
 *  - at most {@link ROOM_TOKEN_MAX_HZ} writes a second, whatever the caller
 *    does (a burst collapses into one trailing write with the latest value);
 *  - nothing is written unless the color moved by at least
 *    {@link ROOM_TOKEN_DEADBAND} on some channel, or it is the value the room is
 *    settling on. The surfaces take only 4-6% of the room, so a smaller step
 *    changes no pixel anyone could see;
 *  - the value is channel numbers (`"222, 109, 35"`), never an `rgb()` string,
 *    and nothing else is ever written. The panes blend between writes with a
 *    CSS color transition (`--glass-ms-room`), which is the compositor's work,
 *    not a script's.
 *
 * Never register the property (`@property`) or animate it: an animated custom
 * property on `:root` is a whole-document style recalc on every frame.
 */
import { channelDistance, formatRoomRgb, roundRgb, type Rgb } from './color';

export const ROOM_TOKEN_PROPERTY = '--room-rgb';
export const ROOM_TOKEN_MAX_HZ = 4;
export const ROOM_TOKEN_MIN_INTERVAL_MS = 1000 / ROOM_TOKEN_MAX_HZ;
/**
 * Channel units of the room color. A surface takes at most 6% of the room, so
 * a step this size moves it by about half a unit (10 x 0.06 = 0.6): nothing
 * anyone could see, but every write restyles the document and restarts the
 * panes' 1.2 s color transition, which repaints them for its whole length
 * (measured: in Chromium that transition, restarted twice a second by a
 * drifting stream, cost more than the rest of the room together). A stream
 * whose colors drift is therefore followed only in steps that show.
 */
export const ROOM_TOKEN_DEADBAND = 10;

export interface TokenWriterClock {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export const realClock: TokenWriterClock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RoomTokenWriter {
  /**
   * Offer the room color. `settled` marks the value the room is resting on:
   * it is written even inside the deadband, so a finished ease lands exactly.
   */
  offer(rgb: Rgb, settled?: boolean): void;
  /** The value last written, or null before the first write. */
  readonly written: Rgb | null;
  /** Writes so far (for the budget test and diagnostics). */
  readonly writes: number;
  /** Cancel a pending trailing write. The written value stays. */
  dispose(): void;
}

export function createRoomTokenWriter(
  element: HTMLElement,
  clock: TokenWriterClock = realClock,
): RoomTokenWriter {
  let written: Rgb | null = null;
  let writes = 0;
  let lastWriteAt = -Infinity;
  let pending: { rgb: Rgb; settled: boolean } | null = null;
  let timer: unknown = null;
  let disposed = false;

  const worthWriting = (rgb: Rgb, settled: boolean) => {
    if (!written) return true;
    const distance = channelDistance(rgb, written);
    if (distance === 0) return false;
    return settled || distance >= ROOM_TOKEN_DEADBAND;
  };

  const write = (rgb: Rgb) => {
    written = roundRgb(rgb);
    writes += 1;
    lastWriteAt = clock.now();
    element.style.setProperty(ROOM_TOKEN_PROPERTY, formatRoomRgb(written));
  };

  const flushPending = () => {
    timer = null;
    if (disposed || !pending) return;
    const next = pending;
    pending = null;
    if (worthWriting(next.rgb, next.settled)) write(next.rgb);
  };

  return {
    offer(rgb, settled = false) {
      if (disposed) return;
      const rounded = roundRgb(rgb);
      if (!worthWriting(rounded, settled)) {
        // A value inside the deadband replaces nothing, but a later settled
        // one must still be able to land: keep the newest intent.
        if (pending) pending = { rgb: rounded, settled: pending.settled || settled };
        return;
      }
      const since = clock.now() - lastWriteAt;
      if (since >= ROOM_TOKEN_MIN_INTERVAL_MS && timer === null) {
        pending = null;
        write(rounded);
        return;
      }
      pending = { rgb: rounded, settled };
      if (timer === null) {
        timer = clock.setTimeout(flushPending, Math.max(0, ROOM_TOKEN_MIN_INTERVAL_MS - since));
      }
    },
    get written() {
      return written;
    },
    get writes() {
      return writes;
    },
    dispose() {
      disposed = true;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
