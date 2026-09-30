import { describe, expect, it } from 'vitest';

import type { ChannelPreviewEntry } from '../../../hooks/useChannelPreviews';
import { personLight, voiceRoomLight, type RoomLight } from '../../../lib/attention/light';
import { ChannelType, type Channel } from '../../../types';
import { QUIET_AFTER_MS } from './model';
import { buildChannelRows, faceOf, LIVE_FACES, type RowInputs } from './rows';

const SCOPE = { serverId: 'srv', userId: 'u1' };
const NOW = new Date(2026, 9, 1, 21, 12).getTime();
const EPOCH_MS = 1704067200000;

/** A snowflake for a moment, so `last_message_id` decodes to that time. */
const idAt = (ms: number, seq = 0) => ((BigInt(ms - EPOCH_MS) << 22n) + BigInt(seq)).toString();

function channel(over: Partial<Channel> & Pick<Channel, 'id' | 'name'>): Channel {
  return { type: ChannelType.Text, position: 0, nsfw: false, created_at: '2026-01-01T00:00:00Z', ...over } as Channel;
}

function preview(over: Partial<ChannelPreviewEntry> & Pick<ChannelPreviewEntry, 'channelId'>): ChannelPreviewEntry {
  return {
    messageId: '1',
    messageType: 0,
    author: { id: 'u2', kind: 'user', name: 'Jeremy', avatar: null },
    content: 'hello',
    encrypted: false,
    createdAt: new Date(NOW - 60_000).toISOString(),
    media: null,
    attachmentCount: 0,
    hasSticker: false,
    ...over,
  };
}

function inputs(over: Partial<RowInputs> = {}): RowInputs {
  return {
    guildId: 'g1',
    channels: [],
    rooms: new Map(),
    previews: new Map(),
    previewError: null,
    recentAuthors: new Map(),
    readStates: {},
    mutedChannelIds: new Set(),
    guildMuted: false,
    people: new Map(),
    counts: new Map(),
    context: { selfUserId: 'u1', memberNames: new Map(), channelNames: new Map() },
    selectedChannelId: null,
    nowMs: NOW,
    streamStartedAt: () => null,
    ...over,
  };
}

const person = (id: string, name: string) => personLight({ userId: id, name, status: 'online', avatar: null });

function loungeWith(over: { streaming?: boolean; talking?: boolean; count?: number } = {}): RoomLight {
  const names = ['Vincent', 'Brendan', 'Nick', 'Jeremy', 'Luke', 'Eric'];
  const occupants = names.slice(0, over.count ?? 3).map((name, index) => ({
    person: person(`p${index}`, name),
    speaking: over.talking ? index === 1 : false,
    sharingScreen: over.streaming ? index === 0 : false,
  }));
  return voiceRoomLight({ scope: SCOPE, guildId: 'g1', channelId: 'lounge', name: 'Lounge', occupants, nowMs: NOW });
}

