import { format, isSameDay } from 'date-fns';

import { Button } from '../ui';
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
 * A quiet event row: date, name, context and one RSVP action. Real schedules
 * remain available without giving Home the weight of an agenda.
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
  return (
    <li className="flex min-w-0 flex-col items-start gap-1 py-2">
      <time dateTime={new Date(event.startsAtMs).toISOString()} className="text-meta text-text-muted">
        {eventWhen(event.startsAtMs, nowMs)}
      </time>
      <span className="flex min-w-0 max-w-full flex-col gap-1">
        <span className="pc-display break-words text-name font-semibold text-text-primary">
          {event.name}
        </span>
        <span className="break-words text-meta text-text-faint">
          {[event.buildingName, event.roomName ?? event.location, event.going > 0 ? `${event.going} going` : null].filter(Boolean).join(' · ')}
        </span>
      </span>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onSetGoing(event, !event.rsvp)}
        aria-pressed={event.rsvp}
        aria-label={
          event.rsvp
            ? `You are going to ${event.name} — tap to change your mind`
            : `Say you are going to ${event.name}`
        }
        className="-ml-2.5 mt-1 text-text-link"
      >
        {event.rsvp ? "You're going" : "I'm going"}
      </Button>
    </li>
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
    <section aria-label="Coming up" className="flex min-w-0 flex-col gap-2">
      <h2 className="pc-display text-heading font-semibold text-text-primary">Coming up</h2>
      <ul className="flex min-w-0 flex-col gap-3">
        {events.map((event) => (
          <EventCard key={event.key} event={event} nowMs={nowMs} onSetGoing={onSetGoing} />
        ))}
      </ul>
    </section>
  );
}
