import { useCurrentUser } from '../../hooks/useCurrentUser';
import { PlanAction, PlanCard, type PlanSlotModel } from '../glass/cards/PlanCard';
import { planWhen } from '../glass/cards/eventTime';
import { PageSection } from './GlassPage';
import type { ComingUpEvent } from './useComingUp';

export interface HomeComingUpProps {
  events: readonly ComingUpEvent[];
  nowMs: number;
  onSetGoing: (event: ComingUpEvent, going: boolean) => void;
}

/**
 * One scheduled event, as the timeline draws it (docs/glass-spec.md §3.2): a
 * plan card, one step above the pane, with the time and place, who is going and
 * one decision as text, "Take the spot" and, once taken, "You're in".
 *
 * The events feature has no capacity or slot list yet (owner decision, plan
 * §8.6), so the slot is your own: an open circle until you take it, your face
 * once you have.
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
  const me = useCurrentUser();
  const startsAt = new Date(event.startsAtMs);
  const where = event.roomName ? ` in ${event.roomName}` : event.location ? `, ${event.location}` : '';
  const slots: PlanSlotModel[] =
    event.rsvp && me
      ? [{ key: 'you', name: 'You', face: { userId: me.id, avatar: me.avatar_hash ?? null }, you: true }]
      : [{ key: 'open', name: 'Your spot', open: true }];

  return (
    <li>
      <PlanCard
        kind="Event"
        title={event.name}
        meta={
          <>
            {planWhen(startsAt, { nowMs })}
            {where}
            {' · '}
            {event.buildingName}
            {event.going > 0 && <span className="glass-plan__count"> · {event.going} going</span>}
          </>
        }
        action={<PlanAction taken={event.rsvp} onToggle={() => onSetGoing(event, !event.rsvp)} />}
        slots={slots}
      />
    </li>
  );
}

/**
 * Coming up — scheduled events across every server (docs/glass-spec.md §3.1).
 *
 * **Omitted entirely when there is nothing scheduled.** An empty "Coming up"
 * heading over a blank space is the "No data" of section headers.
 */
export function HomeComingUp({ events, nowMs, onSetGoing }: HomeComingUpProps) {
  if (events.length === 0) return null;
  return (
    <PageSection kicker="Coming up" list={false}>
      <ul className="glass-plans">
        {events.map((event) => (
          <EventCard key={event.key} event={event} nowMs={nowMs} onSetGoing={onSetGoing} />
        ))}
      </ul>
    </PageSection>
  );
}
