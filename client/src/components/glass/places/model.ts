/**
 * The sidebar's words as data (docs/index-spec.md §4.1 to §4.7).
 *
 * Pure functions and plain types: what a row says, which channels get one and in
 * what order, how a time is written. Nothing here reads a store or renders; the
 * hooks in `usePlacesData.ts` feed it and the components in
 * `components/ix/sidebar` (and the People sidebar) draw what it returns, so every
 * rule below is unit-tested without React.
 *
 *   - **Order**: the server's own order (uncategorized channels first, then each
 *     category's channels by position). Rows never re-sort by activity, so a row
 *     does not move under the pointer.
 *   - **No `#`** is ever added. A channel mention inside a preview reads as the
 *     channel's name.
 */

import { messageSnippetText } from '../../../lib/markdown';
import { parseClipFilename } from '../../../lib/media/clips/clipFilename';
import type { ChannelPreviewEntry } from '../../../hooks/useChannelPreviews';
import { snowflakeTime } from '../../../hooks/useChannelPreviews';
import { ChannelType, type Channel } from '../../../types';

/* ---- Constants ------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

/* ---- Channels: which ones are rows, and in what order ----------------------- */

/** Channel types that get a row. Categories only group; threads live inside their channel. */
export function isPlaceChannel(type: ChannelType | number | undefined): boolean {
  return (
    type === ChannelType.Text
    || type === ChannelType.Voice
    || type === ChannelType.Announcement
    || type === ChannelType.Forum
    || type === ChannelType.Stage
  );
}

export function isVoiceChannel(type: ChannelType | number | undefined): boolean {
  return type === ChannelType.Voice || type === ChannelType.Stage;
}

const byPosition = (a: Pick<Channel, 'position' | 'id'>, b: Pick<Channel, 'position' | 'id'>) =>
  (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id, undefined, { numeric: true });

/**
 * The channels as the server arranged them, flattened: channels without a
 * category first, then each category's channels, categories and channels both in
 * position order. Only rows-worthy types come back.
 */
export function orderChannels<T extends Pick<Channel, 'id' | 'type' | 'position' | 'parent_id'>>(
  channels: readonly T[],
): T[] {
  const categories = channels.filter((channel) => channel.type === ChannelType.Category).sort(byPosition);
  const rows = channels.filter((channel) => isPlaceChannel(channel.type));
  const categoryIds = new Set(categories.map((category) => category.id));
  const uncategorized = rows
    .filter((channel) => !channel.parent_id || !categoryIds.has(channel.parent_id))
    .sort(byPosition);
  const grouped = categories.flatMap((category) =>
    rows.filter((channel) => channel.parent_id === category.id).sort(byPosition),
  );
  return [...uncategorized, ...grouped];
}

/* ---- Time ------------------------------------------------------------------- */

/** ICU writes a narrow no-break space before AM and PM; a row wants a plain one. */
const plainSpaces = (text: string) => text.replace(/[\u202f\u00a0]/g, ' ');

