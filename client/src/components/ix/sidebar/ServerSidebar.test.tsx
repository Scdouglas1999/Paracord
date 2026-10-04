import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSidebarGroups, buildSidebarRooms } from '../../glass/places/rows';
import { entityScopeKey } from '../../../lib/serverScope';
import { useChannelStore } from '../../../stores/channelStore';
import { useMemberStore } from '../../../stores/memberStore';
import { ChannelType, type Channel } from '../../../types';
import { IxShellProvider, type IxShellValue } from '../shell/IxShellContext';
import { serverPlace } from '../shell/place';
import { SidebarSlot } from './SidebarSlot';

/**
 * The server pane wired together, with its data hooks, the card and the menus
 * stubbed: what is on the page, in what order, where each click goes, which pane
 * holds which place. The rules behind each row are in sidebarRows.test.ts and
 * sidebar.test.tsx; the pixels are the e2e spec's.
 */

const SCOPE = { serverId: 'srv', userId: 'me' };
const GUILD = {
  id: 'g1',
  key: entityScopeKey(SCOPE, 'g1'),
  scope: SCOPE,
  name: 'Fuel',
  icon: null,
  icon_hash: null,
  hue: null,
  member_count: 6,
};
const OTHER = { ...GUILD, id: 'g2', key: entityScopeKey(SCOPE, 'g2'), name: 'Game Night', member_count: 12 };

const hooks = vi.hoisted(() => ({
  guilds: [] as unknown[],
  data: null as unknown,
  addons: [] as unknown[],
  cardRoom: null as string | null,
  openServerMenu: vi.fn(),
  openCreateChannel: vi.fn(),
  joinRoom: vi.fn(),
  channelMenu: vi.fn(() => []),
  roomRowMenu: vi.fn(() => []),
  activateGuild: vi.fn(),
  serverMenuOpen: false,
  selections: [] as Array<string | null>,
}));

vi.mock('../../../hooks/useGuilds', () => ({ useAvailableGuilds: () => hooks.guilds }));
vi.mock('../../glass/places/usePlacesData', () => ({
  useServerSidebar: (_guildId: string, selectedChannelId: string | null) => {
    hooks.selections.push(selectedChannelId);
    return hooks.data;
  },
}));
vi.mock('./useAddons', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./useAddons')>()),
  useAddons: () => hooks.addons,
}));
vi.mock('./useSidebarMenus', () => ({
  useSidebarMenus: () => ({ canManage: true, channelMenu: hooks.channelMenu, roomRowMenu: hooks.roomRowMenu, joinRoom: hooks.joinRoom }),
}));
vi.mock('../../../lib/guildNavigation', () => ({ activateGuild: hooks.activateGuild }));
vi.mock('../card', () => ({
  CardSlot: ({ place, position }: { place: { kind: string; guildId?: string }; position: string }) => (
    <div data-testid="card-slot" data-position={position} data-place={place.kind === 'server' ? place.guildId : place.kind} />
  ),
  useInlineCardRoom: () => hooks.cardRoom,
}));
vi.mock('../menus', () => ({
  anchorFromEvent: (event: { clientX: number; clientY: number }) => ({ x: event.clientX, y: event.clientY }),
  openServerMenu: hooks.openServerMenu,
  openCreateChannel: hooks.openCreateChannel,
  useServerMenuOpenFor: () => hooks.serverMenuOpen,
}));
vi.mock('../people', () => ({ PeopleSidebar: () => <div data-testid="people-sidebar" /> }));
vi.mock('../../ui/ContextMenu', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ui/ContextMenu')>()),
  ContextMenu: ({ open, items }: { open: boolean; items: Array<{ label: string }> }) =>
    open ? <div role="menu">{items.map((item) => <span key={item.label}>{item.label}</span>)}</div> : null,
}));

const NOW = new Date(2026, 9, 1, 21, 38).getTime();
const EPOCH_MS = 1704067200000;
const idAt = (ms: number) => ((BigInt(ms - EPOCH_MS) << 22n)).toString();
const channel = (id: string, name: string, over: Partial<Channel> = {}): Channel =>
  ({ id, name, type: ChannelType.Text, position: 0, nsfw: false, guild_id: 'g1', created_at: '2026-01-01T00:00:00Z', ...over }) as Channel;

