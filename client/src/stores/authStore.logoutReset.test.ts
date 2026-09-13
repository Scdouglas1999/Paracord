import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Regression cover for cross-account data leakage on logout.
 *
 * `clearAuthState` used to reset only the typing, read-state and saved-message
 * stores. Everything that actually holds another user's content — messages,
 * channels, guilds, members, presences, voice — was left populated, and there
 * is no reload on logout. Signing in as a second user therefore rendered the
 * first user's servers, channels and messages.
 */

vi.mock('../lib/authToken', () => ({
  getAccessToken: vi.fn(() => null),
  setAccessToken: vi.fn(),
  getRefreshToken: vi.fn(() => null),
  hydrateRefreshTokenStorage: vi.fn(async () => undefined),
  setRefreshToken: vi.fn(),
  clearLegacyPersistedAuth: vi.fn(),
}));

vi.mock('../lib/downloadTicket', () => ({
  clearDownloadTicketCache: vi.fn(),
  startDownloadTicketLifecycle: vi.fn(),
}));

vi.mock('../api/auth', () => ({
  authApi: {
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(async () => undefined),
    getMe: vi.fn(),
    updateMe: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
  },
}));

vi.mock('../api/client', () => ({
  refreshSharedSession: vi.fn(),
  extractApiError: vi.fn(() => 'error'),
}));

import { useAuthStore } from './authStore';
import { useChannelStore } from './channelStore';
import { useGuildStore } from './guildStore';
import { useMemberStore } from './memberStore';
import { getMessageStore } from './messageStore';
import { usePresenceStore } from './presenceStore';
import { useVoiceStore } from './voiceStore';
import { useTypingStore } from './typingStore';
import { useReadStateStore } from './readStateStore';
import { useSavedMessageStore } from './savedMessageStore';

let useMessageStore: ReturnType<typeof getMessageStore>;

const otherUsersMessage = {
  id: 'm1',
  channel_id: 'ch1',
  author: { id: 'other-user', username: 'other', discriminator: '0001' },
  content: 'private',
  tts: false,
  mention_everyone: false,
  pinned: false,
  type: 0,
  attachments: [],
  reactions: [],
};

/** Populate every store the way a signed-in session would. */
function seedSignedInSession() {
  useAuthStore.setState({ token: 'tok', user: { id: 'first-user' } as never });
  useMessageStore = getMessageStore({ serverId: '__local__', userId: 'first-user' });

  useMessageStore.setState({
    messages: { ch1: [otherUsersMessage as never] },
    pins: { ch1: [otherUsersMessage as never] },
    hasMore: { ch1: true },
  });

  useChannelStore.getState().addChannel({ id: 'ch1', guild_id: 'g1' } as never, { serverId: '__local__', userId: 'first-user' });
  useChannelStore.getState().addChannel({ id: 'dm1' } as never, { serverId: 's1', userId: 'first-user' });
  useChannelStore.getState().selectChannel({ id: 'ch1', scope: { serverId: '__local__', userId: 'first-user' } });

  useGuildStore.setState({
    guilds: [{ id: 'g1', name: "First user's space" } as never],
    selectedGuild: { id: 'g1', scope: { serverId: '__local__', userId: 'user-1' } },
  });

  useMemberStore.setState({
    members: new Map([[JSON.stringify(['__local__', 'user-a', 'g1']), [{ user: { id: 'other-user' } } as never]]]),
    membersLoaded: { [JSON.stringify(['__local__', 'user-a', 'g1'])]: true },
  });

  usePresenceStore.getState().updatePresence({ user_id: 'other-user', status: 'online' } as never);

  useVoiceStore.setState({
    participants: new Map([['other-user', { user_id: 'other-user' } as never]]),
    channelParticipants: new Map([['ch1', [{ user_id: 'other-user' } as never]]]),
    speakingUsers: new Set(['other-user']),
  });
}

describe('logout clears every store holding account data', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('leaves no trace of the previous account in memory', async () => {
    seedSignedInSession();

    // Sanity: the session really is populated before we log out, otherwise the
    // assertions below would pass vacuously.
    expect(useMessageStore.getState().messages.ch1).toHaveLength(1);
    expect(useGuildStore.getState().guilds).toHaveLength(1);
    expect(usePresenceStore.getState().presences.size).toBe(1);

    await useAuthStore.getState().logout();

    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();

    expect(useMessageStore.getState().messages).toEqual({});
    expect(useMessageStore.getState().pins).toEqual({});
    expect(useMessageStore.getState().hasMore).toEqual({});

    expect(useChannelStore.getState().channelsByGuild).toEqual({});
    expect(useChannelStore.getState().channelsById).toEqual({});
    expect(useChannelStore.getState().selectedChannel).toBeNull();

    expect(useGuildStore.getState().guilds).toEqual([]);
    expect(useGuildStore.getState().selectedGuild).toBeNull();

    expect(useMemberStore.getState().members.size).toBe(0);
    expect(useMemberStore.getState().membersLoaded).toEqual({});

    expect(usePresenceStore.getState().presences.size).toBe(0);
    expect(usePresenceStore.getState().keysByUser.size).toBe(0);

    expect(useVoiceStore.getState().participants.size).toBe(0);
    expect(useVoiceStore.getState().channelParticipants.size).toBe(0);
    expect(useVoiceStore.getState().speakingUsers.size).toBe(0);
    expect(useVoiceStore.getState().connected).toBe(false);
  });

  it('still clears the transient stores it already handled', async () => {
    const typingReset = vi.spyOn(useTypingStore.getState(), 'reset');
    const readStateReset = vi.spyOn(useReadStateStore.getState(), 'reset');
    const savedReset = vi.spyOn(useSavedMessageStore.getState(), 'reset');

    await useAuthStore.getState().logout();

    expect(typingReset).toHaveBeenCalled();
    expect(readStateReset).toHaveBeenCalled();
    expect(savedReset).toHaveBeenCalled();
  });

  it('a second account starting fresh sees none of the first account content', async () => {
    seedSignedInSession();
    await useAuthStore.getState().logout();

    // Simulate the next sign-in without any reload, which is what actually
    // happens in the app.
    useAuthStore.setState({ token: 'tok2', user: { id: 'second-user' } as never });

    const allCachedMessages = Object.values(useMessageStore.getState().messages).flat();
    expect(allCachedMessages).toHaveLength(0);
    expect(useGuildStore.getState().guilds).toHaveLength(0);
    expect(
      Array.from(useMemberStore.getState().members.values()).flat(),
    ).toHaveLength(0);
  });
});
