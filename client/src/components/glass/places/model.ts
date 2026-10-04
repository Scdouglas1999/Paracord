/**
 * The places panel as data (docs/glass-spec.md §3.1).
 *
 * Pure functions and plain types: what a row says, which shape it takes, how a
 * count or a time is written. Nothing here reads a store or renders; the hooks
 * in `usePlacesData.ts` feed it and the components draw what it returns, so every
 * rule below is unit-tested without React.
 *
 * Owned by the Index sidebar (IX-5) from the Index build on: the rows of
 * `components/ix/sidebar` read their words from here. The Glass panel that also
 * calls these functions is retired with IX-19.
 *
 * DECISIONS THIS MODULE HOLDS (also in docs/design/glass-g9-checkpoint.md):
 *
 *   - **Quiet channel**: no message for 7 days AND nothing unread AND no mention.
 *     An unread channel is never quiet, however old it is; a channel that has
 *     never had a message is quiet.
 *   - **Order**: the server's own order (uncategorized channels first, then each
 *     category's channels by position). Rows never re-sort by activity, so a row
 *     does not move under the pointer. Quiet only changes a row's height.
 *   - **Counts**: an unread count is a number only when it is exact (see
 *     `useUnreadMessageCounts`); otherwise the row shows an unread dot. A mention
 *     is a white `@`, or `@N` from two.
 *   - **No `#`** is ever added by the panel. A channel mention inside a preview
 *     reads as the channel's name.
 */

import { messageSnippetText } from '../../../lib/markdown';
import { parseClipFilename } from '../../../lib/media/clips/clipFilename';
import type { ChannelPreviewEntry } from '../../../hooks/useChannelPreviews';
import { snowflakeTime } from '../../../hooks/useChannelPreviews';
import { ChannelType, type Channel } from '../../../types';

/* ---- Constants ------------------------------------------------------------- */

/** A channel with nothing new for this long is a quiet row (a one-line 44px row). */
export const QUIET_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** The most an unread or mention badge writes out; beyond it, `99+`. */
export const BADGE_CAP = 99;

/** How many messages one count request asks for. `BADGE_CAP + 1` proves "more than the cap". */
export const COUNT_PROBE_LIMIT = BADGE_CAP + 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/* ---- Channels: which ones are rows, and in what order ----------------------- */

/** The kinds of row a channel can be (a voice channel with nobody in it is a text row). */
export type ChannelGlyph = 'chat' | 'voice' | 'announcement' | 'forum' | 'stage' | 'doc';

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

