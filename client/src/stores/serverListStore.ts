import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { secureDelete, secureGet, secureSet } from '../lib/secureStorage';
import { isTauri } from '../lib/tauriEnv';

export interface ServerEntry {
  id: string;           // unique ID (derived from URL hash or random)
  url: string;          // base URL e.g. "http://192.168.1.5:8090"
  name: string;         // server display name
  iconUrl?: string;     // server icon
  token: string | null; // JWT token for this server
  refreshToken?: string | null; // Rotating refresh token for cross-origin refresh
  connected: boolean;   // WebSocket connected
  apiReachable?: boolean; // Last known HTTP/API reachability
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
  setConnected: (id: string, connected: boolean) => void;
  setApiReachable: (id: string, apiReachable: boolean) => void;
  markHydrated: () => void;
  hydrateTokens: () => Promise<void>;
  getServer: (id: string) => ServerEntry | undefined;
  getActiveServer: () => ServerEntry | undefined;
  getServerByUrl: (url: string) => ServerEntry | undefined;
}

function normalizeServerUrl(url: string): string {
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

function generateServerId(url: string): string {
  // Simple hash-based ID from URL for deterministic IDs
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return 's_' + Math.abs(hash).toString(36);
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
                ? { ...s, name, url: normalizedUrl, apiReachable: true, ...(token ? { token } : {}) }
                : s
            ),
            activeServerId: existing.id,
          }));
          return existing.id;
        }
        const id = generateServerId(normalizedUrl);
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
        void saveServerToken(id, token);
        set((state) => ({
          servers: state.servers.map((s) =>
            s.id === id ? { ...s, token } : s
          ),
        }));
      },

      updateRefreshToken: (id, refreshToken) => {
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
          const tokenById = new Map(loaded.map((entry) => [entry.id, entry.token]));
          const refreshTokenById = new Map(
            loaded.map((entry) => [entry.id, entry.refreshToken]),
          );
          set((state) => ({
            servers: state.servers.map((server) => ({
              ...server,
              token: tokenById.get(server.id) ?? null,
              refreshToken: refreshTokenById.get(server.id) ?? null,
            })),
          }));
        } finally {
          set({ tokensHydrated: true });
        }
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
