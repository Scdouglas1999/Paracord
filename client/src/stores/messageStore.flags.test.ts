import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Regression cover for ephemeral messages becoming permanently public.
 *
 * `build_message_json` omits `flags` entirely, so a refetch returns `undefined`
 * where the live gateway payload carried the EPHEMERAL bit (64). The UI gate is
 * `(msg.flags ?? 0) & 64`, which was therefore true while the message was live
 * and false after any refetch — an ephemeral bot reply silently promoted itself
 * into a normal message visible to the whole channel.
 */

const mockChannelApi = vi.hoisted(() => ({
  getMessages: vi.fn(),
  getPins: vi.fn(),
  editMessage: vi.fn(),
}));

vi.mock('./toastStore', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('./pollStore', () => ({
  usePollStore: {
    getState: () => ({ clearPollsForChannel: vi.fn(), upsertPoll: vi.fn() }),
  },
}));
vi.mock('./channelStore', () => ({
  refreshGuildChannelVisibility: vi.fn(),
  useChannelStore: {
    getState: () => ({ channelsByGuild: {}, channelsById: {}, selectedChannelId: 'ch1' }),
  },
}));
vi.mock('../lib/dmE2ee', () => ({ encryptDmMessageV2: vi.fn() }));
vi.mock('../lib/dmE2eeWorker', () => ({ decryptDmMessageOffthread: vi.fn() }));
vi.mock('../lib/groupDmE2ee', () => ({
  decryptGroupDmMessage: vi.fn(),
  encryptGroupDmMessage: vi.fn(),
}));
vi.mock('../lib/accountSession', () => ({
  hasUnlockedPrivateKey: vi.fn(() => false),
  withUnlockedPrivateKey: vi.fn(),
}));
vi.mock('./authStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u1' } }) },
}));
vi.mock('./serverListStore', () => ({
  useServerListStore: { getState: () => ({ getActiveServer: () => undefined }) },
}));
vi.mock('../api/channels', () => ({ channelApi: mockChannelApi }));
vi.mock('../api/client', () => ({
  extractApiError: vi.fn((err: unknown) => (err instanceof Error ? err.message : 'error')),
}));
vi.mock('../lib/constants', () => ({ DEFAULT_MESSAGE_FETCH_LIMIT: 50 }));

import { useMessageStore } from './messageStore';

const EPHEMERAL = 64;

function makeMessage(over: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    channel_id: 'ch1',
    author: { id: 'bot-1', username: 'bot', discriminator: '0000' },
    content: 'only you can see this',
    tts: false,
    mention_everyone: false,
    pinned: false,
    type: 0,
    attachments: [],
    reactions: [],
    ...over,
  };
}

describe('flags survive a refetch that omits them', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMessageStore.setState({
      messages: {},
      hasMore: {},
      loading: {},
      messageErrors: {},
      pins: {},
      decryptingIds: new Set<string>(),
    });
  });

  it('keeps the EPHEMERAL bit when the server response has no flags field', async () => {
    // Live gateway delivery carries the flag.
    useMessageStore.getState().addMessage('ch1', makeMessage({ flags: EPHEMERAL }) as never);
    expect(useMessageStore.getState().messages.ch1[0].flags).toBe(EPHEMERAL);

    // The refetch response omits `flags` entirely, as the real serializer does.
    mockChannelApi.getMessages.mockResolvedValue({ data: [makeMessage()] });
    await useMessageStore.getState().fetchMessages('ch1');

    const refetched = useMessageStore.getState().messages.ch1[0];
    expect(refetched.id).toBe('m1');
    expect((refetched.flags ?? 0) & EPHEMERAL).toBe(EPHEMERAL);
  });

  it('lets the server override flags when it actually sends them', async () => {
    useMessageStore.getState().addMessage('ch1', makeMessage({ flags: EPHEMERAL }) as never);

    // An explicit 0 is a real value, not an omission — honour it.
    mockChannelApi.getMessages.mockResolvedValue({ data: [makeMessage({ flags: 0 })] });
    await useMessageStore.getState().fetchMessages('ch1');

    expect(useMessageStore.getState().messages.ch1[0].flags).toBe(0);
  });

  it('does not invent flags for messages it has never seen', async () => {
    mockChannelApi.getMessages.mockResolvedValue({
      data: [makeMessage({ id: 'never-seen' })],
    });
    await useMessageStore.getState().fetchMessages('ch1');

    expect(useMessageStore.getState().messages.ch1[0].flags).toBeUndefined();
  });

  it('preserves flags on pinned copies too', async () => {
    useMessageStore.getState().addMessage('ch1', makeMessage({ flags: EPHEMERAL }) as never);
    mockChannelApi.getPins.mockResolvedValue({ data: [makeMessage()] });

    await useMessageStore.getState().fetchPins('ch1');

    expect((useMessageStore.getState().pins.ch1[0].flags ?? 0) & EPHEMERAL).toBe(EPHEMERAL);
  });

  it('preserves flags across an edit response', async () => {
    useMessageStore.getState().addMessage('ch1', makeMessage({ flags: EPHEMERAL }) as never);
    mockChannelApi.editMessage.mockResolvedValue({
      data: makeMessage({ content: 'edited' }),
    });

    await useMessageStore.getState().editMessage('ch1', 'm1', 'edited');

    const edited = useMessageStore.getState().messages.ch1[0];
    expect(edited.content).toBe('edited');
    expect((edited.flags ?? 0) & EPHEMERAL).toBe(EPHEMERAL);
  });
});
