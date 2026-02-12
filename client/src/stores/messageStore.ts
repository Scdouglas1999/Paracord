import { create } from 'zustand';
import type { Message, PaginationParams } from '../types';
import { channelApi } from '../api/channels';
import { DEFAULT_MESSAGE_FETCH_LIMIT } from '../lib/constants';

interface MessageState {
  // Messages indexed by channel ID (kept as Record for backward compat)
  messages: Record<string, Message[]>;
  // Tracks whether there are more messages to fetch per channel
  hasMore: Record<string, boolean>;
  // Loading state per channel
  loading: Record<string, boolean>;
  // Pinned messages per channel
  pins: Record<string, Message[]>;

  fetchMessages: (channelId: string, params?: PaginationParams) => Promise<void>;
  sendMessage: (
    channelId: string,
    content: string,
    referencedMessageId?: string,
    attachmentIds?: string[]
  ) => Promise<void>;
  editMessage: (channelId: string, messageId: string, content: string) => Promise<void>;
  deleteMessage: (channelId: string, messageId: string) => Promise<void>;
  setMessages: (channelId: string, messages: Message[]) => void;

  // Pin operations
  fetchPins: (channelId: string) => Promise<void>;
  pinMessage: (channelId: string, messageId: string) => Promise<void>;
  unpinMessage: (channelId: string, messageId: string) => Promise<void>;

  // Reaction operations
  addReaction: (channelId: string, messageId: string, emoji: string) => Promise<void>;
  removeReaction: (channelId: string, messageId: string, emoji: string) => Promise<void>;

  // Reaction gateway event handlers
  handleReactionAdd: (channelId: string, messageId: string, emoji: string, userId: string, currentUserId: string) => void;
  handleReactionRemove: (channelId: string, messageId: string, emoji: string, userId: string, currentUserId: string) => void;

  // Pin state update
  updatePinState: (channelId: string, messageId: string, pinned: boolean) => void;

  // Gateway event handlers
  addMessage: (channelId: string, message: Message) => void;
  updateMessage: (channelId: string, message: Message) => void;
  removeMessage: (channelId: string, messageId: string) => void;
}

