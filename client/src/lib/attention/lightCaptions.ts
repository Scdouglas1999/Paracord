/**
 * The words that go with the light (docs/lantern-stage-spec.md §6.9, §9).
 *
 * Light is never the only cue, so every lit thing renders one of these strings
 * somewhere a screen reader can reach. The light is styling; the words are
 * plain (docs/server-home-spec.md, "Plain words") — "3 talking", "5 here",
 * "Empty", "Nobody in voice", "last active 2 h ago". Never "No data".
 *
 * Pure functions, no imports. One place so two surfaces can never disagree
 * about how a count is worded.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "3 talking" / "1 talking". Zero is an empty channel — use {@link darkRoomCaption}. */
export function talkingCaption(count: number): string {
  return `${Math.max(0, Math.trunc(count))} talking`;
}

/**
 * "5 here" / "1 here": the people a text channel can tell are in it (see
 * `roomLight.ts` for exactly who counts).
 */
export function readingCaption(count: number): string {
  return `${Math.max(0, Math.trunc(count))} here`;
}

/**
 * A voice channel with nobody in it.
 *
 * Two lengths, and both are correct in place: a sidebar **row** has room for
 * one word, "Empty"; a **card** says what is empty, "Nobody in voice". Pick by
 * surface, never by taste.
 */
export function darkRoomCaption(surface: 'row' | 'card' = 'row'): string {
  return surface === 'card' ? 'Nobody in voice' : 'Empty';
}

/**
 * A text channel nobody is in right now. Not "Empty": its messages are still
 * there, and "Empty" would say they were not.
 */
export function quietTextCaption(): string {
  return 'Nobody here';
}

/**
 * When a voice channel last had somebody in it: "last active 2 h ago" /
 * "last active just now" / "no calls yet".
 */
export function lastLitCaption(lastLitMs: number | null, nowMs: number): string {
  if (lastLitMs == null) return 'no calls yet';
  const age = nowMs - lastLitMs;
  if (age < MINUTE) return 'last active just now';
  if (age < HOUR) return `last active ${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `last active ${Math.floor(age / HOUR)} h ago`;
  return `last active ${Math.floor(age / DAY)} d ago`;
}

/**
 * A server's caption, beside its window map: "4 in voice · 3 here" (§7.1). A
 * server with nobody in voice but somebody in a text channel reads "3 here";
 * with neither, "Nobody in voice".
 *
 * It counts people, not channels, and it leaves out how many are online: the
 * section label directly above the plate already says "8 online". This caption
 * shares one 276px sidebar row with the window map, and the map takes the
 * first 118px of it whenever a server has eight or more channels, so it stays
 * two short clauses.
 */
export function buildingCaption(inVoice: number, readingCount: number): string {
  const parts: string[] = [];
  if (inVoice > 0) parts.push(`${Math.trunc(inVoice)} in voice`);
  if (readingCount > 0) parts.push(readingCaption(readingCount));
  return parts.length ? parts.join(' · ') : darkRoomCaption('card');
}

/** The here-now strip: "4 here · 20 online" (§7.2, §7.4). */
export function hereNowCaption(here: number, lightsOn: number): string {
  return `${here} here · ${lightsOn} online`;
}

/** The trailing count on an Around-now well: "+17 online" (§7.3). */
export function lightsOnOverflowCaption(count: number): string {
  return `+${Math.max(0, Math.trunc(count))} online`;
}

/** A server's section meta: "24 online" (§7.1). */
export function litMembersCaption(lightsOn: number): string {
  return `${Math.max(0, Math.trunc(lightsOn))} online`;
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
