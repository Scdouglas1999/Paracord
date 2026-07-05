import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useUnifiedConversations } from './useUnifiedConversations';
import { useChannelStore } from '../stores/channelStore';
import { useGuildStore } from '../stores/guildStore';
import { useReadStateStore } from '../stores/readStateStore';
import { useServerListStore } from '../stores/serverListStore';
import { useVoiceStore } from '../stores/voiceStore';
import { usePinnedStore } from '../stores/pinnedStore';
import { useRelationshipStore } from '../stores/relationshipStore';
import { EPOCH_MS } from '../lib/attention/conversationModel';
import { ChannelType, type Channel, type Guild, type ReadState, type User, type VoiceState } from '../types';

function snowflakeForMs(ms: number): string {
  return String((BigInt(ms) - BigInt(EPOCH_MS)) << 22n);
}

function chan(over: Partial<Channel> & { id: string; type: ChannelType }): Channel {
  return { position: 0, nsfw: false, created_at: '', ...over } as Channel;
}

function guild(over: Partial<Guild> & { id: string; server_url: string }): Guild {
  return {
    name: over.id,
    owner_id: '0',
    member_count: 0,
    features: [],
    created_at: '',
    ...over,
  } as Guild;
}

function rs(channelId: string, lastMessageId: string, mentions = 0): ReadState {
  return { channel_id: channelId, last_message_id: lastMessageId, mention_count: mentions };
}

const URL_A = 'https://a.example.com';
const URL_B = 'https://b.example.com';

/** Reset every store to a clean slate and stub the mount fan-out (no network). */
function resetStores(): void {
  useChannelStore.setState({
    channelsByGuild: {},
    dmChannelsByServer: {},
    loadAllDmChannels: async () => {},
  });
  useReadStateStore.setState({ byServer: {}, refresh: async () => {} });
  useVoiceStore.setState({ channelParticipants: new Map<string, VoiceState[]>() });
  useServerListStore.setState({
    servers: [
      { id: 'a', url: URL_A, name: 'A', token: null, connected: true },
      { id: 'b', url: URL_B, name: 'B', token: null, connected: true },
    ],
    activeServerId: 'a',
  });
  useGuildStore.setState({ guilds: [] });
  usePinnedStore.setState({ pinnedKeys: [] });
  useRelationshipStore.setState({ relationships: [] });
}

function user(id: string, username: string): User {
  return { id, username, discriminator: 0, bot: false, system: false, flags: 0, created_at: '' } as User;
}

function run() {
  return renderHook(() => useUnifiedConversations([])).result.current;
}

beforeEach(() => {
  resetStores();
});

describe('useUnifiedConversations — cross-server merge', () => {
  it('keeps two servers minting the same channelId collision-safe via composite keys', () => {
    // Both servers have a guild whose text channel is id '100'.
    useGuildStore.setState({
      guilds: [guild({ id: 'ga', server_url: URL_A }), guild({ id: 'gb', server_url: URL_B })],
    });
    useChannelStore.setState({
      channelsByGuild: {
        ga: [chan({ id: '100', type: ChannelType.Text, name: 'gen-a', last_message_id: '999' })],
        gb: [chan({ id: '100', type: ChannelType.Text, name: 'gen-b', last_message_id: '999' })],
      },
    });
    // No read-state for either → both unread → both are needs-you.
    const { needsYou } = run();
    const keys = needsYou.map((e) => e.key).sort();
    expect(keys).toEqual(['a:100', 'b:100']);
    expect(needsYou.find((e) => e.key === 'a:100')?.serverId).toBe('a');
    expect(needsYou.find((e) => e.key === 'b:100')?.serverId).toBe('b');
  });
});

