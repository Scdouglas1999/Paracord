import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { entityScopeKey } from '../../../lib/serverScope';
import { useChannelStore } from '../../../stores/channelStore';
import { ENCRYPTED_DM_PLACEHOLDER } from '../../../stores/messageStore';
import { useUIStore } from '../../../stores/uiStore';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import { PeopleSidebar } from './PeopleSidebar';

/**
 * The People pane wired together (docs/index-spec.md §6.6), with its data hooks, the card and the menus
 * stubbed: what is on the page, in what order, where each click goes. The rules behind each line are
 * in peopleModel.test.ts; the pixels are the e2e spec's.
 */

const SCOPE = { serverId: 'srv', userId: 'me' };
const EPOCH_MS = 1704067200000;
const NOW = new Date(2026, 9, 1, 21, 38).getTime();
const idAt = (ms: number) => (BigInt(ms - EPOCH_MS) << 22n).toString();

const hooks = vi.hoisted(() => ({
  dms: [] as unknown[],
  requests: [] as unknown[],
  messages: {} as Record<string, unknown[]>,
  previews: {} as Record<string, unknown>,
  openPeopleMenu: vi.fn(),
  openDmPicker: vi.fn(),
  menuOpen: false,
}));

vi.mock('../../../hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 'me', username: 'sean', display_name: 'Sean', avatar_hash: null }),
  useCurrentAccountScope: () => SCOPE,
}));
vi.mock('../../../hooks/useMutedGuilds', () => ({ useMutedGuilds: () => ({ mutedGuildKeys: [] }) }));
vi.mock('../../../hooks/useUnifiedConversations', () => ({
  useUnifiedConversations: () => ({ pinned: [], needsYou: hooks.dms, recent: [], requests: hooks.requests, needsYouOverflowCount: 0, spaces: [] }),
}));
vi.mock('../../../hooks/useMessageStore', () => ({
  useAccountMessageStore: (_scope: unknown, selector: (state: { messages: Record<string, unknown[]> }) => unknown) => selector({ messages: hooks.messages }),
}));
vi.mock('../../../hooks/useDownloadTicket', () => ({ useDownloadTicket: () => null }));
vi.mock('./useConversationPreview', () => ({
  useConversationPreview: (entry: { channelId: string }) => ({
    preview: hooks.previews[entry.channelId] ?? null,
    text: 'Loading…',
    failed: false,
    historyUnavailable: false,
    retry: () => {},
  }),
}));
vi.mock('../../glass/places/usePlacesData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../glass/places/usePlacesData')>()),
  useMinuteClock: () => NOW,
}));
vi.mock('../card', () => ({
  CardSlot: ({ position }: { position: string }) => <div data-testid="card-slot" data-position={position} />,
}));
vi.mock('../menus', () => ({
  openPeopleMenu: hooks.openPeopleMenu,
  openDmPicker: hooks.openDmPicker,
  useMenuHostStore: (selector: (state: { menu: unknown }) => unknown) => selector({ menu: hooks.menuOpen ? { kind: 'people' } : null }),
}));
vi.mock('../../../lib/attention/conversationNavigation', () => ({
  activateConversation: (entry: { channelId: string }) => `/app/dms/${entry.channelId}`,
}));

const dm = (id: string, title: string, over: Partial<ConversationEntry> = {}): ConversationEntry => ({
  key: `k-${id}`,
  scope: SCOPE,
  serverId: 'srv',
  channelId: id,
  guildId: null,
  userId: `u-${id}`,
  avatar: null,
  kind: 'dm',
  title,
  contextLabel: null,
  lastActivityId: idAt(NOW - 3_600_000),
  unread: false,
  mentionCount: 0,
  isDMUnread: false,
  isThreadReply: false,
  hasVoiceActivity: false,
  pinned: false,
  ...over,
});

const message = (id: string, content: string, author = 'u-jeremy', name = 'Jeremy', at = NOW - 3_600_000) => ({
  id: idAt(at),
  channel_id: id,
  author: { id: author, username: name.toLowerCase(), display_name: name },
  content,
  type: 0,
  attachments: [],
  created_at: new Date(at).toISOString(),
});

function Where() {
  const { pathname } = useLocation();
  return <div data-testid="where">{pathname}</div>;
}

