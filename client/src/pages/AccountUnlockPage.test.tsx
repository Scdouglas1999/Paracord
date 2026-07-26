import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountUnlockPage } from './AccountUnlockPage';

const mockAccountState = vi.hoisted(() => ({
  unlock: vi.fn(),
  publicKey: 'public-key-1234567890',
  username: 'alice',
}));

const mockAuthState = vi.hoisted(() => ({
  token: 'server-token',
}));

const mockServerListState = vi.hoisted(() => ({
  getServerByUrl: vi.fn(),
  addServer: vi.fn(),
  getServer: vi.fn(),
}));

const mockApiBaseUrl = vi.hoisted(() => ({
  getStoredServerUrl: vi.fn(),
  getCurrentOriginServerUrl: vi.fn(),
  setStoredServerUrl: vi.fn(),
}));

const mockGateway = vi.hoisted(() => ({
  connectServer: vi.fn(),
}));

const mockAccount = vi.hoisted(() => ({
  hasAccount: vi.fn(),
}));

vi.mock('../stores/accountStore', () => ({
  useAccountStore: (selector: (state: typeof mockAccountState) => unknown) =>
    selector(mockAccountState),
}));

vi.mock('../stores/authStore', () => ({
  useAuthStore: (selector: (state: typeof mockAuthState) => unknown) =>
    selector(mockAuthState),
}));

vi.mock('../stores/serverListStore', () => ({
  useServerListStore: {
    getState: vi.fn(() => mockServerListState),
  },
}));

vi.mock('../lib/account', () => ({
  hasAccount: mockAccount.hasAccount,
}));

vi.mock('../lib/config/apiBaseUrl', () => ({
  getStoredServerUrl: mockApiBaseUrl.getStoredServerUrl,
  getCurrentOriginServerUrl: mockApiBaseUrl.getCurrentOriginServerUrl,
  setStoredServerUrl: mockApiBaseUrl.setStoredServerUrl,
}));

vi.mock('../gateway/manager', () => ({
  gateway: mockGateway,
}));

function renderUnlockPage() {
  render(
    <MemoryRouter initialEntries={['/unlock']}>
      <Routes>
        <Route path="/unlock" element={<AccountUnlockPage />} />
        <Route path="/login" element={<div>Login page</div>} />
        <Route path="/recover" element={<div>Recover page</div>} />
        <Route path="/app" element={<div>App shell</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AccountUnlockPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccount.hasAccount.mockReturnValue(true);
    mockAccountState.unlock.mockResolvedValue(undefined);
    mockAuthState.token = 'server-token';
    mockApiBaseUrl.getStoredServerUrl.mockReturnValue(null);
    mockApiBaseUrl.getCurrentOriginServerUrl.mockReturnValue(null);
    mockServerListState.getServerByUrl.mockReturnValue(null);
    mockServerListState.addServer.mockReturnValue('server-1');
    mockServerListState.getServer.mockReturnValue({ id: 'server-1', token: 'server-token' });
    mockGateway.connectServer.mockResolvedValue(undefined);
  });

  it('redirects to login when no local account exists', async () => {
    mockAccount.hasAccount.mockReturnValue(false);

    renderUnlockPage();

    expect(await screen.findByText('Login page')).toBeInTheDocument();
  });

  it('navigates recovery and import actions from the locked account screen', async () => {
    const user = userEvent.setup();

    renderUnlockPage();

    await user.click(screen.getByRole('button', { name: /Recover from phrase/ }));
    expect(await screen.findByText('Recover page')).toBeInTheDocument();

    renderUnlockPage();
    await user.click(screen.getByRole('button', { name: /Import account from file/ }));
    expect(await screen.findByText('App shell')).toBeInTheDocument();
  });

  it('locks the form after repeated failed unlock attempts', async () => {
    const user = userEvent.setup();
    mockAccountState.unlock.mockRejectedValue(new Error('bad password'));

    renderUnlockPage();

    await user.type(screen.getByLabelText(/Password/), 'wrong-password');
    const unlockButton = screen.getByRole('button', { name: 'Unlock' });

    await user.click(unlockButton);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unlock failed. Check your password and try again.',
    );
    await user.click(unlockButton);
    await user.click(unlockButton);

    await waitFor(() => expect(unlockButton).toBeDisabled());
    expect(mockAccountState.unlock).toHaveBeenCalledTimes(3);
  });

  it('restores the stored server and reconnects when unlocking succeeds', async () => {
    const user = userEvent.setup();
    mockApiBaseUrl.getStoredServerUrl.mockReturnValue('https://chat.example.test');
    mockServerListState.getServerByUrl.mockReturnValue(null);
    mockServerListState.getServer.mockReturnValue({ id: 'server-1', token: null });

    renderUnlockPage();

    await user.type(screen.getByLabelText(/Password/), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() =>
      expect(mockAccountState.unlock).toHaveBeenCalledWith('correct horse battery staple'),
    );
    expect(mockApiBaseUrl.setStoredServerUrl).toHaveBeenCalledWith('https://chat.example.test');
    expect(mockServerListState.addServer).toHaveBeenCalledWith(
      'https://chat.example.test',
      'chat.example.test',
      'server-token',
    );
    expect(mockGateway.connectServer).toHaveBeenCalledWith('server-1');
    expect(await screen.findByText('App shell')).toBeInTheDocument();
  });
});
