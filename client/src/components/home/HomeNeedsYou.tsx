import { useId, useMemo, useState, type ReactNode } from 'react';

import { Button } from '../ui';
import { LitAvatar } from '../light';
import { cn } from '../../lib/utils';
import { personLight, type PersonLight } from '../../lib/attention/light';
import type { ConversationEntry } from '../../lib/attention/conversationModel';
import { snowflakeToMs } from '../../lib/attention/conversationModel';
import { hasDirectAttention, scoreEntry } from '../../lib/attention/scoreConversation';
import { usePresenceStore } from '../../stores/presenceStore';
import type { FriendRequestEntry } from '../../hooks/useUnifiedConversations';
import { mentionCaption, NEEDS_YOU_QUIET } from './homeCaptions';
import { shortAgo } from './timeOfDay';
import { useHomeMessagePreview } from './useHomeMessagePreview';
import { useScopedAvatar } from '../../hooks/useScopedAvatar';

/** Rows shown before the "show more" control — the column is a shortlist. */
const VISIBLE_ROWS = 6;

export type NeedsYouStatus = 'loading' | 'ready' | 'error';

/**
 * Direct attention uses the unified list’s existing ranking (layout-spec §3.3).
 *
 * Pinned entries and the overflow past the sidebar's cap are folded back in:
 * pinning a conversation must never hide a direct reply. Ordinary unread
 * channels and voice activity belong among the conversations you can return to.
 * `scoreEntry` is the single scorer — Home does not re-rank.
 */
export function homeAttention(entries: ConversationEntry[]) {
  const unique = new Map(entries.map((entry) => [entry.key, entry]));
  const now = Date.now();
  return [...unique.values()]
    .filter(hasDirectAttention)
    .sort((a, b) => scoreEntry(b, now) - scoreEntry(a, now) || a.key.localeCompare(b.key));
}

/** The one action a row offers (§7.5: lit avatar, reason, one action). */
export type NeedsYouAction = 'Open' | 'Reply' | 'Accept';

function actionFor(entry: ConversationEntry): NeedsYouAction {
  return entry.kind === 'dm' || entry.kind === 'group_dm' ? 'Reply' : 'Open';
}

/**
 * Why this row is here, in one plain line.
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
  return `Activity in ${entry.title}`;
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
  action?: ReactNode;
  onActivate?: () => void;
  actionLabel?: string;
  /** A quiet highlight keeps the first direct reply easy to find. */
  raised?: boolean;
  trailing?: ReactNode;
  dataKey?: string;
}

/**
 * One full-row conversation action. Request acceptance and retry are separate
 * controls, so no button contains another button.
 */
function NeedsYouRow({
  lead, reason, time, context, action, onActivate, actionLabel, raised, trailing, dataKey,
}: RowShellProps) {
  const reasonId = useId();
  const contextId = useId();
  const content = (
    <>
      {lead}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span id={reasonId} className="pc-display min-w-0 line-clamp-2 break-words text-name font-semibold text-text-primary">
            {reason}
          </span>
          {time && <span className="ml-auto shrink-0 text-meta text-text-faint">{time}</span>}
        </span>
        <span id={contextId} className="mt-1 block text-[13px] leading-relaxed text-text-secondary">
          <span className="line-clamp-2 break-words">{context}</span>
        </span>
      </span>
    </>
  );
  return (
    <li
      data-conversation-key={dataKey}
      className={cn(
        'min-w-0 rounded-[var(--radius-control)]',
        raised && 'bg-bg-mod-subtle',
      )}
    >
      {onActivate ? (
        <button
          type="button"
          onClick={onActivate}
          aria-label={actionLabel}
          aria-describedby={`${reasonId} ${contextId}`}
          className="pc-focusable flex w-full min-w-0 items-start gap-3 rounded-[var(--radius-control)] px-3 py-3.5 text-left transition-colors hover:bg-bg-mod-subtle"
        >
          {content}
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-3 px-3 py-3.5">
          {content}
          {action}
        </div>
      )}
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
    <span className="flex h-10 w-10 shrink-0 items-center justify-center" aria-hidden>
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
      lead={person ? <LitAvatar person={person} size={40} /> : <RoomLead />}
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
  const { preview: fresh, text, failed, historyUnavailable, retry } = useHomeMessagePreview(entry, 'attention');
  const { serverId, userId } = entry.scope;
  const targetId = fresh?.messageId;
  // A mention by yourself is not a mention worth naming (see `needsYouReason`).
  const authorName = fresh && fresh.authorId && fresh.authorId !== userId ? fresh.author : null;
  const reason = needsYouReason(entry, authorName);
  const action = actionFor(entry);

  const previewLine = fresh?.author && entry.mentionCount === 0
    ? `${fresh.author}: ${text}`
    : text;

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
  const avatar = useScopedAvatar(leadAvatar, entry.scope);
  const person = usePersonLight(leadUserId, leadName, serverId, avatar);

  return (
    <NeedsYouRow
      dataKey={entry.key}
      raised={raised}
      lead={
        person ? (
          <LitAvatar person={person} size={40} />
        ) : (
          <RoomLead talking={entry.hasVoiceActivity} />
        )
      }
      reason={`${reason}${entry.pinned ? ' · pinned' : ''}`}
      time={shortAgo(targetId ? snowflakeToMs(targetId) : entry.lastActivityId ? snowflakeToMs(entry.lastActivityId) : null, Date.now())}
      context={context}
      onActivate={() => onOpen(entry, targetId)}
      actionLabel={`${action} ${entry.title}`}
      trailing={
        failed ? (
          <button
            type="button"
            onClick={retry}
            aria-label={`${historyUnavailable ? 'Reconnect to load' : 'Retry'} preview for ${entry.title}`}
            className="pc-focusable mb-2 ml-[61px] rounded-[var(--radius-control)] px-1.5 py-0.5 text-meta font-semibold text-accent-primary hover:bg-bg-mod-subtle"
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
 * For you — direct replies and friend requests on Home.
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
      aria-label="For you"
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
      <div className="flex items-baseline justify-between gap-2 pb-1">
        <h2 className="pc-display text-[18px] font-semibold text-text-primary">For you</h2>
        {total > 0 && <span className="text-meta text-text-muted">{total}</span>}
      </div>

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

      {total > VISIBLE_ROWS && (
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
