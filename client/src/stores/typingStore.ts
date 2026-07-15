import { create } from 'zustand';

const typingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

interface TypingState {
  typingByChannel: Record<string, string[]>;
  addTyping: (channelId: string, userId: string) => void;
  clearChannel: (channelId: string) => void;
  reset: () => void;
}

export const useTypingStore = create<TypingState>()((set, get) => ({
  typingByChannel: {},

  addTyping: (channelId, userId) => {
    // Always refresh the expiry timer, even when the user is already listed.
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

    // No-op store update when the user is already typing — avoids cloning the
    // channel map / notifying subscribers on every TYPING_START refresh.
    const channelUsers = get().typingByChannel[channelId] || [];
    if (channelUsers.includes(userId)) return;

    set((state) => ({
      typingByChannel: {
        ...state.typingByChannel,
        [channelId]: [...(state.typingByChannel[channelId] || []), userId],
      },
    }));
  },

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

  // Clears all typing state and cancels every pending timer. Called from the
  // auth logout flow (clearAuthState) so typing state does not leak sessions.
  reset: () => {
    for (const timer of typingTimeouts.values()) {
      clearTimeout(timer);
    }
    typingTimeouts.clear();
    set({ typingByChannel: {} });
  },
}));
