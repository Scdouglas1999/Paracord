import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { entityScopeKey } from '../../../lib/serverScope';
import { useChannelStore } from '../../../stores/channelStore';
import { useGlassStore } from '../../../stores/glassStore';
import { useUIStore } from '../../../stores/uiStore';
import { useSheetPages } from '../../glass/sheets/sheetStore';
import {
  openChannelMenu,
  openCreateChannel,
  openHelp,
  openInvite,
  openPeopleMenu,
  openProfileCard,
  openServerMenu,
  useMenuHostStore,
} from './hostStore';
import { MenuHost } from './MenuHost';

/**
 * The menu host: what opens over the frame and is not a sheet (docs/index-spec.md
 * §6.2-6.6, §6.9). Callers (IX-5's header, IX-6's dock, IX-14's People header,
 * IX-15's title) open these through `hostStore`'s functions and never render a
 * menu of their own.
 */

const access = vi.hoisted(() => ({
  value: { permissions: 0n, isOwner: false, isAdmin: false, ready: true },
}));
vi.mock('./useGuildPermissions', () => ({ useGuildAccess: () => access.value }));
vi.mock('../../../hooks/useMutedGuilds', () => ({
  useMutedGuilds: () => ({ mutedGuildKeys: [], toggleMute: vi.fn(), saving: {} }),
}));
vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: () => ({ permissions: access.value.permissions, isAdmin: access.value.isAdmin, isOwner: access.value.isOwner }),
}));
vi.mock('../../../lib/guildNavigation', () => ({ activateGuild: vi.fn() }));
vi.mock('../../../lib/channelNavigation', () => ({ activateChannel: vi.fn() }));
vi.mock('../../user/UserProfile', () => ({
  UserProfilePopup: ({ user }: { user: { username: string } | null }) =>
    user ? <div role="dialog" aria-label={`Profile of ${user.username}`} /> : null,
}));
vi.mock('../../message/DmPickerModal', () => ({
  DmPickerModal: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="DM picker" /> : null),
}));
vi.mock('../../guild/InviteModal', () => ({
  InviteModal: ({ guildName }: { guildName: string }) => <div role="dialog" aria-label={`Invite to ${guildName}`} />,
}));
vi.mock('../../../hooks/useDownloadTicket', () => ({ useDownloadTicket: () => null }));

const SCOPE = { serverId: '__local__', userId: 'me' };
const FUEL = { guildId: 'g1', scope: SCOPE, name: 'Fuel' };

function Probe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderHost() {
  return render(
    <MemoryRouter initialEntries={['/app/guilds/g1/channels/c1']}>
      <MenuHost />
      <Probe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  access.value = { permissions: 0n, isOwner: false, isAdmin: false, ready: true };
  useMenuHostStore.getState().reset();
  useGlassStore.getState().reset();
  useSheetPages.getState().reset();
  useUIStore.setState({ userSettingsOpen: false, guildSettingsId: null } as never);
  useChannelStore.setState({
    channelsByGuild: {
      [entityScopeKey(SCOPE, 'g1')]: [{ id: 'c1', name: 'general', type: 0, channel_type: 0, guild_id: 'g1', position: 0, scope: SCOPE }],
    },
  } as never);
});

