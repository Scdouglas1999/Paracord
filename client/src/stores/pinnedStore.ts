import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Pinned-conversation persistence (layout-spec §3.4).
 *
 * Keys are the composite `${serverId}:${channelId}` (see conversationModel)
 * so pins survive across servers and reconnects. `PinnedRail` renders entries
 * in `pinnedKeys` order.
 */
interface PinnedState {
  pinnedKeys: string[];

  pin: (key: string) => void;
  unpin: (key: string) => void;
  reorder: (keys: string[]) => void;
  isPinned: (key: string) => boolean;
}

export const usePinnedStore = create<PinnedState>()(
  persist(
    (set, get) => ({
      pinnedKeys: [],

      pin: (key) =>
        set((state) =>
          state.pinnedKeys.includes(key)
            ? state
            : { pinnedKeys: [...state.pinnedKeys, key] }
        ),

      unpin: (key) =>
        set((state) => ({
          pinnedKeys: state.pinnedKeys.filter((k) => k !== key),
        })),

      reorder: (keys) =>
        set((state) => {
          // Keep only currently-pinned keys, in the supplied order; append any
          // pinned key the caller omitted so nothing is silently dropped.
          const pinned = new Set(state.pinnedKeys);
          const seen = new Set<string>();
          const next: string[] = [];
          for (const k of keys) {
            if (pinned.has(k) && !seen.has(k)) {
              next.push(k);
              seen.add(k);
            }
          }
          for (const k of state.pinnedKeys) {
            if (!seen.has(k)) next.push(k);
          }
          return { pinnedKeys: next };
        }),

      isPinned: (key) => get().pinnedKeys.includes(key),
    }),
    {
      name: 'paracord:pinned-conversations',
    }
  )
);
