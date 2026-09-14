import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Slash, User, MessageSquare, ListFilter } from 'lucide-react';
import { useCommandStore } from '../../stores/commandStore';
import type { ApplicationCommand } from '../../types/commands';
import { ApplicationCommandType } from '../../types/commands';
import type { AutocompleteChoice } from '../../stores/interactionStore';
import { LoadingSpinner } from '../ui/Feedback';

export interface SlashCommandPopupProps {
  query: string;
  guildId: string;
  onSelectCommand: (command: ApplicationCommand) => void;
  onDismiss: () => void;
  visible: boolean;
  /** When set, show bot autocomplete choices instead of the command list. */
  autocompleteChoices?: AutocompleteChoice[];
  autocompleteLoading?: boolean;
  onSelectChoice?: (choice: AutocompleteChoice) => void;
}

const MAX_VISIBLE = 10;

// Popover recipe (lantern-stage-spec §8): --bg-floating, radius-md, 1px --border-subtle,
// --shadow-plate, the shared pc-enter rise+fade.
const POPOVER_CLASS =
  'absolute bottom-full left-2 right-2 z-30 mb-2 rounded-well border border-border-subtle bg-bg-floating shadow-[var(--shadow-plate)]';

export function SlashCommandPopup({
  query,
  guildId,
  onSelectCommand,
  onDismiss,
  visible,
  autocompleteChoices,
  autocompleteLoading = false,
  onSelectChoice,
}: SlashCommandPopupProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const guildCommands = useCommandStore((s) => s.guildCommands);
  const loading = useCommandStore((s) => s.loading);
  const fetchGuildCommands = useCommandStore((s) => s.fetchGuildCommands);

  const showingChoices = autocompleteChoices !== undefined;

  // Fetch commands when popup becomes visible and not already cached
  useEffect(() => {
    if (visible && !showingChoices && !guildCommands.has(guildId)) {
      void fetchGuildCommands(guildId);
    }
  }, [visible, showingChoices, guildId, guildCommands, fetchGuildCommands]);

  const filteredCommands = useMemo(() => {
    if (showingChoices) return [];
    const commands = guildCommands.get(guildId) ?? [];
    const q = query.toLowerCase();
    return commands
      .filter((cmd) => cmd.name.toLowerCase().startsWith(q))
      .slice(0, MAX_VISIBLE);
  }, [guildCommands, guildId, query, showingChoices]);

  const visibleChoices = useMemo(
    () => (showingChoices ? (autocompleteChoices ?? []).slice(0, MAX_VISIBLE) : []),
    [showingChoices, autocompleteChoices],
  );

  const itemCount = showingChoices ? visibleChoices.length : filteredCommands.length;

  // Reset selected index when query or results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, itemCount, showingChoices]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!visible) return;

      // Always allow Escape to dismiss, including empty "no matches" / loading
      // states — otherwise the popup can trap the user when itemCount is 0.
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
        return;
      }

      if (itemCount === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % itemCount);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + itemCount) % itemCount);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (showingChoices) {
          const choice = visibleChoices[selectedIndex];
          if (choice) onSelectChoice?.(choice);
        } else {
          const cmd = filteredCommands[selectedIndex];
          if (cmd) onSelectCommand(cmd);
        }
      }
    },
    [
      visible,
      itemCount,
      showingChoices,
      visibleChoices,
      filteredCommands,
      selectedIndex,
      onSelectCommand,
      onSelectChoice,
      onDismiss,
    ],
  );

  useEffect(() => {
    if (visible) {
      window.addEventListener('keydown', handleKeyDown, true);
      return () => window.removeEventListener('keydown', handleKeyDown, true);
    }
  }, [visible, handleKeyDown]);

  if (!visible) return null;

  if (showingChoices) {
    if (autocompleteLoading && visibleChoices.length === 0) {
      return (
        <div className={`pc-enter ${POPOVER_CLASS} p-3`}>
          <LoadingSpinner size="sm" label="Loading suggestions…" />
        </div>
      );
    }
    if (visibleChoices.length === 0) {
      return (
        <div className={`pc-enter ${POPOVER_CLASS} px-3 py-2.5`}>
          <p className="text-meta text-text-secondary">No suggestions for this option.</p>
        </div>
      );
    }
    return (
      <div
        className={`pc-enter ${POPOVER_CLASS} max-h-80 overflow-y-auto p-1`}
      >
        <div ref={listRef} className="flex flex-col gap-0.5">
          {visibleChoices.map((choice, i) => {
            const selected = i === selectedIndex;
            return (
              <button
                key={`${choice.name}:${String(choice.value)}`}
                type="button"
                className={`flex w-full items-center gap-2.5 rounded-chip px-2 py-1.5 text-left transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] ${
                  selected
                    ? 'bg-accent-tint text-text-primary'
                    : 'text-text-secondary hover:bg-accent-tint hover:text-text-primary'
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelectChoice?.(choice);
                }}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-chip ${
                    selected ? 'bg-accent-tint-strong text-accent-primary' : 'bg-bg-mod-strong text-text-muted'
                  }`}
                >
                  <ListFilter size={14} strokeWidth={2} />
                </span>
                <div className="min-w-0 flex-1">
                  <span className="text-label text-text-primary">{choice.name}</span>
                  <span className="block truncate text-meta text-text-secondary">
                    {String(choice.value)}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (loading && !guildCommands.get(guildId)?.length) {
    return (
      <div className={`pc-enter ${POPOVER_CLASS} p-3`}>
        <LoadingSpinner size="sm" label="Loading commands…" />
      </div>
    );
  }

  if (filteredCommands.length === 0) {
    return (
      <div className={`pc-enter ${POPOVER_CLASS} px-3 py-2.5`}>
        <p className="text-meta text-text-secondary">
          No commands match{' '}
          <span className="font-semibold text-text-primary">/{query}</span> — check the spelling or
          browse this server&rsquo;s apps.
        </p>
      </div>
    );
  }

  return (
    <div
      className={`pc-enter ${POPOVER_CLASS} max-h-80 overflow-y-auto p-1`}
    >
      <div ref={listRef} className="flex flex-col gap-0.5">
        {filteredCommands.map((cmd, i) => {
          const selected = i === selectedIndex;
          return (
            <button
              key={cmd.id}
              type="button"
              className={`flex w-full items-center gap-2.5 rounded-chip px-2 py-1.5 text-left transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] ${
                selected
                  ? 'bg-accent-tint text-text-primary'
                  : 'text-text-secondary hover:bg-accent-tint hover:text-text-primary'
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelectCommand(cmd);
              }}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-chip ${
                  selected ? 'bg-accent-tint-strong text-accent-primary' : 'bg-bg-mod-strong text-text-muted'
                }`}
              >
                <CommandTypeIcon type={cmd.type} />
              </span>
              <div className="min-w-0 flex-1">
                <span className="text-label text-text-primary">/{cmd.name}</span>
                {cmd.description && (
                  <span className="block truncate text-meta text-text-secondary">{cmd.description}</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CommandTypeIcon({ type }: { type: ApplicationCommandType }) {
  switch (type) {
    case ApplicationCommandType.User:
      return <User size={14} strokeWidth={2} />;
    case ApplicationCommandType.Message:
      return <MessageSquare size={14} strokeWidth={2} />;
    case ApplicationCommandType.ChatInput:
    default:
      return <Slash size={14} strokeWidth={2} />;
  }
}
