import { MessagesSquare } from 'lucide-react';
import { ConversationRow } from './ConversationRow';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';

/**
 * "Recent" section (layout-spec §1, §7.6). The heterogeneous, MERGED-ACROSS-SERVERS
 * conversation list — guild channels (with a context label), DMs, group DMs, threads —
 * sorted by recency by `useUnifiedConversations`. Each entry renders as a
 * ConversationRow, which picks its own leading element by kind.
 *
 * Empty state is left-aligned with warm, specific copy (design-spec Empty-state recipe;
 * kill-list #4/#11). Pure/props-driven for isolation.
 */

export interface RecentListProps {
  entries: ConversationEntry[];
  activeKey?: string | null;
  onSelect: (entry: ConversationEntry) => void;
  /** Flat roving-tabindex ordinal of this section's first row (SHELL-5 wires the handler). */
  navIndexStart?: number;
  /** Flat ordinal of the single roving Tab stop; -1 on every other row. */
  activeNavIndex?: number;
}

export function RecentList({ entries, activeKey, onSelect, navIndexStart = 0, activeNavIndex }: RecentListProps) {
  return (
    <section aria-label="Recent" className="flex flex-col gap-0.5">
      <h2 className="px-2 pb-1 text-section uppercase text-text-muted">Recent</h2>

      {entries.length === 0 ? (
        <div className="flex flex-col items-start gap-1.5 px-2 py-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
            <MessagesSquare size={18} aria-hidden />
          </span>
          <p className="text-label font-medium text-text-primary">Nothing going yet</p>
          <p className="text-meta text-text-secondary">
            Open a channel or start a DM and it&apos;ll show up right here.
          </p>
        </div>
      ) : (
        <div role="group" aria-label="Recent conversations" className="flex flex-col gap-0.5">
          {entries.map((entry, i) => (
            <ConversationRow
              key={entry.key}
              entry={entry}
              active={entry.key === activeKey}
              onClick={onSelect}
              navIndex={navIndexStart + i}
              tabIndex={navIndexStart + i === activeNavIndex ? 0 : -1}
            />
          ))}
        </div>
      )}
    </section>
  );
}
