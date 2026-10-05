import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../../stores/authStore';
import { useGlassStore } from '../../../stores/glassStore';
import { useUIStore } from '../../../stores/uiStore';
import { useSheetPages } from '../../glass/sheets/sheetStore';
import { openAccountMenu } from './accountMenuOpener';
import { AccountMenu } from './AccountMenu';
import { buildChannelMenu, type ChannelMenuInput } from './ChannelMenu';
import { closeMenu, useMenuHostStore } from './hostStore';
import { IxMenu, type IxMenuEntry } from './IxMenu';
import { buildPeopleMenu } from './PeopleMenu';
import { buildServerMenu, useServerMenu, type ServerMenuActions, type ServerMenuInput } from './ServerMenu';

/**
 * The Index menus (docs/index-spec.md §6.2-6.6): which rows each person sees
 * (decided by plain booleans, so it is a unit test and not a screenshot), the
 * popover's keyboard and focus, and the account menu hanging from the toolbar's
 * avatar.
 */

vi.mock('../../../lib/presenceActivities', () => ({ publishPresence: vi.fn() }));
vi.mock('../../../lib/clipboard', () => ({ writeClipboardText: vi.fn().mockResolvedValue(undefined) }));
// An avatar subscribes to the download ticket (a network mint).
vi.mock('../../../hooks/useDownloadTicket', () => ({ useDownloadTicket: () => null }));

const actions = (): ServerMenuActions => ({
  overview: vi.fn(),
  invite: vi.fn(),
  events: vi.fn(),
  setLevel: vi.fn(),
  markRead: vi.fn(),
  toggleMute: vi.fn(),
  createChannel: vi.fn(),
  createRoom: vi.fn(),
  settings: vi.fn(),
  copyLink: vi.fn(),
  leave: vi.fn(),
});

const server = (over: Partial<ServerMenuInput> = {}, can: Partial<ServerMenuInput['can']> = {}): ServerMenuInput => ({
  name: 'Fuel',
  muted: false,
  level: 0,
  isOwner: false,
  hasInviteChannel: true,
  can: { createInvite: false, manageChannels: false, settings: false, ...can },
  ...over,
});

const labels = (entries: IxMenuEntry[]) =>
  entries.flatMap((entry) => (entry.type === 'item' || entry.type === 'group' ? [entry.label] : []));

