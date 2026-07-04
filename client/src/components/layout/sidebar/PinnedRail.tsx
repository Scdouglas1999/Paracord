import { ConversationRow } from './ConversationRow';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';

/**
 * Pinned conversations rail (layout-spec §1, §3.4). Renders the user's pinned
 * conversations — in pin order, as supplied by `useUnifiedConversations().pinned` —
 * floating ABOVE Recent. Hidden entirely when there are no pins (no empty header).
 *
 * Pure/props-driven; the sidebar (SHELL-4) passes the hook output straight through.
 */

export interface PinnedRailProps {
  entries: ConversationEntry[];
  activeKey?: string | null;
  onSelect: (entry: ConversationEntry) => void;
  /** Flat roving-tabindex ordinal of this section's first row (SHELL-5 wires the handler). */
  navIndexStart?: number;
}

export function PinnedRail({ entries, activeKey, onSelect, navIndexStart = 0 }: PinnedRailProps) {
  if (entries.length === 0) return null;

  return (
    <section aria-label="Pinned" className="flex flex-col gap-0.5">
      <h2 className="px-2 pb-1 text-section uppercase text-text-muted">Pinned</h2>
      <div role="listbox" aria-label="Pinned conversations" className="flex flex-col gap-0.5">
        {entries.map((entry, i) => (
          <ConversationRow
            key={entry.key}
            entry={entry}
            active={entry.key === activeKey}
            onClick={onSelect}
            navIndex={navIndexStart + i}
          />
        ))}
      </div>
    </section>
  );
}