function data(over: Record<string, unknown> = {}) {
  const channels = [
    channel('general', 'general', { last_message_id: idAt(NOW - 3 * 60_000) }),
    channel('clips', 'clips', { position: 1, last_message_id: idAt(NOW - 2 * 60_000) }),
    channel('lounge', 'Lounge', { type: ChannelType.Voice, position: 3 }),
    channel('late', 'Late night', { type: ChannelType.Voice, position: 4 }),
  ];
  const input = {
    channels,
    previews: new Map(),
    previewStatus: 'ready' as const,
    readStates: {},
    mutedChannelIds: new Set<string>(),
    guildMuted: false,
    context: { selfUserId: 'me', memberNames: new Map(), channelNames: new Map(), eventNames: new Map() },
    selectedChannelId: 'general',
    nowMs: NOW,
  };
  return {
    listStatus: 'ready',
    listError: null,
    groups: buildSidebarGroups(input),
    rooms: buildSidebarRooms(channels, new Map()),
    roster: { known: true, size: 6, here: 4 },
    channels,
    events: [],
    eventRoomName: () => null,
    nowMs: NOW,
    selfUserId: 'me',
    ...over,
  };
}

function Where() {
  const { pathname } = useLocation();
  return <div data-testid="where">{pathname}</div>;
}

function shell(over: Partial<IxShellValue> = {}): IxShellValue {
  return { layout: 'wide', place: serverPlace('g1'), guildId: 'g1', channelId: 'general', ...over };
}

function renderPane(ui: ReactNode, value: IxShellValue = shell()) {
  return render(
    <MemoryRouter initialEntries={[`/app/guilds/${value.guildId}/channels/${value.channelId}`]}>
      <IxShellProvider value={value}>{ui}</IxShellProvider>
      <Where />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  hooks.guilds = [GUILD, OTHER];
  hooks.data = data();
  hooks.addons = [];
  hooks.cardRoom = null;
  hooks.serverMenuOpen = false;
  hooks.selections = [];
  for (const mock of [hooks.openServerMenu, hooks.openCreateChannel, hooks.joinRoom, hooks.channelMenu, hooks.roomRowMenu, hooks.activateGuild]) mock.mockClear();
  // The roster is already in: the pane asks for nothing.
  useChannelStore.setState({ guildChannelsLoaded: { [GUILD.key]: true, [OTHER.key]: true }, loading: {}, errors: {} } as never);
  useMemberStore.setState({ membersLoaded: { [GUILD.key]: true, [OTHER.key]: true }, loading: {} } as never);
});

