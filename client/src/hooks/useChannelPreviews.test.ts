import { act, renderHook, waitFor } from '@testing-library/react';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelPreview } from '../api/generated/ChannelPreview';
import type { Message } from '../types';
import {
  authorsNewestFirst,
  compareMessageIds,
  effectivePreviews,
  previewFromMessage,
  previewFromWire,
  snowflakeTime,
  useChannelPreviews,
  type ChannelPreviewEntry,
} from './useChannelPreviews';
import { resetServerFeaturesForTests, serverLacks } from '../lib/serverFeatures';

const getChannelPreviews = vi.hoisted(() => vi.fn());
const messageStore = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../api/channels', () => ({
  createChannelApi: () => ({ getChannelPreviews }),
}));
vi.mock('../lib/operationContext', () => ({
  captureScopedOperation: () => ({
    api: {},
    signal: new AbortController().signal,
    assertCurrent: () => {},
    dispose: () => {},
  }),
}));
vi.mock('./useMessageStore', () => ({
  useCurrentMessageStoreApi: () => messageStore.current,
}));

const SCOPE = { serverId: 'srv', userId: 'u1' };

function wire(over: Partial<ChannelPreview> & Pick<ChannelPreview, 'channel_id' | 'message_id'>): ChannelPreview {
  return {
    message_type: 0,
    author_id: 'u2',
    author_kind: 'user',
    author_name: 'Jeremy',
    content: 'hello',
    truncated: false,
    encrypted: false,
    created_at: '2026-10-01T21:09:00-05:00',
    media: null,
    attachment_count: 0,
    has_sticker: false,
    ...over,
  };
}

function message(over: Partial<Message> & Pick<Message, 'id' | 'channel_id'>): Message {
  return {
    author: { id: 'u3', username: 'nick', display_name: 'Nick', discriminator: '1', avatar_hash: 'data:image/png;base64,AAAA' },
    content: 'new message',
    created_at: '2026-10-01T21:15:00-05:00',
    tts: false,
    mention_everyone: false,
    pinned: false,
    type: 0,
    attachments: [],
    reactions: [],
    ...over,
  } as Message;
}

describe('previewFromWire', () => {
  it('keeps what a row needs', () => {
    const entry = previewFromWire(
      wire({
        channel_id: 'c1',
        message_id: '10',
        content: null,
        media: { attachment_id: 'a1', content_type: 'image/png', filename: 'x.png', width: 4, height: 3 },
        attachment_count: 2,
        author_kind: 'webhook',
        author_name: 'Deploys',
      }),
    );
    expect(entry).toMatchObject({
      channelId: 'c1',
      messageId: '10',
      content: null,
      attachmentCount: 2,
      media: { attachmentId: 'a1', contentType: 'image/png', filename: 'x.png' },
      author: { id: 'u2', kind: 'webhook', name: 'Deploys', avatar: null },
    });
  });
});

describe('previewFromMessage', () => {
  it('reads a message the way the server would have described it', () => {
    const entry = previewFromMessage(
      message({
        id: '11',
        channel_id: 'c1',
        content: 'look',
        attachments: [{ id: 'a2', filename: 'y.png', size: 1, content_type: 'image/png', url: '/x', width: 10, height: 10 }],
      }),
    );
    expect(entry).toMatchObject({
      messageId: '11',
      content: 'look',
      author: { id: 'u3', kind: 'user', name: 'Nick', avatar: 'data:image/png;base64,AAAA' },
      media: { attachmentId: 'a2', contentType: 'image/png' },
      attachmentCount: 1,
    });
  });

  it('has no text and no picture for an encrypted message', () => {
    const entry = previewFromMessage(
      message({
        id: '12',
        channel_id: 'c1',
        e2ee: {} as never,
        content: 'ciphertext-ish',
        attachments: [{ id: 'a3', filename: 'z.png', size: 1, content_type: 'image/png', url: '/x' }],
      }),
    );
    expect(entry).toMatchObject({ encrypted: true, content: null, media: null, attachmentCount: 0 });
  });

  it('reads an anonymous message as its alias and a feed post as the feed', () => {
    const anonymous = previewFromMessage(message({ id: '13', channel_id: 'c1', anonymous: { alias: 'Otter', is_anonymous: true, can_deanonymize: false } }));
    expect(anonymous.author).toEqual({ id: 'anon:c1:Otter', kind: 'anonymous', name: 'Otter', avatar: null });
    const feed = previewFromMessage(message({ id: '14', channel_id: 'c1', feed: { id: 'f1', kind: 'rss', name: 'Patch feed' } }));
    expect(feed.author).toEqual({ id: 'f1', kind: 'feed', name: 'Patch feed', avatar: null });
  });

  it('uses a poll’s question as its text', () => {
    const entry = previewFromMessage(message({ id: '15', channel_id: 'c1', content: '', type: 20, poll: { question: 'Late one?' } as never }));
    expect(entry).toMatchObject({ content: 'Late one?', messageType: 20 });
  });
});

