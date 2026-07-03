import { create } from 'zustand';
import { authApi } from '../api/auth';
import type { ReadState } from '../types';

interface ReadStateStore {
  /** Per-channel read state, keyed by channel_id. */
  readStates: Record<string, ReadState>;
  /** Replace the full snapshot from an authoritative REST fetch. */
  setAll: (states: ReadState[]) => void;
  /** Fetch the authoritative snapshot from the server and replace the cache. */
  refresh: () => Promise<void>;
  /** Mark a channel read locally: advance the read cursor and clear mentions. */
  markRead: (channelId: string, lastMessageId: string) => void;
  /** Bump a channel's unread mention count for an incoming mention. */
  incrementMention: (channelId: string) => void;
  /** Drop all cached read state (called on logout). */
  reset: () => void;
}

function indexByChannel(states: ReadState[]): Record<string, ReadState> {
  const next: Record<string, ReadState> = {};
  for (const rs of states) {
    next[rs.channel_id] = rs;
  }
  return next;
}

// Coalesce concurrent snapshot fetches: several unread consumers (sidebars,
// top bar) mount together and each calls refresh() — they should share one GET.
let inFlightRefresh: Promise<void> | null = null;

export const useReadStateStore = create<ReadStateStore>()((set) => ({
  readStates: {},

  setAll: (states) => set({ readStates: indexByChannel(states) }),

  refresh: async () => {
    if (inFlightRefresh) return inFlightRefresh;
    inFlightRefresh = (async () => {
      try {
        const { data } = await authApi.getReadStates();
        set({ readStates: indexByChannel(data) });
      } catch {
        // Keep the existing snapshot on transient fetch failures.
      } finally {
        inFlightRefresh = null;
      }
    })();
    return inFlightRefresh;
  },

  markRead: (channelId, lastMessageId) =>
    set((state) => ({
      readStates: {
        ...state.readStates,
        [channelId]: {
          channel_id: channelId,
          last_message_id: lastMessageId,
          mention_count: 0,
        },
      },
    })),

  incrementMention: (channelId) =>
    set((state) => {
      const existing = state.readStates[channelId];
      return {
        readStates: {
          ...state.readStates,
          [channelId]: {
            channel_id: channelId,
            last_message_id: existing?.last_message_id ?? '',
            mention_count: (existing?.mention_count ?? 0) + 1,
          },
        },
      };
    }),

  reset: () => set({ readStates: {} }),
}));
