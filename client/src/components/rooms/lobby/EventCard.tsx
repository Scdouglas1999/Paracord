import * as React from 'react';

import { Button, Well } from '../../ui';
import { cn } from '../../../lib/utils';
import { goingCaption, headerLine, hostingCaption } from './lobbyCaptions';
import { eventDayTile, eventWhen } from './lobbyTime';
import type { LobbyEvent } from './useNextEvent';

export interface EventCardProps {
  event: LobbyEvent;
  /** Where it happens — the room's name, or the event's own free-text place. */
  where?: string | null;
  /** Who is hosting, when this client can name them. Omitted otherwise. */
  host?: string | null;
  onRsvp: () => void;
  nowMs?: number;
}

/**
 * EventCard — the next thing on the calendar
 * (docs/lantern-stage-spec.md §7.3, §8: "well; day tile (mono weekday +
 * Gabarito date), title, meta, one action").
 *
 * One action, and it is the only one: RSVP. Managing events stays where it has
 * always been (space settings → Events); the Lobby only shows a human what is
 * coming and lets them say they will be there.
 *
 * The card is never rendered empty — `Lobby` omits the whole section when there
 * is nothing coming up, rather than drawing a placeholder (§7.3, §6.9).
 */
export const EventCard = React.forwardRef<HTMLElement, EventCardProps>(function EventCard(
  { event, where, host, onRsvp, nowMs = Date.now() },
  ref,
) {
  const tile = eventDayTile(event.startsAt);
  const meta = headerLine([
    eventWhen(event.startsAt, nowMs),
    where?.trim() || null,
    hostingCaption(host),
    goingCaption(event.going),
  ]);

  return (
    <Well
      ref={ref}
      as="section"
      aria-label="Coming up"
      bare
      className="flex items-center gap-3.5 rounded-[var(--radius-card)] px-3.5 py-3"
    >
      <span
        aria-hidden
        className={cn(
          'flex w-11 shrink-0 flex-col items-center rounded-[var(--radius-control)] py-1.5',
          'bg-bg-raised shadow-[var(--shadow-raised)]',
        )}
      >
        <span className="pc-mono text-[10.5px] leading-none text-text-faint">{tile.weekday}</span>
        <span className="pc-display mt-1 text-heading leading-none text-text-primary">
          {tile.day}
        </span>
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="pc-display truncate text-name text-text-primary">{event.name}</span>
        <span className="truncate text-meta text-text-faint">{meta}</span>
      </span>

      <Button
        variant="ghost"
        size="sm"
        onClick={onRsvp}
        aria-pressed={event.youAreGoing}
        className={cn(
          'shrink-0',
          event.youAreGoing
            ? 'bg-bg-mod-strong text-text-primary'
            : 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
        )}
      >
        {event.youAreGoing ? "You're going" : "I'm going"}
      </Button>
    </Well>
  );
});
