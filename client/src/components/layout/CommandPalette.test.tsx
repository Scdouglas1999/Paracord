import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { entityScopeKey } from '../../lib/serverScope';
import { useChannelStore } from '../../stores/channelStore';
import { useGlassStore } from '../../stores/glassStore';
import { useMemberStore } from '../../stores/memberStore';
import { useRelationshipStore } from '../../stores/relationshipStore';
import { useUIStore } from '../../stores/uiStore';
import { useMenuHostStore } from '../ix/menus/hostStore';
import { useSheetPages } from '../glass/sheets/sheetStore';
import { CommandPalette } from './CommandPalette';

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => navigateMock };
});

// The palette mounts DmPickerModal to satisfy the "New message" command; stub it
// so the test asserts the trigger without pulling in its friend-list fetch.
vi.mock('../message/DmPickerModal', () => ({
  DmPickerModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="dm-picker">DM picker</div> : null,
}));

// Avatars and server marks subscribe to the download ticket (a network mint).
vi.mock('../../hooks/useDownloadTicket', () => ({ useDownloadTicket: () => null }));

// Activating a server or channel checks the signed-in account; the route is what is under test.
vi.mock('../../lib/guildNavigation', () => ({
  activateGuild: vi.fn(),
  guildLandingPath: vi.fn(async (guild: { id: string }) => `/app/guilds/${guild.id}/channels/landing`),
}));
vi.mock('../../lib/channelNavigation', () => ({ activateChannel: vi.fn() }));

const SCOPE = { serverId: '__local__', userId: 'me' };

const world = vi.hoisted(() => ({
  guilds: [] as unknown[],
  dms: [] as unknown[],
}));

vi.mock('../../hooks/useGuilds', () => ({
  useAvailableGuilds: () => world.guilds,
  useSelectedGuildId: () => 'g1',
}));
vi.mock('../../hooks/useChannels', () => ({
  useAvailableChannels: () => world.dms,
}));
vi.mock('../../hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 'me', username: 'sean', flags: 0 }),
  useCurrentAccountScope: () => SCOPE,
}));

const guild = (id: string, name: string) => ({
  id,
  key: entityScopeKey(SCOPE, id),
  name,
  scope: SCOPE,
  icon_hash: null,
  hue: null,
});

const channel = (id: string, name: string, type: number, guildId: string | null = 'g1') => ({
  id,
  name,
  type,
  channel_type: type,
  guild_id: guildId,
  position: 0,
  scope: SCOPE,
});

const person = (id: string, name: string) => ({
  id,
  username: name.toLowerCase(),
  display_name: name,
  discriminator: 1,
  avatar_hash: null,
  bot: false,
  system: false,
  flags: 0,
  created_at: '2026-01-01T00:00:00.000Z',
});

function seed() {
  world.guilds = [guild('g1', 'Game Night'), guild('g2', 'Fuel')];
  world.dms = [{ ...channel('d1', '', 1, null), recipient: person('u2', 'Jeremy') }];
  useChannelStore.setState({
    channelsByGuild: {
      [entityScopeKey(SCOPE, 'g1')]: [channel('c1', 'lounge', 0), channel('c2', 'screenshots', 0), channel('v1', 'Ranked', 2)],
      [entityScopeKey(SCOPE, 'g2')]: [channel('c3', 'plans', 0)],
    },
  } as never);
  useMemberStore.setState({
    members: new Map([
      [
        entityScopeKey(SCOPE, 'g1'),
        [
          { user: person('u3', 'Nick'), roles: [], joined_at: '', deaf: false, mute: false },
          { user: person('u4', 'Maya'), roles: [], joined_at: '', deaf: false, mute: false },
        ],
      ],
    ]),
  } as never);
}

function renderPalette(path = '/app/guilds/g1/channels/c1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <button type="button">Open palette</button>
      <Routes>
        <Route path="/app/guilds/:guildId/channels/:channelId" element={<CommandPalette />} />
        <Route path="*" element={<CommandPalette />} />
      </Routes>
    </MemoryRouter>,
  );
}

