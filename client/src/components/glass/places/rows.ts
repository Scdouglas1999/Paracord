/**
 * The channel rows of one server, built from plain data (docs/glass-spec.md
 * §3.1). Pure: `usePlacesData` hands in what the stores hold; this decides, per
 * channel, which row it is and what it says. No store, no React, no clock of its
 * own (`nowMs` comes in).
 *
 *   live   a voice or stage channel with somebody in it: 92px, the room's tint,
 *          amber "LIVE", the occupants' faces, "Vincent is streaming"
 *   text   64px: faces, a picture or a glyph, name, one line, time, badge
 *   quiet  44px: nothing new for a long time (see `isQuietChannel`)
 */

import type { ChannelPreviewEntry, PreviewAuthor } from '../../../hooks/useChannelPreviews';
import type { RoomLight } from '../../../lib/attention/light';
import { ChannelType, type Channel, type ReadState } from '../../../types';
import { isMessageUnread } from '../../../hooks/useUnreadCounts';
import type { PlaceGlyphName } from './Lead';
import {
  badgeFor,
  badgeWords,
  formatRowTime,
  glyphFor,
  isPlaceChannel,
  isQuietChannel,
  isVoiceChannel,
  lastMessageTime,
  leadFaces,
  liveKicker,
  liveLine,
  orderChannels,
  previewLine,
  thumbnailOf,
  type Badge,
  type ChannelGlyph,
  type FaceModel,
  type PreviewContext,
} from './model';

export type RowLead =
  | { kind: 'faces'; faces: FaceModel[]; variant: 'authors' | 'person'; online?: boolean }
  | { kind: 'media'; attachmentId: string; label: string }
  | { kind: 'glyph'; glyph: PlaceGlyphName };

interface RowBase {
  /** A stable id for roving focus and React keys. */
  id: string;
  channelId: string;
  name: string;
  selected: boolean;
}

export interface TextRowModel extends RowBase {
  kind: 'text';
  lead: RowLead;
  /** "Author: text", or null while a channel has nothing to show. */
  line: string | null;
  /** Why there is no line, when there should be one. */
  lineNote: string | null;
  time: string | null;
  timeIso: string | null;
  badge: Badge | null;
  /** A screen reader's summary of the badge ("1 mention"). */
  badgeWords: string | null;
}

export interface QuietRowModel extends RowBase {
  kind: 'quiet';
  glyph: ChannelGlyph;
  time: string | null;
  timeIso: string | null;
}

export interface LiveRowModel extends RowBase {
  kind: 'live';
  kicker: string;
  occupants: FaceModel[];
  /** Everybody in the room, by name, for a screen reader (the faces are pictures). */
  people: string[];
  /** People in the room beyond the faces drawn. */
  more: number;
  talking: boolean;
  line: string;
  streaming: boolean;
  /** Who is streaming, when somebody is: what Watch opens. */
  streamerId: string | null;
}

export type ChannelRowModel = TextRowModel | QuietRowModel | LiveRowModel;

/** Faces drawn on a live row before "+N". */
export const LIVE_FACES = 4;

export interface RowInputs {
  guildId: string;
  /** Already ordered (`orderChannels`). */
  channels: readonly Channel[];
  /** The voice rooms of the server, as light (occupants, who is streaming). */
  rooms: ReadonlyMap<string, RoomLight>;
  previews: ReadonlyMap<string, ChannelPreviewEntry>;
  /** Why previews are not there, when they are not. */
  previewError: string | null;
  recentAuthors: ReadonlyMap<string, readonly PreviewAuthor[]>;
  readStates: Readonly<Record<string, ReadState | undefined>>;
  mutedChannelIds: ReadonlySet<string>;
  guildMuted: boolean;
  /** Known people of the server, for a face's picture when the message has none. */
  people: ReadonlyMap<string, FaceModel>;
  /** Exact unread counts by channel id; null or absent = not known. */
  counts: ReadonlyMap<string, number | null>;
  context: PreviewContext;
  selectedChannelId: string | null;
  nowMs: number;
  /** When a stream began, per channel and streamer, if the server said. */
  streamStartedAt: (channelId: string, userId: string) => string | null;
}

