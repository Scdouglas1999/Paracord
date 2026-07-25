import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../types';
import { MessageType } from '../../types';
import { MessageList } from './MessageList';

const mocks = vi.hoisted(() => ({
  useMessagesReturn: {
    messages: [] as Message[],
    isLoading: false,
    hasMore: false,
    loadMore: vi.fn(),
    error: null as string | null,
    sendMessage: vi.fn(),
  },
  permissionsState: {
    permissions: 0n,
    isAdmin: false,
  },
  messageStoreState: {
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    deleteMessage: vi.fn(),
    editMessage: vi.fn(),
    pinMessage: vi.fn(),
    unpinMessage: vi.fn(),
    setMessages: vi.fn(),
    decryptingIds: new Set<string>(),
    fetchMessages: vi.fn(),
  },
  readStateStoreState: {
    markRead: vi.fn(),
  },
  updateReadStateForServer: vi.fn().mockResolvedValue({ data: {} }),
  scrollToIndex: vi.fn(),
  savedMessageStoreState: {
    serverId: 'srv-a',
    savedIds: new Set<string>(),
    load: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
}));

function makeMessage(over: Partial<Message> = {}): Message {
  return {
    id: over.id ?? 'msg-1',
    channel_id: over.channel_id ?? 'ch1',
    author: {
      id: 'author-1',
      username: 'Alice',
      discriminator: '0001',
      bot: false,
      flags: 0,
    },
    content: over.content ?? 'Hello there.',
    timestamp: '2026-05-17T12:00:00.000Z',
    created_at: '2026-05-17T12:00:00.000Z',
    tts: false,
    mention_everyone: false,
    pinned: false,
    type: MessageType.Default,
    attachments: [],
    reactions: [],
    ...over,
  };
}

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: index,
        start: index * 80,
      })),
    getTotalSize: () => options.count * 80,
    measureElement: vi.fn(),
    scrollToIndex: mocks.scrollToIndex,
  }),
}));

vi.mock('../../hooks/useMessages', () => ({
  useMessages: () => mocks.useMessagesReturn,
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => ({
    permissions: mocks.permissionsState.permissions,
    isAdmin: mocks.permissionsState.isAdmin,
  }),
}));

vi.mock('../../stores/messageStore', () => ({
  useMessageStore: (selector: (s: typeof mocks.messageStoreState) => unknown) =>
    selector(mocks.messageStoreState),
}));

vi.mock('../../stores/channelStore', () => {
  const state = {
    channelsByGuild: {
      g1: [
        { id: 'ch1', guild_id: 'g1', type: 0, channel_type: 0, name: 'general', position: 0 },
        { id: 'ch2', guild_id: 'g1', type: 0, channel_type: 0, name: 'random', position: 1 },
      ],
    },
    channelsById: {
      ch1: { id: 'ch1', guild_id: 'g1', type: 0, channel_type: 0, name: 'general', position: 0 },
      ch2: { id: 'ch2', guild_id: 'g1', type: 0, channel_type: 0, name: 'random', position: 1 },
    },
    addChannel: vi.fn(),
    updateChannel: vi.fn(),
  };
  return {
    useChannelStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});

vi.mock('../../stores/memberStore', () => {
  const state = { members: new Map() };
  return {
    useMemberStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});

vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (s: { user: { id: string } }) => unknown) => selector({ user: { id: 'viewer' } }),
}));

vi.mock('../../stores/readStateStore', () => ({
  useReadStateStore: Object.assign(
    (selector: (s: typeof mocks.readStateStoreState) => unknown) =>
      selector(mocks.readStateStoreState),
    { getState: () => mocks.readStateStoreState },
  ),
}));

vi.mock('../../stores/serverListStore', () => ({
  useServerListStore: Object.assign(
    (selector: (s: { activeServerId: string }) => unknown) =>
      selector({ activeServerId: 'srv-a' }),
    { getState: () => ({ activeServerId: 'srv-a' }) },
  ),
}));

vi.mock('../../stores/savedMessageStore', () => ({
  useSavedMessageStore: Object.assign(
    (selector: (s: typeof mocks.savedMessageStoreState) => unknown) =>
      selector(mocks.savedMessageStoreState),
    { getState: () => mocks.savedMessageStoreState },
  ),
}));

vi.mock('../../stores/typingStore', () => ({
  useTypingStore: (selector: (s: { typingByChannel: Record<string, string[]> }) => unknown) =>
    selector({ typingByChannel: {} }),
}));

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (s: { lowBandwidthMode: boolean }) => unknown) => selector({ lowBandwidthMode: false }),
}));

vi.mock('../../stores/lightboxStore', () => ({
  useLightboxStore: () => vi.fn(),
}));

vi.mock('../../stores/confirmStore', () => ({
  confirm: vi.fn(),
}));

