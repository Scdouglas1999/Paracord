import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi } from '../api/auth';
import { RegisterPage } from './RegisterPage';

const mockAuthState = vi.hoisted(() => ({
  token: 'access-token' as string | null,
  register: vi.fn(),
}));

const mockAccountState = vi.hoisted(() => ({
  isUnlocked: false,
  publicKey: null as string | null,
}));

const mockServerListState = vi.hoisted(() => ({
  getServerByUrl: vi.fn(),
  addServer: vi.fn(),
  updateToken: vi.fn(),
  updateRefreshToken: vi.fn(),
}));

const mockApiBaseUrl = vi.hoisted(() => ({
  getStoredServerUrl: vi.fn(() => 'https://chat.example.test'),
  getCurrentOriginServerUrl: vi.fn(() => null),
  setStoredServerUrl: vi.fn(),
}));

const mockHasAccount = vi.hoisted(() => vi.fn(() => false));

vi.mock('../api/auth', () => ({
  authApi: {
    options: vi.fn(),
    attachPublicKey: vi.fn(),
  },
}));

vi.mock('../api/client', () => ({
  extractApiError: (err: unknown) => (err instanceof Error ? err.message : 'Registration failed'),
}));

vi.mock('../stores/authStore', () => {
  const useAuthStore = Object.assign(
    (selector: (state: typeof mockAuthState) => unknown) => selector(mockAuthState),
    {
      getState: vi.fn(() => mockAuthState),
    },
  );
  return { useAuthStore };
});

vi.mock('../stores/accountStore', () => ({
  useAccountStore: {
    getState: vi.fn(() => mockAccountState),
  },
}));

vi.mock('../stores/serverListStore', () => ({
  useServerListStore: {
    getState: vi.fn(() => mockServerListState),
  },
}));

vi.mock('../lib/config/apiBaseUrl', () => mockApiBaseUrl);

vi.mock('../lib/account', () => ({
  hasAccount: mockHasAccount,
}));

function renderRegisterPage() {
  render(
    <MemoryRouter initialEntries={['/register']}>
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/app" element={<div>App shell</div>} />
        <Route path="/login" element={<div>Login page</div>} />
        <Route path="/terms" element={<div>Terms</div>} />
        <Route path="/privacy" element={<div>Privacy</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RegisterPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthState.token = 'access-token';
    mockAuthState.register.mockResolvedValue(undefined);
    mockAccountState.isUnlocked = false;
    mockAccountState.publicKey = null;
    mockServerListState.getServerByUrl.mockReturnValue(null);
    mockApiBaseUrl.getStoredServerUrl.mockReturnValue('https://chat.example.test');
    mockApiBaseUrl.getCurrentOriginServerUrl.mockReturnValue(null);
    mockHasAccount.mockReturnValue(false);
    vi.mocked(authApi.options).mockResolvedValue({
      data: { allow_username_login: true, require_email: false },
    } as never);
    vi.mocked(authApi.attachPublicKey).mockResolvedValue({ data: {} } as never);
  });

  it('blocks registration when password confirmation does not match', async () => {
    const user = userEvent.setup();

    renderRegisterPage();

    await user.type(screen.getByLabelText(/Username/), 'ada');
    await user.type(screen.getByLabelText(/^Password/), 'ValidPass123');
    await user.type(screen.getByLabelText(/Confirm Password/), 'DifferentPass123');
    await user.click(screen.getByLabelText(/I have read and agree/));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
    expect(mockAuthState.register).not.toHaveBeenCalled();
  });

  it('trims account fields, stores the connected server, and opens the app', async () => {
    const user = userEvent.setup();

    renderRegisterPage();

    await user.type(screen.getByLabelText(/Email/), 'ada@example.test');
    await user.type(screen.getByLabelText(/Display Name/), '  Ada Lovelace  ');
    await user.type(screen.getByLabelText(/Username/), '  ada  ');
    await user.type(screen.getByLabelText(/^Password/), 'ValidPass123');
    await user.type(screen.getByLabelText(/Confirm Password/), 'ValidPass123');
    await user.click(screen.getByLabelText(/I have read and agree/));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(mockAuthState.register).toHaveBeenCalledWith(
        'ada@example.test',
        'ada',
        'ValidPass123',
        'Ada Lovelace',
      );
    });
    expect(mockApiBaseUrl.setStoredServerUrl).toHaveBeenCalledWith('https://chat.example.test');
    expect(mockServerListState.addServer).toHaveBeenCalledWith(
      'https://chat.example.test',
      'chat.example.test',
      'access-token',
    );
    expect(await screen.findByText('App shell')).toBeInTheDocument();
  });

  it('attaches an unlocked local public key after registration', async () => {
    const user = userEvent.setup();
    mockHasAccount.mockReturnValue(true);
    mockAccountState.isUnlocked = true;
    mockAccountState.publicKey = 'public-key-1';

    renderRegisterPage();

    await user.type(screen.getByLabelText(/Username/), 'ada');
    await user.type(screen.getByLabelText(/^Password/), 'ValidPass123');
    await user.type(screen.getByLabelText(/Confirm Password/), 'ValidPass123');
    await user.click(screen.getByLabelText(/I have read and agree/));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      // The password must travel with the key: the server re-authenticates
      // before accepting a standalone credential that outlives a password change.
      expect(authApi.attachPublicKey).toHaveBeenCalledWith('public-key-1', 'ValidPass123');
    });
  });
});
