vi.mock('../lib/messages/accountMessagingRuntime', async () => (await import('../test/messagingRuntimeMock')).messagingRuntimeMock);
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
// The debounced visibility refetch needs a live connection; the store owns its
// own test. Here we only care that CHANNEL_UPDATE asks for one.
vi.mock('../stores/channelStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stores/channelStore')>()),
  refreshGuildChannelVisibility: vi.fn(),
}));

import { getTestMessagingRuntime } from '../test/messagingRuntimeMock';
import { dispatchGatewayEvent, resolveEmojiKey } from './dispatch';
import { useReadStateStore } from '../stores/readStateStore';
import { GatewayEvents } from './events';
import { useMemberStore } from '../stores/memberStore';
import { useGuildStore } from '../stores/guildStore';
import { refreshGuildChannelVisibility, useChannelStore } from '../stores/channelStore';
import { getMessageStore, type MessageState } from '../stores/messageStore';
import { useAuthStore } from '../stores/authStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useRelationshipStore } from '../stores/relationshipStore';
import { useInteractionStore } from '../stores/interactionStore';
import { InteractionCallbackType, InteractionType } from '../types/interactions';
import * as notifications from '../lib/features/notifications';
import { useNotificationPreferenceStore } from '../stores/notificationPreferenceStore';
import { getServerAccountScope } from '../lib/serverIdentity';
import { accountScopeKey } from '../lib/serverScope';
import type { Message, User } from '../types';

const SERVER = '__local__';
const useMessageStore = {
  getState: () => getMessageStore({ serverId: SERVER, userId: useAuthStore.getState().user?.id ?? 'u1' }).getState(),
  setState: (state: Partial<MessageState>) => getMessageStore({ serverId: SERVER, userId: useAuthStore.getState().user?.id ?? 'u1' }).setState(state),
};

