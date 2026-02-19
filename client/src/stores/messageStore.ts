import { create } from 'zustand';
import type {
  EditMessageRequest,
  Message,
  MessageE2eePayload,
  PaginationParams,
  SendMessageRequest,
} from '../types';
import { channelApi } from '../api/channels';
import { extractApiError } from '../api/client';
import { DEFAULT_MESSAGE_FETCH_LIMIT } from '../lib/constants';
import { decryptDmMessage, encryptDmMessageV2 } from '../lib/dmE2ee';
import { hasUnlockedPrivateKey, withUnlockedPrivateKey } from '../lib/accountSession';
import { useChannelStore } from './channelStore';
import { toast } from './toastStore';
import { usePollStore } from './pollStore';

const ENCRYPTED_DM_PLACEHOLDER = '[Encrypted message]';

function findChannel(channelId: string) {
  const channelsByGuild = useChannelStore.getState().channelsByGuild;
  for (const channels of Object.values(channelsByGuild)) {
    const channel = channels.find((entry) => entry.id === channelId);
    if (channel) return channel;
  }
  return null;
}

function getDmPeerPublicKey(channelId: string): string | null {
  const channel = findChannel(channelId);
  if (!channel) return null;
  const channelType = channel.channel_type ?? channel.type;
  if (channelType !== 1 || channel.guild_id) return null;
  return channel.recipient?.public_key || null;
}

function getDmPeerUserId(channelId: string): string | null {
  const channel = findChannel(channelId);
  if (!channel) return null;
  const channelType = channel.channel_type ?? channel.type;
  if (channelType !== 1 || channel.guild_id) return null;
  return channel.recipient?.id || null;
}

function isDmChannel(channelId: string): boolean {
  const channel = findChannel(channelId);
  if (!channel) return false;
  const channelType = channel.channel_type ?? channel.type;
  return channelType === 1 && !channel.guild_id;
}

async function decryptMessageForChannel(channelId: string, message: Message): Promise<Message> {
  const payload = message.e2ee;
  if (!payload) return message;
  const peerPublicKey = getDmPeerPublicKey(channelId);
  if (!peerPublicKey || !hasUnlockedPrivateKey()) {
    return {
      ...message,
      content: message.content ?? ENCRYPTED_DM_PLACEHOLDER,
    };
  }
  try {
    const plaintext = await withUnlockedPrivateKey((privateKey) =>
      decryptDmMessage(channelId, payload, privateKey, peerPublicKey)
    );
    return {
      ...message,
      content: plaintext,
    };
  } catch {
    return {
      ...message,
      content: ENCRYPTED_DM_PLACEHOLDER,
    };
  }
}

async function decryptMessagesForChannel(channelId: string, messages: Message[]): Promise<Message[]> {
  return Promise.all(messages.map((message) => decryptMessageForChannel(channelId, message)));
}

async function buildSendMessageRequest(
  channelId: string,
  content: string,
  referencedMessageId?: string,
  attachmentIds?: string[],
): Promise<SendMessageRequest> {
  const normalizedContent = content.trim();
  const request: SendMessageRequest = {
    content: normalizedContent,
    referenced_message_id: referencedMessageId,
    attachment_ids: attachmentIds,
  };
  if (!isDmChannel(channelId) || normalizedContent.length === 0) {
    return request;
  }

  const peerPublicKey = getDmPeerPublicKey(channelId);
  if (!peerPublicKey) {
    throw new Error('Unable to encrypt this DM: recipient key is unavailable');
  }
  if (!hasUnlockedPrivateKey()) {
    throw new Error('Unlock your account to send encrypted DMs');
  }

  const peerUserId = getDmPeerUserId(channelId);
  const e2ee = await withUnlockedPrivateKey((privateKey) =>
    peerUserId
      ? encryptDmMessageV2(channelId, normalizedContent, privateKey, peerPublicKey, peerUserId)
      : encryptDmMessageV2(channelId, normalizedContent, privateKey, peerPublicKey, '')
  );
  request.content = '';
  request.e2ee = e2ee;
  return request;
}

