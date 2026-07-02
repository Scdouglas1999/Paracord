import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useCommandStore } from '../../stores/commandStore';
import type { ApplicationCommand } from '../../types/commands';
import { ApplicationCommandType } from '../../types/commands';
import { LoadingSpinner } from '../ui/Feedback';

export interface SlashCommandPopupProps {
  query: string;
  guildId: string;
  onSelectCommand: (command: ApplicationCommand) => void;
  onDismiss: () => void;
  visible: boolean;
}

const MAX_VISIBLE = 10;

export function SlashCommandPopup({
  query,
  guildId,
  onSelectCommand,
  onDismiss,
  visible,
}: SlashCommandPopupProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const guildCommands = useCommandStore((s) => s.guildCommands);
  const loading = useCommandStore((s) => s.loading);
  const fetchGuildCommands = useCommandStore((s) => s.fetchGuildCommands);

  // Fetch commands when popup becomes visible and not already cached
  useEffect(() => {
    if (visible && !guildCommands.has(guildId)) {
      void fetchGuildCommands(guildId);
    }
  }, [visible, guildId, guildCommands, fetchGuildCommands]);

  const commands = guildCommands.get(guildId) ?? [];

  const filteredCommands = useMemo(() => {
    const q = query.toLowerCase();
    return commands
      .filter((cmd) => cmd.name.toLowerCase().startsWith(q))
      .slice(0, MAX_VISIBLE);
  }, [commands, query]);

  // Reset selected index when query or results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, filteredCommands.length]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!visible || filteredCommands.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filteredCommands.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const cmd = filteredCommands[selectedIndex];
        if (cmd) onSelectCommand(cmd);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
      }
    },
    [visible, filteredCommands, selectedIndex, onSelectCommand, onDismiss],
  );

  useEffect(() => {
    if (visible) {
      window.addEventListener('keydown', handleKeyDown, true);
      return () => window.removeEventListener('keydown', handleKeyDown, true);
    }
  }, [visible, handleKeyDown]);

  if (!visible) return null;

  if (loading && commands.length === 0) {
    return (
      <div className="absolute bottom-full left-3 right-3 z-30 mb-2 rounded-xl border border-border-subtle bg-bg-floating p-3 shadow-lg backdrop-blur-lg">
        <LoadingSpinner size="sm" label="Loading commands..." />
      </div>
    );
  }

  if (filteredCommands.length === 0) {
    return (
      <div className="absolute bottom-full left-3 right-3 z-30 mb-2 rounded-xl border border-border-subtle bg-bg-floating p-3 shadow-lg backdrop-blur-lg">
        <div className="text-sm text-text-muted">No matching commands</div>
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-3 right-3 z-30 mb-2 max-h-80 overflow-y-auto rounded-xl border border-border-subtle bg-bg-floating shadow-lg backdrop-blur-lg"
    >
      {filteredCommands.map((cmd, i) => (
        <button
          key={cmd.id}
          type="button"
          className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
            i === selectedIndex
              ? 'bg-accent-primary/15 text-text-primary'
              : 'text-text-secondary hover:bg-bg-mod-subtle'
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelectCommand(cmd);
          }}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          <span
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-xs font-bold"
            style={{ backgroundColor: 'var(--bg-mod-strong)', color: 'var(--text-muted)' }}
          >
            {commandTypeIndicator(cmd.type)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                /{cmd.name}
              </span>
            </div>
            {cmd.description && (
              <div className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>
                {cmd.description}
              </div>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}

function commandTypeIndicator(type: ApplicationCommandType): string {
  switch (type) {
    case ApplicationCommandType.ChatInput:
      return '/';
    case ApplicationCommandType.User:
      return '\u{1F464}';
    case ApplicationCommandType.Message:
      return '\u{1F4AC}';
    default:
      return '/';
  }
}