/** A face for an author: what the message told us, filled in from the roster. */
export function faceOf(author: PreviewAuthor, people: ReadonlyMap<string, FaceModel>): FaceModel {
  const known = author.kind === 'user' ? people.get(author.id) : undefined;
  return {
    userId: author.id,
    name: author.name ?? known?.name ?? 'Someone',
    avatar: author.avatar ?? known?.avatar ?? null,
  };
}

/** Is the channel unread, and how many mentions does it hold? From ids alone. */
export function attentionOf(channel: Channel, readState: ReadState | undefined) {
  const unread = isMessageUnread(channel.last_message_id, readState?.last_message_id);
  return { unread, mentions: readState?.mention_count ?? 0 };
}

export function buildChannelRows(input: RowInputs): ChannelRowModel[] {
  const rows: ChannelRowModel[] = [];
  for (const channel of input.channels) {
    const name = channel.name?.trim() || 'Untitled';
    const selected = channel.id === input.selectedChannelId;
    const room = input.rooms.get(channel.id);

    // A live voice channel, whatever else is true of it.
    if (isVoiceChannel(channel.type) && room && room.occupants.length > 0) {
      const streamer = room.screenSharer?.person ?? null;
      const talkers = room.occupants.filter((occupant) => occupant.speaking).map((occupant) => occupant.person.name);
      const faces = room.occupants.map((occupant) => ({
        userId: occupant.person.userId,
        name: occupant.person.name,
        avatar: occupant.person.avatar,
      }));
      rows.push({
        kind: 'live',
        id: `channel:${channel.id}`,
        channelId: channel.id,
        name,
        selected,
        kicker: liveKicker(streamer ? input.streamStartedAt(channel.id, streamer.userId) : null, input.nowMs),
        occupants: faces.slice(0, LIVE_FACES),
        people: faces.map((face) => face.name),
        more: Math.max(0, faces.length - LIVE_FACES),
        talking: talkers.length > 0,
        streaming: Boolean(streamer),
        streamerId: streamer?.userId ?? null,
        line: liveLine({
          streamerName: streamer?.name ?? null,
          talkingNames: talkers,
          occupantNames: room.occupants.map((occupant) => occupant.person.name),
          occupants: room.occupants.length,
        }),
      });
      continue;
    }

    const readState = input.readStates[channel.id];
    const { unread, mentions } = attentionOf(channel, readState);
    const preview = input.previews.get(channel.id) ?? null;
    const lastMs = preview ? Date.parse(preview.createdAt) : lastMessageTime(channel.last_message_id);
    const lastValid = lastMs !== null && Number.isFinite(lastMs) ? lastMs : lastMessageTime(channel.last_message_id);
    const muted = input.guildMuted || input.mutedChannelIds.has(channel.id);
    const timeIso = lastValid !== null ? new Date(lastValid).toISOString() : null;
    const time = formatRowTime(lastValid, input.nowMs);

    // A muted channel says nothing about being unread: that is what muting is.
    const quiet = isQuietChannel({
      lastMessageMs: lastValid,
      nowMs: input.nowMs,
      unread: unread && !muted,
      mentions: muted ? 0 : mentions,
    });
    if (quiet) {
      rows.push({ kind: 'quiet', id: `channel:${channel.id}`, channelId: channel.id, name, selected, glyph: glyphFor(channel.type), time, timeIso });
      continue;
    }

    const known = input.counts.get(channel.id);
    const badge = badgeFor({
      muted,
      mentions,
      unread,
      unreadCount: known === undefined ? null : known,
    });

    const thumb = thumbnailOf(preview);
    const authors = input.recentAuthors.get(channel.id) ?? [];
    const faces = leadFaces(authors.map((author) => faceOf(author, input.people)));
    const lead: RowLead = thumb
      ? { kind: 'media', attachmentId: thumb.attachmentId, label: thumb.label }
      : faces.length > 0
        ? { kind: 'faces', faces, variant: 'authors' }
        : { kind: 'glyph', glyph: glyphFor(channel.type) };

    const line = previewLine(preview, input.context);
    // There is something in the channel and we could not say what: say so, rather
    // than leave a row that looks empty. (Still loading is not an error.)
    const lineNote =
      !line && input.previewError && channel.last_message_id && channel.last_message_id !== '0'
        ? 'Preview unavailable'
        : null;

    rows.push({
      kind: 'text',
      id: `channel:${channel.id}`,
      channelId: channel.id,
      name,
      selected,
      lead,
      line,
      lineNote,
      time,
      timeIso,
      badge,
      badgeWords: badgeWords(badge),
    });
  }
  return rows;
}

