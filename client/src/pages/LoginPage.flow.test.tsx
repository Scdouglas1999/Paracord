import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi } from '../api/auth';
import { hasAccount } from '../lib/account';
import { setAccessToken, setRefreshToken } from '../lib/authToken';
import { useAccountStore } from '../stores/accountStore';
import { LoginPage } from './LoginPage';

const legacyAttachment = vi.hoisted(() => vi.fn());

const mockGetSetupStatus = vi.hoisted(() => vi.fn());

vi.mock('../api/auth', () => ({
  authApi: {
    options: vi.fn(),
    login: vi.fn(),
    forgotPassword: vi.fn(),
    resetPassword: vi.fn(),
    mfaLogin: vi.fn(),
    attachPublicKey: legacyAttachment,
    getMe: vi.fn(),
  },
}));

vi.mock('../lib/config/apiBaseUrl', () => ({
  API_BASE_URL: '/api/v1',
  SERVER_URL_KEY: 'server-url',
  clearStoredServerUrl: vi.fn(),
  getCurrentOriginServerUrl: vi.fn(() => null),
  getStoredServerUrl: vi.fn(() => null),
  resolveApiBaseUrl: vi.fn(() => '/api/v1'),
  resolveResourceUrl: vi.fn((path: string) => path),
  resolveV2ApiUrl: vi.fn((path: string) => `/api/v2${path}`),
  setStoredServerUrl: vi.fn(),
}));

vi.mock('../lib/account', () => ({
  hasAccount: vi.fn(() => false),
}));

vi.mock('../stores/accountStore', () => ({
  useAccountStore: {
    getState: vi.fn(() => ({ isUnlocked: false, publicKey: null })),
  },
}));

vi.mock('../lib/authToken', () => ({
  setAccessToken: vi.fn(),
  setRefreshToken: vi.fn(),
}));

vi.mock('../api/instance', () => ({
  instanceApi: {
    getSetupStatus: mockGetSetupStatus,
  },
}));

