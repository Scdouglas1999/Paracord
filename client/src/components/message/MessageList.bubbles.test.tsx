import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Member, Message } from '../../types';
import { MessageType } from '../../types';
import { entityScopeKey } from '../../lib/serverScope';
import { parseMarkdown } from '../../lib/markdown';
import { MessageList, isSystemMessage, systemMessageText } from './MessageList';

/**
 * The Glass timeline (docs/glass-spec.md §2.4, §3.2; WP-G10): bubbles grouped
 * with joined corners, the face at the bottom of a group, the name and time
 * above its first bubble, yours on the right with no face, a mention of you
 * raised with a white chip, system lines, the typing bubble, and a row that
 * redraws only when something it draws changed.
 */

const SCOPE = { serverId: 'srv-a', userId: '42' };

const mocks = vi.hoisted(() => ({
  useMessagesReturn: {
    messages: [] as Message[],
    isLoading: false,
    hasMore: false,
    loadMore: vi.fn(),
    error: null as string | null,
    sendMessage: vi.fn(),
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
    deletedMessageIds: new Set<string>(),
    fetchMessages: vi.fn(),
  },
  readStateStoreState: {
    markRead: vi.fn(),
    saveReadPosition: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    // Where the reader had read up to (the catch-up divider); nowhere by default.
    getReadState: vi.fn((): { last_message_id: string } | undefined => undefined),
  },
  typingByChannel: {} as Record<string, string[]>,
  members: new Map<string, Member[]>(),
  savedMessageStoreState: {
    serverId: 'srv-a',
    savedIds: new Set<string>(),
    load: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
  avatarRenders: new Map<string, number>(),
  lowBandwidthMode: false,
  /** What `useGuildEvent` answers: the plan card and the event chip read it. */
  eventResult: {
    status: 'ready' as 'loading' | 'ready' | 'missing' | 'error',
    event: null as import('../glass/cards').GuildEventView | null,
    error: null as string | null,
    busy: false,
    toggleRsvp: vi.fn(),
  },
}));

// Count every face the timeline draws, by person: a row that redraws redraws
// its face, so this is how the suite sees which rows rendered.
vi.mock('./TimelineParts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./TimelineParts')>();
  return {
    ...actual,
    TimelineAvatar: (props: Parameters<typeof actual.TimelineAvatar>[0]) => {
      mocks.avatarRenders.set(props.userId, (mocks.avatarRenders.get(props.userId) ?? 0) + 1);
      return actual.TimelineAvatar(props);
    },
  };
});

