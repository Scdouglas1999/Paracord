import type { HomeEvent } from '../../rooms/lobby/useUpcomingEvents';
import { Kicker } from '../primitives/Kicker';
import { EventRow, type RowFocus } from './PlaceRows';
import { eventLine, eventTile } from './model';

/**
 * "Coming up" (docs/glass-spec.md §3.1): the kicker 32px under the last row, then
 * a row per event, from the server's scheduled events. The date tile is in the
 * instrument cut ("TODAY / 9:30", "FRI / 2"); the line says where and who.
 */

/** How many events the panel shows; the server's own events page has the rest. */
export const COMING_UP_ROWS = 3;

export const eventIdOf = (event: Pick<HomeEvent, 'id'>) => `event:${event.id}`;

export interface ComingUpProps {
  events: readonly HomeEvent[];
  nowMs: number;
  selfUserId: string | null;
  roomName: (event: HomeEvent) => string | null;
  hrefOf: (event: HomeEvent) => string | undefined;
  focusOf: (id: string) => RowFocus;
  onOpen: (event: HomeEvent) => void;
}

export function ComingUp({ events, nowMs, selfUserId, roomName, hrefOf, focusOf, onOpen }: ComingUpProps) {
  const shown = events.slice(0, COMING_UP_ROWS);
  if (shown.length === 0) return null;
  return (
    <section className="glass-places__coming" aria-labelledby="glass-coming-up">
      <Kicker as="h2" id="glass-coming-up" className="glass-places__kicker">
        Coming up
      </Kicker>
      <div className="glass-places__rows">
        {shown.map((event) => (
          <EventRow
            key={event.id}
            id={eventIdOf(event)}
            title={event.name}
            tile={eventTile(event, nowMs)}
            line={eventLine(event, { nowMs, selfUserId, roomName: roomName(event) })}
            href={hrefOf(event)}
            onOpen={() => onOpen(event)}
            {...focusOf(eventIdOf(event))}
          />
        ))}
      </div>
    </section>
  );
}
