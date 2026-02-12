import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ServerEntry {
  id: string;           // unique ID (derived from URL hash or random)
  url: string;          // base URL e.g. "http://192.168.1.5:8090"
  name: string;         // server display name
  iconUrl?: string;     // server icon
  token: string | null; // JWT token for this server
  connected: boolean;   // WebSocket connected
  userId?: string;      // user ID on this server (different per server since it's a snowflake)
}

interface ServerListState {
  servers: ServerEntry[];
  activeServerId: string | null;

  // Actions
  addServer: (url: string, name: string, token?: string) => string; // returns server ID
  removeServer: (id: string) => void;
  setActive: (id: string | null) => void;
  updateToken: (id: string, token: string) => void;
  updateServerInfo: (id: string, data: Partial<ServerEntry>) => void;
  setConnected: (id: string, connected: boolean) => void;
  getServer: (id: string) => ServerEntry | undefined;
  getActiveServer: () => ServerEntry | undefined;
  getServerByUrl: (url: string) => ServerEntry | undefined;
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

export const useServerListStore = create<ServerListState>()(
  persist(
    (set, get) => ({
      servers: [],
      activeServerId: null,

      addServer: (url, name, token) => {
        const existing = get().servers.find((s) => s.url === url);
        if (existing) {
          if (token) {
            set((state) => ({
              servers: state.servers.map((s) =>
                s.id === existing.id ? { ...s, token, name } : s
              ),
              activeServerId: existing.id,
            }));
          }
          return existing.id;
        }
        const id = generateServerId(url);
        const entry: ServerEntry = {
          id,
          url,
          name,
          token: token || null,
          connected: false,
        };
        set((state) => ({
          servers: [...state.servers, entry],
          activeServerId: id,
        }));
        return id;
      },

      removeServer: (id) =>
        set((state) => ({
          servers: state.servers.filter((s) => s.id !== id),
          activeServerId: state.activeServerId === id
            ? state.servers.find((s) => s.id !== id)?.id || null
            : state.activeServerId,
        })),

      setActive: (id) => set({ activeServerId: id }),

      updateToken: (id, token) =>
        set((state) => ({
          servers: state.servers.map((s) =>
            s.id === id ? { ...s, token } : s
          ),
        })),

      updateServerInfo: (id, data) =>
        set((state) => ({
          servers: state.servers.map((s) =>
            s.id === id ? { ...s, ...data } : s
          ),
        })),

      setConnected: (id, connected) =>
        set((state) => ({
          servers: state.servers.map((s) =>
            s.id === id ? { ...s, connected } : s
          ),
        })),

      getServer: (id) => get().servers.find((s) => s.id === id),
      getActiveServer: () => {
        const { servers, activeServerId } = get();
        return servers.find((s) => s.id === activeServerId);
      },
      getServerByUrl: (url) => get().servers.find((s) => s.url === url),
    }),
    {
      name: 'paracord:server-list',
      partialize: (state) => ({
        servers: state.servers.map((s) => ({ ...s, connected: false })),
        activeServerId: state.activeServerId,
      }),
    }
  )
);
