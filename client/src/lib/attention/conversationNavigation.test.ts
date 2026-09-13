import { beforeEach, describe, expect, it } from 'vitest';
import { activateConversation } from './conversationNavigation';
import { conversationKey, type ConversationEntry } from './conversationModel';
import { useServerListStore } from '../../stores/serverListStore';
import { useAuthStore } from '../../stores/authStore';
import { useChannelStore } from '../../stores/channelStore';
import { useGuildStore } from '../../stores/guildStore';
import { LOCAL_SERVER_ID } from '../serverScope';

function entry(serverId: string, userId = 'viewer', guildId: string | null = null): ConversationEntry {
  const scope = { serverId, userId };
  return { scope, serverId, key: conversationKey(scope, '100'), channelId: '100', guildId,
    kind: guildId ? 'guild_text' : 'dm', title: 'Conversation', contextLabel: null,
    lastActivityId: null, unread: false, mentionCount: 0, isDMUnread: false,
    isThreadReply: false, hasVoiceActivity: false, pinned: false };
}

beforeEach(() => {
  useChannelStore.getState().reset();
  useGuildStore.getState().reset();
  useAuthStore.setState({ user: { id: 'viewer' } as never, token: 'home-token' });
  useServerListStore.setState({ activeServerId: 'a', servers: ['a', 'b'].map(id => ({
    id, name: id, url: `https://${id}.example`, token: 'token', userId: 'viewer',
    user: { id: 'viewer' } as never, connected: true,
  })) });
});

describe('conversation navigation ownership', () => {
  it('opens the represented remote account and compound channel selection', () => {
    const row = entry('b', 'viewer', 'guild');
    expect(activateConversation(row)).toBe('/app/guilds/guild/channels/100');
    expect(useServerListStore.getState().activeServerId).toBe('b');
    expect(useChannelStore.getState().selectedChannel).toEqual({ id: '100', scope: row.scope });
  });

  it('opens home DMs with the explicit home account', () => {
    expect(activateConversation(entry(LOCAL_SERVER_ID))).toBe('/app/dms/100');
    expect(useServerListStore.getState().activeServerId).toBeNull();
    expect(useChannelStore.getState().selectedChannel?.scope).toEqual({ serverId: LOCAL_SERVER_ID, userId: 'viewer' });
  });

  it('rejects a row retained from a replaced account without switching or selecting', () => {
    const row = entry('b');
    useServerListStore.setState(state => ({ servers: state.servers.map(server => server.id === 'b'
      ? { ...server, userId: 'next', user: { id: 'next' } as never } : server) }));
    expect(() => activateConversation(row)).toThrow(/no longer signed in/);
    expect(useServerListStore.getState().activeServerId).toBe('a');
    expect(useChannelStore.getState().selectedChannel).toBeNull();
  });

  it('opens guild home using the represented guild account', () => {
    const row = { ...entry('b', 'viewer', 'same'), kind: 'guild_home' as const };
    expect(activateConversation(row)).toBe('/app/guilds/same');
    expect(useGuildStore.getState().selectedGuild).toEqual({ id: 'same', scope: row.scope });
  });
});
