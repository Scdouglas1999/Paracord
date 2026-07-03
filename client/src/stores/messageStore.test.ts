import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

const mockChannelApi = vi.hoisted(() => ({
  getMessages: vi.fn(),
  sendMessage: vi.fn(),
  editMessage: vi.fn(),
  deleteMessage: vi.fn(),
  getPins: vi.fn(),
  pinMessage: vi.fn(),
  unpinMessage: vi.fn(),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
}));

const mockChannelsByGuild = vi.hoisted((): { value: Record<string, Array<Record<string, unknown>>> } => ({
  value: {
    g1: [
      {
        id: 'ch1',
        type: 0,
        channel_type: 0,
        guild_id: 'g1',
        name: 'general',
        position: 0,
      },
    ],
  },
}));

const mockDmE2ee = vi.hoisted(() => ({
  decryptDmMessage: vi.fn(),
  encryptDmMessageV2: vi.fn(),
}));

const mockAccountSession = vi.hoisted(() => ({
  hasUnlockedPrivateKey: vi.fn(() => false),
  withUnlockedPrivateKey: vi.fn(),
}));

const mockAuthUser = vi.hoisted((): { value: { id: string } | null } => ({
  value: { id: 'u1' },
}));

const mockSelectedChannelId = vi.hoisted((): { value: string | null } => ({
  value: null,
}));

vi.mock('./toastStore', () => ({ toast: mockToast }));

vi.mock('./pollStore', () => ({
  usePollStore: {
    getState: () => ({
      clearPollsForChannel: vi.fn(),
      upsertPoll: vi.fn(),
    }),
  },
}));

vi.mock('./channelStore', () => ({
  useChannelStore: {
    getState: () => ({
      channelsByGuild: mockChannelsByGuild.value,
      selectedChannelId: mockSelectedChannelId.value,
    }),
  },
}));

vi.mock('../lib/dmE2ee', () => mockDmE2ee);

vi.mock('../lib/accountSession', () => mockAccountSession);

vi.mock('./authStore', () => ({
  useAuthStore: {
    getState: () => ({ user: mockAuthUser.value }),
  },
}));

vi.mock('../api/channels', () => ({ channelApi: mockChannelApi }));

vi.mock('../api/client', () => ({
  extractApiError: vi.fn((err: unknown) => {
    if (err instanceof Error) return err.message;
    return 'An unexpected error occurred';
  }),
}));

vi.mock('../lib/constants', () => ({
  DEFAULT_MESSAGE_FETCH_LIMIT: 50,
}));

import { useMessageStore, MAX_MESSAGES_PER_CHANNEL, MAX_CACHED_CHANNELS } from './messageStore';
import { encryptDmMessageV2 } from '../lib/dmE2ee';
import { hasUnlockedPrivateKey, withUnlockedPrivateKey } from '../lib/accountSession';

function makeMessage(overrides: Partial<{
  id: string;
  channel_id: string;
  content: string;
  pinned: boolean;
  reactions: Array<{ emoji: string; count: number; me: boolean }>;
}> = {}) {
  return {
    id: 'm1',
    channel_id: 'ch1',
    author: { id: 'u1', username: 'user1', discriminator: '0001' },
    content: 'Hello',
    tts: false,
    mention_everyone: false,
    pinned: false,
    type: 0,
    attachments: [],
    reactions: [],
    ...overrides,
  };
}

