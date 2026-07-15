import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
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

// Popover recipe (design-spec §7): --bg-floating, radius-md, 1px --border-subtle,
// --shadow-lg, 180ms rise+fade enter.
const POPOVER_CLASS =
  'absolute bottom-full left-2 right-2 z-30 mb-2 rounded-md border border-border-subtle bg-bg-floating shadow-lg';

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
  const reduceMotion = useReducedMotion();
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

  const commands = guildCommands.get(guildId) ?? [];

  const filteredCommands = useMemo(() => {
    if (showingChoices) return [];
    const q = query.toLowerCase();
    return commands
      .filter((cmd) => cmd.name.toLowerCase().startsWith(q))
      .slice(0, MAX_VISIBLE);
  }, [commands, query, showingChoices]);

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

  const enter = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 } }
    : { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 } };
  const transition = { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const };

  if (showingChoices) {
    if (autocompleteLoading && visibleChoices.length === 0) {
      return (
        <motion.div {...enter} transition={transition} className={`${POPOVER_CLASS} p-3`}>
          <LoadingSpinner size="sm" label="Loading suggestions…" />
        </motion.div>
      );
    }
    if (visibleChoices.length === 0) {
      return (
        <motion.div {...enter} transition={transition} className={`${POPOVER_CLASS} px-3 py-2.5`}>
          <p className="text-meta text-text-secondary">No suggestions for this option.</p>
        </motion.div>
      );
    }
    return (
      <motion.div
        {...enter}
        transition={transition}
        className={`${POPOVER_CLASS} max-h-80 overflow-y-auto p-1`}
      >
        <div ref={listRef} className="flex flex-col gap-0.5">
          {visibleChoices.map((choice, i) => {
            const selected = i === selectedIndex;
            return (
              <button
                key={`${choice.name}:${String(choice.value)}`}
                type="button"
                className={`flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] ${
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
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-sm ${
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
      </motion.div>
    );
  }

  if (loading && commands.length === 0) {
    return (
      <motion.div {...enter} transition={transition} className={`${POPOVER_CLASS} p-3`}>
        <LoadingSpinner size="sm" label="Loading commands…" />
      </motion.div>
    );
  }

  if (filteredCommands.length === 0) {
    return (
      <motion.div {...enter} transition={transition} className={`${POPOVER_CLASS} px-3 py-2.5`}>
        <p className="text-meta text-text-secondary">
          No commands match{' '}
          <span className="font-semibold text-text-primary">/{query}</span> — check the spelling or
          browse this space&rsquo;s apps.
        </p>
      </motion.div>
    );
  }

  return (
    <motion.div
      {...enter}
      transition={transition}
      className={`${POPOVER_CLASS} max-h-80 overflow-y-auto p-1`}
    >
      <div ref={listRef} className="flex flex-col gap-0.5">
        {filteredCommands.map((cmd, i) => {
          const selected = i === selectedIndex;
          return (
            <button
              key={cmd.id}
              type="button"
              className={`flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] ${
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
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-sm ${
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
    </motion.div>
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
