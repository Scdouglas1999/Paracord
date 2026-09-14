import * as React from 'react';

import { Plate } from '../../ui';
// §5.1/§7.2: the phone sheet changes size when it opens, and a size change is
// the one thing §5.3 will not let a keyframe touch. The engine measures the
// two layouts and plays the difference back as a transform.
import { motionToken, ms, useFlip } from '../../../lib/motion';
import { cn, mergeRefs } from '../../../lib/utils';

export interface RoomChatRibbonProps extends Omit<React.HTMLAttributes<HTMLElement>, 'children'> {
  /** The text channel this room talks in — "build-log". */
  roomName: string;
  /** Somebody is reading it right now: the window dot goes amber. */
  lit?: boolean;
  /** The words beside the name. "room chat" on the Stage. */
  caption?: string;
  /** Header affordances — close, threads, pins. */
  actions?: React.ReactNode;
  /** The message list. */
  children?: React.ReactNode;
  /** The composer. */
  composer?: React.ReactNode;
  /** `ribbon` is the 336px plate beside the Stage; `sheet` is the phone sheet. */
  surface?: 'ribbon' | 'sheet';
  /** Sheet only: is it open? A collapsed sheet is its handle and its name. */
  expanded?: boolean;
  /** Sheet only: the handle's action. */
  onToggle?: () => void;
}

/**
 * RoomChatRibbon — the room's text channel beside the Stage
 * (docs/lantern-stage-spec.md §7.2, §8).
 *
 * A 336px plate: the amber window dot, the channel name, the compact timeline,
 * and a composer that says "Say something" — the room it means is the name in
 * the heading above it. On a phone it is the sheet under the controls, with a
 * drag handle.
 *
 * It holds no messages of its own — the timeline and the composer are the same
 * components a text room uses, handed in as children.
 */
export const RoomChatRibbon = React.forwardRef<HTMLElement, RoomChatRibbonProps>(
  function RoomChatRibbon(
    {
      roomName,
      lit = false,
      caption = 'room chat',
      actions,
      children,
      composer,
      surface = 'ribbon',
      expanded = true,
      onToggle,
      className,
      ...props
    },
    ref,
  ) {
    // Opening travels on the spring over --duration-move; closing is the dim
    // curve at the fade speed, because a sheet going away is not an arrival.
    const sheetRef = useFlip<HTMLElement>(
      [expanded, surface],
      expanded
        ? { scale: false }
        : { scale: false, duration: ms('--duration-fast'), easing: motionToken('--ease-in') },
    );
    const heading = (
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn('pc-window h-2 w-2 shrink-0', lit && 'is-reading')}
          aria-hidden
        />
        <span className="pc-display truncate font-semibold text-text-primary">{roomName}</span>
        <span className="shrink-0 text-meta text-text-faint">{caption}</span>
        {actions && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
    );

    if (surface === 'sheet') {
      return (
        <Plate
          as="aside"
          bare
          ref={mergeRefs(ref, sheetRef)}
          aria-label={`${roomName} — room chat`}
          className={cn(
            'flex min-h-0 flex-col overflow-hidden rounded-b-none',
            expanded ? 'flex-1' : 'shrink-0',
            className,
          )}
          {...props}
        >
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="pc-focusable flex shrink-0 items-center justify-center rounded-[var(--radius-control)] px-4 pb-2.5 pt-3"
          >
            <span className="h-1 w-9 rounded-full bg-bg-mod-strong" aria-hidden />
            <span className="sr-only">
              {expanded ? `Hide the ${roomName} chat` : `Show the ${roomName} chat`}
            </span>
          </button>
          <div className="shrink-0 px-4 pb-2">{heading}</div>
          {expanded && (
            /* The sheet's body arrives the way every other sheet in the
               product does — the plate's own travel is the FLIP above. */
            <div className="pc-sheet-in flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden">
                {children}
              </div>
              {composer && <div className="shrink-0 px-3 pb-3">{composer}</div>}
            </div>
          )}
        </Plate>
      );
    }

    return (
      <Plate
        as="aside"
        bare
        ref={ref}
        aria-label={`${roomName} — room chat`}
        className={cn(
          'flex w-[var(--w-chat-ribbon)] shrink-0 flex-col overflow-hidden',
          className,
        )}
        {...props}
      >
        <div className="shrink-0 border-b border-border-subtle px-3.5 py-3">{heading}</div>
        <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden pb-1.5">
          {children}
        </div>
        {composer && <div className="shrink-0 px-2.5 pb-2.5 pt-2">{composer}</div>}
      </Plate>
    );
  },
);
