import * as React from 'react';

import { cn } from '../../lib/utils';
import { callDuration } from '../../lib/attention/light';
import type { OnAir } from '../../hooks/useLights';

export interface OnAirPillProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  onAir: OnAir;
  /** Return to the Stage. */
  onReturn?: () => void;
}

/**
 * OnAirPill — you are in a room and looking at something else
 * (docs/lantern-stage-spec.md §7.7; it replaced the v1 mini voice bar).
 *
 * A small raised pill in the header: the white dot, the room name, the
 * duration in the mono face, and the mic state. Tapping it returns to the
 * Stage. It is not a control bar — there is exactly one action on it.
 */
export const OnAirPill = React.forwardRef<HTMLButtonElement, OnAirPillProps>(function OnAirPill(
  { onAir, onReturn, className, onClick, ...props },
  ref,
) {
  const mic = onAir.deafened ? 'deafened' : onAir.micOn ? 'mic on' : 'mic off';
  return (
    <button
      ref={ref}
      type="button"
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onReturn?.();
      }}
      className={cn(
        'pc-focusable inline-flex h-[var(--h-control)] min-w-0 shrink-0 items-center gap-2',
        'rounded-[var(--radius-control)] bg-bg-raised px-2.5 shadow-[var(--shadow-lifted)]',
        'text-label text-text-primary',
        'transition-[background-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
        'hover:bg-bg-mod-strong',
        className,
      )}
      {...props}
    >
      {/* §5.1 "speaking is a breath", §6.7 "no badge louder than the room":
          the dot breathes on pc-breathe ONLY while somebody has the floor, and
          sits at its resting glow the rest of the call. */}
      <span
        className={cn('pc-live-dot shrink-0', onAir.speaking && 'is-speaking')}
        aria-hidden
      />
      <span className="pc-display min-w-0 truncate font-semibold">{onAir.roomName}</span>
      <span className="pc-mono shrink-0 text-meta text-text-faint">
        {callDuration(onAir.durationMs)}
      </span>
      <span className="sr-only">
        {`You are in ${onAir.roomName}${onAir.buildingName ? ` in ${onAir.buildingName}` : ''} — ${mic}${
          onAir.sharing ? ', sharing your screen' : ''
        }. Return to the room.`}
      </span>
      <span
        className={cn(
          'shrink-0 text-meta',
          onAir.deafened || !onAir.micOn ? 'text-accent-danger' : 'text-light-white',
        )}
        aria-hidden
      >
        {mic}
      </span>
    </button>
  );
});