async function buildEditMessageRequest(channelId: string, content: string): Promise<EditMessageRequest> {
  const normalizedContent = content.trim();
  const request: EditMessageRequest = { content: normalizedContent };
  if (!isDmChannel(channelId)) {
    return request;
  }
  if (!normalizedContent) {
    throw new Error('Encrypted DMs cannot be edited to empty content');
  }

  const peerPublicKey = getDmPeerPublicKey(channelId);
  if (!peerPublicKey) {
    throw new Error('Unable to encrypt this DM edit: recipient key is unavailable');
  }
  if (!hasUnlockedPrivateKey()) {
    throw new Error('Unlock your account to edit encrypted DMs');
  }

  const peerUserId = getDmPeerUserId(channelId);
  const e2ee: MessageE2eePayload = await withUnlockedPrivateKey((privateKey) =>
    peerUserId
      ? encryptDmMessageV2(channelId, normalizedContent, privateKey, peerPublicKey, peerUserId)
      : encryptDmMessageV2(channelId, normalizedContent, privateKey, peerPublicKey, '')
  );
  request.content = '';
  request.e2ee = e2ee;
  return request;
}

interface MessageState {
  // Messages indexed by channel ID (kept as Record for backward compat)
  messages: Record<string, Message[]>;
  // Tracks whether there are more messages to fetch per channel
  hasMore: Record<string, boolean>;
  // Loading state per channel
  loading: Record<string, boolean>;
  // Pinned messages per channel
  pins: Record<string, Message[]>;
  // Message IDs currently being decrypted (E2EE)
  decryptingIds: Set<string>;

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
  removeMessages: (channelId: string, messageIds: string[]) => void;
}