function resetStores() {
  useGuildStore.setState({ guilds: [], selectedGuild: null });
  useChannelStore.getState().reset();
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
  const readyCore = { id: 'g1', owner_id: 'owner-1', name: 'Updated', member_count: 0, icon_hash: null, created_at: '2026-01-01T00:00:00Z' };
  it('adds a guild with a valid owner_id', () => {
    useAuthStore.setState({ user: { id: 'viewer', username: 'viewer' } as User });
    dispatchGatewayEvent(SERVER, GatewayEvents.READY, {
      guilds: [{ id: 'g1', owner_id: 'owner-1', name: 'Guild One', member_count: 3, icon_hash: null, created_at: '2026-01-01T00:00:00Z', channels: [] }],
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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('guild core contract mismatch'));
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
    useAuthStore.setState({ user: { id: 'viewer' } as User });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dispatchGatewayEvent(SERVER, GatewayEvents.READY, {
      guilds: [
        {
          id: 'g1',
          owner_id: 'o1',
          name: 'G',
          member_count: 3, icon_hash: null, created_at: '2026-01-01T00:00:00Z',
          channels: [
            { id: 'c1', name: 'general', type: 0 },
            { name: 'broken' } as never,
          ],
        },
      ],
    });
    const channels = useChannelStore.getState().channelsByGuild[JSON.stringify([SERVER, 'viewer', 'g1'])] ?? [];
    expect(channels.map((c) => c.id)).toEqual(['c1']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('channel missing id'));
    warn.mockRestore();
  });
  it.each(['id', 'owner_id', 'name', 'member_count', 'icon_hash', 'created_at'] as const)('preserves confirmed guild metadata when READY omits %s', async field => {
    useAuthStore.setState({ user: { id: 'viewer' } as User });
    const scope = { serverId: SERVER, userId: 'viewer' };
    useGuildStore.getState().addGuild({ ...readyCore, name: 'Confirmed', member_count: 9, default_channel_id: 'confirmed-channel', description: 'Confirmed detail' }, scope);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await dispatchGatewayEvent(SERVER, GatewayEvents.READY, { guilds: [{ ...readyCore, [field]: undefined }] });
      expect(useGuildStore.getState().guilds).toHaveLength(1);
      expect(useGuildStore.getState().guilds[0]).toMatchObject({ name: 'Confirmed', member_count: 9, default_channel_id: 'confirmed-channel', description: 'Confirmed detail' });
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
  it('accepts a proven zero count while retaining confirmed detail settings and default channel', async () => {
    useAuthStore.setState({ user: { id: 'viewer' } as User });
    useGuildStore.getState().addGuild({ ...readyCore, member_count: 9, default_channel_id: 'confirmed-channel', description: 'Confirmed detail' }, { serverId: SERVER, userId: 'viewer' });
    await dispatchGatewayEvent(SERVER, GatewayEvents.READY, { guilds: [{ ...readyCore, channels: [{ id: 'different-channel', type: 0 }], description: 'Unvalidated READY detail' }] });
    expect(useGuildStore.getState().guilds[0]).toMatchObject({ member_count: 0, default_channel_id: 'confirmed-channel', description: 'Confirmed detail', created_at: readyCore.created_at });
  });
  it('preserves the confirmed projection when created_at passes the schema but is not a date', async () => {
    useAuthStore.setState({ user: { id: 'viewer' } as User });
    useGuildStore.getState().addGuild({ ...readyCore, name: 'Confirmed' }, { serverId: SERVER, userId: 'viewer' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await dispatchGatewayEvent(SERVER, GatewayEvents.READY, { guilds: [{ ...readyCore, created_at: 'not-a-date' }] });
      expect(useGuildStore.getState().guilds[0]).toMatchObject({ name: 'Confirmed', created_at: readyCore.created_at });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('guild invalid created_at'));
    } finally { warn.mockRestore(); }
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

  it('notifies for a message from another user in an unfocused channel', async () => {
    await dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_CREATE, { ...baseMessage });
    expect(notifications.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('does not notify for a message authored by the current user', async () => {
    await dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_CREATE, {
      ...baseMessage,
      author: { id: 'me', username: 'Me', discriminator: '0000' },
    });
    expect(notifications.sendNotification).not.toHaveBeenCalled();
  });

  it('does not notify when notifications are disabled', async () => {
    (notifications.isEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_CREATE, { ...baseMessage });
    expect(notifications.sendNotification).not.toHaveBeenCalled();
  });
});

describe('dispatch SPORTS_SCORE', () => {
  const score = (content: string, guildId = 'g-sports') => ({
    guild_id: guildId,
    game: 'football/nfl/100',
    league_path: 'football/nfl',
    event_id: '100',
    kind: 'score',
    content,
    team_id: '12',
    favorite_team_ids: ['12'],
    home: { id: '12', abbr: 'KC', name: 'Chiefs', score: 21, logo: '' },
    away: { id: '11', abbr: 'IND', name: 'Colts', score: 7, logo: '' },
  });

  beforeEach(() => {
    localStorage.clear();
    useAuthStore.setState({ user: { id: 'me' } as User });
    useNotificationPreferenceStore.setState({ byAccount: {} });
  });

  it('turns a favorite team score into one notification, even from two servers', async () => {
    await dispatchGatewayEvent(SERVER, GatewayEvents.SPORTS_SCORE, score('Touchdown — Chiefs 21, Colts 7') as never);
    await dispatchGatewayEvent(SERVER, GatewayEvents.SPORTS_SCORE, score('Touchdown — Chiefs 21, Colts 7', 'g-other') as never);
    expect(notifications.sendNotification).toHaveBeenCalledTimes(1);
    expect(notifications.sendNotification).toHaveBeenCalledWith('Chiefs score', 'Touchdown — Chiefs 21, Colts 7');
  });

  it('stays quiet for a muted server and ignores a malformed event', async () => {
    const scope = getServerAccountScope(SERVER);
    expect(scope).toBeTruthy();
    useNotificationPreferenceStore.setState({
      byAccount: {
        [accountScopeKey(scope!)]: {
          'g-sports': { space_id: 'g-sports', level: 0, muted: true, muted_until: null, muted_now: true, suppress_everyone: false },
        },
      },
    });
    await dispatchGatewayEvent(SERVER, GatewayEvents.SPORTS_SCORE, score('Field goal — Chiefs 24, Colts 7') as never);
    await dispatchGatewayEvent(SERVER, GatewayEvents.SPORTS_SCORE, { guild_id: 'g-sports' } as never);
    expect(notifications.sendNotification).not.toHaveBeenCalled();
  });
});

describe('dispatch reaction emoji keying', () => {
  beforeEach(() => useAuthStore.setState({ user: { id: 'u1' } as User }));
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

  it('does not establish an authenticated profile from READY alone', () => {
    useAuthStore.setState({ user: null });

    dispatchGatewayEvent(SERVER, GatewayEvents.READY, {
      user: { id: 'u2', username: 'fresh', flags: 0 },
      guilds: [],
      session_id: 's2',
    } as never);

    expect(useAuthStore.getState().user).toBeNull();
  });
});

describe('server-authorized mention attention', () => {
  it('refreshes only the event account and never guesses a mention count from message text', async () => {
    useAuthStore.setState({ user: { id: 'u1', username: 'me' } as User, token: 'token' });
    useReadStateStore.getState().reset();
    const refresh = vi.spyOn(useReadStateStore.getState(), 'refreshAfterEvent').mockImplementation(() => {});
    await dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_CREATE, { id: '123', channel_id: 'room', content: '@everyone <@u1>', author: { id: 'u2', username: 'other', discriminator: '0001' }, attachments: [], reactions: [] });
    expect(useReadStateStore.getState().getReadState({ serverId: SERVER, userId: 'u1' }, 'room')).toBeUndefined();
    dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_MENTION, { channel_id: 'room', message_id: '123' });
    expect(refresh).toHaveBeenCalledWith({ serverId: SERVER, userId: 'u1' });
    refresh.mockRestore();
  });
});


describe('message mutation attention', () => {
  it('invalidates previews on edits and refreshes authoritative counts on single and bulk deletion', async () => {
    useAuthStore.setState({ user: { id: 'u1', username: 'me' } as User, token: 'token' });
    useReadStateStore.getState().reset();
    const scope = { serverId: SERVER, userId: 'u1' };
    const refresh = vi.spyOn(useReadStateStore.getState(), 'refreshAfterEvent').mockImplementation(() => {});
    const invalidate = vi.spyOn(useReadStateStore.getState(), 'invalidateAttention');
    try {
      // This update envelope carries no verifiable author; the runtime answers
      // with the authoritative stored record the projection then applies.
      getTestMessagingRuntime(scope).acceptGatewayMutation.mockResolvedValueOnce({
        id: '123', channel_id: 'room', content: 'Revised',
        author: { id: 'u2', username: 'other', discriminator: '0001' },
        tts: false, mention_everyone: false, pinned: false, type: 0, attachments: [], reactions: [],
      });
      await dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_UPDATE, { id: '123', channel_id: 'room', content: 'Revised' });
      expect(invalidate).toHaveBeenLastCalledWith(scope, 'room');
      expect(refresh).not.toHaveBeenCalled();
      await dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_DELETE, { id: '123', channel_id: 'room' });
      await dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_DELETE_BULK, { ids: ['124', '125'], channel_id: 'room' });
      expect(invalidate).toHaveBeenCalledTimes(3);
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(refresh).toHaveBeenLastCalledWith(scope);
      expect(useReadStateStore.getState().attentionRevisions[JSON.stringify([SERVER, 'u1'])]?.room).toBe(3);
      useReadStateStore.getState().reset();
      expect(useReadStateStore.getState().attentionRevisions).toEqual({});
    } finally { refresh.mockRestore(); invalidate.mockRestore(); }
  });
});

