import { Button } from '../../../ui';
import { wallClock } from '../../../../lib/formatters';
import { cn } from '../../../../lib/utils';
import type { HomeEvent } from '../useUpcomingEvents';
import { WidgetCard, WidgetError, WidgetLink } from './WidgetCard';

export interface ComingUpWidgetProps {
  events: readonly HomeEvent[];
  error: string | null;
  nowMs: number;
  channelName: (channelId: string | null) => string | null;
  onRsvp: (eventId: string) => void;
  onCalendar: () => void;
}

const DAY = 24 * 60 * 60 * 1000;

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * The time beside a day tile: "Today 7:00 pm", "Tomorrow 1:30 pm", or just
 * "6:00 pm" — the tile already says which day.
 */
export function eventWhen(date: Date, nowMs: number): string {
  const now = new Date(nowMs);
  if (sameDay(date, now)) return `Today ${wallClock(date)}`;
  if (sameDay(date, new Date(nowMs + DAY))) return `Tomorrow ${wallClock(date)}`;
  return wallClock(date);
}

/**
 * "Coming up": the next three events. The first carries its RSVP inline;
 * "Calendar" opens the server's full list.
 */
export function ComingUpWidget({ events, error, nowMs, channelName, onRsvp, onCalendar }: ComingUpWidgetProps) {
  const upcoming = events.filter((event) => !event.happeningNow).slice(0, 3);
  if (upcoming.length === 0 && !error) return null;
  return (
    <WidgetCard title="Coming up" action={<WidgetLink onClick={onCalendar}>Calendar</WidgetLink>}>
      {error && <WidgetError>Could not load events: {error}</WidgetError>}
      <ul className="flex flex-col gap-3">
        {upcoming.map((event, index) => {
          const where = channelName(event.channelId) ?? event.location;
          const meta = [eventWhen(event.startsAt, nowMs), where, event.going > 0 ? `${event.going} going` : null]
            .filter(Boolean)
            .join(' · ');
          return (
            <li key={event.id} className="flex flex-col gap-2.5">
              <div className="flex items-center gap-3">
                <span
                  aria-hidden
                  className={cn(
                    'flex w-11 shrink-0 flex-col items-center rounded-[var(--radius-control)] py-1.5',
                    index === 0 ? 'bg-bg-raised shadow-[var(--shadow-raised)]' : 'bg-bg-mod-subtle',
                  )}
                >
                  <span className="pc-mono text-[10.5px] leading-none text-text-muted">
                    {event.startsAt.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}
                  </span>
                  <span className="pc-display mt-1 text-heading leading-none text-text-primary">
                    {event.startsAt.getDate()}
                  </span>
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-label font-semibold text-text-primary">{event.name}</span>
                  <span className="truncate text-meta text-text-muted">{meta}</span>
                </span>
              </div>
              {index === 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRsvp(event.id)}
                  aria-pressed={event.youAreGoing}
                  className={cn(
                    'w-full',
                    event.youAreGoing
                      ? 'bg-accent-tint text-accent-primary hover:bg-accent-tint-strong hover:text-accent-primary'
                      : 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
                  )}
                >
                  {event.youAreGoing ? "You're going" : "I'm going"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </WidgetCard>
  );
}
