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
import { useRelationshipStore } from '../stores/relationshipStore';
import { useInteractionStore } from '../stores/interactionStore';
import { InteractionCallbackType, InteractionType } from '../types/interactions';
import * as notifications from '../lib/features/notifications';
import type { Message, User } from '../types';

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
  beforeEach(() => {
    vi.spyOn(useRelationshipStore.getState(), 'fetchRelationships').mockResolvedValue();
    vi.spyOn(useChannelStore.getState(), 'loadAllDmChannels').mockResolvedValue();
  });

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

  it('updates cached authors for another user without replacing the signed-in user', () => {
    useAuthStore.setState({ user: { id: 'me', username: 'me-name' } as User });
    useMessageStore.setState({
      messages: {
        ch1: [{
          id: 'm1',
          channel_id: 'ch1',
          author: { id: 'someone-else', username: 'them', discriminator: '0' },
        } as Message],
      },
    });
    dispatchGatewayEvent(SERVER, GatewayEvents.USER_UPDATE, {
      user: { id: 'someone-else', username: 'them', display_name: 'Visible Name' } as User,
    });
    expect(useAuthStore.getState().user?.username).toBe('me-name');
    expect(useMessageStore.getState().messages.ch1[0].author.display_name).toBe('Visible Name');
  });
});

describe('dispatch role/ban/sticker/stage events', () => {
  it('emits paracord:roles-changed for GUILD_ROLE_*', () => {
    const handler = vi.fn();
    window.addEventListener('paracord:roles-changed', handler);
    dispatchGatewayEvent(SERVER, GatewayEvents.GUILD_ROLE_CREATE, { guild_id: 'g1' });
    expect(handler).toHaveBeenCalled();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ guild_id: 'g1' });
    window.removeEventListener('paracord:roles-changed', handler);
  });

  it('emits paracord:bans-changed for GUILD_BAN_*', () => {
    const handler = vi.fn();
    window.addEventListener('paracord:bans-changed', handler);
    dispatchGatewayEvent(SERVER, GatewayEvents.GUILD_BAN_ADD, { guild_id: 'g1' });
    expect(handler).toHaveBeenCalled();
    window.removeEventListener('paracord:bans-changed', handler);
  });

  it('emits paracord:stickers-changed for GUILD_STICKERS_UPDATE', () => {
    const handler = vi.fn();
    window.addEventListener('paracord:stickers-changed', handler);
    dispatchGatewayEvent(SERVER, GatewayEvents.GUILD_STICKERS_UPDATE, { guild_id: 'g1' });
    expect(handler).toHaveBeenCalled();
    window.removeEventListener('paracord:stickers-changed', handler);
  });

  it('emits paracord:stage-instance-changed for STAGE_INSTANCE_*', () => {
    const handler = vi.fn();
    window.addEventListener('paracord:stage-instance-changed', handler);
    dispatchGatewayEvent(SERVER, GatewayEvents.STAGE_INSTANCE_CREATE, {
      guild_id: 'g1',
      channel_id: 'c1',
    });
    expect(handler).toHaveBeenCalled();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ guild_id: 'g1', channel_id: 'c1' });
    window.removeEventListener('paracord:stage-instance-changed', handler);
  });

  it('emits paracord:invites-changed for INVITE_*', () => {
    const handler = vi.fn();
    window.addEventListener('paracord:invites-changed', handler);
    dispatchGatewayEvent(SERVER, GatewayEvents.INVITE_DELETE, { guild_id: 'g1' });
    expect(handler).toHaveBeenCalled();
    window.removeEventListener('paracord:invites-changed', handler);
  });
});

