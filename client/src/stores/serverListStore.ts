import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { secureDelete, secureGet, secureSet } from '../lib/secureStorage';
import { isTauri } from '../lib/tauriEnv';
import type { User } from '../types';
import { registerSessionReset } from './sessionReset';

let tokenHydrationGeneration = 0;

export interface ServerEntry {
  id: string;           // stable unique ID; new entries use a UUID
  url: string;          // base URL e.g. "http://192.168.1.5:8090"
  name: string;         // server display name
  iconUrl?: string;     // server icon
  token: string | null; // JWT token for this server
  refreshToken?: string | null; // Rotating refresh token for cross-origin refresh
  connected: boolean;   // WebSocket connected
  apiReachable?: boolean; // Last known HTTP/API reachability
  user?: User;         // authenticated profile for this server only; never persisted
  userId?: string;      // user ID on this server (different per server since it's a snowflake)
}

interface ServerListState {
  hydrated: boolean;
  tokensHydrated: boolean;
  servers: ServerEntry[];
  activeServerId: string | null;

  // Actions
  addServer: (url: string, name: string, token?: string) => string; // returns server ID
  removeServer: (id: string) => void;
  setActive: (id: string | null) => void;
  updateToken: (id: string, token: string) => void;
  updateRefreshToken: (id: string, refreshToken: string | null) => void;
  updateServerInfo: (id: string, data: Partial<ServerEntry>) => void;
  setAuthenticatedUser: (id: string, user: User) => void;
  mergeUserProjection: (id: string, user: Partial<User> & Pick<User, 'id'>) => void;
  setConnected: (id: string, connected: boolean) => void;
  setApiReachable: (id: string, apiReachable: boolean) => void;
  markHydrated: () => void;
  hydrateTokens: () => Promise<void>;
  clearSessions: () => Promise<void>;
  getServer: (id: string) => ServerEntry | undefined;
  getActiveServer: () => ServerEntry | undefined;
  getServerByUrl: (url: string) => ServerEntry | undefined;
}

export function normalizeServerUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = new URL(trimmed);
    let pathname = parsed.pathname.replace(/\/+$/, '');
    if (
      pathname === '/api' ||
      pathname === '/api/v1' ||
      pathname === '/health' ||
      pathname === '/api/v1/health'
    ) {
      pathname = '';
    }
    return `${parsed.protocol}//${parsed.host}${pathname}`.replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

/**
 * Best default target to pre-fill on the connect screen.
 *
 * In a browser build the UI is served by its own Paracord server, so the
 * current origin is the right server to connect to. In the desktop shell there
 * is no implicit server — it supplies its own default — so this returns empty.
 */
export function resolveDefaultServerTarget(): string {
  if (isTauri()) return '';
  if (typeof window === 'undefined') return '';
  if (!/^https?:$/.test(window.location.protocol)) return '';
  if (!window.location.host) return '';
  return `${window.location.protocol}//${window.location.host}`;
}

function generateServerId(): string {
  // URL equality handles deduplication. A 32-bit hash can alias unrelated hosts.
  return `s_${crypto.randomUUID()}`;
}

function tokenStorageKey(serverId: string): string {
  return `paracord:server-token:${serverId}`;
}

function refreshTokenStorageKey(serverId: string): string {
  return `paracord:server-refresh-token:${serverId}`;
}

async function saveServerToken(serverId: string, token: string | null): Promise<void> {
  if (!token) {
    await secureDelete(tokenStorageKey(serverId));
    return;
  }
  await secureSet(tokenStorageKey(serverId), token);
}

async function saveServerRefreshToken(serverId: string, token: string | null): Promise<void> {
  if (!token) {
    await secureDelete(refreshTokenStorageKey(serverId));
    return;
  }
  await secureSet(refreshTokenStorageKey(serverId), token);
}

