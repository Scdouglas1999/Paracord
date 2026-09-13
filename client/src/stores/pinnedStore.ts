import type { ChannelReference } from '../lib/channelScope';
import { entityScopeKey } from '../lib/serverScope';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Pinned-conversation persistence (layout-spec §3.4).
 *
 * Keys are JSON tuples of server, account and channel (see conversationModel)
 * so pins survive across servers and reconnects.
 *
 * NOTE: nothing renders these. `useUnifiedConversations` reads `pinnedKeys` and
 * partitions the merged list by it, but no surface in the Lantern Stage UI
 * offers a pin affordance — §7.1's column orders buildings by brightness and
 * recency instead. Either a surface gains one or this store goes; see
 * docs/design/wp8-checkpoint.md.
 */
interface PinnedState {
  pinnedKeys: string[];

  pin: (channel: ChannelReference) => void;
  unpin: (channel: ChannelReference) => void;
  reorder: (channels: ChannelReference[]) => void;
  isPinned: (channel: ChannelReference) => boolean;
}

export const usePinnedStore = create<PinnedState>()(
  persist(
    (set, get) => ({
      pinnedKeys: [],

      pin: (channel) => {
        const key = entityScopeKey(channel.scope, channel.id);
        set((state) =>
          state.pinnedKeys.includes(key)
            ? state
            : { pinnedKeys: [...state.pinnedKeys, key] }
        );
      },

      unpin: (channel) => {
        const key = entityScopeKey(channel.scope, channel.id);
        set((state) => ({
          pinnedKeys: state.pinnedKeys.filter((k) => k !== key),
        }));
      },

      reorder: (channels) =>
        set((state) => {
          // Keep only currently-pinned keys, in the supplied order; append any
          // pinned key the caller omitted so nothing is silently dropped.
          const pinned = new Set(state.pinnedKeys);
          const seen = new Set<string>();
          const next: string[] = [];
          for (const channel of channels) {
            const k = entityScopeKey(channel.scope, channel.id);
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

      isPinned: (channel) => get().pinnedKeys.includes(entityScopeKey(channel.scope, channel.id)),
    }),
    {
      // Legacy keys have no account owner and must not be assigned to a new login.
      name: 'paracord:pinned-conversations-by-account',
      version: 1,
      partialize: state => ({ pinnedKeys: state.pinnedKeys }),
    }
  )
);
