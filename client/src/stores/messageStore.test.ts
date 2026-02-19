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
      channelsByGuild: {
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
    }),
  },
}));

vi.mock('../lib/dmE2ee', () => ({
  decryptDmMessage: vi.fn(),
  encryptDmMessageV2: vi.fn(),
}));

vi.mock('../lib/accountSession', () => ({
  hasUnlockedPrivateKey: vi.fn(() => false),
  withUnlockedPrivateKey: vi.fn(),
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

import { useMessageStore } from './messageStore';

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
    useMessageStore.setState({
      messages: {},
      hasMore: {},
      loading: {},
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
});