describe('the server pane', () => {
  it('is the header, the search field, the live card’s inline slot, then channels and rooms, in that order', () => {
    renderPane(<SidebarSlot place={serverPlace('g1')} />);
    const header = screen.getByTestId('ix-sidebar-header');
    const search = screen.getByTestId('ix-search-field');
    const card = screen.getByTestId('card-slot');
    const channels = screen.getByRole('heading', { name: 'Channels' });
    const rooms = screen.getByRole('heading', { name: 'Rooms' });
    const order = [header, search, card, channels, rooms];
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // The card is told which pane it is in, for the place of THIS pane.
    expect(card).toHaveAttribute('data-position', 'inline');
    expect(card).toHaveAttribute('data-place', 'g1');
    expect(header).toHaveTextContent('Fuel');
    expect(header).toHaveTextContent('6 members · 4 here now');
  });

  it('leaves out of Rooms the one room the card shows', () => {
    hooks.cardRoom = 'lounge';
    renderPane(<SidebarSlot place={serverPlace('g1')} />);
    expect(screen.getAllByTestId('ix-room-row').map((room) => room.getAttribute('data-channel-id'))).toEqual(['late']);
  });

  it('opens a channel on click: activates the server and goes to its address', () => {
    renderPane(<SidebarSlot place={serverPlace('g1')} />);
    fireEvent.click(screen.getAllByTestId('ix-channel-row').find((row) => row.getAttribute('data-channel-id') === 'clips') as HTMLElement);
    expect(hooks.activateGuild).toHaveBeenCalledWith({ id: 'g1', scope: SCOPE });
    expect(screen.getByTestId('where')).toHaveTextContent('/app/guilds/g1/channels/clips');
  });

  it('opens Overview from the header, and the server menu from "…" (under the button, hung from its right edge)', () => {
    renderPane(<SidebarSlot place={serverPlace('g1')} />);
    fireEvent.click(screen.getByRole('button', { name: /Fuel overview/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/app/guilds/g1');
    expect(screen.getByTestId('where').textContent).not.toContain('channels');
    const more = screen.getByRole('button', { name: 'Server options' });
    fireEvent.click(more);
    expect(hooks.openServerMenu).toHaveBeenCalledWith(expect.objectContaining({ guildId: 'g1', name: 'Fuel', scope: SCOPE }), { element: more, align: 'end' });
  });

  it('opens the server menu at the pointer on a right-click of the header', () => {
    renderPane(<SidebarSlot place={serverPlace('g1')} />);
    fireEvent.contextMenu(screen.getByTestId('ix-sidebar-header'), { clientX: 120, clientY: 40 });
    expect(hooks.openServerMenu).toHaveBeenCalledWith(expect.objectContaining({ guildId: 'g1' }), { x: 120, y: 40 });
  });

  it('joins a room on click, and builds a room’s menu on right-click', () => {
    renderPane(<SidebarSlot place={serverPlace('g1')} />);
    const late = screen.getAllByTestId('ix-room-row').find((room) => room.getAttribute('data-channel-id') === 'late') as HTMLElement;
    fireEvent.click(late);
    expect(hooks.joinRoom).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'late', name: 'Late night' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/channels/general');
    fireEvent.contextMenu(late);
    expect(hooks.roomRowMenu).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'late' }));
  });

  it('builds a channel’s menu on right-click, with the channel’s own name', () => {
    renderPane(<SidebarSlot place={serverPlace('g1')} />);
    fireEvent.contextMenu(screen.getAllByTestId('ix-channel-row').find((row) => row.getAttribute('data-channel-id') === 'clips') as HTMLElement);
    expect(hooks.channelMenu).toHaveBeenCalledWith('clips', 'clips');
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('creates a channel in the group whose "+" was pressed', () => {
    renderPane(<SidebarSlot place={serverPlace('g1')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create a channel in Channels' }));
    expect(hooks.openCreateChannel).toHaveBeenCalledWith({ guildId: 'g1', scope: SCOPE, kind: 'text', parentId: null });
  });

  it('is the one Tab stop on the open channel, and moves with the arrow keys', () => {
    renderPane(<SidebarSlot place={serverPlace('g1')} />);
    const rows = screen.getAllByTestId('ix-channel-row');
    const general = rows.find((row) => row.getAttribute('data-channel-id') === 'general') as HTMLElement;
    const clips = rows.find((row) => row.getAttribute('data-channel-id') === 'clips') as HTMLElement;
    expect(general).toHaveAttribute('tabindex', '0');
    expect(clips).toHaveAttribute('tabindex', '-1');
    general.focus();
    fireEvent.keyDown(general, { key: 'ArrowDown' });
    expect(clips).toHaveFocus();
  });

  it('marks the route’s channel as the open one in this pane', () => {
    renderPane(<SidebarSlot place={serverPlace('g1')} />);
    expect(screen.getByTestId('ix-sidebar-header').closest('[data-ix-sidebar-pane]')).toHaveAttribute('data-ix-sidebar-pane', 'server');
  });

  it('says why when the list could not load, and offers to try again', () => {
    hooks.data = data({ listStatus: 'error', listError: 'Network down', groups: [], rooms: [] });
    const spy = vi.spyOn(useChannelStore.getState(), 'fetchChannels').mockResolvedValue();
    useChannelStore.setState({ fetchChannels: spy } as never);
    renderPane(<SidebarSlot place={serverPlace('g1')} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Could not load this server's channels. Network down");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(spy).toHaveBeenCalledWith('g1', SCOPE);
  });

  it('says it is loading, and when there is nothing yet', () => {
    hooks.data = data({ listStatus: 'loading', groups: [], rooms: [] });
    const { unmount } = renderPane(<SidebarSlot place={serverPlace('g1')} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading channels…');
    unmount();
    hooks.data = data({ listStatus: 'empty', groups: [], rooms: [] });
    renderPane(<SidebarSlot place={serverPlace('g1')} />);
    expect(screen.getByText('No channels yet.')).toBeInTheDocument();
  });

  it('says a server that is not yours is not available, and offers nothing else', () => {
    hooks.guilds = [];
    renderPane(<SidebarSlot place={serverPlace('g1')} />);
    expect(screen.getByText('This server is not available.')).toBeInTheDocument();
    expect(screen.queryByTestId('ix-search-field')).toBeNull();
  });
});

describe('Coming up in the pane', () => {
  it('opens the server’s Events page for an event (there is no event sheet yet)', () => {
    const friday = new Date(2026, 9, 2, 21, 0);
    hooks.data = data({
      events: [{ id: '7', name: 'Movie night', startsAt: friday, endsAt: null, channelId: 'lounge', location: null, creatorId: null, going: 0, youAreGoing: false, happeningNow: false }],
      eventRoomName: () => 'Lounge',
    });
    renderPane(<SidebarSlot place={serverPlace('g1')} />);
    const row = screen.getByTestId('ix-event-row');
    expect(row).toHaveAttribute('href', '/app/guilds/g1/events');
    expect(row).toHaveTextContent('Fri 9:00 PM · Lounge');
    fireEvent.click(row);
    expect(screen.getByTestId('where')).toHaveTextContent('/app/guilds/g1/events');
  });
});

describe('the pane’s place', () => {
  it('shows the place it is given, not the route’s', () => {
    // The route is in Fuel; this pane is Game Night's (the one sliding in or out).
    renderPane(<SidebarSlot place={serverPlace('g2')} />, shell({ guildId: 'g1', place: serverPlace('g1') }));
    expect(screen.getByTestId('ix-sidebar-header')).toHaveTextContent('Game Night');
    expect(screen.getByTestId('card-slot')).toHaveAttribute('data-place', 'g2');
    // Nothing is open in it: the route's channel belongs to another server.
    expect(screen.getByTestId('ix-sidebar-header').closest('[data-ix-sidebar-pane]')).not.toBeNull();
  });

  it('renders People through the People slot', () => {
    renderPane(<SidebarSlot place={{ kind: 'people' }} />);
    expect(screen.getByTestId('people-sidebar')).toBeInTheDocument();
    expect(screen.queryByTestId('ix-sidebar-header')).toBeNull();
  });

  it('asks for the route’s channel as the open one while it is the current pane', () => {
    renderPane(<SidebarSlot place={serverPlace('g1')} />);
    expect(new Set(hooks.selections)).toEqual(new Set(['general']));
  });

  it('asks for no open channel for a server the route is not in', () => {
    renderPane(<SidebarSlot place={serverPlace('g2')} />, shell({ guildId: 'g1', channelId: 'general' }));
    expect(new Set(hooks.selections)).toEqual(new Set([null]));
  });
});

describe('a pane sliding out', () => {
  it('plays nothing and moves nothing: it renders what it had, with no selection glide', () => {
    renderPane(<SidebarSlot place={serverPlace('g1')} leaving />, shell({ guildId: 'g2', place: serverPlace('g2'), channelId: 'other' }));
    // The route has moved to another server: this pane keeps showing Fuel.
    expect(screen.getByTestId('ix-sidebar-header')).toHaveTextContent('Fuel');
    const rows = within(screen.getByTestId('ix-sidebar-header').closest('[data-ix-sidebar-pane]') as HTMLElement);
    expect(rows.getAllByTestId('ix-channel-row').length).toBeGreaterThan(0);
  });

  it('keeps the channel that was open once the route has moved on (it is sliding away, not changing)', async () => {
    const { rerender } = renderPane(<SidebarSlot place={serverPlace('g1')} />);
    await act(async () => {});
    rerender(
      <MemoryRouter initialEntries={['/app/guilds/g2/channels/x']}>
        <IxShellProvider value={shell({ guildId: 'g2', place: serverPlace('g2'), channelId: 'x' })}>
          <SidebarSlot place={serverPlace('g1')} leaving />
        </IxShellProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('ix-sidebar-header')).toHaveTextContent('Fuel');
    // Its last asks were for the channel it had, never for the other server's.
    expect(hooks.selections.at(-1)).toBe('general');
    expect(hooks.selections).not.toContain('x');
  });
});
