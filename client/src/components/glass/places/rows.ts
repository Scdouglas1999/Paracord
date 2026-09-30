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
import type { Channel, ReadState } from '../../../types';
import { isMessageUnread } from '../../../hooks/useUnreadCounts';
import type { PlaceGlyphName } from './Lead';
import {
  badgeFor,
  badgeWords,
  formatRowTime,
  glyphFor,
  isQuietChannel,
  isVoiceChannel,
  lastMessageTime,
  leadFaces,
  liveKicker,
  liveLine,
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