const dialog = () => screen.getByRole('dialog', { name: 'Quick switcher' });
const field = () => screen.getByRole('combobox', { name: 'Search the quick switcher' });
const groupNames = () => within(dialog()).getAllByRole('group').map((group) => group.getAttribute('aria-label'));

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  navigateMock.mockClear();
  seed();
  useUIStore.setState({ commandPaletteOpen: false });
  useGlassStore.getState().reset();
  useSheetPages.getState().reset();
  useMenuHostStore.getState().reset();
});

afterEach(() => {
  act(() => {
    useUIStore.setState({ commandPaletteOpen: false });
  });
});

async function openWithKeyboard() {
  const user = userEvent.setup();
  renderPalette();
  screen.getByRole('button', { name: 'Open palette' }).focus();
  await user.keyboard('{Control>}k{/Control}');
  await screen.findByRole('dialog', { name: 'Quick switcher' });
  return user;
}

describe('the quick switcher: access', () => {
  it('opens as a named modal dialog and focuses the search field', async () => {
    await openWithKeyboard();
    expect(dialog()).toHaveAttribute('aria-modal', 'true');
    expect(dialog()).toHaveAttribute('tabindex', '-1');
    await waitFor(() => expect(field()).toHaveFocus());
  });

  it('traps Tab focus and restores focus after Escape closes it', async () => {
    const user = await openWithKeyboard();
    const opener = screen.getByRole('button', { name: 'Open palette' });
    await waitFor(() => expect(field()).toHaveFocus());

    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(dialog()).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Quick switcher' })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('toggles closed on a second Mod+K', async () => {
    const user = await openWithKeyboard();
    await user.keyboard('{Control>}k{/Control}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Quick switcher' })).not.toBeInTheDocument());
    expect(useUIStore.getState().commandPaletteOpen).toBe(false);
  });

  it('closes on a click outside, and does not dim the page behind it', async () => {
    const user = await openWithKeyboard();
    const scrim = dialog().parentElement as HTMLElement;
    expect(scrim).toHaveClass('ix-switcher-scrim');
    await user.pointer({ target: scrim, keys: '[MouseLeft]' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Quick switcher' })).not.toBeInTheDocument());
  });
});

describe('the quick switcher: scoped to people (docs/index-spec.md §6.6)', () => {
  async function openInPeople() {
    useRelationshipStore.setState({
      relationships: [
        { id: 'r1', type: 1, user: person('u2', 'Jeremy') },
        { id: 'r2', type: 1, user: person('u3', 'Nick') },
        { id: 'r3', type: 1, user: person('u4', 'Maya') },
        { id: 'r4', type: 3, user: person('u5', 'Brendan') },
      ],
    } as never);
    const user = userEvent.setup();
    renderPalette('/app/dms/d1');
    screen.getByRole('button', { name: 'Open palette' }).focus();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Quick switcher' });
    return user;
  }

  it('lists your conversations first, then your friends, then the servers; no channels until you type', async () => {
    await openInPeople();
    expect(groupNames()).toEqual(['Direct messages', 'People', 'Servers']);
    expect(field()).toHaveAttribute('placeholder', 'Find a person or conversation');
    // Every server is a server here (none is "current"), and a channel is found only by typing.
    expect(within(screen.getByRole('group', { name: 'Servers' })).getAllByRole('option')).toHaveLength(2);
    // A friend you already talk to is under Direct messages, not listed twice; a request is not a friend.
    const people = within(screen.getByRole('group', { name: 'People' })).getAllByRole('option');
    expect(people.map((row) => row.textContent)).toEqual([expect.stringContaining('Nick'), expect.stringContaining('Maya')]);
  });

  it('finds channels of any server by typing', async () => {
    const user = await openInPeople();
    await user.type(field(), 'lounge');
    expect(within(screen.getByRole('group', { name: 'In other servers' })).getByRole('option', { name: /lounge/ })).toBeInTheDocument();
  });
});

