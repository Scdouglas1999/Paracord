import { Blocks, Check, Copy, Gamepad2, Pickaxe, PlugZap, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import type { GameServerKind, GameServerState } from '../../api/gameServers';
import { writeClipboardText } from '../../lib/clipboard';
import { getIdentityColor } from '../../lib/colors';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toastStore';
import { IconButton } from '../ui';
import { playerInitials, stateLabel } from './gameServerModel';

const KIND_ICONS: Record<GameServerKind, LucideIcon> = {
  minecraft_java: Pickaxe,
  minecraft_bedrock: Blocks,
  source: Gamepad2,
  tcp: PlugZap,
};

/** A game server type's glyph in a small well, the way a feed's source sits. */
export function GameKindIcon({ kind, size = 32, className }: { kind: string; size?: number; className?: string }) {
  const Icon = KIND_ICONS[kind as GameServerKind] ?? Gamepad2;
  return (
    <span
      aria-hidden
      className={cn(
        'pc-feed-icon pc-feed-icon-glyph flex shrink-0 items-center justify-center rounded-[var(--radius-thumb)]',
        className,
      )}
      style={{ width: size, height: size }}
    >
      <Icon size={Math.round(size * 0.5)} />
    </span>
  );
}

const DOT_TONE: Record<GameServerState, string> = {
  up: 'bg-accent-success',
  down: 'bg-accent-danger',
  checking: 'bg-text-faint',
};

/** Up, down or not checked yet. Always paired with words somewhere near it. */
export function StatusDot({ state, className }: { state: GameServerState; className?: string }) {
  return (
    <span
      role="img"
      aria-label={stateLabel(state)}
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', DOT_TONE[state] ?? DOT_TONE.checking, className)}
    />
  );
}

/** Who is on, as overlapping initials. Names are in the tooltip and for screen readers. */
export function PlayerPile({
  names,
  total,
  max = 6,
  size = 24,
}: {
  names: readonly string[];
  /** Everyone online, when more are on than the game named. */
  total?: number | null;
  max?: number;
  size?: number;
}) {
  if (names.length === 0) return null;
  const shown = names.slice(0, max);
  const more = Math.max(names.length, total ?? 0) - shown.length;
  return (
    <span className="flex min-w-0 items-center" role="list" aria-label={`On now: ${names.join(', ')}`}>
      {shown.map((name, index) => (
        <span
          key={`${name}-${index}`}
          role="listitem"
          title={name}
          className={cn(
            'pc-display flex shrink-0 items-center justify-center rounded-full font-bold text-text-on-light',
            'shadow-[0_0_0_2px_var(--bg-plate)]',
            index > 0 && '-ml-0.5',
          )}
          style={{
            width: size,
            height: size,
            fontSize: Math.max(9, Math.round(size * 0.38)),
            background: getIdentityColor(name),
          }}
        >
          <span aria-hidden>{playerInitials(name)}</span>
          <span className="sr-only">{name}</span>
        </span>
      ))}
      {more > 0 && (
        <span className="ml-1.5 text-meta tabular-nums text-text-muted" aria-label={`and ${more} more`}>
          +{more}
        </span>
      )}
    </span>
  );
}

/** Copies a game server's address. */
export function CopyAddressButton({ address, name }: { address: string; name: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await writeClipboardText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy the address.");
    }
  };
  return (
    <IconButton size="sm" label={copied ? 'Copied' : `Copy the address of ${name}`} onClick={() => void copy()}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </IconButton>
  );
}
