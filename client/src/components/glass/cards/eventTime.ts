/**
 * How the timeline says when an event is (docs/glass-spec.md §3.2).
 *
 *   plan card   "Tonight at 9:30 PM in Lounge"      (a sentence)
 *   inline chip "Movie night  Fri 9 PM"             (as short as it can be)
 *
 * Both take `nowMs` so a test (or a fixed-clock screenshot) gets the same words
 * on every machine on every day. Nothing here reads a store or the clock on its
 * own.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight at the start of `date`'s local day. */
function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Whole calendar days from `nowMs`'s day to `date`'s day (0 today, 1 tomorrow, -1 yesterday). */
export function dayOffset(date: Date, nowMs: number): number {
  return Math.round((startOfDay(date) - startOfDay(new Date(nowMs))) / DAY_MS);
}

/**
 * "9:30 PM" (or "21:30" where the locale has no day period). With `short`, an
 * exact hour drops its minutes in a 12-hour locale: "9 PM".
 */
export function clockLabel(date: Date, short = false): string {
  const full = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  if (!short) return full.format(date);
  const parts = full.formatToParts(date);
  const hasPeriod = parts.some((part) => part.type === 'dayPeriod');
  const minute = parts.find((part) => part.type === 'minute')?.value;
  if (hasPeriod && minute === '00') {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(date);
  }
  return full.format(date);
}

const weekday = (date: Date) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date);
const monthDay = (date: Date, nowMs: number) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date(nowMs).getFullYear() ? {} : { year: 'numeric' }),
  }).format(date);

/**
 * The plan card's time sentence: "Tonight at 9:30 PM", "Tomorrow at 9:00 PM",
 * "Fri at 9:00 PM", "Oct 9 at 9:00 PM". An event under way says so, and one
 * that is over says when it was.
 */
export function planWhen(start: Date, opts: { nowMs: number; endsAt?: Date | null; happeningNow?: boolean }): string {
  const { nowMs } = opts;
  if (opts.happeningNow) return 'Happening now';
  const offset = dayOffset(start, nowMs);
  const clock = clockLabel(start);
  const finished = (opts.endsAt ?? start).getTime() < nowMs && start.getTime() < nowMs;
  if (finished) {
    return offset === 0 ? `Earlier today at ${clock}` : offset === -1 ? `Yesterday at ${clock}` : `${monthDay(start, nowMs)}`;
  }
  if (offset === 0) return start.getHours() >= 17 ? `Tonight at ${clock}` : `Today at ${clock}`;
  if (offset === 1) return `Tomorrow at ${clock}`;
  if (offset > 1 && offset < 7) return `${weekday(start)} at ${clock}`;
  return `${monthDay(start, nowMs)} at ${clock}`;
}

/** The inline chip's short time: "Today 9:30 PM", "Fri 9 PM", "Oct 9, 9 PM". */
export function chipWhen(start: Date, nowMs: number): string {
  const offset = dayOffset(start, nowMs);
  const clock = clockLabel(start, true);
  if (offset === 0) return `Today ${clock}`;
  if (offset > 0 && offset < 7) return `${weekday(start)} ${clock}`;
  if (offset < 0) return monthDay(start, nowMs);
  return `${monthDay(start, nowMs)}, ${clock}`;
}