/** The glyph tile a channel gets when nothing better (a face, a picture) leads its row. */
export function glyphFor(type: ChannelType | number | undefined): ChannelGlyph {
  switch (type) {
    case ChannelType.Voice:
      return 'voice';
    case ChannelType.Stage:
      return 'stage';
    case ChannelType.Announcement:
      return 'announcement';
    case ChannelType.Forum:
      return 'forum';
    default:
      return 'chat';
  }
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

/** Nothing new for a long time: a one-line row (see the module note). */
export function isQuietChannel(input: {
  lastMessageMs: number | null;
  nowMs: number;
  unread: boolean;
  mentions: number;
}): boolean {
  if (input.unread || input.mentions > 0) return false;
  if (input.lastMessageMs === null) return true;
  return input.nowMs - input.lastMessageMs > QUIET_AFTER_MS;
}

/* ---- Badges ----------------------------------------------------------------- */

/** What sits under a row's time. */
export type Badge =
  /** For you: white. `@` for one mention, `@N` from two. */
  | { kind: 'mention'; label: string; count: number }
  /** Unread, and the count is known exactly: `#3a3b40`. */
  | { kind: 'count'; label: string; count: number }
  /** Unread, count not known (yet): a dot. Never a guess. */
  | { kind: 'dot' };

export function capped(count: number): string {
  return count > BADGE_CAP ? `${BADGE_CAP}+` : String(Math.max(0, Math.trunc(count)));
}

export function mentionBadge(count: number): Badge {
  return { kind: 'mention', count, label: count > 1 ? `@${capped(count)}` : '@' };
}

/** `count` is the number of unread messages when it is known, else null. */
export function unreadBadge(count: number | null): Badge {
  return count === null ? { kind: 'dot' } : { kind: 'count', count, label: capped(count) };
}

/** The badge a channel row wears: a mention outranks a count outranks nothing. */
export function badgeFor(input: {
  muted: boolean;
  mentions: number;
  unread: boolean;
  unreadCount: number | null;
}): Badge | null {
  if (input.muted) return null;
  if (input.mentions > 0) return mentionBadge(input.mentions);
  if (input.unread) return unreadBadge(input.unreadCount);
  return null;
}

/** The words for a badge, for a screen reader (light is never the only cue). */
export function badgeWords(badge: Badge | null): string | null {
  if (!badge) return null;
  if (badge.kind === 'dot') return 'unread';
  if (badge.kind === 'mention') return badge.count === 1 ? '1 mention' : `${badge.count} mentions`;
  return `${badge.count > BADGE_CAP ? `more than ${BADGE_CAP}` : badge.count} unread`;
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

/** "9:30": the clock without its AM or PM, for a date tile that says TODAY. */
export function clockDigits(ms: number): string {
  const parts = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).formatToParts(ms);
  return plainSpaces(
    parts
      .filter((part) => part.type !== 'dayPeriod')
      .map((part) => part.value)
      .join('')
      .trim(),
  );
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
  event: Pick<EventLike, 'startsAt' | 'location'>,
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

/** Is the latest message a picture the row can lead with? */
export function thumbnailOf(entry: ChannelPreviewEntry | null | undefined): { attachmentId: string; label: string } | null {
  if (!entry || entry.encrypted || !entry.media) return null;
  if (!(entry.media.contentType ?? '').startsWith('image/')) return null;
  return { attachmentId: entry.media.attachmentId, label: entry.media.filename };
}

/* ---- Faces ------------------------------------------------------------------ */

export interface FaceModel {
  userId: string;
  name: string;
  /** The stored avatar value; null draws initials. */
  avatar: string | null;
}

/**
 * The faces a row leads with: the last two distinct speakers, the previous one
 * behind (top left) and the latest in front (bottom right). One speaker, one face.
 */
export function leadFaces(authors: readonly FaceModel[]): FaceModel[] {
  const distinct: FaceModel[] = [];
  const seen = new Set<string>();
  for (const author of authors) {
    if (seen.has(author.userId)) continue;
    seen.add(author.userId);
    distinct.push(author);
    if (distinct.length === 2) break;
  }
  return distinct.reverse();
}

/* ---- The server title's line ------------------------------------------------- */

export interface ServerLineInput {
  rosterKnown: boolean;
  memberCount: number;
  online: number;
  /** Voice channels with somebody in them, busiest first. */
  live: ReadonlyArray<{ name: string; occupants: number }>;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * "8 online, 3 in Lounge" while somebody is in voice, "5 members, 2 online"
 * otherwise (screens 01 and 02). Before the roster is known, only the count the
 * server itself reports: never an "online" it has not seen.
 */
export function serverLine(input: ServerLineInput): string {
  if (!input.rosterKnown) return plural(input.memberCount, 'member', 'members');
  const [busiest, ...others] = input.live;
  if (busiest) {
    if (others.length === 0) return `${input.online} online, ${busiest.occupants} in ${busiest.name}`;
    const total = input.live.reduce((sum, room) => sum + room.occupants, 0);
    return `${input.online} online, ${total} in voice`;
  }
  return `${plural(input.memberCount, 'member', 'members')}, ${input.online} online`;
}

/* ---- Live voice rows --------------------------------------------------------- */

export interface LiveLineInput {
  streamerName: string | null;
  talkingNames: readonly string[];
  occupantNames: readonly string[];
  occupants: number;
}

/** "Vincent is streaming", "Brendan is talking", "3 talking", "Nick is in", "3 in here". */
export function liveLine(input: LiveLineInput): string {
  if (input.streamerName) return `${input.streamerName} is streaming`;
  if (input.talkingNames.length === 1) return `${input.talkingNames[0]} is talking`;
  if (input.talkingNames.length > 1) return `${input.talkingNames.length} talking`;
  if (input.occupants === 1) return `${input.occupantNames[0] ?? 'Someone'} is in`;
  return `${input.occupants} in here`;
}

/**
 * The amber kicker: "LIVE 42 MIN" when the stream's start time is known, else
 * "LIVE". A start time is never invented: this client's own observation of when a
 * call lit up is a lower bound, not the stream's age.
 */
export function liveKicker(streamStartedAt: string | null | undefined, nowMs: number): string {
  if (!streamStartedAt) return 'LIVE';
  const started = Date.parse(streamStartedAt);
  if (!Number.isFinite(started) || started > nowMs) return 'LIVE';
  const minutes = Math.floor((nowMs - started) / 60_000);
  return `LIVE ${minutes} MIN`;
}

/* ---- Coming up --------------------------------------------------------------- */

export interface EventTile {
  /** TODAY, NOW, FRI, OCT: the panel uppercases it. */
  top: string;
  /** 9:30 for today and now, the day of the month otherwise. */
  bottom: string;
}

export interface EventLike {
  startsAt: Date;
  happeningNow: boolean;
  channelId: string | null;
  location: string | null;
  creatorId: string | null;
  going: number;
}

export function eventTile(event: Pick<EventLike, 'startsAt' | 'happeningNow'>, nowMs: number): EventTile {
  const ms = event.startsAt.getTime();
  const days = daysBetween(ms, nowMs);
  if (event.happeningNow) return { top: 'Now', bottom: clockDigits(ms) };
  if (days === 0) return { top: 'Today', bottom: clockDigits(ms) };
  const top = days > -7
    ? new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(ms)
    : new Intl.DateTimeFormat(undefined, { month: 'short' }).format(ms);
  return { top, bottom: String(event.startsAt.getDate()) };
}

/**
 * The line under an event's title (screens 01 and 02): the time when the tile
 * does not already say it, where, whether you are hosting, and how many are going
 * ("9:00 PM, you're hosting, 6 going"; "Lounge, 3 going").
 *
 * The reference also says "1 spot left". Events have no capacity yet (glass-plan
 * §8.6), so that clause is not written.
 */
export function eventLine(
  event: EventLike,
  context: { nowMs: number; selfUserId: string | null; roomName: string | null },
): string {
  const ms = event.startsAt.getTime();
  const tileShowsTime = event.happeningNow || daysBetween(ms, context.nowMs) === 0;
  const time = tileShowsTime ? null : clockWords(ms);
  const place = context.roomName
    ? (time ? `in ${context.roomName}` : context.roomName)
    : event.location
      ? `at ${event.location}`
      : null;
  const head = [time, place].filter(Boolean).join(' ');
  const parts = [
    head || null,
    context.selfUserId && event.creatorId === context.selfUserId ? "you're hosting" : null,
    event.going > 0 ? `${event.going} going` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(', ') || 'Scheduled';
}

/* ---- Times from ids ---------------------------------------------------------- */

/** When a channel's newest message was written, from its id. Null when there is none. */
export function lastMessageTime(lastMessageId: string | null | undefined): number | null {
  if (!lastMessageId || lastMessageId === '0') return null;
  return snowflakeTime(lastMessageId);
}
