import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';

import { Button, SectionLabel } from '../ui';
import { LitAvatar } from '../light';
import { cn } from '../../lib/utils';
import { personLight, type PersonLight } from '../../lib/attention/light';
import type { ConversationEntry } from '../../lib/attention/conversationModel';
import { snowflakeToMs } from '../../lib/attention/conversationModel';
import { scoreEntry } from '../../lib/attention/scoreConversation';
import { captureScopedOperation } from '../../lib/operationContext';
import {
  getDatabaseHistoryEpoch,
  requestHistoryReconciliation,
  subscribeDatabaseHistory,
} from '../../lib/databaseHistory';
import { accountScopeKey } from '../../lib/serverScope';
import { usePresenceStore } from '../../stores/presenceStore';
import { useReadStateStore } from '../../stores/readStateStore';
import type { FriendRequestEntry } from '../../hooks/useUnifiedConversations';
import type { Message } from '../../types';
import { mentionCaption, NEEDS_YOU_QUIET } from './homeCaptions';
import { shortAgo } from './timeOfDay';

/** Rows shown before the "show more" control — the column is a shortlist. */
const VISIBLE_ROWS = 6;

export type NeedsYouStatus = 'loading' | 'ready' | 'error';

/**
 * The Needs-you ranking, unchanged from the unified list (layout-spec §3.3).
 *
 * Pinned entries and the overflow past the sidebar's cap are folded back in:
 * pinning a conversation must never hide work, and Home is where the whole
 * list lives. `scoreEntry` is the single scorer — Home does not re-rank.
 */
export function homeAttention(entries: ConversationEntry[]) {
  const unique = new Map(entries.map((entry) => [entry.key, entry]));
  const now = Date.now();
  return [...unique.values()]
    .filter(
      (entry) =>
        entry.mentionCount > 0 ||
        entry.isDMUnread ||
        entry.isThreadReply ||
        entry.unread ||
        entry.hasVoiceActivity,
    )
    .sort((a, b) => scoreEntry(b, now) - scoreEntry(a, now) || a.key.localeCompare(b.key));
}

/** The one action a row offers (§7.5: lit avatar, reason, one action). */
export type NeedsYouAction = 'Open' | 'Reply' | 'Accept';

function actionFor(entry: ConversationEntry): NeedsYouAction {
  return entry.kind === 'dm' || entry.kind === 'group_dm' ? 'Reply' : 'Open';
}

/**
 * Why this row is here, said in the metaphor.
 *
 * The author is named when we know it and it is not you — "You mentioned you"
 * is never a sentence this app says, so a mention whose author resolves to the
 * local account falls back to the count.
 */
export function needsYouReason(entry: ConversationEntry, authorName: string | null): string {
  if (entry.mentionCount > 0) {
    return authorName ? `${authorName} mentioned you` : mentionCaption(entry.mentionCount);
  }
  if (entry.isDMUnread) return entry.title;
  if (entry.isThreadReply) return `New replies in ${entry.title}`;
  if (entry.unread) return `New in ${entry.title}`;
  return `${entry.title} lit up`;
}

/** The message body a row previews — never decrypted, never invented. */
function previewOf(message: Message | null, userId: string): { author: string | null; text: string } {
  if (!message) return { author: null, text: 'No message preview available' };
  // Home never decrypts or advances a DM ratchet in the background.
  if (message.e2ee) {
    return { author: null, text: 'Encrypted message — open the conversation to read' };
  }
  const author = message.author.display_name || message.author.username;
  const content = message.content
    ?.trim()
    .replace(/<@!?([0-9]+)>/g, (token, id: string) => (id === userId ? '@you' : token));
  if (content) return { author, text: content };
  if (message.poll) return { author, text: `Poll: ${message.poll.question}` };
  if (message.attachments?.length) return { author, text: 'Attachment' };
  return { author, text: 'New activity' };
}

/** §1.5: presence is a rim of light, never a coloured dot. */
function usePersonLight(
  userId: string | null | undefined,
  name: string,
  serverId: string | undefined,
  avatar: string | null | undefined,
): PersonLight | null {
  const status = usePresenceStore((state) =>
    userId ? (state.getPresence(userId, serverId)?.status ?? 'offline') : 'offline',
  );
  return useMemo(
    () =>
      userId
        ? personLight({ userId, name, status, avatar: avatar ?? null })
        : null,
    [userId, name, status, avatar],
  );
}