function renderPane(path = '/app/dms/jeremy', props: { leaving?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <PeopleSidebar {...props} />
      <Where />
    </MemoryRouter>,
  );
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-testid="ix-dm-row"][data-channel-id="${id}"]`) as HTMLElement;

beforeEach(() => {
  hooks.dms = [
    dm('jeremy', 'Jeremy', { lastActivityId: idAt(NOW - 26 * 60_000) }),
    dm('nick', 'Nick', { lastActivityId: idAt(NOW - 3 * 86_400_000) }),
    dm('maya', 'Maya', { lastActivityId: idAt(NOW - 4 * 86_400_000) }),
  ];
  hooks.requests = [];
  hooks.messages = {
    jeremy: [message('jeremy', 'see you tonight', 'u-jeremy', 'Jeremy', NOW - 26 * 60_000)],
    nick: [message('nick', 'lol yeah', 'u-nick', 'Nick', NOW - 3 * 86_400_000)],
    maya: [message('maya', 'ok sending the invite', 'u-maya', 'Maya', NOW - 4 * 86_400_000)],
  };
  hooks.previews = {};
  hooks.menuOpen = false;
  hooks.openPeopleMenu.mockClear();
  hooks.openDmPicker.mockClear();
  useUIStore.setState({ commandPaletteOpen: false });
  useChannelStore.setState({
    channelsById: {},
    guildChannelsLoaded: { [entityScopeKey(SCOPE, '')]: true },
    errors: {},
  } as never);
});

describe('the header and the search field', () => {
  it('is your face, "People", the line, and "…"', () => {
    renderPane();
    expect(screen.getByTestId('ix-sidebar-header')).toHaveTextContent('People');
    expect(screen.getByTestId('ix-sidebar-header')).toHaveTextContent('Friends and direct messages');
    expect(screen.getByTestId('ix-sidebar-header').querySelector('[data-avatar]')).not.toBeNull();
    const more = screen.getByRole('button', { name: 'People options' });
    expect(more).toHaveAttribute('aria-haspopup', 'menu');
    expect(more).toHaveAttribute('aria-expanded', 'false');
  });

  it('"…" and a right click on the header open the People menu', () => {
    renderPane();
    fireEvent.click(screen.getByRole('button', { name: 'People options' }));
    expect(hooks.openPeopleMenu).toHaveBeenCalledWith({ element: screen.getByRole('button', { name: 'People options' }), align: 'end' });
    fireEvent.contextMenu(screen.getByTestId('ix-sidebar-header'), { clientX: 40, clientY: 50 });
    expect(hooks.openPeopleMenu).toHaveBeenLastCalledWith({ x: 40, y: 50 });
  });

  it('says the menu is open', () => {
    hooks.menuOpen = true;
    renderPane();
    expect(screen.getByRole('button', { name: 'People options' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('"Search people" opens the quick switcher', () => {
    renderPane();
    const field = screen.getByTestId('ix-search-field');
    expect(field).toHaveTextContent('Search people');
    fireEvent.click(field);
    expect(useUIStore.getState().commandPaletteOpen).toBe(true);
  });

  it('renders the inline slot for your direct call', () => {
    renderPane();
    expect(screen.getByTestId('card-slot')).toHaveAttribute('data-position', 'inline');
  });
});

describe('Friends and Inbox', () => {
  it('Friends opens its page and says what waits: the line, and a white count of requests', () => {
    hooks.requests = [{ key: 'r1' }, { key: 'r2' }];
    renderPane();
    const friends = screen.getByTestId('ix-people-friends');
    expect(friends).toHaveTextContent('Friends');
    expect(friends).toHaveTextContent('2 requests');
    expect(friends).toHaveAccessibleName(/Friends, 2 requests/);
    fireEvent.click(friends);
    expect(screen.getByTestId('where')).toHaveTextContent('/app/friends');
  });

  it('Inbox opens its page; nothing waiting says so', () => {
    renderPane();
    const inbox = screen.getByTestId('ix-people-inbox');
    expect(inbox).toHaveTextContent('All caught up');
    fireEvent.click(inbox);
    expect(screen.getByTestId('where')).toHaveTextContent('/app/inbox');
  });

  it('Inbox counts what needs you: mentions in a white count, the line in counts until the newest message is known', () => {
    hooks.dms = [dm('jeremy', 'Jeremy', { mentionCount: 2, isDMUnread: true }), ...(hooks.dms as ConversationEntry[]).slice(1)];
    renderPane('/app/friends');
    const inbox = screen.getByTestId('ix-people-inbox');
    expect(inbox).toHaveTextContent('2 mentions · 1 unread');
    expect(inbox).toHaveAccessibleName(/Inbox, 2 mentions/);
  });

  it('Inbox shows the newest line once its message is known', () => {
    hooks.dms = [dm('jeremy', 'Jeremy', { mentionCount: 1 }), ...(hooks.dms as ConversationEntry[]).slice(1)];
    hooks.previews = { jeremy: { author: 'Jeremy', authorId: 'u-jeremy', avatar: null, text: 'ping', message: message('jeremy', 'ping') } };
    renderPane('/app/friends');
    expect(screen.getByTestId('ix-people-inbox')).toHaveTextContent('Jeremy: ping');
  });

  it('carries the selection only while its page is open, and not a count while you read it', () => {
    hooks.requests = [{ key: 'r1' }];
    renderPane('/app/friends');
    const friends = screen.getByTestId('ix-people-friends');
    expect(friends).toHaveAttribute('aria-current', 'page');
    expect(within(friends).queryByText('1', { selector: '.ix-ch__mention' })).toBeNull();
    expect(screen.getByTestId('ix-people-inbox')).not.toHaveAttribute('aria-current');
  });
});

describe('Messages', () => {
  it('lists every conversation as a two-line row: the name, the time, the last line', () => {
    renderPane();
    expect(screen.getByRole('heading', { name: 'Messages' })).toBeInTheDocument();
    expect(row('jeremy')).toHaveTextContent('Jeremy');
    expect(row('jeremy')).toHaveTextContent('9:12 PM');
    expect(row('jeremy')).toHaveTextContent('see you tonight');
    expect(row('nick')).toHaveTextContent('Mon');
    expect(row('nick')).toHaveTextContent('lol yeah');
    expect(row('maya')).toHaveTextContent('Sun');
    expect(row('maya')).toHaveTextContent('ok sending the invite');
  });

  it('a row is a link with an address, and the open conversation is the current page', () => {
    renderPane('/app/dms/nick');
    expect(row('nick')).toHaveAttribute('href', '/app/dms/nick');
    expect(row('nick')).toHaveAttribute('aria-current', 'page');
    expect(row('jeremy')).not.toHaveAttribute('aria-current');
  });

  it('a click opens the conversation; a modifier click is left to the browser', () => {
    renderPane();
    fireEvent.click(row('maya'), { ctrlKey: true });
    expect(screen.getByTestId('where')).toHaveTextContent('/app/dms/jeremy');
    fireEvent.click(row('maya'));
    expect(screen.getByTestId('where')).toHaveTextContent('/app/dms/maya');
  });

  it('something unread gets the dot and a state in its name; a mention a white count', () => {
    hooks.dms = [
      dm('jeremy', 'Jeremy', { lastActivityId: idAt(NOW - 26 * 60_000) }),
      dm('nick', 'Nick', { isDMUnread: true }),
      dm('maya', 'Maya', { isDMUnread: true, mentionCount: 3 }),
    ];
    renderPane();
    expect(row('nick')).toHaveAttribute('data-unread', 'true');
    expect(row('nick')).toHaveAccessibleName(/Nick, unread/);
    expect(row('nick').querySelector('.ix-ch__mention')).toBeNull();
    expect(row('maya').querySelector('.ix-ch__mention')).toHaveTextContent('3');
    expect(row('maya')).toHaveAccessibleName(/Maya, unread, 3 mentions/);
    expect(row('jeremy')).not.toHaveAttribute('data-unread');
  });

  it('the conversation you are reading is read as you read it: no dot, no count', () => {
    hooks.dms = [dm('jeremy', 'Jeremy', { isDMUnread: true, mentionCount: 2 })];
    renderPane('/app/dms/jeremy');
    expect(row('jeremy')).not.toHaveAttribute('data-unread');
    expect(row('jeremy').querySelector('.ix-ch__mention')).toBeNull();
  });

  it('a group has two overlapped faces and names who spoke', () => {
    hooks.dms = [dm('trio', 'Jeremy, Maya', { kind: 'group_dm', userId: null })];
    useChannelStore.setState({
      channelsById: {
        [entityScopeKey(SCOPE, 'trio')]: { id: 'trio', recipients: [{ id: 'me', username: 'sean' }, { id: 'u-j', username: 'jeremy', display_name: 'Jeremy' }, { id: 'u-m', username: 'maya', display_name: 'Maya' }] },
      },
    } as never);
    hooks.messages = { trio: [message('trio', 'dinner?', 'u-m', 'Maya', NOW - 3_600_000)] };
    renderPane('/app/friends');
    const group = row('trio');
    expect(group.querySelector('.ix-dm__lead')).toHaveAttribute('data-group');
    expect(group.querySelectorAll('[data-avatar]')).toHaveLength(2);
    expect(group).toHaveTextContent('Maya: dinner?');
  });

  it('a conversation with no message says so, and one still loading says nothing', () => {
    hooks.dms = [dm('fresh', 'Fresh', { lastActivityId: null }), dm('slow', 'Slow')];
    hooks.messages = {};
    renderPane('/app/friends');
    expect(row('fresh')).toHaveTextContent('No messages yet');
    expect(row('slow').querySelector('.ix-ch__line-text')).toBeNull();
  });

  it('asks for the newest message of a conversation the store does not hold (and reads an encrypted one as such)', () => {
    hooks.messages = {};
    hooks.previews = {
      jeremy: { author: 'Jeremy', authorId: 'u-jeremy', avatar: null, text: 'x', message: { ...message('jeremy', ENCRYPTED_DM_PLACEHOLDER), e2ee: { v: 1 } } },
      nick: { author: 'Nick', authorId: 'u-nick', avatar: null, text: 'lol yeah', message: message('nick', 'lol yeah', 'u-nick', 'Nick') },
    };
    renderPane();
    expect(row('nick')).toHaveTextContent('lol yeah');
    expect(row('jeremy')).toHaveTextContent('Encrypted');
    expect(row('jeremy').querySelector('svg')).not.toBeNull();
  });

  it('the Messages "+" opens New message', () => {
    renderPane();
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    expect(hooks.openDmPicker).toHaveBeenCalled();
  });
});

describe('when there is nothing to list', () => {
  it('says there are no conversations, and offers the way to start one', () => {
    hooks.dms = [];
    renderPane();
    expect(screen.getByText('No conversations yet.')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'New message' }).at(-1) as HTMLElement);
    expect(hooks.openDmPicker).toHaveBeenCalled();
  });

  it('says it is loading before the list has arrived, and says so loudly when it could not load', () => {
    hooks.dms = [];
    useChannelStore.setState({ guildChannelsLoaded: {}, errors: {} } as never);
    const { unmount } = renderPane();
    expect(screen.getByRole('status')).toHaveTextContent('Loading conversations');
    unmount();
    useChannelStore.setState({ guildChannelsLoaded: {}, errors: { [entityScopeKey(SCOPE, '')]: 'Failed to load channels: down' } } as never);
    renderPane();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load your conversations');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('keyboard and the pane that is leaving', () => {
  it('the rows are one Tab stop (the open one), reached with the arrow keys', () => {
    renderPane('/app/dms/nick');
    const stops = document.querySelectorAll('[data-place-row][tabindex="0"]');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(row('nick'));
    row('nick').focus();
    fireEvent.keyDown(row('nick'), { key: 'ArrowDown' });
    expect(row('maya')).toHaveFocus();
    fireEvent.keyDown(row('maya'), { key: 'Home' });
    expect(screen.getByTestId('ix-people-friends')).toHaveFocus();
  });

  it('a leaving pane keeps the row that was open when it started to leave', () => {
    function Go() {
      const navigate = useNavigate();
      return <button onClick={() => navigate('/app/dms/maya')}>go</button>;
    }
    render(
      <MemoryRouter initialEntries={['/app/dms/nick']}>
        <PeopleSidebar leaving />
        <Go />
      </MemoryRouter>,
    );
    expect(row('nick')).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    // The route moved on; this pane is sliding out and shows what it showed.
    expect(row('nick')).toHaveAttribute('aria-current', 'page');
    expect(row('maya')).not.toHaveAttribute('aria-current');
  });

  it('the pane that is staying follows the route', () => {
    function Go() {
      const navigate = useNavigate();
      return <button onClick={() => navigate('/app/dms/maya')}>go</button>;
    }
    render(
      <MemoryRouter initialEntries={['/app/dms/nick']}>
        <PeopleSidebar />
        <Go />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(row('maya')).toHaveAttribute('aria-current', 'page');
    expect(row('nick')).not.toHaveAttribute('aria-current');
  });
});
