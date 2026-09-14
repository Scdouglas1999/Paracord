import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProtectedRoute } from './App';
import { destinationAfterLogin } from './pages/LoginPage';

const authState = {
  token: null as string | null,
  sessionBootstrapComplete: true,
  settings: null as { crypto_auth_enabled: boolean } | null,
  hasFetchedSettings: true,
  fetchSettings: vi.fn(),
};

const serverListState = {
  servers: [] as Array<{ id: string; token?: string | null; refreshToken?: string | null }>,
  tokensHydrated: true,
};

const accountState = { isUnlocked: false };
let deviceHasIdentity = false;

vi.mock('./stores/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: typeof authState) => unknown) => selector(authState),
    { getState: () => ({ logout: vi.fn(async () => undefined) }) },
  ),
}));
vi.mock('./stores/serverListStore', () => ({
  useServerListStore: (selector: (s: typeof serverListState) => unknown) => selector(serverListState),
}));
vi.mock('./stores/accountStore', () => ({
  useAccountStore: (selector: (s: typeof accountState) => unknown) => selector(accountState),
}));
vi.mock('./lib/account', () => ({ hasAccount: () => deviceHasIdentity }));
vi.mock('./gateway/manager', () => ({ gateway: { syncServers: vi.fn(async () => undefined) } }));
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

/** A handle that lets a test navigate the way a late async handler would. */
let stray: ((to: string) => void) | null = null;
function StrayNavigator() {
  const navigate = useNavigate();
  stray = (to: string) => navigate(to, { replace: true });
  return null;
}

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/app']}>
      <StrayNavigator />
      <Routes>
        <Route path="/app" element={<ProtectedRoute><div>App shell</div></ProtectedRoute>} />
        <Route path="/setup" element={<div>Set up a local identity</div>} />
        <Route path="/unlock" element={<div>Unlock screen</div>} />
        <Route path="/login" element={<div>Login form</div>} />
        <Route path="/connect" element={<div>Connect screen</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute guard', () => {
  beforeEach(() => {
    authState.token = null;
    authState.settings = null;
    authState.hasFetchedSettings = true;
    accountState.isUnlocked = false;
    deviceHasIdentity = false;
    // A server in the list makes serverStatus resolve to 'ready' synchronously.
    serverListState.servers = [{ id: 's1' }];
    serverListState.tokensHydrated = true;
    stray = null;
  });

  it('sends a signed-in account with no device identity to /setup', () => {
    authState.token = 'tok';
    authState.settings = { crypto_auth_enabled: true };
    renderApp();
    expect(screen.getByText('Set up a local identity')).toBeInTheDocument();
  });

  // The blank second device: the sign-in handler's own late navigate('/app')
  // used to land after the guard had already redirected, and <Navigate> never
  // fired again because none of its props had changed.
  it('re-issues its redirect when something navigates back to the guarded route', () => {
    authState.token = 'tok';
    authState.settings = { crypto_auth_enabled: true };
    renderApp();
    expect(screen.getByText('Set up a local identity')).toBeInTheDocument();

    act(() => stray?.('/app'));

    expect(screen.getByText('Set up a local identity')).toBeInTheDocument();
    expect(document.body.textContent?.trim()).not.toBe('');
  });

  it('offers the unlock screen when the device holds a locked identity', () => {
    deviceHasIdentity = true;
    renderApp();
    expect(screen.getByText('Unlock screen')).toBeInTheDocument();
  });

  it('waits for the device key instead of asking for a password again', () => {
    deviceHasIdentity = true;
    accountState.isUnlocked = true;
    renderApp();
    expect(screen.queryByText('Login form')).not.toBeInTheDocument();
    expect(document.body.textContent).toContain("Signing in with this device's key");
  });

  // The law this domain exists to enforce: whatever the state, something renders.
  it('never renders an empty window', () => {
    for (const token of [null, 'tok']) {
      for (const crypto of [true, false]) {
        for (const identity of [false, true]) {
          for (const unlocked of [false, true]) {
            authState.token = token;
            authState.settings = crypto ? { crypto_auth_enabled: true } : null;
            deviceHasIdentity = identity;
            accountState.isUnlocked = unlocked;
            const { unmount } = renderApp();
            expect(
              document.body.textContent?.trim(),
              `blank for token=${token} crypto=${crypto} identity=${identity} unlocked=${unlocked}`,
            ).not.toBe('');
            unmount();
          }
        }
      }
    }
  });
});

describe('destinationAfterLogin', () => {
  it('goes to the app when sign-in finishes on the sign-in screen', () => {
    expect(destinationAfterLogin(null, true)).toBe('/app');
  });

  it('leaves the route alone when a guard has already replaced the screen', () => {
    expect(destinationAfterLogin(null, false)).toBeNull();
  });

  it('still honours an invite the person asked for', () => {
    expect(destinationAfterLogin('aBcDeF', false)).toBe('/invite/aBcDeF');
  });
});
