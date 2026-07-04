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
import { useServerListStore } from './serverListStore';

/**
 * Resolve the current user's id for the active server. Per-server user ids are
 * distinct snowflakes (see serverListStore `userId`), and the global authStore
 * stays LOCAL-only, so the active server's `userId` is authoritative for
 * matching gateway reaction echoes; fall back to the LOCAL authStore user.
 */
function currentServerUserId(): string | undefined {
  return useServerListStore.getState().getActiveServer()?.userId ?? useAuthStore.getState().user?.id;
}

const ENCRYPTED_DM_PLACEHOLDER = '[Encrypted message]';
const OFFLINE_QUEUE_STORAGE_KEY = 'offline-message-queue';

const _messageFetchControllers = new Map<string, AbortController>();

/**
 * Memory bounds for the in-store message cache. A channel keeps at most
 * MAX_MESSAGES_PER_CHANNEL messages (oldest trimmed, newest kept at the tail),
 * and at most MAX_CACHED_CHANNELS channels are retained — least-recently-used
 * channels are evicted first, but never the channel the user is viewing.
 */
export const MAX_MESSAGES_PER_CHANNEL = 500;
export const MAX_CACHED_CHANNELS = 25;

// Channel access recency for LRU eviction; iteration order is oldest-first.
const _channelAccessOrder = new Set<string>();

function touchChannel(channelId: string): void {
  _channelAccessOrder.delete(channelId);
  _channelAccessOrder.add(channelId);
}

function forgetChannel(channelId: string): void {
  _channelAccessOrder.delete(channelId);
}

/**
 * Trim a channel's message list to MAX_MESSAGES_PER_CHANNEL, preserving order.
 * By default the newest N are kept (oldest trimmed) — correct for live appends.
 * When `trimNewest` is set (backward pagination via `before`), the oldest N are
 * kept instead, so a just-fetched older page is retained rather than sliced off
 * the head — otherwise scroll-back would wall at the cap and refetch the same
 * discarded page forever.
 */
function capChannelMessages(messages: Message[], trimNewest = false): Message[] {
  if (messages.length <= MAX_MESSAGES_PER_CHANNEL) return messages;
  return trimNewest
    ? messages.slice(0, MAX_MESSAGES_PER_CHANNEL)
    : messages.slice(messages.length - MAX_MESSAGES_PER_CHANNEL);
}

function activeChannelId(): string | null {
  try {
    return useChannelStore.getState().selectedChannelId ?? null;
  } catch {
    return null;
  }
}

/**
 * When more than MAX_CACHED_CHANNELS channels are cached, drop the
 * least-recently-used channels (never the active one) and clear every
 * channel-keyed map plus module-level bookkeeping (pending reaction keys,
 * in-flight fetches) for the dropped channels. Returns the pruned maps to
 * merge into state, or null when nothing needs eviction.
 */
function evictChannels(state: MessageState): Partial<MessageState> | null {
  const cached = Object.keys(state.messages);
  const overflow = cached.length - MAX_CACHED_CHANNELS;
  if (overflow <= 0) return null;

  const active = activeChannelId();
  const rank = new Map<string, number>();
  let order = 1;
  for (const id of _channelAccessOrder) rank.set(id, order++);
  // Oldest access (or never-touched channels, rank 0) evicted first.
  const victims = cached
    .filter((id) => id !== active)
    .sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))
    .slice(0, overflow);
  if (victims.length === 0) return null;

  const messages = { ...state.messages };
  const hasMore = { ...state.hasMore };
  const loading = { ...state.loading };
  const messageErrors = { ...state.messageErrors };
  const pins = { ...state.pins };
  for (const channelId of victims) {
    for (const message of messages[channelId] ?? []) {
      _pendingReactionKeys.delete(message.id);
    }
    cancelMessageFetch(channelId);
    forgetChannel(channelId);
    delete messages[channelId];
    delete hasMore[channelId];
    delete loading[channelId];
    delete messageErrors[channelId];
    delete pins[channelId];
  }
  return { messages, hasMore, loading, messageErrors, pins };
}

/**
 * Merge a state patch and then run LRU channel eviction against the resulting
 * state, folding any pruned maps back into the patch. Use at every site that
 * may introduce or grow a channel's message list.
 */
