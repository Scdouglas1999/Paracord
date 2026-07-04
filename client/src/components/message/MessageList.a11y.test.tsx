import { fireEvent, render, screen } from '@testing-library/react';
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
}));

function makeMessage(): Message {
  return {
    id: 'msg-1',
    channel_id: 'ch1',
    author: {
      id: 'author-1',
      username: 'Alice',
      discriminator: '0001',
      bot: false,
      flags: 0,
    },
    content: 'Hello there.',
    timestamp: '2026-05-17T12:00:00.000Z',
    created_at: '2026-05-17T12:00:00.000Z',
    tts: false,
    mention_everyone: false,
    pinned: false,
    type: MessageType.Default,
    attachments: [],
    reactions: [],
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
    scrollToIndex: vi.fn(),
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
      g1: [{ id: 'ch1', guild_id: 'g1', type: 0, channel_type: 0, name: 'general', position: 0 }],
    },
    channelsById: {
      ch1: { id: 'ch1', guild_id: 'g1', type: 0, channel_type: 0, name: 'general', position: 0 },
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
    getThreads: vi.fn().mockResolvedValue({ data: [] }),
    getArchivedThreads: vi.fn().mockResolvedValue({ data: [] }),
    getEditHistory: vi.fn().mockResolvedValue({ data: [] }),
    bulkDeleteMessages: vi.fn().mockResolvedValue({ data: {} }),
    createThread: vi.fn().mockResolvedValue({ data: {} }),
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

  it('reveals the per-message action toolbar when a message row receives keyboard focus', async () => {
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
});