/* =============================================================================
   The Index sidebar's rows (docs/index-spec.md §4.5, §4.6)

   One two-line row per text channel (name, time, the last line, an unread dot or
   a mention count), grouped by category; one slim row per voice or stage channel
   under "Rooms". Pure, like everything above: the hook feeds it, the components
   in `components/ix/sidebar` draw what it returns.
   ============================================================================= */

/** A channel row's kind: what glyph (if any) follows its name. */
export type SidebarChannelKind = 'text' | 'announcement' | 'forum';

/** Why a row's second line is not a message, when it is not. */
export type SidebarLineNote = 'topic' | 'empty' | 'unavailable' | 'encrypted' | 'post';

export interface SidebarChannel {
  /** Roving-focus and key id: `channel:<channelId>`. */
  id: string;
  channelId: string;
  name: string;
  kind: SidebarChannelKind;
  selected: boolean;
  /** The second line: "Jeremy: who's up for a run tonight?", a topic, "No messages yet". Null while it is still loading. */
  line: string | null;
  note: SidebarLineNote | null;
  /** The last message is end-to-end encrypted and this client has not read it: the line is "Encrypted" with a lock. */
  encrypted: boolean;
  /** "9:41 PM", "Tue", "Sep 28"; null for a channel with nothing in it. */
  time: string | null;
  timeIso: string | null;
  /** Something unread here, a mention included: a white dot, the ink name and the brighter line. Never on a muted or the open channel. */
  unread: boolean;
  /** Mentions of you, as a white count chip under the time. Never on a muted or the open channel. */
  mentions: number;
  muted: boolean;
  /** Words for a screen reader, after the name: "unread", "2 mentions", "muted". */
  state: string[];
}

export interface SidebarGroup {
  /** `channels` for the uncategorized group, else `category:<id>`. */
  id: string;
  categoryId: string | null;
  /** The label: "Channels", or the category's name in sentence case. */
  label: string;
  channels: SidebarChannel[];
}

export interface SidebarRoom {
  /** `room:<channelId>`. */
  id: string;
  channelId: string;
  name: string;
  stage: boolean;
  /** Somebody is in it. */
  busy: boolean;
  count: number;
  /** "Empty" or "3 here". */
  tail: string;
  /** Up to `ROOM_FACES` of the people in it, for the faces before the count. */
  faces: FaceModel[];
  /** Everybody in it, for a screen reader. */
  people: string[];
  /** Somebody in it is sharing their screen. */
  streaming: boolean;
}

/** Faces a busy room row draws before its count. */
export const ROOM_FACES = 3;

const byPosition = (a: Pick<Channel, 'position' | 'id'>, b: Pick<Channel, 'position' | 'id'>) =>
  (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id, undefined, { numeric: true });

