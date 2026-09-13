/**
 * The words that go with the light (docs/lantern-stage-spec.md §6.9, §9).
 *
 * Light is never the only cue, so every lit thing renders one of these strings
 * somewhere a screen reader can reach. Copy is specific and in the metaphor —
 * "3 talking", "5 reading", "Dark · nobody in", "last lit 2 h ago". Never
 * "No data", "It's quiet here" or "Online".
 *
 * Pure functions, no imports. One place so two surfaces can never disagree
 * about how a count is worded.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "3 talking" / "1 talking". Zero is a dark room — use {@link darkRoomCaption}. */
export function talkingCaption(count: number): string {
  return `${Math.max(0, Math.trunc(count))} talking`;
}

/** "5 reading" / "1 reading". */
export function readingCaption(count: number): string {
  return `${Math.max(0, Math.trunc(count))} reading`;
}

/**
 * A room with nobody in it.
 *
 * The contract spells this two ways and both are correct in place: a sidebar
 * **row** reads "Dark · nobody in" (§7.1) and a Lobby **card** reads
 * "Dark · nobody's in" (§6.9, §7.3). Pick by surface, never by taste.
 */
export function darkRoomCaption(surface: 'row' | 'card' = 'row'): string {
  return surface === 'card' ? "Dark · nobody's in" : 'Dark · nobody in';
}

/** "last lit 2 h ago" / "last lit just now" / "never lit". */
export function lastLitCaption(lastLitMs: number | null, nowMs: number): string {
  if (lastLitMs == null) return 'never lit';
  const age = nowMs - lastLitMs;
  if (age < MINUTE) return 'last lit just now';
  if (age < HOUR) return `last lit ${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `last lit ${Math.floor(age / HOUR)} h ago`;
  return `last lit ${Math.floor(age / DAY)} d ago`;
}

/**
 * A building's caption: "2 rooms lit · 3 reading" (§7.1). A building with no
 * lit voice room but somebody reading reads just "1 reading"; a fully dark
 * building reads "Dark · nobody in".
 */
export function buildingCaption(roomsLit: number, readingCount: number): string {
  const parts: string[] = [];
  if (roomsLit > 0) parts.push(roomsLit === 1 ? '1 room lit' : `${roomsLit} rooms lit`);
  if (readingCount > 0) parts.push(readingCaption(readingCount));
  return parts.length ? parts.join(' · ') : darkRoomCaption('row');
}

/** The here-now strip: "4 here · 20 lights on" (§7.2, §7.4). */
export function hereNowCaption(here: number, lightsOn: number): string {
  return `${here} here · ${lightsOn} lights on`;
}

/** The trailing count on an Around-now well: "+17 lights on" (§7.3). */
export function lightsOnOverflowCaption(count: number): string {
  return `+${Math.max(0, Math.trunc(count))} lights on`;
}

/** A building's section meta: "24 in" (§7.1). */
export function litMembersCaption(lightsOn: number): string {
  return `${Math.max(0, Math.trunc(lightsOn))} in`;
}

/**
 * A call duration in the mono meta face: "34:12", "1:02:11".
 * Always two-digit seconds so the tabular numerals do not shuffle.
 */
export function callDuration(durationMs: number | null): string {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) return '0:00';
  const total = Math.floor(durationMs / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

/**
 * "Mara, Priya and Ren"; past `max`, "Mara, Priya and 4 others".
 * Used by the Around-now sentence and by every occupant line.
 */
export function nameList(names: string[], max = 3): string {
  const list = names.filter((n) => n.trim().length > 0);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  if (list.length <= max) {
    return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  }
  const shown = list.slice(0, max - 1);
  const rest = list.length - shown.length;
  return `${shown.join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}`;
}