vi.mock('./messageLight', () => import('../../test/messageLightMock'));
vi.mock('../../hooks/useLights', () => import('../../test/messageLightMock'));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({ index, key: index, start: index * 80 })),
    getTotalSize: () => options.count * 80,
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
    getOffsetForIndex: vi.fn(),
  }),
}));
vi.mock('../../lib/permissionDataCache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchChannelOverwrites: vi.fn().mockResolvedValue([]),
  fetchGuildRoles: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../hooks/useMessages', () => ({ useMessages: () => mocks.useMessagesReturn }));
vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => ({ permissions: 1n << 6n, isAdmin: false }),
}));
vi.mock('../../hooks/useMessageStore', () => ({
  useCurrentMessageStore: (selector: (s: typeof mocks.messageStoreState) => unknown) =>
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
vi.mock('../../hooks/useChannels', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useChannels')>('../../hooks/useChannels');
  const { useChannelStore } = await import('../../stores/channelStore');
  return {
    ...actual,
    useCurrentChannelStore: useChannelStore,
    useChannelActions: () => useChannelStore.getState(),
    getAccountChannelView: () => useChannelStore.getState(),
    useGuildChannels: (id: string) => useChannelStore((state) => state.channelsByGuild[id] ?? []),
  };
});
vi.mock('../../stores/memberStore', () => {
  const state = { get members() { return mocks.members; } };
  return {
    useMemberStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});
vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (s: { user: { id: string } }) => unknown) => selector({ user: { id: '42' } }),
}));
vi.mock('../../stores/readStateStore', () => ({
  useReadStateStore: Object.assign(
    (selector: (s: typeof mocks.readStateStoreState) => unknown) => selector(mocks.readStateStoreState),
    { getState: () => mocks.readStateStoreState },
  ),
}));
vi.mock('../../stores/serverListStore', () => {
  const state = { activeServerId: 'srv-a', servers: [{ id: 'srv-a', token: 'token', userId: '42', user: { id: '42' } }] };
  return {
    useServerListStore: Object.assign(
      (selector: (value: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});
vi.mock('../../stores/savedMessageStore', () => ({
  useSavedMessageStore: Object.assign(
    (selector: (s: typeof mocks.savedMessageStoreState) => unknown) => selector(mocks.savedMessageStoreState),
    { getState: () => mocks.savedMessageStoreState },
  ),
}));
vi.mock('../../stores/typingStore', () => ({
  useTypingStore: (selector: (s: { typingByChannel: Record<string, string[]> }) => unknown) =>
    selector({ typingByChannel: mocks.typingByChannel }),
}));
vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (s: { lowBandwidthMode: boolean }) => unknown) => selector({ lowBandwidthMode: mocks.lowBandwidthMode }),
}));
vi.mock('../../stores/toastStore', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('../../api/channels', () => ({
  channelApi: {
    getThreads: vi.fn().mockResolvedValue({ data: [] }),
    getArchivedThreads: vi.fn().mockResolvedValue({ data: [] }),
  },
}));
vi.mock('../user/UserProfile', () => ({ UserProfilePopup: () => null }));
vi.mock('../ui/EmojiPicker', () => ({ EmojiPicker: () => null }));
vi.mock('./MessageEmbed', () => ({ MessageEmbedCard: () => null, extractUrls: () => [] }));
vi.mock('./GitHubEventEmbed', () => ({ GitHubEventEmbed: () => null, isGitHubWebhookMessage: () => false }));
vi.mock('./PollMessageCard', () => ({ PollMessageCard: () => null }));
vi.mock('../../api/files', () => ({
  fileApi: {
    resolveAttachmentObjectUrl: vi.fn(async (url: string) => url),
    download: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock('../glass/cards/useGuildEvent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../glass/cards/useGuildEvent')>()),
  useGuildEvent: () => mocks.eventResult,
}));

const USERS: Record<string, { id: string; username: string }> = {
  // Snowflake-shaped ids: markdown only reads a mention of digits.
  viewer: { id: '42', username: 'Sean' },
  brendan: { id: '101', username: 'Brendan' },
  nick: { id: '102', username: 'Nick' },
  jeremy: { id: '103', username: 'Jeremy' },
  eric: { id: '104', username: 'Eric' },
};

/** Minutes after 9:00 PM today, as an ISO string. */
function todayAt(minutes: number): string {
  const date = new Date();
  date.setHours(21, 0, 0, 0);
  date.setMinutes(date.getMinutes() + minutes);
  return date.toISOString();
}

let nextId = 1;
function message(author: keyof typeof USERS, at: string, over: Partial<Message> = {}): Message {
  const id = over.id ?? `m${nextId++}`;
  return {
    id,
    channel_id: 'ch1',
    author: { ...USERS[author], discriminator: '0001', bot: false, flags: 0 },
    content: `words ${id}`,
    timestamp: at,
    created_at: at,
    tts: false,
    mention_everyone: false,
    pinned: false,
    type: MessageType.Default,
    attachments: [],
    reactions: [],
    ...over,
  };
}

function member(key: keyof typeof USERS): Member {
  return { user: { ...USERS[key], discriminator: '0001' }, roles: [] } as unknown as Member;
}

function renderList(props: Partial<Parameters<typeof MessageList>[0]> = {}) {
  return render(
    <MemoryRouter>
      <MessageList channelId="ch1" {...props} />
    </MemoryRouter>,
  );
}

function rowOf(text: string): HTMLElement {
  const row = screen.getByText(text).closest('[role="article"]');
  if (!row) throw new Error(`no row for ${text}`);
  return row as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readStateStoreState.getReadState.mockReturnValue(undefined);
  mocks.readStateStoreState.refresh.mockResolvedValue(undefined);
  nextId = 1;
  mocks.useMessagesReturn.messages = [];
  mocks.typingByChannel = {};
  mocks.avatarRenders.clear();
  mocks.members = new Map([
    [entityScopeKey(SCOPE, 'g1'), (Object.keys(USERS) as (keyof typeof USERS)[]).map(member)],
  ]);
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

describe('grouping (§2.4)', () => {
  it('names the first bubble of a group, joins the rest, and puts the face beside the last', async () => {
    mocks.useMessagesReturn.messages = [
      message('eric', todayAt(0), { content: 'permits came through for Saturday' }),
      message('eric', todayAt(0), { content: 'rim trail, north lot at 7' }),
      message('eric', todayAt(1), { content: 'bring layers' }),
      message('nick', todayAt(4), { content: "I'll drive" }),
    ];
    renderList();

    const first = rowOf('permits came through for Saturday');
    const middle = rowOf('rim trail, north lot at 7');
    const last = rowOf('bring layers');
    const other = rowOf("I'll drive");

    // Name and time above the first bubble only.
    expect(within(first).getByText('Eric')).toBeInTheDocument();
    expect(first.querySelector('.glass-msg__head')).not.toBeNull();
    expect(middle.querySelector('.glass-msg__head')).toBeNull();
    expect(last.querySelector('.glass-msg__head')).toBeNull();

    // The join: continuation rows join the bubble above them.
    expect(first).not.toHaveAttribute('data-grouped');
    expect(middle).toHaveAttribute('data-grouped', 'true');
    expect(last).toHaveAttribute('data-grouped', 'true');
    expect(first.querySelector('.glass-bubble')).not.toHaveAttribute('data-join-top');
    expect(middle.querySelector('.glass-bubble')).toHaveAttribute('data-join-top', 'true');

    // The face sits at the bottom of the group: only the last row draws one.
    expect(first.querySelector('.glass-tl-avatar')).toBeNull();
    expect(middle.querySelector('.glass-tl-avatar')).toBeNull();
    expect(last.querySelector('.glass-tl-avatar')).not.toBeNull();
    expect(last).toHaveAttribute('data-last', 'true');
    expect(first).not.toHaveAttribute('data-last');

    // A new author starts a new group.
    expect(other).not.toHaveAttribute('data-grouped');
    expect(within(other).getByText('Nick')).toBeInTheDocument();
    expect(other.querySelector('.glass-tl-avatar')).not.toBeNull();
  });

  it('moves the face down when the same author writes again (the memo sees the new edge)', async () => {
    const earlier = message('eric', todayAt(0), { content: 'first words' });
    mocks.useMessagesReturn.messages = [earlier];
    const view = renderList();
    expect(rowOf('first words')).toHaveAttribute('data-last', 'true');
    expect(rowOf('first words').querySelector('.glass-tl-avatar')).not.toBeNull();

    mocks.useMessagesReturn.messages = [earlier, message('eric', todayAt(1), { content: 'second words' })];
    view.rerender(
      <MemoryRouter>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );

    await waitFor(() => expect(rowOf('first words')).not.toHaveAttribute('data-last'));
    expect(rowOf('first words').querySelector('.glass-tl-avatar')).toBeNull();
    expect(rowOf('second words')).toHaveAttribute('data-last', 'true');
    expect(rowOf('second words').querySelector('.glass-tl-avatar')).not.toBeNull();
  });

  it('breaks a group at midnight and puts the day between them as a kicker', async () => {
    const lateNight = new Date(2026, 4, 16, 23, 58).toISOString();
    const pastMidnight = new Date(2026, 4, 17, 0, 1).toISOString();
    mocks.useMessagesReturn.messages = [
      message('eric', lateNight, { content: 'still up' }),
      message('eric', pastMidnight, { content: 'now it is tomorrow' }),
    ];
    renderList();
    expect(rowOf('now it is tomorrow')).not.toHaveAttribute('data-grouped');
    // A day kicker above the oldest message (not today) and at the day change.
    expect(screen.getAllByRole('separator')).toHaveLength(2);
  });

  it('opens a conversation from today with no day kicker above it', async () => {
    mocks.useMessagesReturn.messages = [message('eric', todayAt(0), { content: 'hello' })];
    renderList();
    await screen.findByText('hello');
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('starts a new group for a reply and carries its context inside the bubble', async () => {
    const parent = message('nick', todayAt(0), { content: 'new personal best btw' });
    mocks.useMessagesReturn.messages = [
      parent,
      message('eric', todayAt(1), { content: 'first' }),
      message('eric', todayAt(1), { content: 'nice run', reference_id: parent.id, type: MessageType.Reply }),
    ];
    renderList();
    const reply = rowOf('nice run');
    expect(reply).not.toHaveAttribute('data-grouped');
    const bubble = reply.querySelector('.glass-bubble') as HTMLElement;
    expect(within(bubble).getByRole('button', { name: 'Jump to the message from Nick' })).toBeInTheDocument();
  });
});

describe('whose bubble (§3.2)', () => {
  it('puts your own message on the right with no face and no name', async () => {
    mocks.useMessagesReturn.messages = [message('viewer', todayAt(0), { content: 'home in 20' })];
    renderList();
    const mine = rowOf('home in 20');
    expect(mine).toHaveAttribute('data-own', 'true');
    expect(mine.querySelector('.glass-msg__face')).toBeNull();
    expect(mine.querySelector('.glass-msg__head')).toBeNull();
    expect(mine.querySelector('.glass-bubble')).not.toBeNull();
  });

  it('raises a message that mentions you and makes your mention the white chip', async () => {
    mocks.useMessagesReturn.messages = [
      message('jeremy', todayAt(0), { content: '<@42> is movie night still on? ask <@102>' }),
    ];
    renderList();
    const row = screen.getByText(/movie night still on/).closest('[role="article"]') as HTMLElement;
    expect(row).toHaveAttribute('data-mentions-me', 'true');
    const chip = row.querySelector('.glass-mention-self') as HTMLElement;
    expect(chip).toHaveTextContent('@Sean');
    // Somebody else's mention in the same bubble is not yours.
    expect(within(row).getByText('@Nick')).not.toHaveClass('glass-mention-self');
  });
});

describe('the mention chip', () => {
  // The chip is markdown's: it names who it is for in `data-user-id`, and the
  // reader's own is the white one. If markdown stops doing either, this fails
  // instead of the chip silently disappearing.
  it('names every mention and whitens only the reader’s', () => {
    const names = new Map([['42', 'Sean'], ['7', 'Nick']]);
    const nodes = parseMarkdown('hey <@42> and <@7>', undefined, names, undefined, { selfUserId: '42' });
    const { container } = render(<div>{nodes}</div>);
    expect(container.querySelectorAll('[data-user-id]')).toHaveLength(2);
    const chips = container.querySelectorAll('.glass-mention-self');
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent('@Sean');
    expect(chips[0]).toHaveAttribute('data-user-id', '42');
    expect(within(container).getByText('@Nick')).toHaveAttribute('data-user-id', '7');
    expect(within(container).getByText('@Nick')).not.toHaveClass('glass-mention-self');
  });

  it('whitens nobody when nobody is the reader', () => {
    const { container } = render(<div>{parseMarkdown('hey <@42>', undefined, new Map([['42', 'Sean']]))}</div>);
    expect(container.querySelector('.glass-mention-self')).toBeNull();
    expect(container.querySelector('.glass-mention')).toHaveAttribute('data-user-id', '42');
  });
});

describe('system messages', () => {
  it('reads as a centered line, not a bubble', async () => {
    mocks.useMessagesReturn.messages = [
      message('nick', todayAt(0), { content: '', type: MessageType.PinnedMessage }),
    ];
    renderList();
    const line = await screen.findByRole('article', { name: 'System message: Nick pinned a message' });
    expect(line).toHaveTextContent('Nick pinned a message');
    expect(line.querySelector('.glass-bubble')).toBeNull();
  });

  it('knows the system types and never groups with them', () => {
    expect(isSystemMessage({ type: MessageType.GuildMemberJoin })).toBe(true);
    expect(isSystemMessage({ message_type: 8 } as Message)).toBe(true);
    expect(isSystemMessage({ type: MessageType.Default })).toBe(false);
    expect(isSystemMessage({ type: MessageType.Reply })).toBe(false);
    expect(systemMessageText(message('eric', todayAt(0), { type: MessageType.ChannelNameChange, content: 'trips' }), 'Eric'))
      .toBe('Eric renamed the channel to trips');
  });
});

describe('typing (§3.2)', () => {
  it('draws a bubble of dots beside the typist’s face and says who in words', async () => {
    mocks.useMessagesReturn.messages = [message('nick', todayAt(0), { content: 'hello' })];
    mocks.typingByChannel = { ch1: ['104'] };
    const { container } = renderList();
    expect(await screen.findByText('Eric is typing')).toHaveClass('sr-only');
    const typing = container.querySelector('.glass-tl-typing-row') as HTMLElement;
    expect(typing.querySelector('.glass-tl-typing')).not.toBeNull();
    expect(typing.querySelector('.glass-tl-avatar')).toHaveTextContent('E');
  });
});

describe('a row redraws only when something it draws changed', () => {
  it('draws 500 messages and does not redraw one of them when somebody starts typing', async () => {
    const authors = ['brendan', 'nick', 'jeremy', 'viewer'] as const;
    const messages: Message[] = [];
    for (let i = 0; i < 500; i++) {
      // Groups of three: the same author three minutes running, then the next.
      const author = authors[Math.floor(i / 3) % authors.length];
      messages.push(message(author, todayAt(-500 + i), { content: `line ${i}` }));
    }
    mocks.useMessagesReturn.messages = messages;
    const view = renderList();
    expect(await screen.findByText('line 499')).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(500);

    const faces = () => [...mocks.avatarRenders.entries()]
      .filter(([userId]) => userId !== '104')
      .reduce((sum, [, count]) => sum + count, 0);
    const before = faces();
    // Every group by somebody else has one face; yours have none.
    expect(before).toBeGreaterThan(0);

    mocks.typingByChannel = { ch1: ['104'] };
    view.rerender(
      <MemoryRouter>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Eric is typing')).toBeInTheDocument();
    expect(mocks.avatarRenders.get('104')).toBeGreaterThan(0);
    expect(faces()).toBe(before);

    // Hovering one row redraws that row, not the list.
    const hovered = rowOf('line 2');
    act(() => {
      fireEvent.mouseEnter(hovered);
    });
    await waitFor(() => expect(within(hovered).getByRole('button', { name: 'More actions' })).toBeInTheDocument());
    expect(faces()).toBe(before + 1);
  }, 60_000);
});

describe('the catch-up divider (§3.2)', () => {
  const readUpTo = (id: string) => mocks.readStateStoreState.getReadState.mockReturnValue({ last_message_id: id });
  const after = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it('says how many you missed and sits above the first of them', async () => {
    mocks.useMessagesReturn.messages = [
      message('viewer', todayAt(0), { id: '1001', content: 'home in 20' }),
      message('brendan', todayAt(4), { id: '1002', content: 'okay who is on' }),
      message('nick', todayAt(6), { id: '1003', content: 'new personal best' }),
      // Yours, sent from somewhere else: not something you missed.
      message('viewer', todayAt(7), { id: '1004', content: 'nice one' }),
    ];
    readUpTo('1001');
    renderList();
    const divider = await screen.findByTestId('catch-up-divider');
    expect(within(divider).getByText(/^2 new since /)).toBeInTheDocument();
    expect(within(divider).getByRole('button', { name: 'Mark read' })).toBeInTheDocument();
    expect(after(rowOf('home in 20'), divider)).toBe(true);
    expect(after(divider, rowOf('okay who is on'))).toBe(true);
  });

  it('starts a new group after it, even for the author it interrupts', async () => {
    mocks.useMessagesReturn.messages = [
      message('brendan', todayAt(0), { id: '1001', content: 'first words' }),
      message('brendan', todayAt(1), { id: '1002', content: 'second words' }),
    ];
    readUpTo('1001');
    renderList();
    await screen.findByTestId('catch-up-divider');
    expect(rowOf('second words')).not.toHaveAttribute('data-grouped');
    expect(within(rowOf('second words')).getByText('Brendan')).toBeInTheDocument();
    expect(rowOf('first words')).toHaveAttribute('data-last', 'true');
  });

  it('reads the position before opening the conversation moves it', async () => {
    mocks.useMessagesReturn.messages = [
      message('brendan', todayAt(0), { id: '1001', content: 'read' }),
      message('brendan', todayAt(9), { id: '1002', content: 'unread' }),
    ];
    readUpTo('1001');
    renderList();
    await screen.findByTestId('catch-up-divider');
    expect(mocks.readStateStoreState.markRead).toHaveBeenCalled();
    expect(mocks.readStateStoreState.getReadState.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.readStateStoreState.markRead.mock.invocationCallOrder[0]);
  });

  it('waits for a late account snapshot before capturing and advancing the cursor', async () => {
    let finish!: () => void;
    mocks.readStateStoreState.refresh.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    mocks.useMessagesReturn.messages = [
      message('brendan', todayAt(0), { id: '1001', content: 'read' }),
      message('nick', todayAt(9), { id: '1002', content: 'unread' }),
    ];
    renderList();
    expect(mocks.readStateStoreState.refresh).toHaveBeenCalledWith(SCOPE);
    expect(mocks.readStateStoreState.markRead).not.toHaveBeenCalled();
    await act(async () => { readUpTo('1001'); finish(); });
    expect(await screen.findByTestId('catch-up-divider')).toHaveTextContent('1 new');
    expect(mocks.readStateStoreState.markRead).toHaveBeenCalledWith(SCOPE, 'ch1', '1002');
  });

  it('advances normally when the initial snapshot is legitimately empty', async () => {
    mocks.useMessagesReturn.messages = [message('nick', todayAt(9), { id: '1002', content: 'first visit' })];
    renderList();
    await waitFor(() => expect(mocks.readStateStoreState.markRead).toHaveBeenCalledWith(SCOPE, 'ch1', '1002'));
    expect(screen.queryByTestId('catch-up-divider')).toBeNull();
  });

  it('does not mark a conversation read after leaving while its snapshot loads', async () => {
    let finish!: () => void;
    mocks.readStateStoreState.refresh.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    mocks.useMessagesReturn.messages = [message('nick', todayAt(9), { id: '1002', content: 'unread' })];
    const view = renderList();
    view.unmount();
    await act(async () => { readUpTo('1001'); finish(); });
    expect(mocks.readStateStoreState.markRead).not.toHaveBeenCalled();
  });

  it('goes away on Mark read', async () => {
    mocks.useMessagesReturn.messages = [
      message('brendan', todayAt(0), { id: '1001', content: 'read' }),
      message('nick', todayAt(9), { id: '1002', content: 'unread' }),
    ];
    readUpTo('1001');
    renderList();
    fireEvent.click(within(await screen.findByTestId('catch-up-divider')).getByRole('button', { name: 'Mark read' }));
    await waitFor(() => expect(screen.queryByTestId('catch-up-divider')).toBeNull());
  });

  it('is not there when nothing was missed, or when the channel was never read', async () => {
    mocks.useMessagesReturn.messages = [
      message('brendan', todayAt(0), { id: '1001', content: 'read' }),
      message('nick', todayAt(9), { id: '1002', content: 'also read' }),
    ];
    readUpTo('1002');
    const view = renderList();
    await screen.findByText('also read');
    expect(screen.queryByTestId('catch-up-divider')).toBeNull();
    view.unmount();

    mocks.readStateStoreState.getReadState.mockReturnValue(undefined);
    renderList();
    await screen.findByText('also read');
    expect(screen.queryByTestId('catch-up-divider')).toBeNull();
  });
});

describe('reactions bite the corner (§3.2)', () => {
  const like = { emoji: '\u{1F44D}', count: 2, me: true };
  const image = {
    id: 'a1',
    filename: 'mission.png',
    size: 100_000,
    content_type: 'image/png',
    url: '/attachments/a1',
    width: 480,
    height: 270,
  };

  it('is ONE chip on the bubble of a message of words, with an icon and a count for each reaction', async () => {
    mocks.useMessagesReturn.messages = [
      message('nick', todayAt(0), { content: 'new personal best', reactions: [like, { emoji: '\u{1F525}', count: 5, me: false }] }),
    ];
    renderList();
    const row = rowOf('new personal best');
    const chips = within(row).getAllByRole('group', { name: 'Reactions' });
    expect(chips).toHaveLength(1);
    // It hangs off the bubble's line, not under the message.
    expect(chips[0].parentElement).toHaveClass('glass-msg__line');
    expect(chips[0]).toHaveAttribute('data-placement', 'bubble');
    expect(chips[0].parentElement).toHaveAttribute('data-bitten', 'true');
    const thumbs = within(chips[0]).getByRole('button', { name: /2 reactions, including yours/ });
    expect(thumbs).toHaveAttribute('aria-pressed', 'true');
    expect(thumbs).toHaveTextContent('2');
    // The flame is Paracord's own line mark, not the emoji.
    const flame = within(chips[0]).getByRole('button', { name: /5 reactions/ });
    expect(flame.querySelector('[data-glyph="flame"]')).not.toBeNull();
    expect(flame).toHaveTextContent('5');
  });

  it('bites the picture instead when the message has one, outside its clipping frame', async () => {
    mocks.useMessagesReturn.messages = [
      message('nick', todayAt(0), { content: '', attachments: [image], reactions: [like] }),
    ];
    const { container } = renderList();
    const media = await waitFor(() => {
      const found = container.querySelector('.glass-media');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    const chip = within(media).getByRole('group', { name: 'Reactions' });
    // A child of the host, not of the frame that clips the picture.
    expect(chip.parentElement).toBe(media);
    expect(media.querySelector('.glass-media__frame')).not.toContainElement(chip);
    expect(media.querySelector('.glass-media__frame')).toHaveAttribute('data-shaped');
    // No footer: nothing about the file's name or size is written under it.
    expect(container.querySelector('.glass-tl-media__footer')).toBeNull();
    expect(screen.queryByText('mission.png')).toBeNull();
  });

  it('toggles yours when a reaction is pressed', async () => {
    mocks.useMessagesReturn.messages = [message('nick', todayAt(0), { content: 'hello there', reactions: [like] })];
    renderList();
    fireEvent.click(within(rowOf('hello there')).getByRole('button', { name: /2 reactions, including yours/ }));
    await waitFor(() => expect(mocks.messageStoreState.removeReaction).toHaveBeenCalledWith('ch1', expect.any(String), like.emoji));
  });

  it('keeps adding a reaction one gesture away, from the message’s React action', async () => {
    mocks.useMessagesReturn.messages = [message('nick', todayAt(0), { content: 'hello there', reactions: [like] })];
    renderList();
    const row = rowOf('hello there');
    act(() => {
      fireEvent.mouseEnter(row);
    });
    expect(await within(row).findByRole('button', { name: 'React to Nick' })).toBeInTheDocument();
  });
});

describe('media (§3.2)', () => {
  const image = {
    id: 'a1',
    filename: 'mission.png',
    size: 100_000,
    content_type: 'image/png',
    url: '/attachments/a1',
    width: 480,
    height: 270,
  };

  it('keeps open and download reachable without a footer: open on the picture, download in its tools', async () => {
    mocks.useMessagesReturn.messages = [message('nick', todayAt(0), { content: '', attachments: [image] })];
    renderList();
    expect(await screen.findByRole('button', { name: 'Open image preview: mission.png' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download mission.png' })).toBeInTheDocument();
    // Yours only: delete.
    expect(screen.queryByRole('button', { name: 'Delete mission.png' })).toBeNull();
  });

  it('offers delete on your own picture', async () => {
    mocks.useMessagesReturn.messages = [message('viewer', todayAt(0), { content: '', attachments: [image] })];
    renderList();
    expect(await screen.findByRole('button', { name: 'Delete mission.png' })).toBeInTheDocument();
  });

  it('joins the corner under a bubble of the same group', async () => {
    mocks.useMessagesReturn.messages = [message('nick', todayAt(0), { content: 'look at this', attachments: [image] })];
    const { container } = renderList();
    await screen.findByRole('button', { name: 'Open image preview: mission.png' });
    expect(container.querySelector('.glass-media')).toHaveAttribute('data-join-top', 'true');
  });
});

describe('a posted clip (§6.4)', () => {
  const clip = {
    id: 'c1',
    filename: "Clip 0m30s from Vincent's screen.webm",
    size: 1_280_000,
    content_type: 'video/webm',
    url: '/attachments/c1',
  };
  const like = { emoji: '\u{1F44D}', count: 1, me: false };

  it('is a 16:9 media bubble with a play button and its label, not a file row', async () => {
    mocks.useMessagesReturn.messages = [message('eric', todayAt(0), { content: '', attachments: [clip] })];
    const { container } = renderList();
    const play = await screen.findByRole('button', { name: "Play clip, 0:30 from Vincent's screen" });
    const media = container.querySelector('.glass-media') as HTMLElement;
    expect(media).toContainElement(play);
    expect(media.querySelector('.glass-media__frame')).toHaveStyle({ aspectRatio: '16 / 9' });
    expect(within(media).getByText("0:30 from Vincent's screen")).toBeInTheDocument();
    expect(media.querySelector('video')).not.toBeNull();
    expect(container.querySelector('.glass-file')).toBeNull();
    // A picture's tools: download for anyone, delete only for your own.
    expect(within(media).getByRole('button', { name: `Download ${clip.filename}` })).toBeInTheDocument();
    expect(within(media).queryByRole('button', { name: `Delete ${clip.filename}` })).toBeNull();
  });

  it('offers delete on your own clip and joins the corner under your words', async () => {
    mocks.useMessagesReturn.messages = [message('viewer', todayAt(0), { content: 'that was close', attachments: [clip] })];
    const { container } = renderList();
    expect(await screen.findByRole('button', { name: `Delete ${clip.filename}` })).toBeInTheDocument();
    expect(container.querySelector('.glass-media')).toHaveAttribute('data-join-top', 'true');
  });

  it('takes the reactions chip on its corner, like a picture', async () => {
    mocks.useMessagesReturn.messages = [message('eric', todayAt(0), { content: '', attachments: [clip], reactions: [like] })];
    const { container } = renderList();
    await screen.findByRole('button', { name: "Play clip, 0:30 from Vincent's screen" });
    const media = container.querySelector('.glass-media') as HTMLElement;
    const chip = within(media).getByRole('group', { name: 'Reactions' });
    expect(chip.parentElement).toBe(media);
  });

  it('leaves any other video a file row, and a clip too while previews are off', async () => {
    const other = { ...clip, id: 'v2', filename: 'holiday.webm' };
    mocks.useMessagesReturn.messages = [message('eric', todayAt(0), { content: '', attachments: [other] })];
    const first = renderList();
    expect(await screen.findByRole('button', { name: 'holiday.webm' })).toBeInTheDocument();
    expect(first.container.querySelector('.glass-media')).toBeNull();
    first.unmount();

    mocks.lowBandwidthMode = true;
    try {
      mocks.useMessagesReturn.messages = [message('eric', todayAt(0), { content: '', attachments: [clip] })];
      const { container } = renderList();
      const row = await waitFor(() => {
        const found = container.querySelector('.glass-file');
        expect(found).not.toBeNull();
        return found as HTMLElement;
      });
      expect(within(row).getByText('Preview off')).toBeInTheDocument();
      expect(container.querySelector('.glass-media')).toBeNull();
    } finally {
      mocks.lowBandwidthMode = false;
    }
  });
});

describe('events and channels in a message (§3.2)', () => {
  const haz = {
    id: '7001',
    guildId: 'g1',
    name: 'Haz 5 run',
    startsAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
    endsAt: null,
    channelId: null,
    location: null,
    creatorId: '101',
    going: 3,
    youAreGoing: false,
    status: 1,
  };

  it('draws a message that is only an event as a plan card, with no bubble', async () => {
    mocks.eventResult = { ...mocks.eventResult, status: 'ready', event: haz };
    mocks.useMessagesReturn.messages = [message('brendan', todayAt(0), { content: '<event:7001>' })];
    const { container } = renderList();
    const card = await screen.findByRole('group', { name: 'Event: Haz 5 run' });
    expect(within(card).getByRole('button', { name: 'I’m in' })).toBeInTheDocument();
    expect(container.querySelector('.glass-bubble')).toBeNull();
  });

  it('keeps an event named inside a sentence as a chip in that sentence', async () => {
    mocks.eventResult = { ...mocks.eventResult, status: 'ready', event: haz };
    mocks.useMessagesReturn.messages = [message('jeremy', todayAt(0), { content: 'is <event:7001> still on? bring snacks' })];
    const { container } = renderList();
    const row = (await screen.findByText(/still on\? bring snacks/)).closest('[role="article"]') as HTMLElement;
    expect(row.querySelector('.glass-bubble .ix-inline--event')).toHaveTextContent('Haz 5 run');
    expect(container.querySelector('.glass-plan')).toBeNull();
  });
});
