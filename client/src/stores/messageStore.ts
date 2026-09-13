import { getAccountChannelView } from '../lib/channelView';
import { getServerAccountScope } from '../lib/serverIdentity';
import { accountScopeKey, type AccountScope } from '../lib/serverScope';
import { captureScopedOperation, type OperationContext } from '../lib/operationContext';
import axios from 'axios';
import { create } from 'zustand';
import type {
  Message,
  MessageAuthor,
  PaginationParams,
  SendMessageRequest,
  User,
} from '../types';
import { createChannelApi } from '../api/channels';
import { extractApiError } from '../api/client';
import { DEFAULT_MESSAGE_FETCH_LIMIT } from '../lib/constants';
import { refreshGuildChannelVisibility } from './channelStore';
import { toast } from './toastStore';
import { usePollStore } from './pollStore';
import { useAuthStore } from './authStore';
import { useServerListStore } from './serverListStore';
import { registerSessionReset } from './sessionReset';
import { registerAccountHistoryReset } from '../lib/databaseHistory';
import { HistoryRequest } from '../lib/messages/historyReconciliation';
import { getAccountMessagingRuntime, type EncryptedAttachmentSubmission, type MessageDraft } from '../lib/messages/accountMessagingRuntime';
import { applyDecryptedBody } from '../lib/messages/attachments/messageBodyProjection';
import { canProjectMutationReceipt } from '../lib/messages/receiptProjection';

export const MAX_MESSAGES_PER_CHANNEL = 500;
export const MAX_CACHED_CHANNELS = 25;

export type IncomingMessagePayload = Partial<Message> & {
  author_id?: string | number | null;
  user_id?: string | number | null;
};

/**
 * Author placeholder for payloads that identify their author by id only. The
 * id is what every downstream consumer actually keys on (grouping, ownership,
 * mention checks, profile popups); the label is corrected as soon as a
 * USER_UPDATE, member fetch, or full refetch supplies the real identity.
 */
function synthesizeAuthor(authorId: string): MessageAuthor {
  return {
    id: authorId,
    username: 'Unknown user',
    discriminator: '0000',
    display_name: null,
    avatar_hash: null,
  };
}

/**
 * Coerce an inbound payload into a renderable `Message`, or return `null` when
 * it cannot be made safe. A malformed payload must never reach the store: the
 * feed is virtualized and shared, so one bad record breaks every row around it.
 *
 * This is deliberately defensive rather than trusting the declared type — the
 * client talks to self-hosted servers of arbitrary version and must not crash
 * on any of them.
 */
export function normalizeIncomingMessage(raw: IncomingMessagePayload | null | undefined): Message | null {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.id || !raw.channel_id) return null;

  const rawAuthor = raw.author as Partial<MessageAuthor> | null | undefined;
  let author: MessageAuthor;

  if (rawAuthor && rawAuthor.id != null && String(rawAuthor.id).length > 0) {
    // Present but possibly partial — fill the fields the UI dereferences.
    author = {
      ...rawAuthor,
      id: String(rawAuthor.id),
      username: rawAuthor.username ?? 'Unknown user',
      discriminator: rawAuthor.discriminator ?? '0000',
    };
  } else {
    const fallbackId = raw.author_id ?? raw.user_id;
    if (fallbackId == null || String(fallbackId).length === 0) {
      console.warn('[messageStore] dropping message payload with no resolvable author');
      return null;
    }
    author = synthesizeAuthor(String(fallbackId));
  }

  return { ...(raw as Message), id: String(raw.id), author };
}

interface OfflineQueuedMessage {
  id: string;
  scope: AccountScope;
  channelId: string;
  content: string;
  referencedMessageId?: string;
  nonce: string;
  createdAt: string;
}

export interface MessageState {
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
    stickerIds?: string[],
    draft?: MessageDraft,
    // Encrypted attachment seam: files for an end-to-end encrypted conversation
    // never become plaintext `attachmentIds`; they go to the encrypted producer.
    attachments?: EncryptedAttachmentSubmission,
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

