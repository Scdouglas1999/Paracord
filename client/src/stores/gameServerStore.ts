import { create } from 'zustand';
import { gameServerErrorMessage, gameServersApi, type GameServer, type GameServerList } from '../api/gameServers';
import { registerSessionReset } from './sessionReset';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface GameServerEntry {
  list: GameServerList | null;
  status: LoadStatus;
  error: string | null;
  /** When the list last arrived, in ms. */
  fetchedAt: number;
}

interface GameServerStore {
  byGuild: Record<string, GameServerEntry>;
  /**
   * Read a server's list unless one arrived less than `maxAgeMs` ago. The
   * sidebar row, the front-page widget and the add-on page share it, so a
   * refresh one of them asks for serves the others too.
   */
  refresh: (guildId: string, maxAgeMs?: number) => Promise<void>;
  adopt: (guildId: string, list: GameServerList) => void;
  /** Put one changed server in place (or add it). */
  upsert: (guildId: string, server: GameServer) => void;
  removeServer: (guildId: string, serverId: string) => void;
  setEnabled: (guildId: string, enabled: boolean) => void;
  reset: () => void;
}

const inflight = new Map<string, Promise<void>>();

export const useGameServerStore = create<GameServerStore>((set, get) => ({
  byGuild: {},

  refresh: (guildId, maxAgeMs = 0) => {
    if (!guildId) return Promise.resolve();
    const pending = inflight.get(guildId);
    if (pending) return pending;
    const current = get().byGuild[guildId];
    if (current?.status === 'ready' && Date.now() - current.fetchedAt < maxAgeMs) {
      return Promise.resolve();
    }
    const task = (async () => {
      set((state) => ({
        byGuild: {
          ...state.byGuild,
          [guildId]: {
            list: state.byGuild[guildId]?.list ?? null,
            status: state.byGuild[guildId]?.list ? 'ready' : 'loading',
            error: null,
            fetchedAt: state.byGuild[guildId]?.fetchedAt ?? 0,
          },
        },
      }));
      try {
        const { data } = await gameServersApi.list(guildId);
        get().adopt(guildId, data);
      } catch (err) {
        set((state) => ({
          byGuild: {
            ...state.byGuild,
            [guildId]: {
              list: state.byGuild[guildId]?.list ?? null,
              status: 'error',
              error: gameServerErrorMessage(err),
              fetchedAt: state.byGuild[guildId]?.fetchedAt ?? 0,
            },
          },
        }));
      } finally {
        inflight.delete(guildId);
      }
    })();
    inflight.set(guildId, task);
    return task;
  },

  adopt: (guildId, list) =>
    set((state) => ({
      byGuild: {
        ...state.byGuild,
        [guildId]: { list, status: 'ready', error: null, fetchedAt: Date.now() },
      },
    })),

  upsert: (guildId, server) =>
    set((state) => {
      const entry = state.byGuild[guildId];
      if (!entry?.list) return state;
      const exists = entry.list.servers.some((item) => item.id === server.id);
      const servers = exists
        ? entry.list.servers.map((item) => (item.id === server.id ? server : item))
        : [...entry.list.servers, server];
      return { byGuild: { ...state.byGuild, [guildId]: { ...entry, list: { ...entry.list, servers } } } };
    }),

  removeServer: (guildId, serverId) =>
    set((state) => {
      const entry = state.byGuild[guildId];
      if (!entry?.list) return state;
      const servers = entry.list.servers.filter((item) => item.id !== serverId);
      return { byGuild: { ...state.byGuild, [guildId]: { ...entry, list: { ...entry.list, servers } } } };
    }),

  setEnabled: (guildId, enabled) =>
    set((state) => {
      const entry = state.byGuild[guildId];
      if (!entry?.list) return state;
      return { byGuild: { ...state.byGuild, [guildId]: { ...entry, list: { ...entry.list, enabled } } } };
    }),

  reset: () => {
    inflight.clear();
    set({ byGuild: {} });
  },
}));

registerSessionReset('gameServers', () => useGameServerStore.getState().reset());