it('applies ordered channel activity from create, delete and bulk-delete gateway envelopes', async () => {
  useAuthStore.setState({ user: { id: 'u1', username: 'me' } as User, token: 'token' });
  const scope = { serverId: SERVER, userId: 'u1' };
  useChannelStore.getState().addChannel({ id: '1', guild_id: '100', type: 0, name: 'Room', position: 0, nsfw: false, created_at: '2026-01-01', last_message_id: null, message_revision: '0' }, scope);
  const refresh = vi.spyOn(useReadStateStore.getState(), 'refreshAfterEvent').mockImplementation(() => {});
  const activity = (revision: string, tail: string | null) => ({ channel_id: '1', guild_id: '100', revision, last_message_id: tail });
  const current = () => useChannelStore.getState().channelsById[JSON.stringify([SERVER, 'u1', '1'])];
  const message = { id: '999', channel_id: '1', guild_id: '100', content: 'Hello', author: { id: 'u2', username: 'other', discriminator: '0001' }, attachments: [], reactions: [], channel_activity: activity('1', '999') };
  try {
    await dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_CREATE, message);
    expect(current()).toMatchObject({ message_revision: '1', last_message_id: '999' });
    await dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_DELETE, { id: '999', channel_id: '1', channel_activity: activity('2', null) });
    await dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_CREATE, message);
    expect(current()).toMatchObject({ message_revision: '2', last_message_id: null });
    await dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_DELETE_BULK, { ids: ['998'], channel_id: '1', channel_activity: activity('3', '997') });
    expect(current()).toMatchObject({ message_revision: '3', last_message_id: '997' });
  } finally { refresh.mockRestore(); }
});

