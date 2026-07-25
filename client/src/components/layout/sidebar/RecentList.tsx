import { ChevronDown, ChevronUp, MessagesSquare } from 'lucide-react';
import { ConversationRow } from './ConversationRow';
import { VoiceChannelOccupants } from './VoiceChannelOccupants';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';

/**
 * "Recent" section (layout-spec §1, §7.7). The heterogeneous, MERGED-ACROSS-SERVERS
 * conversation list — guild channels (with a context label), DMs, group DMs, threads —
 * sorted by recency by `useUnifiedConversations`. Each entry renders as a
 * ConversationRow, which picks its own leading element by kind.
 *
 * Zero-state comfort (design-spec Empty-state recipe; kill-list #4/#11): a left-aligned
 * icon-in-well, one warm specific line, and two quiet inline actions (Add a friend /
 * Explore spaces) so a brand-new account can still reach people. When non-empty, a
 * the list is bounded by the sidebar and can expand in place, so Spaces remains visible
 * by default without pretending a DM-only route contains every conversation kind.
 */

export interface RecentListProps {
  entries: ConversationEntry[];
  activeKey?: string | null;
  onSelect: (entry: ConversationEntry) => void;
  /** Zero-state action → the friends surface (/app/friends). */
  onAddFriend?: () => void;
  /** Zero-state action → server discovery (/app/discovery). */
  onExploreServers?: () => void;
  /** Total number of recent conversations before the sidebar's collapsed cap. */
  totalCount?: number;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  /** Flat roving-tabindex ordinal of this section's first row (SHELL-5 wires the handler). */
  navIndexStart?: number;
  /** Flat ordinal of the single roving Tab stop; -1 on every other row. */
  activeNavIndex?: number;
}

/** Quiet inline text action for the zero-state (emerald link affordance). */
function InlineAction({ label, onClick }: { label: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xs text-meta font-medium text-accent-primary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:text-accent-primary-hover focus-visible:shadow-[var(--focus-ring)]"
    >
      {label}
    </button>
  );
}

export function RecentList({
  entries,
  activeKey,
  onSelect,
  onAddFriend,
  onExploreServers,
  totalCount = entries.length,
  expanded = false,
  onToggleExpanded,
  navIndexStart = 0,
  activeNavIndex,
}: RecentListProps) {
  const hiddenCount = Math.max(0, totalCount - entries.length);
  const canCollapse = expanded && totalCount > 0;

  return (
    <section aria-label="Recent" className="flex flex-col gap-0.5">
      <h2 className="px-2 pb-1 text-section uppercase text-text-muted">Recent</h2>

      {entries.length === 0 ? (
        <div className="flex flex-col items-start gap-1.5 px-2 py-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
            <MessagesSquare size={18} aria-hidden />
          </span>
          <p className="text-label font-medium text-text-primary">Nothing here just yet</p>
          <p className="text-meta text-text-secondary">Conversations you visit will gather here.</p>
          <div className="mt-1 flex items-center gap-3">
            <InlineAction label="Add a friend" onClick={onAddFriend} />
            <span aria-hidden className="text-meta text-text-muted">·</span>
            <InlineAction label="Explore spaces" onClick={onExploreServers} />
          </div>
        </div>
      ) : (
        <>
          <div role="group" aria-label="Recent conversations" className="flex flex-col gap-0.5">
            {entries.map((entry, i) => (
              <div key={entry.key}>
                <ConversationRow
                  entry={entry}
                  active={entry.key === activeKey}
                  onClick={onSelect}
                  navIndex={navIndexStart + i}
                  tabIndex={navIndexStart + i === activeNavIndex ? 0 : -1}
                />
                <VoiceChannelOccupants entry={entry} />
              </div>
            ))}
          </div>
          {(hiddenCount > 0 || canCollapse) && (
            <button
              type="button"
              onClick={onToggleExpanded}
              aria-expanded={expanded}
              className="group mt-0.5 flex items-center gap-1 self-start rounded-sm px-2 py-1 text-meta text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
            >
              {expanded ? 'Show fewer' : `Show ${hiddenCount} more`}
              {expanded ? (
                <ChevronUp size={12} aria-hidden />
              ) : (
                <ChevronDown size={12} aria-hidden />
              )}
            </button>
          )}
        </>
      )}
    </section>
  );
}
