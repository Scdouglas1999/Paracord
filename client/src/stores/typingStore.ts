import { create } from 'zustand';

const typingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

interface TypingState {
  typingByChannel: Record<string, string[]>;
  addTyping: (channelId: string, userId: string) => void;
  clearChannel: (channelId: string) => void;
  reset: () => void;
}

export const useTypingStore = create<TypingState>()((set) => ({
  typingByChannel: {},

  addTyping: (channelId, userId) =>
    set((state) => {
      const channelUsers = state.typingByChannel[channelId] || [];
      const nextUsers = channelUsers.includes(userId)
        ? channelUsers
        : [...channelUsers, userId];

      const timeoutKey = `${channelId}:${userId}`;
      const existing = typingTimeouts.get(timeoutKey);
      if (existing) clearTimeout(existing);
      typingTimeouts.set(
        timeoutKey,
        setTimeout(() => {
          set((current) => {
            const users = (current.typingByChannel[channelId] || []).filter((u) => u !== userId);
            return {
              typingByChannel: {
                ...current.typingByChannel,
                [channelId]: users,
              },
            };
          });
          typingTimeouts.delete(timeoutKey);
        }, 8000)
      );

      return {
        typingByChannel: {
          ...state.typingByChannel,
          [channelId]: nextUsers,
        },
      };
    }),

  clearChannel: (channelId) =>
    set((state) => {
      // Cancel any pending per-user expiry timers for this channel so they
      // don't fire after the channel has been cleared (and leak in the Map).
      const prefix = `${channelId}:`;
      for (const [key, timer] of typingTimeouts) {
        if (key.startsWith(prefix)) {
          clearTimeout(timer);
          typingTimeouts.delete(key);
        }
      }
      return {
        typingByChannel: {
          ...state.typingByChannel,
          [channelId]: [],
        },
      };
    }),

  // Clears all typing state and cancels every pending timer. Wire this into the
  // auth logout flow alongside the other per-session store resets.
  reset: () => {
    for (const timer of typingTimeouts.values()) {
      clearTimeout(timer);
    }
    typingTimeouts.clear();
    set({ typingByChannel: {} });
  },
}));
