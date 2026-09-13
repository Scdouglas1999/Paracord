/**
 * Home's title and its one sentence (docs/lantern-stage-spec.md §7.5).
 *
 * The title is a time-of-day word — **Morning / Afternoon / Tonight** — and the
 * sentence under it says the date and how many people have their lights on, so
 * the first line of the app is a fact rather than a greeting.
 *
 * Pure functions with an injected `Date`, so the boundaries are testable and
 * there is exactly one place they are written down.
 */

import { format } from 'date-fns';

export type TimeOfDayWord = 'Morning' | 'Afternoon' | 'Tonight';

/**
 * The boundaries, stated once.
 *
 *   05:00 – 11:59  Morning
 *   12:00 – 17:59  Afternoon
 *   18:00 – 04:59  Tonight   (the small hours belong to the night before)
 *
 * The night wraps past midnight on purpose: at 02:00 you are still in the same
 * evening you started, and "Morning" would be a lie about the light outside.
 */
export const MORNING_STARTS_AT_HOUR = 5;
export const AFTERNOON_STARTS_AT_HOUR = 12;
export const NIGHT_STARTS_AT_HOUR = 18;

/** The time-of-day word for a local-time clock hour (0–23). */
export function timeOfDayWordForHour(hour: number): TimeOfDayWord {
  const h = Math.floor(hour);
  if (h >= NIGHT_STARTS_AT_HOUR || h < MORNING_STARTS_AT_HOUR) return 'Tonight';
  if (h < AFTERNOON_STARTS_AT_HOUR) return 'Morning';
  return 'Afternoon';
}

/** The time-of-day word for a moment. */
export function timeOfDayWord(now: Date): TimeOfDayWord {
  return timeOfDayWordForHour(now.getHours());
}

/** "Saturday 12 September" — the date half of the sentence. */
export function homeDateLine(now: Date): string {
  return format(now, 'EEEE d MMMM');
}

/**
 * "30 people have their lights on across your 2 buildings".
 *
 * Never "No data" and never a zero dressed up as activity (§6.9): with nobody
 * lit it says so, and with no buildings at all it says that instead of counting
 * people who cannot exist.
 */
export function lightsOnAcrossBuildingsCaption(lightsOn: number, buildings: number): string {
  const people = Math.max(0, Math.trunc(lightsOn));
  const houses = Math.max(0, Math.trunc(buildings));
  if (houses === 0) return 'you have not joined a building yet';
  const where = houses === 1 ? 'your building' : `your ${houses} buildings`;
  if (people === 0) return `nobody has their lights on across ${where}`;
  const who = people === 1 ? '1 person has' : `${people} people have`;
  return `${who} their lights on across ${where}`;
}

/** The whole sentence: "Saturday 12 September · 30 people have their lights on…". */
export function homeSentence(now: Date, lightsOn: number, buildings: number): string {
  return `${homeDateLine(now)} · ${lightsOnAcrossBuildingsCaption(lightsOn, buildings)}`;
}

/**
 * A compact "how long ago" for a Needs-you row or a Pick-up row: "2m", "18m",
 * "1h", "3d". Mono meta, so it never reflows as it counts up.
 */
export function shortAgo(thenMs: number | null, nowMs: number): string | null {
  if (thenMs == null || !Number.isFinite(thenMs)) return null;
  const age = Math.max(0, nowMs - thenMs);
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