function applyEviction(state: MessageState, patch: Partial<MessageState>): Partial<MessageState> {
  const eviction = evictChannels({ ...state, ...patch });
  return eviction ? { ...patch, ...eviction } : patch;
}

/**
 * Normalize an emoji value (either a plain unicode/string key or a partial
 * emoji object carrying `{ id, name }`) into a stable comparison key. Matches
 * the semantics of the gateway-consolidation `resolveEmojiKey` helper: prefer a
 * custom emoji `id`, fall back to `name`, then to the raw string.
 */
function resolveEmojiKey(emoji: string | { id?: string | null; name?: string | null }): string {
  if (typeof emoji === 'string') return emoji;
  if (emoji.id) return emoji.id;
  if (emoji.name) return emoji.name;
  return '';
}

/**
 * Per-message set of pending optimistic reaction changes, keyed by
 * `${emojiKey}\u0000${userId}`. addReaction/removeReaction record the current
 * user's optimistic change here; the matching gateway echo consumes the key and
 * skips its own increment/decrement so the actor's reaction is not counted
 * twice. Keys for other users (or echoes without a prior optimistic update) are
 * never present, so those changes still apply normally.
 */
const _pendingReactionKeys = new Map<string, Set<string>>();

function pendingReactionKey(emojiKey: string, userId: string): string {
  return `${emojiKey}\u0000${userId}`;
}

function markPendingReaction(messageId: string, emojiKey: string, userId: string): void {
  let set = _pendingReactionKeys.get(messageId);
  if (!set) {
    set = new Set<string>();
    _pendingReactionKeys.set(messageId, set);
  }
  set.add(pendingReactionKey(emojiKey, userId));
}

function clearPendingReaction(messageId: string, emojiKey: string, userId: string): void {
  const set = _pendingReactionKeys.get(messageId);
  if (!set) return;
  set.delete(pendingReactionKey(emojiKey, userId));
  if (set.size === 0) _pendingReactionKeys.delete(messageId);
}

/**
 * Consume a pending optimistic reaction key if present. Returns true when the
 * gateway echo matched (and should therefore be ignored to avoid double
 * counting), false otherwise.
 */
function consumePendingReaction(messageId: string, emojiKey: string, userId: string): boolean {
  const set = _pendingReactionKeys.get(messageId);
  if (!set) return false;
  const key = pendingReactionKey(emojiKey, userId);
  if (!set.has(key)) return false;
  set.delete(key);
  if (set.size === 0) _pendingReactionKeys.delete(messageId);
  return true;
}

interface OfflineQueuedMessage {
  id: string;
  channelId: string;
  content: string;
  referencedMessageId?: string;
  nonce: string;
  createdAt: string;
}

function createMessageNonce(): string {
  return crypto.randomUUID();
}

