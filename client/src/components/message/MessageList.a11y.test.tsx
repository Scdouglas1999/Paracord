import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
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

describe('MessageList keyboard accessibility and error state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permissionsState.permissions = 0n;
    mocks.permissionsState.isAdmin = false;
    mocks.useMessagesReturn.messages = [];
    mocks.useMessagesReturn.error = null;
    mocks.useMessagesReturn.isLoading = false;
    mocks.readStateStoreState.markRead.mockReset();
    mocks.updateReadStateForServer.mockClear();
    mocks.scrollToIndex.mockClear();
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

  it('jumps to and temporarily highlights a message targeted by the inbox query', async () => {
    mocks.useMessagesReturn.messages = [makeMessage({ id: 'saved-message' })];

    render(
      <MemoryRouter initialEntries={['/app/guilds/g1/channels/ch1?message=saved-message']}>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );

    const row = await screen.findByRole('article', { name: /Alice/ });
    await waitFor(() => expect(mocks.scrollToIndex).toHaveBeenCalled());
    await waitFor(() => {
      expect(row.getAttribute('style')).toContain('background-color: var(--accent-tint-strong)');
      expect(row.getAttribute('style')).toContain('border-left: 2px solid var(--accent-primary)');
    });
  });

  it('reveals the per-message action toolbar when a message row receives keyboard focus', async () => {
    mocks.permissionsState.permissions = 1n << 6n; // ADD_REACTIONS
    mocks.useMessagesReturn.messages = [makeMessage()];

    render(
      <MemoryRouter>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );

    const row = await screen.findByRole('article', { name: /Alice/ });

    // Toolbar is hidden until the row is hovered or focused.
    expect(screen.queryByRole('button', { name: 'Add Reaction' })).toBeNull();

    fireEvent.focus(row);

    expect(screen.getByRole('button', { name: 'Add Reaction' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument();
  });

  it('renders an error banner with a retry control instead of the welcome empty state when the fetch failed', async () => {
    mocks.useMessagesReturn.messages = [];
    mocks.useMessagesReturn.error = 'Failed to load messages.';

    render(
      <MemoryRouter>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Failed to load messages.');
    expect(screen.queryByText('#general is ready when you are')).toBeNull();

    const retry = screen.getByRole('button', { name: /retry/i });
    fireEvent.click(retry);

    expect(mocks.messageStoreState.fetchMessages).toHaveBeenCalledWith('ch1');
  });

  it('shows the welcome empty state when the channel is genuinely empty with no error', async () => {
    mocks.useMessagesReturn.messages = [];
    mocks.useMessagesReturn.error = null;

    render(
      <MemoryRouter>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );

    expect(await screen.findByText('#general is ready when you are')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('marks a re-entered channel read even when the cached message count is unchanged', async () => {
    mocks.useMessagesReturn.messages = [makeMessage({ id: 'msg-1', channel_id: 'ch1' })];

    const { rerender } = render(
      <MemoryRouter>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(mocks.readStateStoreState.markRead).toHaveBeenCalledWith('srv-a', 'ch1', 'msg-1');
    });
    mocks.readStateStoreState.markRead.mockClear();

    // Same array length as ch1: the re-entry mark-read must be keyed by channel
    // + latest message id, not only by messages.length.
    mocks.useMessagesReturn.messages = [makeMessage({ id: 'msg-2', channel_id: 'ch2' })];
    rerender(
      <MemoryRouter>
        <MessageList channelId="ch2" />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(mocks.readStateStoreState.markRead).toHaveBeenCalledWith('srv-a', 'ch2', 'msg-2');
    });
  });
});
