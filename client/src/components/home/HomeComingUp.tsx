import { format, isSameDay } from 'date-fns';

import { Button, SectionLabel, Well } from '../ui';
import { cn } from '../../lib/utils';
import type { ComingUpEvent } from './useComingUp';

export interface HomeComingUpProps {
  events: readonly ComingUpEvent[];
  nowMs: number;
  onSetGoing: (event: ComingUpEvent, going: boolean) => void;
}

/** "Today 1:00 pm", "Tomorrow 9:30 am", "Sat 13 Sep 1:00 pm". */
export function eventWhen(startsAtMs: number, nowMs: number): string {
  const start = new Date(startsAtMs);
  const now = new Date(nowMs);
  const tomorrow = new Date(nowMs + 24 * 60 * 60 * 1000);
  const clock = format(start, 'h:mm a').toLowerCase();
  if (isSameDay(start, now)) return `Today ${clock}`;
  if (isSameDay(start, tomorrow)) return `Tomorrow ${clock}`;
  return `${format(start, 'EEE d MMM')} ${clock}`;
}

/** "Today 1:00 pm · Kestrel Robotics · Shop floor · 6 going". */
export function eventMeta(event: ComingUpEvent, nowMs: number): string {
  const parts = [eventWhen(event.startsAtMs, nowMs), event.buildingName];
  const where = event.roomName ?? event.location;
  if (where) parts.push(where);
  if (event.going > 0) parts.push(`${event.going} going`);
  return parts.join(' · ');
}

/**
 * EventCard — one scheduled event (docs/lantern-stage-spec.md §8).
 *
 * A well with a day tile, the title, one meta line and **one** action. The day
 * tile pairs the mono weekday against the Gabarito date exactly as §2 sets the
 * two faces against each other; nothing here glows, because an event is not a
 * person (§0).
 */
function EventCard({
  event,
  nowMs,
  onSetGoing,
}: {
  event: ComingUpEvent;
  nowMs: number;
  onSetGoing: (event: ComingUpEvent, going: boolean) => void;
}) {
  const start = new Date(event.startsAtMs);
  return (
    <Well
      bare
      as="li"
      className="flex items-center gap-3.5 rounded-[var(--radius-card)] px-3.5 py-3"
    >
      <span
        aria-hidden
        className={cn(
          'flex w-11 shrink-0 flex-col items-center rounded-[var(--radius-control)] py-1.5',
          'bg-bg-raised shadow-[var(--shadow-raised)]',
        )}
      >
        {/* §6.8 bans uppercase; the mono face and the size already make this
            read as a label, so "Sat" is enough. */}
        <span className="pc-mono text-[10.5px] text-text-faint">{format(start, 'EEE')}</span>
        <span className="pc-display text-heading font-bold leading-none text-text-primary">
          {format(start, 'd')}
        </span>
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="pc-display truncate text-name font-semibold text-text-primary">
          {event.name}
        </span>
        <span className="truncate text-meta text-text-faint">{eventMeta(event, nowMs)}</span>
      </span>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onSetGoing(event, !event.rsvp)}
        aria-label={
          event.rsvp
            ? `You are going to ${event.name} — tap to change your mind`
            : `Say you are going to ${event.name}`
        }
        className={cn(
          'ml-auto shrink-0',
          !event.rsvp && 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
        )}
      >
        {event.rsvp ? "You're going" : "I'm going"}
      </Button>
    </Well>
  );
}

/**
 * Coming up — scheduled events across every building (§7.5).
 *
 * **Omitted entirely when there is nothing scheduled.** An empty "Coming up"
 * heading over a blank space is the "No data" of section headers.
 */
export function HomeComingUp({ events, nowMs, onSetGoing }: HomeComingUpProps) {
  if (events.length === 0) return null;
  return (
    <section aria-label="Coming up" className="flex flex-col gap-2">
      <SectionLabel className="px-0 pb-1 pt-2">Coming up</SectionLabel>
      <ul className="flex flex-col gap-2">
        {events.map((event) => (
          <EventCard key={event.key} event={event} nowMs={nowMs} onSetGoing={onSetGoing} />
        ))}
      </ul>
    </section>
  );
}
