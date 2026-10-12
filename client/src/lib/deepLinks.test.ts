import { beforeEach, describe, expect, it, vi } from 'vitest';

const listeners = new Map<string, (event: { payload: string }) => void>();
const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: string }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('./tauriEnv', () => ({ isTauri: () => true }));

import { useAddServerStore } from '../components/ix/dock/addServerStore';
import { useAuthStore } from '../stores/authStore';
import { useServerListStore } from '../stores/serverListStore';
import { useToastStore } from '../stores/toastStore';
import {
  FIRST_RUN_JOIN_PATH,
  FIRST_RUN_SIGN_IN_PATH,
  UNKNOWN_LINK_MESSAGE,
  installDeepLinks,
  parseServerLink,
  routeDeepLink,
  setFirstRunProbe,
  useDeepLinkIntake,
} from './deepLinks';
import { encodePortableLink } from './portableLinks';

const portable = `paracord://invite/${encodePortableLink('https://chat.example.com', 'hTKzmak')}`;

function toasts() {
  return useToastStore.getState().toasts.map((t) => t.message);
}

function hasServer() {
  useServerListStore.setState({
    servers: [{ id: 's1', url: 'https://chat.example.com', name: 'Chat' } as never],
  });
}

beforeEach(() => {
  listeners.clear();
  invokeMock.mockReset();
  setFirstRunProbe(null);
  useToastStore.setState({ toasts: [] });
  useDeepLinkIntake.setState({ invite: null, server: null });
  useAddServerStore.setState({ open: false, tab: 'create', joinDraft: null });
  useServerListStore.setState({ servers: [], tokensHydrated: true });
  useAuthStore.setState({ token: null });
  window.history.replaceState(null, '', '/');
});

describe('routeDeepLink', () => {
  it('sends an invite to the first-run join step when there are no servers', async () => {
    await routeDeepLink(portable);
    expect(window.location.pathname).toBe(FIRST_RUN_JOIN_PATH);
    expect(useDeepLinkIntake.getState().takeInvite()).toEqual({
      serverUrl: 'https://chat.example.com',
      code: 'hTKzmak',
    });
    expect(useDeepLinkIntake.getState().takeInvite()).toBeNull();
    expect(useAddServerStore.getState().open).toBe(false);
  });

  it('sends an invite to the first-run join step while the first run says it is active', async () => {
    hasServer();
    useAuthStore.setState({ token: 'x' });
    setFirstRunProbe(() => true);
    await routeDeepLink('https://chat.example.com/invite/abc');
    expect(window.location.pathname).toBe(FIRST_RUN_JOIN_PATH);
  });

  it('opens the Join tab with the link filled in once there is a server', async () => {
    hasServer();
    await routeDeepLink(portable);
    const state = useAddServerStore.getState();
    expect(state.open).toBe(true);
    expect(state.tab).toBe('join');
    expect(state.joinDraft).toBe('https://chat.example.com/invite/hTKzmak');
    expect(window.location.pathname).toBe('/');
  });

  it('waits for saved servers to load before deciding', async () => {
    useServerListStore.setState({ tokensHydrated: false });
    hasServer();
    const done = routeDeepLink(portable);
    await Promise.resolve();
    expect(useAddServerStore.getState().open).toBe(false);
    useServerListStore.setState({ tokensHydrated: true });
    await done;
    expect(useAddServerStore.getState().tab).toBe('join');
  });

  it('sends a server link to sign-in with the server prefilled', async () => {
    await routeDeepLink('paracord://server/chat.example.com');
    expect(window.location.pathname).toBe(FIRST_RUN_SIGN_IN_PATH);
    expect(useDeepLinkIntake.getState().takeServer()).toBe('https://chat.example.com');
  });

  it('says so for a link it cannot read, and does nothing else', async () => {
    for (const bad of ['paracord://nothing/here', 'https://example.com/', 'paracord://invite/%%%', 'hello']) {
      useToastStore.setState({ toasts: [] });
      await routeDeepLink(bad);
      expect(toasts()).toEqual([UNKNOWN_LINK_MESSAGE]);
    }
    expect(window.location.pathname).toBe('/');
    expect(useAddServerStore.getState().open).toBe(false);
    expect(useDeepLinkIntake.getState().invite).toBeNull();
  });

  it('parses server links with the invite parser rules', () => {
    expect(parseServerLink('paracord://server/chat.example.com:8443')).toBe('https://chat.example.com:8443');
    expect(parseServerLink('paracord://server/localhost:8090')).toBe('http://localhost:8090');
    expect(parseServerLink('paracord://server/user:pw@evil.example')).toBeNull();
    expect(parseServerLink('paracord://invite/abc')).toBeNull();
  });
});

describe('installDeepLinks', () => {
  it('listens first, routes the cold-start queue, then routes live events', async () => {
    const order: string[] = [];
    invokeMock.mockImplementation(async (command: string) => {
      order.push(`invoke:${command}:listening=${listeners.has('deep-link')}`);
      return [portable];
    });
    await installDeepLinks();
    await vi.waitFor(() => expect(window.location.pathname).toBe(FIRST_RUN_JOIN_PATH));
    expect(order).toEqual(['invoke:take_pending_deep_links:listening=true']);
    // Then a link that arrives while the app is running comes through the same listener.
    hasServer();
    window.history.replaceState(null, '', '/');
    listeners.get('deep-link')!({ payload: portable });
    await vi.waitFor(() => expect(useAddServerStore.getState().tab).toBe('join'));
    expect(window.location.pathname).toBe('/');
  });
});
