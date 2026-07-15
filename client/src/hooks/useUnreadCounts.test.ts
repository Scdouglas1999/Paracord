import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { computeGuildUnread, isMessageUnread, useUnreadCounts } from './useUnreadCounts';
import { useChannelStore } from '../stores/channelStore';
import { useGuildStore } from '../stores/guildStore';
import { useReadStateStore } from '../stores/readStateStore';
import { useServerListStore } from '../stores/serverListStore';
import { ChannelType, type Channel, type Guild, type ReadState } from '../types';

/**
 * useUnreadCounts was rewritten from a single flat read-state map to per-server
 * resolution: each guild resolves to its owning server via guild.server_url →
 * getServerByUrl (falling back to the active server when unmapped — the §9 flag-3
 * mis-attribution path), and every per-channel unread/mention read indexes the
 * resolved server's byServer bucket. These tests pin that resolution so a
 * regression can't silently read the wrong bucket.
 */

const URL_A = 'https://a.example.com';
const URL_B = 'https://b.example.com';

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

function seed(): void {
  useReadStateStore.setState({
    // Override the mount fan-out so no network is attempted.
    refresh: async () => {},
    byServer: {
      // g1 → server 'b'. In 'a', c1 is fully read (a mis-read would drop g1).
      a: {
        c1: rs('c1', 'm-latest', 0),
        // g2 falls back here — unread + 3 mentions live only in 'a'.
        c2: rs('c2', 'm-old', 3),
      },
      b: {
        c1: rs('c1', 'm-old', 2),
      },
    },
  });
  useServerListStore.setState({
    servers: [
      { id: 'a', url: URL_A, name: 'A', token: null, connected: true },
      { id: 'b', url: URL_B, name: 'B', token: null, connected: true },
    ],
    activeServerId: 'a',
  } as never);
  useGuildStore.setState({
    guilds: [
      guild({ id: 'g1', server_url: URL_B }),
      // Unmapped server_url → resolution must fall back to the active server 'a'.
      guild({ id: 'g2', server_url: 'https://unmapped.example.com' }),
    ],
  });
  useChannelStore.setState({
    channelsByGuild: {
      g1: [chan({ id: 'c1', type: ChannelType.Text, last_message_id: 'm-latest' })],
      g2: [chan({ id: 'c2', type: ChannelType.Text, last_message_id: 'm-latest' })],
    },
  });
}

beforeEach(() => {
  seed();
});

describe('useUnreadCounts — per-server read-state resolution', () => {
  it('treats a read cursor ahead of stale channel metadata as read', () => {
    const channels = [
      chan({
        id: 'stale-channel',
        type: ChannelType.Text,
        last_message_id: '332154312534790144',
      }),
    ];
    const readStates = new Map([
      [
        'stale-channel',
        rs('stale-channel', '332154400000000000', 0),
      ],
    ]);

    expect(computeGuildUnread(channels, readStates)).toBeNull();
    expect(isMessageUnread('332154312534790144', '332154400000000000')).toBe(false);
  });

  it('still reports unread when the channel latest snowflake is newer than the read cursor', () => {
    const channels = [
      chan({
        id: 'newer-channel',
        type: ChannelType.Text,
        last_message_id: '332154400000000000',
      }),
    ];
    const readStates = new Map([
      [
        'newer-channel',
        rs('newer-channel', '332154312534790144', 0),
      ],
    ]);

    expect(computeGuildUnread(channels, readStates)).toEqual({
      unreadCount: 1,
      mentionCount: 0,
    });
    expect(isMessageUnread('332154400000000000', '332154312534790144')).toBe(true);
  });

  it("reads a guild's counts from its OWNING server's bucket, not the active server", () => {
    const { result } = renderHook(() => useUnreadCounts([]));

    // g1 resolves to server 'b': stale read (unread) + 2 mentions live only there.
    // Had it read the active server 'a' (where c1 is fully read), g1 would drop out.
    expect(result.current.guildUnreads.get('g1')).toEqual({ unreadCount: 1, mentionCount: 2 });
    expect(result.current.isChannelUnread.has('c1')).toBe(true);
    expect(result.current.channelMentionCounts.get('c1')).toBe(2);
  });

  it('falls back to the active server when the guild.server_url is unmapped (§9 flag-3)', () => {
    const { result } = renderHook(() => useUnreadCounts([]));

    // g2's server_url resolves to nothing → active server 'a', where c2 is stale
    // + carries 3 mentions. An empty-bucket regression would lose the mention count.
    expect(result.current.guildUnreads.get('g2')).toEqual({ unreadCount: 1, mentionCount: 3 });
    expect(result.current.channelMentionCounts.get('c2')).toBe(3);
  });

  it('excludes muted guilds from the per-guild unread totals', () => {
    const { result } = renderHook(() => useUnreadCounts(['g1']));

    expect(result.current.guildUnreads.has('g1')).toBe(false);
    // Non-muted guilds are unaffected.
    expect(result.current.guildUnreads.get('g2')).toEqual({ unreadCount: 1, mentionCount: 3 });
  });
});