describe('ids and authors', () => {
  it('orders snowflakes as numbers, not as text', () => {
    expect(compareMessageIds('9', '10')).toBe(-1);
    expect(compareMessageIds('10', '9')).toBe(1);
    expect(compareMessageIds('10', '10')).toBe(0);
  });

  it('decodes when a snowflake was minted, and refuses what is not one', () => {
    const ms = Date.UTC(2026, 9, 1, 12, 0, 0);
    const id = ((BigInt(ms - 1704067200000) << 22n) + 5n).toString();
    expect(snowflakeTime(id)).toBe(ms);
    expect(snowflakeTime('abc')).toBeNull();
    expect(snowflakeTime(null)).toBeNull();
  });

  it('lists the distinct authors of a timeline, newest first', () => {
    const list = [
      message({ id: '1', channel_id: 'c', author: { id: 'a', username: 'a', discriminator: '1' } }),
      message({ id: '2', channel_id: 'c', author: { id: 'b', username: 'b', discriminator: '1' } }),
      message({ id: '3', channel_id: 'c', author: { id: 'a', username: 'a', discriminator: '1' } }),
    ];
    expect(authorsNewestFirst(list, 5).map((author) => author.id)).toEqual(['a', 'b']);
    expect(authorsNewestFirst(list, 1).map((author) => author.id)).toEqual(['a']);
  });
});

describe('effectivePreviews', () => {
  const fetched = new Map<string, ChannelPreviewEntry>([['c1', previewFromWire(wire({ channel_id: 'c1', message_id: '100', content: 'old' }))]]);

  it('keeps the fetched preview when the store has nothing or something older', () => {
    const channels = [{ id: 'c1', last_message_id: '100' }];
    expect(effectivePreviews(fetched, channels, {}).get('c1')?.content).toBe('old');
    expect(effectivePreviews(fetched, channels, { c1: [message({ id: '90', channel_id: 'c1' })] }).get('c1')?.content).toBe('old');
  });

  it('follows a newer message in the store, and an edit of the previewed one', () => {
    const channels = [{ id: 'c1', last_message_id: '101' }];
    expect(effectivePreviews(fetched, channels, { c1: [message({ id: '101', channel_id: 'c1', content: 'fresh' })] }).get('c1')?.content).toBe('fresh');
    const edited = effectivePreviews(fetched, [{ id: 'c1', last_message_id: '100' }], { c1: [message({ id: '100', channel_id: 'c1', content: 'edited' })] });
    expect(edited.get('c1')?.content).toBe('edited');
  });

  it('does not trust a timeline that stops short of the channel’s newest message', () => {
    // The store holds an old window (opened around an old message): the channel's
    // tail is 500, the store's newest is 200, and 200 is newer than the fetched 100.
    const preview = effectivePreviews(fetched, [{ id: 'c1', last_message_id: '500' }], { c1: [message({ id: '200', channel_id: 'c1' })] });
    expect(preview.get('c1')?.messageId).toBe('100');
  });

  it('has an entry only for a channel that has a message', () => {
    const result = effectivePreviews(fetched, [{ id: 'c1' }, { id: 'c2' }], {});
    expect([...result.keys()]).toEqual(['c1']);
  });

  it('can show a message the server has not been asked about yet', () => {
    const result = effectivePreviews(new Map(), [{ id: 'c9', last_message_id: '7' }], { c9: [message({ id: '7', channel_id: 'c9', content: 'first' })] });
    expect(result.get('c9')?.content).toBe('first');
  });
});

