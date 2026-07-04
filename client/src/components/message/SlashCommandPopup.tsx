import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Slash, User, MessageSquare } from 'lucide-react';
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
}: SlashCommandPopupProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
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

  const enter = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 } }
    : { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 } };
  const transition = { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const };

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
          browse this server&rsquo;s apps.
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
