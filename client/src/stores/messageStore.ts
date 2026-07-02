import axios from 'axios';
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
import { encryptDmMessageV2 } from '../lib/dmE2ee';
import { decryptDmMessageOffthread } from '../lib/dmE2eeWorker';
import { hasUnlockedPrivateKey, withUnlockedPrivateKey } from '../lib/accountSession';
import { decryptGroupDmMessage, encryptGroupDmMessage } from '../lib/groupDmE2ee';
import { useChannelStore } from './channelStore';
import { toast } from './toastStore';
import { usePollStore } from './pollStore';
import { getVersionedJson, setVersionedJson } from '../lib/versionedStorage';
import { useAuthStore } from './authStore';

const ENCRYPTED_DM_PLACEHOLDER = '[Encrypted message]';
const OFFLINE_QUEUE_STORAGE_KEY = 'offline-message-queue';

const _messageFetchControllers = new Map<string, AbortController>();

interface OfflineQueuedMessage {
  id: string;
  channelId: string;
  content: string;
  referencedMessageId?: string;
  createdAt: string;
}

function loadOfflineQueue(): OfflineQueuedMessage[] {
  return getVersionedJson<OfflineQueuedMessage[]>(OFFLINE_QUEUE_STORAGE_KEY, []);
}

function persistOfflineQueue(queue: OfflineQueuedMessage[]): void {
  setVersionedJson(OFFLINE_QUEUE_STORAGE_KEY, queue);
}

function shouldQueueMessageError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (!axios.isAxiosError(err)) return false;
  if (err.code === 'ERR_NETWORK' || err.code === 'ECONNABORTED') return true;
  if (!err.response) return true;
  return err.response.status >= 500;
}

/** Cancel any in-flight message fetch for the given channel. */
export function cancelMessageFetch(channelId: string): void {
  const controller = _messageFetchControllers.get(channelId);
  if (controller) {
    controller.abort();
    _messageFetchControllers.delete(channelId);
  }
}

function findChannel(channelId: string) {
  const channelsByGuild = useChannelStore.getState().channelsByGuild;
  for (const channels of Object.values(channelsByGuild)) {
    const channel = channels.find((entry) => entry.id === channelId);
    if (channel) return channel;
  }
  return null;
}