describe('live rows', () => {
  const lounge = channel({ id: 'lounge', name: 'Lounge', type: ChannelType.Voice });

  it('is a live row for a voice channel with somebody in it', () => {
    const [row] = buildChannelRows(inputs({ channels: [lounge], rooms: new Map([['lounge', loungeWith({ streaming: true, talking: true })]]) }));
    expect(row).toMatchObject({
      kind: 'live',
      name: 'Lounge',
      kicker: 'LIVE',
      streaming: true,
      streamerId: 'p0',
      talking: true,
      line: 'Vincent is streaming',
    });
    if (row.kind !== 'live') throw new Error('not live');
    expect(row.occupants.map((face) => face.name).sort()).toEqual(['Brendan', 'Nick', 'Vincent']);
    expect([...row.people].sort()).toEqual(['Brendan', 'Nick', 'Vincent']);
  });

  it('writes the minutes when the streamer’s start time is known', () => {
    const started = new Date(NOW - 42 * 60_000).toISOString();
    const [row] = buildChannelRows(
      inputs({
        channels: [lounge],
        rooms: new Map([['lounge', loungeWith({ streaming: true })]]),
        streamStartedAt: (channelId, userId) => (channelId === 'lounge' && userId === 'p0' ? started : null),
      }),
    );
    expect(row).toMatchObject({ kind: 'live', kicker: 'LIVE 42 MIN' });
  });

  it('has nothing to watch when nobody is streaming', () => {
    const [row] = buildChannelRows(inputs({ channels: [lounge], rooms: new Map([['lounge', loungeWith({ talking: true })]]) }));
    expect(row).toMatchObject({ kind: 'live', streaming: false, streamerId: null, line: 'Brendan is talking' });
  });

  it('draws a few faces and counts the rest', () => {
    const [row] = buildChannelRows(inputs({ channels: [lounge], rooms: new Map([['lounge', loungeWith({ count: 6 })]]) }));
    if (row.kind !== 'live') throw new Error('not live');
    expect(row.occupants).toHaveLength(LIVE_FACES);
    expect(row.more).toBe(2);
    // The names are all there for a screen reader, faces or not.
    expect(row.people).toHaveLength(6);
  });

  it('is a plain row when nobody is in the voice channel', () => {
    const empty = voiceRoomLight({ scope: SCOPE, guildId: 'g1', channelId: 'lounge', name: 'Lounge', occupants: [], nowMs: NOW });
    const [row] = buildChannelRows(inputs({ channels: [lounge], rooms: new Map([['lounge', empty]]) }));
    expect(row.kind).not.toBe('live');
  });

  it('is selected when its channel is the one in the address', () => {
    const [row] = buildChannelRows(inputs({ channels: [lounge], rooms: new Map([['lounge', loungeWith()]]), selectedChannelId: 'lounge' }));
    expect(row.selected).toBe(true);
  });
});