describe('the server menu in the host', () => {
  it('opens from the opener function with the rows for what the account may do', async () => {
    renderHost();
    act(() => openServerMenu(FUEL, { x: 20, y: 20 }));
    const menu = await screen.findByRole('menu', { name: 'Fuel menu' });
    expect(within(menu).getAllByRole('menuitem').map((row) => row.textContent)).toEqual([
      'Overview',
      'Events',
      'Notifications',
      'Mark as read',
      'Mute server',
      'Copy link',
      'Leave server',
    ]);
  });

  it('gives an owner the management rows and no Leave', async () => {
    access.value = { permissions: BigInt('0x7FFFFFFFFFFFFFFF'), isOwner: true, isAdmin: true, ready: true };
    renderHost();
    act(() => openServerMenu(FUEL, { x: 20, y: 20 }));
    const menu = await screen.findByRole('menu', { name: 'Fuel menu' });
    for (const name of ['Invite people', 'Create channel', 'Create voice channel', 'Server settings']) {
      expect(within(menu).getByRole('menuitem', { name })).toBeInTheDocument();
    }
    expect(within(menu).queryByRole('menuitem', { name: 'Leave server' })).not.toBeInTheDocument();
  });

  it('goes to the Overview and to the Events page', async () => {
    const user = userEvent.setup();
    renderHost();
    act(() => openServerMenu(FUEL, { x: 20, y: 20 }));
    await user.click(await screen.findByRole('menuitem', { name: 'Overview' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/app/guilds/g1');
    act(() => openServerMenu(FUEL, { x: 20, y: 20 }));
    await user.click(await screen.findByRole('menuitem', { name: 'Events' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/app/guilds/g1/events');
  });

  it('opens server settings for the server it was opened on', async () => {
    access.value = { permissions: 0n, isOwner: true, isAdmin: true, ready: true };
    const user = userEvent.setup();
    renderHost();
    act(() => openServerMenu(FUEL, { x: 20, y: 20 }));
    await user.click(await screen.findByRole('menuitem', { name: 'Server settings' }));
    expect(useUIStore.getState().guildSettingsId).toBe('g1');
  });

  it('opens the invite dialog through the first text channel', async () => {
    access.value = { permissions: 1n, isOwner: false, isAdmin: false, ready: true };
    const user = userEvent.setup();
    renderHost();
    act(() => openServerMenu(FUEL, { x: 20, y: 20 }));
    await user.click(await screen.findByRole('menuitem', { name: 'Invite people' }));
    expect(await screen.findByRole('dialog', { name: 'Invite to Fuel' })).toBeInTheDocument();
  });

  it('is replaced, not stacked, by the next menu', async () => {
    renderHost();
    act(() => openServerMenu(FUEL, { x: 20, y: 20 }));
    await screen.findByRole('menu', { name: 'Fuel menu' });
    act(() => openPeopleMenu({ x: 20, y: 20 }));
    await screen.findByRole('menu', { name: 'People menu' });
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Fuel menu' })).not.toBeInTheDocument());
  });

  it('puts the account menu away when another menu opens', async () => {
    renderHost();
    act(() => useGlassStore.getState().openSheet('account'));
    await screen.findByRole('menu', { name: 'Account' });
    act(() => openServerMenu(FUEL, { x: 20, y: 20 }));
    expect(useGlassStore.getState().sheet).toBeNull();
    await screen.findByRole('menu', { name: 'Fuel menu' });
  });
});

describe('the channel and People menus in the host', () => {
  it('opens the channel menu, and a page row opens the channel sheet on that page', async () => {
    const user = userEvent.setup();
    renderHost();
    act(() =>
      openChannelMenu(
        { subject: { kind: 'channel', guildId: 'g1', channelId: 'c1', channelName: 'general' }, summary: { allowed: true, reason: null } },
        { x: 40, y: 40 },
      ),
    );
    const menu = await screen.findByRole('menu', { name: 'Channel actions' });
    expect(within(menu).queryByRole('menuitem', { name: /Inbox/ })).not.toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: 'Media' }));
    expect(useGlassStore.getState().sheet).toBe('channel');
    expect(useSheetPages.getState().channelPage).toBe('media');
  });

  it('opens the People menu, and New message opens the picker', async () => {
    const user = userEvent.setup();
    renderHost();
    act(() => openPeopleMenu({ x: 40, y: 40 }));
    await user.click(await screen.findByRole('menuitem', { name: 'New message' }));
    expect(await screen.findByRole('dialog', { name: 'DM picker' })).toBeInTheDocument();
  });

  it('sends Add friend to the Friends page', async () => {
    const user = userEvent.setup();
    renderHost();
    act(() => openPeopleMenu({ x: 40, y: 40 }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add friend' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/app/friends');
  });
});

describe('Help, the profile card and the small dialogs', () => {
  it('opens Help with Ctrl /, and closes it with the same keys', async () => {
    const user = userEvent.setup();
    renderHost();
    await user.keyboard('{Control>}/{/Control}');
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    await user.keyboard('{Control>}/{/Control}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument());
  });

  it('opens Help from its opener function, and Done closes it', async () => {
    const user = userEvent.setup();
    renderHost();
    act(() => openHelp());
    const help = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    for (const group of ['Navigation', 'Settings', 'Messaging', 'Calls', 'General']) {
      expect(within(help).getByRole('region', { name: group })).toBeInTheDocument();
    }
    await user.click(within(help).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument());
  });

  it('opens the profile card for a person at a point', () => {
    renderHost();
    act(() => openProfileCard({ id: 'u2', username: 'vincent' }, { x: 100, y: 100 }));
    expect(screen.getByRole('dialog', { name: 'Profile of vincent' })).toBeInTheDocument();
  });

  it('opens the invite dialog from its opener function', () => {
    renderHost();
    act(() => openInvite({ guildName: 'Fuel', channelId: 'c1' }));
    expect(screen.getByRole('dialog', { name: 'Invite to Fuel' })).toBeInTheDocument();
  });
});

describe('Create channel / Create voice channel', () => {
  it('creates a text channel with a name, then opens it', async () => {
    const createChannel = vi.fn().mockResolvedValue({ id: 'c9', name: 'plans', scope: SCOPE });
    useChannelStore.setState({ createChannel } as never);
    const user = userEvent.setup();
    renderHost();
    act(() => openCreateChannel({ guildId: 'g1', scope: SCOPE, kind: 'text' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create channel' });
    expect(within(dialog).getByRole('button', { name: 'Create' })).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'plans');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(createChannel).toHaveBeenCalledWith('g1', { name: 'plans', channel_type: 0, parent_id: null }, SCOPE),
    );
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/app/guilds/g1/channels/c9'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create channel' })).not.toBeInTheDocument());
  });

  it('creates a room as a voice channel and does not navigate (joining never navigates)', async () => {
    const createChannel = vi.fn().mockResolvedValue({ id: 'v9', name: 'Late night', scope: SCOPE });
    useChannelStore.setState({ createChannel } as never);
    const user = userEvent.setup();
    renderHost();
    act(() => openCreateChannel({ guildId: 'g1', scope: SCOPE, kind: 'room' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create voice channel' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Late night{Enter}');
    await waitFor(() =>
      expect(createChannel).toHaveBeenCalledWith('g1', { name: 'Late night', channel_type: 2, parent_id: null }, SCOPE),
    );
    expect(screen.getByTestId('location')).toHaveTextContent('/app/guilds/g1/channels/c1');
  });

  it('offers the server\'s categories and sends the one chosen', async () => {
    useChannelStore.setState({
      channelsByGuild: {
        [entityScopeKey(SCOPE, 'g1')]: [{ id: 'cat1', name: 'Games', type: 4, channel_type: 4, guild_id: 'g1', position: 0, scope: SCOPE }],
      },
      createChannel: vi.fn().mockResolvedValue({ id: 'c8', scope: SCOPE }),
    } as never);
    const user = userEvent.setup();
    renderHost();
    act(() => openCreateChannel({ guildId: 'g1', scope: SCOPE, kind: 'text', parentId: 'cat1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create channel' });
    expect(within(dialog).getByRole('combobox', { name: 'Category' })).toHaveValue('cat1');
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'ranked{Enter}');
    await waitFor(() =>
      expect(useChannelStore.getState().createChannel).toHaveBeenCalledWith('g1', expect.objectContaining({ parent_id: 'cat1' }), SCOPE),
    );
  });

  it('says why it failed, in an alert, and stays open', async () => {
    useChannelStore.setState({ createChannel: vi.fn().mockRejectedValue(new Error('Nope')) } as never);
    const user = userEvent.setup();
    renderHost();
    act(() => openCreateChannel({ guildId: 'g1', scope: SCOPE, kind: 'text' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create channel' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'plans{Enter}');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not create the channel');
    expect(screen.getByRole('dialog', { name: 'Create channel' })).toBeInTheDocument();
  });
});
