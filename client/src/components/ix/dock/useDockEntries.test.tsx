import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import { useVoiceStore } from '../../../stores/voiceStore';
import { useDockEntries } from './useDockEntries';

const mocks = vi.hoisted(() => ({
  guilds: [] as unknown[],
  user: null as unknown,
  conversations: { pinned: [], needsYou: [], recent: [], requests: [], needsYouOverflowCount: 0, spaces: [] } as Record<string, unknown>,
  muted: ['muted-key'],
}));

vi.mock('../../../hooks/useGuilds', () => ({ useAvailableGuilds: () => mocks.guilds }));
vi.mock('../../../hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));
vi.mock('../../../hooks/useMutedGuilds', () => ({ useMutedGuilds: () => ({ mutedGuildKeys: mocks.muted }) }));
vi.mock('../../../hooks/useUnifiedConversations', () => ({
  useUnifiedConversations: (muted: string[]) => {
    // The dock hands it the muted keys, so a muted server carries no signals.
    expect(muted).toEqual(mocks.muted);
    return mocks.conversations;
  },
}));

const scope = { serverId: '__local__', userId: '42' };
const guild = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, key: id, scope, icon: null, icon_hash: null, hue: null, ...extra });
const channel = (extra: Partial<ConversationEntry>): ConversationEntry => ({
  key: `k${Math.random()}`,
  scope,
  serverId: '__local__',
  channelId: 'c',
  guildId: 'g1',
  kind: 'guild_text',
  title: 'general',
  contextLabel: null,
  lastActivityId: null,
  unread: false,
  mentionCount: 0,
  isDMUnread: false,
  isThreadReply: false,
  hasVoiceActivity: false,
  pinned: false,
  ...extra,
});

beforeEach(() => {
  mocks.guilds = [guild('g1', 'Fuel'), guild('g2', 'Game Night', { hue: 195, icon_hash: 'abc' })];
  mocks.user = { id: '42', username: 'sean', display_name: 'Sean', avatar_hash: null };
  mocks.conversations = { pinned: [], needsYou: [], recent: [], requests: [], needsYouOverflowCount: 0, spaces: [] };
  useVoiceStore.setState({ channelParticipants: new Map() });
});

describe('useDockEntries', () => {
  it('is People first, then every server in the client\'s order, with its hue and icon', () => {
    const { result } = renderHook(() => useDockEntries());
    expect(result.current.entries.map((entry) => [entry.key, entry.kind, entry.name])).toEqual([
      ['people', 'people', 'People'],
      ['g1', 'server', 'Fuel'],
      ['g2', 'server', 'Game Night'],
    ]);
    const game = result.current.entries[2];
    expect(game.hue).toBe(195);
    expect(game.icon).toBe('abc');
    expect(result.current.entries[1].hue).toBeNull();
    expect(result.current.me).toEqual({ id: '42', name: 'Sean', avatar: null });
  });

  it('has no People before there is an account to show', () => {
    mocks.user = null;
    const { result } = renderHook(() => useDockEntries());
    expect(result.current.entries.map((entry) => entry.key)).toEqual(['g1', 'g2']);
    expect(result.current.me).toBeNull();
  });

  it('lights a server while somebody is in one of its voice channels, and only that one', () => {
    useVoiceStore.setState({ channelParticipants: new Map([['vc', [{ guild_id: 'g2' }]]]) as never });
    const { result } = renderHook(() => useDockEntries());
    expect(result.current.entries.map((entry) => entry.live)).toEqual([false, false, true]);
  });

  it('carries unread and mentions from the conversation model, per server', () => {
    mocks.conversations = {
      ...mocks.conversations,
      pinned: [channel({ guildId: 'g1', unread: true })],
      needsYou: [channel({ guildId: 'g2', mentionCount: 2 })],
      recent: [channel({ guildId: 'g2', unread: true, mentionCount: 1 })],
    };
    const { result } = renderHook(() => useDockEntries());
    const [, fuel, game] = result.current.entries;
    expect(fuel).toMatchObject({ unread: true, mentions: 0 });
    expect(game).toMatchObject({ unread: true, mentions: 3 });
  });

  it('gives People its unread direct messages, its mentions and its friend requests', () => {
    mocks.conversations = {
      ...mocks.conversations,
      needsYou: [channel({ guildId: null, kind: 'dm', isDMUnread: true, mentionCount: 1 })],
      requests: [{ key: 'request:1' }, { key: 'request:2' }],
    };
    const { result } = renderHook(() => useDockEntries());
    expect(result.current.entries[0]).toMatchObject({ unread: true, mentions: 3, requests: 2, dmMentions: 1 });
  });

  it('keeps its entries when nothing it reads has changed', () => {
    const { result, rerender } = renderHook(() => useDockEntries());
    const first = result.current.entries;
    rerender();
    expect(result.current.entries).toBe(first);
  });
});
