import { describe, it, expect, beforeEach, vi } from 'vitest';

// Avoid touching the real (crypto-backed) secure storage layer in unit tests.
vi.mock('../lib/secureStorage', () => ({
  secureGet: vi.fn(async () => null),
  secureSet: vi.fn(async () => {}),
  secureDelete: vi.fn(async () => {}),
}));

import { useServerListStore, resolveDefaultServerTarget } from './serverListStore';
import { secureGet } from '../lib/secureStorage';

function reset() {
  useServerListStore.setState({
    servers: [],
    activeServerId: null,
    hydrated: false,
    tokensHydrated: false,
  });
}

describe('serverListStore', () => {
  beforeEach(() => {
    reset();
  });

  describe('addServer', () => {
    it('adds a new server and makes the first one active automatically', () => {
      const id = useServerListStore.getState().addServer('https://a.example.com', 'A');
      const state = useServerListStore.getState();
      expect(state.servers).toHaveLength(1);
      expect(state.servers[0].id).toBe(id);
      expect(state.activeServerId).toBe(id);
    });

    it('dedupes an already-present server and returns the existing id', () => {
      const id1 = useServerListStore.getState().addServer('https://a.example.com', 'A');
      const id2 = useServerListStore.getState().addServer('https://a.example.com/', 'A renamed');
      expect(id2).toBe(id1);
      const state = useServerListStore.getState();
      expect(state.servers).toHaveLength(1);
      // Metadata is merged in place rather than duplicated.
      expect(state.servers[0].name).toBe('A renamed');
    });

    it('updates the token on a duplicate add instead of creating a new entry', () => {
      const id = useServerListStore.getState().addServer('https://a.example.com', 'A');
      expect(useServerListStore.getState().servers[0].token).toBeNull();
      const dupId = useServerListStore.getState().addServer('https://a.example.com', 'A', 'jwt-123');
      expect(dupId).toBe(id);
      const state = useServerListStore.getState();
      expect(state.servers).toHaveLength(1);
      expect(state.servers[0].token).toBe('jwt-123');
    });

    it('treats differing paths on the same host as the same server', () => {
      const id1 = useServerListStore.getState().addServer('https://a.example.com/api/v1', 'A');
      const id2 = useServerListStore.getState().addServer('https://a.example.com/health', 'A');
      expect(id2).toBe(id1);
      expect(useServerListStore.getState().servers).toHaveLength(1);
    });

    it('keeps distinct hosts as separate servers', () => {
      const id1 = useServerListStore.getState().addServer('https://a.example.com', 'A');
      const id2 = useServerListStore.getState().addServer('https://b.example.com', 'B');
      expect(id2).not.toBe(id1);
      expect(useServerListStore.getState().servers).toHaveLength(2);
    });

    it('does not alias URLs that collide under the former 32-bit hash', () => {
      const first = useServerListStore.getState().addServer('https://example.test/Aa', 'A');
      const second = useServerListStore.getState().addServer('https://example.test/BB', 'B');
      expect(first).not.toBe(second);
      expect(useServerListStore.getState().servers).toHaveLength(2);
    });
  });

  // Every API response marks its server reachable. When that wrote a new
  // `servers` array regardless, it woke every subscriber of this store dozens of
  // times per screen — and on the desktop one of those subscribers makes the
  // shell issue a real `/health` request per server before the app may talk.
  it('does not notify subscribers when reachability is already what it says', () => {
    const id = useServerListStore.getState().addServer('https://a.example.com', 'A');
    useServerListStore.getState().setApiReachable(id, true);
    const before = useServerListStore.getState().servers;

    const seen = vi.fn();
    const stop = useServerListStore.subscribe(seen);
    useServerListStore.getState().setApiReachable(id, true);
    stop();

    expect(seen).not.toHaveBeenCalled();
    expect(useServerListStore.getState().servers).toBe(before);
  });

  it('still records a reachability change', () => {
    const id = useServerListStore.getState().addServer('https://a.example.com', 'A');
    useServerListStore.getState().setApiReachable(id, true);
    useServerListStore.getState().setApiReachable(id, false);
    expect(useServerListStore.getState().servers[0].apiReachable).toBe(false);
  });

  it('requires a fresh authenticated profile when reconnect supplies a different credential', () => {
    const store = useServerListStore.getState();
    const id = store.addServer('https://example.test', 'A', 'old-token');
    store.setAuthenticatedUser(id, { id: 'old-user', username: 'old-user', flags: 1 } as never);
    store.addServer('https://example.test', 'A', 'new-token');
    expect(store.getServer(id)?.user).toBeUndefined();
    expect(store.getServer(id)?.userId).toBeUndefined();
    expect(store.getServer(id)?.token).toBe('new-token');
  });

  describe('credential hydration ownership', () => {
    it('does not restore credentials that finish loading after logout', async () => {
      const id = useServerListStore.getState().addServer('https://example.test', 'A');
      let finish!: (token: string | null) => void;
      vi.mocked(secureGet).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const pending = useServerListStore.getState().hydrateTokens();
      await useServerListStore.getState().clearSessions();
      finish('old-access-token');
      await pending;
      expect(useServerListStore.getState().getServer(id)?.token).toBeNull();
    });

    it('does not replace a newly issued credential with an older stored token', async () => {
      const id = useServerListStore.getState().addServer('https://example.test', 'A');
      let finish!: (token: string | null) => void;
      vi.mocked(secureGet).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const pending = useServerListStore.getState().hydrateTokens();
      useServerListStore.getState().updateToken(id, 'new-access-token');
      finish('old-access-token');
      await pending;
      expect(useServerListStore.getState().getServer(id)?.token).toBe('new-access-token');
    });
  });

  describe('removeServer', () => {
    it('picks a sane next-active server when the active one is removed', () => {
      const id1 = useServerListStore.getState().addServer('https://a.example.com', 'A');
      const id2 = useServerListStore.getState().addServer('https://b.example.com', 'B');
      // Second add is active; removing it should fall back to a remaining server.
      expect(useServerListStore.getState().activeServerId).toBe(id2);
      useServerListStore.getState().removeServer(id2);
      const state = useServerListStore.getState();
      expect(state.servers).toHaveLength(1);
      expect(state.activeServerId).toBe(id1);
    });

    it('clears active when the last server is removed', () => {
      const id = useServerListStore.getState().addServer('https://a.example.com', 'A');
      useServerListStore.getState().removeServer(id);
      const state = useServerListStore.getState();
      expect(state.servers).toHaveLength(0);
      expect(state.activeServerId).toBeNull();
    });

    it('leaves active untouched when a non-active server is removed', () => {
      const id1 = useServerListStore.getState().addServer('https://a.example.com', 'A');
      const id2 = useServerListStore.getState().addServer('https://b.example.com', 'B');
      expect(useServerListStore.getState().activeServerId).toBe(id2);
      useServerListStore.getState().removeServer(id1);
      expect(useServerListStore.getState().activeServerId).toBe(id2);
    });
  });

  describe('resolveDefaultServerTarget', () => {
    it('returns the current origin in a browser (non-Tauri) build', () => {
      expect(resolveDefaultServerTarget()).toBe(
        `${window.location.protocol}//${window.location.host}`
      );
    });
  });
});
