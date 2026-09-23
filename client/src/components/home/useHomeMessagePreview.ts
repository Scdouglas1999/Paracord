import { messagePreviewText } from '../../lib/markdown';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { ConversationEntry } from '../../lib/attention/conversationModel';
import {
  getDatabaseHistoryEpoch,
  requestHistoryReconciliation,
  subscribeDatabaseHistory,
} from '../../lib/databaseHistory';
import { captureScopedOperation } from '../../lib/operationContext';
import { fetchGuildRoles } from '../../lib/permissionDataCache';
import { accountScopeKey, type AccountScope } from '../../lib/serverScope';
import { useReadStateStore } from '../../stores/readStateStore';
import type { Message } from '../../types';

interface HomeMessagePreview {
  author: string | null;
  authorId: string | null;
  avatar: string | null;
  text: string;
  messageId?: string;
}

interface PreviewState extends HomeMessagePreview {
  revision: string;
  failed?: boolean;
}

/** Home only formats server messages. It never decrypts a DM or advances its ratchet. */
function previewOf(
  message: Message,
  userId: string,
  roleNames?: ReadonlyMap<string, string>,
): HomeMessagePreview {
  const identity = {
    authorId: message.author?.id ?? null,
    avatar: message.author?.avatar_hash ?? null,
    messageId: message.id,
  };
  if (message.e2ee) {
    return {
      ...identity,
      author: null,
      text: 'Encrypted message — open the conversation to read',
    };
  }
  const author = message.author?.display_name || message.author?.username || null;
  // Plain words: no code fences, no markup, and a mention is a name. Home has no
  // member list to hand, so the one name it is sure of is the reader's own.
  const content = messagePreviewText(message.content ?? '', new Map([[userId, 'you']]), roleNames);
  const text = content || (message.poll
    ? `Poll: ${message.poll.question}`
    : message.attachments?.length
      ? 'Attachment'
      : 'New activity');
  return { ...identity, author, text };
}

function emptyPreview(text: string): HomeMessagePreview {
  return { author: null, authorId: null, avatar: null, text };
}

/**
 * Read one preview without loading a timeline, decrypting, or marking anything
 * read. Every result belongs to a captured account and history generation. The
 * local state is invalidated on activity, edits/deletions, permission changes,
 * or an account change; it is never persisted or shared under a bare channel ID.
 */
