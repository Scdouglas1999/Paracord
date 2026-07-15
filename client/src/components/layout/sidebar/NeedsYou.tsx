import { CheckCheck, UserPlus } from 'lucide-react';
import { ConversationRow } from './ConversationRow';
import { VoiceChannelOccupants } from './VoiceChannelOccupants';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import type { FriendRequestEntry } from '../../../hooks/useUnifiedConversations';
import { cn } from '../../../lib/utils';

/**
 * "Needs you" section (layout-spec §1, §7.7). Attention-ranked entries — already
 * scored and capped at 6 by `useUnifiedConversations` — rendered as ConversationRows
 * under a --text-section uppercase header. Incoming friend requests rank ABOVE them
 * (they are literally waiting on the user) as RequestRows that open /app/friends.
 * Empty state is left-aligned with warm, specific copy (design-spec Empty-state recipe;
 * kill-list #4/#11 — never "It's quiet").
 *
 * Pure/props-driven so the sidebar (SHELL-4) can pass the hook output straight through
 * and it stays testable in isolation.
 */

/** Compact relative label for a request timestamp ("now" / "5m" / "2h" / "3d"). */
function compactAgo(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

interface RequestRowProps {
  request: FriendRequestEntry;
  onOpen: (request: FriendRequestEntry) => void;
  navIndex: number;
  tabIndex: number;
}

function RequestRow({ request, onOpen, navIndex, tabIndex }: RequestRowProps) {
  const ts = request.createdMs != null ? compactAgo(request.createdMs) : null;
  return (
    <button
      type="button"
      role="option"
      aria-selected={false}
      data-nav-index={navIndex}
      tabIndex={tabIndex}
      onClick={() => onOpen(request)}
      className={cn(
        'group relative flex h-[34px] w-full items-center gap-2 rounded-sm px-2 text-left outline-none',
        'text-text-secondary transition-colors duration-[140ms] ease-[var(--ease-out)]',
        'hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]',
      )}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-tint text-accent-primary">
        <UserPlus size={13} aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate text-label">
        <span className="font-semibold text-text-primary">{request.username}</span>
        {' sent a friend request'}
      </span>
      {ts && <span className="shrink-0 text-meta tabular-nums text-text-muted">{ts}</span>}
    </button>
  );
}

export interface NeedsYouProps {
  entries: ConversationEntry[];
  /** Attention-bearing entries that continue in Recent after the six-row cap. */
  overflowCount?: number;
  /** Incoming friend requests, rendered above the ranked conversation rows. */
  requests?: FriendRequestEntry[];
  /** Open the friends surface (/app/friends) from a request row. */
  onOpenRequest?: (request: FriendRequestEntry) => void;
  activeKey?: string | null;
  onSelect: (entry: ConversationEntry) => void;
  /** Flat roving-tabindex ordinal of this section's first row (SHELL-5 wires the handler). */
  navIndexStart?: number;
  /** Flat ordinal of the single roving Tab stop; -1 on every other row. */
  activeNavIndex?: number;
}

export function NeedsYou({
  entries,
  overflowCount = 0,
  requests = [],
  onOpenRequest,
  activeKey,
  onSelect,
  navIndexStart = 0,
  activeNavIndex,
}: NeedsYouProps) {
  const isEmpty = requests.length === 0 && entries.length === 0;

  return (
    <section aria-label="Needs you" className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-2 px-2 pb-1">
        <h2 className="text-section uppercase text-text-muted">Needs you</h2>
        {overflowCount > 0 && (
          <span className="text-meta normal-case tabular-nums text-text-muted">
            +{overflowCount} below
          </span>
        )}
      </div>

      {isEmpty ? (
        <div className="flex flex-col items-start gap-1.5 px-2 py-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
            <CheckCheck size={18} aria-hidden />
          </span>
          <p className="text-label font-medium text-text-primary">You&apos;re all caught up</p>
          <p className="text-meta text-text-secondary">
            Mentions, friend requests, and unread DMs land here the moment they need you.
          </p>
        </div>
      ) : (
        <div role="group" aria-label="Needs you conversations" className="flex flex-col gap-0.5">
          {requests.map((request, i) => (
            <RequestRow
              key={request.key}
              request={request}
              onOpen={onOpenRequest ?? (() => {})}
              navIndex={navIndexStart + i}
              tabIndex={navIndexStart + i === activeNavIndex ? 0 : -1}
            />
          ))}
          {entries.map((entry, i) => {
            const navIndex = navIndexStart + requests.length + i;
            return (
              <div key={entry.key}>
                <ConversationRow
                  entry={entry}
                  active={entry.key === activeKey}
                  onClick={onSelect}
                  navIndex={navIndex}
                  tabIndex={navIndex === activeNavIndex ? 0 : -1}
                />
                <VoiceChannelOccupants entry={entry} />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
