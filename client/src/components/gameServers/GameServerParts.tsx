import { Blocks, Copy, Gamepad2, Pickaxe, PlugZap, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import type { GameServerKind, GameServerState } from '../../api/gameServers';
import { writeClipboardText } from '../../lib/clipboard';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toastStore';
import { AvatarStack } from '../ix/identity';
import { IxGlyph } from '../ix/glyphs';
import { Control } from '../ix/primitives';
import { stateLabel } from './gameServerModel';

const KIND_ICONS: Record<GameServerKind, LucideIcon> = {
  minecraft_java: Pickaxe,
  minecraft_bedrock: Blocks,
  source: Gamepad2,
  tcp: PlugZap,
};

/**
 * A game server type's glyph in a tile (docs/index-spec.md §3.1 "glyph tile": the
 * place's hue, radius 30% of the side), the way an action card's glyph sits.
 */
export function GameKindIcon({ kind, size = 32, className }: { kind: string; size?: number; className?: string }) {
  const Icon = KIND_ICONS[kind as GameServerKind] ?? Gamepad2;
  return (
    <span
      aria-hidden
      className={cn('ix-hue-tile ix-gamekind', className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }}
    >
      <Icon size={Math.round(size * 0.5)} strokeWidth={1.7} />
    </span>
  );
}

/**
 * Up, down or not checked yet. Always paired with words somewhere near it: up is
 * amber (it is live), down the one danger ink, and a server not checked yet a hollow
 * ring.
 */
export function StatusDot({ state, className }: { state: GameServerState; className?: string }) {
  return (
    <span
      role="img"
      aria-label={stateLabel(state)}
      className={cn('ix-dot', className)}
      data-state={state in { up: 1, down: 1, checking: 1 } ? state : 'checking'}
    />
  );
}

/**
 * Who is on, as overlapping faces. A player is not a user: the name is the identity,
 * and its hue the same one every time. The names are the group's accessible name.
 */
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
    <span className="ix-pile" role="img" aria-label={`On now: ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`}>
      <AvatarStack
        people={shown.map((name) => ({ userId: `player:${name}`, name }))}
        size={size}
        overlap={7}
        ring="var(--ix-main)"
      />
      {more > 0 && (
        <span className="ix-pile__more" aria-hidden>
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
    <Control
      className="ix-ctl--small"
      label={copied ? 'Copied' : `Copy the address of ${name}`}
      onClick={() => void copy()}
    >
      {copied ? <IxGlyph name="check" size={14} /> : <Copy size={14} strokeWidth={1.7} />}
    </Control>
  );
}
