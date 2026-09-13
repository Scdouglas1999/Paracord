vi.mock('../lib/messages/accountMessagingRuntime', async () => (await import('../test/messagingRuntimeMock')).messagingRuntimeMock);
import { getTestMessagingRuntime } from '../test/messagingRuntimeMock';
vi.mock('../lib/operationContext', () => ({
  captureScopedOperation: (scope: { serverId: string; userId: string }) => {
    const controller = new AbortController();
    return { scope, signal: controller.signal, api: {}, assertCurrent() { controller.signal.throwIfAborted(); }, dispose() { controller.abort(); } };
  },
}));
import { useChannelStore } from './channelStore';
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
  refreshGuildChannelVisibility: vi.fn(),
  useChannelStore: {
    getState: () => ({
      channelsByGuild: mockChannelsByGuild.value,
      channelsById: Object.fromEntries(
        Object.values(mockChannelsByGuild.value)
          .flat()
          .map((channel) => [String(channel.id), channel]),
      ),
      selectedChannelId: mockSelectedChannelId.value,
    }),
  },
}));

vi.mock('../lib/dmE2ee', () => mockDmE2ee);

vi.mock('../lib/accountSession', () => mockAccountSession);

vi.mock('./authStore', () => ({
  useAuthStore: { subscribe: () => () => {},
    getState: () => ({ user: mockAuthUser.value }),
  },
}));

vi.mock('../api/channels', () => ({ channelApi: mockChannelApi, createChannelApi: () => mockChannelApi }));

vi.mock('../api/client', () => ({
  extractApiError: vi.fn((err: unknown) => {
    if (err instanceof Error) return err.message;
    return 'An unexpected error occurred';
  }),
}));

vi.mock('../lib/constants', () => ({
  DEFAULT_MESSAGE_FETCH_LIMIT: 50,
}));

