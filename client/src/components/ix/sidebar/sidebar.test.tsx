import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SportsGame } from '../../../api/sports';
import type { GameServer } from '../../../api/gameServers';
import { useUIStore } from '../../../stores/uiStore';
import type { SidebarChannel, SidebarGroup, SidebarRoom } from '../../glass/places/rows';
import type { HomeEvent } from '../../rooms/lobby/useUpcomingEvents';
import { AddonList } from './AddonList';
import { ChannelList, keepsVisible } from './ChannelList';
import { ChannelRow } from './ChannelRow';
import { COMING_UP_ROWS, ComingUp, comingUp } from './ComingUp';
import { RoomList, roomLabel } from './RoomList';
import { SearchField } from './SearchField';
import { SidebarHeader } from './SidebarHeader';
import { ADDON_ID, gamesLine, sportsLine, wordLine, type AddonModel } from './useAddons';
import { LONG_PRESS_MS, pointEvent, useLongPress } from './useLongPress';
import { nextRowIndex, rovingKeyDown, useRovingList } from './useRovingList';

const NOW = new Date(2026, 9, 1, 21, 38).getTime();
const focus = (id: string) => ({ tabIndex: (id === 'channel:g' ? 0 : -1) as 0 | -1, onFocus: vi.fn() });

function row(over: Partial<SidebarChannel> & Pick<SidebarChannel, 'channelId' | 'name'>): SidebarChannel {
  return {
    id: `channel:${over.channelId}`,
    kind: 'text',
    selected: false,
    line: 'Jeremy: hey',
    note: null,
    encrypted: false,
    time: '9:41 PM',
    timeIso: new Date(NOW).toISOString(),
    unread: false,
    mentions: 0,
    muted: false,
    state: [],
    ...over,
  };
}

/* ---- Rows --------------------------------------------------------------------- */

