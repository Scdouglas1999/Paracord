import { useId, useMemo } from 'react';

import { LitAvatar } from '../light';
import { cn } from '../../lib/utils';
import { personLight } from '../../lib/attention/light';
import { snowflakeToMs, type ConversationEntry } from '../../lib/attention/conversationModel';
import { usePresenceStore } from '../../stores/presenceStore';
import { shortAgo } from './timeOfDay';
import { useHomeMessagePreview } from './useHomeMessagePreview';
import { useScopedAvatar } from '../../hooks/useScopedAvatar';

export interface HomePickUpProps {
  entries: readonly ConversationEntry[];
  /**
   * Room keys (`entityScopeKey(scope, channelId)`) that are lit right now, so a
   * row's window dot is the same light the building's map is showing. Anything
   * not in here draws dark — this component never decides a room is lit.
   */
  litRooms: ReadonlySet<string>;
  onOpen: (entry: ConversationEntry) => void;
}

/** Where you were, in one line: "Saltmarsh Sailing · last message 40m ago". */
export function pickUpContext(entry: ConversationEntry, nowMs: number): string {
  const ago = shortAgo(entry.lastActivityId ? snowflakeToMs(entry.lastActivityId) : null, nowMs);
  const where = entry.kind === 'dm' || entry.kind === 'group_dm' ? 'direct' : entry.contextLabel;
  const when = !ago
    ? 'nothing new since you left'
    : ago === 'now'
      ? 'last message just now'
      : `last message ${ago} ago`;
  return [where, when].filter(Boolean).join(' · ');
}

function PickUpRow({
  entry,
  lit,
  onOpen,
}: {
  entry: ConversationEntry;
  lit: boolean;
  onOpen: (entry: ConversationEntry) => void;
}) {
  const { preview, text, failed, historyUnavailable, retry } = useHomeMessagePreview(entry, 'latest');
  const contextId = useId();
  const previewId = useId();
  const isDm = entry.kind === 'dm';
  const leadUserId = isDm ? entry.userId : preview?.authorId;
  const leadName = isDm ? entry.title : preview?.author ?? entry.title;
  const leadAvatar = useScopedAvatar(isDm ? entry.avatar : preview?.avatar, entry.scope);
  const status = usePresenceStore((state) =>
    leadUserId
      ? (state.getPresence(leadUserId, entry.scope.serverId)?.status ?? 'offline')
      : 'offline',
  );
  const person = useMemo(
    () =>
      leadUserId
        ? personLight({
            userId: leadUserId,
            name: leadName,
            status,
            avatar: leadAvatar ?? null,
          })
        : null,
    [leadUserId, leadName, leadAvatar, status],
  );
  const lastMessageId = preview?.messageId ?? entry.lastActivityId;
  const ago = shortAgo(lastMessageId ? snowflakeToMs(lastMessageId) : null, Date.now());
  const where = isDm ? 'Direct message' : entry.kind === 'group_dm' ? 'Group message' : entry.contextLabel;

  return (
    <li className="min-w-0" data-conversation-key={entry.key}>
      <button
        type="button"
        onClick={() => onOpen(entry)}
        aria-label={`Open ${entry.title}`}
        aria-describedby={`${contextId} ${previewId}`}
        className={cn(
          'pc-focusable flex w-full min-w-0 items-start gap-3.5 rounded-[var(--radius-control)] px-3 py-4 text-left',
          'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-subtle',
        )}
      >
        {person ? (
          <LitAvatar person={person} size={44} />
        ) : (
          <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center">
            <span className={cn('pc-window', lit && 'is-reading')} style={{ width: 10, height: 13 }} />
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-3">
            <span className="pc-display min-w-0 truncate text-[17px] font-semibold text-text-primary">
              {entry.kind === 'guild_text' || entry.kind === 'thread' ? <span aria-hidden className="mr-1 text-text-muted">#</span> : null}
              {entry.title}
            </span>
            {ago && <span className="ml-auto shrink-0 text-meta text-text-faint">{ago}</span>}
          </span>
          <span id={contextId} className="mt-0.5 truncate text-meta text-text-muted">
            {where}
            {entry.unread && <span className="sr-only"> · unread</span>}
          </span>
          <span id={previewId} className="mt-1.5 line-clamp-2 break-words text-[14px] leading-relaxed text-text-secondary">
            {preview?.author && <span className="font-medium text-text-primary">{preview.author}: </span>}
            {text}
          </span>
        </span>
      </button>
      {failed && (
        <button
          type="button"
          onClick={retry}
          aria-label={`${historyUnavailable ? 'Reconnect to load' : 'Retry'} preview for ${entry.title}`}
          className="pc-focusable mb-3 ml-[64px] rounded-[var(--radius-control)] px-1.5 py-0.5 text-meta font-semibold text-accent-primary hover:bg-bg-mod-subtle"
        >
          {historyUnavailable ? 'Reconnect' : 'Retry'}
        </button>
      )}
    </li>
  );
}

/**
 * Pick up the conversation — real recent messages, with room to recognize who
 * wrote them and where they belong.
 *
 * The conversations you were last in that are *not* waiting on you — the ones
 * For you has already claimed are never repeated here. Omitted entirely when
 * there is nothing to return to.
 */
export function HomePickUp({ entries, litRooms, onOpen }: HomePickUpProps) {
  if (entries.length === 0) return null;
  return (
    <section aria-label="Pick up the conversation" className="flex min-w-0 flex-col gap-1">
      <h2 className="pc-display pb-2 text-[20px] font-semibold text-text-primary">Pick up the conversation</h2>
      <ul className="flex min-w-0 flex-col divide-y divide-border-subtle">
        {entries.map((entry) => (
          <PickUpRow
            key={entry.key}
            entry={entry}
            lit={litRooms.has(entry.key)}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </section>
  );
}