function mergeMessageFields(existing: Message, incoming: Partial<Message>): Message {
  const merged: Message = { ...existing };
  for (const key of Object.keys(incoming) as (keyof Message)[]) {
    if (key === 'id') continue;
    const value = incoming[key];
    if (value !== undefined) {
      (merged as unknown as Record<string, unknown>)[key as string] = value;
    }
  }
  return merged;
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
  nonce?: string,
): Promise<SendMessageRequest> {
  const normalizedContent = content.trim();
  const request: SendMessageRequest = {
    content: normalizedContent,
    referenced_message_id: referencedMessageId,
    attachment_ids: attachmentIds,
    sticker_ids: stickerIds,
    nonce: nonce ?? createMessageNonce(),
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
  // Last fetch error per channel: message string on failure, null/absent when
  // the last fetch succeeded. Lets the UI distinguish a failed fetch from an
  // empty channel.
  messageErrors: Record<string, string | null>;
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
  editScheduledMessage: (
    channelId: string,
    scheduledMessageId: string,
    content: string,
    sendAtIso: string,
    e2ee?: unknown,
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
  updateMessage: (channelId: string, message: Partial<Message> & Pick<Message, 'id'>) => void;
  removeMessage: (channelId: string, messageId: string) => void;
  removeMessages: (channelId: string, messageIds: string[]) => void;
}

export const useMessageStore = create<MessageState>()((set, get) => ({
  messages: {},
  hasMore: {},
  loading: {},
  messageErrors: {},
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

    set((state) => ({
      loading: { ...state.loading, [channelId]: true },
      // Clear any prior error when a fresh fetch/retry starts.
      messageErrors: { ...state.messageErrors, [channelId]: null },
    }));

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
          touchChannel(channelId);
          set((state) => {
            const existing = params?.before ? state.messages[channelId] || [] : [];
            // API returns newest first (ORDER BY id DESC); reverse to
            // chronological order (oldest at top, newest at bottom).
            const sorted = [...decrypted].reverse();
            const merged = params?.before ? [...sorted, ...existing] : sorted;
            const nextMessages = {
              ...state.messages,
              [channelId]: capChannelMessages(merged, !!params?.before),
            };
            return applyEviction(state, {
              messages: nextMessages,
              hasMore: {
                ...state.hasMore,
                [channelId]: decrypted.length >= DEFAULT_MESSAGE_FETCH_LIMIT,
              },
              messageErrors: { ...state.messageErrors, [channelId]: null },
            });
          });
          return;
        } catch (err) {
          if (axios.isCancel(err) || controller.signal.aborted) return;
          lastErr = err;
        }
      }
      const errorMessage = extractApiError(lastErr);
      set((state) => ({
        messageErrors: { ...state.messageErrors, [channelId]: errorMessage },
      }));
      toast.error(`Failed to load messages: ${errorMessage}`);
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
      touchChannel(channelId);
      set((state) => {
        const existing = state.messages[channelId] || [];
        if (existing.some((m) => m.id === decrypted.id)) return state;
        return applyEviction(state, {
          messages: { ...state.messages, [channelId]: capChannelMessages([...existing, decrypted]) },
        });
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
        nonce: createMessageNonce(),
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
      ...(referencedMessageId ? { reference_message_id: referencedMessageId } : {}),
    } as Parameters<typeof channelApi.createScheduledMessage>[1]);
  },

  editScheduledMessage: async (channelId, scheduledMessageId, content, sendAtIso, e2ee) => {
    const normalized = content.trim();
    if (!normalized && e2ee === undefined) {
      return;
    }
    const request = await buildSendMessageRequest(channelId, normalized);
    await channelApi.updateScheduledMessage(channelId, scheduledMessageId, {
      content: request.content || undefined,
      e2ee: e2ee ?? request.e2ee,
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
          undefined,
          undefined,
          queued.nonce,
        );
        const { data } = await channelApi.sendMessage(queued.channelId, request);
        const decrypted = await decryptMessageForChannel(queued.channelId, data);
        if (decrypted.poll) {
          usePollStore.getState().upsertPoll(decrypted.poll);
        }
        touchChannel(queued.channelId);
        set((state) => {
          const existing = state.messages[queued.channelId] || [];
          const nextQueue = state.offlineQueue.filter((item) => item.id !== queued.id);
          persistOfflineQueue(nextQueue);
          if (existing.some((m) => m.id === decrypted.id)) {
            return { offlineQueue: nextQueue };
          }
          return applyEviction(state, {
            offlineQueue: nextQueue,
            messages: {
              ...state.messages,
              [queued.channelId]: capChannelMessages([...existing, decrypted]),
            },
          });
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

  setMessages: (channelId, messages) => {
    touchChannel(channelId);
    set((state) =>
      applyEviction(state, {
        messages: { ...state.messages, [channelId]: capChannelMessages(messages) },
      }),
    );
  },

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
    const emojiKey = resolveEmojiKey(emoji);
    const currentUserId = currentServerUserId();
    // Snapshot for rollback on failure
    const snapshot = (get().messages[channelId] || []).find((m) => m.id === messageId)?.reactions;
    // Record the pending optimistic add so the gateway echo for our own user is
    // ignored instead of double-counted.
    if (currentUserId) markPendingReaction(messageId, emojiKey, currentUserId);
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
      // The optimistic add is being rolled back, so drop the pending key: no
      // echo will arrive, and if one somehow does it should apply normally.
      if (currentUserId) clearPendingReaction(messageId, emojiKey, currentUserId);
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
    const emojiKey = resolveEmojiKey(emoji);
    const currentUserId = currentServerUserId();
    // Snapshot for rollback on failure
    const snapshot = (get().messages[channelId] || []).find((m) => m.id === messageId)?.reactions;
    // Record the pending optimistic remove so the gateway echo for our own user
    // is ignored instead of double-decremented.
    if (currentUserId) markPendingReaction(messageId, emojiKey, currentUserId);
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
      // The optimistic remove is being rolled back, so drop the pending key: no
      // echo will arrive, and if one somehow does it should apply normally.
      if (currentUserId) clearPendingReaction(messageId, emojiKey, currentUserId);
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
  handleReactionAdd: (channelId, messageId, emoji, _userId, currentUserId) => {
    const emojiKey = resolveEmojiKey(emoji);
    const isMe = _userId === currentUserId;
    // If this is the actor's own echo for an add we already applied
    // optimistically, consume the pending key and skip to avoid double-counting.
    // Echoes from other users, or the actor's echo on another device (no pending
    // key), fall through and apply normally.
    if (isMe && consumePendingReaction(messageId, emojiKey, currentUserId)) {
      return;
    }
    set((state) => {
      const existing = state.messages[channelId] || [];
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) => {
            if (m.id !== messageId) return m;
            const reactions = [...((m.reactions || []) as Array<{ emoji: string; count: number; me: boolean }>)];
            const idx = reactions.findIndex((r) => resolveEmojiKey(r.emoji) === emojiKey);
            if (idx >= 0) {
              reactions[idx] = {
                ...reactions[idx],
                count: reactions[idx].count + 1,
                me: reactions[idx].me || isMe,
              };
            } else {
              reactions.push({ emoji: emojiKey, count: 1, me: isMe });
            }
            return { ...m, reactions };
          }),
        },
      };
    });
  },

  handleReactionRemove: (channelId, messageId, emoji, _userId, currentUserId) => {
    const emojiKey = resolveEmojiKey(emoji);
    const isMe = _userId === currentUserId;
    // If this is the actor's own echo for a remove we already applied
    // optimistically, consume the pending key and skip to avoid under-counting.
    if (isMe && consumePendingReaction(messageId, emojiKey, currentUserId)) {
      return;
    }
    set((state) => {
      const existing = state.messages[channelId] || [];
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) => {
            if (m.id !== messageId) return m;
            let reactions = [...((m.reactions || []) as Array<{ emoji: string; count: number; me: boolean }>)];
            const idx = reactions.findIndex((r) => resolveEmojiKey(r.emoji) === emojiKey);
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
    });
  },

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
    touchChannel(channelId);
    set((state) => {
      const existing = state.messages[channelId] || [];
      if (existing.some((m) => m.id === message.id)) return state;
      const incomingNonce = (message as { nonce?: string }).nonce;
      if (incomingNonce && existing.some((m) => (m as { nonce?: string }).nonce === incomingNonce)) {
        return state;
      }
      const nextDecrypting = isE2ee ? new Set(state.decryptingIds).add(message.id) : state.decryptingIds;
      return applyEviction(state, {
        messages: { ...state.messages, [channelId]: capChannelMessages([...existing, baseMessage]) },
        decryptingIds: nextDecrypting,
      });
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
    set((state) => {
      const existing = state.messages[channelId] || [];
      const current = existing.find((m) => m.id === message.id);
      if (!current) return state;
      const merged = mergeMessageFields(current, message);
      const isE2ee = message.e2ee !== undefined ? Boolean(message.e2ee) : Boolean(merged.e2ee);
      const baseMessage: Message = {
        ...merged,
        content:
          isE2ee && message.content === undefined
            ? current.content
            : isE2ee
              ? ''
              : merged.content,
      };
      if (baseMessage.poll) {
        usePollStore.getState().upsertPoll(baseMessage.poll);
      }
      const nextDecrypting = isE2ee && message.e2ee !== undefined
        ? new Set(state.decryptingIds).add(message.id)
        : state.decryptingIds;
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) => (m.id === baseMessage.id ? baseMessage : m)),
        },
        decryptingIds: nextDecrypting,
      };
    });
    const existingMessage = get().messages[channelId]?.find((m) => m.id === message.id);
    const shouldDecrypt = message.e2ee !== undefined
      ? Boolean(message.e2ee)
      : Boolean(existingMessage?.e2ee);
    if (shouldDecrypt && message.e2ee !== undefined) {
      void decryptMessageForChannel(channelId, mergeMessageFields(existingMessage!, message)).then((decrypted) => {
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
