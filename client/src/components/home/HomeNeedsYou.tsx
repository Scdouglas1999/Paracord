import { useId, useMemo, useState, type ReactNode } from 'react';

import { Button } from '../ui';
import { GlyphTile } from '../glass/places/Lead';
import { badgeFor, type FaceModel } from '../glass/places/model';
import type { ConversationEntry } from '../../lib/attention/conversationModel';
import { snowflakeToMs } from '../../lib/attention/conversationModel';
import { hasDirectAttention, scoreEntry } from '../../lib/attention/scoreConversation';
import { usePresenceStore } from '../../stores/presenceStore';
import type { FriendRequestEntry } from '../../hooks/useUnifiedConversations';
import { mentionCaption, NEEDS_YOU_QUIET } from './homeCaptions';
import { PageNote, PageSection } from './GlassPage';
import { PagePerson, PageRow, RowBadge, RowTime } from './PageRow';
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

/**
 * The face on a row and whether they are here. Presence is read PER ROW (its own
 * store selector), and it is ink on the face, never a colored dot (§1.3).
 */
function usePerson(
  userId: string | null | undefined,
  name: string,
  serverId: string | undefined,
  avatar: string | null | undefined,
): { face: FaceModel; status: string } | null {
  const status = usePresenceStore((state) =>
    userId ? (state.getPresence(userId, serverId)?.status ?? 'offline') : 'offline',
  );
  return useMemo(
    () => (userId ? { face: { userId, name, avatar: avatar ?? null }, status } : null),
    [userId, name, avatar, status],
  );
}

interface RowShellProps {
  lead: ReactNode;
  reason: string;
  time: string | null;
  context: ReactNode;
  /** A decision beside the row, when the row itself is not the way in. */
  action?: ReactNode;
  onActivate?: () => void;
  actionLabel?: string;
  badge?: ReturnType<typeof badgeFor>;
  dataKey?: string;
}

/**
 * One full-row conversation action. Request acceptance and retry are separate
 * controls, so no button contains another button.
 */
function NeedsYouRow({ lead, reason, time, context, action, onActivate, actionLabel, badge, dataKey }: RowShellProps) {
  const reasonId = useId();
  const contextId = useId();
  return (
    <PageRow
      dataKey={dataKey}
      lead={lead}
      title={reason}
      titleId={reasonId}
      line={context}
      lineId={contextId}
      wrap
      aside={
        time || badge ? (
          <>
            {time && <RowTime>{time}</RowTime>}
            <RowBadge badge={badge ?? null} />
          </>
        ) : undefined
      }
      onOpen={onActivate}
      label={actionLabel}
      describedBy={`${reasonId} ${contextId}`}
      actions={action}
    />
  );
}

/**
 * The lead for a row with no person attached: a tile with the channel's glyph.
 * It never claims light: a room is live only when the row itself proves somebody
 * is in a call there.
 */
function RoomLead({ voice = false }: { voice?: boolean }) {
  return <GlyphTile glyph={voice ? 'voice' : 'chat'} />;
}

function RequestRow({
  request,
  onAccept,
}: {
  request: FriendRequestEntry;
  onAccept: (userId: string) => void;
}) {
  const person = usePerson(request.userId, request.username, undefined, null);
  return (
    <NeedsYouRow
      lead={person ? <PagePerson face={person.face} /> : <RoomLead />}
      reason={request.username}
      time={shortAgo(request.createdMs, Date.now())}
      context="wants to be friends"
      action={
        <Button
          size="sm"
          variant="glass"
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
  onOpen,
}: {
  entry: ConversationEntry;
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
  const person = usePerson(leadUserId, leadName, serverId, avatar);

  return (
    <NeedsYouRow
      dataKey={entry.key}
      lead={
        person ? (
          <PagePerson face={person.face} status={person.status} live={entry.hasVoiceActivity} />
        ) : (
          <RoomLead voice={entry.hasVoiceActivity} />
        )
      }
      reason={`${reason}${entry.pinned ? ' · pinned' : ''}`}
      time={shortAgo(targetId ? snowflakeToMs(targetId) : entry.lastActivityId ? snowflakeToMs(entry.lastActivityId) : null, Date.now())}
      context={context}
      badge={badgeFor({ muted: false, mentions: entry.mentionCount, unread: entry.isDMUnread || entry.unread, unreadCount: null })}
      onActivate={() => onOpen(entry, targetId)}
      actionLabel={`${action} ${entry.title}`}
      action={
        failed ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={retry}
            aria-label={`${historyUnavailable ? 'Reconnect to load' : 'Retry'} preview for ${entry.title}`}
          >
            {historyUnavailable ? 'Reconnect' : 'Retry'}
          </Button>
        ) : undefined
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
    <PageSection
      kicker="For you"
      label="For you"
      count={total > 0 ? total : null}
      list={total > 0}
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
      footer={
        total > VISIBLE_ROWS ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setVisibleCount((value) => (value >= total ? VISIBLE_ROWS : value + VISIBLE_ROWS))
            }
          >
            {visibleCount >= total
              ? 'Show fewer'
              : `Show ${Math.min(VISIBLE_ROWS, total - visibleCount)} more`}
          </Button>
        ) : undefined
      }
    >
      {total === 0 ? (
        <PageNote>
          {NEEDS_YOU_QUIET[status]}
          {status === 'error' && (
            <>
              {' '}
              <button type="button" onClick={onRefresh} className="glass-focusable">
                Refresh
              </button>
            </>
          )}
        </PageNote>
      ) : (
        <>
          {requests.map((request) => (
            <RequestRow key={request.key} request={request} onAccept={onAccept} />
          ))}
          {visible.map((entry) => (
            <AttentionRow key={entry.key} entry={entry} onOpen={onOpen} />
          ))}
        </>
      )}
    </PageSection>
  );
}
