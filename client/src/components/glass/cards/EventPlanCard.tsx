import { useCurrentChannelStore } from '../../../hooks/useChannels';
import { useCurrentAccountScope, useCurrentUser } from '../../../hooks/useCurrentUser';
import { displayName } from '../../../lib/displayName';
import { entityScopeKey } from '../../../lib/serverScope';
import { useMemberStore } from '../../../stores/memberStore';
import { planWhen } from './eventTime';
import { PlanAction, PlanCard, type PlanSlotModel } from './PlanCard';
import { isHappeningNow, useGuildEvent, type GuildEventView } from './useGuildEvent';
import { useMinuteNow } from './useNow';

/**
 * An event in the timeline, as a plan card (docs/glass-spec.md §3.2): its
 * title, when and where, who is hosting and whether you are in, and the one
 * decision, "Take the spot" / "You're in".
 *
 * The events feature has no capacity or slot list yet (owner decision: later),
 * so the slots are the ones the server can vouch for: the host, and you. The
 * dashed circle is your own spot, open until you take it.
 */

/** Over: canceled, completed, or its time has passed. Nobody can take a spot in it. */
export function isEventOver(event: GuildEventView, nowMs: number): boolean {
  if (event.status === 3 || event.status === 4) return true;
  return !isHappeningNow(event, nowMs) && event.startsAt.getTime() < nowMs;
}

export function EventPlanCard({
  guildId,
  eventId,
  joinTop,
}: {
  guildId: string | null | undefined;
  eventId: string;
  joinTop?: boolean;
}) {
  const { status, event, error, busy, toggleRsvp } = useGuildEvent(guildId, eventId);
  const me = useCurrentUser();
  const scope = useCurrentAccountScope();
  const nowMs = useMinuteNow();
  const channelId = event?.channelId;
  const channel = useCurrentChannelStore((view) => (channelId ? view.channelsById[channelId] : undefined));
  const members = useMemberStore((state) =>
    guildId && scope ? state.members.get(entityScopeKey(scope, guildId)) : undefined,
  );
  const host = event?.creatorId
    ? members?.find((member) => (member.user?.id ?? member.user_id) === event.creatorId)
    : undefined;

  if (!event) {
    return (
      <PlanCard
        kind="Event"
        label={status === 'loading' ? 'Event, loading' : 'Event, unavailable'}
        joinTop={joinTop}
        title={status === 'loading' ? 'Event' : 'An event'}
        meta={
          status === 'loading'
            ? 'Loading…'
            : status === 'error'
              ? `Could not load this event: ${error ?? 'try again in a moment'}`
              : 'This event is no longer available'
        }
        aria-busy={status === 'loading' || undefined}
      />
    );
  }

  const over = isEventOver(event, nowMs);
  const happeningNow = isHappeningNow(event, nowMs);
  const iAmHost = Boolean(me?.id) && event.creatorId === me?.id;

  const slots: PlanSlotModel[] = [];
  if (event.creatorId && !iAmHost) {
    slots.push({
      key: 'host',
      name: host ? displayName(host.user, host.nick) : 'Host',
      detail: 'Host',
      face: { userId: event.creatorId, avatar: host?.user?.avatar_hash ?? null },
    });
  }
  if (me && (event.youAreGoing || iAmHost)) {
    slots.push({
      key: 'you',
      name: 'You',
      detail: iAmHost ? 'Host' : undefined,
      face: { userId: me.id, avatar: me.avatar_hash ?? null, name: displayName(me) },
      you: true,
    });
  } else if (!over) {
    slots.push({ key: 'open', name: 'Your spot', open: true });
  }

  const place = channel?.name ? ` in ${channel.name}` : event.location ? `, ${event.location}` : '';
  const when = event.status === 4 ? 'Canceled' : planWhen(event.startsAt, { nowMs, endsAt: event.endsAt, happeningNow });

  return (
    <PlanCard
      kind="Event"
      joinTop={joinTop}
      title={event.name}
      meta={
        <>
          {when}
          {event.status !== 4 && place}
          {event.going > 0 && <span className="glass-plan__count"> · {event.going} going</span>}
        </>
      }
      action={over ? undefined : <PlanAction taken={event.youAreGoing} busy={busy} onToggle={() => void toggleRsvp()} />}
      slots={slots}
    />
  );
}