  // Gateway event handlers. `addMessage` takes the raw wire payload — it
  // normalizes and validates internally, so callers must NOT pre-cast to
  // `Message` and assert a shape the server may not have sent.
  addMessage: (channelId: string, message: IncomingMessagePayload) => void;
  updateMessage: (channelId: string, message: Partial<Message> & Pick<Message, 'id'>) => void;
  removeMessage: (channelId: string, messageId: string) => void;
  removeMessages: (channelId: string, messageIds: string[]) => void;
  updateUserIdentity: (user: User) => void;
  /** Drop all cached messages, pins and queues. Called on logout. */
  reset: () => void;
}

function createAccountMessageStore(scope: AccountScope) {
  let revoked = false;

  const operations = new Set<OperationContext>();
  function ownOperation() {
    if (revoked) throw new Error('This message session has ended. Sign in again to continue.');
    const context = captureScopedOperation(scope);
    operations.add(context);
    context.signal.addEventListener('abort', () => operations.delete(context), { once: true });
    return context;
  }
  /**
   * Reaction echoes match the verified account that owns this store.
   */
  function currentServerUserId(): string | undefined {
    return scope.userId;
  }

  const ENCRYPTED_DM_PLACEHOLDER = '[Encrypted message]';
  const runtime = getAccountMessagingRuntime(scope);

  const _messageFetchRequests = new Map<string, HistoryRequest>();
  let messageSessionGeneration = 0;

  /**
   * Memory bounds for this account's message cache. A channel keeps at most
   * MAX_MESSAGES_PER_CHANNEL messages (oldest trimmed, newest kept at the tail),
   * and at most MAX_CACHED_CHANNELS channels are retained — least-recently-used
   * channels are evicted first, but never the channel the user is viewing.
   */

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
    return getAccountChannelView(scope).selectedChannelId;
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

  function createMessageNonce(): string {
    return crypto.randomUUID();
  }

  /**
   * Wire shape of an inbound message before it is trusted as a `Message`.
   *
   * The gateway's interaction paths (slash commands, component callbacks, bot
   * replies) emit `author_id` as a bare string instead of the `author` object
   * every other path emits. Casting that straight to `Message` produced a stored
   * record with no `author`, and the first render that touched `msg.author.id`
   * threw — taking the entire app down with it, because a bot reply is enough to
   * trip it.
   */

  /**
   * Carry locally-known `flags` onto refetched copies of the same message.
   *
   * `build_message_json` omits `flags` entirely, so a refetch returns `undefined`
   * where the live gateway payload had a value. `(flags ?? 0) & 64` — the
   * EPHEMERAL bit — is therefore true while the message is live and false after
   * any refetch, silently promoting an ephemeral bot reply into a normal message
   * visible to the whole channel. An absent field means "unknown", never
   * "cleared", so keep the value we already had.
   */
  function preserveKnownFlags(incoming: Message[], existing: Message[] | undefined): Message[] {
    if (!existing?.length) return incoming;
    const knownFlagsById = new Map<string, number>();
    for (const message of existing) {
      if (message.flags != null) knownFlagsById.set(message.id, message.flags);
    }
    if (knownFlagsById.size === 0) return incoming;
    return incoming.map((message) => {
      if (message.flags != null) return message;
      const known = knownFlagsById.get(message.id);
      return known == null ? message : { ...message, flags: known };
    });
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

  /** Cancel any in-flight message fetch for the given channel. */
  function cancelMessageFetch(channelId: string): void {
    _messageFetchRequests.get(channelId)?.controller.abort();
  }

  /** Publish plaintext only while this ciphertext still owns its row; preserve newer metadata. */
  async function hydrateMessage(channelId: string, snapshot: Message, generation: number): Promise<void> {
    const decrypted = await decryptMessageForChannel(channelId, snapshot);
    // Encrypted attachment seam: an attachment's real name, type and key exist
    // only inside the decrypted body, so they travel with the plaintext. Rows
    // the body did not describe keep whatever metadata the store already has.
    const described = decrypted.attachments?.some(attachment => attachment.encryption)
      ? decrypted.attachments : undefined;
    if (generation !== messageSessionGeneration) return;
    useMessageStore.setState((state) => {
      const hydrateRows = (rows: Message[] | undefined) => rows?.map(current => {
        if (current.id !== snapshot.id || current.e2ee !== snapshot.e2ee) return current;
        return { ...current, content: decrypted.content, ...(described ? { attachments: described } : {}) };
      });
      const messages = hydrateRows(state.messages[channelId]);
      const pins = hydrateRows(state.pins[channelId]);
      const hydrated = messages?.find(message => message.id === snapshot.id);
      if (hydrated) _messageFetchRequests.get(channelId)?.record(hydrated);
      const decryptingIds = new Set(state.decryptingIds);
      decryptingIds.delete(snapshot.id);
      return {
        messages: messages ? { ...state.messages, [channelId]: messages } : state.messages,
        pins: pins ? { ...state.pins, [channelId]: pins } : state.pins,
        decryptingIds,
      };
    });
  }

  function findChannel(channelId: string) {
    return getAccountChannelView(scope).channelsById[channelId] ?? null;
  }

  function isDmChannel(channelId: string): boolean {
    const channel = findChannel(channelId);
    if (!channel) return false;
    const channelType = channel.channel_type ?? channel.type;
    return (channelType === 1 || channelType === 3) && !channel.guild_id;
  }

  async function decryptMessageForChannel(channelId: string, message: Message): Promise<Message> {
    if (!message.e2ee) return message;
    try {
      const plaintext = await runtime.decrypt(channelId, message.e2ee, message.id);
      // Encrypted attachment seam: the decrypted body is a versioned envelope
      // when it carries attachments, and plain text otherwise. A body this build
      // cannot read becomes the unreadable placeholder rather than losing its
      // attachments silently.
      return applyDecryptedBody(message, plaintext);
    } catch { return { ...message, content: ENCRYPTED_DM_PLACEHOLDER }; }
  }

  async function decryptMessagesForChannel(channelId: string, messages: Message[]): Promise<Message[]> {
    return Promise.all(messages.map((message) => decryptMessageForChannel(channelId, message)));
  }

  async function buildSendMessageRequest(channelId: string, content: string, referencedMessageId?: string): Promise<SendMessageRequest> {
    if (!findChannel(channelId)) throw new Error('Load this conversation before scheduling a message.');
    if (isDmChannel(channelId)) throw new Error('Encrypted message scheduling requires the account-owned scheduling producer.');
    return { content: content.trim(), referenced_message_id: referencedMessageId, nonce: createMessageNonce() };
  }

  const useMessageStore = create<MessageState>()((write, get) => {
    const set = (next: Partial<MessageState> | ((state: MessageState) => Partial<MessageState>)) => {
      if (!revoked) write(next);
    };
    return ({
      messages: {},
      hasMore: {},
      loading: {},
      messageErrors: {},
      pins: {},
      decryptingIds: new Set<string>(),
      offlineQueue: [],

      fetchMessages: async (channelId, params) => {
        const context = ownOperation();
        const api = createChannelApi(() => context.api);
        try {
          const previous = _messageFetchRequests.get(channelId);
          if (previous && !previous.controller.signal.aborted) return;

          const generation = messageSessionGeneration;
          const request = new HistoryRequest(params?.around ? 'around' : params?.before ? 'before' : 'latest');
          const release = () => {
            if (_messageFetchRequests.get(channelId) !== request) return;
            _messageFetchRequests.delete(channelId);
            set(state => ({
              loading: { ...state.loading, [channelId]: false },
              ...(request.failure ? { messageErrors: { ...state.messageErrors, [channelId]: request.failure } } : {}),
            }));
          };
          context.signal.addEventListener('abort', () => request.controller.abort(), { once: true });
          request.controller.signal.addEventListener('abort', () => { release(); context.dispose(); }, { once: true });
          for (const [key, pending] of _messageFetchRequests) {
            if (key !== channelId) pending.controller.abort();
          }
          _messageFetchRequests.set(channelId, request);
          const isCurrent = () => generation === messageSessionGeneration
            && _messageFetchRequests.get(channelId) === request
            && !request.controller.signal.aborted;
          set((state) => ({
            loading: Object.fromEntries([
              ...Object.keys(state.loading).map((key) => [key, false] as const),
              [channelId, true],
            ]),
            messageErrors: { ...state.messageErrors, [channelId]: null },
          }));

          const MAX_RETRIES = 2;
          let lastErr: unknown;
          try {
            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
              if (!isCurrent()) return;
              try {
                if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
                if (!isCurrent()) return;
                await runtime.prepareChannelHistory(channelId);
                if (!isCurrent()) return;
                const { data } = await api.getMessages(
                  channelId,
                  { limit: DEFAULT_MESSAGE_FETCH_LIMIT, ...params },
                  { timeout: 5_000, signal: request.controller.signal },
                );
                if (!isCurrent()) return;
                const visible = await runtime.filterDeletedMessages(data);
                if (!isCurrent()) return;
                let toDecrypt: Message[] = [];
                touchChannel(channelId);
                set((state) => {
                  const existing = state.messages[channelId] ?? [];
                  const history = preserveKnownFlags([...visible].reverse(), existing);
                  const merged = capChannelMessages(request.reconcile(history, existing), !!params?.before);
                  toDecrypt = merged.filter((message) => message.e2ee && !existing.includes(message));
                  const decryptingIds = new Set(state.decryptingIds);
                  for (const message of toDecrypt) decryptingIds.add(message.id);
                  // Refresh polls from the reconciled window, never the stale HTTP slice.
                  if (!params?.before) usePollStore.getState().clearPollsForChannel(channelId);
                  for (const message of merged) {
                    if (message.poll) usePollStore.getState().upsertPoll(message.poll);
                  }
                  return applyEviction(state, {
                    messages: { ...state.messages, [channelId]: merged },
                    decryptingIds,
                    hasMore: {
                      ...state.hasMore,
                      [channelId]: params?.around ? true : data.length >= DEFAULT_MESSAGE_FETCH_LIMIT,
                    },
                    messageErrors: { ...state.messageErrors, [channelId]: null },
                  });
                });
                await Promise.all(toDecrypt.map((message) => hydrateMessage(channelId, message, generation)));
                return;
              } catch (err) {
                if (axios.isCancel(err) || !isCurrent()) return;
                lastErr = err;
              }
            }
            if (!isCurrent()) return;
            const errorMessage = extractApiError(lastErr);
            set((state) => ({ messageErrors: { ...state.messageErrors, [channelId]: errorMessage } }));
            toast.error(`Failed to load messages: ${errorMessage}`);
          } finally {
            if (generation === messageSessionGeneration && _messageFetchRequests.get(channelId) === request) {
              _messageFetchRequests.delete(channelId);
              set((state) => ({
                loading: { ...state.loading, [channelId]: false },
                ...(request.failure ? { messageErrors: { ...state.messageErrors, [channelId]: request.failure } } : {}),
              }));
            }
          }

        } finally { context.dispose(); }
      },

      sendMessage: async (channelId, content, referencedMessageId, attachmentIds, stickerIds, draft, attachments) => {
        if (!content.trim() && !attachmentIds?.length && !stickerIds?.length && !attachments?.files.length) return;
        if (revoked) throw new Error('This account message session has ended.');
        await runtime.send(channelId, content, referencedMessageId, attachmentIds, stickerIds, draft, attachments);
      },

      scheduleMessage: async (channelId, content, sendAtIso, referencedMessageId) => {
        const context = ownOperation();
        const api = createChannelApi(() => context.api);
        try {
          const normalized = content.trim();
          if (!normalized) {
            return;
          }
          const request = await buildSendMessageRequest(channelId, normalized, referencedMessageId);
          await api.createScheduledMessage(channelId, {
            content: request.content || undefined,
            e2ee: request.e2ee,
            nonce: request.nonce,
            send_at: sendAtIso,
            ...(referencedMessageId ? { reference_message_id: referencedMessageId } : {}),
          } as Parameters<typeof api.createScheduledMessage>[1]);

        } finally { context.dispose(); }
      },

      editScheduledMessage: async (channelId, scheduledMessageId, content, sendAtIso, e2ee) => {
        const context = ownOperation();
        const api = createChannelApi(() => context.api);
        try {
          const normalized = content.trim();
          if (!normalized && e2ee === undefined) {
            return;
          }
          if (e2ee !== undefined) throw new Error('Encrypted message scheduling is not available.');
          const request = await buildSendMessageRequest(channelId, normalized);
          await api.updateScheduledMessage(channelId, scheduledMessageId, {
            content: request.content || undefined,
            e2ee: e2ee ?? request.e2ee,
            nonce: request.nonce,
            send_at: sendAtIso,
          });

        } finally { context.dispose(); }
      },

      flushOfflineQueue: async () => { await runtime.reconcile(); },

      editMessage: async (channelId, messageId, content) => {
        const message = get().messages[channelId]?.find(row => row.id === messageId) ?? get().pins[channelId]?.find(row => row.id === messageId);
        if (!message) throw new Error('Load this message before editing it.');
        await runtime.editMessage(message, content);
      },

      deleteMessage: async (channelId, messageId) => {
        const message = get().messages[channelId]?.find(row => row.id === messageId) ?? get().pins[channelId]?.find(row => row.id === messageId);
        if (!message) throw new Error('Load this message before deleting it.');
        if (message.author.id === scope.userId) { await runtime.deleteMessage(message); return; }
        const context = ownOperation();
        try {
          await createChannelApi(() => context.api).deleteMessage(channelId, messageId);
          context.assertCurrent();
          await runtime.observeDeleted(channelId, messageId);
          get().removeMessage(channelId, messageId);
        } finally { context.dispose(); }
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
        const context = ownOperation();
        const api = createChannelApi(() => context.api);
        try {
          const generation = messageSessionGeneration;
          try {
            await runtime.prepareChannelHistory(channelId);
            context.assertCurrent();
            const { data } = await api.getPins(channelId);
            const decrypted = await decryptMessagesForChannel(channelId, await runtime.filterDeletedMessages(data));
            const visible = await runtime.filterDeletedMessages(decrypted);
            context.assertCurrent();
            if (generation !== messageSessionGeneration) return;
            set((state) => ({
              pins: {
                ...state.pins,
                // Pins come from the same serializer that omits `flags`.
                [channelId]: preserveKnownFlags(visible.filter(message => message.pinned), state.messages[channelId]),
              },
            }));
          } catch (err) {
            toast.error(`Failed to load pinned messages: ${extractApiError(err)}`);
          }

        } finally { context.dispose(); }
      },

      pinMessage: async (channelId, messageId) => {
        const context = ownOperation();
        const api = createChannelApi(() => context.api);
        try {
          await api.pinMessage(channelId, messageId);
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

        } finally { context.dispose(); }
      },

      unpinMessage: async (channelId, messageId) => {
        const context = ownOperation();
        const api = createChannelApi(() => context.api);
        try {
          await api.unpinMessage(channelId, messageId);
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

        } finally { context.dispose(); }
      },

      addReaction: async (channelId, messageId, emoji) => {
        const context = ownOperation();
        const api = createChannelApi(() => context.api);
        try {
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
            await api.addReaction(channelId, messageId, emoji);
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

        } finally { context.dispose(); }
      },

      removeReaction: async (channelId, messageId, emoji) => {
        const context = ownOperation();
        const api = createChannelApi(() => context.api);
        try {
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
            await api.removeReaction(channelId, messageId, emoji);
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

        } finally { context.dispose(); }
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
      addMessage: (channelId, rawMessage) => {
        if (revoked) return;
        // Guard here rather than only at the dispatch call site: every path into the
        // store (gateway, replay, optimistic send) has to be safe, and an authorless
        // record in the cache breaks the whole virtualized feed, not just its row.
        const message = normalizeIncomingMessage(rawMessage);
        if (!message) return;
        if (_messageFetchRequests.get(channelId)?.isDeleted(message.id)) return;
        const isE2ee = Boolean(message.e2ee);
        const baseMessage = {
          ...message,
          // Keep content empty while decrypting — the UI will show a skeleton
          content: isE2ee ? '' : message.content,
        };
        _messageFetchRequests.get(channelId)?.record(baseMessage, true);
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
          void hydrateMessage(channelId, baseMessage, messageSessionGeneration);
        }
      },

      updateMessage: (channelId, message) => {
        if (revoked) return;
        _messageFetchRequests.get(channelId)?.record(message);
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
        // `existingMessage` is genuinely optional: the `set` above returns early
        // when the message is not cached (and eviction can drop it between the two
        // statements). The old `existingMessage!` asserted otherwise and would have
        // thrown inside `mergeMessageFields`. Nothing to decrypt if it is gone.
        if (shouldDecrypt && message.e2ee !== undefined && existingMessage) {
          void hydrateMessage(channelId, existingMessage, messageSessionGeneration);
        }
      },

      removeMessage: (channelId, messageId) => get().removeMessages(channelId, [messageId]),

      removeMessages: (channelId, messageIds) => {
        _messageFetchRequests.get(channelId)?.remove(messageIds);
        set((state) => {
          const idSet = new Set(messageIds);
          const decryptingIds = new Set(state.decryptingIds);
          for (const id of idSet) decryptingIds.delete(id);
          return {
            messages: {
              ...state.messages,
              [channelId]: (state.messages[channelId] ?? []).filter((message) => !idSet.has(message.id)),
            },
            pins: {
              ...state.pins,
              [channelId]: (state.pins[channelId] ?? []).filter((message) => !idSet.has(message.id)),
            },
            decryptingIds,
          };
        });
      },

      updateUserIdentity: (user) =>
        set((state) => {
          const patchAuthor = (message: Message): Message =>
            message.author?.id === user.id
              ? {
                ...message,
                author: {
                  ...message.author,
                  ...user,
                  discriminator: String(user.discriminator),
                },
              }
              : message;

          // USER_UPDATE fires for every profile edit by anyone the client can see.
          // Rebuilding every cached channel array and every message object on each
          // one re-rendered the whole feed even when the user had authored nothing
          // here. Rebuild only the channels that actually contain their messages,
          // and keep the original array identity everywhere else so downstream
          // selectors and memos stay stable.
          const remapChannels = (
            source: Record<string, Message[]>,
          ): Record<string, Message[]> | null => {
            let changed = false;
            const next: Record<string, Message[]> = {};
            for (const [channelId, messages] of Object.entries(source)) {
              if (!messages.some((message) => message.author?.id === user.id)) {
                next[channelId] = messages;
                continue;
              }
              next[channelId] = messages.map(patchAuthor);
              changed = true;
            }
            return changed ? next : null;
          };

          const messages = remapChannels(state.messages);
          const pins = remapChannels(state.pins);
          if (!messages && !pins) return state;
          return {
            ...(messages ? { messages } : {}),
            ...(pins ? { pins } : {}),
          };
        }),

      reset: () => {
        // Abort every in-flight fetch before dropping state, otherwise a response
        // for the previous account lands after the reset and repopulates the cache.
        messageSessionGeneration++;
        for (const operation of operations) operation.dispose();
        operations.clear();
        for (const request of _messageFetchRequests.values()) request.controller.abort();
        _messageFetchRequests.clear();
        _pendingReactionKeys.clear();
        _channelAccessOrder.clear();
        set({
          messages: {},
          hasMore: {},
          loading: {},
          messageErrors: {},
          pins: {},
          decryptingIds: new Set<string>(),
          // Durable queues belong to the account runtime, outside this cache.
          offlineQueue: [],
        });
      },
    });
  });

  const stopKnownMessages = runtime.registerKnownMessages(() => {
    const state = useMessageStore.getState(); return [...Object.values(state.messages).flat(), ...Object.values(state.pins).flat()];
  });
  const stopMessages = runtime.subscribeMessages(event => {
    if (revoked) return;
    if (event.kind === 'authoritative') {
      const hidden = new Set(event.hidden); const current = new Map(event.present.map(message => [message.id, message]));
      const pending = new Map((event.pending ?? []).map(message => [message.id, message]));
      useMessageStore.setState(state => {
        const reconcile = (rows: Message[] | undefined) => (rows ?? []).flatMap(message => {
          if (hidden.has(message.id)) return [];
          if (pending.has(message.id)) return [pending.get(message.id)!];
          const replacement = current.get(message.id);
          if (!replacement || replacement.message_revision === message.message_revision) return [message];
          return [{ ...replacement, content: replacement.e2ee ? ENCRYPTED_DM_PLACEHOLDER : replacement.content }];
        });
        return { messages: { ...state.messages, [event.channelId]: reconcile(state.messages[event.channelId]) },
          pins: { ...state.pins, [event.channelId]: reconcile(state.pins[event.channelId]).filter(message => message.pinned) } };
      });
      const state = useMessageStore.getState();
      for (const message of [...state.messages[event.channelId] ?? [], ...state.pins[event.channelId] ?? []]) if (message.e2ee) void hydrateMessage(event.channelId, message, messageSessionGeneration);
    } else if (event.kind === 'create') {
      useMessageStore.getState().addMessage(event.message.channel_id, event.message);
      const channel = findChannel(event.message.channel_id);
      if (channel) refreshGuildChannelVisibility(channel.guild_id, channel.scope);
    } else if (event.kind === 'edit') {
      const current = useMessageStore.getState().messages[event.message.channel_id]?.find(message => message.id === event.message.id);
      if (current && canProjectMutationReceipt(current, event.message)) useMessageStore.getState().updateMessage(event.message.channel_id, event.message);
    } else if (event.kind === 'delete') useMessageStore.getState().removeMessage(event.channelId, event.messageId);
    else if (event.kind === 'encryption-locked') {
      messageSessionGeneration++;
      for (const request of _messageFetchRequests.values()) request.controller.abort();
      const clear = (channels: Record<string, Message[]>) => Object.fromEntries(Object.entries(channels).map(([id, rows]) => [id, rows.map(message => message.e2ee ? { ...message, content: ENCRYPTED_DM_PLACEHOLDER } : message)]));
      useMessageStore.setState(state => ({ messages: clear(state.messages), pins: clear(state.pins), decryptingIds: new Set<string>() }));
    } else if (event.kind === 'encryption-ready') {
      const state = useMessageStore.getState();
      for (const collection of [state.messages, state.pins]) for (const [channelId, messages] of Object.entries(collection)) {
        for (const message of messages) if (message.e2ee) void hydrateMessage(channelId, message, messageSessionGeneration);
      }
    }
  });
  function revoke() {
    stopKnownMessages(); stopMessages(); useMessageStore.getState().reset(); revoked = true;
  }
  return Object.assign(useMessageStore, { scope, cancelFetch: cancelMessageFetch, revoke });

}

