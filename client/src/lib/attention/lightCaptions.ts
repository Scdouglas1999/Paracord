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