describe('useUnifiedConversations — needs-you scoring', () => {
  it('caps needs-you at 6 and orders by tier (mention > dm > thread > plain > voice)', () => {
    useGuildStore.setState({ guilds: [guild({ id: 'g1', server_url: URL_A })] });
    useChannelStore.setState({
      channelsByGuild: {
        g1: [
          chan({ id: 'm', type: ChannelType.Text, name: 'mention', last_message_id: '999' }),
          chan({ id: 't', type: ChannelType.Thread, name: 'thread', last_message_id: '999' }),
          chan({ id: 'v', type: ChannelType.Voice, name: 'voice' }),
          chan({ id: 'p1', type: ChannelType.Text, name: 'p1', last_message_id: '999' }),
          chan({ id: 'p2', type: ChannelType.Text, name: 'p2', last_message_id: '999' }),
          chan({ id: 'p3', type: ChannelType.Text, name: 'p3', last_message_id: '999' }),
          chan({ id: 'p4', type: ChannelType.Text, name: 'p4', last_message_id: '999' }),
        ],
      },
      // DM unread on the active server.
      dmChannelsByServer: {
        a: [
          chan({
            id: 'd',
            type: ChannelType.DM,
            last_message_id: '999',
            recipient: { id: 'u9', username: 'nine', discriminator: 0 },
          }),
        ],
      },
    });
    // 'm' carries mentions (its read cursor is behind → also unread, mention dominates).
    useReadStateStore.setState({ byServer: { a: { m: rs('m', '1', 3) } } });
    // 'v' has a live occupant.
    useVoiceStore.setState({ channelParticipants: new Map([['v', [{} as VoiceState]]]) });

    const { needsYou } = run();
    expect(needsYou).toHaveLength(6);
    expect(needsYou[0].channelId).toBe('m'); // mention tier first
    expect(needsYou[1].channelId).toBe('d'); // DM unread
    expect(needsYou[2].channelId).toBe('t'); // thread reply
    // Voice (weight 30) loses its slot to the four plain unreads (weight 40).
    expect(needsYou.some((e) => e.channelId === 'v')).toBe(false);
    expect(needsYou[0].mentionCount).toBe(3);
    expect(needsYou[1].isDMUnread).toBe(true);
    expect(needsYou[1].userId).toBe('u9');
    expect(needsYou[2].isThreadReply).toBe(true);
  });

  it('does not admit a fully-read channel into needs-you on recency alone', () => {
    useGuildStore.setState({ guilds: [guild({ id: 'g1', server_url: URL_A })] });
    useChannelStore.setState({
      channelsByGuild: {
        g1: [chan({ id: 'read', type: ChannelType.Text, last_message_id: '500' })],
      },
    });
    useReadStateStore.setState({ byServer: { a: { read: rs('read', '500', 0) } } });
    const { needsYou, recent } = run();
    expect(needsYou).toHaveLength(0);
    expect(recent.map((e) => e.channelId)).toEqual(['read']);
  });
});

describe('useUnifiedConversations — pinned', () => {
  it('floats pinned entries out (in pin order) before scoring, even mentions', () => {
    useGuildStore.setState({ guilds: [guild({ id: 'g1', server_url: URL_A })] });
    useChannelStore.setState({
      channelsByGuild: {
        g1: [
          chan({ id: 'pin1', type: ChannelType.Text, last_message_id: '999' }),
          chan({ id: 'pin2', type: ChannelType.Text, last_message_id: '999' }),
          chan({ id: 'hot', type: ChannelType.Text, last_message_id: '999' }),
        ],
      },
    });
    // 'hot' has mentions — would be needs-you #1 if not pinned.
    useReadStateStore.setState({ byServer: { a: { hot: rs('hot', '1', 5) } } });
    // Pin order: pin2 before pin1, and pin the mention channel too.
    usePinnedStore.setState({ pinnedKeys: ['a:pin2', 'a:pin1', 'a:hot'] });

    const { needsYou, pinned, recent } = run();
    expect(pinned.map((e) => e.key)).toEqual(['a:pin2', 'a:pin1', 'a:hot']);
    expect(pinned.every((e) => e.pinned)).toBe(true);
    // Pinned channels never appear in needs-you or recent.
    expect(needsYou).toHaveLength(0);
    expect(recent).toHaveLength(0);
  });
});

