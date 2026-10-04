import { describe, expect, it } from 'vitest';

import type { ChannelPreviewEntry } from '../../../hooks/useChannelPreviews';
import { ChannelType, type Channel, type ReadState } from '../../../types';
import {
  ROOM_FACES,
  buildSidebarGroups,
  buildSidebarRooms,
  categoryLabel,
  groupChannels,
  type RoomOccupant,
  type SidebarInputs,
} from './rows';

const NOW = new Date(2026, 9, 1, 21, 38).getTime();
const EPOCH_MS = 1704067200000;
const idAt = (ms: number, seq = 0) => ((BigInt(ms - EPOCH_MS) << 22n) + BigInt(seq)).toString();

function channel(over: Partial<Channel> & Pick<Channel, 'id' | 'name'>): Channel {
  return { type: ChannelType.Text, position: 0, nsfw: false, created_at: '2026-01-01T00:00:00Z', ...over } as Channel;
}

function preview(over: Partial<ChannelPreviewEntry> & Pick<ChannelPreviewEntry, 'channelId'>): ChannelPreviewEntry {
  return {
    messageId: '1',
    messageType: 0,
    author: { id: 'u2', kind: 'user', name: 'Jeremy', avatar: null },
    content: 'who’s up for a run tonight?',
    encrypted: false,
    createdAt: new Date(NOW - 3 * 60_000).toISOString(),
    media: null,
    attachmentCount: 0,
    hasSticker: false,
    ...over,
  };
}

function inputs(over: Partial<SidebarInputs> = {}): SidebarInputs {
  return {
    channels: [],
    previews: new Map(),
    previewStatus: 'ready',
    readStates: {},
    mutedChannelIds: new Set(),
    guildMuted: false,
    context: { selfUserId: 'u1', memberNames: new Map(), channelNames: new Map(), eventNames: new Map() },
    selectedChannelId: null,
    nowMs: NOW,
    ...over,
  };
}

/** A channel whose newest message was `minutesAgo` minutes ago. */
const active = (id: string, name: string, minutesAgo = 3, over: Partial<Channel> = {}) =>
  channel({ id, name, last_message_id: idAt(NOW - minutesAgo * 60_000), ...over });

const read = (channelId: string, lastMessageId: string, mentions = 0): ReadState =>
  ({ channel_id: channelId, last_message_id: lastMessageId, mention_count: mentions }) as ReadState;

const rowsOf = (input: SidebarInputs) => buildSidebarGroups(input).flatMap((group) => group.channels);
const rowOf = (input: SidebarInputs, id: string) => {
  const row = rowsOf(input).find((candidate) => candidate.channelId === id);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
};

describe('category labels', () => {
  it('writes an imported ALL CAPS name as a sentence, and leaves a name with any lowercase as the server wrote it', () => {
    expect(categoryLabel('TEXT CHANNELS')).toBe('Text channels');
    expect(categoryLabel('VOICE CHANNELS')).toBe('Voice channels');
    expect(categoryLabel('ANNOUNCEMENTS')).toBe('Announcements');
    expect(categoryLabel('Game Night')).toBe('Game Night');
    expect(categoryLabel('GAME night')).toBe('GAME night');
  });

  it('leaves what is more likely an acronym than a habit: a short word, one word', () => {
    expect(categoryLabel('LFG')).toBe('LFG');
    expect(categoryLabel('FPS 2')).toBe('FPS 2');
    expect(categoryLabel('Q&A')).toBe('Q&A');
    expect(categoryLabel('FPS GAMES')).toBe('FPS GAMES');
    expect(categoryLabel('NSFW')).toBe('NSFW');
  });

  it('keeps names that have no letters to case, and says "Channels" for none', () => {
    expect(categoryLabel('2026')).toBe('2026');
    expect(categoryLabel('  ')).toBe('Channels');
    expect(categoryLabel(null)).toBe('Channels');
  });
});

