import { create } from 'zustand';
import { authApi } from '../api/auth';
import { connectionManager, LOCAL_SERVER_ID } from '../lib/connectionManager';
import { useServerListStore } from './serverListStore';
import type { ReadState } from '../types';

/** Per-channel read state for a single server, keyed by channel_id. */
type ServerReadStates = Record<string, ReadState>;

// Stable empty record so `getReadStateMap` returns a referentially-stable value
// for unknown servers (avoids busting downstream memos).
const EMPTY_READ_STATES: ServerReadStates = Object.freeze({});

interface ReadStateStore {
  /**
   * serverId-scoped read state — the single source of truth for the cross-server
   * unread merge. Keyed by serverId (a `serverListStore` id, or `LOCAL_SERVER_ID`
   * for the legacy single-server / local-auth path) then by channel_id.
   */
  byServer: Record<string, ServerReadStates>;
  /**
   * Derived mirror of the ACTIVE server's record, kept in sync on every mutation.
   *
   * NOTE: `TopBar` (read/refresh/setAll), `MessageList` + `InboxOverlay`
   * (markRead) still read/write via the single-arg active-server adapters below
   * and resolve against this mirror. They ride the active-server adapter until
   * the wave-3 chat migration passes an explicit serverId (layout-spec §3.5,
   * §8 wave 3). Do NOT use this mirror for cross-server logic — read `byServer`.
   */
  readStates: ServerReadStates;

  /** The per-server read-state record consumed by `computeGuildUnread`. */
  getReadStateMap: (serverId: string) => ServerReadStates;
  /** A single channel's read state on a specific server, if known. */
  getReadState: (serverId: string, channelId: string) => ReadState | undefined;

  /**
   * Replace a server's full snapshot from an authoritative REST fetch. `serverId`
   * defaults to the active server so the legacy `setAll(states)` call site keeps
   * working.
   */
  setAll: (states: ReadState[], serverId?: string) => void;
  /** Fetch authoritative snapshots from every connected server and replace each cache. */
  refresh: () => Promise<void>;
  /**
   * Mark a channel read: advance the read cursor and clear mentions. Accepts the
   * new `(serverId, channelId, lastMessageId)` form and the legacy
   * `(channelId, lastMessageId)` form (resolves to the active server).
   */
  markRead: {
    (channelId: string, lastMessageId: string): void;
    (serverId: string, channelId: string, lastMessageId: string): void;
  };
  /**
   * Bump a channel's unread mention count. Accepts the new `(serverId, channelId)`
   * form and the legacy `(channelId)` form (resolves to the active server).
   */
  incrementMention: {
    (channelId: string): void;
    (serverId: string, channelId: string): void;
  };
  /** Drop all cached read state (called on logout). */
  reset: () => void;
}

function indexByChannel(states: ReadState[]): ServerReadStates {
  const next: ServerReadStates = {};
  for (const rs of states) {
    next[rs.channel_id] = rs;
  }
  return next;
}

/**
 * Resolve the serverId the single-arg legacy adapters target: the active server
 * from `serverListStore`, falling back to the `__local__` bucket (the legacy
 * single-server / local-auth connection) when no server is marked active.
 */
function resolveActiveServerId(): string {
  return useServerListStore.getState().activeServerId ?? LOCAL_SERVER_ID;
}

// Coalesce concurrent snapshot fetches: several unread consumers (sidebars,
// top bar) mount together and each calls refresh() — they should share one pass.
let inFlightRefresh: Promise<void> | null = null;

export const useReadStateStore = create<ReadStateStore>()((set, get) => {
  // Recompute the active-server mirror alongside every `byServer` write so the
  // legacy single-arg call sites keep resolving without edits.
  const withMirror = (
    byServer: Record<string, ServerReadStates>,
  ): Pick<ReadStateStore, 'byServer' | 'readStates'> => ({
    byServer,
    readStates: byServer[resolveActiveServerId()] ?? EMPTY_READ_STATES,
  });

  const markReadImpl = (a: string, b: string, c?: string): void => {
    // 3 args → (serverId, channelId, lastMessageId); 2 args → legacy (channelId, lastMessageId).
    const serverId = c !== undefined ? a : resolveActiveServerId();
    const channelId = c !== undefined ? b : a;
    const lastMessageId = c !== undefined ? c : b;
    set((state) => {
      const existingMap = state.byServer[serverId] ?? EMPTY_READ_STATES;
      const nextMap: ServerReadStates = {
        ...existingMap,
        [channelId]: { channel_id: channelId, last_message_id: lastMessageId, mention_count: 0 },
      };
      return withMirror({ ...state.byServer, [serverId]: nextMap });
    });
  };

  const incrementMentionImpl = (a: string, b?: string): void => {
    // 2 args → (serverId, channelId); 1 arg → legacy (channelId).
    const serverId = b !== undefined ? a : resolveActiveServerId();
    const channelId = b !== undefined ? b : a;
    set((state) => {
      const existingMap = state.byServer[serverId] ?? EMPTY_READ_STATES;
      const existing = existingMap[channelId];
      const nextMap: ServerReadStates = {
        ...existingMap,
        [channelId]: {
          channel_id: channelId,
          last_message_id: existing?.last_message_id ?? '',
          mention_count: (existing?.mention_count ?? 0) + 1,
        },
      };
      return withMirror({ ...state.byServer, [serverId]: nextMap });
    });
  };

  return {
    byServer: {},
    readStates: EMPTY_READ_STATES,

    getReadStateMap: (serverId) => get().byServer[serverId] ?? EMPTY_READ_STATES,
    getReadState: (serverId, channelId) => get().byServer[serverId]?.[channelId],

    setAll: (states, serverId) =>
      set((state) => {
        const sid = serverId ?? resolveActiveServerId();
        return withMirror({ ...state.byServer, [sid]: indexByChannel(states) });
      }),

    refresh: async () => {
      if (inFlightRefresh) return inFlightRefresh;
      inFlightRefresh = (async () => {
        try {
          const { servers, activeServerId } = useServerListStore.getState();
          const activeId = activeServerId ?? LOCAL_SERVER_ID;

          type FetchResult = { serverId: string; states: ReadState[] } | null;
          const tasks: Promise<FetchResult>[] = [];

          // Active / local server: authoritative primary client.
          tasks.push(
            authApi
              .getReadStates()
              .then(({ data }) => ({ serverId: activeId, states: data }) as FetchResult)
              .catch(() => null),
          );

          // Background servers: fan out over their per-server API clients so the
          // cross-server merge sees every connected server's unreads.
          for (const server of servers) {
            if (server.id === activeId || !server.connected) continue;
            const client = connectionManager.getApiClient(server.id);
            if (!client) continue;
            tasks.push(
              client
                .get<ReadState[]>('/users/@me/read-states')
                .then(({ data }) => ({ serverId: server.id, states: data }) as FetchResult)
                .catch(() => null),
            );
          }

          const results = await Promise.all(tasks);
          set((state) => {
            const nextByServer = { ...state.byServer };
            for (const result of results) {
              // Null = this server's fetch failed: keep its prior snapshot so an
              // unreachable background server degrades gracefully (§9 flag 2).
              if (result) nextByServer[result.serverId] = indexByChannel(result.states);
            }
            return withMirror(nextByServer);
          });
        } finally {
          inFlightRefresh = null;
        }
      })();
      return inFlightRefresh;
    },

    markRead: markReadImpl as ReadStateStore['markRead'],

    incrementMention: incrementMentionImpl as ReadStateStore['incrementMention'],

    reset: () => set({ byServer: {}, readStates: EMPTY_READ_STATES }),
  };
});