function renderLoginPage() {
  render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/app" element={<div>App shell</div>} />
        <Route path="/setup-server" element={<div>Set up your Paracord server</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LoginPage password reset and MFA flows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSetupStatus.mockResolvedValue({ data: { setup_required: false } });
    vi.mocked(authApi.options).mockResolvedValue({
      data: { allow_username_login: true, require_email: false },
    } as never);
    vi.mocked(authApi.login).mockReset();
    vi.mocked(authApi.forgotPassword).mockReset();
    vi.mocked(authApi.resetPassword).mockReset();
    vi.mocked(authApi.mfaLogin).mockReset();
    legacyAttachment.mockReset();
    vi.mocked(authApi.getMe).mockResolvedValue({
      data: {
        id: 'user-1',
        username: 'resetuser',
        discriminator: 1,
        flags: 0,
        bot: false,
        system: false,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    } as never);
    vi.mocked(hasAccount).mockReturnValue(false);
    vi.mocked(useAccountStore.getState).mockReturnValue({ isUnlocked: false, publicKey: null } as never);
  });

  it('requests a reset token and submits a matching new password', async () => {
    const user = userEvent.setup();
    vi.mocked(authApi.forgotPassword).mockResolvedValue({
      data: { message: 'If the account exists, a password reset email has been sent.' },
    } as never);
    vi.mocked(authApi.resetPassword).mockResolvedValue({
      data: { message: 'Password updated successfully.' },
    } as never);

    renderLoginPage();

    await user.click(screen.getByRole('button', { name: 'Forgot your password?' }));
    await user.type(screen.getByLabelText(/Email or Username/), 'reset@example.com');
    await user.click(screen.getByRole('button', { name: 'Request Reset Token' }));

    await waitFor(() => expect(authApi.forgotPassword).toHaveBeenCalledWith('reset@example.com'));
    expect(await screen.findByRole('heading', { name: 'Set New Password' })).toBeInTheDocument();
    expect(screen.getByText(/reset token has been generated/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Reset Token/), 'reset-token');
    await user.type(screen.getByLabelText(/^New Password/), 'NewPassword123!');
    await user.type(screen.getByLabelText(/Confirm Password/), 'NewPassword123!');
    await user.click(screen.getByRole('button', { name: 'Set New Password' }));

    await waitFor(() =>
      expect(authApi.resetPassword).toHaveBeenCalledWith('reset-token', 'NewPassword123!'),
    );
    expect(screen.getByText(/Password updated successfully/i)).toBeInTheDocument();
  });

  it('blocks reset submission when password confirmation does not match', async () => {
    const user = userEvent.setup();
    renderLoginPage();

    await user.click(screen.getByRole('button', { name: 'Forgot your password?' }));
    await user.click(screen.getByRole('button', { name: 'Enter token' }));
    await user.type(screen.getByLabelText(/Reset Token/), 'reset-token');
    await user.type(screen.getByLabelText(/^New Password/), 'NewPassword123!');
    await user.type(screen.getByLabelText(/Confirm Password/), 'DifferentPass123!');
    await user.click(screen.getByRole('button', { name: 'Set New Password' }));

    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
    expect(authApi.resetPassword).not.toHaveBeenCalled();
  });

  it('switches to MFA challenge and submits the one-time code', async () => {
    const user = userEvent.setup();
    vi.mocked(authApi.login).mockResolvedValue({
      data: {
        token: '',
        user: { mfa_required: true, mfa_ticket: 'ticket-1' },
      },
    } as never);
    vi.mocked(authApi.mfaLogin).mockResolvedValue({
      data: {
        token: 'access-token',
        refresh_token: 'refresh-token',
        user: {
          id: 'user-1',
          username: 'resetuser',
          discriminator: 1,
          flags: 0,
          bot: false,
          system: false,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      },
    } as never);

    renderLoginPage();

    await user.type(screen.getByLabelText(/Email or Username/), 'reset@example.com');
    await user.type(screen.getByLabelText(/^Password/), 'OriginalPass123!');
    await user.click(screen.getByRole('button', { name: 'Log In' }));

    expect(await screen.findByRole('heading', { name: 'Two-Factor Authentication' })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Authentication Code/), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(authApi.mfaLogin).toHaveBeenCalledWith('ticket-1', '123456'));
    expect(await screen.findByText('App shell')).toBeInTheDocument();
  });

  it('keeps the login session and does not enroll an unlocked identity implicitly', async () => {
    const user = userEvent.setup();
    vi.mocked(hasAccount).mockReturnValue(true);
    vi.mocked(useAccountStore.getState).mockReturnValue({
      isUnlocked: true,
      publicKey: 'a'.repeat(64),
    } as never);
    vi.mocked(authApi.login).mockResolvedValue({
      data: {
        token: 'initial-access-token',
        refresh_token: 'initial-refresh-token',
        user: {
          id: 'user-1',
          username: 'adminuser',
          discriminator: 1,
          flags: 1,
          bot: false,
          system: false,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      },
    } as never);
    renderLoginPage();

    await user.type(screen.getByLabelText(/Email or Username/), 'admin@example.com');
    await user.type(screen.getByLabelText(/^Password/), 'OriginalPass123!');
    await user.click(screen.getByRole('button', { name: 'Log In' }));

    expect(await screen.findByText('App shell')).toBeInTheDocument();
    expect(legacyAttachment).not.toHaveBeenCalled();
    expect(setAccessToken).toHaveBeenLastCalledWith('initial-access-token');
    expect(setRefreshToken).toHaveBeenLastCalledWith('initial-refresh-token');
  });
  it('clears the previous refresh-token copy when the login response uses cookies only', async () => {
    vi.mocked(authApi.login).mockResolvedValue({ data: {
      token: 'cookie-session-access', user: { id: 'user-1', username: 'resetuser' },
    } } as never);
    renderLoginPage();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Email or Username/), 'resetuser');
    await user.type(screen.getByLabelText(/^Password/), 'OriginalPass123!');
    await user.click(screen.getByRole('button', { name: 'Log In' }));
    expect(await screen.findByText('App shell')).toBeInTheDocument();
    expect(setRefreshToken).toHaveBeenLastCalledWith(null);
  });

});

describe('LoginPage on a server that has no owner yet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authApi.options).mockResolvedValue({
      data: { allow_username_login: true, require_email: false },
    } as never);
  });

  it('redirects to the claim flow instead of showing a sign-in form nobody can use', async () => {
    mockGetSetupStatus.mockResolvedValue({ data: { setup_required: true } });

    renderLoginPage();

    expect(await screen.findByText('Set up your Paracord server')).toBeInTheDocument();
  });

  it('stays on sign-in when the setup check fails, rather than guessing', async () => {
    mockGetSetupStatus.mockRejectedValue(new Error('offline'));

    renderLoginPage();

    await waitFor(() => expect(mockGetSetupStatus).toHaveBeenCalled());
    expect(screen.queryByText('Set up your Paracord server')).not.toBeInTheDocument();
  });
});