export function useHomeMessagePreview(entry: ConversationEntry, mode: 'attention' | 'latest') {
  const scopeKey = accountScopeKey(entry.scope);
  const after = useReadStateStore((state) => mode === 'attention'
    ? state.byAccount[scopeKey]?.[entry.channelId]?.last_message_id ?? '0'
    : '0');
  const attentionRevision = useReadStateStore(
    (state) => state.attentionRevisions[scopeKey]?.[entry.channelId] ?? 0,
  );
  const historyEpoch = useSyncExternalStore(subscribeDatabaseHistory, () => {
    try {
      return getDatabaseHistoryEpoch(entry.scope);
    } catch {
      return 'unavailable' as const;
    }
  });
  const historyUnavailable = historyEpoch === 'unavailable';
  const kind = mode === 'latest' ? 'latest' : entry.mentionCount > 0 ? 'mention' : 'unread';
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [capabilityRevision, setCapabilityRevision] = useState(0);
  const revision = JSON.stringify([
    scopeKey,
    entry.key,
    entry.channelId,
    historyEpoch,
    entry.lastActivityId,
    entry.mentionCount,
    kind,
    after,
    retryCount,
    attentionRevision,
    capabilityRevision,
  ]);
  const failed = historyUnavailable || (preview?.revision === revision && !!preview.failed);
  const { serverId, userId } = entry.scope;

  useEffect(() => {
    if (!entry.lastActivityId || historyUnavailable) return;
    let disposed = false;
    let context: ReturnType<typeof captureScopedOperation> | undefined;
    const invalidateCapabilities = (event: Event) => {
      // Current gateway/runtime producers invalidate an entire account. Honor
      // an optional channel when a more specific invalidation is available.
      const detail = (event as CustomEvent<AccountScope & { channelId?: string }>).detail;
      if (detail?.serverId !== serverId || detail?.userId !== userId ||
        (detail.channelId !== undefined && detail.channelId !== entry.channelId)) return;
      // Fence the old request synchronously: its promise can settle before the
      // state update causes React to run this effect's cleanup.
      disposed = true;
      context?.dispose();
      setPreview(null);
      setCapabilityRevision((value) => value + 1);
    };
    window.addEventListener('paracord:conversation-capabilities-changed', invalidateCapabilities);
    void (async () => {
      try {
        context = captureScopedOperation({ serverId, userId });
        let message: Message | null;
        if (kind === 'latest') {
          const { data } = await context.request<Message[]>({
            method: 'GET',
            url: `/channels/${encodeURIComponent(entry.channelId)}/messages`,
            params: { limit: 1 },
            timeout: 15_000,
          });
          if (disposed) return;
          if (!Array.isArray(data) || data.length > 1) throw new Error('Invalid preview response');
          message = data[0] ?? null;
        } else {
          const { data } = await context.request<{
            channel_id: string;
            user_id: string;
            kind: string;
            message: Message | null;
          }>({
            method: 'GET',
            url: `/channels/${encodeURIComponent(entry.channelId)}/messages/attention`,
            params: { kind, after },
            timeout: 15_000,
          });
          if (disposed) return;
          if (data.channel_id !== entry.channelId || data.user_id !== userId || data.kind !== kind) {
            throw new Error('Invalid attention response');
          }
          message = data.message;
        }
        if (message !== null && (
          !message ||
          message.channel_id !== entry.channelId ||
          typeof message.id !== 'string' ||
          !/^[1-9][0-9]*$/.test(message.id) ||
          (kind !== 'latest' && BigInt(message.id) <= BigInt(after))
        )) {
          throw new Error('Invalid preview message');
        }
        let roleNames: Map<string, string> | undefined;
        if (message && entry.guildId && /<@&\d+>/.test(message.content ?? '')) {
          try {
            const roles = await fetchGuildRoles(entry.guildId, { serverId, userId });
            if (disposed) return;
            roleNames = new Map(roles.map((role) => [role.id, role.name]));
          } catch (err) {
            throw new Error(err instanceof Error ? `Could not load roles for this preview. ${err.message}` : 'Could not load roles for this preview.');
          }
        }
        setPreview({
          revision,
          ...(message ? previewOf(message, userId, roleNames) : emptyPreview(
            kind === 'mention'
              ? 'No unread mention target is available'
              : kind === 'unread'
                ? 'No unread message remains'
                : 'No message preview available',
          )),
        });
      } catch (err) {
        if (!disposed) {
          const message = err instanceof Error && err.message.startsWith('Could not load roles')
            ? err.message
            : 'Preview unavailable';
          setPreview({ revision, ...emptyPreview(message), failed: true });
        }
      } finally {
        context?.dispose();
      }
    })();
    return () => {
      disposed = true;
      context?.dispose();
      window.removeEventListener('paracord:conversation-capabilities-changed', invalidateCapabilities);
    };
  }, [entry.channelId, entry.guildId, entry.lastActivityId, serverId, userId, revision, kind, after, historyUnavailable]);

  const fresh = preview?.revision === revision && !preview.failed ? preview : null;
  const roleFailure = preview?.revision === revision && preview.failed && preview.text.startsWith('Could not load roles')
    ? preview.text
    : null;
  const text = historyUnavailable
    ? 'Reconnect this account to restore previews'
    : roleFailure
      ? roleFailure
      : failed
        ? 'Preview unavailable'
        : fresh?.text ?? (entry.lastActivityId ? 'Loading…' : 'No message preview available');

  return {
    preview: fresh,
    text,
    failed,
    historyUnavailable,
    retry: () => historyUnavailable
      ? requestHistoryReconciliation(entry.scope)
      : setRetryCount((count) => count + 1),
  };
}