describe('the server menu: rows by permission (§6.2)', () => {
  it('gives an ordinary member Overview, Events, Notifications, Mark as read, Mute, Copy link and Leave', () => {
    expect(labels(buildServerMenu(server(), actions()))).toEqual([
      'Overview',
      'Events',
      'Notifications',
      'Mark as read',
      'Mute server',
      'Copy link',
      'Leave server',
    ]);
  });

  it('adds Invite people with the invite permission, once there is a channel to mint it through', () => {
    const can = { createInvite: true };
    expect(labels(buildServerMenu(server({}, can), actions()))).toContain('Invite people');
    expect(labels(buildServerMenu(server({ hasInviteChannel: false }, can), actions()))).not.toContain('Invite people');
    expect(labels(buildServerMenu(server(), actions()))).not.toContain('Invite people');
  });

  it('adds Create channel and Create voice channel only with Manage Channels', () => {
    expect(labels(buildServerMenu(server({}, { manageChannels: true }), actions()))).toEqual(
      expect.arrayContaining(['Create channel', 'Create voice channel']),
    );
    expect(labels(buildServerMenu(server(), actions()))).not.toContain('Create channel');
    expect(labels(buildServerMenu(server(), actions()))).not.toContain('Create voice channel');
  });

  it('adds Server settings only where it is permitted', () => {
    expect(labels(buildServerMenu(server({}, { settings: true }), actions()))).toContain('Server settings');
    expect(labels(buildServerMenu(server(), actions()))).not.toContain('Server settings');
  });

  it('never offers the owner Leave server, and keeps it for everyone else, in the danger ink', () => {
    expect(labels(buildServerMenu(server({ isOwner: true }), actions()))).not.toContain('Leave server');
    const leave = buildServerMenu(server(), actions()).find((entry) => entry.type === 'item' && entry.id === 'leave');
    expect(leave).toMatchObject({ danger: true });
  });

  it('says Unmute when the server is muted, and disables the row while it saves', () => {
    const entries = buildServerMenu(server({ muted: true, saving: true }), actions());
    const mute = entries.find((entry) => entry.type === 'item' && entry.id === 'mute');
    expect(mute).toMatchObject({ label: 'Unmute server', disabled: true });
  });

  it('puts the notification levels in a group, with the one in force checked', () => {
    const entries = buildServerMenu(server({ level: 1 }), actions());
    const group = entries.find((entry) => entry.type === 'group');
    expect(group).toMatchObject({ label: 'Notifications' });
    if (group?.type !== 'group') throw new Error('no group');
    expect(group.items.map((item) => [item.label, item.checked])).toEqual([
      ['All messages', false],
      ['Only mentions', true],
      ['Nothing', false],
    ]);
  });

  it('wires every row to its action', () => {
    const a = actions();
    const entries = buildServerMenu(server({ isOwner: false }, { createInvite: true, manageChannels: true, settings: true }), a);
    const items = entries.flatMap((entry) => (entry.type === 'item' ? [entry] : entry.type === 'group' ? entry.items : []));
    for (const item of items) item.onSelect();
    expect(a.overview).toHaveBeenCalled();
    expect(a.invite).toHaveBeenCalled();
    expect(a.events).toHaveBeenCalled();
    expect(a.setLevel).toHaveBeenCalledTimes(3);
    expect(a.markRead).toHaveBeenCalled();
    expect(a.toggleMute).toHaveBeenCalled();
    expect(a.createChannel).toHaveBeenCalled();
    expect(a.createRoom).toHaveBeenCalled();
    expect(a.settings).toHaveBeenCalled();
    expect(a.copyLink).toHaveBeenCalled();
    expect(a.leave).toHaveBeenCalled();
  });
});

describe('the channel menu: rows (§6.5)', () => {
  const channel = (over: Partial<ChannelMenuInput> = {}): ChannelMenuInput => ({
    isDm: false,
    isAnnouncement: false,
    summary: { allowed: true, reason: null },
    canEdit: false,
    ...over,
  });
  const noop = { page: vi.fn(), edit: vi.fn(), copyLink: vi.fn() };

  it('lists the pages of a channel, then Copy link; no Inbox, no Help', () => {
    expect(labels(buildChannelMenu(channel(), noop))).toEqual([
      'Catch up summary',
      'Pinned messages',
      'Threads',
      'Media',
      'Leaderboard',
      'Notifications',
      'Copy link',
    ]);
  });

  it('adds Follows to an announcement channel and Edit channel to someone who may', () => {
    const rows = labels(buildChannelMenu(channel({ isAnnouncement: true, canEdit: true }), noop));
    expect(rows).toContain('Follows');
    expect(rows).toContain('Edit channel');
    expect(labels(buildChannelMenu(channel(), noop))).not.toContain('Follows');
  });

  it('leaves threads, follows, the leaderboard and notifications out of a direct message', () => {
    expect(labels(buildChannelMenu(channel({ isDm: true, canEdit: true }), noop))).toEqual([
      'Catch up summary',
      'Pinned messages',
      'Media',
      'Edit channel',
      'Copy link',
    ]);
  });

  it('explains why a summary is unavailable instead of hiding it', () => {
    const row = buildChannelMenu(channel({ summary: { allowed: false, reason: 'Summaries are off.' } }), noop)[0];
    expect(row).toMatchObject({ disabled: true, description: 'Summaries are off.' });
  });

  it('opens the channel sheet on the page a row names', () => {
    const page = vi.fn();
    const rows = buildChannelMenu(channel(), { ...noop, page });
    for (const entry of rows) if (entry.type === 'item' && entry.id !== 'copy-link') entry.onSelect();
    expect(page.mock.calls.map(([name]) => name)).toEqual(['summary', 'pins', 'threads', 'media', 'leaderboard', 'notifications']);
  });
});