describe('useChannelPreviews', () => {
  const CHANNELS = [{ id: 'c1', last_message_id: '100' }];

  beforeEach(() => {
    getChannelPreviews.mockReset();
    getChannelPreviews.mockResolvedValue({ data: [wire({ channel_id: 'c1', message_id: '100', content: 'old' })] });
    messageStore.current = createStore(() => ({ messages: {} as Record<string, Message[]>, deletedMessageIds: new Set<string>() }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const store = () =>
    messageStore.current as StoreApi<{ messages: Record<string, Message[]>; deletedMessageIds: Set<string> }>;

  it('asks the server once and hands back the previews', async () => {
    const { result } = renderHook(() => useChannelPreviews('g1', SCOPE, CHANNELS));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(getChannelPreviews).toHaveBeenCalledTimes(1);
    expect(getChannelPreviews.mock.calls[0][0]).toBe('g1');
    expect(result.current.previews.get('c1')?.content).toBe('old');
    expect(result.current.recentAuthors.get('c1')?.[0]).toMatchObject({ id: 'u2', name: 'Jeremy' });
  });

  it('follows a new message from the store without another request', async () => {
    const { result } = renderHook(() => useChannelPreviews('g1', SCOPE, [{ id: 'c1', last_message_id: '101' }]));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => {
      store().setState({ messages: { c1: [message({ id: '101', channel_id: 'c1', content: 'fresh' })] } });
    });
    expect(result.current.previews.get('c1')).toMatchObject({ messageId: '101', content: 'fresh' });
    // The newest speaker leads the recent authors, then the fetched one.
    expect(result.current.recentAuthors.get('c1')?.map((author) => author.id)).toEqual(['u3']);
    expect(getChannelPreviews).toHaveBeenCalledTimes(1);
  });

  it('asks again, once, when the previewed message is deleted', async () => {
    const { result } = renderHook(() => useChannelPreviews('g1', SCOPE, CHANNELS));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    getChannelPreviews.mockResolvedValue({ data: [wire({ channel_id: 'c1', message_id: '99', content: 'the one before' })] });
    act(() => {
      store().setState({ deletedMessageIds: new Set(['100']) });
    });
    await waitFor(() => expect(getChannelPreviews).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.previews.get('c1')?.content).toBe('the one before'));
    // The deleted id is not asked about twice.
    act(() => {
      store().setState({ deletedMessageIds: new Set(['100']) });
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(getChannelPreviews).toHaveBeenCalledTimes(2);
  });

  it('says so when the server cannot answer, and shows no previews', async () => {
    getChannelPreviews.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useChannelPreviews('g1', SCOPE, CHANNELS));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBeTruthy();
    expect(result.current.previews.size).toBe(0);
  });

  it('reads a server without the route as one older than previews: no error, store previews only, asked once', async () => {
    resetServerFeaturesForTests();
    getChannelPreviews.mockRejectedValue({ isAxiosError: true, response: { status: 404, data: '' } });
    const { result, unmount } = renderHook(() => useChannelPreviews('g1', SCOPE, [{ id: 'c1', last_message_id: '101' }]));
    await waitFor(() => expect(result.current.status).toBe('unsupported'));
    expect(result.current.error).toBeNull();
    expect(serverLacks('srv', 'channelPreviews')).toBe(true);
    // A channel whose messages are loaded still shows its newest one.
    act(() => {
      store().setState({ messages: { c1: [message({ id: '101', channel_id: 'c1', content: 'fresh' })] } });
    });
    expect(result.current.previews.get('c1')).toMatchObject({ messageId: '101', content: 'fresh' });
    unmount();
    const again = renderHook(() => useChannelPreviews('g2', SCOPE, CHANNELS));
    await waitFor(() => expect(again.result.current.status).toBe('unsupported'));
    expect(getChannelPreviews).toHaveBeenCalledTimes(1);
    resetServerFeaturesForTests();
  });

  it('asks again for another server, and never shows the old one’s previews for it', async () => {
    const { result, rerender } = renderHook(({ guild }) => useChannelPreviews(guild, SCOPE, CHANNELS), { initialProps: { guild: 'g1' } });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    getChannelPreviews.mockResolvedValue({ data: [] });
    rerender({ guild: 'g2' });
    expect(result.current.status).toBe('loading');
    expect(result.current.previews.size).toBe(0);
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(getChannelPreviews.mock.calls[1][0]).toBe('g2');
  });

  it('does nothing without a server', () => {
    const { result } = renderHook(() => useChannelPreviews(null, null, CHANNELS));
    expect(result.current.status).toBe('idle');
    expect(getChannelPreviews).not.toHaveBeenCalled();
  });

  it('asks again when the gateway says the account’s permissions may have changed', async () => {
    const { result } = renderHook(() => useChannelPreviews('g1', SCOPE, CHANNELS));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    // Another account's change is not ours.
    act(() => {
      window.dispatchEvent(new CustomEvent('paracord:conversation-capabilities-changed', { detail: { serverId: 'other', userId: 'x' } }));
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(getChannelPreviews).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new CustomEvent('paracord:conversation-capabilities-changed', { detail: SCOPE }));
    });
    await waitFor(() => expect(getChannelPreviews).toHaveBeenCalledTimes(2));
  });
});