function startOfDay(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Whole calendar days from `thenMs` to `nowMs` in the viewer's zone. */
export function daysBetween(thenMs: number, nowMs: number): number {
  return Math.round((startOfDay(nowMs) - startOfDay(thenMs)) / DAY_MS);
}

/**
 * A row's time: "9:09 PM" today, "Tue" within the last six days, "Sep 12" beyond
 * that, "Sep 12, 2025" from another year. The reference (screens 01, 02) shows
 * exactly these.
 */
export function formatRowTime(when: number | string | null | undefined, nowMs: number): string | null {
  if (when === null || when === undefined) return null;
  const ms = typeof when === 'number' ? when : Date.parse(when);
  if (!Number.isFinite(ms)) return null;
  const days = daysBetween(ms, nowMs);
  if (days <= 0) {
    return plainSpaces(new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(ms));
  }
  if (days < 7) return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(ms);
  const sameYear = new Date(ms).getFullYear() === new Date(nowMs).getFullYear();
  return new Intl.DateTimeFormat(
    undefined,
    sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' },
  ).format(ms);
}

/** "9:00 PM". */
export function clockWords(ms: number): string {
  return plainSpaces(new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(ms));
}

/** "9 PM" on the hour, "9:30 PM" otherwise: the shortest honest clock. */
export function clockShort(ms: number): string {
  const minutes = new Date(ms).getMinutes();
  return plainSpaces(
    new Intl.DateTimeFormat(undefined, minutes === 0 ? { hour: 'numeric' } : { hour: 'numeric', minute: '2-digit' }).format(ms),
  );
}

function whenWords(whenMs: number, nowMs: number, clock: (ms: number) => string): string {
  const time = clock(whenMs);
  const ahead = daysBetween(nowMs, whenMs);
  if (ahead === 0) return `Today ${time}`;
  if (Math.abs(ahead) < 7) return `${new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(whenMs)} ${time}`;
  const sameYear = new Date(whenMs).getFullYear() === new Date(nowMs).getFullYear();
  const day = new Intl.DateTimeFormat(
    undefined,
    sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' },
  ).format(whenMs);
  return `${day}, ${time}`;
}

/**
 * When something is, in a few words: "Today 9 PM", "Fri 9 PM" within a week
 * either way, "Oct 9, 9 PM" beyond it ("Oct 9, 2027, 9 PM" from another year).
 * Calendar days in the viewer's zone, not 24-hour spans. A preview's version.
 */
export function shortWhen(whenMs: number, nowMs: number): string {
  return whenWords(whenMs, nowMs, clockShort);
}

/** The same with the minutes always written ("Fri 9:00 PM"): the Coming up rows' version. */
export function fullWhen(whenMs: number, nowMs: number): string {
  return whenWords(whenMs, nowMs, clockWords);
}

/**
 * The sidebar header's line (index-spec §4.1): "2 members · 2 here now", where
 * "here now" counts the members who are online (not idle, not away). Before the
 * roster is known it says only the count the server itself reports: never a
 * "here now" it has not seen.
 */
export function headerLine(input: { memberCount: number; here: number; rosterKnown: boolean }): string {
  const members = plural(input.memberCount, 'member', 'members');
  return input.rosterKnown ? `${members} · ${input.here} here now` : members;
}

/**
 * A Coming up row's second line (index-spec §4.7): "Fri 9:00 PM · Lounge", or
 * the place it names (a location), or just the time.
 */
export function comingUpLine(
  event: { startsAt: Date; location: string | null },
  context: { nowMs: number; roomName: string | null },
): string {
  const where = context.roomName ?? event.location;
  const when = fullWhen(event.startsAt.getTime(), context.nowMs);
  return where ? `${when} · ${where}` : when;
}

/** The date tile of a Coming up row: the weekday (shown in capitals by the style) and the day of the month. */
export function dateTile(startsAt: Date): { weekday: string; day: string } {
  return {
    weekday: new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(startsAt),
    day: String(startsAt.getDate()),
  };
}

/* ---- Previews: the one line under a channel's name --------------------------- */

export interface PreviewContext {
  selfUserId: string | null;
  /** User id → the name a mention of them reads as. */
  memberNames: ReadonlyMap<string, string>;
  /** Channel id → its name, so `<#id>` reads as a name and never as `#`. */
  channelNames: ReadonlyMap<string, string>;
  /** Event id → its name, so `<event:id>` reads as "Movie night". An event the client does not know reads as "an event". */
  eventNames: ReadonlyMap<string, string>;
  /**
   * Events the client knows with their start, so a message that is only an
   * event reads as "Movie night · Fri 9 PM" (index-spec §4.5). Needs `nowMs`.
   */
  events?: ReadonlyMap<string, { name: string; startsAt: Date }>;
  nowMs?: number;
}

/**
 * What a message with no text shared, in the words a row uses after "posted":
 * "a photo", "4 photos", "a clip", "a video", "a recording", "a file", "3 files".
 * The server's preview names the first attachment's type and the count of all of
 * them, so more than one picture is counted as photos only when the first is
 * one; any other set is files.
 */
function mediaWords(entry: ChannelPreviewEntry): string | null {
  const type = entry.media?.contentType ?? '';
  if (entry.attachmentCount > 1) {
    return type.startsWith('image/') ? `${entry.attachmentCount} photos` : `${entry.attachmentCount} files`;
  }
  if (type.startsWith('image/')) return 'a photo';
  if (type.startsWith('video/')) return parseClipFilename(entry.media?.filename ?? '') ? 'a clip' : 'a video';
  if (type.startsWith('audio/')) return 'a recording';
  return entry.attachmentCount === 1 ? 'a file' : null;
}

const SYSTEM_WORDS: Record<number, string> = {
  3: 'started a call',
  4: 'renamed the channel',
  5: 'changed the channel icon',
  6: 'pinned a message',
  7: 'joined the server',
};

/** The author's name as the row says it: "You" for yourself. */
export function authorLabel(entry: ChannelPreviewEntry, selfUserId: string | null): string {
  if (entry.author.kind === 'user' && selfUserId && entry.author.id === selfUserId) return 'You';
  return entry.author.name?.trim() || 'Someone';
}

/** Plain words for a message's text: markup gone, mentions as names, spoilers hidden. */
export function previewText(
  content: string,
  context: Pick<PreviewContext, 'memberNames' | 'channelNames' | 'eventNames'>,
): string {
  const withChannels = content.replace(/<#(\d+)>/g, (_match, id: string) => context.channelNames.get(id) ?? 'a channel');
  // An event's name goes in after the markup is stripped (inside `messageSnippetText`), so a
  // name with an underscore or asterisk in it is not read as formatting.
  return messageSnippetText(withChannels, context.memberNames, undefined, undefined, context.eventNames)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The line under a channel's name: "Jeremy: @Sean is movie night still on?".
 * Media with no text reads as what was posted ("Nick posted 4 photos"), with no
 * colon, as the reference does. A message that is only a scheduled event reads
 * as the event itself ("Movie night · Fri 9 PM"). Returns null when a channel
 * has nothing to say.
 */
export function previewLine(entry: ChannelPreviewEntry | null | undefined, context: PreviewContext): string | null {
  if (!entry) return null;
  const who = authorLabel(entry, context.selfUserId);
  if (entry.encrypted) return `${who}: Encrypted message`;
  if (entry.messageType !== 0 && entry.messageType !== 19 && entry.messageType !== 20) {
    const words = SYSTEM_WORDS[entry.messageType];
    return words ? `${who} ${words}` : 'New activity';
  }
  const eventOnly = entry.content?.trim().match(/^<event:(\d+)>$/);
  const sharedEvent = eventOnly ? context.events?.get(eventOnly[1]) : undefined;
  if (sharedEvent && context.nowMs !== undefined) {
    return `${sharedEvent.name} · ${shortWhen(sharedEvent.startsAt.getTime(), context.nowMs)}`;
  }
  const text = entry.content ? previewText(entry.content, context) : '';
  if (entry.messageType === 20) return text ? `${who} started a poll: ${text}` : `${who} started a poll`;
  if (text) return `${who}: ${text}`;
  const shared = mediaWords(entry);
  if (shared) return `${who} posted ${shared}`;
  if (entry.hasSticker) return `${who} sent a sticker`;
  return `${who} sent a message`;
}

/* ---- Faces ------------------------------------------------------------------ */

export interface FaceModel {
  userId: string;
  name: string;
  /** The stored avatar value; null draws the monogram. */
  avatar: string | null;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/* ---- Times from ids ---------------------------------------------------------- */

/** When a channel's newest message was written, from its id. Null when there is none. */
export function lastMessageTime(lastMessageId: string | null | undefined): number | null {
  if (!lastMessageId || lastMessageId === '0') return null;
  return snowflakeTime(lastMessageId);
}