describe('dispatch INTERACTION_CREATE / slash feedback', () => {
  beforeEach(() => {
    useInteractionStore.setState({
      pendingInteractions: new Map(),
      thinkingInteractions: new Set(),
      activeModal: null,
      autocompleteChoices: [],
      autocompleteInteractionId: null,
    });
  });

  it('marks deferred empty interaction responses as thinking', () => {
    useInteractionStore.getState().addPendingInteraction({
      id: 'ix1',
      application_id: 'app1',
      type: InteractionType.ApplicationCommand,
      channel_id: 'ch1',
      token: 'tok',
      version: 1,
    });
    dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_CREATE, {
      id: 'm-deferred',
      channel_id: 'ch1',
      content: '',
      author: { id: 'bot', username: 'Bot', discriminator: '0000', bot: true },
      interaction: { id: 'ix1', type: 2, name: 'ping' },
    } as Partial<Message>);
    expect(useInteractionStore.getState().thinkingInteractions.has('ix1')).toBe(true);
  });

  it('clears pending state when a filled interaction message arrives', () => {
    useInteractionStore.getState().addPendingInteraction({
      id: 'ix2',
      application_id: 'app1',
      type: InteractionType.ApplicationCommand,
      channel_id: 'ch1',
      token: 'tok',
      version: 1,
    });
    useInteractionStore.getState().handleInteractionResponse('ix2', {
      type: InteractionCallbackType.DeferredChannelMessageWithSource,
    });
    dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_CREATE, {
      id: 'm-done',
      channel_id: 'ch1',
      content: 'pong',
      author: { id: 'bot', username: 'Bot', discriminator: '0000', bot: true },
      interaction: { id: 'ix2', type: 2, name: 'ping' },
    } as Partial<Message>);
    expect(useInteractionStore.getState().pendingInteractions.has('ix2')).toBe(false);
    expect(useInteractionStore.getState().thinkingInteractions.has('ix2')).toBe(false);
  });

  it('opens a modal from INTERACTION_CREATE callback type 9', () => {
    dispatchGatewayEvent(SERVER, GatewayEvents.INTERACTION_CREATE, {
      interaction_id: 'ix3',
      type: InteractionCallbackType.Modal,
      channel_id: 'ch1',
      guild_id: 'g1',
      application_id: 'app1',
      data: {
        title: 'Report',
        custom_id: 'report_modal',
        components: [],
      },
    });
    expect(useInteractionStore.getState().activeModal).toMatchObject({
      interactionId: 'ix3',
      title: 'Report',
      customId: 'report_modal',
      components: [],
      channelId: 'ch1',
      guildId: 'g1',
      applicationId: 'app1',
    });
  });

  it('stores autocomplete choices from INTERACTION_CREATE callback type 8', () => {
    dispatchGatewayEvent(SERVER, GatewayEvents.INTERACTION_CREATE, {
      interaction_id: 'ix4',
      type: InteractionCallbackType.ApplicationCommandAutocompleteResult,
      data: {
        choices: [
          { name: 'Alpha', value: 'alpha' },
          { name: 'Beta', value: 'beta' },
        ],
      },
    });
    expect(useInteractionStore.getState().autocompleteChoices).toEqual([
      { name: 'Alpha', value: 'alpha' },
      { name: 'Beta', value: 'beta' },
    ]);
    expect(useInteractionStore.getState().autocompleteInteractionId).toBe('ix4');
  });

  it('stamps modal channel/guild from pending interaction when gateway omits them', () => {
    useInteractionStore.getState().addPendingInteraction({
      id: 'ix5',
      application_id: 'app5',
      type: InteractionType.MessageComponent,
      channel_id: 'ch5',
      guild_id: 'g5',
      token: 'tok',
      version: 1,
    });
    dispatchGatewayEvent(SERVER, GatewayEvents.INTERACTION_CREATE, {
      interaction_id: 'ix5',
      type: InteractionCallbackType.Modal,
      data: {
        title: 'Edit',
        custom_id: 'edit_modal',
        components: [],
      },
    });
    expect(useInteractionStore.getState().activeModal).toMatchObject({
      interactionId: 'ix5',
      channelId: 'ch5',
      guildId: 'g5',
      applicationId: 'app5',
    });
  });
});

// Keep voiceStore import referenced (READY loads voice states) so tree-shaking
// of the mock graph doesn't drop the module the dispatcher touches.
void useVoiceStore;

describe('READY user projection', () => {
  // Regression: READY carries only the public projection of the account
  // (no `flags`, no `email`). Replacing the stored user wiped `flags`, which
  // silently revoked the admin panel from real server admins as soon as the
  // gateway connected.
  it('merges READY user into the stored profile instead of replacing it', () => {
    useAuthStore.setState({
      user: {
        id: 'u1',
        username: 'owner',
        flags: 1,
        email: 'owner@example.com',
      } as unknown as User,
    });

    dispatchGatewayEvent(SERVER, GatewayEvents.READY, {
      user: { id: 'u1', username: 'owner', display_name: 'Owner', avatar_hash: null },
      guilds: [],
      session_id: 's1',
    } as never);

    const user = useAuthStore.getState().user as unknown as Record<string, unknown>;
    expect(user.flags).toBe(1);
    expect(user.email).toBe('owner@example.com');
    // Fields READY does carry are still applied.
    expect(user.display_name).toBe('Owner');
  });

  it('accepts the READY user when nothing is stored yet', () => {
    useAuthStore.setState({ user: null });

    dispatchGatewayEvent(SERVER, GatewayEvents.READY, {
      user: { id: 'u2', username: 'fresh', flags: 0 },
      guilds: [],
      session_id: 's2',
    } as never);

    expect(useAuthStore.getState().user?.id).toBe('u2');
  });
});