export const useMessageStore = create<MessageState>()((set, get) => ({
  messages: {},
  hasMore: {},
  loading: {},
  pins: {},
  decryptingIds: new Set<string>(),

  fetchMessages: async (channelId, params) => {
    if (get().loading[channelId]) return;
    set((state) => ({ loading: { ...state.loading, [channelId]: true } }));
    const MAX_RETRIES = 2;
    const RETRY_DELAY = 1500;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY * attempt));
        }
        const { data } = await channelApi.getMessages(channelId, {
          limit: DEFAULT_MESSAGE_FETCH_LIMIT,
          ...params,
        });
        const decrypted = await decryptMessagesForChannel(channelId, data);
        if (!params?.before) {
          usePollStore.getState().clearPollsForChannel(channelId);
        }
        for (const message of decrypted) {
          if (message.poll) {
            usePollStore.getState().upsertPoll(message.poll);
          }
        }
        set((state) => {
          const existing = params?.before ? state.messages[channelId] || [] : [];
          // API returns newest first (ORDER BY id DESC); reverse to
          // chronological order (oldest at top, newest at bottom).
          const sorted = [...decrypted].reverse();
          const merged = params?.before ? [...sorted, ...existing] : sorted;
          return {
            messages: { ...state.messages, [channelId]: merged },
            hasMore: {
              ...state.hasMore,
              [channelId]: decrypted.length >= DEFAULT_MESSAGE_FETCH_LIMIT,
            },
          };
        });
        set((state) => ({ loading: { ...state.loading, [channelId]: false } }));
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    toast.error(`Failed to load messages: ${extractApiError(lastErr)}`);
    set((state) => ({ loading: { ...state.loading, [channelId]: false } }));
  },

  sendMessage: async (channelId, content, referencedMessageId, attachmentIds) => {
    const request = await buildSendMessageRequest(
      channelId,
      content,
      referencedMessageId,
      attachmentIds,
    );
    const { data } = await channelApi.sendMessage(channelId, request);
    const decrypted = await decryptMessageForChannel(channelId, data);
    if (decrypted.poll) {
      usePollStore.getState().upsertPoll(decrypted.poll);
    }
    // Optimistic: the gateway will also deliver MESSAGE_CREATE, addMessage dedupes
    set((state) => {
      const existing = state.messages[channelId] || [];
      if (existing.some((m) => m.id === decrypted.id)) return state;
      return { messages: { ...state.messages, [channelId]: [...existing, decrypted] } };
    });
  },

  editMessage: async (channelId, messageId, content) => {
    const request = await buildEditMessageRequest(channelId, content);
    const { data } = await channelApi.editMessage(channelId, messageId, request);
    const decrypted = await decryptMessageForChannel(channelId, data);
    set((state) => {
      const existing = state.messages[channelId] || [];
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) => (m.id === messageId ? decrypted : m)),
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
      const decrypted = await decryptMessagesForChannel(channelId, data);
      set((state) => ({ pins: { ...state.pins, [channelId]: decrypted } }));
    } catch (err) {
      toast.error(`Failed to load pinned messages: ${extractApiError(err)}`);
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
    // Snapshot for rollback on failure
    const snapshot = (get().messages[channelId] || []).find((m) => m.id === messageId)?.reactions;
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
    try {
      await channelApi.addReaction(channelId, messageId, emoji);
    } catch {
      // Rollback optimistic update on failure
      if (snapshot !== undefined) {
        set((state) => {
          const existing = state.messages[channelId] || [];
          return {
            messages: {
              ...state.messages,
              [channelId]: existing.map((m) =>
                m.id === messageId ? { ...m, reactions: snapshot } : m
              ),
            },
          };
        });
      }
      toast.error('Failed to add reaction');
    }
  },

  removeReaction: async (channelId, messageId, emoji) => {
    // Snapshot for rollback on failure
    const snapshot = (get().messages[channelId] || []).find((m) => m.id === messageId)?.reactions;
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
    try {
      await channelApi.removeReaction(channelId, messageId, emoji);
    } catch {
      // Rollback optimistic update on failure
      if (snapshot !== undefined) {
        set((state) => {
          const existing = state.messages[channelId] || [];
          return {
            messages: {
              ...state.messages,
              [channelId]: existing.map((m) =>
                m.id === messageId ? { ...m, reactions: snapshot } : m
              ),
            },
          };
        });
      }
      toast.error('Failed to remove reaction');
    }
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
  addMessage: (channelId, message) => {
    const isE2ee = Boolean(message.e2ee);
    const baseMessage = {
      ...message,
      // Keep content empty while decrypting — the UI will show a skeleton
      content: isE2ee ? '' : message.content,
    };
    if (baseMessage.poll) {
      usePollStore.getState().upsertPoll(baseMessage.poll);
    }
    set((state) => {
      const existing = state.messages[channelId] || [];
      if (existing.some((m) => m.id === message.id)) return state;
      const nextDecrypting = isE2ee ? new Set(state.decryptingIds).add(message.id) : state.decryptingIds;
      return {
        messages: { ...state.messages, [channelId]: [...existing, baseMessage] },
        decryptingIds: nextDecrypting,
      };
    });
    if (isE2ee) {
      void decryptMessageForChannel(channelId, { ...message }).then((decrypted) => {
        set((state) => {
          const current = state.messages[channelId] || [];
          const nextDecrypting = new Set(state.decryptingIds);
          nextDecrypting.delete(message.id);
          return {
            messages: {
              ...state.messages,
              [channelId]: current.map((entry) =>
                entry.id === decrypted.id ? decrypted : entry
              ),
            },
            decryptingIds: nextDecrypting,
          };
        });
      });
    }
  },

  updateMessage: (channelId, message) => {
    const isE2ee = Boolean(message.e2ee);
    const baseMessage = {
      ...message,
      content: isE2ee ? '' : message.content,
    };
    if (baseMessage.poll) {
      usePollStore.getState().upsertPoll(baseMessage.poll);
    }
    set((state) => {
      const existing = state.messages[channelId] || [];
      const nextDecrypting = isE2ee ? new Set(state.decryptingIds).add(message.id) : state.decryptingIds;
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) => (m.id === baseMessage.id ? baseMessage : m)),
        },
        decryptingIds: nextDecrypting,
      };
    });
    if (isE2ee) {
      void decryptMessageForChannel(channelId, { ...message }).then((decrypted) => {
        set((state) => {
          const current = state.messages[channelId] || [];
          const nextDecrypting = new Set(state.decryptingIds);
          nextDecrypting.delete(message.id);
          return {
            messages: {
              ...state.messages,
              [channelId]: current.map((entry) =>
                entry.id === decrypted.id ? decrypted : entry
              ),
            },
            decryptingIds: nextDecrypting,
          };
        });
      });
    }
  },

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

  removeMessages: (channelId, messageIds) =>
    set((state) => {
      const existing = state.messages[channelId] || [];
      const idSet = new Set(messageIds);
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.filter((m) => !idSet.has(m.id)),
        },
      };
    }),
}));