describe('messageStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelsByGuild.value = {
      g1: [
        {
          id: 'ch1',
          type: 0,
          channel_type: 0,
          guild_id: 'g1',
          name: 'general',
          position: 0,
        },
      ],
    };
    vi.mocked(hasUnlockedPrivateKey).mockReturnValue(false);
    vi.mocked(withUnlockedPrivateKey).mockReset();
    vi.mocked(encryptDmMessageV2).mockReset();
    mockAuthUser.value = { id: 'u1' };
    mockSelectedChannelId.value = null;
    useMessageStore.setState({
      messages: {},
      hasMore: {},
      loading: {},
      messageErrors: {},
      pins: {},
      decryptingIds: new Set<string>(),
    });
  });

  it('has correct initial state', () => {
    const state = useMessageStore.getState();
    expect(state.messages).toEqual({});
    expect(state.hasMore).toEqual({});
    expect(state.loading).toEqual({});
    expect(state.pins).toEqual({});
  });

  describe('fetchMessages', () => {
    it('fetches and stores messages for a channel', async () => {
      const msgs = [
        makeMessage({ id: 'm2', content: 'Newer' }),
        makeMessage({ id: 'm1', content: 'Older' }),
      ];
      mockChannelApi.getMessages.mockResolvedValue({ data: msgs });

      await useMessageStore.getState().fetchMessages('ch1');
      const state = useMessageStore.getState();
      // Messages should be reversed (API returns newest first, store keeps chronological)
      expect(state.messages['ch1']).toHaveLength(2);
      expect(state.messages['ch1'][0].id).toBe('m1');
      expect(state.messages['ch1'][1].id).toBe('m2');
      expect(state.loading['ch1']).toBe(false);
    });

    it('sets hasMore to true when result equals limit', async () => {
      const msgs = Array.from({ length: 50 }, (_, i) =>
        makeMessage({ id: `m${i}`, content: `Msg ${i}` }),
      );
      mockChannelApi.getMessages.mockResolvedValue({ data: msgs });

      await useMessageStore.getState().fetchMessages('ch1');
      expect(useMessageStore.getState().hasMore['ch1']).toBe(true);
    });

    it('sets hasMore to false when result is less than limit', async () => {
      mockChannelApi.getMessages.mockResolvedValue({ data: [makeMessage()] });

      await useMessageStore.getState().fetchMessages('ch1');
      expect(useMessageStore.getState().hasMore['ch1']).toBe(false);
    });

    it('does not fetch while already loading', async () => {
      useMessageStore.setState({ loading: { ch1: true } });
      await useMessageStore.getState().fetchMessages('ch1');
      expect(mockChannelApi.getMessages).not.toHaveBeenCalled();
    });

    it('shows toast on fetch failure', async () => {
      mockChannelApi.getMessages.mockRejectedValue(new Error('fail'));

      await useMessageStore.getState().fetchMessages('ch1');
      expect(mockToast.error).toHaveBeenCalled();
      expect(useMessageStore.getState().loading['ch1']).toBe(false);
    });

    it('prepends messages when params.before is specified', async () => {
      useMessageStore.setState({
        messages: { ch1: [makeMessage({ id: 'm3', content: 'Current' })] },
      });
      const olderMsgs = [
        makeMessage({ id: 'm2', content: 'Older 2' }),
        makeMessage({ id: 'm1', content: 'Older 1' }),
      ];
      mockChannelApi.getMessages.mockResolvedValue({ data: olderMsgs });

      await useMessageStore.getState().fetchMessages('ch1', { before: 'm3' });
      const messages = useMessageStore.getState().messages['ch1'];
      // Reversed older messages should come before existing
      expect(messages[0].id).toBe('m1');
      expect(messages[1].id).toBe('m2');
      expect(messages[2].id).toBe('m3');
    });
  });

  describe('sendMessage', () => {
    it('sends a message and adds it to the store', async () => {
      const sentMsg = makeMessage({ id: 'new1', content: 'New message' });
      mockChannelApi.sendMessage.mockResolvedValue({ data: sentMsg });

      await useMessageStore.getState().sendMessage('ch1', 'New message');
      const messages = useMessageStore.getState().messages['ch1'];
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('New message');
    });

    it('does not duplicate if message already exists', async () => {
      const existingMsg = makeMessage({ id: 'new1', content: 'Existing' });
      useMessageStore.setState({ messages: { ch1: [existingMsg] } });

      mockChannelApi.sendMessage.mockResolvedValue({ data: existingMsg });

      await useMessageStore.getState().sendMessage('ch1', 'Existing');
      expect(useMessageStore.getState().messages['ch1']).toHaveLength(1);
    });

    it('encrypts one-to-one DM content before sending to the API', async () => {
      const e2ee = { version: 2, nonce: 'nonce', ciphertext: 'ciphertext', header: 'header' };
      mockChannelsByGuild.value = {
        '': [
          {
            id: 'dm1',
            type: 1,
            channel_type: 1,
            guild_id: undefined,
            name: 'Friend',
            position: 0,
            recipient: { id: 'peer-1', username: 'Friend', public_key: 'peer-public-key' },
          },
        ],
      };
      vi.mocked(hasUnlockedPrivateKey).mockReturnValue(true);
      vi.mocked(withUnlockedPrivateKey).mockImplementation(async (callback) =>
        callback(new Uint8Array([1, 2, 3]))
      );
      vi.mocked(encryptDmMessageV2).mockResolvedValue(e2ee);
      mockChannelApi.sendMessage.mockResolvedValue({ data: makeMessage({ id: 'dm-msg', channel_id: 'dm1', content: '' }) });

      await useMessageStore.getState().sendMessage('dm1', 'secret hello');

      expect(encryptDmMessageV2).toHaveBeenCalledWith(
        'dm1',
        'secret hello',
        new Uint8Array([1, 2, 3]),
        'peer-public-key',
        'peer-1',
      );
      expect(mockChannelApi.sendMessage).toHaveBeenCalledWith('dm1', {
        content: '',
        referenced_message_id: undefined,
        attachment_ids: undefined,
        sticker_ids: undefined,
        e2ee,
      });
    });

    it('rejects one-to-one DM sends while the account key is locked', async () => {
      mockChannelsByGuild.value = {
        '': [
          {
            id: 'dm1',
            type: 1,
            channel_type: 1,
            guild_id: undefined,
            name: 'Friend',
            position: 0,
            recipient: { id: 'peer-1', username: 'Friend', public_key: 'peer-public-key' },
          },
        ],
      };
      vi.mocked(hasUnlockedPrivateKey).mockReturnValue(false);

      await expect(useMessageStore.getState().sendMessage('dm1', 'secret hello')).rejects.toThrow(
        'Unlock your account to send encrypted DMs',
      );
      expect(mockChannelApi.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('editMessage', () => {
    it('updates a message in the store', async () => {
      const original = makeMessage({ id: 'm1', content: 'Original' });
      useMessageStore.setState({ messages: { ch1: [original] } });

      const edited = makeMessage({ id: 'm1', content: 'Edited' });
      mockChannelApi.editMessage.mockResolvedValue({ data: edited });

      await useMessageStore.getState().editMessage('ch1', 'm1', 'Edited');
      expect(useMessageStore.getState().messages['ch1'][0].content).toBe('Edited');
    });
  });

  describe('deleteMessage', () => {
    it('removes a message from the store', async () => {
      const msg1 = makeMessage({ id: 'm1' });
      const msg2 = makeMessage({ id: 'm2' });
      useMessageStore.setState({ messages: { ch1: [msg1, msg2] } });
      mockChannelApi.deleteMessage.mockResolvedValue({});

      await useMessageStore.getState().deleteMessage('ch1', 'm1');
      const messages = useMessageStore.getState().messages['ch1'];
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe('m2');
    });
  });

  describe('setMessages', () => {
    it('sets messages for a channel directly', () => {
      const msgs = [makeMessage({ id: 'm1' }), makeMessage({ id: 'm2' })];
      useMessageStore.getState().setMessages('ch1', msgs);
      expect(useMessageStore.getState().messages['ch1']).toEqual(msgs);
    });
  });

  describe('addMessage (gateway handler)', () => {
    it('adds a new message', () => {
      const msg = makeMessage({ id: 'm1', content: 'Gateway msg' });
      useMessageStore.getState().addMessage('ch1', msg);
      expect(useMessageStore.getState().messages['ch1']).toHaveLength(1);
      expect(useMessageStore.getState().messages['ch1'][0].content).toBe('Gateway msg');
    });

    it('does not duplicate messages', () => {
      const msg = makeMessage({ id: 'm1' });
      useMessageStore.getState().addMessage('ch1', msg);
      useMessageStore.getState().addMessage('ch1', msg);
      expect(useMessageStore.getState().messages['ch1']).toHaveLength(1);
    });
  });

  describe('updateMessage (gateway handler)', () => {
    it('replaces an existing message by id', () => {
      const original = makeMessage({ id: 'm1', content: 'Old' });
      useMessageStore.setState({ messages: { ch1: [original] } });

      const updated = makeMessage({ id: 'm1', content: 'Updated' });
      useMessageStore.getState().updateMessage('ch1', updated);
      expect(useMessageStore.getState().messages['ch1'][0].content).toBe('Updated');
    });
  });

  describe('removeMessage (gateway handler)', () => {
    it('removes a message by id', () => {
      const msg = makeMessage({ id: 'm1' });
      useMessageStore.setState({ messages: { ch1: [msg] } });

      useMessageStore.getState().removeMessage('ch1', 'm1');
      expect(useMessageStore.getState().messages['ch1']).toHaveLength(0);
    });
  });

  describe('handleReactionAdd', () => {
    it('adds a new reaction to a message', () => {
      const msg = makeMessage({ id: 'm1', reactions: [] });
      useMessageStore.setState({ messages: { ch1: [msg] } });

      useMessageStore.getState().handleReactionAdd('ch1', 'm1', '👍', 'u2', 'u1');
      const reactions = useMessageStore.getState().messages['ch1'][0].reactions as Array<{
        emoji: string;
        count: number;
        me: boolean;
      }>;
      expect(reactions).toHaveLength(1);
      expect(reactions[0].emoji).toBe('👍');
      expect(reactions[0].count).toBe(1);
      expect(reactions[0].me).toBe(false);
    });

    it('marks me:true when current user adds reaction', () => {
      const msg = makeMessage({ id: 'm1', reactions: [] });
      useMessageStore.setState({ messages: { ch1: [msg] } });

      useMessageStore.getState().handleReactionAdd('ch1', 'm1', '👍', 'u1', 'u1');
      const reactions = useMessageStore.getState().messages['ch1'][0].reactions as Array<{
        emoji: string;
        count: number;
        me: boolean;
      }>;
      expect(reactions[0].me).toBe(true);
    });

    it('increments count on existing reaction', () => {
      const msg = makeMessage({
        id: 'm1',
        reactions: [{ emoji: '👍', count: 1, me: false }],
      });
      useMessageStore.setState({ messages: { ch1: [msg] } });

      useMessageStore.getState().handleReactionAdd('ch1', 'm1', '👍', 'u2', 'u1');
      const reactions = useMessageStore.getState().messages['ch1'][0].reactions as Array<{
        emoji: string;
        count: number;
        me: boolean;
      }>;
      expect(reactions[0].count).toBe(2);
    });
  });

  describe('handleReactionRemove', () => {
    it('decrements reaction count', () => {
      const msg = makeMessage({
        id: 'm1',
        reactions: [{ emoji: '👍', count: 2, me: false }],
      });
      useMessageStore.setState({ messages: { ch1: [msg] } });

      useMessageStore.getState().handleReactionRemove('ch1', 'm1', '👍', 'u2', 'u1');
      const reactions = useMessageStore.getState().messages['ch1'][0].reactions as Array<{
        emoji: string;
        count: number;
        me: boolean;
      }>;
      expect(reactions[0].count).toBe(1);
    });

    it('removes reaction when count reaches 0', () => {
      const msg = makeMessage({
        id: 'm1',
        reactions: [{ emoji: '👍', count: 1, me: false }],
      });
      useMessageStore.setState({ messages: { ch1: [msg] } });

      useMessageStore.getState().handleReactionRemove('ch1', 'm1', '👍', 'u2', 'u1');
      const reactions = useMessageStore.getState().messages['ch1'][0].reactions;
      expect(reactions).toHaveLength(0);
    });
  });

  describe('reaction double-count reconciliation', () => {
    it('does not double-count the actor own reaction on gateway echo', async () => {
      const msg = makeMessage({ id: 'm1', reactions: [] });
      useMessageStore.setState({ messages: { ch1: [msg] } });
      mockChannelApi.addReaction.mockResolvedValue({});

      // Optimistic add by the current user (u1).
      await useMessageStore.getState().addReaction('ch1', 'm1', '👍');
      // Gateway echoes the actor's own MESSAGE_REACTION_ADD.
      useMessageStore.getState().handleReactionAdd('ch1', 'm1', '👍', 'u1', 'u1');

      const reactions = useMessageStore.getState().messages['ch1'][0].reactions as Array<{
        emoji: string;
        count: number;
        me: boolean;
      }>;
      expect(reactions).toHaveLength(1);
      expect(reactions[0].count).toBe(1);
      expect(reactions[0].me).toBe(true);
    });

    it('does not under-count the actor own reaction removal on gateway echo', async () => {
      const msg = makeMessage({
        id: 'm1',
        reactions: [{ emoji: '👍', count: 1, me: true }],
      });
      useMessageStore.setState({ messages: { ch1: [msg] } });
      mockChannelApi.removeReaction.mockResolvedValue({});

      // Optimistic remove by the current user (u1) — count 1 -> reaction gone.
      await useMessageStore.getState().removeReaction('ch1', 'm1', '👍');
      // Gateway echoes the actor's own MESSAGE_REACTION_REMOVE.
      useMessageStore.getState().handleReactionRemove('ch1', 'm1', '👍', 'u1', 'u1');

      const reactions = useMessageStore.getState().messages['ch1'][0].reactions as Array<unknown>;
      expect(reactions).toHaveLength(0);
    });

    it('increments to 2 when a different user reacts after the actor', async () => {
      const msg = makeMessage({ id: 'm1', reactions: [] });
      useMessageStore.setState({ messages: { ch1: [msg] } });
      mockChannelApi.addReaction.mockResolvedValue({});

      await useMessageStore.getState().addReaction('ch1', 'm1', '👍');
      // Actor's own echo is reconciled (no double count)...
      useMessageStore.getState().handleReactionAdd('ch1', 'm1', '👍', 'u1', 'u1');
      // ...but a different user's reaction still increments.
      useMessageStore.getState().handleReactionAdd('ch1', 'm1', '👍', 'u2', 'u1');

      const reactions = useMessageStore.getState().messages['ch1'][0].reactions as Array<{
        emoji: string;
        count: number;
        me: boolean;
      }>;
      expect(reactions).toHaveLength(1);
      expect(reactions[0].count).toBe(2);
      expect(reactions[0].me).toBe(true);
    });
  });

  describe('messageErrors map', () => {
    it('sets messageErrors on fetch failure and clears it on a successful retry', async () => {
      mockChannelApi.getMessages.mockRejectedValue(new Error('boom'));

      await useMessageStore.getState().fetchMessages('ch1');
      expect(useMessageStore.getState().messageErrors['ch1']).toBe('boom');

      mockChannelApi.getMessages.mockResolvedValue({ data: [makeMessage()] });
      await useMessageStore.getState().fetchMessages('ch1');
      expect(useMessageStore.getState().messageErrors['ch1']).toBeNull();
    });
  });

  describe('updatePinState', () => {
    it('toggles pinned state on a message', () => {
      const msg = makeMessage({ id: 'm1', pinned: false });
      useMessageStore.setState({ messages: { ch1: [msg] } });

      useMessageStore.getState().updatePinState('ch1', 'm1', true);
      expect(useMessageStore.getState().messages['ch1'][0].pinned).toBe(true);

      useMessageStore.getState().updatePinState('ch1', 'm1', false);
      expect(useMessageStore.getState().messages['ch1'][0].pinned).toBe(false);
    });
  });

  describe('per-channel message cap', () => {
    it('trims oldest messages beyond the cap on setMessages, preserving order', () => {
      const overflow = 5;
      const msgs = Array.from({ length: MAX_MESSAGES_PER_CHANNEL + overflow }, (_, i) =>
        makeMessage({ id: `cap-${i}` }),
      );

      useMessageStore.getState().setMessages('cap-ch', msgs);

      const stored = useMessageStore.getState().messages['cap-ch'];
      expect(stored).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
      // Oldest `overflow` messages dropped; newest kept at the tail.
      expect(stored[0].id).toBe(`cap-${overflow}`);
      expect(stored[stored.length - 1].id).toBe(`cap-${MAX_MESSAGES_PER_CHANNEL + overflow - 1}`);
    });

    it('appending beyond the cap trims the oldest and keeps newest at the tail', () => {
      const seed = Array.from({ length: MAX_MESSAGES_PER_CHANNEL }, (_, i) =>
        makeMessage({ id: `a-${i}` }),
      );
      useMessageStore.getState().setMessages('cap-ch2', seed);

      useMessageStore.getState().addMessage('cap-ch2', makeMessage({ id: 'a-new' }));

      const stored = useMessageStore.getState().messages['cap-ch2'];
      expect(stored).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
      expect(stored[0].id).toBe('a-1'); // oldest ('a-0') evicted
      expect(stored[stored.length - 1].id).toBe('a-new');
    });
  });

  describe('LRU channel eviction', () => {
    it('evicts the least-recently-used channels but never the active one', () => {
      // The active channel is visited first, making it the least-recently-used;
      // it must survive eviction regardless.
      mockSelectedChannelId.value = 'lru-0';

      const total = MAX_CACHED_CHANNELS + 2;
      for (let i = 0; i < total; i++) {
        useMessageStore.getState().setMessages(`lru-${i}`, [makeMessage({ id: `m-${i}` })]);
      }

      const { messages } = useMessageStore.getState();
      expect(Object.keys(messages)).toHaveLength(MAX_CACHED_CHANNELS);
      // Active channel retained despite being the oldest access.
      expect(messages['lru-0']).toBeDefined();
      // The two oldest NON-active channels were dropped.
      expect(messages['lru-1']).toBeUndefined();
      expect(messages['lru-2']).toBeUndefined();
      // Most recently visited channels retained.
      expect(messages[`lru-${total - 1}`]).toBeDefined();
    });

    it('clears all channel-keyed aux maps for an evicted channel', () => {
      mockSelectedChannelId.value = 'aux-active';

      // Populate the victim channel and its parallel channel-keyed maps.
      useMessageStore.getState().setMessages('aux-victim', [makeMessage({ id: 'v1' })]);
      useMessageStore.setState((s) => ({
        hasMore: { ...s.hasMore, 'aux-victim': true },
        pins: { ...s.pins, 'aux-victim': [makeMessage({ id: 'pin1' })] },
        messageErrors: { ...s.messageErrors, 'aux-victim': 'boom' },
      }));
      // Keep the active channel present so it is never a victim.
      useMessageStore.getState().setMessages('aux-active', [makeMessage({ id: 'a1' })]);

      // Flood with fresh channels to push the (older, non-active) victim out.
      for (let i = 0; i < MAX_CACHED_CHANNELS; i++) {
        useMessageStore.getState().setMessages(`aux-fill-${i}`, [makeMessage({ id: `f-${i}` })]);
      }

      const state = useMessageStore.getState();
      expect(state.messages['aux-victim']).toBeUndefined();
      expect(state.hasMore['aux-victim']).toBeUndefined();
      expect(state.pins['aux-victim']).toBeUndefined();
      expect(state.messageErrors['aux-victim']).toBeUndefined();
      // The active channel survived eviction.
      expect(state.messages['aux-active']).toBeDefined();
    });
  });
});