interface RowShellProps {
  lead: ReactNode;
  reason: string;
  time: string | null;
  context: ReactNode;
  action: ReactNode;
  /** The first row is raised — the one thing most likely to need you. */
  raised?: boolean;
  trailing?: ReactNode;
  dataKey?: string;
}

/**
 * NeedsYouRow — `32px 1fr auto` (docs/lantern-stage-spec.md §8).
 *
 * Lit avatar, the reason in Gabarito, one line of context, and exactly one
 * action. The row itself is not a button: a row with an action inside it and a
 * click target around it is two targets pretending to be one.
 */
function NeedsYouRow({ lead, reason, time, context, action, raised, trailing, dataKey }: RowShellProps) {
  return (
    <li
      data-conversation-key={dataKey}
      className={cn(
        'relative grid min-w-0 grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1',
        'rounded-[var(--radius-card)] px-3.5 py-3',
        raised && 'bg-bg-raised shadow-[var(--shadow-raised)]',
      )}
    >
      {lead}
      <span className="min-w-0">
        <span className="flex items-baseline gap-2">
          <span className="pc-display truncate text-name font-semibold text-text-primary">
            {reason}
          </span>
          {time && <span className="shrink-0 text-meta text-text-faint">{time}</span>}
        </span>
        <span className="mt-0.5 block truncate text-[13px] text-text-secondary">{context}</span>
      </span>
      {action}
      {trailing}
    </li>
  );
}

/**
 * The fallback lead for a row with no person attached — a window, not a face.
 *
 * It only carries light when the row itself proves somebody is in there (a live
 * room). An unread text room is dark here: nobody has told us anyone is reading
 * it, and a light with no source is the one thing this design never draws (§0).
 */
function RoomLead({ talking = false }: { talking?: boolean }) {
  return (
    <span className="flex h-8 w-8 items-center justify-center" aria-hidden>
      <span className={cn('pc-window', talking && 'is-talking')} style={{ width: 10, height: 13 }} />
    </span>
  );
}

function RequestRow({
  request,
  raised,
  onAccept,
}: {
  request: FriendRequestEntry;
  raised: boolean;
  onAccept: (userId: string) => void;
}) {
  const person = usePersonLight(request.userId, request.username, undefined, null);
  return (
    <NeedsYouRow
      raised={raised}
      lead={person ? <LitAvatar person={person} size={32} /> : <RoomLead />}
      reason={request.username}
      time={shortAgo(request.createdMs, Date.now())}
      context="wants to be friends"
      action={
        <Button
          size="sm"
          variant="primary"
          className="shrink-0"
          onClick={() => onAccept(request.userId)}
          aria-label={`Accept ${request.username}'s friend request`}
        >
          Accept
        </Button>
      }
    />
  );
}