describe('the People menu (§6.6)', () => {
  it('has New message, Start a group, Add friend and Settings', () => {
    const a = { newMessage: vi.fn(), startGroup: vi.fn(), addFriend: vi.fn(), settings: vi.fn() };
    const entries = buildPeopleMenu(a);
    expect(labels(entries)).toEqual(['New message', 'Start a group', 'Add friend', 'Settings']);
    for (const entry of entries) if (entry.type === 'item') entry.onSelect();
    expect(a.newMessage).toHaveBeenCalled();
    expect(a.startGroup).toHaveBeenCalled();
    expect(a.addFriend).toHaveBeenCalled();
    expect(a.settings).toHaveBeenCalled();
  });
});

/* ---- The popover ---------------------------------------------------------------------- */

function Harness({ entries, onClose }: { entries: IxMenuEntry[]; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen((value) => !value)}>
        Opener
      </button>
      <IxMenu
        open={open}
        anchor={{ x: 40, y: 40 }}
        label="Test menu"
        entries={entries}
        onClose={() => {
          setOpen(false);
          onClose?.();
        }}
      />
    </>
  );
}

const sample = (onSelect = vi.fn()): IxMenuEntry[] => [
  { type: 'item', id: 'a', label: 'Alpha', onSelect },
  { type: 'item', id: 'b', label: 'Bravo', onSelect: vi.fn() },
  { type: 'separator', id: 's' },
  { type: 'item', id: 'c', label: 'Charlie', disabled: true, onSelect: vi.fn() },
  { type: 'item', id: 'd', label: 'Delta', danger: true, onSelect: vi.fn() },
];

async function openMenu(entries: IxMenuEntry[] = sample(), onClose?: () => void) {
  const user = userEvent.setup();
  render(<Harness entries={entries} onClose={onClose} />);
  const opener = screen.getByRole('button', { name: 'Opener' });
  opener.focus();
  await user.click(opener);
  const menu = await screen.findByRole('menu', { name: 'Test menu' });
  return { user, menu, opener };
}

