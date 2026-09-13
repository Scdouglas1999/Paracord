/**
 * The Lobby's own words (docs/lantern-stage-spec.md §6.9, §7.3).
 *
 * Counts, durations and every light caption already have one home in
 * `lib/attention/lightCaptions.ts` — nothing here re-words those. What lives
 * here is the copy §7.3 spells out for *this* surface and nowhere else: the
 * header's "24 of 61 have their lights on", the dark card's invitation, the
 * event line, the media strip's count.
 *
 * Pure functions, no React and no store. One place, so the header and a card
 * can never disagree about how the same fact is worded.
 */

import { nameList } from '../../../lib/attention/light';

/**
 * "24 of 61 have their lights on" (§7.3).
 *
 * `memberCount` is the building's roll; when the server has not told us one it
 * is the number of people we can see, and saying "of N" would be a claim we
 * cannot back — so the clause drops the denominator instead of inventing it.
 */
export function lightsOnOfCaption(lightsOn: number, memberCount: number): string {
  const on = Math.max(0, Math.trunc(lightsOn));
  const total = Math.max(0, Math.trunc(memberCount));
  if (on === 0) return "Nobody's lights are on";
  if (total > on) return `${on} of ${total} have their lights on`;
  return on === 1 ? '1 has their lights on' : `${on} have their lights on`;
}

/** "2 rooms lit" / "1 room lit". Empty when the building is dark. */
export function roomsLitCaption(roomsLit: number): string {
  const lit = Math.max(0, Math.trunc(roomsLit));
  if (lit === 0) return '';
  return lit === 1 ? '1 room lit' : `${lit} rooms lit`;
}

/** "thermal test at 1 pm" — the header's next-event clause (§7.3). */
export function nextEventCaption(name: string, timeLabel: string): string {
  const trimmed = name.trim();
  if (!trimmed || !timeLabel) return '';
  return `${trimmed} at ${timeLabel}`;
}

/** Join the header's clauses with the building's own separator. */
export function headerLine(clauses: readonly (string | null | undefined)[]): string {
  return clauses.filter((clause): clause is string => Boolean(clause && clause.trim())).join(' · ');
}

/**
 * The speaking line on a lit card: "Mara speaking", "Mara and Priya speaking".
 * Empty when nobody is talking — the card falls back to the room's own caption
 * rather than asserting a voice nobody can hear.
 */
export function speakingCaption(names: readonly string[]): string {
  const list = nameList([...names]);
  return list ? `${list} speaking` : '';
}

/**
 * The Around-now sentence when the building has people in it but nobody is in a
 * room. WP1's default ("Nobody's lights are on right now") is about rooms, and
 * next to a "+17 lights on" count it would contradict itself.
 */
export const NOBODY_IN_A_ROOM = "Nobody's in a room right now";

/** The add tile (§7.3), shown only to somebody who can actually open one. */
export const OPEN_A_NEW_ROOM = 'Open a new room';

/** "Recently in Kestrel Robotics" — the media strip's label (§7.3). */
export function recentlyInCaption(buildingName: string): string {
  const name = buildingName.trim();
  return name ? `Recently in ${name}` : 'Recently shared';
}

/** "14 photos this week" / "1 photo this week". Empty at zero — never "0". */
export function photosThisWeekCaption(count: number): string {
  const total = Math.max(0, Math.trunc(count));
  if (total === 0) return '';
  return total === 1 ? '1 photo this week' : `${total} photos this week`;
}

/** "6 going" / "1 going". Empty at zero, so the clause drops out entirely. */
export function goingCaption(count: number): string {
  const total = Math.max(0, Math.trunc(count));
  if (total === 0) return '';
  return `${total} going`;
}

/** "Priya is hosting". Empty when we cannot name the host. */
export function hostingCaption(name: string | null | undefined): string {
  const host = (name ?? '').trim();
  return host ? `${host} is hosting` : '';
}

/** "Priya · 10:02" — a text room's last line of traffic (§8 TextRoomRow). */
export function lastAuthorCaption(
  author: string | null | undefined,
  time: string | null | undefined,
): string {
  return headerLine([author?.trim() || null, time?.trim() || null]);
}

/**
 * A text room nobody has written in yet (§6.9, §7.3).
 *
 * Its row has no author, no line and no stamp, and drawn as three blanks beside
 * neighbours that have all three it reads as a row that failed to load. This
 * says the true thing instead — and it is the room's own invitation, so it
 * never appears next to a preview.
 */
export const NOTHING_SAID_YET = 'Nothing said here yet';

/** "1 mention" / "3 mentions" — the chip on a text room row (§7.3). */
export function mentionCaption(count: number): string {
  const total = Math.max(0, Math.trunc(count));
  if (total === 0) return '';
  return total === 1 ? '1 mention' : `${total} mentions`;
}
