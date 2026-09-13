/**
 * Clocks and calendars for the Lobby (docs/lantern-stage-spec.md §7.3, §8).
 *
 * Durations and "last lit" belong to the light vocabulary and are already
 * written down in `lib/attention/lightCaptions.ts`. What is here is the wall
 * clock the Lobby shows a human: the time of an event, the day tile beside it,
 * and the stamp on a text room's last line of traffic.
 *
 * Pure functions with the clock injected, so they are testable without faking
 * `Date` — and so a stamp can never disagree between two surfaces.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A date we could not parse is not rendered at all — never "Invalid Date". */
export function parseDate(value: string | number | null | undefined): Date | null {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function lowerMeridiem(value: string): string {
  return value.replace(/\bAM\b/g, 'am').replace(/\bPM\b/g, 'pm');
}

/** "1 pm" on the hour, "1:30 pm" otherwise — the header's next-event clause. */
export function shortClock(date: Date): string {
  const onTheHour = date.getMinutes() === 0;
  return lowerMeridiem(
    date.toLocaleTimeString(undefined, {
      hour: 'numeric',
      ...(onTheHour ? {} : { minute: '2-digit' }),
    }),
  );
}

/** "1:00 pm" — the event card always shows the minutes. */
export function clockTime(date: Date): string {
  return lowerMeridiem(
    date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
  );
}

/** Same calendar day as `now`? Local time, because a human reads it locally. */
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "Today" / "Tomorrow" / "Sat 13 Sep" — the day half of an event's line. */
export function eventDay(date: Date, nowMs: number): string {
  const now = new Date(nowMs);
  if (isSameDay(date, now)) return 'Today';
  const tomorrow = new Date(nowMs + DAY);
  if (isSameDay(date, tomorrow)) return 'Tomorrow';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** "Today 1:00 pm" — the first clause of the event card's meta line (§7.3). */
export function eventWhen(date: Date, nowMs: number): string {
  return `${eventDay(date, nowMs)} ${clockTime(date)}`;
}

/** The day tile beside an event: mono weekday over a Gabarito date (§8). */
export function eventDayTile(date: Date): { weekday: string; day: string } {
  return {
    weekday: date.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase(),
    day: date.toLocaleDateString(undefined, { day: 'numeric' }),
  };
}

/**
 * A text room's last line of traffic: "10:02" today, "yesterday", the weekday
 * inside a week, then the date. Short, because the room's name is the loud half.
 */
export function trafficStamp(atMs: number, nowMs: number): string {
  const date = new Date(atMs);
  if (!Number.isFinite(date.getTime())) return '';
  const now = new Date(nowMs);
  if (isSameDay(date, now)) {
    return lowerMeridiem(
      date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    );
  }
  if (isSameDay(date, new Date(nowMs - DAY))) return 'yesterday';
  if (nowMs - atMs < 7 * DAY && nowMs >= atMs) {
    return date.toLocaleDateString(undefined, { weekday: 'short' });
  }
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** The media strip's window: a photo counts as "this week" for seven days. */
export const MEDIA_WEEK_MS = 7 * DAY;
