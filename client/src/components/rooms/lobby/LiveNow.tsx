import { useState } from 'react';
import { Link } from 'react-router';
import { Mic } from 'lucide-react';

import { GlassButton } from '../../glass/primitives';
import { PlanAction, PlanCard, type PlanSlotModel } from '../../glass/cards/PlanCard';
import { planWhen } from '../../glass/cards/eventTime';
import { PageSection } from '../../home/GlassPage';
import { LiveRoomRow } from '../../home/LiveRoomRow';
import { teamPaint } from '../../sports/gamecast';
import { sportsHref, statusLine, stripAriaLabel, stripMatchup } from '../../sports/model';
import { TeamMark } from '../../sports/TeamMark';
import { TogetherCover } from '../../voice/together/TogetherCover';
import type { SportsGame } from '../../../api/sports';
import type { RoomLight } from '../../../lib/attention/light';
import { roomSharedName } from '../../../lib/motion';
import type { TogetherActivity } from '../../../lib/together/model';
import type { CSSProperties } from 'react';
import { NOBODY_IN_VOICE, moreLine } from './homeCaptions';
import type { LiveItem, LiveNow as LiveNowModel } from './liveNowModel';
import type { HomeEvent } from './useUpcomingEvents';
import { useHideScores } from './useHideScores';
import { useCurrentUser } from '../../../hooks/useCurrentUser';

export interface LiveNowProps {
  guildId: string;
  live: LiveNowModel;
  /** Every voice channel, for the quiet line when nothing is live. */
  voiceRooms: readonly RoomLight[];
  nowMs: number;
  channelName: (channelId: string | null) => string | null;
  onJoinRoom: (room: RoomLight, origin: Element | null) => void;
  onOpenChannel: (channelId: string) => void;
  onRsvp: (eventId: string) => void;
}

/**
 * "Live now": the calls, stages, events and games happening right now (docs/glass-spec.md
 * §1.3, §3.1), in amber, each with a way in. A call is the live row the places
 * panel draws, at page width; an event is a plan card; a game is a solid card with
 * the add-on's own team marks. At most three, then "+N more". Join is the cream
 * button of the first call, and glass on the rest.
 *
 * When nothing is live it is one line: the voice channels as buttons and "Nobody
 * in voice". Never an invented history.
 */
export function LiveNow({ guildId, live, voiceRooms, nowMs, channelName, onJoinRoom, onOpenChannel, onRsvp }: LiveNowProps) {
  const [expanded, setExpanded] = useState(false);
  const items = expanded ? live.all : live.shown;

  if (live.all.length === 0) {
    if (voiceRooms.length === 0) return null;
    return (
      <PageSection kicker="Voice channels" list={false}>
        <div className="glass-ov__voices">
          {voiceRooms.map((room) => (
            <GlassButton
              key={room.key}
              variant="glass"
              data-motion-shared={roomSharedName(room.channelId)}
              aria-label={`Join ${room.name}`}
              onClick={(event) => onJoinRoom(room, event.currentTarget)}
            >
              <Mic size={14} aria-hidden />
              {room.name}
            </GlassButton>
          ))}
          <span className="glass-sec__note" style={{ margin: 0 }}>
            {NOBODY_IN_VOICE}
          </span>
        </div>
      </PageSection>
    );
  }

  // The first call carries the page's one cream button.
  const firstCall = items.findIndex((item) => item.kind === 'voice' || item.kind === 'stage' || item.kind === 'together');

  return (
    <PageSection kicker="Live now" tone="amber" count={live.all.length}>
      {items.map((item, index) => (
        <LiveItemRow
          key={item.key}
          item={item}
          primary={index === firstCall}
          guildId={guildId}
          nowMs={nowMs}
          channelName={channelName}
          onJoinRoom={onJoinRoom}
          onOpenChannel={onOpenChannel}
          onRsvp={onRsvp}
        />
      ))}
      {live.more > 0 && (
        <li className="glass-ov__more">
          <GlassButton variant="text" onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Show fewer' : moreLine(live.more)}
          </GlassButton>
        </li>
      )}
    </PageSection>
  );
}