import { getMessageStore, cancelMessageFetch, MAX_MESSAGES_PER_CHANNEL, MAX_CACHED_CHANNELS } from './messageStore';
const useMessageStore = getMessageStore({ serverId: '__local__', userId: 'u1' });

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
    useMessageStore.getState().reset();
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
      const response = deferred<{ data: ReturnType<typeof makeMessage>[] }>();
      mockChannelApi.getMessages.mockReturnValueOnce(response.promise);
      const first = useMessageStore.getState().fetchMessages('ch1');
      await useMessageStore.getState().fetchMessages('ch1');
      expect(mockChannelApi.getMessages).toHaveBeenCalledTimes(1);
      response.resolve({ data: [] });
      await first;
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

  describe('durable message actions', () => {
    const runtime = getTestMessagingRuntime({ serverId: '__local__', userId: 'u1' });
    it('accepts a draft through the runtime and projects only its delivery receipt', async () => {
      const draft = { revision: 'revision', content: 'New message' };
      await useMessageStore.getState().sendMessage('ch1', draft.content, 'reply', ['file'], ['sticker'], draft);
      expect(runtime.send).toHaveBeenCalledWith('ch1', draft.content, 'reply', ['file'], ['sticker'], draft, undefined);
      expect(mockChannelApi.sendMessage).not.toHaveBeenCalled();
      expect(useMessageStore.getState().messages.ch1).toBeUndefined();
      const message = makeMessage({ id: 'new1', content: draft.content });
      runtime.emit({ kind: 'create', message });
      runtime.emit({ kind: 'create', message });
      expect(useMessageStore.getState().messages.ch1).toEqual([message]);
    });
    it('propagates encrypted storage/identity rejection and leaves draft ownership with its caller', async () => {
      runtime.send.mockRejectedValueOnce(new Error('Encrypted storage unavailable'));
      await expect(useMessageStore.getState().sendMessage('ch1', 'Keep this text')).rejects.toThrow('Encrypted storage unavailable');
      expect(mockChannelApi.sendMessage).not.toHaveBeenCalled();
      expect(useMessageStore.getState().offlineQueue).toEqual([]);
    });
    it('routes DM text through the same durable boundary without using the legacy cipher', async () => {
      await useMessageStore.getState().sendMessage('dm1', 'secret hello');
      expect(runtime.send).toHaveBeenCalledWith('dm1', 'secret hello', undefined, undefined, undefined, undefined, undefined);
      expect(encryptDmMessageV2).not.toHaveBeenCalled();
      expect(mockChannelApi.sendMessage).not.toHaveBeenCalled();
    });
    it('projects an edit only after its authoritative receipt', async () => {
      const original = makeMessage({ content: 'Original' });
      useMessageStore.setState({ messages: { ch1: [original] } });
      await useMessageStore.getState().editMessage('ch1', 'm1', 'Edited');
      expect(runtime.editMessage).toHaveBeenCalledWith(original, 'Edited');
      expect(useMessageStore.getState().messages.ch1[0].content).toBe('Original');
      runtime.emit({ kind: 'edit', message: { ...original, content: 'Edited', edited_timestamp: '2026-01-01T00:00:01Z' } });
      expect(useMessageStore.getState().messages.ch1[0].content).toBe('Edited');
    });
    it('projects a delete only after its durable receipt and never resurrects a deleted row from an edit receipt', async () => {
      const original = makeMessage();
      useMessageStore.setState({ messages: { ch1: [original] } });
      await useMessageStore.getState().deleteMessage('ch1', 'm1');
      expect(runtime.deleteMessage).toHaveBeenCalledWith(original);
      expect(useMessageStore.getState().messages.ch1).toHaveLength(1);
      runtime.emit({ kind: 'delete', channelId: 'ch1', messageId: 'm1' });
      runtime.emit({ kind: 'edit', message: { ...original, content: 'Late', edited_timestamp: '2026-01-01T00:00:01Z' } });
      expect(useMessageStore.getState().messages.ch1).toEqual([]);
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


function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('asynchronous encrypted message hydration', () => {
  const encrypted = (ciphertext: string) => ({ ...makeMessage(), e2ee: { version: 2, nonce: 'nonce', ciphertext } });

  beforeEach(() => {
    useMessageStore.getState().reset();
    vi.clearAllMocks();
    mockChannelsByGuild.value = { dm: [{ id: 'ch1', type: 1, recipient: { id: 'peer', public_key: 'peer-key' } }] };
    mockAccountSession.hasUnlockedPrivateKey.mockReturnValue(true);
  });

  it('keeps the newer edit when old ciphertext finishes decrypting last', async () => {
    const old = deferred<string>();
    const newer = deferred<string>();
    getTestMessagingRuntime({ serverId: '__local__', userId: 'u1' }).decrypt.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
    useMessageStore.getState().addMessage('ch1', encrypted('old'));
    useMessageStore.getState().updateMessage('ch1', encrypted('new'));
    newer.resolve('new plaintext');
    await vi.waitFor(() => expect(useMessageStore.getState().messages.ch1[0].content).toBe('new plaintext'));
    old.resolve('stale plaintext');
    await old.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(useMessageStore.getState().messages.ch1[0].content).toBe('new plaintext');
    expect(useMessageStore.getState().decryptingIds.size).toBe(0);
  });

  it('preserves pin and reaction metadata received during decryption', async () => {
    const plaintext = deferred<string>();
    getTestMessagingRuntime({ serverId: '__local__', userId: 'u1' }).decrypt.mockReturnValueOnce(plaintext.promise);
    useMessageStore.getState().addMessage('ch1', encrypted('ciphertext'));
    useMessageStore.getState().updateMessage('ch1', { id: 'm1', pinned: true, reactions: [{ emoji: '👍', count: 2, me: false }] });
    plaintext.resolve('Hello privately');
    await vi.waitFor(() => expect(useMessageStore.getState().messages.ch1[0].content).toBe('Hello privately'));
    expect(useMessageStore.getState().messages.ch1[0]).toMatchObject({ pinned: true, reactions: [{ emoji: '👍', count: 2, me: false }] });
  });

  it('does not resurrect a deleted row after decryption', async () => {
    const plaintext = deferred<string>();
    getTestMessagingRuntime({ serverId: '__local__', userId: 'u1' }).decrypt.mockReturnValueOnce(plaintext.promise);
    useMessageStore.getState().addMessage('ch1', encrypted('ciphertext'));
    useMessageStore.getState().removeMessage('ch1', 'm1');
    plaintext.resolve('deleted');
    await plaintext.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(useMessageStore.getState().messages.ch1).toEqual([]);
    expect(useMessageStore.getState().decryptingIds.size).toBe(0);
  });

  it('does not restore a pin when deletion arrives while its ciphertext is decrypting', async () => {
    const runtime = getTestMessagingRuntime({ serverId: '__local__', userId: 'u1' });
    const plaintext = deferred<string>(); runtime.decrypt.mockReturnValueOnce(plaintext.promise);
    mockChannelApi.getPins.mockResolvedValueOnce({ data: [encrypted('pin')] });
    runtime.filterDeletedMessages.mockImplementationOnce(async rows => rows).mockResolvedValueOnce([]);
    const pins = useMessageStore.getState().fetchPins('ch1');
    await vi.waitFor(() => expect(runtime.decrypt).toHaveBeenCalledTimes(1));
    runtime.emit({ kind: 'delete', channelId: 'ch1', messageId: 'm1' });
    plaintext.resolve('Deleted pin plaintext'); await pins;
    expect(useMessageStore.getState().pins.ch1).toEqual([]);
  });

  it('does not restore a pin when authority reports an unpin during decryption', async () => {
    const runtime = getTestMessagingRuntime({ serverId: '__local__', userId: 'u1' });
    const plaintext = deferred<string>(); runtime.decrypt.mockReturnValueOnce(plaintext.promise);
    const pinned = { ...encrypted('pin'), pinned: true, message_revision: '1' };
    mockChannelApi.getPins.mockResolvedValueOnce({ data: [pinned] });
    runtime.filterDeletedMessages.mockImplementationOnce(async rows => rows)
      .mockImplementationOnce(async rows => rows.map(message => ({ ...message, pinned: false, message_revision: '2' })));
    const pins = useMessageStore.getState().fetchPins('ch1');
    await vi.waitFor(() => expect(runtime.decrypt).toHaveBeenCalledTimes(1));
    plaintext.resolve('Unpinned plaintext'); await pins;
    expect(useMessageStore.getState().pins.ch1).toEqual([]);
  });

  it('removes an authoritatively unpinned row from pins while retaining its channel message', () => {
    const runtime = getTestMessagingRuntime({ serverId: '__local__', userId: 'u1' });
    const pinned = { ...makeMessage({ pinned: true }), message_revision: '1' };
    useMessageStore.setState({ messages: { ch1: [pinned] }, pins: { ch1: [pinned] } });
    runtime.emit({ kind: 'authoritative', channelId: 'ch1', hidden: [], present: [{ ...pinned, pinned: false, message_revision: '2' }] });
    expect(useMessageStore.getState().pins.ch1).toEqual([]);
    expect(useMessageStore.getState().messages.ch1).toEqual([{ ...pinned, pinned: false, message_revision: '2' }]);
  });

  it('cannot decrypt into another login even when the row and ciphertext IDs match', async () => {
    const plaintext = deferred<string>();
    getTestMessagingRuntime({ serverId: '__local__', userId: 'u1' }).decrypt.mockReturnValueOnce(plaintext.promise);
    const message = encrypted('ciphertext');
    useMessageStore.getState().addMessage('ch1', message);
    useMessageStore.getState().reset();
    useMessageStore.getState().setMessages('ch1', [{ ...message, content: 'other login' }]);
    plaintext.resolve('previous login secret');
    await plaintext.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(useMessageStore.getState().messages.ch1[0].content).toBe('other login');
  });
});

describe('history and realtime ordering', () => {
  beforeEach(() => {
    useMessageStore.getState().reset();
    vi.clearAllMocks();
    mockAccountSession.hasUnlockedPrivateKey.mockReturnValue(false);
    mockChannelsByGuild.value = { g1: [{ id: 'ch1', type: 0, guild_id: 'g1' }] };
  });

  it('keeps a realtime create received after the HTTP snapshot', async () => {
    const response = deferred<{ data: ReturnType<typeof makeMessage>[] }>();
    mockChannelApi.getMessages.mockReturnValueOnce(response.promise);
    const pending = useMessageStore.getState().fetchMessages('ch1');
    useMessageStore.getState().addMessage('ch1', makeMessage({ id: 'm2', content: 'arrived live' }));
    response.resolve({ data: [makeMessage({ id: 'm1' })] });
    await pending;
    expect(useMessageStore.getState().messages.ch1.map(m => m.id)).toEqual(['m1', 'm2']);
  });

  it('applies edits to messages not cached when the event arrived', async () => {
    const response = deferred<{ data: ReturnType<typeof makeMessage>[] }>();
    mockChannelApi.getMessages.mockReturnValueOnce(response.promise);
    const pending = useMessageStore.getState().fetchMessages('ch1');
    useMessageStore.getState().updateMessage('ch1', { id: 'm1', content: 'edited while loading' });
    response.resolve({ data: [makeMessage({ id: 'm1', content: 'stale' })] });
    await pending;
    expect(useMessageStore.getState().messages.ch1[0].content).toBe('edited while loading');
  });

  it('does not resurrect deleted messages from history or a replayed create', async () => {
    const response = deferred<{ data: ReturnType<typeof makeMessage>[] }>();
    mockChannelApi.getMessages.mockReturnValueOnce(response.promise);
    const pending = useMessageStore.getState().fetchMessages('ch1');
    useMessageStore.getState().removeMessages('ch1', ['m1', 'm2']);
    useMessageStore.getState().addMessage('ch1', makeMessage({ id: 'm1' }));
    response.resolve({ data: [makeMessage({ id: 'm2' }), makeMessage({ id: 'm1' })] });
    await pending;
    expect(useMessageStore.getState().messages.ch1).toEqual([]);
  });

  it('deduplicates overlapping pages while keeping the current version', async () => {
    useMessageStore.getState().setMessages('ch1', [makeMessage({ id: 'm2', content: 'current' })]);
    mockChannelApi.getMessages.mockResolvedValueOnce({ data: [makeMessage({ id: 'm2', content: 'stale' }), makeMessage({ id: 'm1' })] });
    await useMessageStore.getState().fetchMessages('ch1', { before: 'm3' });
    expect(useMessageStore.getState().messages.ch1.map(m => [m.id, m.content])).toEqual([['m1', 'Hello'], ['m2', 'current']]);
  });

  it('keeps an around-anchor response a historical window', async () => {
    const response = deferred<{ data: ReturnType<typeof makeMessage>[] }>();
    mockChannelApi.getMessages.mockReturnValueOnce(response.promise);
    const pending = useMessageStore.getState().fetchMessages('ch1', { around: 'm1' });
    useMessageStore.getState().addMessage('ch1', makeMessage({ id: 'm9' }));
    response.resolve({ data: [makeMessage({ id: 'm1' })] });
    await pending;
    expect(useMessageStore.getState().messages.ch1.map(m => m.id)).toEqual(['m1']);
  });

  it('does not let an aborted request clear a replacement request or its loading state', async () => {
    const old = deferred<{ data: ReturnType<typeof makeMessage>[] }>();
    const next = deferred<{ data: ReturnType<typeof makeMessage>[] }>();
    mockChannelApi.getMessages.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const first = useMessageStore.getState().fetchMessages('ch1');
    await vi.waitFor(() => expect(mockChannelApi.getMessages).toHaveBeenCalledTimes(1));
    cancelMessageFetch({ serverId: '__local__', userId: 'u1' }, 'ch1');
    const second = useMessageStore.getState().fetchMessages('ch1');
    old.resolve({ data: [makeMessage({ id: 'old' })] });
    await first;
    expect(useMessageStore.getState().messages.ch1).toBeUndefined();
    expect(useMessageStore.getState().loading.ch1).toBe(true);
    next.resolve({ data: [makeMessage({ id: 'new' })] });
    await second;
    expect(useMessageStore.getState().messages.ch1.map(m => m.id)).toEqual(['new']);
    expect(useMessageStore.getState().loading.ch1).toBe(false);
  });

  it('rejects late results and cleanup from a prior login generation', async () => {
    const old = deferred<{ data: ReturnType<typeof makeMessage>[] }>();
    mockChannelApi.getMessages.mockReturnValueOnce(old.promise);
    const pending = useMessageStore.getState().fetchMessages('ch1');
    await vi.waitFor(() => expect(mockChannelApi.getMessages).toHaveBeenCalledTimes(1));
    useMessageStore.getState().reset();
    old.resolve({ data: [makeMessage({ id: 'previous-account' })] });
    await pending;
    expect(useMessageStore.getState().messages).toEqual({});
    expect(useMessageStore.getState().loading).toEqual({});
  });

  it('keeps a successful send that arrives before the gateway echo', async () => {
    const history = deferred<{ data: ReturnType<typeof makeMessage>[] }>();
    mockChannelApi.getMessages.mockReturnValueOnce(history.promise);

    const pending = useMessageStore.getState().fetchMessages('ch1');
    await useMessageStore.getState().sendMessage('ch1', 'Hello');
    getTestMessagingRuntime({ serverId: '__local__', userId: 'u1' }).emit({ kind: 'create', message: makeMessage({ id: 'm2' }) });
    history.resolve({ data: [makeMessage({ id: 'm1' })] });
    await pending;
    expect(useMessageStore.getState().messages.ch1.map(m => m.id)).toEqual(['m1', 'm2']);
  });
});

vi.mock('../lib/channelView', () => ({
  getAccountChannelView: () => useChannelStore.getState(),
}));
