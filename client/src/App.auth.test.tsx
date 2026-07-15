import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthRoute, resolveCryptoAuthRedirect } from './App';

const authState = {
  token: null as string | null,
  sessionBootstrapComplete: true,
};

const serverListState = {
  servers: [] as Array<{ id: string; token?: string | null; refreshToken?: string | null }>,
  tokensHydrated: true,
};

vi.mock('./stores/authStore', () => ({
  useAuthStore: (selector: (s: typeof authState) => unknown) => selector(authState),
}));

vi.mock('./stores/serverListStore', () => ({
  useServerListStore: (selector: (s: typeof serverListState) => unknown) => selector(serverListState),
}));

vi.mock('./lib/config/apiBaseUrl', () => ({
  API_BASE_URL: '/api/v1',
  SERVER_URL_KEY: 'server-url',
  clearStoredServerUrl: vi.fn(),
  getCurrentOriginServerUrl: vi.fn(() => null),
  getStoredServerUrl: vi.fn(() => 'https://example.test'),
  setStoredServerUrl: vi.fn(),
  resolveApiBaseUrl: vi.fn(() => '/api/v1'),
  resolveResourceUrl: vi.fn((path: string) => path),
  resolveServerRootUrl: vi.fn((path: string) => path),
  resolveV2ApiUrl: vi.fn((path: string) => `/api/v2${path}`),
}));

function renderAuthRouteAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<AuthRoute><div>Login form</div></AuthRoute>} />
        <Route path="/app" element={<div>App shell</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AuthRoute', () => {
  beforeEach(() => {
    authState.token = null;
    authState.sessionBootstrapComplete = true;
    serverListState.tokensHydrated = true;
    serverListState.servers = [{ id: 's1' }]; // serverStatus resolves to 'ready' synchronously
  });

  it('redirects an authenticated user away from /login to /app', () => {
    authState.token = 'valid-token';
    renderAuthRouteAt('/login');
    expect(screen.getByText('App shell')).toBeInTheDocument();
    expect(screen.queryByText('Login form')).not.toBeInTheDocument();
  });

  it('renders the login form for an unauthenticated user', () => {
    authState.token = null;
    renderAuthRouteAt('/login');
    expect(screen.getByText('Login form')).toBeInTheDocument();
    expect(screen.queryByText('App shell')).not.toBeInTheDocument();
  });

  it('redirects away from login when a saved server token was restored', () => {
    serverListState.servers = [{ id: 's1', token: 'server-token' }];
    renderAuthRouteAt('/login');
    expect(screen.getByText('App shell')).toBeInTheDocument();
    expect(screen.queryByText('Login form')).not.toBeInTheDocument();
  });

  it('redirects away from login when a saved server refresh token can restore the session', () => {
    serverListState.servers = [{ id: 's1', refreshToken: 'server-refresh-token' }];
    renderAuthRouteAt('/login');
    expect(screen.getByText('App shell')).toBeInTheDocument();
    expect(screen.queryByText('Login form')).not.toBeInTheDocument();
  });

  it('waits for saved server tokens before deciding whether to show login', () => {
    serverListState.tokensHydrated = false;
    renderAuthRouteAt('/login');
    expect(screen.getByText('Restoring session...')).toBeInTheDocument();
    expect(screen.queryByText('Login form')).not.toBeInTheDocument();
  });
});

describe('resolveCryptoAuthRedirect', () => {
  const base = {
    hasAccount: true,
    isUnlocked: true,
    hasServers: false,
    hasToken: true,
    serverReady: true,
  };

  it('sends users without a local account to /setup', () => {
    expect(resolveCryptoAuthRedirect({ ...base, hasAccount: false })).toBe('/setup');
  });

  it('sends locked accounts to /unlock', () => {
    expect(resolveCryptoAuthRedirect({ ...base, isUnlocked: false })).toBe('/unlock');
  });

  it('admits the user when a server list exists', () => {
    expect(resolveCryptoAuthRedirect({ ...base, hasServers: true, hasToken: false, serverReady: false })).toBeNull();
  });

  it('admits the user with a token on a ready server', () => {
    expect(resolveCryptoAuthRedirect({ ...base, hasServers: false })).toBeNull();
  });

  it('sends a tokenless user to /login', () => {
    expect(resolveCryptoAuthRedirect({ ...base, hasToken: false, serverReady: false })).toBe('/login');
  });

  it('falls back to /connect when a token exists but no server is ready', () => {
    expect(resolveCryptoAuthRedirect({ ...base, serverReady: false })).toBe('/connect');
  });
});
