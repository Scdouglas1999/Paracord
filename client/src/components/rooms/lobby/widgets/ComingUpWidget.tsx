import { useCurrentUser } from '../../../../hooks/useCurrentUser';
import { displayName } from '../../../../lib/displayName';
import type { Member } from '../../../../types';
import { PlanAction, PlanCard, type PlanSlotModel } from '../../../glass/cards/PlanCard';
import { planWhen } from '../../../glass/cards/eventTime';
import type { HomeEvent } from '../useUpcomingEvents';
import { WidgetCard, WidgetError, WidgetLink } from './WidgetCard';

export interface ComingUpWidgetProps {
  events: readonly HomeEvent[];
  error: string | null;
  nowMs: number;
  channelName: (channelId: string | null) => string | null;
  /** The server's members, so the host can wear their face. */
  members?: readonly Member[];
  onRsvp: (eventId: string) => void;
  /** Opens the Events page. */
  onCalendar: () => void;
}

/** Three events, the one under way first (there is no "Live now" block to hold it). */
const SHOWN = 3;

/**
 * "Coming up": the next three events (one under way comes first) as cards of the
 * event-card family: the title, when and where, and one decision as text, "Take the spot" and then "You're in". The
 * slots are the ones the server can vouch for: the host, and you. "Calendar" opens the
 * Events page, the full list.
 */
export function ComingUpWidget({ events, error, nowMs, channelName, members, onRsvp, onCalendar }: ComingUpWidgetProps) {
  const me = useCurrentUser();
  const upcoming = [...events].sort((a, b) => Number(b.happeningNow) - Number(a.happeningNow)).slice(0, SHOWN);
  if (upcoming.length === 0 && !error) return null;
  return (
    <WidgetCard title="Coming up" bare action={<WidgetLink onClick={onCalendar}>Calendar</WidgetLink>}>
      {error && <WidgetError>Could not load events: {error}</WidgetError>}
      <ul className="ix-plans">
        {upcoming.map((event) => {
          const where = channelName(event.channelId);
          const host = event.creatorId && event.creatorId !== me?.id
            ? members?.find((member) => (member.user?.id ?? member.user_id) === event.creatorId)
            : undefined;
          const slots: PlanSlotModel[] = [];
          if (event.creatorId && event.creatorId !== me?.id) {
            slots.push({
              key: 'host',
              name: host ? displayName(host.user, host.nick) : 'Host',
              detail: 'Host',
              face: { userId: event.creatorId, avatar: host?.user?.avatar_hash ?? null },
            });
          }
          if (me && (event.youAreGoing || event.creatorId === me.id)) {
            slots.push({
              key: 'you',
              name: 'You',
              detail: event.creatorId === me.id ? 'Host' : undefined,
              face: { userId: me.id, avatar: me.avatar_hash ?? null },
              you: true,
            });
          } else {
            slots.push({ key: 'open', name: 'Your spot', open: true });
          }
          return (
            <li key={event.id}>
              <PlanCard
                kind="Event"
                title={event.name}
                meta={
                  <>
                    {planWhen(event.startsAt, { nowMs, endsAt: event.endsAt, happeningNow: event.happeningNow })}
                    {where ? ` in ${where}` : event.location ? `, ${event.location}` : ''}
                    {event.going > 0 && <span> · {event.going} going</span>}
                  </>
                }
                action={<PlanAction taken={event.youAreGoing} onToggle={() => onRsvp(event.id)} />}
                slots={slots}
              />
            </li>
          );
        })}
      </ul>
    </WidgetCard>
  );
}
