import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../../stores/authStore';
import { useGlassStore } from '../../../stores/glassStore';
import { useUIStore } from '../../../stores/uiStore';
import { AccountMenu } from './AccountMenu';
import { useSheetPages } from './sheetStore';

/**
 * The account menu: your face's popover. Status, a line of your own, Reminders,
 * Settings, the doors that depend on who you are, and Sign out.
 */

vi.mock('../../../lib/presenceActivities', () => ({ publishPresence: vi.fn() }));
vi.mock('../../../lib/clipboard', () => ({ writeClipboardText: vi.fn().mockResolvedValue(undefined) }));

const updateSettings = vi.fn();
const logout = vi.fn();

function Probe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function Harness() {
  // The header's face is the anchor the menu opens under.
  const sheet = useGlassStore((s) => s.sheet);
  const accountPage = useSheetPages((s) => s.accountPage);
  const open = sheet === 'account' && accountPage === null;
  return (
    <MemoryRouter>
      <button type="button" className="glass-header__avatar" onClick={() => useGlassStore.getState().openSheet('account')}>
        Your profile, online
      </button>
      <AccountMenu open={open} />
      <Probe />
    </MemoryRouter>
  );
}

async function openMenu() {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Your profile, online' }));
  const menu = await screen.findByRole('menu', { name: 'Account' });
  return { user, menu };
}

beforeEach(() => {
  vi.clearAllMocks();
  useGlassStore.getState().reset();
  useSheetPages.getState().reset();
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

describe('AccountMenu', () => {
  it('is a menu named Account, that says who you are and what you are set to', async () => {
    const { menu } = await openMenu();
    expect(within(menu).getByText('Sean')).toBeInTheDocument();
    expect(within(menu).getAllByText('Online').length).toBeGreaterThan(1);
  });

  it('checks the status in force, as a radio', async () => {
    const { menu } = await openMenu();
    expect(within(menu).getByRole('menuitemradio', { name: 'Online' })).toHaveAttribute('aria-checked', 'true');
    expect(within(menu).getByRole('menuitemradio', { name: 'Away' })).toHaveAttribute('aria-checked', 'false');
    expect(within(menu).getByRole('menuitemradio', { name: 'Do not disturb' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemradio', { name: 'Invisible' })).toBeInTheDocument();
  });

  it('puts focus on the status in force, so the arrow keys have somewhere to start', async () => {
    const { menu } = await openMenu();
    await waitFor(() => expect(within(menu).getByRole('menuitemradio', { name: 'Online' })).toHaveFocus());
  });

  it('changes your status, and closes', async () => {
    const { user, menu } = await openMenu();
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Do not disturb' }));
    expect(updateSettings).toHaveBeenCalledWith({ status: 'dnd', custom_status: null });
    expect(useGlassStore.getState().sheet).toBeNull();
  });

  it('sets a line of your own on Enter, keeping your status', async () => {
    const { user, menu } = await openMenu();
    await user.type(within(menu).getByRole('textbox', { name: 'Custom status' }), 'Back in ten{Enter}');
    expect(updateSettings).toHaveBeenCalledWith({ status: 'online', custom_status: 'Back in ten' });
    expect(useGlassStore.getState().sheet).toBeNull();
  });

  it('clears the line when it is set empty', async () => {
    useAuthStore.setState({ settings: { status: 'idle', custom_status: 'Lunch' } } as never);
    const { user, menu } = await openMenu();
    const field = within(menu).getByRole('textbox', { name: 'Custom status' });
    expect(field).toHaveValue('Lunch');
    await user.clear(field);
    await user.click(within(menu).getByRole('button', { name: 'Set custom status' }));
    expect(updateSettings).toHaveBeenCalledWith({ status: 'idle', custom_status: null });
  });

  it('opens settings from its row', async () => {
    const { user, menu } = await openMenu();
    await user.click(within(menu).getByRole('menuitem', { name: 'Settings' }));
    expect(useUIStore.getState().userSettingsOpen).toBe(true);
    expect(useGlassStore.getState().sheet).toBeNull();
  });

  it('opens reminders as a sheet of its own: the menu gives way to it', async () => {
    const { user, menu } = await openMenu();
    await user.click(within(menu).getByRole('menuitem', { name: 'Reminders' }));
    expect(useGlassStore.getState().sheet).toBe('account');
    expect(useSheetPages.getState().accountPage).toBe('reminders');
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Account' })).not.toBeInTheDocument());
  });

  it('goes to the developer portal', async () => {
    const { user, menu } = await openMenu();
    await user.click(within(menu).getByRole('menuitem', { name: 'Developer portal' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/app/developers');
  });

  it('offers the admin dashboard to an admin, and to no one else', async () => {
    const first = await openMenu();
    expect(within(first.menu).queryByRole('menuitem', { name: 'Admin dashboard' })).not.toBeInTheDocument();
  });

  it('offers the admin dashboard to an admin', async () => {
    useAuthStore.setState({ user: { id: 'me', username: 'sean', display_name: 'Sean', flags: 1 } } as never);
    const { user, menu } = await openMenu();
    await user.click(within(menu).getByRole('menuitem', { name: 'Admin dashboard' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/app/admin');
  });

  it('signs you out', async () => {
    const { user, menu } = await openMenu();
    await user.click(within(menu).getByRole('menuitem', { name: 'Sign out' }));
    expect(logout).toHaveBeenCalledTimes(1);
    expect(useGlassStore.getState().sheet).toBeNull();
  });

  it('walks its rows with the arrow keys, and Escape closes it and gives focus back to your face', async () => {
    const { user, menu } = await openMenu();
    const face = screen.getByRole('button', { name: 'Your profile, online' });
    await waitFor(() => expect(within(menu).getByRole('menuitemradio', { name: 'Online' })).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('menuitemradio', { name: 'Away' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('menuitemradio', { name: 'Online' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(useGlassStore.getState().sheet).toBeNull();
    await waitFor(() => expect(face).toHaveFocus());
  });
});
