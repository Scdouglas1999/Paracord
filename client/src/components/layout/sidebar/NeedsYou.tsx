import { CheckCheck } from 'lucide-react';
import { ConversationRow } from './ConversationRow';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';

/**
 * "Needs you" section (layout-spec §1, §7.6). Attention-ranked entries — already
 * scored and capped at 6 by `useUnifiedConversations` — rendered as ConversationRows
 * under a --text-section uppercase header. Empty state is left-aligned with warm,
 * specific copy (design-spec Empty-state recipe; kill-list #4/#11 — never "It's quiet").
 *
 * Pure/props-driven so the sidebar (SHELL-4) can pass the hook output straight through
 * and it stays testable in isolation.
 */

export interface NeedsYouProps {
  entries: ConversationEntry[];
  activeKey?: string | null;
  onSelect: (entry: ConversationEntry) => void;
  /** Flat roving-tabindex ordinal of this section's first row (SHELL-5 wires the handler). */
  navIndexStart?: number;
  /** Flat ordinal of the single roving Tab stop; -1 on every other row. */
  activeNavIndex?: number;
}

export function NeedsYou({ entries, activeKey, onSelect, navIndexStart = 0, activeNavIndex }: NeedsYouProps) {
  return (
    <section aria-label="Needs you" className="flex flex-col gap-0.5">
      <h2 className="px-2 pb-1 text-section uppercase text-text-muted">Needs you</h2>

      {entries.length === 0 ? (
        <div className="flex flex-col items-start gap-1.5 px-2 py-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-sm bg-accent-tint text-accent-primary">
            <CheckCheck size={18} aria-hidden />
          </span>
          <p className="text-label font-medium text-text-primary">You&apos;re all caught up</p>
          <p className="text-meta text-text-secondary">
            Mentions and unread DMs land here the moment they need you.
          </p>
        </div>
      ) : (
        <div role="group" aria-label="Needs you conversations" className="flex flex-col gap-0.5">
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
