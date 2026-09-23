import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getRouterAccess: vi.fn(),
  updateRouterAccess: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../api/admin', () => ({
  adminApi: {
    getSettings: mocks.getSettings,
    updateSettings: mocks.updateSettings,
    getRouterAccess: mocks.getRouterAccess,
    updateRouterAccess: mocks.updateRouterAccess,
  },
}));
vi.mock('../../api/client', () => ({
  extractApiError: (error: { response?: { data?: { message?: string } } } & Error) =>
    error.response?.data?.message ?? error.message,
}));
vi.mock('../../stores/toastStore', () => ({ toast: { success: mocks.success, error: mocks.error } }));

const SETTINGS = {
  registration_enabled: 'true',
  registration_mode: 'invite_only',
  server_name: 'Riverside',
  server_description: '',
  max_guilds_per_user: '100',
  max_members_per_guild: '1000',
};

const HOME_ONLY = { running: false, saved: false, restart_required: false, loopback_bind: false };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ data: SETTINGS });
  mocks.updateSettings.mockImplementation(async (data: Record<string, string>) => ({ data }));
  mocks.getRouterAccess.mockResolvedValue({ data: HOME_ONLY });
});

describe('who can create an account', () => {
  it('shows the saved choice and saves a change', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    const inviteOnly = await screen.findByRole('radio', { name: /People with an invite link/ });
    await waitFor(() => expect(inviteOnly).toHaveAttribute('aria-checked', 'true'));

    await user.click(screen.getByRole('radio', { name: /Anyone who can reach this server/ }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mocks.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ registration_mode: 'open' }),
      ),
    );
    // The router switch was not touched, so it is not re-saved.
    expect(mocks.updateRouterAccess).not.toHaveBeenCalled();
  });
});

describe('network', () => {
  it('says how the server is reachable now, and that a change needs a restart', async () => {
    const user = userEvent.setup();
    mocks.updateRouterAccess.mockResolvedValue({
      data: { running: false, saved: true, restart_required: true, loopback_bind: false },
    });
    render(<SettingsPanel />);

    expect(await screen.findByText('Only reachable on your home network')).toBeInTheDocument();
    await user.click(
      screen.getByRole('switch', { name: 'Let friends outside your home network connect' }),
    );
    expect(screen.getByText(/Takes effect after you save and restart the server/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mocks.updateRouterAccess).toHaveBeenCalledWith(true));
    expect(await screen.findByText('Saved. Restart the server for this to take effect.')).toBeInTheDocument();
  });

  it('cannot be changed when an environment variable decides it, and says where', async () => {
    mocks.getRouterAccess.mockResolvedValue({
      data: { ...HOME_ONLY, locked_by: 'PARACORD_AUTO_PORT_FORWARD' },
    });
    render(<SettingsPanel />);

    expect(await screen.findByText('PARACORD_AUTO_PORT_FORWARD')).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Let friends outside your home network connect' }),
    ).toBeDisabled();
  });

  it('keeps the reason next to the switch when the server could not save it', async () => {
    const user = userEvent.setup();
    mocks.updateRouterAccess.mockRejectedValue(
      Object.assign(new Error('409'), {
        response: { data: { message: 'Paracord couldn’t save this to its config file.' } },
      }),
    );
    render(<SettingsPanel />);

    await user.click(
      await screen.findByRole('switch', { name: 'Let friends outside your home network connect' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Paracord couldn’t save this to its config file.',
    );
  });
});
