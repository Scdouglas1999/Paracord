import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ArrowRight, Bell } from 'lucide-react';
import type { ConversationEntry } from '../../lib/attention/conversationModel';
import { scoreEntry } from '../../lib/attention/scoreConversation';
import { useReadStateStore } from '../../stores/readStateStore';
import { accountScopeKey } from '../../lib/serverScope';
import { captureScopedOperation } from '../../lib/operationContext';
import { useServerListStore } from '../../stores/serverListStore';
import { HomeSectionHeader } from './HomeSectionHeader';
import type { Message } from '../../types';
import { getDatabaseHistoryEpoch, requestHistoryReconciliation, subscribeDatabaseHistory } from '../../lib/databaseHistory';

export function attentionReason(entry: ConversationEntry) {
  if (entry.mentionCount > 0) return `${entry.mentionCount} mention${entry.mentionCount === 1 ? '' : 's'}`;
  if (entry.isDMUnread) return 'Unread direct message';
  if (entry.isThreadReply) return 'Unread thread replies';
  if (entry.unread) return 'Unread messages';
  return 'Live room';
}

/** Include pinned attention and overflow: pinning must never hide work on Home. */
export function homeAttention(entries: ConversationEntry[]) {
  const unique = new Map(entries.map(entry => [entry.key, entry]));
  const now = Date.now();
  return [...unique.values()]
    .filter(entry => entry.mentionCount > 0 || entry.isDMUnread || entry.isThreadReply || entry.unread || entry.hasVoiceActivity)
    .sort((a, b) => scoreEntry(b, now) - scoreEntry(a, now) || a.key.localeCompare(b.key));
}

function previewText(message: Message | null, userId: string): string {
  if (!message) return 'No message preview available';
  // Home never decrypts or advances a DM ratchet in the background.
  if (message.e2ee) return 'Encrypted message — open the conversation to read';
  const content = message.content?.trim().replace(/<@!?([0-9]+)>/g, (token, id: string) => id === userId ? '@you' : token);
  if (content) {
    const author = message.author.display_name || message.author.username;
    return `${author.length > 24 ? `${author.slice(0, 24)}…` : author}: ${content}`;
  }
  if (message.poll) return `Poll: ${message.poll.question}`;
  if (message.attachments?.length) return 'Attachment';
  return 'New activity';
}

