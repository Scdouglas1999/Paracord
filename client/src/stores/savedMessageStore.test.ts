import { beforeEach, describe, expect, it, vi } from 'vitest';
import { savedMessagesApi } from '../api/savedMessages';
import { useSavedMessageStore } from './savedMessageStore';
import { useServerListStore } from './serverListStore';

vi.mock('../api/savedMessages', () => ({
  savedMessagesApi: {
    list: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
  },
}));

const item = {
  message: {
    id: 'message-1',
    channel_id: 'channel-1',
    author: { id: 'user-1', username: 'Ada', discriminator: '0001' },
    content: 'Review this launch note',
    tts: false,
    mention_everyone: false,
    pinned: false,
    type: 0,
    attachments: [],
    reactions: [],
  },
  saved_at: '2026-07-11T12:00:00Z',
  channel: { id: 'channel-1', name: 'launch', guild_id: 'guild-1' },
};

describe('savedMessageStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useServerListStore.setState({ activeServerId: null });
    useSavedMessageStore.getState().reset();
  });

  it('loads saved messages and builds the fast membership set', async () => {
    vi.mocked(savedMessagesApi.list).mockResolvedValue({ data: { items: [item], total: 1 } } as never);

    await useSavedMessageStore.getState().load();

    expect(useSavedMessageStore.getState().items).toEqual([item]);
    expect(useSavedMessageStore.getState().savedIds.has('message-1')).toBe(true);
    expect(useSavedMessageStore.getState().loaded).toBe(true);
  });

  it('optimistically saves and rolls back when the request fails', async () => {
    vi.mocked(savedMessagesApi.save).mockRejectedValue(new Error('offline'));

    const request = useSavedMessageStore.getState().save('message-2');
    expect(useSavedMessageStore.getState().savedIds.has('message-2')).toBe(true);
    await expect(request).rejects.toThrow('offline');
    expect(useSavedMessageStore.getState().savedIds.has('message-2')).toBe(false);
  });

  it('optimistically removes an item and restores it when the request fails', async () => {
    useSavedMessageStore.setState({ serverId: '__local__', items: [item], savedIds: new Set(['message-1']) });
    vi.mocked(savedMessagesApi.remove).mockRejectedValue(new Error('offline'));

    const request = useSavedMessageStore.getState().remove('message-1');
    expect(useSavedMessageStore.getState().items).toEqual([]);
    expect(useSavedMessageStore.getState().savedIds.has('message-1')).toBe(false);
    await expect(request).rejects.toThrow('offline');
    expect(useSavedMessageStore.getState().items).toEqual([item]);
    expect(useSavedMessageStore.getState().savedIds.has('message-1')).toBe(true);
  });

  it('does not carry saved-message state across servers', async () => {
    useServerListStore.setState({ activeServerId: 'server-a' });
    vi.mocked(savedMessagesApi.list).mockResolvedValueOnce({ data: { items: [item], total: 1 } } as never);
    await useSavedMessageStore.getState().load();
    expect(useSavedMessageStore.getState().savedIds.has('message-1')).toBe(true);

    useServerListStore.setState({ activeServerId: 'server-b' });
    vi.mocked(savedMessagesApi.list).mockResolvedValueOnce({ data: { items: [], total: 0 } } as never);
    await useSavedMessageStore.getState().load();

    expect(useSavedMessageStore.getState().serverId).toBe('server-b');
    expect(useSavedMessageStore.getState().items).toEqual([]);
    expect(useSavedMessageStore.getState().savedIds.has('message-1')).toBe(false);
  });
});