const stores = new Map<string, ReturnType<typeof createAccountMessageStore>>();
/** Every cache, request, reaction journal and queue view belongs to this account. */
export function getMessageStore(scope: AccountScope) {
  subscribeToAccountChanges();
  const key = accountScopeKey(scope);
  let store = stores.get(key);
  if (!store) { store = createAccountMessageStore(Object.freeze({ ...scope })); stores.set(key, store); }
  return store;
}
export function cancelMessageFetch(scope: AccountScope, channelId: string) {
  stores.get(accountScopeKey(scope))?.cancelFetch(channelId);
}
export function resetMessageStores() {
  for (const store of stores.values()) store.revoke();
  stores.clear();
}
function purgeRevokedAccounts() {
  for (const [key, store] of stores) {
    const current = getServerAccountScope(store.scope.serverId);
    const credentialRevoked = store.scope.serverId === '__local__' && !useAuthStore.getState().token;
    if (!current || credentialRevoked || accountScopeKey(current) !== key) { store.revoke(); stores.delete(key); }
  }
}
let observingAccounts = false;
function subscribeToAccountChanges() {
  if (observingAccounts) return;
  useServerListStore.subscribe(purgeRevokedAccounts);
  useAuthStore.subscribe(purgeRevokedAccounts);
  observingAccounts = true;
}
registerSessionReset('messages', resetMessageStores);
registerAccountHistoryReset('messages', scope => stores.get(accountScopeKey(scope))?.getState().reset());

export async function flushMessageQueues() {
  const ids = ['__local__', ...useServerListStore.getState().servers.map(server => server.id)];
  const scopes = ids.map(getServerAccountScope).filter((scope): scope is AccountScope => !!scope);
  await Promise.allSettled(scopes.map(scope => getMessageStore(scope).getState().flushOfflineQueue()));
}
