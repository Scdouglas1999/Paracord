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
const LIST_ID = 'ix-slash-commands';

// The completion popover of the message box (docs/index-spec.md §4.12): near-
// solid, radius 16, above the box, at most six rows before it scrolls; the same
// surface as @ / # / : completion (`.ix-complete` in ix-composer.css). Every
// state below renders the same root, so moving between loading, empty and a
// list keeps the element and never replays its entrance. It closes the instant
// the query stops being a command: an autocomplete follows keystrokes, and a
// leave would trail behind the typing.
const POPOVER_CLASS = 'ix-complete';

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
        <div className={POPOVER_CLASS}>
          <div className="ix-complete__status">
            <LoadingSpinner size="sm" label="Loading suggestions…" />
          </div>
        </div>
      );
    }
    if (visibleChoices.length === 0) {
      return (
        <div className={POPOVER_CLASS}>
          <p className="ix-complete__status">No suggestions for this option.</p>
        </div>
      );
    }
    return (
      <div className={POPOVER_CLASS} role="listbox" id={LIST_ID} aria-label="Suggestions">
        <div ref={listRef} className="ix-complete__list">
          {visibleChoices.map((choice, i) => {
            const selected = i === selectedIndex;
            return (
              <div
                key={`${choice.name}:${String(choice.value)}`}
                role="option"
                tabIndex={-1}
                aria-selected={selected}
                className="ix-complete__row ix-complete__row--two"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelectChoice?.(choice);
                }}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <span className="ix-complete__mark" aria-hidden>
                  <ListFilter size={15} strokeWidth={1.7} />
                </span>
                <span className="ix-complete__stack">
                  <span className="ix-complete__name">{choice.name}</span>
                  <span className="ix-complete__meta">{String(choice.value)}</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (loading && !guildCommands.get(guildId)?.length) {
    return (
      <div className={POPOVER_CLASS}>
        <div className="ix-complete__status">
          <LoadingSpinner size="sm" label="Loading commands…" />
        </div>
      </div>
    );
  }

  if (filteredCommands.length === 0) {
    return (
      <div className={POPOVER_CLASS}>
        <p className="ix-complete__status">
          No commands match <span className="ix-complete__strong">/{query}</span>. Check the spelling, or
          look through this server&rsquo;s apps.
        </p>
      </div>
    );
  }

  return (
    <div className={POPOVER_CLASS} role="listbox" id={LIST_ID} aria-label="Commands">
      <div ref={listRef} className="ix-complete__list">
        {filteredCommands.map((cmd, i) => {
          const selected = i === selectedIndex;
          return (
            <div
              key={cmd.id}
              role="option"
              tabIndex={-1}
              aria-selected={selected}
              className={`ix-complete__row${cmd.description ? ' ix-complete__row--two' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelectCommand(cmd);
              }}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span className="ix-complete__mark" aria-hidden>
                <CommandTypeIcon type={cmd.type} />
              </span>
              <span className="ix-complete__stack">
                <span className="ix-complete__name">/{cmd.name}</span>
                {cmd.description && <span className="ix-complete__meta">{cmd.description}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CommandTypeIcon({ type }: { type: ApplicationCommandType }) {
  switch (type) {
    case ApplicationCommandType.User:
      return <User size={15} strokeWidth={1.7} />;
    case ApplicationCommandType.Message:
      return <MessageSquare size={15} strokeWidth={1.7} />;
    case ApplicationCommandType.ChatInput:
    default:
      return <Slash size={15} strokeWidth={1.7} />;
  }
}