describe('text rows', () => {
  const general = channel({ id: 'general', name: 'General', last_message_id: idAt(NOW - 3 * 60_000) });

  it('carries the line, the time and the last speakers’ faces', () => {
    const [row] = buildChannelRows(
      inputs({
        channels: [general],
        previews: new Map([['general', preview({ channelId: 'general', content: 'movie night?', createdAt: new Date(NOW - 3 * 60_000).toISOString() })]]),
        recentAuthors: new Map([
          [
            'general',
            [
              { id: 'jeremy', kind: 'user', name: 'Jeremy', avatar: null },
              { id: 'nick', kind: 'user', name: 'Nick', avatar: null },
            ],
          ],
        ]),
        readStates: { general: { channel_id: 'general', last_message_id: general.last_message_id!, mention_count: 0 } },
      }),
    );
    expect(row).toMatchObject({ kind: 'text', name: 'General', line: 'Jeremy: movie night?', time: '9:09 PM', badge: null });
    if (row.kind !== 'text') throw new Error('not text');
    expect(row.lead).toMatchObject({ kind: 'faces', variant: 'authors' });
    expect(row.lead.kind === 'faces' && row.lead.faces.map((face) => face.userId)).toEqual(['nick', 'jeremy']);
  });

  it('leads with the latest picture when the latest message has one', () => {
    const [row] = buildChannelRows(
      inputs({
        channels: [general],
        previews: new Map([
          ['general', preview({ channelId: 'general', media: { attachmentId: 'a9', contentType: 'image/png', filename: 'x.png', width: 1, height: 1 }, attachmentCount: 1 })],
        ]),
        readStates: { general: { channel_id: 'general', last_message_id: general.last_message_id!, mention_count: 0 } },
      }),
    );
    if (row.kind !== 'text') throw new Error('not text');
    expect(row.lead).toMatchObject({ kind: 'media', attachmentId: 'a9' });
  });

  it('leads with a glyph tile when nobody is known', () => {
    const [row] = buildChannelRows(
      inputs({
        channels: [general],
        readStates: { general: { channel_id: 'general', last_message_id: general.last_message_id!, mention_count: 0 } },
      }),
    );
    if (row.kind !== 'text') throw new Error('not text');
    expect(row.lead).toEqual({ kind: 'glyph', glyph: 'chat' });
    // The time still comes from the id, before the preview arrives.
    expect(row.time).toBe('9:09 PM');
    expect(row.line).toBeNull();
  });

  it('shows a white mention badge, whatever the count', () => {
    const [row] = buildChannelRows(
      inputs({
        channels: [general],
        previews: new Map([['general', preview({ channelId: 'general' })]]),
        readStates: { general: { channel_id: 'general', last_message_id: '1', mention_count: 1 } },
        counts: new Map([['general', 6]]),
      }),
    );
    if (row.kind !== 'text') throw new Error('not text');
    expect(row.badge).toEqual({ kind: 'mention', count: 1, label: '@' });
    expect(row.badgeWords).toBe('1 mention');
  });

  it('shows the exact unread count when it is known, and a dot when it is not', () => {
    const state = { general: { channel_id: 'general', last_message_id: '1', mention_count: 0 } };
    const known = buildChannelRows(inputs({ channels: [general], readStates: state, counts: new Map([['general', 3]]) }))[0];
    const unknown = buildChannelRows(inputs({ channels: [general], readStates: state, counts: new Map([['general', null]]) }))[0];
    const absent = buildChannelRows(inputs({ channels: [general], readStates: state }))[0];
    if (known.kind !== 'text' || unknown.kind !== 'text' || absent.kind !== 'text') throw new Error('not text');
    expect(known.badge).toEqual({ kind: 'count', count: 3, label: '3' });
    expect(unknown.badge).toEqual({ kind: 'dot' });
    expect(absent.badge).toEqual({ kind: 'dot' });
  });

  it('treats a channel never opened as unread, and one read to its tail as read', () => {
    const neverOpened = buildChannelRows(inputs({ channels: [general] }))[0];
    const read = buildChannelRows(
      inputs({ channels: [general], readStates: { general: { channel_id: 'general', last_message_id: general.last_message_id!, mention_count: 0 } } }),
    )[0];
    if (neverOpened.kind !== 'text' || read.kind !== 'text') throw new Error('not text');
    expect(neverOpened.badge).toEqual({ kind: 'dot' });
    expect(read.badge).toBeNull();
  });

  it('says nothing about being unread in a muted channel or a muted server', () => {
    const state = { general: { channel_id: 'general', last_message_id: '1', mention_count: 2 } };
    const mutedChannel = buildChannelRows(inputs({ channels: [general], readStates: state, mutedChannelIds: new Set(['general']) }))[0];
    const mutedServer = buildChannelRows(inputs({ channels: [general], readStates: state, guildMuted: true }))[0];
    if (mutedChannel.kind !== 'text' || mutedServer.kind !== 'text') throw new Error('muted rows are quiet or text');
    expect(mutedChannel.badge).toBeNull();
    expect(mutedServer.badge).toBeNull();
  });

  it('says why a channel has no line when the previews could not be loaded', () => {
    const [row] = buildChannelRows(
      inputs({
        channels: [general],
        previewError: 'nope',
        readStates: { general: { channel_id: 'general', last_message_id: general.last_message_id!, mention_count: 0 } },
      }),
    );
    if (row.kind !== 'text') throw new Error('not text');
    expect(row.line).toBeNull();
    expect(row.lineNote).toBe('Preview unavailable');
  });

  it('is a text row with the voice glyph for a voice channel nobody is in but that has chat', () => {
    const empty = channel({ id: 'v', name: 'Lounge', type: ChannelType.Voice, last_message_id: idAt(NOW - 60_000) });
    const [row] = buildChannelRows(
      inputs({ channels: [empty], readStates: { v: { channel_id: 'v', last_message_id: empty.last_message_id!, mention_count: 0 } } }),
    );
    if (row.kind !== 'text') throw new Error('not text');
    expect(row.lead).toEqual({ kind: 'glyph', glyph: 'voice' });
  });
});