describe('the quick switcher: scope and order (docs/index-spec.md §4.2)', () => {
  it('lists the current server first (channels, rooms), then other servers and direct messages', async () => {
    await openWithKeyboard();
    expect(groupNames()).toEqual(['Channels', 'Voice channels', 'Servers', 'Direct messages']);
    const channels = within(screen.getByRole('group', { name: 'Channels' })).getAllByRole('option');
    expect(channels.map((row) => row.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('lounge'), expect.stringContaining('screenshots')]));
    expect(within(screen.getByRole('group', { name: 'Voice channels' })).getByRole('option', { name: /Ranked/ })).toBeInTheDocument();
    // The other server, not the current one.
    expect(within(screen.getByRole('group', { name: 'Servers' })).getByRole('option', { name: /Fuel/ })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Servers' })).queryByRole('option', { name: /Game Night/ })).not.toBeInTheDocument();
  });

  it('shows people and the commands only when what is typed matches them, after the places', async () => {
    const user = await openWithKeyboard();
    expect(screen.queryByRole('option', { name: /New message/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Nick/ })).not.toBeInTheDocument();
    await user.type(field(), 'n');
    const order = ['Channels', 'Voice channels', 'People', 'Servers', 'Direct messages', 'In other servers', 'Commands'];
    const names = groupNames();
    expect(names).toEqual(order.filter((label) => names.includes(label)));
    expect(names).toContain('People');
    expect(names[names.length - 1]).toBe('Commands');
  });

  it('ends with a row that searches messages in this server, with the words carried over', async () => {
    const user = await openWithKeyboard();
    const rows = () => within(dialog()).getAllByRole('option');
    expect(rows().at(-1)).toHaveTextContent('Search messages in Game Night');
    await user.type(field(), 'guns');
    expect(rows().at(-1)).toHaveTextContent('Search messages in Game Night for “guns”');
    // Move to the last row and open it: the search sheet opens with the words in it.
    for (let i = 0; i < rows().length; i += 1) await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(useGlassStore.getState().sheet).toBe('search'));
    expect(useSheetPages.getState().searchSeed).toBe('guns');
  });

  it('opens a channel in the current server with Enter', async () => {
    const user = await openWithKeyboard();
    await user.type(field(), 'screen');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/app/guilds/g1/channels/c2'));
  });

  it('says so, and still offers the message search, when nothing matches', async () => {
    const user = await openWithKeyboard();
    await user.type(field(), 'zzzz');
    expect(screen.getByText('Nothing matches “zzzz”')).toBeInTheDocument();
    expect(within(dialog()).getByRole('option', { name: /Search messages in Game Night for “zzzz”/ })).toBeInTheDocument();
  });

  it('has no message-search row where there is nothing to search (no server or conversation on the page)', async () => {
    const user = userEvent.setup();
    renderPalette('/app/friends');
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Quick switcher' });
    expect(within(dialog()).queryByRole('option', { name: /Search messages/ })).not.toBeInTheDocument();
  });
});

describe('the quick switcher: commands', () => {
  async function openAndType(query: string) {
    const user = await openWithKeyboard();
    await user.type(field(), query);
    return user;
  }

  it('offers the social commands when typed', async () => {
    await openAndType('friend');
    expect(screen.getByRole('option', { name: /Add a friend/ })).toBeInTheDocument();
    expect(screen.getAllByRole('option', { name: /^Friends/ })).toHaveLength(1);
  });

  it('opens the DM picker from "New message"', async () => {
    const user = await openAndType('new message');
    await user.click(screen.getByRole('option', { name: /New message/ }));
    await waitFor(() => expect(screen.getByTestId('dm-picker')).toBeInTheDocument());
  });

  it('routes "Add a friend" to the friends page', async () => {
    const user = await openAndType('add a friend');
    await user.click(screen.getByRole('option', { name: /Add a friend/ }));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/app/friends', { state: { addFriend: true } }));
  });

  it('routes "All conversations" to the DM index', async () => {
    const user = await openAndType('all conv');
    await user.click(screen.getByRole('option', { name: /All conversations/ }));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/app/dms'));
  });

  it('has no "Go to home": Home is retired into People', async () => {
    await openAndType('home');
    expect(screen.queryByRole('option', { name: /Go to home/ })).not.toBeInTheDocument();
  });
});
