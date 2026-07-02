import { create } from 'zustand';

const typingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

interface TypingState {
  typingByChannel: Record<string, string[]>;
  addTyping: (channelId: string, userId: string) => void;
  clearChannel: (channelId: string) => void;
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
    set((state) => ({
      typingByChannel: {
        ...state.typingByChannel,
        [channelId]: [],
      },
    })),
}));