describe('durable gateway dispatch acceptance', () => {
  const owned = { serverId: SERVER, userId: 'durable-owner' };
  const encryptedMessage = { id: '100', channel_id: 'durable-channel', author: { id: 'peer', username: 'Peer', discriminator: '0001' },
    content: '', e2ee: { version: 2, nonce: 'nonce', ciphertext: 'ciphertext', header: 'header' } };
  const stored = (overrides: Record<string, unknown> = {}) => ({
    id: '200', channel_id: 'durable-channel',
    author: { id: 'peer', username: 'Peer', discriminator: '0001' },
    content: 'Plaintext body', tts: false, mention_everyone: false, pinned: false,
    type: 0, attachments: [], reactions: [], ...overrides,
  }) as Message;
  beforeEach(() => { useAuthStore.setState({ user: { id: owned.userId, username: 'Owner' } as User }); });

  it('holds create projection until the durable mutation accepts', async () => {
    const runtime = getTestMessagingRuntime(owned);
    let commit!: (message: Message | null) => void;
    runtime.acceptGatewayMutation.mockReturnValueOnce(new Promise(resolve => { commit = resolve; }));
    const result = dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_CREATE, encryptedMessage);
    expect(result).toBeInstanceOf(Promise);
    let accepted = false; void result!.then(() => { accepted = true; });
    await Promise.resolve();
    expect(accepted).toBe(false);
    expect(getMessageStore(owned).getState().messages['durable-channel'] ?? []).toEqual([]);
    expect(runtime.acceptGatewayMutation).toHaveBeenCalledWith(expect.objectContaining({ kind: 'create', channelId: 'durable-channel', messageId: '100' }));
    commit(stored({ id: '100', e2ee: encryptedMessage.e2ee, content: '' }));
    await result;
    expect(accepted).toBe(true);
    expect(getMessageStore(owned).getState().messages['durable-channel'].map(message => message.id)).toEqual(['100']);
  });

  it('gates plain message creates on durable acceptance too', async () => {
    const runtime = getTestMessagingRuntime(owned);
    const result = dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_CREATE, stored());
    expect(result).toBeInstanceOf(Promise);
    expect(runtime.acceptGatewayMutation).toHaveBeenCalledWith(expect.objectContaining({ kind: 'create', channelId: 'durable-channel', messageId: '200' }));
    await result;
    expect(getMessageStore(owned).getState().messages['durable-channel'].map(message => message.id)).toEqual(['200']);
  });

  it('drops a create the durable layer never makes authoritative', async () => {
    const runtime = getTestMessagingRuntime(owned);
    runtime.acceptGatewayMutation.mockResolvedValueOnce(null);
    await dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_CREATE, stored());
    expect(getMessageStore(owned).getState().messages['durable-channel'] ?? []).toEqual([]);
  });

  it('rejects the dispatch and keeps the channel checkpoint when durable acceptance fails', async () => {
    const runtime = getTestMessagingRuntime(owned);
    useChannelStore.getState().addChannel({ id: '900', guild_id: '100', type: 0, name: 'Room', position: 0, nsfw: false, created_at: '2026-01-01', last_message_id: null, message_revision: '7' }, owned);
    runtime.acceptGatewayMutation.mockRejectedValueOnce(new Error('Durable journal unavailable'));
    await expect(dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_CREATE, {
      ...stored({ id: '901', channel_id: '900' }), guild_id: '100', message_revision: '9',
      channel_activity: { channel_id: '900', guild_id: '100', revision: '9', last_message_id: '901' },
    })).rejects.toThrow('Durable journal unavailable');
    expect(runtime.acceptGatewayMutation).toHaveBeenCalledWith(expect.objectContaining({ kind: 'create', channelId: '900', messageId: '901', revision: '9' }));
    expect(getMessageStore(owned).getState().messages['900'] ?? []).toEqual([]);
    expect(useChannelStore.getState().channelsById[JSON.stringify([SERVER, owned.userId, '900'])]?.message_revision).toBe('7');
  });

  it('keeps visible rows until delete persistence accepts', async () => {
    const runtime = getTestMessagingRuntime(owned);
    getMessageStore(owned).getState().addMessage('durable-channel', stored({ id: '100', content: 'Visible' }));
    let commit!: (message: Message | null) => void;
    runtime.acceptGatewayMutation.mockReturnValueOnce(new Promise(resolve => { commit = resolve; }));
    const result = dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_DELETE, { id: '100', channel_id: 'durable-channel' });
    expect(result).toBeInstanceOf(Promise);
    expect(getMessageStore(owned).getState().messages['durable-channel']).toHaveLength(1);
    commit(null);
    await result;
    expect(getMessageStore(owned).getState().messages['durable-channel']).toEqual([]);
    expect(runtime.acceptGatewayMutation).toHaveBeenCalledWith(expect.objectContaining({ kind: 'delete', channelId: 'durable-channel', messageId: '100' }));
  });

  it('serializes bulk deletion in revision order and stops the batch at its first failure', async () => {
    const runtime = getTestMessagingRuntime(owned);
    getMessageStore(owned).getState().setMessages('durable-channel', [stored({ id: '100' }), stored({ id: '101' }), stored({ id: '102' })]);
    runtime.acceptGatewayMutation.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Failed second tombstone'));
    await expect(dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_DELETE_BULK, {
      ids: ['102', '100', '101'], channel_id: 'durable-channel',
      message_revisions: { '100': '1', '101': '2', '102': '3' },
    })).rejects.toThrow('second tombstone');
    expect(runtime.acceptGatewayMutation.mock.calls).toEqual([
      [expect.objectContaining({ kind: 'delete', channelId: 'durable-channel', messageId: '100', revision: '1' })],
      [expect.objectContaining({ kind: 'delete', channelId: 'durable-channel', messageId: '101', revision: '2' })],
    ]);
    // The rejected batch never projected: every row remains cached.
    expect(getMessageStore(owned).getState().messages['durable-channel']).toHaveLength(3);
  });

  it('awaits the runtime handshake for READY and RESUMED', async () => {
    const runtime = getTestMessagingRuntime(owned);
    for (const event of [GatewayEvents.READY, GatewayEvents.RESUMED] as const) {
      let release!: () => void;
      runtime.acceptHandshake.mockReturnValueOnce(new Promise<void>(resolve => { release = resolve; }));
      const result = dispatchGatewayEvent(SERVER, event, { guilds: [] });
      expect(result).toBeInstanceOf(Promise);
      let settled = false; void result!.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      await result;
      expect(settled).toBe(true);
    }
  });

  it('keeps ordinary non-body dispatch synchronous', () => {
    expect(dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_REACTION_ADD, { channel_id: 'durable-channel', message_id: '100', user_id: 'peer', emoji: '👍' })).toBeUndefined();
    expect(dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_MENTION, { channel_id: 'durable-channel', message_id: '100' })).toBeUndefined();
  });
  it('rejects the projection continuation when its captured account is replaced after durable work', async () => {
    const runtime = getTestMessagingRuntime(owned); const signal = new AbortController().signal;
    runtime.captureGatewayLease.mockReturnValueOnce({ signal, assertCurrent: () => { if (useAuthStore.getState().user?.id !== owned.userId) throw new Error('Account replaced'); } });
    let commit!: (message: Message | null) => void;
    runtime.acceptGatewayMutation.mockReturnValueOnce(new Promise(resolve => { commit = resolve; }));
    const pending = dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_CREATE, stored());
    const failure = expect(pending).rejects.toThrow('Account replaced');
    useAuthStore.setState({ user: { id: 'replacement', username: 'Replacement' } as User });
    commit(stored()); await failure;
    expect(getMessageStore({ serverId: SERVER, userId: 'replacement' }).getState().messages['durable-channel'] ?? []).toEqual([]);
  });
  it('rejects a bulk projection continuation when the same account connection is paused', async () => {
    const runtime = getTestMessagingRuntime(owned); const abort = new AbortController();
    runtime.captureGatewayLease.mockReturnValueOnce({ signal: abort.signal, assertCurrent: () => abort.signal.throwIfAborted() });
    getMessageStore(owned).getState().setMessages('durable-channel', [stored({ id: '100' })]);
    let commit!: (message: Message | null) => void;
    runtime.acceptGatewayMutation.mockReturnValueOnce(new Promise(resolve => { commit = resolve; }));
    const pending = dispatchGatewayEvent(SERVER, GatewayEvents.MESSAGE_DELETE_BULK, { channel_id: 'durable-channel', ids: ['100'], message_revisions: { '100': '1' } });
    const failure = expect(pending).rejects.toThrow('Transport replaced');
    await Promise.resolve(); abort.abort(new Error('Transport replaced')); commit(null); await failure;
    expect(getMessageStore(owned).getState().messages['durable-channel']).toHaveLength(1);
  });
});