export const useServerListStore = create<ServerListState>()(
  persist(
    (set, get) => ({
      hydrated: false,
      tokensHydrated: false,
      servers: [],
      activeServerId: null,

      addServer: (url, name, token) => {
        const normalizedUrl = normalizeServerUrl(url);
        const existing = get().servers.find((s) => normalizeServerUrl(s.url) === normalizedUrl);
        if (existing) {
          // Re-connecting to an already-known server: update its metadata and
          // token in place (never duplicate) and make it the active server.
          if (token) {
            void saveServerToken(existing.id, token);
          }
          set((state) => ({
            servers: state.servers.map((s) =>
              s.id === existing.id
                ? { ...s, name, url: normalizedUrl, apiReachable: true, ...(token && token !== s.token ? { token, user: undefined, userId: undefined } : {}) }
                : s
            ),
            activeServerId: existing.id,
          }));
          return existing.id;
        }
        const id = generateServerId();
        const entry: ServerEntry = {
          id,
          url: normalizedUrl,
          name,
          token: token || null,
          connected: false,
          apiReachable: true,
        };
        if (token) {
          void saveServerToken(id, token);
        }
        set((state) => ({
          servers: [...state.servers, entry],
          activeServerId: id,
        }));
        return id;
      },

      removeServer: (id) => {
        void saveServerToken(id, null);
        void saveServerRefreshToken(id, null);
        set((state) => ({
          servers: state.servers.filter((s) => s.id !== id),
          activeServerId: state.activeServerId === id
            ? state.servers.find((s) => s.id !== id)?.id || null
            : state.activeServerId,
        }));
      },

      setActive: (id) => set({ activeServerId: id }),

      updateToken: (id, token) => {
        if (!get().getServer(id)) return;
        void saveServerToken(id, token);
        set((state) => ({
          servers: state.servers.map((s) =>
            s.id === id ? { ...s, token, ...(!token ? { user: undefined, userId: undefined, connected: false } : {}) } : s
          ),
        }));
      },

      updateRefreshToken: (id, refreshToken) => {
        if (!get().getServer(id)) return;
        void saveServerRefreshToken(id, refreshToken);
        set((state) => ({
          servers: state.servers.map((s) =>
            s.id === id ? { ...s, refreshToken } : s
          ),
        }));
      },

      updateServerInfo: (id, data) =>
        set((state) => ({
          servers: state.servers.map((s) =>
            s.id === id ? { ...s, ...data } : s
          ),
        })),

      setAuthenticatedUser: (id, user) => set((state) => ({
        servers: state.servers.map((server) => server.id === id
          ? { ...server, userId: user.id, user }
          : server),
      })),

      mergeUserProjection: (id, user) => set((state) => ({
        servers: state.servers.map((server) => {
          // Gateway projections may omit private fields. They may update only
          // the account verified by this server's REST authentication response.
          if (server.id !== id || server.user?.id !== user.id) return server;
          return { ...server, user: { ...server.user, ...user } };
        }),
      })),

      setConnected: (id, connected) =>
        set((state) => ({
          servers: state.servers.map((s) =>
            s.id === id ? { ...s, connected, apiReachable: connected || s.apiReachable } : s
          ),
        })),

      setApiReachable: (id, apiReachable) =>
        set((state) => ({
          servers: state.servers.map((s) =>
            s.id === id ? { ...s, apiReachable } : s
          ),
        })),

      markHydrated: () => set({ hydrated: true }),

      hydrateTokens: async () => {
        const generation = ++tokenHydrationGeneration;
        set({ tokensHydrated: false });
        try {
          const servers = get().servers;
          const loaded = await Promise.all(
            servers.map(async (server) => ({
              id: server.id,
              token: await secureGet(tokenStorageKey(server.id)),
              refreshToken: await secureGet(refreshTokenStorageKey(server.id)),
            }))
          );
          if (generation !== tokenHydrationGeneration) return;
          const tokenById = new Map(loaded.map((entry) => [entry.id, entry.token]));
          const refreshTokenById = new Map(
            loaded.map((entry) => [entry.id, entry.refreshToken]),
          );
          set((state) => ({
            servers: state.servers.map((server) => {
              const original = servers.find((entry) => entry.id === server.id);
              if (!original || server.token !== original.token || server.refreshToken !== original.refreshToken) return server;
              return { ...server, token: tokenById.get(server.id) ?? null, refreshToken: refreshTokenById.get(server.id) ?? null };
            }),
          }));
        } finally {
          if (generation === tokenHydrationGeneration) set({ tokensHydrated: true });
        }
      },

      clearSessions: async () => {
        tokenHydrationGeneration += 1;
        const servers = get().servers;
        set({
          servers: servers.map((server) => ({ ...server, token: null, refreshToken: null, user: undefined, userId: undefined, connected: false })),
          tokensHydrated: true,
        });
        await Promise.all(servers.flatMap((server) => [saveServerToken(server.id, null), saveServerRefreshToken(server.id, null)]));
      },

      getServer: (id) => get().servers.find((s) => s.id === id),
      getActiveServer: () => {
        const { servers, activeServerId } = get();
        return servers.find((s) => s.id === activeServerId);
      },
      getServerByUrl: (url) => {
        const normalizedUrl = normalizeServerUrl(url);
        return get().servers.find((s) => normalizeServerUrl(s.url) === normalizedUrl);
      },
    }),
    {
      name: 'paracord:server-list',
      onRehydrateStorage: () => (state) => {
        state?.markHydrated();
      },
      partialize: (state) => ({
        servers: state.servers.map((s) => ({
          ...s,
          user: undefined,
          token: null,
          refreshToken: null,
          connected: false,
          apiReachable: s.apiReachable ?? false,
        })),
        activeServerId: state.activeServerId,
      }),
    }
  )
);

registerSessionReset('server-sessions', () => useServerListStore.getState().clearSessions());
