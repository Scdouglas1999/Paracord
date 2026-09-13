import { useMemo } from 'react';

import { SectionLabel } from '../ui';
import { LitAvatar } from '../light';
import { cn } from '../../lib/utils';
import { personLight } from '../../lib/attention/light';
import { snowflakeToMs, type ConversationEntry } from '../../lib/attention/conversationModel';
import { usePresenceStore } from '../../stores/presenceStore';
import { shortAgo } from './timeOfDay';

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
  const isDm = entry.kind === 'dm';
  const status = usePresenceStore((state) =>
    isDm && entry.userId
      ? (state.getPresence(entry.userId, entry.serverId)?.status ?? 'offline')
      : 'offline',
  );
  const person = useMemo(
    () =>
      isDm && entry.userId
        ? personLight({
            userId: entry.userId,
            name: entry.title,
            status,
            avatar: entry.avatar ?? null,
          })
        : null,
    [isDm, entry.userId, entry.title, entry.avatar, status],
  );

  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={() => onOpen(entry)}
        className={cn(
          'pc-focusable flex w-full min-w-0 items-center gap-3 rounded-[var(--radius-control)] px-3 py-2.5 text-left',
          'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-subtle',
        )}
      >
        {person ? (
          <LitAvatar person={person} size={20} />
        ) : (
          <span
            aria-hidden
            className={cn('pc-window shrink-0', lit && 'is-reading')}
            style={{ width: 8, height: 8 }}
          />
        )}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-label font-semibold text-text-primary">{entry.title}</span>
          <span className="truncate text-meta text-text-faint">
            {pickUpContext(entry, Date.now())}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * Pick up where you left off (docs/lantern-stage-spec.md §7.5).
 *
 * The conversations you were last in that are *not* waiting on you — the ones
 * Needs-you has already claimed are never repeated here. Omitted entirely when
 * there is nothing to return to.
 */
export function HomePickUp({ entries, litRooms, onOpen }: HomePickUpProps) {
  if (entries.length === 0) return null;
  return (
    <section aria-label="Pick up where you left off" className="flex min-w-0 flex-col gap-1">
      <SectionLabel className="px-0 pb-1 pt-3">Pick up where you left off</SectionLabel>
      <ul className="flex min-w-0 flex-col">
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