describe('CHANNEL_UPDATE and what you can still see', () => {
  const scope = { serverId: SERVER, userId: 'viewer' };

  beforeEach(() => {
    useAuthStore.setState({ user: { id: 'viewer', username: 'viewer' } as User });
    useChannelStore.getState().setChannels(
      'g1',
      [{ id: 'c1', guild_id: 'g1', type: 0, name: 'perm-loss', position: 0, nsfw: false, created_at: '' }],
      scope,
    );
  });

  it('re-asks which rooms you can see, so one you just lost leaves the screen', async () => {
    // The server sends the bare channel id when an overwrite moves — it is the
    // only notice somebody who just lost VIEW_CHANNEL gets.
    await dispatchGatewayEvent(SERVER, GatewayEvents.CHANNEL_UPDATE, { id: 'c1' });
    expect(refreshGuildChannelVisibility).toHaveBeenCalledWith('g1', scope);
  });
});


describe('membership event completeness', () => {
  it('refetches a discovered member with a user but no roles instead of caching a partial record', () => {
    useAuthStore.setState({ user: { id: 'viewer' } as User });
    const add = vi.spyOn(useMemberStore.getState(), 'addMember');
    const fetch = vi.spyOn(useMemberStore.getState(), 'fetchMembers').mockResolvedValue(undefined);
    try {
      dispatchGatewayEvent(SERVER, GatewayEvents.GUILD_MEMBER_ADD, {
        guild_id: 'g1', user: { id: 'joined', username: 'Joined' } as User,
      });
      expect(add).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledWith('g1', { serverId: SERVER, userId: 'viewer' });
    } finally { add.mockRestore(); fetch.mockRestore(); }
  });

  it('immediately applies a complete membership record', () => {
    useAuthStore.setState({ user: { id: 'viewer' } as User });
    const add = vi.spyOn(useMemberStore.getState(), 'addMember').mockImplementation(() => {});
    const fetch = vi.spyOn(useMemberStore.getState(), 'fetchMembers').mockResolvedValue(undefined);
    const data = { guild_id: 'g1', user: { id: 'joined', username: 'Joined' } as User, roles: ['g1'], joined_at: '2026-09-19T00:00:00Z', deaf: false, mute: false };
    try {
      dispatchGatewayEvent(SERVER, GatewayEvents.GUILD_MEMBER_ADD, data);
      expect(add).toHaveBeenCalledWith('g1', data, { serverId: SERVER, userId: 'viewer' });
      expect(fetch).not.toHaveBeenCalled();
    } finally { add.mockRestore(); fetch.mockRestore(); }
  });
});