function AttentionRow({ entry, onOpen }: { entry: ConversationEntry; onOpen: (entry: ConversationEntry, messageId?: string) => void }) {
  const serverName = useServerListStore(state => state.servers.find(server => server.id === entry.serverId)?.name);
  const after = useReadStateStore(state => state.byAccount[accountScopeKey(entry.scope)]?.[entry.channelId]?.last_message_id ?? '0');
  const attentionRevision = useReadStateStore(state => state.attentionRevisions[accountScopeKey(entry.scope)]?.[entry.channelId] ?? 0);
  const historyEpoch = useSyncExternalStore(subscribeDatabaseHistory, () => {
    try { return getDatabaseHistoryEpoch(entry.scope); }
    catch { return 'unavailable' as const; }
  });
  const historyUnavailable = historyEpoch === 'unavailable';
  const kind = entry.mentionCount > 0 ? 'mention' : 'unread';
  const [preview, setPreview] = useState<{ revision: string; text: string; messageId?: string; failed?: boolean } | null>(null);
  const [retry, setRetry] = useState(0);
  const revision = JSON.stringify([entry.key, historyEpoch, entry.lastActivityId, entry.mentionCount, kind, after, retry, attentionRevision]);
  const failed = historyUnavailable || (preview?.revision === revision && preview.failed);
  const voiceOnly = entry.hasVoiceActivity && !entry.unread && !entry.isDMUnread && !entry.isThreadReply && !entry.mentionCount;
  const { serverId, userId } = entry.scope;
  useEffect(() => {
    if (voiceOnly || !entry.lastActivityId || historyUnavailable) return;
    let disposed = false;
    let context: ReturnType<typeof captureScopedOperation> | undefined;
    void (async () => {
      try {
        context = captureScopedOperation({ serverId, userId });
        const { data } = await context.request<{ channel_id: string; user_id: string; kind: string; message: Message | null }>({
          method: 'GET',
          url: `/channels/${encodeURIComponent(entry.channelId)}/messages/attention`,
          params: { kind, after },
          timeout: 15_000,
        });
        if (disposed) return;
        if (data.channel_id !== entry.channelId || data.user_id !== userId || data.kind !== kind
          || (data.message !== null && (!data.message || data.message.channel_id !== entry.channelId
            || typeof data.message.id !== 'string' || !/^[1-9][0-9]*$/.test(data.message.id)
            || BigInt(data.message.id) <= BigInt(after)))) {
          throw new Error('Invalid attention response');
        }
        setPreview({ revision, text: data.message ? previewText(data.message, userId)
          : kind === 'mention' ? 'No unread mention target is available' : 'No unread message remains',
          messageId: data.message?.id });
      } catch {
        if (!disposed) setPreview({ revision, text: 'Preview unavailable', failed: true });
      } finally {
        context?.dispose();
      }
    })();
    return () => { disposed = true; context?.dispose(); };
  }, [entry.channelId, entry.lastActivityId, serverId, userId, revision, retry, voiceOnly, kind, after, historyUnavailable]);

  const targetId = preview?.revision === revision && !preview.failed ? preview.messageId : undefined;
  const action = !targetId && !voiceOnly ? 'Open conversation' : entry.mentionCount > 0 ? 'Review mentions' : entry.isThreadReply ? 'Read replies' : voiceOnly ? 'Open room' : 'Read conversation';
  return (
    <li data-conversation-key={entry.key} className="relative min-w-0">
      <button type="button" onClick={() => onOpen(entry, targetId)} className="group flex min-h-24 w-full min-w-0 items-center gap-3 px-4 py-3 text-left outline-none hover:bg-bg-mod-subtle focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-meta font-semibold text-accent-primary">{attentionReason(entry)}{entry.pinned ? ' · Pinned' : ''}</span>
          <span className="block truncate text-label font-semibold text-text-primary">{entry.title}</span>
          <span className="block truncate text-meta text-text-muted">{entry.contextLabel}</span>
          <span className="block truncate text-meta text-text-muted">{serverName || (entry.serverId === '__local__' ? 'This server' : entry.serverId)}</span>
          <span className="mt-1 line-clamp-2 h-10 break-words text-meta text-text-secondary">{voiceOnly ? 'Open this room to join the conversation' : <>{kind === 'mention' ? 'Mention' : entry.isThreadReply ? 'Unread reply' : 'First unread'}: {historyUnavailable ? 'Reconnect this account to restore previews' : failed ? 'Preview unavailable' : preview?.revision === revision ? preview.text : entry.lastActivityId ? 'Loading…' : 'No message preview available'}</>}</span>
          <span className="mt-1 inline-flex min-h-11 max-w-[calc(100%-4rem)] items-center gap-1 text-meta font-semibold text-accent-primary">{action}<ArrowRight size={12} aria-hidden /></span>
        </span>
      </button>
      {failed && !voiceOnly && <button type="button" onClick={() => historyUnavailable ? requestHistoryReconciliation(entry.scope) : setRetry(value => value + 1)} aria-label={`${historyUnavailable ? 'Reconnect to load' : 'Retry'} preview for ${entry.title}`} className="absolute bottom-2 right-3 min-h-11 min-w-11 rounded-sm bg-bg-secondary px-2 text-meta text-accent-primary outline-none hover:bg-bg-mod-subtle focus-visible:ring-2 focus-visible:ring-accent-primary">{historyUnavailable ? 'Reconnect' : 'Retry'}</button>}
    </li>
  );
}

export function HomeNeedsYou({ entries, onOpen }: { entries: ConversationEntry[]; onOpen: (entry: ConversationEntry, messageId?: string) => void }) {
  const [heldKeys, setHeldKeys] = useState<string[] | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [visibleCount, setVisibleCount] = useState(6);
  const ordered = useMemo(() => {
    if (!heldKeys) return entries;
    const current = new Map(entries.map(entry => [entry.key, entry]));
    const held = new Set(heldKeys);
    // Removed/revoked entries disappear immediately; new work waits at the end.
    return [...heldKeys.flatMap(key => current.get(key) ? [current.get(key)!] : []), ...entries.filter(entry => !held.has(entry.key))];
  }, [entries, heldKeys]);
  const hold = () => setHeldKeys(keys => keys ?? ordered.map(entry => entry.key));
  const release = () => setHeldKeys(null);
  if (!entries.length) return null;
  const visible = ordered.slice(0, visibleCount);
  return (
    <section aria-label="Needs you" onPointerEnter={event => { if (event.pointerType !== 'touch') { setHovered(true); hold(); } }} onPointerLeave={() => { setHovered(false); if (!focused) release(); }} onFocusCapture={() => { setFocused(true); hold(); }} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setFocused(false); if (!hovered) release(); } }}>
      <HomeSectionHeader icon={<Bell size={14} />} label="Needs you" count={entries.length} />
      <p className="mb-3 text-meta text-text-muted">Mentions first, then direct messages, replies, unread channels, and live rooms. Recent activity breaks ties.</p>
      <ul className="divide-y divide-border-subtle overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">{visible.map(entry => <AttentionRow key={entry.key} entry={entry} onOpen={onOpen} />)}</ul>
      {entries.length > 6 && <button type="button" onClick={() => setVisibleCount(value => value >= entries.length ? 6 : value + 6)} className="mt-2 min-h-11 rounded-sm px-3 text-label font-semibold text-accent-primary outline-none hover:bg-accent-tint focus-visible:ring-2 focus-visible:ring-accent-primary">{visibleCount >= entries.length ? 'Show fewer conversations' : `Show ${Math.min(6, entries.length - visibleCount)} more conversations`}</button>}
    </section>
  );
}
