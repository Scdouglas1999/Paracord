import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Member, Message } from '../../types';
import { MessageType } from '../../types';
import { entityScopeKey } from '../../lib/serverScope';
import { configureMotion, resetMotionSwitchForTests } from '../../lib/motion';
import { installWaapiStub, type WaapiStub } from '../../lib/motion/waapiStub';
import { resetVoiceLinesForTests, useVoiceLineStore } from './voiceLines';
import { parseMarkdown } from '../../lib/markdown';
import { MessageList, isSystemMessage, systemMessageText } from './MessageList';

/**
 * The Index timeline (docs/index-spec.md §3.1, §4.11; IX-11): bubbles grouped
 * by author within five minutes with joined corners, the 30px face at the
 * bottom of a group and the name over its first bubble, time dividers, yours
 * cream on the right with no face, the white chip for a mention of you, system
 * lines and your own voice joins, the typing bubble, the New divider, the
 * reactions chip at the corner, media bubbles, the thread line, editing in
 * place, the arrival of somebody else's message, and a row that redraws only
 * when something it draws changed.
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
  compact: false,
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

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; getItemKey?: (index: number) => string | number }) => ({
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey?.(index) ?? index, start: index * 80 })),
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
      g1: [
        { id: 'ch1', guild_id: 'g1', type: 0, channel_type: 0, name: 'general', position: 0 },
        { id: 'vc1', guild_id: 'g1', type: 2, channel_type: 2, name: 'General', position: 0 },
        {
          id: 'th1', guild_id: 'g1', type: 6, channel_type: 6, name: 'haz runs', position: 0, parent_id: 'ch1',
          message_count: 3, created_at: new Date(2026, 9, 1, 21, 30).toISOString(),
          thread_metadata: { starter_message_id: 'starter-1', archived: false },
        },
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
  useAuthStore: (selector: (s: { user: { id: string }; settings: { message_display_compact: boolean } }) => unknown) =>
    selector({ user: { id: '42' }, settings: { message_display_compact: mocks.compact } }),
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

afterEach(() => {
  resetVoiceLinesForTests();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useMessagesReturn.isLoading = false;
  mocks.useMessagesReturn.hasMore = false;
  mocks.compact = false;
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

describe('grouping (§4.11)', () => {
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

    // The name over the first bubble only (no time: that is the hover's).
    expect(within(first).getByRole('button', { name: 'Eric' })).toBeInTheDocument();
    expect(first.querySelector('.ix-msg__name')).not.toBeNull();
    expect(middle.querySelector('.ix-msg__name')).toBeNull();
    expect(last.querySelector('.ix-msg__name')).toBeNull();

    // Joined corners on the face's side: the first at the bottom, the middle
    // both, the last at the top.
    const bubble = (row: HTMLElement) => row.querySelector('.glass-bubble') as HTMLElement;
    expect(bubble(first)).not.toHaveAttribute('data-join-top');
    expect(bubble(first)).toHaveAttribute('data-join-bottom', 'true');
    expect(bubble(middle)).toHaveAttribute('data-join-top', 'true');
    expect(bubble(middle)).toHaveAttribute('data-join-bottom', 'true');
    expect(bubble(last)).toHaveAttribute('data-join-top', 'true');
    expect(bubble(last)).not.toHaveAttribute('data-join-bottom');
    expect(middle).toHaveAttribute('data-grouped', 'true');

    // The 30px face sits at the bottom of the group: only the last row draws one.
    expect(first.querySelector('.ix-msg__face .ix-av')).toBeNull();
    expect(middle.querySelector('.ix-msg__face .ix-av')).toBeNull();
    const face = last.querySelector('.ix-msg__face .ix-av') as HTMLElement;
    expect(face).not.toBeNull();
    expect(face).toHaveStyle({ width: '30px', height: '30px' });
    expect(face).toHaveTextContent('E');

    // A new author starts a new group.
    expect(other).not.toHaveAttribute('data-grouped');
    expect(within(other).getByRole('button', { name: 'Nick' })).toBeInTheDocument();
  });

  it('groups within five minutes, not six', async () => {
    mocks.useMessagesReturn.messages = [
      message('eric', todayAt(0), { content: 'one' }),
      message('eric', todayAt(4), { content: 'two' }),
      message('eric', todayAt(10), { content: 'three' }),
    ];
    renderList();
    expect(rowOf('two')).toHaveAttribute('data-grouped', 'true');
    expect(rowOf('three')).not.toHaveAttribute('data-grouped');
  });

  it('moves the face down when the same author writes again (the memo sees the new edge)', async () => {
    const earlier = message('eric', todayAt(0), { content: 'first words' });
    mocks.useMessagesReturn.messages = [earlier];
    const view = renderList();
    expect(rowOf('first words')).toHaveAttribute('data-last', 'true');
    expect(rowOf('first words').querySelector('.ix-msg__face .ix-av')).not.toBeNull();

    mocks.useMessagesReturn.messages = [earlier, message('eric', todayAt(1), { content: 'second words' })];
    view.rerender(
      <MemoryRouter>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );

    await waitFor(() => expect(rowOf('first words')).not.toHaveAttribute('data-last'));
    expect(rowOf('first words').querySelector('.ix-msg__face .ix-av')).toBeNull();
    expect(rowOf('second words')).toHaveAttribute('data-last', 'true');
    expect(rowOf('second words').querySelector('.ix-msg__face .ix-av')).not.toBeNull();
  });

  it('starts a new group for a reply and puts the quoted line above its bubble', async () => {
    const parent = message('nick', todayAt(0), { content: 'new personal best btw' });
    mocks.useMessagesReturn.messages = [
      parent,
      message('eric', todayAt(1), { content: 'first' }),
      message('eric', todayAt(1), { content: 'nice run', reference_id: parent.id, type: MessageType.Reply }),
    ];
    renderList();
    const reply = rowOf('nice run');
    expect(reply).not.toHaveAttribute('data-grouped');
    const line = within(reply).getByRole('button', { name: /^Reply to Nick: new personal best btw/ });
    // The send flight carries a picture of this line (`.glass-tl-reply`); it is
    // the row's, above the bubble, not inside it.
    expect(line).toHaveClass('glass-tl-reply');
    expect(reply.querySelector('.glass-bubble')).not.toContainElement(line);
    expect(line).toHaveTextContent('Nick: new personal best btw');
  });
});

describe('time dividers (§4.11)', () => {
  it('opens the conversation with its time: "Today 9:00 PM"', async () => {
    mocks.useMessagesReturn.messages = [message('eric', todayAt(0), { content: 'hello' })];
    renderList();
    await screen.findByText('hello');
    const dividers = screen.getAllByRole('separator');
    expect(dividers).toHaveLength(1);
    expect(dividers[0]).toHaveAccessibleName(/^Today 9:00/);
    expect(dividers[0].querySelector('b')).toHaveTextContent('Today');
  });

  it('puts one between messages more than 30 minutes apart, and breaks the group there', async () => {
    mocks.useMessagesReturn.messages = [
      message('eric', todayAt(0), { content: 'early' }),
      message('eric', todayAt(31), { content: 'later' }),
      message('eric', todayAt(45), { content: 'later still' }),
    ];
    renderList();
    expect(screen.getAllByRole('separator')).toHaveLength(2);
    expect(rowOf('later')).not.toHaveAttribute('data-grouped');
  });

  it('breaks a group at midnight and says which day', async () => {
    const lateNight = new Date(2026, 4, 16, 23, 58).toISOString();
    const pastMidnight = new Date(2026, 4, 17, 0, 1).toISOString();
    mocks.useMessagesReturn.messages = [
      message('eric', lateNight, { content: 'still up' }),
      message('eric', pastMidnight, { content: 'now it is tomorrow' }),
    ];
    renderList();
    expect(rowOf('now it is tomorrow')).not.toHaveAttribute('data-grouped');
    expect(screen.getAllByRole('separator')).toHaveLength(2);
  });
});

describe('whose bubble (§4.11)', () => {
  it('puts your own message on the right in cream, with no face and no name', async () => {
    mocks.useMessagesReturn.messages = [message('viewer', todayAt(0), { content: 'home in 20' })];
    renderList();
    const mine = rowOf('home in 20');
    expect(mine).toHaveAttribute('data-own', 'true');
    expect(mine.querySelector('.ix-msg__face')).toBeNull();
    expect(mine.querySelector('.ix-msg__name')).toBeNull();
    expect(mine.querySelector('.glass-bubble.ix-bubble')).not.toBeNull();
  });

  it('keeps the bubble and makes your mention the white chip', async () => {
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

  it('shows a message this device cannot read as "Encrypted message"', async () => {
    mocks.useMessagesReturn.messages = [
      message('jeremy', todayAt(0), { content: '[Encrypted message]', e2ee: { version: 1 } } as unknown as Partial<Message>),
    ];
    renderList();
    const text = await screen.findByText('Encrypted message');
    expect(text.closest('.glass-bubble')).toHaveAttribute('data-muted', 'true');
  });

  it('marks an edited message "edited" after its words, and that opens its history', async () => {
    mocks.useMessagesReturn.messages = [
      message('jeremy', todayAt(0), { content: 'see you at 9', edited_timestamp: todayAt(2) } as Partial<Message>),
    ];
    renderList();
    const edited = within(rowOf('see you at 9')).getByRole('button', { name: /^Edited/ });
    expect(edited).toHaveTextContent('edited');
    expect(edited.closest('.glass-bubble__text')).not.toBeNull();
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

describe('system lines (§4.11)', () => {
  it('reads as a centered line, not a bubble', async () => {
    mocks.useMessagesReturn.messages = [
      message('nick', todayAt(0), { content: '', type: MessageType.PinnedMessage }),
    ];
    renderList();
    const line = await screen.findByRole('article', { name: 'Nick pinned a message' });
    expect(line).toHaveTextContent('Nick pinned a message');
    expect(line).toHaveClass('ix-tl-system');
    expect(line).toHaveAttribute('data-glyph', 'pin');
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

  it('says "You joined General" where it happened, among the messages, in the server’s first channel', async () => {
    mocks.useMessagesReturn.messages = [
      message('jeremy', todayAt(0), { content: 'who is up for a run' }),
      message('jeremy', todayAt(1), { content: 'I am in General' }),
      message('nick', todayAt(10), { content: 'on my way' }),
    ];
    act(() => {
      useVoiceLineStore.getState().add({ kind: 'joined', guildId: 'g1', channelId: 'vc1', at: todayAt(4) });
      // Another server's voice channel is not this conversation's business.
      useVoiceLineStore.getState().add({ kind: 'joined', guildId: 'g2', channelId: 'vc9', at: todayAt(5) });
    });
    renderList();
    const line = await screen.findByText('You joined General');
    const row = line.closest('.ix-tl-system') as HTMLElement;
    expect(row).toHaveAttribute('data-glyph', 'voice');
    const after = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(after(rowOf('I am in General'), row)).toBe(true);
    expect(after(row, rowOf('on my way'))).toBe(true);
    expect(screen.getAllByText(/^You joined/)).toHaveLength(1);
    // A system line breaks the group: Nick's message starts its own.
    expect(rowOf('I am in General')).toHaveAttribute('data-last', 'true');
  });
});

describe('typing (§4.11)', () => {
  it('draws a bubble of dots beside the typist’s face and says who in words', async () => {
    mocks.useMessagesReturn.messages = [message('nick', todayAt(0), { content: 'hello' })];
    mocks.typingByChannel = { ch1: ['104'] };
    const { container } = renderList();
    expect(await screen.findByText('Eric is typing')).toHaveClass('sr-only');
    const typing = container.querySelector('.glass-tl-typing-row') as HTMLElement;
    expect(typing.querySelector('.ix-typing__bubble')).not.toBeNull();
    expect(typing.querySelector('.ix-av')).toHaveTextContent('E');
  });

  it('overlaps two typists’ faces and names them both', async () => {
    mocks.useMessagesReturn.messages = [message('jeremy', todayAt(0), { content: 'hello' })];
    mocks.typingByChannel = { ch1: ['102', '104'] };
    const { container } = renderList();
    const typing = await waitFor(() => {
      const found = container.querySelector('.glass-tl-typing-row');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(typing.querySelectorAll('.ix-faces .ix-av')).toHaveLength(2);
    expect(within(typing).getAllByText('Nick and Eric are typing')).toHaveLength(2);
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
    expect(faces()).toBe(before);

    // Opening one row's menu redraws that row (its capsule stays up), not the list.
    const row = rowOf('line 2');
    fireEvent.click(within(row).getByRole('button', { name: 'More actions' }));
    await waitFor(() => expect(row).toHaveAttribute('data-menu-open', 'true'));
    expect(faces()).toBe(before + 1);
  }, 60_000);
});

describe('the New divider (§4.11)', () => {
  const readUpTo = (id: string) => mocks.readStateStoreState.getReadState.mockReturnValue({ last_message_id: id });
  const after = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it('says "New" above the first message you had not read, with Mark read', async () => {
    mocks.useMessagesReturn.messages = [
      message('viewer', todayAt(0), { id: '1001', content: 'home in 20' }),
      message('brendan', todayAt(4), { id: '1002', content: 'okay who is on' }),
      message('nick', todayAt(6), { id: '1003', content: 'new personal best' }),
      // Yours, sent from somewhere else: not something you missed.
      message('viewer', todayAt(7), { id: '1004', content: 'nice one' }),
    ];
    readUpTo('1001');
    renderList();
    const divider = await screen.findByTestId('new-divider');
    expect(within(divider).getByText('New')).toBeInTheDocument();
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
    await screen.findByTestId('new-divider');
    expect(rowOf('second words')).not.toHaveAttribute('data-grouped');
    expect(within(rowOf('second words')).getByRole('button', { name: 'Brendan' })).toBeInTheDocument();
    expect(rowOf('first words')).toHaveAttribute('data-last', 'true');
  });

  it('reads the position before opening the conversation moves it', async () => {
    mocks.useMessagesReturn.messages = [
      message('brendan', todayAt(0), { id: '1001', content: 'read' }),
      message('brendan', todayAt(9), { id: '1002', content: 'unread' }),
    ];
    readUpTo('1001');
    renderList();
    await screen.findByTestId('new-divider');
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
    expect(await screen.findByTestId('new-divider')).toHaveTextContent('New');
    expect(mocks.readStateStoreState.markRead).toHaveBeenCalledWith(SCOPE, 'ch1', '1002');
  });

  it('advances normally when the initial snapshot is legitimately empty', async () => {
    mocks.useMessagesReturn.messages = [message('nick', todayAt(9), { id: '1002', content: 'first visit' })];
    renderList();
    await waitFor(() => expect(mocks.readStateStoreState.markRead).toHaveBeenCalledWith(SCOPE, 'ch1', '1002'));
    expect(screen.queryByTestId('new-divider')).toBeNull();
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
    fireEvent.click(within(await screen.findByTestId('new-divider')).getByRole('button', { name: 'Mark read' }));
    await waitFor(() => expect(screen.queryByTestId('new-divider')).toBeNull());
  });

  it('leaves on its own two seconds after you reach the bottom', async () => {
    mocks.useMessagesReturn.messages = [
      message('brendan', todayAt(0), { id: '1001', content: 'read' }),
      message('nick', todayAt(9), { id: '1002', content: 'unread' }),
    ];
    readUpTo('1001');
    renderList();
    await screen.findByTestId('new-divider');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(screen.getByTestId('new-divider')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('new-divider')).toBeNull(), { timeout: 2_000 });
  });

  it('is not there when nothing was missed, or when the channel was never read', async () => {
    mocks.useMessagesReturn.messages = [
      message('brendan', todayAt(0), { id: '1001', content: 'read' }),
      message('nick', todayAt(9), { id: '1002', content: 'also read' }),
    ];
    readUpTo('1002');
    const view = renderList();
    await screen.findByText('also read');
    expect(screen.queryByTestId('new-divider')).toBeNull();
    view.unmount();

    mocks.readStateStoreState.getReadState.mockReturnValue(undefined);
    renderList();
    await screen.findByText('also read');
    expect(screen.queryByTestId('new-divider')).toBeNull();
  });
});

describe('reactions bite the corner (§4.11)', () => {
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

  it('is ONE chip at the bubble’s top trailing corner, with an icon and a count for each reaction', async () => {
    mocks.useMessagesReturn.messages = [
      message('nick', todayAt(0), { content: 'new personal best', reactions: [like, { emoji: '\u{1F525}', count: 5, me: false }] }),
    ];
    renderList();
    const row = rowOf('new personal best');
    const chips = within(row).getAllByRole('group', { name: 'Reactions' });
    expect(chips).toHaveLength(1);
    // In the bubble's corner, beside the action capsule; the row makes room.
    expect(chips[0].parentElement).toHaveClass('ix-msg__corner');
    expect(chips[0]).toHaveAttribute('data-placement', 'bubble');
    expect(row).toHaveAttribute('data-bitten', 'true');
    const thumbs = within(chips[0]).getByRole('button', { name: /2 reactions, including yours/ });
    expect(thumbs).toHaveAttribute('aria-pressed', 'true');
    expect(thumbs).toHaveAttribute('data-me', 'true');
    expect(thumbs).toHaveTextContent('2');
    // The flame is Paracord's own line mark, not the emoji.
    const flame = within(chips[0]).getByRole('button', { name: /5 reactions/ });
    expect(flame.querySelector('[data-glyph="flame"]')).not.toBeNull();
    expect(flame).toHaveTextContent('5');
  });

  it('bites the picture instead when the message is only a picture, outside its clipping frame', async () => {
    mocks.useMessagesReturn.messages = [
      message('nick', todayAt(0), { content: '', attachments: [image], reactions: [like] }),
    ];
    const { container } = renderList();
    const media = await waitFor(() => {
      const found = container.querySelector('.ix-media');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    const chip = within(media).getByRole('group', { name: 'Reactions' });
    // A child of the host, not of the frame that clips the picture.
    expect(chip.parentElement).toBe(media);
    expect(media.querySelector('.ix-media__frame')).not.toContainElement(chip);
    // Fitted inside 360×360: 480×270 draws at 360×203.
    expect(media.querySelector('.ix-media__frame')).toHaveStyle({ width: '360px', aspectRatio: '360 / 203' });
    // No footer: nothing about the file's name or size is written under it.
    expect(screen.queryByText('mission.png')).toBeNull();
  });

  it('toggles yours when a reaction is pressed', async () => {
    mocks.useMessagesReturn.messages = [message('nick', todayAt(0), { content: 'hello there', reactions: [like] })];
    renderList();
    fireEvent.click(within(rowOf('hello there')).getByRole('button', { name: /2 reactions, including yours/ }));
    await waitFor(() => expect(mocks.messageStoreState.removeReaction).toHaveBeenCalledWith('ch1', expect.any(String), like.emoji));
  });

  it('keeps adding a reaction one gesture away, from the capsule’s React', async () => {
    mocks.useMessagesReturn.messages = [message('nick', todayAt(0), { content: 'hello there', reactions: [like] })];
    renderList();
    const row = rowOf('hello there');
    expect(within(row).getByRole('button', { name: 'React to Nick' }).closest('.ix-capsule')).not.toBeNull();
  });
});

describe('media bubbles (§4.11)', () => {
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

  it('joins the bubble above it, and the bubble joins it', async () => {
    mocks.useMessagesReturn.messages = [message('nick', todayAt(0), { content: 'look at this', attachments: [image] })];
    const { container } = renderList();
    await screen.findByRole('button', { name: 'Open image preview: mission.png' });
    expect(container.querySelector('.ix-media')).toHaveAttribute('data-join-top', 'true');
    expect(container.querySelector('.ix-media')).not.toHaveAttribute('data-join-bottom');
    expect(rowOf('look at this').querySelector('.glass-bubble')).toHaveAttribute('data-join-bottom', 'true');
  });

  it('draws a file as a card bubble with its name, size and download', async () => {
    const file = { id: 'f1', filename: 'notes.txt', size: 2048, content_type: 'text/plain', url: '/attachments/f1' };
    mocks.useMessagesReturn.messages = [message('nick', todayAt(0), { content: '', attachments: [file] })];
    const { container } = renderList();
    const card = await waitFor(() => {
      const found = container.querySelector('.ix-file--timeline');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(within(card).getByRole('button', { name: 'notes.txt' })).toBeInTheDocument();
    expect(within(card).getByText(/^2(\.0)? KB$/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Download' })).toBeInTheDocument();
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

  it('is a 16:9 media bubble with a play button and its label, not a file card', async () => {
    mocks.useMessagesReturn.messages = [message('eric', todayAt(0), { content: '', attachments: [clip] })];
    const { container } = renderList();
    const play = await screen.findByRole('button', { name: "Play clip, 0:30 from Vincent's screen" });
    const media = container.querySelector('.ix-media') as HTMLElement;
    expect(media).toContainElement(play);
    expect(media.querySelector('.ix-media__frame')).toHaveStyle({ aspectRatio: '360 / 203' });
    expect(within(media).getByText("0:30 from Vincent's screen")).toBeInTheDocument();
    expect(media.querySelector('video')).not.toBeNull();
    expect(container.querySelector('.ix-file')).toBeNull();
    // A picture's tools: download for anyone, delete only for your own.
    expect(within(media).getByRole('button', { name: `Download ${clip.filename}` })).toBeInTheDocument();
    expect(within(media).queryByRole('button', { name: `Delete ${clip.filename}` })).toBeNull();
  });

  it('offers delete on your own clip and joins the corner under your words', async () => {
    mocks.useMessagesReturn.messages = [message('viewer', todayAt(0), { content: 'that was close', attachments: [clip] })];
    const { container } = renderList();
    expect(await screen.findByRole('button', { name: `Delete ${clip.filename}` })).toBeInTheDocument();
    expect(container.querySelector('.ix-media')).toHaveAttribute('data-join-top', 'true');
  });

  it('takes the reactions chip on its corner, like a picture', async () => {
    mocks.useMessagesReturn.messages = [message('eric', todayAt(0), { content: '', attachments: [clip], reactions: [like] })];
    const { container } = renderList();
    await screen.findByRole('button', { name: "Play clip, 0:30 from Vincent's screen" });
    const media = container.querySelector('.ix-media') as HTMLElement;
    const chip = within(media).getByRole('group', { name: 'Reactions' });
    expect(chip.parentElement).toBe(media);
  });

  it('leaves any other video a file card, and a clip too while previews are off', async () => {
    const other = { ...clip, id: 'v2', filename: 'holiday.webm' };
    mocks.useMessagesReturn.messages = [message('eric', todayAt(0), { content: '', attachments: [other] })];
    const first = renderList();
    expect(await screen.findByRole('button', { name: 'holiday.webm' })).toBeInTheDocument();
    expect(first.container.querySelector('.ix-media')).toBeNull();
    first.unmount();

    mocks.lowBandwidthMode = true;
    try {
      mocks.useMessagesReturn.messages = [message('eric', todayAt(0), { content: '', attachments: [clip] })];
      const { container } = renderList();
      const row = await waitFor(() => {
        const found = container.querySelector('.ix-file');
        expect(found).not.toBeNull();
        return found as HTMLElement;
      });
      expect(within(row).getByText(/Preview off/)).toBeInTheDocument();
      expect(container.querySelector('.ix-media')).toBeNull();
    } finally {
      mocks.lowBandwidthMode = false;
    }
  });
});

describe('threads (§4.11)', () => {
  it('hangs "3 replies · 9:30 PM" under the thread’s starter, and it opens the thread', async () => {
    mocks.useMessagesReturn.messages = [message('brendan', todayAt(0), { id: 'starter-1', content: 'haz 5 tonight?' })];
    renderList();
    const line = await within(rowOf('haz 5 tonight?')).findByRole('button', { name: /^haz runs: 3 replies · 9:30/ });
    expect(line).toHaveClass('ix-thread-line');
    expect(line).toHaveTextContent(/^3 replies · 9:30/);
    // The capsule's thread button opens the same thread.
    expect(within(rowOf('haz 5 tonight?')).getByRole('button', { name: 'Open thread' })).toBeInTheDocument();
  });
});

describe('editing in place (§4.12)', () => {
  it('edits your message in its place: Esc cancels', async () => {
    mocks.useMessagesReturn.messages = [message('viewer', todayAt(0), { content: 'see you at 9' })];
    renderList();
    const row = rowOf('see you at 9');
    fireEvent.click(within(row).getByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const field = await within(row).findByRole('textbox', { name: 'Edit your message' });
    expect(field).toHaveValue('see you at 9');
    fireEvent.keyDown(field, { key: 'Escape' });
    await waitFor(() => expect(within(row).queryByRole('textbox')).toBeNull());
    expect(mocks.messageStoreState.editMessage).not.toHaveBeenCalled();
  });

  it('offers what the menu promises (§4.11) and never a Mark unread it cannot keep', async () => {
    mocks.useMessagesReturn.messages = [message('viewer', todayAt(0), { content: 'see you at 9' })];
    renderList();
    fireEvent.click(within(rowOf('see you at 9')).getByRole('button', { name: 'More actions' }));
    const menu = await screen.findByRole('menu', { name: 'Message actions' });
    const labels = within(menu).getAllByRole('menuitem').map((item) => item.textContent);
    for (const label of ['Edit', 'Copy text', 'Forward', 'Remind me', 'Copy link', 'Delete']) {
      expect(labels).toContain(label);
    }
    expect(labels).not.toContain('Mark unread');
  });
});

describe('compact density (§6.13)', () => {
  it('draws the group face at 24px', async () => {
    mocks.compact = true;
    mocks.useMessagesReturn.messages = [message('nick', todayAt(0), { content: 'tight' })];
    renderList();
    expect(rowOf('tight').querySelector('.ix-msg__face .ix-av')).toHaveStyle({ width: '24px' });
  });
});

describe('a message arrives (§5.10)', () => {
  let waapi: WaapiStub;
  beforeEach(() => {
    resetMotionSwitchForTests();
    configureMotion('full');
    waapi = installWaapiStub();
  });
  afterEach(() => {
    waapi.restore();
    resetMotionSwitchForTests();
  });

  const arrivals = () => waapi.played.filter((record) => record.animation.id === 'ix-timeline:arrive');

  async function opened(messages: Message[]) {
    // The history loads first: nothing in it arrives.
    mocks.useMessagesReturn.isLoading = true;
    mocks.useMessagesReturn.messages = messages;
    const view = renderList();
    mocks.useMessagesReturn.isLoading = false;
    view.rerender(
      <MemoryRouter>
        <MessageList channelId="ch1" />
      </MemoryRouter>,
    );
    await screen.findByText(messages[messages.length - 1].content ?? '');
    return (next: Message[]) => {
      mocks.useMessagesReturn.messages = next;
      view.rerender(
        <MemoryRouter>
          <MessageList channelId="ch1" />
        </MemoryRouter>,
      );
    };
  }

  it('rises from the avatar’s side when somebody else writes, and the history never does', async () => {
    const history = [message('nick', todayAt(0), { content: 'already here' })];
    const next = await opened(history);
    expect(arrivals()).toHaveLength(0);
    await act(async () => next([...history, message('jeremy', todayAt(1), { content: 'just arrived' })]));
    await waitFor(() => expect(arrivals()).toHaveLength(1));
    const [pop] = arrivals();
    expect(pop.target).toBe(rowOf('just arrived'));
    expect(pop.keyframes[0]).toMatchObject({ transform: 'translateY(14px) scale(0.96)', opacity: 0, transformOrigin: '0% 100%' });
    expect(pop.options).toMatchObject({ duration: 250, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
    for (const frame of pop.keyframes) {
      for (const property of Object.keys(frame)) {
        expect(['transform', 'opacity', 'transformOrigin', 'offset', 'easing', 'composite']).toContain(property);
      }
    }
  });

  it('never touches your own message: the send flight is its only landing', async () => {
    const history = [message('nick', todayAt(0), { content: 'already here' })];
    const next = await opened(history);
    await act(async () => next([...history, message('viewer', todayAt(1), { content: 'mine' })]));
    await screen.findByText('mine');
    await act(async () => { await Promise.resolve(); });
    expect(arrivals()).toHaveLength(0);
  });
});