describe('IxMenu: the popover', () => {
  it('is a menu with a name, and focus lands on its first row', async () => {
    const { menu } = await openMenu();
    expect(menu).toHaveClass('ix-menu');
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Alpha' })).toHaveFocus());
  });

  it('walks the rows with the arrow keys, wrapping, skipping a disabled one; Home and End jump', async () => {
    const { user, menu } = await openMenu();
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Alpha' })).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('menuitem', { name: 'Bravo' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('menuitem', { name: 'Delta' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(within(menu).getByRole('menuitem', { name: 'Delta' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(within(menu).getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(within(menu).getByRole('menuitem', { name: 'Delta' })).toHaveFocus();
  });

  it('jumps to the row that starts with the letter you type', async () => {
    const { user, menu } = await openMenu();
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Alpha' })).toHaveFocus());
    await user.keyboard('d');
    expect(within(menu).getByRole('menuitem', { name: 'Delta' })).toHaveFocus();
  });

  it('runs a row\'s action and closes', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { user, menu } = await openMenu(sample(onSelect), onClose);
    await user.click(within(menu).getByRole('menuitem', { name: 'Alpha' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Test menu' })).not.toBeInTheDocument());
  });

  it('closes on Escape and gives focus back to what opened it; a lower layer never hears the Escape', async () => {
    const lower = vi.fn();
    window.addEventListener('keydown', lower);
    const { user, opener } = await openMenu();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Test menu' })).not.toBeInTheDocument());
    // Focus goes back once the menu has let go of it, which a loaded runner can see a beat later.
    await waitFor(() => expect(opener).toHaveFocus());
    expect(lower).not.toHaveBeenCalled();
    window.removeEventListener('keydown', lower);
  });

  it('closes on Tab and on a press outside', async () => {
    const first = await openMenu();
    await first.user.keyboard('{Tab}');
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Test menu' })).not.toBeInTheDocument());
  });

  it('closes on a pointer press outside it', async () => {
    const { user } = await openMenu();
    await user.pointer({ target: document.body, keys: '[MouseLeft]' });
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Test menu' })).not.toBeInTheDocument());
  });

  it('draws a radio row with a check, a danger row in the danger ink, and a disabled row disabled', async () => {
    const entries: IxMenuEntry[] = [
      { type: 'item', id: 'x', label: 'Online', checked: true, onSelect: vi.fn() },
      { type: 'item', id: 'y', label: 'Idle', checked: false, onSelect: vi.fn() },
      { type: 'item', id: 'z', label: 'Leave', danger: true, onSelect: vi.fn() },
      { type: 'item', id: 'w', label: 'Soon', disabled: true, description: 'Not yet', onSelect: vi.fn() },
    ];
    const { menu } = await openMenu(entries);
    expect(within(menu).getByRole('menuitemradio', { name: 'Online' })).toHaveAttribute('aria-checked', 'true');
    expect(within(menu).getByRole('menuitemradio', { name: 'Idle' })).toHaveAttribute('aria-checked', 'false');
    expect(within(menu).getByRole('menuitem', { name: 'Leave' })).toHaveAttribute('data-danger');
    expect(within(menu).getByRole('menuitem', { name: /Soon/ })).toBeDisabled();
    await waitFor(() => expect(within(menu).getByRole('menuitemradio', { name: 'Online' })).toHaveFocus());
  });

  it('expands a group in place with its caret, and Right/Left open and close it from the keyboard', async () => {
    const level = vi.fn();
    const entries: IxMenuEntry[] = [
      {
        type: 'group',
        id: 'g',
        label: 'Notifications',
        items: [
          { type: 'item', id: 'g0', label: 'All messages', checked: true, keepOpen: true, onSelect: level },
          { type: 'item', id: 'g1', label: 'Nothing', checked: false, keepOpen: true, onSelect: level },
        ],
      },
      { type: 'item', id: 'o', label: 'Other', onSelect: vi.fn() },
    ];
    const { user, menu } = await openMenu(entries);
    const group = within(menu).getByRole('menuitem', { name: 'Notifications' });
    expect(group).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{ArrowRight}');
    expect(group).toHaveAttribute('aria-expanded', 'true');
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Nothing' }));
    expect(level).toHaveBeenCalledTimes(1);
    // keepOpen: choosing a level leaves the menu where it is.
    expect(screen.getByRole('menu', { name: 'Test menu' })).toBeInTheDocument();
    group.focus();
    await user.keyboard('{ArrowLeft}');
    expect(group).toHaveAttribute('aria-expanded', 'false');
  });
});

/* ---- The account menu ------------------------------------------------------------------ */

const updateSettings = vi.fn();
const logout = vi.fn();

function Probe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function AccountHarness() {
  // The toolbar's avatar is the anchor the menu hangs from (IX-4's `data-ix-account-anchor`).
  const sheet = useGlassStore((s) => s.sheet);
  const accountPage = useSheetPages((s) => s.accountPage);
  return (
    <MemoryRouter>
      <button type="button" data-ix-account-anchor="" aria-label="Your account" onClick={openAccountMenu}>
        S
      </button>
      <AccountMenu open={sheet === 'account' && accountPage === null} />
      <Probe />
    </MemoryRouter>
  );
}

async function openAccount() {
  const user = userEvent.setup();
  render(<AccountHarness />);
  const face = screen.getByRole('button', { name: 'Your account' });
  face.focus();
  await user.click(face);
  const menu = await screen.findByRole('menu', { name: 'Account' });
  return { user, menu, face };
}

describe('AccountMenu (§6.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGlassStore.getState().reset();
    useSheetPages.getState().reset();
    useMenuHostStore.getState().reset();
    useUIStore.setState({ userSettingsOpen: false });
    updateSettings.mockResolvedValue(undefined);
    useAuthStore.setState({
      token: 'token',
      user: { id: 'me', username: 'sean', display_name: 'Sean', flags: 0 } as never,
      settings: { status: 'online', custom_status: null } as never,
      updateSettings,
      logout,
    } as never);
  });

  it('says who you are (name, @username) and what you are set to', async () => {
    const { menu } = await openAccount();
    expect(within(menu).getByText('Sean')).toBeInTheDocument();
    expect(within(menu).getByText('@sean')).toBeInTheDocument();
    expect(menu).toHaveClass('ix-menu');
  });

  it('checks the status in force, as a radio: Online, Idle, Do not disturb, Invisible', async () => {
    const { menu } = await openAccount();
    expect(within(menu).getByRole('menuitemradio', { name: 'Online' })).toHaveAttribute('aria-checked', 'true');
    expect(within(menu).getByRole('menuitemradio', { name: 'Idle' })).toHaveAttribute('aria-checked', 'false');
    expect(within(menu).getByRole('menuitemradio', { name: 'Do not disturb' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemradio', { name: 'Invisible' })).toBeInTheDocument();
  });

  it('puts focus on the status in force, so the arrow keys have somewhere to start', async () => {
    const { menu } = await openAccount();
    await waitFor(() => expect(within(menu).getByRole('menuitemradio', { name: 'Online' })).toHaveFocus());
  });

  it('changes your status, and closes', async () => {
    const { user, menu } = await openAccount();
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Do not disturb' }));
    expect(updateSettings).toHaveBeenCalledWith({ status: 'dnd', custom_status: null });
    expect(useGlassStore.getState().sheet).toBeNull();
  });

  it('sets a line of your own on Enter, keeping your status', async () => {
    const { user, menu } = await openAccount();
    await user.type(within(menu).getByRole('textbox', { name: 'Custom status' }), 'Back in ten{Enter}');
    expect(updateSettings).toHaveBeenCalledWith({ status: 'online', custom_status: 'Back in ten' });
    expect(useGlassStore.getState().sheet).toBeNull();
  });

  it('clears the line when it is set empty', async () => {
    useAuthStore.setState({ settings: { status: 'idle', custom_status: 'Lunch' } } as never);
    const { user, menu } = await openAccount();
    const field = within(menu).getByRole('textbox', { name: 'Custom status' });
    expect(field).toHaveValue('Lunch');
    await user.clear(field);
    await user.click(within(menu).getByRole('button', { name: 'Set custom status' }));
    expect(updateSettings).toHaveBeenCalledWith({ status: 'idle', custom_status: null });
  });

  it('lists its doors in the spec\'s order, with the shortcuts beside Settings and Keyboard shortcuts', async () => {
    const { menu } = await openAccount();
    const rows = within(menu).getAllByRole('menuitem').map((row) => row.textContent);
    expect(rows).toEqual([
      expect.stringContaining('Profile'),
      expect.stringContaining('Reminders'),
      expect.stringContaining('Settings'),
      expect.stringContaining('Keyboard shortcuts'),
      expect.stringContaining('Developer portal'),
      expect.stringContaining('Copy username'),
      expect.stringContaining('Sign out'),
    ]);
    expect(within(menu).getByRole('menuitem', { name: /^Settings/ })).toHaveTextContent(/Ctrl ,|⌘,/);
    expect(within(menu).getByRole('menuitem', { name: /^Keyboard shortcuts/ })).toHaveTextContent(/Ctrl \/|⌘\//);
  });

  it('opens settings from its row', async () => {
    const { user, menu } = await openAccount();
    await user.click(within(menu).getByRole('menuitem', { name: /^Settings/ }));
    expect(useUIStore.getState().userSettingsOpen).toBe(true);
    expect(useGlassStore.getState().sheet).toBeNull();
  });

  it('opens the profile section of settings from Profile', async () => {
    const { user, menu } = await openAccount();
    await user.click(within(menu).getByRole('menuitem', { name: 'Profile' }));
    expect(useUIStore.getState().userSettingsOpen).toBe(true);
    expect(useUIStore.getState().userSettingsInitialSection).toBe('account');
  });

  it('opens the Help dialog from Keyboard shortcuts', async () => {
    const { user, menu } = await openAccount();
    await user.click(within(menu).getByRole('menuitem', { name: /^Keyboard shortcuts/ }));
    expect(useMenuHostStore.getState().help).toBe(true);
  });

  it('opens reminders as a sheet of its own: the menu gives way to it', async () => {
    const { user, menu } = await openAccount();
    await user.click(within(menu).getByRole('menuitem', { name: 'Reminders' }));
    expect(useGlassStore.getState().sheet).toBe('account');
    expect(useSheetPages.getState().accountPage).toBe('reminders');
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Account' })).not.toBeInTheDocument());
  });

  it('goes to the developer portal', async () => {
    const { user, menu } = await openAccount();
    await user.click(within(menu).getByRole('menuitem', { name: 'Developer portal' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/app/developers');
  });

  it('offers the admin dashboard to an instance admin, and to no one else', async () => {
    const first = await openAccount();
    expect(within(first.menu).queryByRole('menuitem', { name: 'Admin dashboard' })).not.toBeInTheDocument();
  });

  it('offers the admin dashboard to an admin', async () => {
    useAuthStore.setState({ user: { id: 'me', username: 'sean', display_name: 'Sean', flags: 1 } } as never);
    const { user, menu } = await openAccount();
    await user.click(within(menu).getByRole('menuitem', { name: 'Admin dashboard' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/app/admin');
  });

  it('signs you out', async () => {
    const { user, menu } = await openAccount();
    await user.click(within(menu).getByRole('menuitem', { name: 'Sign out' }));
    expect(logout).toHaveBeenCalledTimes(1);
    expect(useGlassStore.getState().sheet).toBeNull();
  });

  it('closes on Escape and gives focus back to the toolbar avatar', async () => {
    const { user, face } = await openAccount();
    await user.keyboard('{Escape}');
    expect(useGlassStore.getState().sheet).toBeNull();
    await waitFor(() => expect(face).toHaveFocus());
  });

  it('is anchored to the toolbar avatar: its right edge is the avatar\'s', async () => {
    const face = (() => {
      render(<AccountHarness />);
      return screen.getByRole('button', { name: 'Your account' });
    })();
    // jsdom has no layout: give the avatar a rect and read where the menu was placed.
    face.getBoundingClientRect = () => ({ x: 1200, y: 12, width: 32, height: 32, left: 1200, top: 12, right: 1232, bottom: 44, toJSON: () => ({}) });
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(280);
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(400);
    try {
      act(() => openAccountMenu());
      const menu = await screen.findByRole('menu', { name: 'Account' });
      await waitFor(() => expect(menu.style.visibility).toBe('visible'));
      // right edge 1232 -> left 952; just under the avatar (bottom 44 + 6).
      expect(menu.style.left).toBe('952px');
      expect(menu.style.top).toBe('50px');
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });
});

/* ---- The host store and the compat hook ------------------------------------------------ */

describe('opening the server menu', () => {
  beforeEach(() => useMenuHostStore.getState().reset());

  const scope = { serverId: '__local__', userId: 'me' };
  const ref = { guildId: 'g1', scope, name: 'Fuel' };

  function Opener() {
    const menu = useServerMenu();
    const anchor = { current: document.body } as { current: HTMLElement };
    return (
      <>
        <button type="button" onClick={() => menu.openFromElement(ref, anchor)}>
          toggle
        </button>
        <button type="button" onClick={() => menu.openAtPoint(ref, { x: 5, y: 6 })}>
          point
        </button>
        <output data-testid="open">{String(menu.isOpenFor('g1'))}</output>
      </>
    );
  }

  it('opens under an element, and a second press from the same element closes it', () => {
    render(<Opener />);
    fireEvent.click(screen.getByText('toggle'));
    expect(useMenuHostStore.getState().menu).toMatchObject({ kind: 'server', server: { guildId: 'g1' } });
    expect(screen.getByTestId('open')).toHaveTextContent('true');
    fireEvent.click(screen.getByText('toggle'));
    expect(useMenuHostStore.getState().menu).toBeNull();
  });

  it('opens at the pointer for a right click', () => {
    render(<Opener />);
    fireEvent.click(screen.getByText('point'));
    expect(useMenuHostStore.getState().menu).toMatchObject({ kind: 'server', anchor: { x: 5, y: 6 } });
    act(() => closeMenu());
    expect(useMenuHostStore.getState().menu).toBeNull();
  });
});