export const useMessageStore = create<MessageState>()((set, get) => ({
  messages: {},
  hasMore: {},
  loading: {},
  pins: {},

  fetchMessages: async (channelId, params) => {
    if (get().loading[channelId]) return;
    set((state) => ({ loading: { ...state.loading, [channelId]: true } }));
    try {
      const { data } = await channelApi.getMessages(channelId, {
        limit: DEFAULT_MESSAGE_FETCH_LIMIT,
        ...params,
      });
      set((state) => {
        const existing = params?.before ? state.messages[channelId] || [] : [];
        // API returns newest first (ORDER BY id DESC); reverse to
        // chronological order (oldest at top, newest at bottom).
        const sorted = [...data].reverse();
        const merged = params?.before ? [...sorted, ...existing] : sorted;
        return {
          messages: { ...state.messages, [channelId]: merged },
          hasMore: { ...state.hasMore, [channelId]: data.length >= DEFAULT_MESSAGE_FETCH_LIMIT },
          loading: { ...state.loading, [channelId]: false },
        };
      });
    } catch {
      set((state) => ({ loading: { ...state.loading, [channelId]: false } }));
    }
  },

  sendMessage: async (channelId, content, referencedMessageId, attachmentIds) => {
    const { data } = await channelApi.sendMessage(channelId, {
      content,
      referenced_message_id: referencedMessageId,
      attachment_ids: attachmentIds,
    });
    // Optimistic: the gateway will also deliver MESSAGE_CREATE, addMessage dedupes
    set((state) => {
      const existing = state.messages[channelId] || [];
      if (existing.some((m) => m.id === data.id)) return state;
      return { messages: { ...state.messages, [channelId]: [...existing, data] } };
    });
  },

  editMessage: async (channelId, messageId, content) => {
    const { data } = await channelApi.editMessage(channelId, messageId, content);
    set((state) => {
      const existing = state.messages[channelId] || [];
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) => (m.id === messageId ? data : m)),
        },
      };
    });
  },

  deleteMessage: async (channelId, messageId) => {
    await channelApi.deleteMessage(channelId, messageId);
    set((state) => {
      const existing = state.messages[channelId] || [];
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.filter((m) => m.id !== messageId),
        },
      };
    });
  },

  setMessages: (channelId, messages) =>
    set((state) => ({ messages: { ...state.messages, [channelId]: messages } })),

  fetchPins: async (channelId) => {
    try {
      const { data } = await channelApi.getPins(channelId);
      set((state) => ({ pins: { ...state.pins, [channelId]: data } }));
    } catch {
      /* ignore */
    }
  },

  pinMessage: async (channelId, messageId) => {
    await channelApi.pinMessage(channelId, messageId);
    // Update pinned flag on the message in the message list
    set((state) => {
      const existing = state.messages[channelId] || [];
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) =>
            m.id === messageId ? { ...m, pinned: true } : m
          ),
        },
      };
    });
    // Refresh pins list
    get().fetchPins(channelId);
  },

  unpinMessage: async (channelId, messageId) => {
    await channelApi.unpinMessage(channelId, messageId);
    // Update pinned flag on the message in the message list
    set((state) => {
      const existing = state.messages[channelId] || [];
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) =>
            m.id === messageId ? { ...m, pinned: false } : m
          ),
        },
        pins: {
          ...state.pins,
          [channelId]: (state.pins[channelId] || []).filter((m) => m.id !== messageId),
        },
      };
    });
  },

  addReaction: async (channelId, messageId, emoji) => {
    // Optimistic update: immediately show the reaction locally
    set((state) => {
      const existing = state.messages[channelId] || [];
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) => {
            if (m.id !== messageId) return m;
            const reactions = [...((m.reactions || []) as Array<{ emoji: string; count: number; me: boolean }>)];
            const idx = reactions.findIndex((r) => r.emoji === emoji);
            if (idx >= 0) {
              if (!reactions[idx].me) {
                reactions[idx] = { ...reactions[idx], count: reactions[idx].count + 1, me: true };
              }
            } else {
              reactions.push({ emoji, count: 1, me: true });
            }
            return { ...m, reactions };
          }),
        },
      };
    });
    await channelApi.addReaction(channelId, messageId, emoji);
  },

  removeReaction: async (channelId, messageId, emoji) => {
    // Optimistic update: immediately remove the reaction locally
    set((state) => {
      const existing = state.messages[channelId] || [];
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) => {
            if (m.id !== messageId) return m;
            let reactions = [...((m.reactions || []) as Array<{ emoji: string; count: number; me: boolean }>)];
            const idx = reactions.findIndex((r) => r.emoji === emoji);
            if (idx >= 0) {
              if (reactions[idx].count <= 1) {
                reactions = reactions.filter((_, i) => i !== idx);
              } else {
                reactions[idx] = { ...reactions[idx], count: reactions[idx].count - 1, me: false };
              }
            }
            return { ...m, reactions };
          }),
        },
      };
    });
    await channelApi.removeReaction(channelId, messageId, emoji);
  },

  // Reaction gateway event handlers
  handleReactionAdd: (channelId, messageId, emoji, _userId, currentUserId) =>
    set((state) => {
      const existing = state.messages[channelId] || [];
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) => {
            if (m.id !== messageId) return m;
            const reactions = [...((m.reactions || []) as Array<{ emoji: string; count: number; me: boolean }>)];
            const idx = reactions.findIndex((r) => r.emoji === emoji);
            const isMe = _userId === currentUserId;
            if (idx >= 0) {
              reactions[idx] = {
                ...reactions[idx],
                count: reactions[idx].count + 1,
                me: reactions[idx].me || isMe,
              };
            } else {
              reactions.push({ emoji, count: 1, me: isMe });
            }
            return { ...m, reactions };
          }),
        },
      };
    }),

  handleReactionRemove: (channelId, messageId, emoji, _userId, currentUserId) =>
    set((state) => {
      const existing = state.messages[channelId] || [];
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) => {
            if (m.id !== messageId) return m;
            let reactions = [...((m.reactions || []) as Array<{ emoji: string; count: number; me: boolean }>)];
            const idx = reactions.findIndex((r) => r.emoji === emoji);
            const isMe = _userId === currentUserId;
            if (idx >= 0) {
              if (reactions[idx].count <= 1) {
                reactions = reactions.filter((_, i) => i !== idx);
              } else {
                reactions[idx] = {
                  ...reactions[idx],
                  count: reactions[idx].count - 1,
                  me: isMe ? false : reactions[idx].me,
                };
              }
            }
            return { ...m, reactions };
          }),
        },
      };
    }),

  // Pin state update
  updatePinState: (channelId, messageId, pinned) =>
    set((state) => {
      const existing = state.messages[channelId] || [];
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) =>
            m.id === messageId ? { ...m, pinned } : m
          ),
        },
      };
    }),

  // Gateway event handlers
  addMessage: (channelId, message) =>
    set((state) => {
      const existing = state.messages[channelId] || [];
      if (existing.some((m) => m.id === message.id)) return state;
      return { messages: { ...state.messages, [channelId]: [...existing, message] } };
    }),

  updateMessage: (channelId, message) =>
    set((state) => {
      const existing = state.messages[channelId] || [];
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) => (m.id === message.id ? message : m)),
        },
      };
    }),

  removeMessage: (channelId, messageId) =>
    set((state) => {
      const existing = state.messages[channelId] || [];
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.filter((m) => m.id !== messageId),
        },
      };
    }),
}));
