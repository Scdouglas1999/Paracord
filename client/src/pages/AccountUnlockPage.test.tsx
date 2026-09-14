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
  getApiClient: vi.fn(),
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
  normalizeServerUrl: (url: string) => url.trim().replace(/\/+$/, ''),
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

function renderUnlockPage(entry = '/unlock') {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/unlock" element={<AccountUnlockPage />} />
        <Route path="/login" element={<div>Login page</div>} />
        <Route path="/recover" element={<div>Recover page</div>} />
        <Route path="/app" element={<div>App shell</div>} />
        <Route path="/app/dms/:id" element={<div>Original conversation</div>} />
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
    mockGateway.getApiClient.mockReturnValue(undefined);
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
  it('connects the server it just made active even though the entry carries a token', async () => {
    // `addServer` is handed the session token, so the entry ALWAYS has one the
    // moment it is created. Gating the connect on a missing token skipped it on
    // exactly the load that created the entry, and the now-active server had no
    // API client: "This server is not connected. Reconnect before trying again."
    const user = userEvent.setup();
    mockApiBaseUrl.getStoredServerUrl.mockReturnValue('https://chat.example.test');
    mockServerListState.getServerByUrl.mockReturnValue(null);
    mockServerListState.getServer.mockReturnValue({ id: 'server-1', token: 'server-token' });
    mockGateway.getApiClient.mockReturnValue(undefined);

    renderUnlockPage();
    await user.type(screen.getByLabelText(/Password/), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() => expect(mockGateway.connectServer).toHaveBeenCalledWith('server-1'));
    expect(await screen.findByText('App shell')).toBeInTheDocument();
  });

  it('does not reconnect a server that already has a live client', async () => {
    const user = userEvent.setup();
    mockApiBaseUrl.getStoredServerUrl.mockReturnValue('https://chat.example.test');
    mockServerListState.getServerByUrl.mockReturnValue({ id: 'server-1', token: 'server-token' });
    mockServerListState.getServer.mockReturnValue({ id: 'server-1', token: 'server-token' });
    mockGateway.getApiClient.mockReturnValue({} as never);

    renderUnlockPage();
    await user.type(screen.getByLabelText(/Password/), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(await screen.findByText('App shell')).toBeInTheDocument();
    expect(mockGateway.connectServer).not.toHaveBeenCalled();
  });

  it('leaves the app’s own origin to __local__ instead of re-registering it as a server', async () => {
    // The embedded web UI is served BY the server it talks to. Adding that same
    // origin as a second "remote" entry and making it active gave every request
    // a connection the duplicate-SSE guard leaves without an event stream, so
    // READY never arrived and the composer waited for a handshake forever.
    const user = userEvent.setup();
    mockApiBaseUrl.getStoredServerUrl.mockReturnValue(null);
    mockApiBaseUrl.getCurrentOriginServerUrl.mockReturnValue('http://127.0.0.1:18410');

    renderUnlockPage();
    await user.type(screen.getByLabelText(/Password/), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(await screen.findByText('App shell')).toBeInTheDocument();
    expect(mockServerListState.addServer).not.toHaveBeenCalled();
    expect(mockGateway.connectServer).not.toHaveBeenCalled();
  });

  it('still restores a genuinely remote stored server', async () => {
    const user = userEvent.setup();
    mockApiBaseUrl.getStoredServerUrl.mockReturnValue('https://chat.example.test');
    mockApiBaseUrl.getCurrentOriginServerUrl.mockReturnValue('http://127.0.0.1:18410');
    mockServerListState.getServerByUrl.mockReturnValue(null);
    mockGateway.getApiClient.mockReturnValue(undefined);

    renderUnlockPage();
    await user.type(screen.getByLabelText(/Password/), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() => expect(mockGateway.connectServer).toHaveBeenCalledWith('server-1'));
  });

  it('returns to the original conversation after unlocking from its composer', async () => {
    const user = userEvent.setup();
    renderUnlockPage('/unlock?returnTo=%2Fapp%2Fdms%2F123');
    await user.type(screen.getByLabelText(/Password/), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('Original conversation')).toBeInTheDocument();
  });

});
