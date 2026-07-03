import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock leaf side-effect modules so dispatch stays unit-scoped.
vi.mock('../lib/features/notifications', () => ({
  isEnabled: vi.fn(() => false),
  sendNotification: vi.fn(() => Promise.resolve()),
}));
vi.mock('../lib/accountSession', () => ({
  hasUnlockedPrivateKey: vi.fn(() => false),
}));
vi.mock('../lib/signalPrekeys', () => ({
  ensurePrekeysUploaded: vi.fn(() => Promise.resolve()),
}));

import { dispatchGatewayEvent, resolveEmojiKey } from './dispatch';
import { GatewayEvents } from './events';
import { useGuildStore } from '../stores/guildStore';
import { useChannelStore } from '../stores/channelStore';
import { useMessageStore } from '../stores/messageStore';
import { useAuthStore } from '../stores/authStore';
import { useVoiceStore } from '../stores/voiceStore';
import * as notifications from '../lib/features/notifications';
import type { User } from '../types';

const SERVER = '__test_server__';

function resetStores() {
  useGuildStore.setState({ guilds: [], selectedGuildId: null });
  useChannelStore.setState({
    channels: [],
    channelsByGuild: {},
    channelsById: {},
    guildChannelsLoaded: {},
    selectedChannelId: null,
  });
  useAuthStore.setState({ user: null });
}

beforeEach(() => {
  resetStores();
  vi.clearAllMocks();
});

afterEach(() => {
  resetStores();
});

describe('resolveEmojiKey', () => {
  it('keys unicode emoji by their string', () => {
    expect(resolveEmojiKey('👍')).toBe('👍');
  });
  it('keys custom emoji by id (ignoring name)', () => {
    expect(resolveEmojiKey({ id: '123', name: 'blob' })).toBe('123');
  });
  it('keys emoji objects without id by name', () => {
    expect(resolveEmojiKey({ name: '👍' })).toBe('👍');
  });
  it('returns undefined for missing/empty emoji', () => {
    expect(resolveEmojiKey(undefined)).toBeUndefined();
    expect(resolveEmojiKey('')).toBeUndefined();
    expect(resolveEmojiKey({})).toBeUndefined();
  });
});

describe('dispatch READY normalization', () => {
  it('adds a guild with a valid owner_id', () => {
    dispatchGatewayEvent(SERVER, GatewayEvents.READY, {
      guilds: [{ id: 'g1', owner_id: 'owner-1', name: 'Guild One', channels: [] }],
    });
    const guilds = useGuildStore.getState().guilds;
    expect(guilds).toHaveLength(1);
    expect(guilds[0].owner_id).toBe('owner-1');
  });

  it('skips (does not default) a guild missing owner_id and logs a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dispatchGatewayEvent(SERVER, GatewayEvents.READY, {
      guilds: [{ id: 'g1', name: 'No Owner', channels: [] }],
    });
    expect(useGuildStore.getState().guilds).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('owner_id'));
    warn.mockRestore();
  });

  it('skips a guild missing id and logs a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dispatchGatewayEvent(SERVER, GatewayEvents.READY, {
      guilds: [{ owner_id: 'o1', name: 'No Id' } as never],
    });
    expect(useGuildStore.getState().guilds).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('normalizes guild channels but skips channels missing id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dispatchGatewayEvent(SERVER, GatewayEvents.READY, {
      guilds: [
        {
          id: 'g1',
          owner_id: 'o1',
          name: 'G',
          channels: [
            { id: 'c1', name: 'general', type: 0 },
            { name: 'broken' } as never,
          ],
        },
      ],
    });
    const channels = useChannelStore.getState().channelsByGuild['g1'] ?? [];
    expect(channels.map((c) => c.id)).toEqual(['c1']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('channel missing id'));
    warn.mockRestore();
  });
});

describe('dispatch MESSAGE_CREATE notification gating', () => {
  const baseMessage = {
    id: 'm1',
    channel_id: 'ch1',
    content: 'hello',
    author: { id: 'other-user', username: 'Other', discriminator: '0000' },
  };

  beforeEach(() => {
    useAuthStore.setState({ user: { id: 'me' } as User });
    (notifications.isEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it('notifies for a message from another user in an unfocused channel', () => {
    dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_CREATE, { ...baseMessage });
    expect(notifications.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('does not notify for a message authored by the current user', () => {
    dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_CREATE, {
      ...baseMessage,
      author: { id: 'me', username: 'Me', discriminator: '0000' },
    });
    expect(notifications.sendNotification).not.toHaveBeenCalled();
  });

  it('does not notify when notifications are disabled', () => {
    (notifications.isEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_CREATE, { ...baseMessage });
    expect(notifications.sendNotification).not.toHaveBeenCalled();
  });
});

describe('dispatch reaction emoji keying', () => {
  it('forwards the custom emoji id for MESSAGE_REACTION_ADD', () => {
    const spy = vi.spyOn(useMessageStore.getState(), 'handleReactionAdd');
    dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_REACTION_ADD, {
      channel_id: 'ch1',
      message_id: 'm1',
      user_id: 'u2',
      emoji: { id: 'emoji-42', name: 'blob' },
    });
    expect(spy).toHaveBeenCalledWith('ch1', 'm1', 'emoji-42', 'u2', expect.any(String));
    spy.mockRestore();
  });

  it('forwards the unicode emoji string for MESSAGE_REACTION_REMOVE', () => {
    const spy = vi.spyOn(useMessageStore.getState(), 'handleReactionRemove');
    dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_REACTION_REMOVE, {
      channel_id: 'ch1',
      message_id: 'm1',
      user_id: 'u2',
      emoji: '👍',
    });
    expect(spy).toHaveBeenCalledWith('ch1', 'm1', '👍', 'u2', expect.any(String));
    spy.mockRestore();
  });

  it('skips reaction events with no resolvable emoji', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(useMessageStore.getState(), 'handleReactionAdd');
    dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_REACTION_ADD, {
      channel_id: 'ch1',
      message_id: 'm1',
      user_id: 'u2',
      emoji: {},
    });
    expect(spy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    spy.mockRestore();
    warn.mockRestore();
  });
});

describe('dispatch USER_UPDATE self-vs-other', () => {
  it('applies the payload directly when it targets the current user', () => {
    useAuthStore.setState({ user: { id: 'me', username: 'old' } as User });
    const fetchSpy = vi.spyOn(useAuthStore.getState(), 'fetchUser');
    dispatchGatewayEvent(SERVER, GatewayEvents.USER_UPDATE, {
      user: { id: 'me', username: 'new' } as User,
    });
    expect(useAuthStore.getState().user?.username).toBe('new');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('ignores USER_UPDATE for another user (no refetch, no state change)', () => {
    useAuthStore.setState({ user: { id: 'me', username: 'me-name' } as User });
    const fetchSpy = vi.spyOn(useAuthStore.getState(), 'fetchUser');
    dispatchGatewayEvent(SERVER, GatewayEvents.USER_UPDATE, {
      user: { id: 'someone-else', username: 'them' } as User,
    });
    expect(useAuthStore.getState().user?.username).toBe('me-name');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

// Keep voiceStore import referenced (READY loads voice states) so tree-shaking
// of the mock graph doesn't drop the module the dispatcher touches.
void useVoiceStore;