/**
 * "TEXT CHANNELS" is an imported habit, and the sidebar's labels are sentence
 * case (§1.5): a name written in capitals is written as a sentence. Only a name
 * that is plainly shouting is touched: all capitals, every word of four letters
 * or more, and either two words or one of five. A short one ("LFG", "FPS 2",
 * "Q&A", "NSFW") is more likely an acronym than a habit, and any name with a
 * lowercase letter is the server's own choice; both are left as written.
 */
export function categoryLabel(name: string | null | undefined): string {
  const text = (name ?? '').trim();
  if (!text) return 'Channels';
  const words = text.split(/\s+/);
  const letters = (word: string) => word.replace(/[^\p{L}]/gu, '');
  const shouting =
    words.every((word) => letters(word).length >= 4 && letters(word) === letters(word).toUpperCase())
    && (words.length >= 2 || letters(words[0]).length >= 5);
  return shouting ? text.charAt(0).toUpperCase() + text.slice(1).toLowerCase() : text;
}

/**
 * The channels' text-like rows in groups: the uncategorized ones first (under
 * "Channels"), then each category in position order, each with its channels in
 * position order. A group with nothing in it is left out. Voice and stage
 * channels are Rooms, not channels, and are not here. A channel whose category
 * is gone is uncategorized.
 */
export function groupChannels(channels: readonly Channel[]): Array<{ category: Channel | null; channels: Channel[] }> {
  const categories = channels.filter((channel) => channel.type === ChannelType.Category).sort(byPosition);
  const categoryIds = new Set(categories.map((category) => category.id));
  const textLike = channels.filter((channel) => isPlaceChannel(channel.type) && !isVoiceChannel(channel.type));
  const groups: Array<{ category: Channel | null; channels: Channel[] }> = [];
  const loose = textLike.filter((channel) => !channel.parent_id || !categoryIds.has(channel.parent_id)).sort(byPosition);
  if (loose.length > 0) groups.push({ category: null, channels: loose });
  for (const category of categories) {
    const own = textLike.filter((channel) => channel.parent_id === category.id).sort(byPosition);
    if (own.length > 0) groups.push({ category, channels: own });
  }
  return groups;
}

/** Somebody in a voice room, as a row needs them (a face, a name, whether they share a screen). */
export interface RoomOccupant {
  userId: string;
  name: string;
  avatar: string | null;
  sharingScreen: boolean;
}

export interface SidebarInputs {
  /** Every channel of the server the store holds (categories and threads included). */
  channels: readonly Channel[];
  previews: ReadonlyMap<string, ChannelPreviewEntry>;
  /** Whether previews are here yet: `ready` is the only state in which "No messages yet" is true. */
  previewStatus: 'idle' | 'loading' | 'ready' | 'error';
  readStates: Readonly<Record<string, ReadState | undefined>>;
  mutedChannelIds: ReadonlySet<string>;
  guildMuted: boolean;
  context: PreviewContext;
  selectedChannelId: string | null;
  nowMs: number;
}

function kindOf(type: Channel['type']): SidebarChannelKind {
  return type === ChannelType.Announcement ? 'announcement' : type === ChannelType.Forum ? 'forum' : 'text';
}

/** "unread", "2 mentions": what a row's dot and chip say in words, with "muted" for a muted channel. */
function stateWords(muted: boolean, unread: boolean, mentions: number): string[] {
  if (muted) return ['muted'];
  const words: string[] = [];
  if (unread) words.push('unread');
  if (mentions > 0) words.push(mentions === 1 ? '1 mention' : `${mentions} mentions`);
  return words;
}

/** The newest post of a forum: its thread channel with the greatest id, from the threads the store holds. */
function latestPost(forumId: string, channels: readonly Channel[]): Channel | null {
  let best: Channel | null = null;
  for (const channel of channels) {
    if (channel.type !== ChannelType.Thread || channel.parent_id !== forumId) continue;
    if (!best || channel.id.localeCompare(best.id, undefined, { numeric: true }) > 0) best = channel;
  }
  return best;
}

