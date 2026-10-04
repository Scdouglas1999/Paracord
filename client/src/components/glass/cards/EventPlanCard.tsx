import { Fragment } from 'react';

import { useCurrentChannelStore } from '../../../hooks/useChannels';
import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { entityScopeKey } from '../../../lib/serverScope';
import { dayTile, planWhen } from './eventTime';
import { EventButton, EventCard } from './EventCard';
import { useEventMaybe } from './eventMaybe';
import { PlanCard } from './PlanCard';
import { isHappeningNow, useGuildEvent, type GuildEventStatus, type GuildEventView } from './useGuildEvent';
import { useMinuteNow } from './useNow';

/**
 * An event in the timeline, as the event card (docs/index-spec.md §4.11): a
 * calendar tile, its name, when and where, how many are going, and your answer:
 * "I'm in" (cream) and "Maybe".
 *
 *   going      "You're in" with a check, quiet; pressing it gives the spot back
 *   maybe      "Maybe" pressed. The server has only going and not going, so this
 *              is your own mark on this device (`eventMaybe.ts`), never a count
 *   neither    "I'm in" is the card's one cream button
 *
 * An event that is over, or canceled, has no answer to give, so no buttons.
 * `onOpenDetails` adds a "Details" button: the event's own sheet is built by the
 * pages and sheets packages; until a caller hands one in there is nothing to open.
 */

/** Over: canceled, completed, or its time has passed. Nobody can answer for it. */
export function isEventOver(event: GuildEventView, nowMs: number): boolean {
  if (event.status === 3 || event.status === 4) return true;
  return !isHappeningNow(event, nowMs) && event.startsAt.getTime() < nowMs;
}

/** What the card says about the event, in one line: "Friday at 9:00 PM · in General · 3 going". */
export function eventMetaParts(
  event: GuildEventView,
  nowMs: number,
  channelName: string | null | undefined,
): { when: string; live: boolean; parts: string[] } {
  const live = event.status !== 4 && isHappeningNow(event, nowMs);
  const when = event.status === 4 ? 'Canceled' : planWhen(event.startsAt, { nowMs, endsAt: event.endsAt, happeningNow: live });
  const parts: string[] = [];
  if (event.status !== 4) {
    if (channelName) parts.push(`in ${channelName}`);
    else if (event.location) parts.push(event.location);
    if (event.going > 0) parts.push(`${event.going} going`);
  }
  return { when, live, parts };
}

export interface EventPlanViewProps {
  event: GuildEventView;
  nowMs: number;
  /** The channel the event is in, by name. */
  channelName?: string | null;
  /** A "Maybe" marked on this device. */
  maybe: boolean;
  /** An RSVP is on its way. */
  busy?: boolean;
  onToggleRsvp: () => void;
  onSetMaybe: (on: boolean) => void;
  onOpenDetails?: (event: GuildEventView) => void;
  joinTop?: boolean;
}

/** The card for an event the server vouched for: the part with no hooks, so a gallery can draw every state. */
export function EventPlanView({
  event,
  nowMs,
  channelName,
  maybe,
  busy,
  onToggleRsvp,
  onSetMaybe,
  onOpenDetails,
  joinTop,
}: EventPlanViewProps) {
  const over = isEventOver(event, nowMs);
  const { when, live, parts } = eventMetaParts(event, nowMs, channelName);
  const going = event.youAreGoing;
  // Going wins: an RSVP made on another device after a "Maybe" here is the answer.
  const isMaybe = maybe && !going;
  const tile = dayTile(event.startsAt);

  const pressIn = () => {
    onSetMaybe(false);
    onToggleRsvp();
  };
  const pressMaybe = () => {
    if (isMaybe) {
      onSetMaybe(false);
      return;
    }
    onSetMaybe(true);
    // Maybe is not going: if you were in, the spot goes back.
    if (going) onToggleRsvp();
  };

  return (
    <EventCard
      weekday={tile.weekday}
      day={tile.day}
      title={event.name}
      joinTop={joinTop}
      tone={event.status === 4 ? 'canceled' : over ? 'over' : live ? 'live' : undefined}
      data-choice={going ? 'in' : isMaybe ? 'maybe' : undefined}
      meta={
        <>
          {live ? <span className="ix-event__live">{when}</span> : when}
          {/* Each part is kept whole, so a narrow card breaks between them, never inside "3 going". */}
          {parts.map((part) => (
            <Fragment key={part}>
              {' '}
              <span className="ix-event__part">{`· ${part}`}</span>
            </Fragment>
          ))}
        </>
      }
    >
      {!over && (
        <>
          <EventButton primary={!going} check={going} disabled={busy} onClick={pressIn}>
            {going ? 'You’re in' : 'I’m in'}
          </EventButton>
          <EventButton
            pressed={isMaybe}
            check={isMaybe}
            aria-pressed={isMaybe}
            title="Only you see your Maybe"
            onClick={pressMaybe}
          >
            Maybe
          </EventButton>
        </>
      )}
      {onOpenDetails && (
        <EventButton className="ix-event__btn--quiet" onClick={() => onOpenDetails(event)}>
          Details
        </EventButton>
      )}
    </EventCard>
  );
}

/** An event that is loading, gone, or could not be asked for: the card family's plain card, saying so. */
export function EventUnavailable({
  status,
  error,
  joinTop,
}: {
  status: GuildEventStatus;
  error: string | null;
  joinTop?: boolean;
}) {
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

export function EventPlanCard({
  guildId,
  eventId,
  joinTop,
  onOpenDetails,
}: {
  guildId: string | null | undefined;
  eventId: string;
  joinTop?: boolean;
  onOpenDetails?: (event: GuildEventView) => void;
}) {
  const { status, event, error, busy, toggleRsvp } = useGuildEvent(guildId, eventId);
  const scope = useCurrentAccountScope();
  const nowMs = useMinuteNow();
  const channelId = event?.channelId;
  const channel = useCurrentChannelStore((view) => (channelId ? view.channelsById[channelId] : undefined));
  const { maybe, setMaybe } = useEventMaybe(
    event ? (scope ? entityScopeKey(scope, event.id) : event.id) : null,
    event ? event.startsAt.getTime() : null,
  );

  if (!event) return <EventUnavailable status={status} error={error} joinTop={joinTop} />;
  return (
    <EventPlanView
      event={event}
      nowMs={nowMs}
      channelName={channel?.name}
      maybe={maybe}
      busy={busy}
      onToggleRsvp={() => void toggleRsvp()}
      onSetMaybe={setMaybe}
      onOpenDetails={onOpenDetails}
      joinTop={joinTop}
    />
  );
}
