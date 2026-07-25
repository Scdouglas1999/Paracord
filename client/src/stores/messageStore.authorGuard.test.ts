import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Regression cover for the crash that a bot reply used to cause.
 *
 * The server's interaction paths emit MESSAGE_CREATE with `author_id` (a
 * string) instead of the `author` object every other path emits. The gateway
 * cast the payload straight to `Message`, so an authorless record landed in the
 * store and the first render that read `msg.author.id` threw — and with a
 * single root ErrorBoundary, that took the whole app down.
 */

const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('./toastStore', () => ({ toast: mockToast }));

vi.mock('./pollStore', () => ({
  usePollStore: {
    getState: () => ({ clearPollsForChannel: vi.fn(), upsertPoll: vi.fn() }),
  },
}));

vi.mock('./channelStore', () => ({
  refreshGuildChannelVisibility: vi.fn(),
  useChannelStore: {
    getState: () => ({
      channelsByGuild: {},
      channelsById: {},
      selectedChannelId: 'ch1',
    }),
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
vi.mock('../api/channels', () => ({ channelApi: {} }));
vi.mock('../api/client', () => ({
  extractApiError: vi.fn((err: unknown) => (err instanceof Error ? err.message : 'error')),
}));
vi.mock('../lib/constants', () => ({ DEFAULT_MESSAGE_FETCH_LIMIT: 50 }));

import { useMessageStore, normalizeIncomingMessage } from './messageStore';
import { shouldGroup } from '../components/message/MessageList';

function resetStore() {
  useMessageStore.setState({
    messages: {},
    hasMore: {},
    loading: {},
    messageErrors: {},
    pins: {},
    decryptingIds: new Set<string>(),
  });
}

describe('normalizeIncomingMessage', () => {
  it('synthesizes an author from a bare author_id (the bot/slash-command shape)', () => {
    const normalized = normalizeIncomingMessage({
      id: 'm1',
      channel_id: 'ch1',
      content: 'pong',
      author_id: '987654321',
    });

    expect(normalized).not.toBeNull();
    expect(normalized!.author.id).toBe('987654321');
    // Every downstream consumer keys on the id; the label is corrected later.
    expect(normalized!.author.username).toBe('Unknown User');
    expect(normalized!.author.discriminator).toBe('0000');
  });

  it('rejects a payload with no resolvable author rather than storing it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(normalizeIncomingMessage({ id: 'm1', channel_id: 'ch1', content: 'x' })).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects payloads missing id or channel_id', () => {
    expect(normalizeIncomingMessage({ channel_id: 'ch1', author_id: 'u9' })).toBeNull();
    expect(normalizeIncomingMessage({ id: 'm1', author_id: 'u9' })).toBeNull();
    expect(normalizeIncomingMessage(null)).toBeNull();
    expect(normalizeIncomingMessage(undefined)).toBeNull();
  });

  it('fills partial author objects instead of leaving holes the UI dereferences', () => {
    const normalized = normalizeIncomingMessage({
      id: 'm1',
      channel_id: 'ch1',
      // A server that sends an author object but omits the display fields.
      author: { id: 'u5' } as never,
    });

    expect(normalized!.author).toMatchObject({
      id: 'u5',
      username: 'Unknown User',
      discriminator: '0000',
    });
  });

  it('preserves a well-formed author untouched', () => {
    const author = { id: 'u1', username: 'real', discriminator: '0001' };
    const normalized = normalizeIncomingMessage({ id: 'm1', channel_id: 'ch1', author });
    expect(normalized!.author).toMatchObject(author);
  });
});

describe('addMessage author guard', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it('stores an interaction payload with a usable author instead of dropping it', () => {
    useMessageStore.getState().addMessage('ch1', {
      id: 'm1',
      channel_id: 'ch1',
      content: 'pong',
      author_id: '42',
    });

    const stored = useMessageStore.getState().messages.ch1;
    expect(stored).toHaveLength(1);
    expect(stored[0].author.id).toBe('42');
  });

  it('never puts an authorless record in the cache', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    useMessageStore.getState().addMessage('ch1', {
      id: 'm1',
      channel_id: 'ch1',
      content: 'broken',
    });
    warn.mockRestore();

    expect(useMessageStore.getState().messages.ch1 ?? []).toHaveLength(0);
  });

  it('leaves every cached message with an author that shouldGroup can read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    useMessageStore.getState().addMessage('ch1', { id: 'm1', channel_id: 'ch1', author_id: '42' });
    useMessageStore.getState().addMessage('ch1', { id: 'm2', channel_id: 'ch1' });
    useMessageStore.getState().addMessage('ch1', { id: 'm3', channel_id: 'ch1', author_id: '42' });
    warn.mockRestore();

    const stored = useMessageStore.getState().messages.ch1;
    // This is the exact call that used to throw a TypeError and white-screen
    // the app; it must be safe for every message the store admits.
    expect(() => stored.forEach((m, i) => shouldGroup(stored[i - 1] ?? null, m))).not.toThrow();
  });
});

describe('shouldGroup resilience', () => {
  it('does not throw when either side has no author', () => {
    const withAuthor = { author: { id: 'u1' }, timestamp: '2026-01-01T00:00:00Z' };
    const authorless = { timestamp: '2026-01-01T00:00:30Z' } as { author?: { id?: string } };

    expect(() => shouldGroup(authorless, withAuthor)).not.toThrow();
    expect(() => shouldGroup(withAuthor, authorless)).not.toThrow();
    expect(shouldGroup(authorless, withAuthor)).toBe(false);
    expect(shouldGroup(withAuthor, authorless)).toBe(false);
  });

  it('never groups two authorless rows together', () => {
    const a = { timestamp: '2026-01-01T00:00:00Z' } as { author?: { id?: string } };
    const b = { timestamp: '2026-01-01T00:00:10Z' } as { author?: { id?: string } };
    expect(shouldGroup(a, b)).toBe(false);
  });
});