vi.mock('../../stores/toastStore', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../api/channels', () => ({
  channelApi: {
    updateReadState: vi.fn().mockResolvedValue({ data: {} }),
    updateReadStateForServer: mocks.updateReadStateForServer,
    getThreads: vi.fn().mockResolvedValue({ data: [] }),
    getArchivedThreads: vi.fn().mockResolvedValue({ data: [] }),
    getEditHistory: vi.fn().mockResolvedValue({ data: [] }),
    bulkDeleteMessages: vi.fn().mockResolvedValue({ data: {} }),
    createThread: vi.fn().mockResolvedValue({ data: {} }),
    getOverwrites: vi.fn().mockResolvedValue({ data: [] }),
    deanonymizeMessage: vi.fn(),
  },
}));

vi.mock('../../api/guilds', () => ({
  guildApi: {
    getRoles: vi.fn().mockResolvedValue({ data: [] }),
    createReport: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('../../api/files', () => ({
  fileApi: {
    download: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../user/UserProfile', () => ({
  UserProfilePopup: () => null,
}));

vi.mock('../ui/EmojiPicker', () => ({
  EmojiPicker: () => null,
}));

vi.mock('./MessageEmbed', () => ({
  MessageEmbedCard: () => null,
  extractUrls: () => [],
}));

vi.mock('./GitHubEventEmbed', () => ({
  GitHubEventEmbed: () => null,
  isGitHubWebhookMessage: () => false,
}));

vi.mock('./PollMessageCard', () => ({
  PollMessageCard: () => null,
}));

vi.mock('./EphemeralMessage', () => ({
  EphemeralMessage: () => null,
}));

/**
 * Regression cover for the deep-link scroll hijack.
 *
 * The `#msg-<id>` jump effect depends on `rows`, which is rebuilt on every new
 * message, reaction and typing flicker. The found-row branch had no once-guard
 * and never cleared the hash, so after one jump from search every subsequent
 * render yanked the viewport back to that message — permanently. `?message=`
 * already had both a once-guard and a strip-after-success; the hash did not.
 */

/** Only the deep-link jump uses align:'center'; sticky-bottom uses align:'end'. */
function centerJumpCalls() {
  return mocks.scrollToIndex.mock.calls.filter(
    (call) => (call[1] as { align?: string } | undefined)?.align === 'center',
  );
}

describe('MessageList #msg- deep link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permissionsState.permissions = 0n;
    mocks.permissionsState.isAdmin = false;
    mocks.useMessagesReturn.messages = [];
    mocks.useMessagesReturn.error = null;
    mocks.useMessagesReturn.isLoading = false;
    mocks.scrollToIndex.mockClear();
    window.history.replaceState(null, '', '/app/guilds/g1/channels/ch1');
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it('scrolls to the hash target once and consumes the hash', async () => {
    mocks.useMessagesReturn.messages = [
      makeMessage({ id: 'older' }),
      makeMessage({ id: 'target' }),
    ];
    window.history.replaceState(null, '', '/app/guilds/g1/channels/ch1#msg-target');

    render(
      <MemoryRouter initialEntries={['/app/guilds/g1/channels/ch1']}>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );

    await waitFor(() => expect(centerJumpCalls().length).toBe(1));
    // The hash must be stripped, mirroring how `?message=` is consumed once its
    // target is in the loaded window.
    await waitFor(() => expect(window.location.hash).toBe(''));
  });

  it('does not re-scroll when rows rebuild after the jump', async () => {
    mocks.useMessagesReturn.messages = [
      makeMessage({ id: 'older' }),
      makeMessage({ id: 'target' }),
    ];
    window.history.replaceState(null, '', '/app/guilds/g1/channels/ch1#msg-target');

    const { rerender } = render(
      <MemoryRouter initialEntries={['/app/guilds/g1/channels/ch1']}>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );

    await waitFor(() => expect(centerJumpCalls().length).toBe(1));

    // A new message arrives: `rows` gets a fresh identity, which is exactly what
    // used to re-trigger the jump and drag the viewport back.
    for (let i = 0; i < 3; i++) {
      mocks.useMessagesReturn.messages = [
        ...mocks.useMessagesReturn.messages,
        makeMessage({ id: `later-${i}` }),
      ];
      rerender(
        <MemoryRouter initialEntries={['/app/guilds/g1/channels/ch1']}>
          <MessageList channelId="ch1" />
        </MemoryRouter>,
      );
      await waitFor(() => expect(centerJumpCalls().length).toBe(1));
    }

    expect(centerJumpCalls()).toHaveLength(1);
  });

  it('re-arms the guard for a different hash target', async () => {
    mocks.useMessagesReturn.messages = [
      makeMessage({ id: 'first' }),
      makeMessage({ id: 'second' }),
    ];
    window.history.replaceState(null, '', '/app/guilds/g1/channels/ch1#msg-first');

    const { rerender } = render(
      <MemoryRouter initialEntries={['/app/guilds/g1/channels/ch1']}>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(centerJumpCalls().length).toBe(1));

    // A second search jump to another message must still work.
    window.history.replaceState(null, '', '/app/guilds/g1/channels/ch1#msg-second');
    mocks.useMessagesReturn.messages = [...mocks.useMessagesReturn.messages];
    rerender(
      <MemoryRouter initialEntries={['/app/guilds/g1/channels/ch1']}>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );

    await waitFor(() => expect(centerJumpCalls().length).toBe(2));
  });
});