describe('useUnifiedConversations — recent ordering', () => {
  it('sorts recent by last activity descending', () => {
    const now = Date.now();
    useGuildStore.setState({ guilds: [guild({ id: 'g1', server_url: URL_A })] });
    const oldId = snowflakeForMs(now - 3_600_000);
    const midId = snowflakeForMs(now - 60_000);
    const newId = snowflakeForMs(now - 1_000);
    useChannelStore.setState({
      channelsByGuild: {
        g1: [
          chan({ id: 'old', type: ChannelType.Text, last_message_id: oldId }),
          chan({ id: 'new', type: ChannelType.Text, last_message_id: newId }),
          chan({ id: 'mid', type: ChannelType.Text, last_message_id: midId }),
        ],
      },
    });
    // All read → no attention signal → all land in recent.
    useReadStateStore.setState({
      byServer: {
        a: { old: rs('old', oldId), new: rs('new', newId), mid: rs('mid', midId) },
      },
    });
    const { needsYou, recent } = run();
    expect(needsYou).toHaveLength(0);
    expect(recent.map((e) => e.channelId)).toEqual(['new', 'mid', 'old']);
  });
});

describe('useUnifiedConversations — graceful degradation', () => {
  it('renders rows for a server that has no read-state yet', () => {
    useGuildStore.setState({
      guilds: [guild({ id: 'ga', server_url: URL_A }), guild({ id: 'gb', server_url: URL_B })],
    });
    useChannelStore.setState({
      channelsByGuild: {
        ga: [chan({ id: 'a1', type: ChannelType.Text, last_message_id: '999' })],
        gb: [chan({ id: 'b1', type: ChannelType.Text, last_message_id: '999' })],
      },
    });
    // Only server 'a' has a read-state bucket; 'b' is missing entirely.
    useReadStateStore.setState({ byServer: { a: { a1: rs('a1', '999', 0) } } });

    const result = run();
    // a1 is read (no signal) → recent; b1 has no read-state → treated as unread.
    expect(result.needsYou.map((e) => e.key)).toEqual(['b:b1']);
    expect(result.recent.map((e) => e.key)).toEqual(['a:a1']);
  });

  it('surfaces pending-incoming friend requests, newest first, with decoded timestamps', () => {
    const now = Date.now();
    const olderId = snowflakeForMs(now - 3_600_000);
    const newerId = snowflakeForMs(now - 60_000);
    useRelationshipStore.setState({
      relationships: [
        { id: olderId, type: 3, user: user('u1', 'Ada') }, // pending incoming (older)
        { id: newerId, type: 3, user: user('u2', 'Bo') }, // pending incoming (newer)
        { id: '5', type: 1, user: user('u3', 'friend') }, // accepted friend — excluded
        { id: '6', type: 4, user: user('u4', 'outgoing') }, // pending OUTGOING — excluded
        { id: 'u5:me', type: 3, user: user('u5', 'NoTs') }, // composite id → no timestamp
      ],
    });

    const { requests } = run();
    // Only the three pending-incoming requests, ordered newest → oldest.
    expect(requests.map((r) => r.username)).toEqual(['Bo', 'Ada', 'NoTs']);
    expect(requests[0].key).toBe('request:u2');
    expect(requests[1].createdMs).toBeGreaterThan(0);
    // A composite fallback id carries no decodable request time.
    expect(requests[2].createdMs).toBeNull();
  });

  it('maps joined guilds to spaces with resolved serverIds', () => {
    useGuildStore.setState({
      guilds: [
        guild({ id: 'ga', server_url: URL_A, name: 'Alpha' }),
        guild({ id: 'gb', server_url: URL_B, name: 'Beta' }),
      ],
    });
    const { spaces } = run();
    expect(spaces).toEqual([
      { id: 'ga', name: 'Alpha', icon: null, serverId: 'a' },
      { id: 'gb', name: 'Beta', icon: null, serverId: 'b' },
    ]);
  });
});