export function buildSidebarGroups(input: SidebarInputs): SidebarGroup[] {
  return groupChannels(input.channels).map(({ category, channels }) => ({
    id: category ? `category:${category.id}` : 'channels',
    categoryId: category?.id ?? null,
    label: category ? categoryLabel(category.name) : 'Channels',
    channels: channels.map((channel): SidebarChannel => {
      const name = channel.name?.trim() || 'Untitled';
      const selected = channel.id === input.selectedChannelId;
      const muted = input.guildMuted || input.mutedChannelIds.has(channel.id);
      const { unread, mentions } = attentionOf(channel, input.readStates[channel.id]);
      // The channel you are reading is read as you read it; a muted one says nothing.
      const quiet = muted || selected;
      const shownMentions = quiet ? 0 : mentions;
      const shownUnread = !quiet && (unread || mentions > 0);
      const preview = input.previews.get(channel.id) ?? null;
      const post = channel.type === ChannelType.Forum ? latestPost(channel.id, input.channels) : null;

      const fromPreview = preview ? Date.parse(preview.createdAt) : lastMessageTime(channel.last_message_id);
      const lastMs = fromPreview !== null && Number.isFinite(fromPreview) ? fromPreview : lastMessageTime(channel.last_message_id);
      const when = post ? lastMessageTime(post.id) ?? lastMs : lastMs;
      const empty = !channel.last_message_id || channel.last_message_id === '0';

      let line: string | null = null;
      let note: SidebarLineNote | null = null;
      let encrypted = false;
      if (post) {
        line = post.name?.trim() || 'Untitled post';
        note = 'post';
      } else if (preview?.encrypted) {
        encrypted = true;
        note = 'encrypted';
      } else if (preview) {
        line = previewLine(preview, input.context);
      } else if (empty) {
        // The channel record itself says nothing was ever posted: no need to wait for previews.
        const topic = channel.topic?.trim();
        if (topic) {
          line = topic;
          note = 'topic';
        } else if (channel.type !== ChannelType.Forum) {
          line = 'No messages yet';
          note = 'empty';
        }
      } else if (input.previewStatus === 'error') {
        line = 'Preview unavailable';
        note = 'unavailable';
      } else if (input.previewStatus === 'ready' && channel.topic?.trim()) {
        line = channel.topic.trim();
        note = 'topic';
      }

      return {
        id: `channel:${channel.id}`,
        channelId: channel.id,
        name,
        kind: kindOf(channel.type),
        selected,
        line,
        note,
        encrypted,
        time: formatRowTime(when, input.nowMs),
        timeIso: when !== null ? new Date(when).toISOString() : null,
        unread: shownUnread,
        mentions: shownMentions,
        muted,
        state: stateWords(muted, shownUnread, shownMentions),
      };
    }),
  }));
}

/**
 * Every voice and stage channel, in the server's order: category order, then
 * position. The sidebar leaves out the one the live card shows (the card's own
 * choice, `useInlineCardRoom`), so a room is never both or neither.
 */
export function buildSidebarRooms(
  channels: readonly Channel[],
  occupancy: ReadonlyMap<string, readonly RoomOccupant[]>,
): SidebarRoom[] {
  return orderChannels(channels)
    .filter((channel) => isVoiceChannel(channel.type))
    .map((channel): SidebarRoom => {
      const occupants = occupancy.get(channel.id) ?? [];
      const count = occupants.length;
      return {
        id: `room:${channel.id}`,
        channelId: channel.id,
        name: channel.name?.trim() || 'Untitled',
        stage: channel.type === ChannelType.Stage,
        busy: count > 0,
        count,
        tail: count > 0 ? `${count} here` : 'Empty',
        faces: occupants.slice(0, ROOM_FACES).map((occupant) => ({
          userId: occupant.userId,
          name: occupant.name,
          avatar: occupant.avatar,
        })),
        people: occupants.map((occupant) => occupant.name),
        streaming: occupants.some((occupant) => occupant.sharingScreen),
      };
    });
}