function AttentionRow({
  entry,
  raised,
  onOpen,
}: {
  entry: ConversationEntry;
  raised: boolean;
  onOpen: (entry: ConversationEntry, messageId?: string) => void;
}) {
  const after = useReadStateStore(
    (state) => state.byAccount[accountScopeKey(entry.scope)]?.[entry.channelId]?.last_message_id ?? '0',
  );
  const attentionRevision = useReadStateStore(
    (state) => state.attentionRevisions[accountScopeKey(entry.scope)]?.[entry.channelId] ?? 0,
  );
  const historyEpoch = useSyncExternalStore(subscribeDatabaseHistory, () => {
    try {
      return getDatabaseHistoryEpoch(entry.scope);
    } catch {
      return 'unavailable' as const;
    }
  });
  const historyUnavailable = historyEpoch === 'unavailable';
  const kind = entry.mentionCount > 0 ? 'mention' : 'unread';
  const [preview, setPreview] = useState<{
    revision: string;
    author: string | null;
    authorId: string | null;
    avatar: string | null;
    text: string;
    messageId?: string;
    failed?: boolean;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const revision = JSON.stringify([
    entry.key,
    historyEpoch,
    entry.lastActivityId,
    entry.mentionCount,
    kind,
    after,
    retry,
    attentionRevision,
  ]);
  const failed = historyUnavailable || (preview?.revision === revision && preview.failed);
  const voiceOnly =
    entry.hasVoiceActivity &&
    !entry.unread &&
    !entry.isDMUnread &&
    !entry.isThreadReply &&
    !entry.mentionCount;
  const { serverId, userId } = entry.scope;

  useEffect(() => {
    if (voiceOnly || !entry.lastActivityId || historyUnavailable) return;
    let disposed = false;
    let context: ReturnType<typeof captureScopedOperation> | undefined;
    void (async () => {
      try {
        context = captureScopedOperation({ serverId, userId });
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
        if (
          data.channel_id !== entry.channelId ||
          data.user_id !== userId ||
          data.kind !== kind ||
          (data.message !== null &&
            (!data.message ||
              data.message.channel_id !== entry.channelId ||
              typeof data.message.id !== 'string' ||
              !/^[1-9][0-9]*$/.test(data.message.id) ||
              BigInt(data.message.id) <= BigInt(after)))
        ) {
          throw new Error('Invalid attention response');
        }
        const body = data.message
          ? previewOf(data.message, userId)
          : {
              author: null,
              text:
                kind === 'mention'
                  ? 'No unread mention target is available'
                  : 'No unread message remains',
            };
        setPreview({
          revision,
          author: body.author,
          authorId: data.message?.author?.id ?? null,
          avatar: data.message?.author?.avatar_hash ?? null,
          text: body.text,
          messageId: data.message?.id,
        });
      } catch {
        if (!disposed) {
          setPreview({
            revision,
            author: null,
            authorId: null,
            avatar: null,
            text: 'Preview unavailable',
            failed: true,
          });
        }
      } finally {
        context?.dispose();
      }
    })();
    return () => {
      disposed = true;
      context?.dispose();
    };
  }, [
    entry.channelId,
    entry.lastActivityId,
    serverId,
    userId,
    revision,
    retry,
    voiceOnly,
    kind,
    after,
    historyUnavailable,
  ]);

  const fresh = preview?.revision === revision && !preview.failed ? preview : null;
  const targetId = fresh?.messageId;
  // A mention by yourself is not a mention worth naming (see `needsYouReason`).
  const authorName = fresh && fresh.authorId && fresh.authorId !== userId ? fresh.author : null;
  const reason = needsYouReason(entry, authorName);
  const action = actionFor(entry);

  const previewLine = voiceOnly
    ? 'Open this channel to join what is happening'
    : historyUnavailable
      ? 'Reconnect this account to restore previews'
      : failed
        ? 'Preview unavailable'
        : fresh
          ? entry.mentionCount > 0
            ? fresh.text
            : fresh.author
              ? `${fresh.author}: ${fresh.text}`
              : fresh.text
          : entry.lastActivityId
            ? 'Loading…'
            : 'No message preview available';

  const place =
    entry.mentionCount > 0
      ? entry.title
      : entry.kind === 'dm' || entry.kind === 'group_dm'
        ? null
        : entry.contextLabel;
  const context = [place, previewLine].filter(Boolean).join(' · ');

  // The lead avatar is the person whose message is waiting: the DM's peer, or
  // the author the attention feed just named.
  const leadUserId = entry.kind === 'dm' ? (entry.userId ?? null) : (fresh?.authorId ?? null);
  const leadName =
    entry.kind === 'dm' ? entry.title : (fresh?.author ?? entry.title);
  const leadAvatar = entry.kind === 'dm' ? (entry.avatar ?? null) : (fresh?.avatar ?? null);
  const person = usePersonLight(leadUserId, leadName, serverId, leadAvatar);

  return (
    <NeedsYouRow
      dataKey={entry.key}
      raised={raised}
      lead={
        person ? (
          <LitAvatar person={person} size={32} />
        ) : (
          <RoomLead talking={entry.hasVoiceActivity} />
        )
      }
      reason={`${reason}${entry.pinned ? ' · pinned' : ''}`}
      time={shortAgo(entry.lastActivityId ? snowflakeToMs(entry.lastActivityId) : null, Date.now())}
      context={context}
      action={
        <Button
          size="sm"
          variant="ghost"
          className={cn('shrink-0', raised && 'shadow-[inset_0_0_0_1px_var(--border-strong)]')}
          onClick={() => onOpen(entry, targetId)}
          aria-label={`${action} ${entry.title}`}
        >
          {action}
        </Button>
      }
      trailing={
        failed && !voiceOnly ? (
          <button
            type="button"
            onClick={() =>
              historyUnavailable ? requestHistoryReconciliation(entry.scope) : setRetry((v) => v + 1)
            }
            aria-label={`${historyUnavailable ? 'Reconnect to load' : 'Retry'} preview for ${entry.title}`}
            className="pc-focusable col-start-2 justify-self-start rounded-[var(--radius-control)] px-1.5 py-0.5 text-meta font-semibold text-accent-primary hover:bg-bg-mod-subtle"
          >
            {historyUnavailable ? 'Reconnect' : 'Retry'}
          </button>
        ) : null
      }
    />
  );
}

export interface HomeNeedsYouProps {
  entries: ConversationEntry[];
  requests: readonly FriendRequestEntry[];
  /** Whether the activity behind the list is known yet — quiet copy depends on it. */
  status: NeedsYouStatus;
  onOpen: (entry: ConversationEntry, messageId?: string) => void;
  onAccept: (userId: string) => void;
  onRefresh: () => void;
}

/**
 * Needs you — the right column of Home (docs/lantern-stage-spec.md §7.5).
 *
 * Friend requests first (somebody is literally waiting on an answer), then the
 * unified list's own ranking. The order is **held** while a pointer is over the
 * section or focus is inside it, so a row never moves out from under the cursor
 * when a new message lands.
 *
 * The quiet state tells the truth: it only says nothing is waiting once the
 * activity behind it is actually known.
 */
export function HomeNeedsYou({
  entries,
  requests,
  status,
  onOpen,
  onAccept,
  onRefresh,
}: HomeNeedsYouProps) {
  const [heldKeys, setHeldKeys] = useState<string[] | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [visibleCount, setVisibleCount] = useState(VISIBLE_ROWS);

  const ordered = useMemo(() => {
    if (!heldKeys) return entries;
    const current = new Map(entries.map((entry) => [entry.key, entry]));
    const held = new Set(heldKeys);
    // Removed entries disappear immediately; new work waits at the end.
    return [
      ...heldKeys.flatMap((key) => (current.get(key) ? [current.get(key)!] : [])),
      ...entries.filter((entry) => !held.has(entry.key)),
    ];
  }, [entries, heldKeys]);

  const hold = () => setHeldKeys((keys) => keys ?? ordered.map((entry) => entry.key));
  const release = () => setHeldKeys(null);

  const total = entries.length + requests.length;
  const visible = ordered.slice(0, Math.max(0, visibleCount - requests.length));

  return (
    <section
      aria-label="Needs you"
      className="flex min-w-0 flex-col gap-2"
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') {
          setHovered(true);
          hold();
        }
      }}
      onPointerLeave={() => {
        setHovered(false);
        if (!focused) release();
      }}
      onFocusCapture={() => {
        setFocused(true);
        hold();
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
          if (!hovered) release();
        }
      }}
    >
      <SectionLabel
        className="px-0 pb-0.5 pt-0"
        meta={total > 0 ? <span className="text-text-primary">{total}</span> : undefined}
      >
        Needs you
      </SectionLabel>

      {total === 0 ? (
        <p className="text-[13px] text-text-muted">
          {NEEDS_YOU_QUIET[status]}
          {status === 'error' && (
            <>
              {' '}
              <button
                type="button"
                onClick={onRefresh}
                className="pc-focusable rounded-[var(--radius-control)] font-semibold text-accent-primary underline-offset-4 hover:underline"
              >
                Refresh
              </button>
            </>
          )}
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-1">
          {requests.map((request, index) => (
            <RequestRow
              key={request.key}
              request={request}
              raised={index === 0}
              onAccept={onAccept}
            />
          ))}
          {visible.map((entry, index) => (
            <AttentionRow
              key={entry.key}
              entry={entry}
              raised={requests.length === 0 && index === 0}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}

      {entries.length > VISIBLE_ROWS && (
        <button
          type="button"
          onClick={() =>
            setVisibleCount((value) => (value >= total ? VISIBLE_ROWS : value + VISIBLE_ROWS))
          }
          className="pc-focusable self-start rounded-[var(--radius-control)] px-1.5 py-1 text-label font-semibold text-accent-primary hover:bg-bg-mod-subtle"
        >
          {visibleCount >= total
            ? 'Show fewer'
            : `Show ${Math.min(VISIBLE_ROWS, total - visibleCount)} more`}
        </button>
      )}
    </section>
  );
}
