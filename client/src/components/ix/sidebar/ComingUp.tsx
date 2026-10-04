import type { HomeEvent } from '../../rooms/lobby/useUpcomingEvents';
import { comingUpLine, dateTile } from '../../glass/places/model';
import { SidebarLabel } from './SidebarLabel';
import { FLIP_ATTRIBUTE } from './useCollapse';
import type { RowFocus } from './useRovingList';

/** How many events the sidebar shows; the server's Events page has the rest. */
export const COMING_UP_ROWS = 3;
/** Events further out than this are not "coming up" (docs/index-spec.md §4.7). */
export const COMING_UP_DAYS = 7;

export const eventIdOf = (event: Pick<HomeEvent, 'id'>) => `event:${event.id}`;

/** The events that belong here: running now, or starting within seven days; soonest first, at most three. */
export function comingUp(events: readonly HomeEvent[], nowMs: number): HomeEvent[] {
  const horizon = nowMs + COMING_UP_DAYS * 24 * 60 * 60 * 1000;
  return events
    .filter((event) => event.happeningNow || event.startsAt.getTime() <= horizon)
    .sort((a, b) => Number(b.happeningNow) - Number(a.happeningNow) || a.startsAt.getTime() - b.startsAt.getTime())
    .slice(0, COMING_UP_ROWS);
}

export interface ComingUpProps {
  events: readonly HomeEvent[];
  nowMs: number;
  roomName: (event: HomeEvent) => string | null;
  hrefOf: (event: HomeEvent) => string;
  focusOf: (id: string) => RowFocus;
  onOpen: (event: HomeEvent) => void;
}

/**
 * Coming up (docs/index-spec.md §4.7): shown only when the server has events in
 * the next seven days, under Voice channels, at most three rows. A 32x36 date tile (the
 * weekday in the server's hue, the day), the title, "Fri 9:00 PM · Lounge", and
 * "Live" in amber for an event in progress. Click opens it.
 */
export function ComingUp({ events, nowMs, roomName, hrefOf, focusOf, onOpen }: ComingUpProps) {
  const shown = comingUp(events, nowMs);
  if (shown.length === 0) return null;
  return (
    <section aria-labelledby="ix-sb-coming-up">
      <SidebarLabel id="ix-sb-coming-up">Coming up</SidebarLabel>
      <ul className="ix-sb__list">
        {shown.map((event) => {
          const tile = dateTile(event.startsAt);
          return (
            <li key={event.id}>
              <a
                href={hrefOf(event)}
                className="ix-ev"
                data-testid="ix-event-row"
                data-place-row=""
                data-row-id={eventIdOf(event)}
                {...{ [FLIP_ATTRIBUTE]: '' }}
                {...focusOf(eventIdOf(event))}
                onClick={(click) => {
                  if (click.defaultPrevented || click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
                  click.preventDefault();
                  onOpen(event);
                }}
              >
                <span className="ix-ev__tile" aria-hidden="true">
                  <span className="ix-ev__weekday ix-hue-weekday">{tile.weekday}</span>
                  <span className="ix-ev__day">{tile.day}</span>
                </span>
                <span className="ix-ev__text">
                  <span className="ix-ev__title">{event.name}</span>
                  <span className="ix-ev__line">{comingUpLine(event, { nowMs, roomName: roomName(event) })}</span>
                </span>
                {event.happeningNow && <span className="ix-ev__live">Live</span>}
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