function getChannelType(channelId: string): number | null {
  const channel = findChannel(channelId);
  if (!channel) return null;
  return channel.channel_type ?? channel.type ?? null;
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

function getGroupDmRecipients(channelId: string): Array<{ id: string; public_key?: string | null }> {
  const channel = findChannel(channelId);
  if (!channel) return [];
  const channelType = channel.channel_type ?? channel.type;
  if (channelType !== 3 || channel.guild_id) return [];
  return (channel.recipients || []).map((recipient) => ({
    id: recipient.id,
    public_key: recipient.public_key,
  }));
}

function isGroupDmChannel(channelId: string): boolean {
  return getChannelType(channelId) === 3;
}

function isDmChannel(channelId: string): boolean {
  const channel = findChannel(channelId);
  if (!channel) return false;
  const channelType = channel.channel_type ?? channel.type;
  return (channelType === 1 || channelType === 3) && !channel.guild_id;
}

async function decryptMessageForChannel(channelId: string, message: Message): Promise<Message> {
  const payload = message.e2ee;
  if (!payload) return message;
  if (!hasUnlockedPrivateKey()) {
    return {
      ...message,
      content: message.content ?? ENCRYPTED_DM_PLACEHOLDER,
    };
  }

  if (isGroupDmChannel(channelId)) {
    const myUser = useAuthStore.getState().user;
    if (!myUser?.id) {
      return {
        ...message,
        content: ENCRYPTED_DM_PLACEHOLDER,
      };
    }
    const recipients = getGroupDmRecipients(channelId);
    const resolvePublicKey = (userId: string): string | null => {
      if (userId === myUser.id) {
        return myUser.public_key || null;
      }
      const found = recipients.find((recipient) => recipient.id === userId);
      return found?.public_key || null;
    };
    try {
      const plaintext = await withUnlockedPrivateKey((privateKey) =>
        decryptGroupDmMessage(channelId, payload, myUser.id, privateKey, resolvePublicKey)
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

  const peerPublicKey = getDmPeerPublicKey(channelId);
  if (!peerPublicKey) {
    return {
      ...message,
      content: message.content ?? ENCRYPTED_DM_PLACEHOLDER,
    };
  }
  try {
    const plaintext = await withUnlockedPrivateKey((privateKey) =>
      decryptDmMessageOffthread(channelId, payload, privateKey, peerPublicKey)
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
  stickerIds?: string[],
): Promise<SendMessageRequest> {
  const normalizedContent = content.trim();
  const request: SendMessageRequest = {
    content: normalizedContent,
    referenced_message_id: referencedMessageId,
    attachment_ids: attachmentIds,
    sticker_ids: stickerIds,
  };
  if (!isDmChannel(channelId) || normalizedContent.length === 0) {
    return request;
  }

  if (isGroupDmChannel(channelId)) {
    if (!hasUnlockedPrivateKey()) {
      throw new Error('Unlock your account to send encrypted DMs');
    }
    const myUser = useAuthStore.getState().user;
    if (!myUser?.id) {
      throw new Error('Unable to encrypt this group DM: user identity is unavailable');
    }
    const recipients = getGroupDmRecipients(channelId);
    if (recipients.length === 0) {
      throw new Error('Unable to encrypt this group DM: recipient keys are unavailable');
    }
    const e2ee = await withUnlockedPrivateKey((privateKey) =>
      encryptGroupDmMessage(channelId, normalizedContent, myUser.id, privateKey, recipients)
    );
    request.content = '';
    request.e2ee = e2ee;
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
  if (!peerUserId) {
    throw new Error('Unable to encrypt this DM: recipient identity is unavailable');
  }
  const e2ee = await withUnlockedPrivateKey((privateKey) =>
    encryptDmMessageV2(channelId, normalizedContent, privateKey, peerPublicKey, peerUserId)
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

  if (isGroupDmChannel(channelId)) {
    if (!hasUnlockedPrivateKey()) {
      throw new Error('Unlock your account to edit encrypted DMs');
    }
    const myUser = useAuthStore.getState().user;
    if (!myUser?.id) {
      throw new Error('Unable to encrypt this group DM edit: user identity is unavailable');
    }
    const recipients = getGroupDmRecipients(channelId);
    if (recipients.length === 0) {
      throw new Error('Unable to encrypt this group DM edit: recipient keys are unavailable');
    }
    const e2ee: MessageE2eePayload = await withUnlockedPrivateKey((privateKey) =>
      encryptGroupDmMessage(channelId, normalizedContent, myUser.id, privateKey, recipients)
    );
    request.content = '';
    request.e2ee = e2ee;
    return request;
  }

  const peerPublicKey = getDmPeerPublicKey(channelId);
  if (!peerPublicKey) {
    throw new Error('Unable to encrypt this DM edit: recipient key is unavailable');
  }
  if (!hasUnlockedPrivateKey()) {
    throw new Error('Unlock your account to edit encrypted DMs');
  }

  const peerUserId = getDmPeerUserId(channelId);
  if (!peerUserId) {
    throw new Error('Unable to encrypt this DM edit: recipient identity is unavailable');
  }
  const e2ee: MessageE2eePayload = await withUnlockedPrivateKey((privateKey) =>
    encryptDmMessageV2(channelId, normalizedContent, privateKey, peerPublicKey, peerUserId)
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
  // Messages composed while offline and awaiting retry
  offlineQueue: OfflineQueuedMessage[];

  fetchMessages: (channelId: string, params?: PaginationParams) => Promise<void>;
  sendMessage: (
    channelId: string,
    content: string,
    referencedMessageId?: string,
    attachmentIds?: string[],
    stickerIds?: string[]
  ) => Promise<void>;
  scheduleMessage: (
    channelId: string,
    content: string,
    sendAtIso: string,
    referencedMessageId?: string,
  ) => Promise<void>;
  flushOfflineQueue: () => Promise<void>;
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
  offlineQueue: loadOfflineQueue(),

  fetchMessages: async (channelId, params) => {
    if (get().loading[channelId]) return;

    // Abort any in-flight fetch for a different channel
    for (const [key, ctrl] of _messageFetchControllers) {
      if (key !== channelId) {
        ctrl.abort();
        _messageFetchControllers.delete(key);
      }
    }

    set((state) => ({ loading: { ...state.loading, [channelId]: true } }));

    const controller = new AbortController();
    _messageFetchControllers.set(channelId, controller);

    const MAX_RETRIES = 2;
    const RETRY_DELAY = 300;
    const REQUEST_TIMEOUT = 5_000;
    let lastErr: unknown;
    try {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (controller.signal.aborted) return;
        try {
          if (attempt > 0) {
            await new Promise((r) => setTimeout(r, RETRY_DELAY * attempt));
          }
          if (controller.signal.aborted) return;
          const { data } = await channelApi.getMessages(
            channelId,
            { limit: DEFAULT_MESSAGE_FETCH_LIMIT, ...params },
            {
              timeout: REQUEST_TIMEOUT,
              signal: controller.signal,
            },
          );
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
          return;
        } catch (err) {
          if (axios.isCancel(err) || controller.signal.aborted) return;
          lastErr = err;
        }
      }
      toast.error(`Failed to load messages: ${extractApiError(lastErr)}`);
    } finally {
      set((state) => ({ loading: { ...state.loading, [channelId]: false } }));
      _messageFetchControllers.delete(channelId);
    }
  },

  sendMessage: async (channelId, content, referencedMessageId, attachmentIds, stickerIds) => {
    const normalized = content.trim();
    if (!normalized && !(attachmentIds && attachmentIds.length > 0) && !(stickerIds && stickerIds.length > 0)) {
      return;
    }
    const request = await buildSendMessageRequest(
      channelId,
      content,
      referencedMessageId,
      attachmentIds,
      stickerIds,
    );
    try {
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
    } catch (err) {
      const networkQueueable = shouldQueueMessageError(err);
      const hasAttachments = (attachmentIds?.length ?? 0) > 0;
      if (!networkQueueable || hasAttachments || normalized.length === 0) {
        throw err;
      }
      const queued: OfflineQueuedMessage = {
        id: `offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        channelId,
        content: normalized,
        referencedMessageId,
        createdAt: new Date().toISOString(),
      };
      set((state) => {
        const next = [...state.offlineQueue, queued];
        persistOfflineQueue(next);
        return { offlineQueue: next };
      });
      toast.info('Message queued and will send when reconnected.');
    }
  },

  scheduleMessage: async (channelId, content, sendAtIso, referencedMessageId) => {
    const normalized = content.trim();
    if (!normalized) {
      return;
    }
    const request = await buildSendMessageRequest(channelId, normalized, referencedMessageId);
    await channelApi.createScheduledMessage(channelId, {
      content: request.content || undefined,
      e2ee: request.e2ee,
      nonce: request.nonce,
      send_at: sendAtIso,
    });
  },

  flushOfflineQueue: async () => {
    const queue = [...get().offlineQueue];
    if (queue.length === 0) return;

    for (const queued of queue) {
      try {
        const request = await buildSendMessageRequest(
          queued.channelId,
          queued.content,
          queued.referencedMessageId,
        );
        const { data } = await channelApi.sendMessage(queued.channelId, request);
        const decrypted = await decryptMessageForChannel(queued.channelId, data);
        if (decrypted.poll) {
          usePollStore.getState().upsertPoll(decrypted.poll);
        }
        set((state) => {
          const existing = state.messages[queued.channelId] || [];
          const nextQueue = state.offlineQueue.filter((item) => item.id !== queued.id);
          persistOfflineQueue(nextQueue);
          if (existing.some((m) => m.id === decrypted.id)) {
            return { offlineQueue: nextQueue };
          }
          return {
            offlineQueue: nextQueue,
            messages: {
              ...state.messages,
              [queued.channelId]: [...existing, decrypted],
            },
          };
        });
      } catch (err) {
        if (shouldQueueMessageError(err)) {
          // Still offline or server unavailable; keep remaining queue items.
          return;
        }
        // Drop malformed/non-retryable queued item and continue.
        set((state) => {
          const nextQueue = state.offlineQueue.filter((item) => item.id !== queued.id);
          persistOfflineQueue(nextQueue);
          return { offlineQueue: nextQueue };
        });
      }
    }
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
