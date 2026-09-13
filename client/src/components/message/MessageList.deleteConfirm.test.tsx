import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../types';
import { MessageType } from '../../types';
import { MessageList } from './MessageList';

// Render framer-motion's Modal shell synchronously in jsdom.
vi.mock('framer-motion', async () => {
  const React = await import('react');
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useReducedMotion: () => true,
    motion: {
      div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
        ({ children, ...props }, ref) => (
          <div ref={ref} {...props}>
            {children}
          </div>
        ),
      ),
      button: React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
        ({ children, ...props }, ref) => (
          <button ref={ref} {...props}>
            {children}
          </button>
        ),
      ),
    },
  };
});

const mocks = vi.hoisted(() => ({
  deleteContexts: [] as AbortController[],
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
  },
  scrollToIndex: vi.fn(),
  savedMessageStoreState: {
    serverId: 'srv-a',
    savedIds: new Set<string>(),
    load: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
  toastState: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

function makeOwnMessage(over: Partial<Message> = {}): Message {
  return {
    id: over.id ?? 'm1',
    channel_id: over.channel_id ?? 'ch1',
    author: {
      id: 'viewer',
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

vi.mock('../../lib/operationContext', () => ({
  captureScopedOperation: () => {
    const controller = new AbortController(); mocks.deleteContexts.push(controller);
    return { signal: controller.signal, assertCurrent: () => controller.signal.throwIfAborted(), dispose: () => controller.abort() };
  },
}));

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

vi.mock('../../hooks/useMessageStore', () => ({
  useCurrentMessageStore: (selector: (s: typeof mocks.messageStoreState) => unknown) =>
    selector(mocks.messageStoreState),
}));

vi.mock('../../stores/channelStore', () => {
  const state = {
    channelsByGuild: {
      g1: [
        { id: 'ch1', guild_id: 'g1', type: 0, channel_type: 0, name: 'general', position: 0 },
      ],
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
  toast: mocks.toastState,
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

function renderList() {
  return render(
    <MemoryRouter>
      <MessageList channelId="ch1" />
    </MemoryRouter>,
  );
}

async function openDeleteConfirm(messageId: string) {
  const row = document.getElementById(`msg-${messageId}`);
  expect(row).not.toBeNull();
  fireEvent.contextMenu(row!);
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete Message' }));
  return screen.findByRole('alertdialog');
}

describe('MessageList delete confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permissionsState.permissions = 0n;
    mocks.permissionsState.isAdmin = false;
    mocks.useMessagesReturn.messages = [];
    mocks.useMessagesReturn.error = null;
    mocks.useMessagesReturn.isLoading = false;
    mocks.messageStoreState.deleteMessage.mockReset().mockResolvedValue(undefined);
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

  it('portals the confirmation outside the virtualized message rows', async () => {
    mocks.useMessagesReturn.messages = [makeOwnMessage({ id: 'm1' }), makeOwnMessage({ id: 'm2' })];
    renderList();

    const row = document.getElementById('msg-m1');
    expect(row).not.toBeNull();
    expect(row!.closest('[data-index]')).not.toBeNull();

    const dialog = await openDeleteConfirm('m1');

    // The dialog must not live inside the transformed virtual row: sibling rows
    // paint and hit-test above it there regardless of z-index.
    expect(dialog.closest('[data-index]')).toBeNull();
    expect(row!.contains(dialog)).toBe(false);
    expect(screen.getByRole('feed').contains(dialog)).toBe(false);
    // Modal portals its backdrop to document.body; the panel is its child.
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    // Focus is moved inside the dialog by the modal's focus trap.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it('deletes only the targeted message when confirmed', async () => {
    mocks.useMessagesReturn.messages = [makeOwnMessage({ id: 'm1' }), makeOwnMessage({ id: 'm2' })];
    renderList();

    const dialog = await openDeleteConfirm('m1');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mocks.messageStoreState.deleteMessage).toHaveBeenCalledTimes(1);
      expect(mocks.messageStoreState.deleteMessage).toHaveBeenCalledWith('ch1', 'm1');
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(dialog).not.toBeNull();
  });

  it('dismisses on Cancel and on Escape without deleting', async () => {
    mocks.useMessagesReturn.messages = [makeOwnMessage({ id: 'm1' })];
    renderList();

    await openDeleteConfirm('m1');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mocks.messageStoreState.deleteMessage).not.toHaveBeenCalled();

    await openDeleteConfirm('m1');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mocks.messageStoreState.deleteMessage).not.toHaveBeenCalled();
  });

  it('dismisses an old-history confirmation before a restored message ID can be targeted', async () => {
    mocks.useMessagesReturn.messages = [makeOwnMessage({ id: 'm1' })];
    renderList(); await openDeleteConfirm('m1');
    mocks.deleteContexts.at(-1)!.abort(new Error('Database history changed'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mocks.messageStoreState.deleteMessage).not.toHaveBeenCalled();
    await openDeleteConfirm('m1');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.messageStoreState.deleteMessage).toHaveBeenCalledWith('ch1', 'm1'));
  });

  it('keeps a replacement confirmation owned when an earlier deletion completes', async () => {
    mocks.useMessagesReturn.messages = [makeOwnMessage({ id: 'm1' }), makeOwnMessage({ id: 'm2' })];
    let complete!: () => void;
    mocks.messageStoreState.deleteMessage.mockReturnValueOnce(new Promise<void>(resolve => { complete = resolve; }));
    renderList(); await openDeleteConfirm('m1');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await openDeleteConfirm('m2'); complete();
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.messageStoreState.deleteMessage).toHaveBeenLastCalledWith('ch1', 'm2'));
  });

  it('keeps the confirmation open for retry when deletion fails', async () => {
    mocks.useMessagesReturn.messages = [makeOwnMessage({ id: 'm1' })];
    mocks.messageStoreState.deleteMessage
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(undefined);
    renderList();

    await openDeleteConfirm('m1');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mocks.toastState.error).toHaveBeenCalled());
    // Failure must not dismiss the dialog — the user can retry or cancel.
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(mocks.messageStoreState.deleteMessage).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(mocks.messageStoreState.deleteMessage).toHaveBeenCalledTimes(2);
      expect(mocks.messageStoreState.deleteMessage).toHaveBeenLastCalledWith('ch1', 'm1');
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });
});