describe('a channel row', () => {
  const props = { href: '/app/guilds/g1/channels/c', group: 'channels', keep: false, leaving: false, tabIndex: 0 as const, onFocus: vi.fn() };

  it('is a link with the name, the time and the line, and no # of its own', () => {
    render(
      <ChannelRow {...props} row={row({ channelId: 'c', name: 'general' })} onOpen={vi.fn()} onContextMenu={vi.fn()} />,
    );
    const link = screen.getByTestId('ix-channel-row');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/app/guilds/g1/channels/c');
    expect(link).toHaveAttribute('data-channel-id', 'c');
    expect(link).toHaveTextContent('general9:41 PMJeremy: hey');
    expect(link.textContent).not.toContain('#');
    expect(link.querySelector('time')).toHaveAttribute('datetime', new Date(NOW).toISOString());
  });

  it('opens on a plain click and leaves a modified click to the browser', () => {
    const onOpen = vi.fn();
    render(<ChannelRow {...props} row={row({ channelId: 'c', name: 'general' })} onOpen={onOpen} onContextMenu={vi.fn()} />);
    const link = screen.getByTestId('ix-channel-row');
    const plain = fireEvent.click(link);
    expect(plain).toBe(false);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // The browser would navigate for these; jsdom cannot, so stop it after React has looked.
    const stop = (event: Event) => event.preventDefault();
    window.addEventListener('click', stop);
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { button: 1 });
    window.removeEventListener('click', stop);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('says what it is for a screen reader: the open one is the current page, state follows the name', () => {
    render(
      <ChannelRow
        {...props}
        row={row({ channelId: 'c', name: 'clips', selected: true, unread: true, mentions: 2, state: ['unread', '2 mentions'] })}
        onOpen={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );
    const link = screen.getByTestId('ix-channel-row');
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(link).toHaveAttribute('data-ix-selected');
    expect(link).toHaveAttribute('data-unread', 'true');
    expect(within(link).getByText(/, unread, 2 mentions/)).toHaveClass('sr-only');
  });

  it('shows a count chip under the time for mentions (99+ past the cap) and gives the line the first column', () => {
    const { rerender } = render(
      <ChannelRow {...props} row={row({ channelId: 'c', name: 'plans', unread: true, mentions: 3 })} onOpen={vi.fn()} onContextMenu={vi.fn()} />,
    );
    expect(screen.getByTestId('ix-channel-row')).toHaveAttribute('data-mentions', 'true');
    expect(screen.getByText('3')).toHaveClass('ix-ch__mention');
    rerender(<ChannelRow {...props} row={row({ channelId: 'c', name: 'plans', unread: true, mentions: 150 })} onOpen={vi.fn()} onContextMenu={vi.fn()} />);
    expect(screen.getByText('99+')).toBeInTheDocument();
  });

  it('is quiet when muted, and has no dot, chip or time when there is nothing to say', () => {
    render(
      <ChannelRow
        {...props}
        row={row({ channelId: 'c', name: 'noise', muted: true, state: ['muted'], time: null, line: 'No messages yet' })}
        onOpen={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );
    const link = screen.getByTestId('ix-channel-row');
    expect(link).toHaveAttribute('data-muted', 'true');
    expect(link).not.toHaveAttribute('data-unread');
    expect(link.querySelector('time')).toBeNull();
    expect(link.querySelector('.ix-ch__mention')).toBeNull();
  });

  it('writes "Encrypted" with a lock for a message it cannot read, and a megaphone after an announcement channel’s name', () => {
    const { rerender } = render(
      <ChannelRow {...props} row={row({ channelId: 'c', name: 'private', encrypted: true, line: null, note: 'encrypted' })} onOpen={vi.fn()} onContextMenu={vi.fn()} />,
    );
    const link = screen.getByTestId('ix-channel-row');
    expect(link.querySelector('.ix-ch__line .ix-glyph')).not.toBeNull();
    expect(link.querySelector('.ix-ch__line')).toHaveTextContent('Encrypted');
    rerender(<ChannelRow {...props} row={row({ channelId: 'c', name: 'news', kind: 'announcement' })} onOpen={vi.fn()} onContextMenu={vi.fn()} />);
    expect(screen.getByTestId('ix-channel-row').querySelector('.ix-ch__name .ix-ch__kind')).not.toBeNull();
  });

  it('opens its menu on right-click', () => {
    const onContextMenu = vi.fn();
    render(<ChannelRow {...props} row={row({ channelId: 'c', name: 'general' })} onOpen={vi.fn()} onContextMenu={onContextMenu} />);
    fireEvent.contextMenu(screen.getByTestId('ix-channel-row'));
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });
});

/* ---- Channel list --------------------------------------------------------------- */

describe('the channel list', () => {
  const groups: SidebarGroup[] = [
    { id: 'channels', categoryId: null, label: 'Channels', channels: [row({ channelId: 'g', name: 'general' })] },
    {
      id: 'category:cat',
      categoryId: 'cat',
      label: 'Text channels',
      channels: [
        row({ channelId: 'a', name: 'quiet' }),
        row({ channelId: 'b', name: 'loud', unread: true, state: ['unread'] }),
        row({ channelId: 'c', name: 'open', selected: true }),
        row({ channelId: 'd', name: 'ping', mentions: 1, unread: true }),
      ],
    },
  ];
  const baseProps = {
    groups,
    collapsed: new Set<string>(),
    hrefOf: (id: string) => `/c/${id}`,
    focusOf: focus,
    leaving: false,
    canCreate: false,
    onToggle: vi.fn(),
    onCreate: vi.fn(),
    onOpen: vi.fn(),
    onMenu: vi.fn(),
  };

  it('has a labeled section per group: the uncategorized one is plain, a category is a button that folds', () => {
    render(<ChannelList {...baseProps} />);
    expect(screen.getByRole('heading', { name: 'Channels' })).toBeInTheDocument();
    expect(within(screen.getByRole('heading', { name: 'Channels' })).queryByRole('button')).toBeNull();
    const fold = within(screen.getByRole('heading', { name: 'Text channels' })).getByRole('button', { name: 'Text channels' });
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByTestId('ix-channel-row')).toHaveLength(5);
  });

  it('shows only the rows that matter in a closed category: unread, mentioned, open', () => {
    render(<ChannelList {...baseProps} collapsed={new Set(['category:cat'])} />);
    const names = screen.getAllByTestId('ix-channel-row').map((link) => link.getAttribute('data-channel-id'));
    expect(names).toEqual(['g', 'b', 'c', 'd']);
    expect(screen.getByRole('button', { name: 'Text channels' })).toHaveAttribute('aria-expanded', 'false');
    expect(keepsVisible(row({ channelId: 'x', name: 'x' }))).toBe(false);
  });

  it('closes on click, and with Left; opens with Right', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<ChannelList {...baseProps} onToggle={onToggle} />);
    const fold = screen.getByRole('button', { name: 'Text channels' });
    fireEvent.click(fold);
    expect(onToggle).toHaveBeenLastCalledWith('category:cat');
    fireEvent.keyDown(fold, { key: 'ArrowRight' });
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(fold, { key: 'ArrowLeft' });
    expect(onToggle).toHaveBeenCalledTimes(2);
    rerender(<ChannelList {...baseProps} onToggle={onToggle} collapsed={new Set(['category:cat'])} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Text channels' }), { key: 'ArrowRight' });
    expect(onToggle).toHaveBeenCalledTimes(3);
  });

  it('offers "+" at a label only to someone who can create channels, naming the category', () => {
    const onCreate = vi.fn();
    const { rerender } = render(<ChannelList {...baseProps} />);
    expect(screen.queryByRole('button', { name: /Create a channel/ })).toBeNull();
    rerender(<ChannelList {...baseProps} canCreate onCreate={onCreate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create a channel in Text channels' }));
    expect(onCreate).toHaveBeenLastCalledWith('cat');
    fireEvent.click(screen.getByRole('button', { name: 'Create a channel in Channels' }));
    expect(onCreate).toHaveBeenLastCalledWith(null);
  });

  it('keeps a "+" out of the heading’s name', () => {
    render(<ChannelList {...baseProps} canCreate />);
    expect(screen.getByRole('heading', { name: 'Channels' })).toBeInTheDocument();
  });

  it('marks the rows of a group, so closing it knows what to hide', () => {
    render(<ChannelList {...baseProps} />);
    const loud = screen.getAllByTestId('ix-channel-row').find((link) => link.getAttribute('data-channel-id') === 'b');
    expect(loud).toHaveAttribute('data-ix-group', 'category:cat');
    expect(loud).toHaveAttribute('data-keep', 'true');
    const quiet = screen.getAllByTestId('ix-channel-row').find((link) => link.getAttribute('data-channel-id') === 'a');
    expect(quiet).not.toHaveAttribute('data-keep');
  });
});

/* ---- Voice channels ------------------------------------------------------------------------ */

describe('the rooms', () => {
  const room = (over: Partial<SidebarRoom> & Pick<SidebarRoom, 'channelId' | 'name'>): SidebarRoom => ({
    id: `room:${over.channelId}`,
    stage: false,
    busy: false,
    count: 0,
    tail: 'Empty',
    faces: [],
    people: [],
    streaming: false,
    ...over,
  });
  const props = { focusOf: focus, onJoin: vi.fn(), onMenu: vi.fn() };

  it('renders nothing, not even a label, when there are no rooms', () => {
    const { container } = render(<RoomList {...props} rooms={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is a labeled section of buttons: name and "Empty", or "3 here" with up to three small faces', () => {
    render(
      <RoomList
        {...props}
        rooms={[
          room({ channelId: 'late', name: 'Late night' }),
          room({
            channelId: 'lounge',
            name: 'Lounge',
            busy: true,
            count: 3,
            tail: '3 here',
            faces: [{ userId: '1', name: 'Vincent', avatar: null }, { userId: '2', name: 'Brendan', avatar: null }, { userId: '3', name: 'Nick', avatar: null }],
            people: ['Vincent', 'Brendan', 'Nick'],
          }),
        ]}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Voice channels' })).toBeInTheDocument();
    const [late, lounge] = screen.getAllByTestId('ix-room-row');
    expect(late.tagName).toBe('BUTTON');
    expect(late).toHaveTextContent('Late nightEmpty');
    expect(late).not.toHaveAttribute('data-busy');
    expect(lounge).toHaveAttribute('data-busy', 'true');
    // The faces are pictures (aria-hidden) with a monogram each: the name and the count are the text.
    expect(lounge.querySelector('.ix-rm__name')).toHaveTextContent('Lounge');
    expect(lounge.querySelector('.ix-rm__tail')).toHaveTextContent(/3 here$/);
    expect(lounge.querySelectorAll('.ix-faces .ix-av')).toHaveLength(3);
    expect(late.querySelector('.ix-faces')).toBeNull();
  });

  it('joins on click and opens its menu on right-click', () => {
    const onJoin = vi.fn();
    const onMenu = vi.fn();
    const lounge = room({ channelId: 'lounge', name: 'Lounge' });
    render(<RoomList {...props} onJoin={onJoin} onMenu={onMenu} rooms={[lounge]} />);
    fireEvent.click(screen.getByTestId('ix-room-row'));
    expect(onJoin).toHaveBeenCalledWith(lounge);
    fireEvent.contextMenu(screen.getByTestId('ix-room-row'));
    expect(onMenu).toHaveBeenCalledWith(expect.anything(), lounge);
  });

  it('draws a stage as a podium and says join the audience', () => {
    const { rerender } = render(<RoomList {...props} rooms={[room({ channelId: 's', name: 'Town hall', stage: true })]} />);
    const stage = screen.getByTestId('ix-room-row');
    expect(stage.querySelector('.ix-glyph')?.innerHTML).not.toBe('');
    expect(stage).toHaveAccessibleName('Town hall, empty. Join the audience');
    rerender(<RoomList {...props} rooms={[room({ channelId: 'v', name: 'Voice' })]} />);
    expect(screen.getByTestId('ix-room-row').querySelector('.ix-glyph')?.innerHTML).not.toBe(stage.querySelector('.ix-glyph')?.innerHTML);
  });

  it('names who is in it for a screen reader, and whether somebody is sharing', () => {
    expect(roomLabel(room({ channelId: 'l', name: 'Lounge', count: 2, people: ['Vincent', 'Nick'], streaming: true }))).toBe(
      'Lounge, 2 here: Vincent, Nick, someone is sharing their screen. Join',
    );
    expect(roomLabel(room({ channelId: 'l', name: 'Late night' }))).toBe('Late night, empty. Join');
  });
});

/* ---- Coming up ----------------------------------------------------------------------- */

describe('Coming up', () => {
  const event = (id: string, name: string, startsAt: Date, over: Partial<HomeEvent> = {}): HomeEvent => ({
    id,
    name,
    startsAt,
    endsAt: null,
    channelId: null,
    location: null,
    creatorId: null,
    going: 0,
    youAreGoing: false,
    happeningNow: false,
    ...over,
  });
  const DAY = 24 * 60 * 60 * 1000;
  const friday = new Date(2026, 9, 2, 21, 0);

  it('keeps what is running now and what starts within seven days, soonest first, at most three', () => {
    const list = [
      event('late', 'Next month', new Date(NOW + 20 * DAY)),
      event('d3', 'Three days', new Date(NOW + 3 * DAY)),
      event('d1', 'Tomorrow', new Date(NOW + 1 * DAY)),
      event('now', 'Running', new Date(NOW - 20 * 60_000), { happeningNow: true }),
      event('d6', 'Six days', new Date(NOW + 6 * DAY)),
      event('d5', 'Five days', new Date(NOW + 5 * DAY)),
    ];
    expect(comingUp(list, NOW).map((entry) => entry.id)).toEqual(['now', 'd1', 'd3']);
    expect(COMING_UP_ROWS).toBe(3);
    expect(comingUp([event('late', 'Next month', new Date(NOW + 20 * DAY))], NOW)).toEqual([]);
  });

  it('renders nothing, not even its label, when nothing is coming up', () => {
    const { container } = render(
      <ComingUp events={[]} nowMs={NOW} roomName={() => null} hrefOf={() => '#'} focusOf={focus} onOpen={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('writes a row: date tile, title, "Fri 9:00 PM · Lounge", and Live for one in progress', () => {
    const onOpen = vi.fn();
    const movie = event('1', 'Movie night', friday, { channelId: 'lounge' });
    const running = event('2', 'Game night', new Date(NOW - 30 * 60_000), { happeningNow: true });
    render(
      <ComingUp
        events={[movie, running]}
        nowMs={NOW}
        roomName={(entry) => (entry.channelId === 'lounge' ? 'Lounge' : null)}
        hrefOf={(entry) => `/e/${entry.id}`}
        focusOf={focus}
        onOpen={onOpen}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Coming up' })).toBeInTheDocument();
    const rows = screen.getAllByTestId('ix-event-row');
    expect(rows).toHaveLength(2);
    // Running first.
    expect(rows[0]).toHaveTextContent('Game night');
    expect(rows[0]).toHaveTextContent('Live');
    expect(rows[1]).toHaveTextContent('Movie night');
    expect(rows[1]).toHaveTextContent('Fri 9:00 PM · Lounge');
    expect(rows[1].querySelector('.ix-ev__weekday')).toHaveTextContent('Fri');
    expect(rows[1].querySelector('.ix-ev__weekday')).toHaveClass('ix-hue-weekday');
    expect(rows[1].querySelector('.ix-ev__day')).toHaveTextContent('2');
    expect(rows[1].querySelector('.ix-ev__tile')).toHaveAttribute('aria-hidden', 'true');
    expect(rows[1]).toHaveAttribute('href', '/e/1');
    fireEvent.click(rows[1]);
    expect(onOpen).toHaveBeenCalledWith(movie);
  });
});

/* ---- Add-ons ------------------------------------------------------------------------------ */

describe('the add-ons', () => {
  const sports: AddonModel = { id: ADDON_ID.sports, kind: 'sports', name: 'Sports', line: 'Cubs 3–2 Brewers · 7th', selected: true, href: '/app/guilds/g1/sports' };
  const word: AddonModel = { id: ADDON_ID.word, kind: 'word', name: 'Daily word', line: '4 solved today', selected: false, href: '/app/guilds/g1/daily-word' };
  const server = (id: string, name: string, state: 'up' | 'down'): GameServer =>
    ({ id, name, kind: 'minecraft_java', address: `${name}.example:25565`, status: { state, players: null, error: null, checked_at: null } }) as unknown as GameServer;
  const games: AddonModel = {
    id: ADDON_ID.games,
    kind: 'games',
    name: 'Game servers',
    line: '1 of 2 online',
    selected: false,
    servers: [server('s1', 'Survival', 'up'), server('s2', 'Creative', 'down')],
  };

  it('renders nothing when the server has none', () => {
    const { container } = render(<AddonList addons={[]} focusOf={focus} onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is two-line links: the name and a live line, the open page current', () => {
    const onOpen = vi.fn();
    render(<AddonList addons={[sports, word]} focusOf={focus} onOpen={onOpen} />);
    expect(screen.getByRole('heading', { name: 'Add-ons' })).toBeInTheDocument();
    const [first, second] = screen.getAllByTestId('ix-addon-row');
    expect(first).toHaveTextContent('SportsCubs 3–2 Brewers · 7th');
    expect(first).toHaveAttribute('aria-current', 'page');
    expect(first).toHaveAttribute('data-ix-selected');
    expect(second).toHaveTextContent('Daily word4 solved today');
    expect(second).not.toHaveAttribute('aria-current');
    fireEvent.click(second);
    expect(onOpen).toHaveBeenCalledWith(word);
  });

  it('opens a small list for Game servers, which have no page: each with its status', async () => {
    render(<AddonList addons={[games]} focusOf={focus} onOpen={vi.fn()} />);
    const row = screen.getByTestId('ix-addon-row');
    expect(row.tagName).toBe('BUTTON');
    expect(row).toHaveAttribute('aria-haspopup', 'dialog');
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    const dialog = await screen.findByRole('dialog', { name: 'Game servers' });
    expect(within(dialog).getByText('Survival')).toBeInTheDocument();
    expect(within(dialog).getByText('Creative')).toBeInTheDocument();
  });
});

describe('the add-ons’ live lines', () => {
  const game = (id: string, state: 'pre' | 'in' | 'post', heat: number, over: Partial<SportsGame> = {}): SportsGame =>
    ({
      id,
      state,
      heat,
      detail: '7th',
      start: new Date(NOW).toISOString(),
      away: { name: 'Chicago Cubs', short_name: 'Cubs', abbr: 'CHC', score: 3 },
      home: { name: 'Milwaukee Brewers', short_name: 'Brewers', abbr: 'MIL', score: 2 },
      ...over,
    }) as unknown as SportsGame;

  it('says the hottest live game when one is on, how many when several are, and what it is otherwise', () => {
    expect(sportsLine([game('1', 'in', 5)], false)).toBe('Cubs 3–2 Brewers · 7th');
    expect(sportsLine([game('1', 'in', 5), game('2', 'in', 9)], false)).toBe('2 live now');
    expect(sportsLine([game('1', 'pre', 0), game('2', 'post', 0)], false)).toBe('Scores');
    expect(sportsLine(undefined, false)).toBe('Scores');
  });

  it('does not spoil a score for someone who hides them', () => {
    expect(sportsLine([game('1', 'in', 5)], true)).toBe('1 live now');
  });

  it('writes the clock after the dash as one word ("Bot 7th", not "Bot – 7th")', () => {
    expect(sportsLine([game('1', 'in', 5, { detail: '8:25 - 1st' })], false)).toBe('Cubs 3–2 Brewers · 8:25 1st');
  });

  it('counts the day’s solvers, or names the puzzle', () => {
    expect(wordLine(4)).toBe('4 solved today');
    expect(wordLine(0)).toBe("Today's puzzle");
    expect(wordLine(null)).toBe("Today's puzzle");
  });

  it('counts game servers online, and says checking until one has answered', () => {
    const up = { status: { state: 'up' } } as unknown as GameServer;
    const down = { status: { state: 'down' } } as unknown as GameServer;
    const checking = { status: { state: 'checking' } } as unknown as GameServer;
    expect(gamesLine([up, down, up])).toBe('2 of 3 online');
    expect(gamesLine([checking, checking])).toBe('Checking…');
  });
});

/* ---- Header and search ------------------------------------------------------------------------ */

describe('the header', () => {
  const props = {
    guildId: '310030000000000000',
    name: 'Fuel',
    icon: null,
    hue: null,
    line: '2 members · 2 here now',
    current: false,
    menuRef: { current: null },
    menuOpen: false,
    onOpenOverview: vi.fn(),
    onOpenMenu: vi.fn(),
    onContextMenu: vi.fn(),
  };

  it('is the mark, the name and the line; the mark and name open Overview, "…" opens the menu', () => {
    const onOpenOverview = vi.fn();
    const onOpenMenu = vi.fn();
    render(<SidebarHeader {...props} onOpenOverview={onOpenOverview} onOpenMenu={onOpenMenu} />);
    const header = screen.getByTestId('ix-sidebar-header');
    expect(header.querySelector('[data-server-mark]')).toHaveTextContent('F');
    expect(header).toHaveTextContent('Fuel2 members · 2 here now');
    const overview = screen.getByRole('button', { name: 'Fuel overview, 2 members · 2 here now' });
    fireEvent.click(overview);
    expect(onOpenOverview).toHaveBeenCalledTimes(1);
    const more = screen.getByRole('button', { name: 'Server options' });
    expect(more).toHaveAttribute('aria-haspopup', 'menu');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
  });

  it('has no chevron, and a right-click anywhere on it opens the menu', () => {
    const onContextMenu = vi.fn();
    render(<SidebarHeader {...props} onContextMenu={onContextMenu} />);
    expect(screen.getByTestId('ix-sidebar-header').querySelector('.ix-sb__chev')).toBeNull();
    fireEvent.contextMenu(screen.getByTestId('ix-sidebar-header'));
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });

  it('is current on the Overview page, and "…" reports its menu open', () => {
    render(<SidebarHeader {...props} current menuOpen />);
    expect(screen.getByRole('button', { name: /Fuel overview/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Server options' })).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('the search field', () => {
  beforeEach(() => useUIStore.getState().setCommandPaletteOpen(false));
  afterEach(() => useUIStore.getState().setCommandPaletteOpen(false));

  it('says "Search Fuel" and the shortcut, and opens the quick switcher', () => {
    render(<SearchField name="Fuel" />);
    const field = screen.getByTestId('ix-search-field');
    expect(field.tagName).toBe('BUTTON');
    expect(field).toHaveTextContent('Search FuelCtrl K');
    expect(field.querySelector('kbd')).toHaveTextContent('Ctrl K');
    expect(field).toHaveAttribute('aria-keyshortcuts', 'Control+K');
    fireEvent.click(field);
    expect(useUIStore.getState().commandPaletteOpen).toBe(true);
  });
});

/* ---- The keyboard ----------------------------------------------------------------------------------- */

describe('the roving list', () => {
  it('moves with Up and Down (wrapping), Home and End, and ignores every other key', () => {
    expect(nextRowIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextRowIndex('ArrowDown', 2, 3)).toBe(0);
    expect(nextRowIndex('ArrowUp', 0, 3)).toBe(2);
    expect(nextRowIndex('ArrowUp', 2, 3)).toBe(1);
    expect(nextRowIndex('Home', 2, 3)).toBe(0);
    expect(nextRowIndex('End', 0, 3)).toBe(2);
    expect(nextRowIndex('ArrowDown', -1, 3)).toBe(0);
    expect(nextRowIndex('a', 0, 3)).toBeNull();
    expect(nextRowIndex('ArrowDown', 0, 0)).toBeNull();
  });

  function List() {
    const ids = ['a', 'b', 'c'];
    const roving = useRovingList(ids, 'b');
    return (
      <div data-testid="list" onKeyDown={(event) => rovingKeyDown(event.currentTarget, event)}>
        {ids.map((id) => (
          <a key={id} href={`#${id}`} data-place-row="" {...roving.focusOf(id)} onClick={(event) => event.preventDefault()}>
            {id}
          </a>
        ))}
        <button type="button">outside</button>
      </div>
    );
  }

  it('is one Tab stop: the preferred row, then whichever was focused last', () => {
    render(<List />);
    const [a, b, c] = screen.getAllByRole('link');
    expect([a, b, c].map((link) => link.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    a.focus();
    fireEvent.focus(a);
    expect([a, b, c].map((link) => link.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
  });

  it('moves focus between rows with the arrow keys, and only from a row', () => {
    render(<List />);
    const [a, b, c] = screen.getAllByRole('link');
    b.focus();
    fireEvent.keyDown(b, { key: 'ArrowDown' });
    expect(c).toHaveFocus();
    fireEvent.keyDown(c, { key: 'ArrowDown' });
    expect(a).toHaveFocus();
    fireEvent.keyDown(a, { key: 'End' });
    expect(c).toHaveFocus();
    fireEvent.keyDown(c, { key: 'Home' });
    expect(a).toHaveFocus();
    const outside = screen.getByRole('button', { name: 'outside' });
    outside.focus();
    fireEvent.keyDown(outside, { key: 'ArrowDown' });
    expect(outside).toHaveFocus();
  });

  it('opens a link row with Space, and leaves a modified or shifted key alone', () => {
    render(<List />);
    const [, b, c] = screen.getAllByRole('link');
    const clicks = vi.fn();
    b.addEventListener('click', clicks);
    b.focus();
    fireEvent.keyDown(b, { key: ' ' });
    expect(clicks).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(b, { key: 'ArrowDown', altKey: true });
    fireEvent.keyDown(b, { key: 'ArrowDown', shiftKey: true });
    expect(c).not.toHaveFocus();
    expect(b).toHaveFocus();
  });
});

/* ---- Long press (touch) ------------------------------------------------------------------------------- */

describe('a long press', () => {
  function Pressable({ onPress, onOpen }: { onPress: (point: { x: number; y: number }) => void; onOpen: () => void }) {
    const press = useLongPress(onPress);
    return (
      <button type="button" {...press} onClick={onOpen}>
        row
      </button>
    );
  }
  const touch = { pointerType: 'touch', clientX: 40, clientY: 80 };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens the menu where a finger has held for half a second, and swallows the click that follows', () => {
    const onPress = vi.fn();
    const onOpen = vi.fn();
    render(<Pressable onPress={onPress} onOpen={onOpen} />);
    const button = screen.getByRole('button');
    fireEvent.pointerDown(button, touch);
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(onPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onPress).toHaveBeenCalledWith({ x: 40, y: 80 });
    fireEvent.pointerUp(button, touch);
    fireEvent.click(button);
    expect(onOpen).not.toHaveBeenCalled();
    // The next tap is an ordinary one.
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('is a scroll, not a press, when the finger moves or lifts early; and a mouse never presses', () => {
    const onPress = vi.fn();
    render(<Pressable onPress={onPress} onOpen={vi.fn()} />);
    const button = screen.getByRole('button');
    fireEvent.pointerDown(button, touch);
    fireEvent.pointerMove(button, { ...touch, clientX: 70 });
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    fireEvent.pointerDown(button, touch);
    vi.advanceTimersByTime(200);
    fireEvent.pointerUp(button, touch);
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    fireEvent.pointerDown(button, { pointerType: 'mouse', clientX: 1, clientY: 1 });
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('puts a point where a menu opener reads a mouse event', () => {
    const event = pointEvent({ x: 12, y: 34 });
    expect([event.clientX, event.clientY]).toEqual([12, 34]);
    expect(() => {
      event.preventDefault();
      event.stopPropagation();
    }).not.toThrow();
  });

  it('opens a channel row’s menu', () => {
    const onContextMenu = vi.fn();
    const onOpen = vi.fn();
    render(
      <ChannelRow
        row={row({ channelId: 'c', name: 'general' })}
        href="/c"
        group="channels"
        keep={false}
        leaving={false}
        tabIndex={0}
        onFocus={vi.fn()}
        onOpen={onOpen}
        onContextMenu={onContextMenu}
      />,
    );
    const link = screen.getByTestId('ix-channel-row');
    fireEvent.pointerDown(link, touch);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onContextMenu).toHaveBeenCalledWith(expect.objectContaining({ clientX: 40, clientY: 80 }));
    fireEvent.click(link);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('opens a room row’s menu', () => {
    const onMenu = vi.fn();
    const lounge = { id: 'room:l', channelId: 'l', name: 'Lounge', stage: false, busy: false, count: 0, tail: 'Empty', faces: [], people: [], streaming: false };
    render(<RoomList rooms={[lounge]} focusOf={focus} onJoin={vi.fn()} onMenu={onMenu} />);
    fireEvent.pointerDown(screen.getByTestId('ix-room-row'), touch);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onMenu).toHaveBeenCalledWith(expect.objectContaining({ clientX: 40, clientY: 80 }), lounge);
  });
});