function LiveItemRow({
  item,
  primary,
  guildId,
  nowMs,
  channelName,
  onJoinRoom,
  onOpenChannel,
  onRsvp,
}: {
  item: LiveItem;
  primary: boolean;
  guildId: string;
  nowMs: number;
  channelName: (channelId: string | null) => string | null;
  onJoinRoom: (room: RoomLight, origin: Element | null) => void;
  onOpenChannel: (channelId: string) => void;
  onRsvp: (eventId: string) => void;
}) {
  switch (item.kind) {
    case 'together':
      return (
        <LiveRoomRow
          room={item.room}
          kindLabel={item.activity.kind === 'watch' ? 'Watching together' : 'Listening together'}
          primary={primary}
          nowMs={nowMs}
          onOpen={() => onOpenChannel(item.room.channelId)}
          onJoin={(origin) => onJoinRoom(item.room, origin)}
        >
          <TogetherLine activity={item.activity} />
        </LiveRoomRow>
      );
    case 'voice':
    case 'stage':
      return (
        <LiveRoomRow
          room={item.room}
          kindLabel={item.kind === 'stage' ? 'Stage' : null}
          primary={primary}
          nowMs={nowMs}
          onOpen={() => onOpenChannel(item.room.channelId)}
          onJoin={(origin) => onJoinRoom(item.room, origin)}
        />
      );
    case 'event':
      return (
        <li>
          <LiveEventCard
            event={item.event}
            where={channelName(item.event.channelId) ?? item.event.location}
            nowMs={nowMs}
            onOpen={item.event.channelId ? () => onOpenChannel(item.event.channelId as string) : null}
            onRsvp={() => onRsvp(item.event.id)}
          />
        </li>
      );
    case 'game':
      return (
        <li>
          <LiveGameCard guildId={guildId} game={item.game} />
        </li>
      );
  }
}

/** What a call is playing together: the cover and the title, under the faces. */
function TogetherLine({ activity }: { activity: TogetherActivity }) {
  return (
    <span className="glass-live__meta">
      <span className="glass-live__cover" aria-hidden>
        <TogetherCover item={{ thumbnail: activity.thumbnail, source: activity.source ?? 'url', content_type: activity.content_type ?? (activity.kind === 'listen' ? 'audio/' : null) }} />
      </span>
      <span className="glass-live__line">{activity.title ?? 'Nothing queued'}</span>
    </span>
  );
}

/**
 * An event whose time is now, as a plan card (§3.2): "Happening now" and its one
 * decision. With a channel to go to, the decision is Open; without one it is the
 * RSVP the card always has.
 */
function LiveEventCard({
  event,
  where,
  nowMs,
  onOpen,
  onRsvp,
}: {
  event: HomeEvent;
  where: string | null;
  nowMs: number;
  onOpen: (() => void) | null;
  onRsvp: () => void;
}) {
  const me = useCurrentUser();
  const slots: PlanSlotModel[] =
    event.youAreGoing && me
      ? [{ key: 'you', name: 'You', face: { userId: me.id, avatar: me.avatar_hash ?? null }, you: true }]
      : [{ key: 'open', name: 'Your spot', open: true }];
  return (
    <PlanCard
      kind="Event"
      title={event.name}
      meta={
        <>
          {planWhen(event.startsAt, { nowMs, endsAt: event.endsAt, happeningNow: true })}
          {where ? ` in ${where}` : ''}
          {event.going > 0 && <span className="glass-plan__count"> · {event.going} going</span>}
        </>
      }
      action={
        onOpen ? (
          <GlassButton variant="text" onClick={onOpen}>
            Open
          </GlassButton>
        ) : (
          <PlanAction taken={event.youAreGoing} onToggle={onRsvp} />
        )
      }
      slots={slots}
    />
  );
}

/** A game from the Sports add-on, drawn with the add-on's own team marks. */
export function LiveGameCard({ guildId, game }: { guildId: string; game: SportsGame }) {
  const hideScores = useHideScores();
  const away = teamPaint(game.away, game.home);
  const home = teamPaint(game.home, game.away);
  const score = hideScores ? null : `${game.away.score ?? 0}–${game.home.score ?? 0}`;
  return (
    <article aria-label={stripAriaLabel(game)} className="glass-game">
      <span className="glass-kicker glass-live__kicker">{game.league.toUpperCase()}</span>
      <Link
        to={sportsHref(guildId)}
        className="glass-game__link glass-focusable"
        style={{ '--pc-away': away.fill, '--pc-home': home.fill } as CSSProperties}
      >
        <span className="glass-game__teams">
          <TeamMark team={game.away} />
          <TeamMark team={game.home} />
        </span>
        <span className="glass-name" style={{ flex: '1 1 auto', minWidth: 0 }}>
          {stripMatchup(game)}
        </span>
        {score && <span className="glass-instrument glass-game__score">{score}</span>}
      </Link>
      <span className="glass-secondary">{statusLine(game)}</span>
    </article>
  );
}
