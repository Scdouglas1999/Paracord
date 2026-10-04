import type { CSSProperties } from 'react';

import { cn } from '../../../lib/utils';
import type { PresenceStatus } from '../../../lib/presence';

/**
 * Presence as a dot (docs/index-spec.md §2.3). A 10px dot at an avatar's
 * bottom-right with a 2.5px ring in the surface color behind it:
 *
 *   online  solid ink
 *   idle    the tertiary ink
 *   dnd     a hollow ring (`--ix-ink-2`, 1.5px stroke)
 *   offline nothing is drawn
 *
 * No red, green or yellow: one danger color exists and presence is not danger.
 * The dot is decorative; the person's name (or the control that wraps it) must
 * carry the state in words, as `presenceLabel` gives it.
 */
export type PresenceKind = 'online' | 'idle' | 'dnd';

/**
 * Which dot a status draws, or null for none. `streaming` (live in a voice
 * channel) is online; `offline`, `invisible` and anything unknown draw nothing.
 */
export function presenceKind(status: PresenceStatus | null | undefined): PresenceKind | null {
  switch (status) {
    case 'online':
    case 'streaming':
      return 'online';
    case 'idle':
      return 'idle';
    case 'dnd':
      return 'dnd';
    default:
      return null;
  }
}

export interface PresenceDotProps {
  status: PresenceStatus | null | undefined;
  /**
   * The surface behind the dot, as a CSS value (`var(--ix-main)`): the 2.5px ring
   * is this color. Defaults to whatever `--ix-ring` an ancestor set, else the
   * sidebar's foot.
   */
  ring?: string;
  /** Diameter in px. Default 10 (8 on a face under 30px: `Avatar` passes it). */
  size?: number;
  /** In flow (a row's trailing state) instead of on a face's corner. */
  inline?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function PresenceDot({ status, ring, size, inline = false, className, style }: PresenceDotProps) {
  const kind = presenceKind(status);
  if (!kind) return null;
  const custom: Record<string, string | number> = {};
  if (ring) custom['--ix-ring'] = ring;
  if (size) custom['--ix-dot'] = `${size}px`;
  return (
    <span
      aria-hidden="true"
      data-presence={kind}
      className={cn('ix-presence', `ix-presence--${kind}`, inline && 'ix-presence--inline', className)}
      style={{ ...custom, ...style } as CSSProperties}
    />
  );
}