describe('quiet rows', () => {
  const old = idAt(NOW - QUIET_AFTER_MS - 60_000);

  it('is one line for a channel nothing has happened in for more than a week', () => {
    const patch = channel({ id: 'patch', name: 'Patch notes', last_message_id: old });
    const [row] = buildChannelRows(inputs({ channels: [patch], readStates: { patch: { channel_id: 'patch', last_message_id: old, mention_count: 0 } } }));
    expect(row).toMatchObject({ kind: 'quiet', name: 'Patch notes', glyph: 'chat' });
  });

  it('is one line for a channel that never had a message', () => {
    const [row] = buildChannelRows(inputs({ channels: [channel({ id: 'empty', name: 'Empty' })] }));
    expect(row).toMatchObject({ kind: 'quiet', time: null });
  });

  it('is a full row again when something is unread or mentions you', () => {
    const patch = channel({ id: 'patch', name: 'Patch notes', last_message_id: old });
    const unread = buildChannelRows(inputs({ channels: [patch], readStates: { patch: { channel_id: 'patch', last_message_id: '1', mention_count: 0 } } }))[0];
    const mention = buildChannelRows(inputs({ channels: [patch], readStates: { patch: { channel_id: 'patch', last_message_id: old, mention_count: 1 } } }))[0];
    expect(unread.kind).toBe('text');
    expect(mention.kind).toBe('text');
  });

  it('stays quiet in a muted channel that is unread: muting is what asks for that', () => {
    const patch = channel({ id: 'patch', name: 'Patch notes', last_message_id: old });
    const [row] = buildChannelRows(
      inputs({
        channels: [patch],
        readStates: { patch: { channel_id: 'patch', last_message_id: '1', mention_count: 3 } },
        mutedChannelIds: new Set(['patch']),
      }),
    );
    expect(row.kind).toBe('quiet');
  });

  it('uses the server’s order and never re-sorts by activity', () => {
    const rows = buildChannelRows(
      inputs({
        channels: [
          channel({ id: 'a', name: 'A', last_message_id: old }),
          channel({ id: 'b', name: 'B', last_message_id: idAt(NOW - 60_000) }),
          channel({ id: 'c', name: 'C', last_message_id: old }),
        ],
        readStates: {
          a: { channel_id: 'a', last_message_id: old, mention_count: 0 },
          b: { channel_id: 'b', last_message_id: idAt(NOW - 60_000), mention_count: 0 },
          c: { channel_id: 'c', last_message_id: old, mention_count: 0 },
        },
      }),
    );
    expect(rows.map((row) => `${row.name}:${row.kind}`)).toEqual(['A:quiet', 'B:text', 'C:quiet']);
  });
});

describe('faceOf', () => {
  const people = new Map([['nick', { userId: 'nick', name: 'Nick (guild nick)', avatar: 'data:image/png;base64,AAAA' }]]);

  it('fills a face in from the roster when the message told us only the name', () => {
    expect(faceOf({ id: 'nick', kind: 'user', name: 'nick', avatar: null }, people)).toEqual({
      userId: 'nick',
      name: 'nick',
      avatar: 'data:image/png;base64,AAAA',
    });
  });

  it('uses the picture the message carried, and never looks a webhook up as a member', () => {
    expect(faceOf({ id: 'nick', kind: 'user', name: 'Nick', avatar: 'x' }, people).avatar).toBe('x');
    expect(faceOf({ id: 'nick', kind: 'webhook', name: 'Bot', avatar: null }, people).avatar).toBeNull();
  });

  it('has a name even for an author nobody knows', () => {
    expect(faceOf({ id: 'gone', kind: 'user', name: null, avatar: null }, people).name).toBe('Someone');
  });
});
