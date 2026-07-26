import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import type { Message } from '../../types';
import { MessageType } from '../../types';
import { MessageList } from './MessageList';

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
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
  },
}));

const messages: Message[] = [
  {
    id: 'msg-1',
    channel_id: 'ch1',
    author: {
      id: 'anon-user',
      username: 'Anonymous User',
      discriminator: '0000',
      bot: false,
      flags: 0,
    },
    content: 'Anonymous launch feedback.',
    timestamp: '2026-05-17T12:00:00.000Z',
    created_at: '2026-05-17T12:00:00.000Z',
    tts: false,
    mention_everyone: false,
    pinned: false,
    type: MessageType.Default,
    attachments: [],
    reactions: [],
    anonymous: {
      alias: 'Anonymous User',
      is_anonymous: true,
      can_deanonymize: true,
    },
    expires_at: '2026-05-17T13:00:00.000Z',
  },
];

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
  useMessages: () => ({
    messages,
    isLoading: false,
    hasMore: false,
    loadMore: vi.fn(),
  }),
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => ({
    permissions: mocks.permissionsState.permissions,
    isAdmin: mocks.permissionsState.isAdmin,
  }),
}));

vi.mock('../../stores/messageStore', () => {
  return {
    useMessageStore: (selector: (s: typeof mocks.messageStoreState) => unknown) =>
      selector(mocks.messageStoreState),
  };
});

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
  const state = {
    members: new Map(),
  };
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
    error: mocks.toastError,
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('../../api/channels', () => ({
  channelApi: {
    updateReadState: vi.fn().mockResolvedValue({ data: {} }),
    updateReadStateForServer: vi.fn().mockResolvedValue({ data: {} }),
    getThreads: vi.fn().mockResolvedValue({ data: [] }),
    getArchivedThreads: vi.fn().mockResolvedValue({ data: [] }),
    getEditHistory: vi.fn().mockResolvedValue({ data: [] }),
    bulkDeleteMessages: vi.fn().mockResolvedValue({ data: {} }),
    createThread: vi.fn().mockResolvedValue({ data: {} }),
    getOverwrites: vi.fn().mockResolvedValue({ data: [] }),
    deanonymizeMessage: vi.fn().mockResolvedValue({
      data: {
        message_id: 'msg-1',
        channel_id: 'ch1',
        user_id: 'real-user',
        alias: 'Anonymous User',
        user: { id: 'real-user', username: 'alice', discriminator: '0001' },
      },
    }),
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

describe('MessageList anonymous and disappearing message display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permissionsState.permissions = 0n;
    mocks.permissionsState.isAdmin = false;
    messages[0].attachments = [];
    messages[0].stickers = [];
    messages[0].reactions = [];
    messages[0].pinned = false;
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

  it('renders anonymous and expiry indicators for channel feature messages', async () => {
    render(
      <MemoryRouter>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Anonymous launch feedback.')).toBeInTheDocument();
    expect(screen.getByText('Anonymous')).toBeInTheDocument();
    expect(screen.getByText(/expires/i)).toBeInTheDocument();
  });

  it('shows reaction API failures to the user', async () => {
    const user = userEvent.setup();
    messages[0].reactions = [{ emoji: '👍', count: 1, me: false }];
    mocks.messageStoreState.addReaction.mockRejectedValueOnce(new Error('Reaction blocked'));

    render(
      <MemoryRouter>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: /👍/ }));

    expect(mocks.toastError).toHaveBeenCalledWith('Failed to add reaction: Reaction blocked');
  });

  it('shows pin failures from the message context menu', async () => {
    const user = userEvent.setup();
    mocks.permissionsState.isAdmin = true;
    mocks.messageStoreState.pinMessage.mockRejectedValueOnce(new Error('Missing manage messages'));

    render(
      <MemoryRouter>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );

    fireEvent.contextMenu(await screen.findByRole('article', { name: /Anonymous User/ }), {
      clientX: 16,
      clientY: 16,
    });
    await user.click(await screen.findByRole('menuitem', { name: /Pin Message/ }));

    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to pin message: Missing manage messages',
    );
  });

  it('does not render unsafe sticker image URLs', async () => {
    messages[0].stickers = [
      {
        id: 'sticker-1',
        guild_id: 'g1',
        name: 'unsafe_sticker',
        description: null,
        format_type: 1,
        creator_id: null,
        image_url: 'javascript:alert(1)',
        created_at: '2026-05-17T12:00:00.000Z',
      },
    ];

    const { container } = render(
      <MemoryRouter>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );

    expect(await screen.findByText('unsafe_sticker')).toBeInTheDocument();
    expect(container.querySelector('img[src^="javascript:"]')).toBeNull();
  });

  it('falls back to a file row for unsafe image attachment URLs', async () => {
    messages[0].attachments = [
      {
        id: 'att-1',
        filename: 'unsafe.png',
        size: 1024,
        content_type: 'image/png',
        url: '//evil.example/unsafe.png',
      },
    ];

    const { container } = render(
      <MemoryRouter>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('button', { name: 'unsafe.png' })).toBeInTheDocument();
    expect(container.querySelector('img[src="//evil.example/unsafe.png"]')).toBeNull();
  });

  it('offers Reveal Author when can_deanonymize is true', async () => {
    const user = userEvent.setup();
    mocks.permissionsState.isAdmin = true;

    render(
      <MemoryRouter>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );

    fireEvent.contextMenu(await screen.findByRole('article', { name: /Anonymous User/ }), {
      clientX: 16,
      clientY: 16,
    });
    await user.click(await screen.findByRole('menuitem', { name: /Reveal Author/ }));

    expect(await screen.findByText(/Real author:/)).toBeInTheDocument();
    expect(screen.getByText(/alice/)).toBeInTheDocument();
  });
});