describe('channel groups', () => {
  const category = (id: string, name: string, position: number) => channel({ id, name, type: ChannelType.Category, position });

  it('puts the uncategorized channels first, then each category by position, channels by position inside', () => {
    const groups = groupChannels([
      category('cat2', 'Later', 2),
      channel({ id: 'b', name: 'b', position: 2, parent_id: 'cat1' }),
      category('cat1', 'Sooner', 1),
      channel({ id: 'a', name: 'a', position: 1, parent_id: 'cat1' }),
      channel({ id: 'loose2', name: 'loose2', position: 5 }),
      channel({ id: 'loose1', name: 'loose1', position: 4 }),
      channel({ id: 'c', name: 'c', parent_id: 'cat2' }),
    ]);
    expect(groups.map((group) => [group.category?.id ?? null, group.channels.map((entry) => entry.id)])).toEqual([
      [null, ['loose1', 'loose2']],
      ['cat1', ['a', 'b']],
      ['cat2', ['c']],
    ]);
  });

  it('leaves out voice and stage channels (they are Rooms), threads, and categories with nothing in them', () => {
    const groups = groupChannels([
      category('cat1', 'Voice only', 1),
      category('cat2', 'Empty', 2),
      channel({ id: 'v', name: 'Lounge', type: ChannelType.Voice, parent_id: 'cat1' }),
      channel({ id: 's', name: 'Stage', type: ChannelType.Stage, parent_id: 'cat1' }),
      channel({ id: 't', name: 'thread', type: ChannelType.Thread, parent_id: 'cat1' }),
      channel({ id: 'general', name: 'general' }),
    ]);
    expect(groups.map((group) => group.channels.map((entry) => entry.id))).toEqual([['general']]);
  });

  it('keeps announcement and forum channels, and treats a channel whose category is gone as uncategorized', () => {
    const groups = groupChannels([
      channel({ id: 'news', name: 'news', type: ChannelType.Announcement }),
      channel({ id: 'posts', name: 'posts', type: ChannelType.Forum }),
      channel({ id: 'orphan', name: 'orphan', parent_id: 'deleted' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBeNull();
    expect(groups[0].channels.map((entry) => entry.id).sort()).toEqual(['news', 'orphan', 'posts']);
  });

  it('labels the groups: "Channels", then each category as a sentence, with the roving ids', () => {
    const groups = buildSidebarGroups(
      inputs({ channels: [category('cat1', 'TEXT CHANNELS', 1), channel({ id: 'a', name: 'a', parent_id: 'cat1' }), channel({ id: 'g', name: 'g' })] }),
    );
    expect(groups.map((group) => [group.id, group.categoryId, group.label])).toEqual([
      ['channels', null, 'Channels'],
      ['category:cat1', 'cat1', 'Text channels'],
    ]);
    expect(groups[1].channels[0].id).toBe('channel:a');
  });
});

describe('a channel row: the line under the name', () => {
  it('is "Author: text" for the newest message, with its time', () => {
    const general = active('g', 'general');
    const row = rowOf(inputs({ channels: [general], previews: new Map([['g', preview({ channelId: 'g' })]]) }), 'g');
    expect(row).toMatchObject({ name: 'general', line: 'Jeremy: who’s up for a run tonight?', note: null, time: '9:35 PM' });
    expect(row.timeIso).toBe(new Date(NOW - 3 * 60_000).toISOString());
  });

  it('says "No messages yet" for a channel nothing was ever posted in, without waiting for previews', () => {
    const quiet = channel({ id: 'q', name: 'general' });
    expect(rowOf(inputs({ channels: [quiet], previewStatus: 'loading' }), 'q')).toMatchObject({ line: 'No messages yet', note: 'empty', time: null });
  });

  it('shows the topic of a channel with no message, in place of "No messages yet"', () => {
    const clips = channel({ id: 'c', name: 'clips', topic: 'Share your best moments' });
    expect(rowOf(inputs({ channels: [clips] }), 'c')).toMatchObject({ line: 'Share your best moments', note: 'topic' });
  });

  it('is blank, not a guess, while previews are still on their way for a channel that has messages', () => {
    const busy = active('g', 'general', 3, { topic: 'a topic that is not the news' });
    expect(rowOf(inputs({ channels: [busy], previewStatus: 'loading' }), 'g')).toMatchObject({ line: null, note: null });
    expect(rowOf(inputs({ channels: [busy], previewStatus: 'idle' }), 'g').line).toBeNull();
  });

  it('says so when previews could not be read for a channel that has messages', () => {
    const busy = active('g', 'general');
    expect(rowOf(inputs({ channels: [busy], previewStatus: 'error' }), 'g')).toMatchObject({ line: 'Preview unavailable', note: 'unavailable' });
  });

  it('writes media and events the way the reference does', () => {
    const image = { attachmentId: 'a', contentType: 'image/png', filename: 'x.png', width: 1, height: 1 };
    const shots = active('s', 'screenshots');
    const row = rowOf(
      inputs({
        channels: [shots],
        previews: new Map([['s', preview({ channelId: 's', author: { id: 'u3', kind: 'user', name: 'Nick', avatar: null }, content: null, media: image, attachmentCount: 4 })]]),
      }),
      's',
    );
    expect(row.line).toBe('Nick posted 4 photos');
    const plans = active('p', 'plans', 1);
    const friday = new Date(2026, 9, 2, 21, 0);
    const event = rowOf(
      inputs({
        channels: [plans],
        previews: new Map([['p', preview({ channelId: 'p', content: '<event:7002>' })]]),
        context: { selfUserId: 'u1', memberNames: new Map(), channelNames: new Map(), eventNames: new Map(), events: new Map([['7002', { name: 'Movie night', startsAt: friday }]]), nowMs: NOW },
      }),
      'p',
    );
    expect(event.line).toBe('Movie night · Fri 9 PM');
  });

  it('is "Encrypted" with a lock for a message this client has not read, and never shows its text', () => {
    const secret = active('e', 'private');
    const row = rowOf(inputs({ channels: [secret], previews: new Map([['e', preview({ channelId: 'e', encrypted: true, content: null })]]) }), 'e');
    expect(row).toMatchObject({ encrypted: true, line: null, note: 'encrypted' });
  });

  it('previews a forum by the title of its newest post, from the posts the client has', () => {
    const forum = channel({ id: 'f', name: 'feedback', type: ChannelType.Forum, last_message_id: idAt(NOW - 60_000) });
    const old = channel({ id: idAt(NOW - 3 * 3600_000), name: 'Old post', type: ChannelType.Thread, parent_id: 'f' });
    const fresh = channel({ id: idAt(NOW - 10 * 60_000), name: 'Voice chat is great', type: ChannelType.Thread, parent_id: 'f' });
    const row = rowOf(inputs({ channels: [forum, old, fresh] }), 'f');
    expect(row).toMatchObject({ kind: 'forum', line: 'Voice chat is great', note: 'post', time: '9:28 PM' });
  });

  it('does not claim a forum is empty: with no posts known it shows its topic, or nothing', () => {
    const forum = channel({ id: 'f', name: 'feedback', type: ChannelType.Forum });
    expect(rowOf(inputs({ channels: [forum] }), 'f').line).toBeNull();
    expect(rowOf(inputs({ channels: [{ ...forum, topic: 'Ideas and bugs' }] }), 'f').line).toBe('Ideas and bugs');
  });

  it('marks an announcement channel for its megaphone', () => {
    expect(rowOf(inputs({ channels: [channel({ id: 'n', name: 'news', type: ChannelType.Announcement })] }), 'n').kind).toBe('announcement');
  });
});

describe('a channel row: what needs you', () => {
  const lastRead = idAt(NOW - 3 * 3600_000);

  it('is unread when the newest message is past your read position, and says so for a screen reader', () => {
    const clips = active('c', 'clips', 3);
    const row = rowOf(inputs({ channels: [clips], readStates: { c: read('c', lastRead) } }), 'c');
    expect(row).toMatchObject({ unread: true, mentions: 0, muted: false, state: ['unread'] });
  });

  it('is read when you are caught up', () => {
    const clips = active('c', 'clips', 3);
    expect(rowOf(inputs({ channels: [clips], readStates: { c: read('c', clips.last_message_id as string) } }), 'c')).toMatchObject({ unread: false, state: [] });
  });

  it('counts mentions, and a mention is also unread', () => {
    const plans = active('p', 'plans');
    const row = rowOf(inputs({ channels: [plans], readStates: { p: read('p', lastRead, 2) } }), 'p');
    expect(row).toMatchObject({ unread: true, mentions: 2, state: ['unread', '2 mentions'] });
    expect(rowOf(inputs({ channels: [plans], readStates: { p: read('p', lastRead, 1) } }), 'p').state).toEqual(['unread', '1 mention']);
  });

  it('says nothing about a muted channel, whatever is in it (muting is that)', () => {
    const clips = active('c', 'clips');
    const row = rowOf(inputs({ channels: [clips], readStates: { c: read('c', lastRead, 3) }, mutedChannelIds: new Set(['c']) }), 'c');
    expect(row).toMatchObject({ unread: false, mentions: 0, muted: true, state: ['muted'] });
    // A muted server mutes every channel in it.
    expect(rowOf(inputs({ channels: [clips], readStates: { c: read('c', lastRead) }, guildMuted: true }), 'c').muted).toBe(true);
  });

  it('says nothing about the channel you are reading: you are reading it', () => {
    const general = active('g', 'general');
    const row = rowOf(inputs({ channels: [general], selectedChannelId: 'g', readStates: { g: read('g', lastRead, 2) } }), 'g');
    expect(row).toMatchObject({ selected: true, unread: false, mentions: 0 });
  });
});

describe('time labels', () => {
  it('writes today as a clock time, the week as a weekday, and older as a date', () => {
    const today = active('a', 'a', 3);
    const week = channel({ id: 'b', name: 'b', last_message_id: idAt(new Date(2026, 8, 26, 1, 12).getTime()) });
    const old = channel({ id: 'c', name: 'c', last_message_id: idAt(new Date(2026, 7, 12, 14, 0).getTime()) });
    const input = inputs({ channels: [today, week, old] });
    expect(rowOf(input, 'a').time).toBe('9:35 PM');
    expect(rowOf(input, 'b').time).toBe('Sat');
    expect(rowOf(input, 'c').time).toBe('Aug 12');
  });
});

describe('rooms', () => {
  const who = (id: string, name: string, sharingScreen = false): RoomOccupant => ({ userId: id, name, avatar: null, sharingScreen });
  const voice = (id: string, name: string, position: number, over: Partial<Channel> = {}) =>
    channel({ id, name, type: ChannelType.Voice, position, ...over });

  it('lists every voice and stage channel in the server’s order, as "Empty" or "N here"', () => {
    const rooms = buildSidebarRooms(
      [
        channel({ id: 'text', name: 'general' }),
        voice('late', 'Late night', 2),
        voice('gen', 'General', 1),
        channel({ id: 'stage', name: 'Town hall', type: ChannelType.Stage, position: 3 }),
      ],
      new Map([['gen', [who('u2', 'Jeremy'), who('u3', 'Vincent')]]]),
    );
    expect(rooms.map((room) => [room.id, room.name, room.tail, room.busy, room.stage])).toEqual([
      ['room:gen', 'General', '2 here', true, false],
      ['room:late', 'Late night', 'Empty', false, false],
      ['room:stage', 'Town hall', 'Empty', false, true],
    ]);
  });

  it('draws up to three faces, names everyone for a screen reader, and notes a stream', () => {
    const six = ['A', 'B', 'C', 'D', 'E', 'F'].map((name) => who(`u-${name}`, name, name === 'C'));
    const [room] = buildSidebarRooms([voice('lounge', 'Lounge', 1)], new Map([['lounge', six]]));
    expect(ROOM_FACES).toBe(3);
    expect(room.faces).toHaveLength(3);
    expect(room.count).toBe(6);
    expect(room.tail).toBe('6 here');
    expect([...room.people].sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(room.streaming).toBe(true);
  });

  it('orders rooms by category, then position, like the channels', () => {
    const rooms = buildSidebarRooms(
      [
        channel({ id: 'cat', name: 'Calls', type: ChannelType.Category, position: 1 }),
        voice('in', 'In a category', 1, { parent_id: 'cat' }),
        voice('loose', 'Loose', 9),
      ],
      new Map(),
    );
    expect(rooms.map((room) => room.channelId)).toEqual(['loose', 'in']);
  });
});
