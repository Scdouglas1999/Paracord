import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    saveReadPosition: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    // Where the reader had read up to (the catch-up divider); nowhere by default.
    getReadState: vi.fn((): { last_message_id: string } | undefined => undefined),
  },
  scrollToIndex: vi.fn(),
  typingByChannel: {} as Record<string, string[]>,
  fetchChannelOverwrites: vi.fn(),
  savedMessageStoreState: {
    serverId: 'srv-a',
    savedIds: new Set<string>(),
    load: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
  emojiPickerPositions: [] as { x: number; y: number }[],
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
  useVirtualizer: (options: { count: number; getItemKey?: (index: number) => string | number }) => ({
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: options.getItemKey?.(index) ?? index,
        start: index * 80,
      })),
    getTotalSize: () => options.count * 80,
    measureElement: vi.fn(),
    scrollToIndex: mocks.scrollToIndex,
  }),
}));

vi.mock('../../lib/permissionDataCache', async importOriginal => ({
  ...(await importOriginal<object>()),
  fetchChannelOverwrites: mocks.fetchChannelOverwrites,
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

vi.mock('../../hooks/useMessageStore', () => ({
  useCurrentMessageStore: (selector: (s: typeof mocks.messageStoreState) => unknown) =>
    selector(mocks.messageStoreState),
}));

vi.mock('../../stores/channelStore', () => {
  const state = {
    channelsByGuild: {
      g1: [
        { id: 'ch1', guild_id: 'g1', type: 0, channel_type: 0, name: 'general', position: 0 },
        { id: 'ch2', guild_id: 'g1', type: 0, channel_type: 0, name: 'random', position: 1 },
      ],
      // A direct message has no guild, so it has no member list to name from.
      '': [
        { id: 'dm1', guild_id: null, type: 1, channel_type: 1, position: 0,
          recipient: { id: 'author-1', username: 'Alice', discriminator: '0001' } },
      ],
    },
    channelsById: {
      ch1: { id: 'ch1', guild_id: 'g1', type: 0, channel_type: 0, name: 'general', position: 0 },
      ch2: { id: 'ch2', guild_id: 'g1', type: 0, channel_type: 0, name: 'random', position: 1 },
      th1: { id: 'th1', guild_id: 'g1', type: 6, channel_type: 6, name: 'Bracket tolerance', parent_id: 'ch1', position: 0 },
      dm1: { id: 'dm1', guild_id: null, type: 1, channel_type: 1, position: 0,
        recipient: { id: 'author-1', username: 'Alice', discriminator: '0001' } },
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

vi.mock('../../stores/serverListStore', () => {
  const state = { activeServerId: 'srv-a', servers: [{ id: 'srv-a', token: 'token', userId: 'viewer', user: { id: 'viewer' } }] };
  return { useServerListStore: Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  ) };
});

vi.mock('../../stores/savedMessageStore', () => ({
  useSavedMessageStore: Object.assign(
    (selector: (s: typeof mocks.savedMessageStoreState) => unknown) =>
      selector(mocks.savedMessageStoreState),
    { getState: () => mocks.savedMessageStoreState },
  ),
}));

vi.mock('../../stores/typingStore', () => ({
  useTypingStore: (selector: (s: { typingByChannel: Record<string, string[]> }) => unknown) =>
    selector({ typingByChannel: mocks.typingByChannel }),
}));

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (s: { lowBandwidthMode: boolean }) => unknown) => selector({ lowBandwidthMode: false }),
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
  EmojiPicker: (props: { position: { x: number; y: number } }) => {
    mocks.emojiPickerPositions.push(props.position);
    return null;
  },
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
    mocks.useMessagesReturn.hasMore = false;
    mocks.readStateStoreState.markRead.mockReset();
    mocks.readStateStoreState.saveReadPosition.mockClear();
    mocks.scrollToIndex.mockClear();
    mocks.fetchChannelOverwrites.mockResolvedValue([]);
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
    // The jump target's bubble is ringed (glass-timeline.css reads `data-jump`).
    await waitFor(() => expect(row).toHaveAttribute('data-jump', 'true'));
  });

  it('offers react, reply and more in one capsule at the bubble’s corner, inside the row', async () => {
    mocks.permissionsState.permissions = 1n << 6n; // ADD_REACTIONS
    mocks.useMessagesReturn.messages = [makeMessage()];

    render(
      <MemoryRouter>
        <MessageList channelId="ch1" onReply={vi.fn()} />
      </MemoryRouter>,
    );

    const row = await screen.findByRole('article', { name: /Alice/ });
    // Shown by hover or focus-within (ix-timeline.css): drawn in the row, so a
    // keyboard user tabbing into the row reaches them.
    const capsule = within(row).getByRole('toolbar', { name: /Actions for Alice/ });
    expect(capsule.closest('.ix-msg__corner')).not.toBeNull();
    expect(within(capsule).getByRole('button', { name: 'React to Alice' })).toBeInTheDocument();
    expect(within(capsule).getByRole('button', { name: 'Reply to Alice' })).toBeInTheDocument();
    const more = within(capsule).getByRole('button', { name: 'More actions' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    expect(await screen.findByRole('menu', { name: 'Message actions' })).toBeInTheDocument();
    expect(more).toHaveAttribute('aria-expanded', 'true');
    // The row keeps its capsule up while its menu is open.
    expect(row).toHaveAttribute('data-menu-open', 'true');
  });

  it('names each bubble with its author and time for a screen reader', async () => {
    mocks.useMessagesReturn.messages = [makeMessage()];
    render(
      <MemoryRouter>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );
    const row = await screen.findByRole('article', { name: /Alice/ });
    const label = document.getElementById(row.getAttribute('aria-labelledby')!);
    expect(label).toHaveClass('sr-only');
    expect(label?.textContent).toMatch(/^Alice, \d{1,2}:\d{2}/);
  });

  // Reading a room's overwrite list needs MANAGE_CHANNELS, so asking for it on
  // every room a plain member opened answered 403 every time — a failed request
  // and a console error the timeline swallowed.
  it('does not ask for permission overwrites it is not allowed to read', async () => {
    mocks.useMessagesReturn.messages = [makeMessage()];

    render(
      <MemoryRouter>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );

    await screen.findByRole('article', { name: /Alice/ });
    expect(mocks.fetchChannelOverwrites).not.toHaveBeenCalled();
  });

  it('asks for permission overwrites once the viewer may manage the room', async () => {
    mocks.permissionsState.permissions = 1n << 4n; // MANAGE_CHANNELS
    mocks.useMessagesReturn.messages = [makeMessage()];

    render(
      <MemoryRouter>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );

    await waitFor(() => expect(mocks.fetchChannelOverwrites).toHaveBeenCalledWith('ch1'));
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
    expect(screen.queryByText('general is ready')).toBeNull();

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

    expect(await screen.findByText('general is ready')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    // The send flight's hook: the first message flies in and the empty state leaves.
    expect(screen.getByText('general is ready').closest('[data-timeline-empty]')).not.toBeNull();
  });

  it('draws the empty state it is given (the welcome) in place of the feed', async () => {
    mocks.useMessagesReturn.messages = [];
    mocks.useMessagesReturn.hasMore = false;
    render(
      <MemoryRouter>
        <MessageList channelId="ch1" header={<h1>general</h1>} emptyState={<p>Fuel is ready</p>} />
      </MemoryRouter>,
    );
    const welcome = await screen.findByText('Fuel is ready');
    expect(welcome.closest('[data-timeline-empty]')).not.toBeNull();
    expect(screen.queryByText('general is ready')).toBeNull();
    // The title is the scroller's first item, above it.
    const title = screen.getByRole('heading', { name: 'general' });
    expect(screen.getByRole('feed').firstElementChild?.contains(title)).toBe(true);
  });

  it('puts the header above the history only once the start of the conversation is loaded', async () => {
    mocks.useMessagesReturn.messages = [makeMessage()];
    mocks.useMessagesReturn.hasMore = true;
    const { rerender } = render(
      <MemoryRouter>
        <MessageList channelId="ch1" header={<h1>general</h1>} />
      </MemoryRouter>,
    );
    await screen.findByRole('article', { name: /Alice/ });
    expect(screen.queryByRole('heading', { name: 'general' })).toBeNull();
    // Older history still to come: three static skeleton bubbles at the top.
    expect(screen.getByRole('status', { name: 'Loading older messages' })).toBeInTheDocument();
    mocks.useMessagesReturn.hasMore = false;
    rerender(
      <MemoryRouter>
        <MessageList channelId="ch1" header={<h1>general</h1>} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'general' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading older messages' })).toBeNull();
  });

  it('hands the scroller to whoever folds the title', async () => {
    mocks.useMessagesReturn.messages = [makeMessage()];
    const onScroller = vi.fn();
    render(
      <MemoryRouter>
        <MessageList channelId="ch1" onScroller={onScroller} />
      </MemoryRouter>,
    );
    await screen.findByRole('article', { name: /Alice/ });
    expect(onScroller).toHaveBeenCalledWith(screen.getByRole('feed'));
  });

  it('does not tell an empty thread it is a dark room', async () => {
    // A thread is not a channel (§7.1): it never says "Nothing in … yet". An
    // empty one is a thread nobody has replied in yet.
    mocks.useMessagesReturn.messages = [];
    mocks.useMessagesReturn.error = null;

    render(
      <MemoryRouter>
        <MessageList channelId="th1" />
      </MemoryRouter>,
    );

    expect(await screen.findByText('No replies yet')).toBeInTheDocument();
    expect(screen.getByText('Nobody has replied in this thread yet.')).toBeInTheDocument();
    expect(screen.queryByText(/is ready$/)).toBeNull();
  });

  it('marks a re-entered channel read even when the cached message count is unchanged', async () => {
    mocks.useMessagesReturn.messages = [makeMessage({ id: 'msg-1', channel_id: 'ch1' })];

    const { rerender } = render(
      <MemoryRouter>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(mocks.readStateStoreState.markRead).toHaveBeenCalledWith({ serverId: 'srv-a', userId: 'viewer' }, 'ch1', 'msg-1');
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
      expect(mocks.readStateStoreState.markRead).toHaveBeenCalledWith({ serverId: 'srv-a', userId: 'viewer' }, 'ch2', 'msg-2');
    });
  });

  // The typing row resolved names from the guild's member list only. A DM has
  // no guild, so the one person in the conversation — already named in the
  // header — was announced as "Someone is typing".
  it('names the person typing in a direct message', async () => {
    mocks.useMessagesReturn.messages = [makeMessage({ id: 'dm-msg', channel_id: 'dm1' })];
    mocks.typingByChannel = { dm1: ['author-1'] };
    render(
      <MemoryRouter>
        <MessageList channelId="dm1" />
      </MemoryRouter>,
    );
    const typing = await waitFor(() => screen.getByText(/is typing/));
    expect(typing.parentElement?.textContent).toContain('Alice');
    expect(typing.parentElement?.textContent).not.toContain('Someone');
  });

  // The React menu item once read a position kept in state, which is still the
  // PREVIOUS menu's click point while the new menu's items are being built.
  it('opens the React emoji picker beside the current menu, not the previous one', async () => {
    mocks.permissionsState.permissions = 1n << 6n; // ADD_REACTIONS
    mocks.useMessagesReturn.messages = [
      makeMessage({ id: 'm-first' }),
      makeMessage({ id: 'm-second' }),
    ];
    mocks.emojiPickerPositions.length = 0;

    render(
      <MemoryRouter>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );

    const rows = await screen.findAllByRole('article');
    fireEvent.contextMenu(rows[0], { clientX: 100, clientY: 200 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'React' }));
    await waitFor(() => {
      expect(mocks.emojiPickerPositions.at(-1)).toEqual({ x: 104, y: 204 });
    });

    // A second menu, far away: the picker must follow THIS click.
    fireEvent.contextMenu(rows[1], { clientX: 600, clientY: 700 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'React' }));
    await waitFor(() => {
      expect(mocks.emojiPickerPositions.at(-1)).toEqual({ x: 604, y: 704 });
    });
  });
});

vi.mock('../../hooks/useChannels', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useChannels')>('../../hooks/useChannels');
  const { useChannelStore } = await import('../../stores/channelStore');
  return {
    ...actual,
    useCurrentChannelStore: useChannelStore,
    useChannelActions: () => useChannelStore.getState(),
    getAccountChannelView: () => useChannelStore.getState(),
    useGuildChannels: (id: string) => useChannelStore(state => state.channelsByGuild[id] ?? []),
  };
});
