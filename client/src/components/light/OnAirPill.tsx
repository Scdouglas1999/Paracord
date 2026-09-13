import * as React from 'react';

import { cn } from '../../lib/utils';
import { callDuration } from '../../lib/attention/light';
import { roomSharedName } from '../../lib/motion';
import type { OnAir } from '../../hooks/useLights';

export interface OnAirPillProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  onAir: OnAir;
  /** Return to the Stage. The pill hands itself over as the shared element. */
  onReturn?: (origin?: Element | null) => void;
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
  // Who else is actually on this call. A 1:1 DM used to say nothing at all, so
  // the caller could not tell whether the other person had picked up.
  const shown = onAir.others.slice(0, 3);
  const company = onAir.others.length === 0
    ? (onAir.isDirectMessage ? 'nobody has joined yet' : 'you are the only one here')
    : onAir.others.length === 1
    ? `with ${onAir.others[0].name}`
    : `with ${onAir.others.length} others`;
  return (
    <button
      ref={ref}
      type="button"
      // Leaving the Stage folds the dominant tile into this pill, and tapping
      // it unfolds it again — the same shared element, both ways (§5.1).
      data-motion-shared={onAir.room ? roomSharedName(onAir.room.channelId) : undefined}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onReturn?.(event.currentTarget);
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
      {/* The company you are keeping: initials for up to three, a count past
          that, and an explicit "nobody yet" rather than an empty space. */}
      {shown.length > 0 ? (
        <span className="flex shrink-0 items-center -space-x-1.5" aria-hidden>
          {shown.map((person) => (
            <span
              key={person.userId}
              title={person.name}
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-full bg-bg-mod-strong text-[10px] font-semibold text-text-secondary ring-2 ring-bg-raised',
                person.speaking && 'text-light-white',
              )}
            >
              {person.name.charAt(0).toUpperCase()}
            </span>
          ))}
          {onAir.others.length > shown.length && (
            <span className="pl-2.5 text-meta text-text-faint">{`+${onAir.others.length - shown.length}`}</span>
          )}
        </span>
      ) : (
        <span className="shrink-0 truncate text-meta text-text-faint" aria-hidden>
          {onAir.isDirectMessage ? 'ringing' : 'alone'}
        </span>
      )}
      <span className="pc-mono shrink-0 text-meta text-text-faint">
        {callDuration(onAir.durationMs)}
      </span>
      <span className="sr-only">
        {`You are ${onAir.isDirectMessage ? 'in a call with' : 'in'} ${onAir.roomName}${
          onAir.buildingName ? ` in ${onAir.buildingName}` : ''
        } — ${company}, ${mic}${onAir.sharing ? ', sharing your screen' : ''}. Return to the call.`}
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
