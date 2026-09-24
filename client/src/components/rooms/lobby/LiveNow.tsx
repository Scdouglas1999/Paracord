import { useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router';
import { CalendarClock, Clapperboard, Mic, Music, Radio } from 'lucide-react';

import { LitAvatar } from '../../light';
import { Button } from '../../ui';
import { teamPaint } from '../../sports/gamecast';
import { sportsHref, statusLine, stripAriaLabel, stripMatchup } from '../../sports/model';
import { TeamMark } from '../../sports/TeamMark';
import type { SportsGame } from '../../../api/sports';
import type { RoomLight } from '../../../lib/attention/light';
import { wallClock } from '../../../lib/formatters';
import { roomSharedName } from '../../../lib/motion';
import { cn } from '../../../lib/utils';
import { TogetherCover } from '../../voice/together/TogetherCover';
import type { TogetherActivity } from '../../../lib/together/model';
import { NOBODY_IN_VOICE, liveCountLine, moreLine, voiceLine } from './homeCaptions';
import type { LiveItem, LiveNow as LiveNowModel } from './liveNowModel';
import type { HomeEvent } from './useUpcomingEvents';
import { useHideScores } from './useHideScores';

export interface LiveNowProps {
  guildId: string;
  live: LiveNowModel;
  /** Every voice channel, for the quiet line when nothing is live. */
  voiceRooms: readonly RoomLight[];
  phone: boolean;
  channelName: (channelId: string | null) => string | null;
  onJoinRoom: (room: RoomLight, origin: Element | null) => void;
  onOpenChannel: (channelId: string) => void;
  onRsvp: (eventId: string) => void;
}

/**
 * "Live now": the calls, stages, events and games happening right now, as
 * cards that carry the amber glow. At most three, then "+N more".
 *
 * When nothing is live it is one line — the voice channels as buttons and
 * "Nobody in voice" — and never an invented history.
 */
export function LiveNow({
  guildId,
  live,
  voiceRooms,
  phone,
  channelName,
  onJoinRoom,
  onOpenChannel,
  onRsvp,
}: LiveNowProps) {
  const [expanded, setExpanded] = useState(false);
  const items = expanded ? live.all : live.shown;

  if (live.all.length === 0) {
    if (voiceRooms.length === 0) return null;
    return (
      <section aria-label="Voice channels" className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="pc-home-heading mr-1">Voice channels</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          {voiceRooms.map((room) => (
            <Button
              key={room.key}
              variant="ghost"
              size="sm"
              data-motion-shared={roomSharedName(room.channelId)}
              onClick={(event) => onJoinRoom(room, event.currentTarget)}
              className="shadow-[inset_0_0_0_1px_var(--border-subtle)] hover:shadow-[inset_0_0_0_1px_var(--border-strong)]"
              aria-label={`Join ${room.name}`}
            >
              <Mic size={14} aria-hidden className="text-text-muted" />
              {room.name}
            </Button>
          ))}
        </div>
        <span className="text-meta text-text-muted">{NOBODY_IN_VOICE}</span>
      </section>
    );
  }

  return (
    <section aria-label="Live now" className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <span className="pc-home-live-dot" aria-hidden />
        <h2 className="pc-home-heading">
          Live now
        </h2>
        <span className="text-meta text-text-muted">{liveCountLine(live.all.length)}</span>
      </div>
      <div
        className={cn(
          'grid gap-3',
          // Two columns even for one card, so a lone call is a card and not a
          // banner; three once there are three.
          phone ? 'grid-cols-1' : items.length >= 3 ? 'grid-cols-3' : 'grid-cols-2',
        )}
      >
        {items.map((item) => (
          <LiveCard
            key={item.key}
            item={item}
            compact={phone}
            guildId={guildId}
            channelName={channelName}
            onJoinRoom={onJoinRoom}
            onOpenChannel={onOpenChannel}
            onRsvp={onRsvp}
          />
        ))}
      </div>
      {live.more > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="pc-focusable self-start rounded-[var(--radius-chip)] px-1 text-label text-text-link hover:underline"
        >
          {expanded ? 'Show fewer' : moreLine(live.more)}
        </button>
      )}
    </section>
  );
}

function LiveCard({
  item,
  compact,
  guildId,
  channelName,
  onJoinRoom,
  onOpenChannel,
  onRsvp,
}: {
  item: LiveItem;
  compact: boolean;
  guildId: string;
  channelName: (channelId: string | null) => string | null;
  onJoinRoom: (room: RoomLight, origin: Element | null) => void;
  onOpenChannel: (channelId: string) => void;
  onRsvp: (eventId: string) => void;
}) {
  switch (item.kind) {
    case 'together':
      return <LiveTogetherCard room={item.room} activity={item.activity} compact={compact} onJoin={onJoinRoom} />;
    case 'voice':
    case 'stage':
      return <LiveRoomCard room={item.room} stage={item.kind === 'stage'} compact={compact} onJoin={onJoinRoom} />;
    case 'event':
      return (
        <LiveEventCard
          event={item.event}
          where={channelName(item.event.channelId) ?? item.event.location}
          onOpen={item.event.channelId ? () => onOpenChannel(item.event.channelId as string) : null}
          onRsvp={() => onRsvp(item.event.id)}
        />
      );
    case 'game':
      return <LiveGameCard guildId={guildId} game={item.game} />;
  }
}

/**
 * The card every live thing sits on: the amber edge and glow, still.
 *
 * `speaking` makes the glow breathe, and only a voice or stage card whose
 * channel has somebody talking right now passes it. People sitting in a call
 * in silence, an event and a game all keep the still glow: the breath means
 * "someone is talking in there", and it costs frames on every one of them.
 */
function LiveShell({
  children,
  label,
  shared,
  speaking = false,
}: {
  children: ReactNode;
  label: string;
  shared?: string;
  speaking?: boolean;
}) {
  return (
    <article
      aria-label={label}
      data-motion-shared={shared}
      data-speaking={speaking ? '' : undefined}
      className={cn('pc-home-live flex min-w-0 flex-col gap-3 px-4 pb-3.5 pt-3.5', speaking && 'is-speaking')}
    >
      {children}
    </article>
  );
}

function Kicker({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 text-meta text-light-amber">
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

function LiveRoomCard({
  room,
  stage,
  compact,
  onJoin,
}: {
  room: RoomLight;
  stage: boolean;
  compact: boolean;
  onJoin: (room: RoomLight, origin: Element | null) => void;
}) {
  const talking = room.occupants.filter((occupant) => occupant.speaking).map((occupant) => occupant.person.name);
  // The same flag the faces below breathe on (LitAvatar's `pc-speaking`), so
  // the card and the avatars start and stop together.
  const speaking = room.occupants.some((occupant) => occupant.person.speaking);
  const line = voiceLine(talking, room.occupants.length, room.durationMs);
  // Already in this call: the button takes you back to it, it does not join again.
  const action = room.youAreHere ? 'Return to' : stage ? 'Enter' : 'Join';
  const pile = <FacePile room={room} compact={compact} />;
  return (
    <LiveShell label={`${room.name}, live`} shared={roomSharedName(room.channelId)} speaking={speaking}>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Kicker icon={stage ? <Radio size={12} aria-hidden /> : <Mic size={12} aria-hidden />}>
            {stage ? 'Stage' : 'Voice'}
          </Kicker>
          <h3 className="pc-display truncate text-name text-text-primary">{room.name}</h3>
        </div>
        <Button
          variant="light"
          size="sm"
          onClick={(event) => onJoin(room, event.currentTarget.closest('[data-motion-shared]'))}
          aria-label={`${action} ${room.name}`}
          className="shrink-0"
        >
          {room.youAreHere ? 'Return' : action}
        </Button>
      </div>
      {compact ? (
        <div className="flex min-w-0 items-center gap-3">
          {pile}
          <p className="min-w-0 truncate text-meta text-text-secondary">{line}</p>
        </div>
      ) : (
        <>
          {pile}
          <p className="truncate text-meta text-text-secondary">{line}</p>
        </>
      )}
    </LiveShell>
  );
}

/** The faces in a call, overlapping, with "+N" for the rest. */
function FacePile({ room, compact }: { room: RoomLight; compact: boolean }) {
  const size = compact ? 30 : 38;
  const faces = room.occupants.slice(0, compact ? 3 : 4);
  const extra = room.occupants.length - faces.length;
  return (
    <div className="flex shrink-0 items-center" aria-hidden>
      {faces.map((occupant, index) => (
        <LitAvatar
          key={occupant.person.userId}
          person={occupant.person}
          size={size}
          hideLabel
          room={room.channelId}
          className={cn(index > 0 && (compact ? '-ml-2' : '-ml-2.5'))}
        />
      ))}
      {extra > 0 && (
        <span
          className={cn(
            'flex items-center justify-center rounded-full bg-bg-mod-strong px-2 text-meta text-text-secondary',
            'shadow-[0_0_0_2px_var(--bg-raised)]',
            compact ? '-ml-2' : '-ml-2.5',
          )}
          style={{ height: size, minWidth: size }}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}

/**
 * A call that is watching or listening to something together: what is on,
 * who is there, and the way in.
 */
function LiveTogetherCard({
  room,
  activity,
  compact,
  onJoin,
}: {
  room: RoomLight;
  activity: TogetherActivity;
  compact: boolean;
  onJoin: (room: RoomLight, origin: Element | null) => void;
}) {
  const watching = activity.kind === 'watch';
  const speaking = room.occupants.some((occupant) => occupant.person.speaking);
  const count = room.occupants.length;
  const who = `${count} ${count === 1 ? 'person' : 'people'} ${watching ? 'watching' : 'listening'}`;
  return (
    <LiveShell label={`${room.name}, ${watching ? 'watching' : 'listening to'} ${activity.title ?? 'something'} together`} shared={roomSharedName(room.channelId)} speaking={speaking}>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Kicker icon={watching ? <Clapperboard size={12} aria-hidden /> : <Music size={12} aria-hidden />}>
            {watching ? 'Watching together' : 'Listening together'}
          </Kicker>
          <h3 className="pc-display truncate text-name text-text-primary">{room.name}</h3>
        </div>
        <Button
          variant="light"
          size="sm"
          onClick={(event) => onJoin(room, event.currentTarget.closest('[data-motion-shared]'))}
          aria-label={`${room.youAreHere ? 'Return to' : 'Join'} ${room.name}`}
          className="shrink-0"
        >
          {room.youAreHere ? 'Return' : 'Join'}
        </Button>
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <span className={cn('shrink-0 overflow-hidden rounded-[var(--radius-control)] bg-bg-well', compact ? 'h-10 w-16' : 'h-12 w-20')}>
          <TogetherCover item={{ thumbnail: activity.thumbnail, source: activity.source ?? 'url', content_type: activity.content_type ?? (activity.kind === 'listen' ? 'audio/' : null) }} />
        </span>
        <p className="line-clamp-2 min-w-0 text-label text-text-primary">{activity.title ?? 'Nothing queued'}</p>
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <FacePile room={room} compact={compact} />
        <p className="min-w-0 truncate text-meta text-text-secondary">{who}</p>
      </div>
    </LiveShell>
  );
}

function LiveEventCard({
  event,
  where,
  onOpen,
  onRsvp,
}: {
  event: HomeEvent;
  where: string | null;
  onOpen: (() => void) | null;
  onRsvp: () => void;
}) {
  return (
    <LiveShell label={`${event.name}, happening now`}>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Kicker icon={<CalendarClock size={12} aria-hidden />}>Happening now</Kicker>
          <h3 className="pc-display line-clamp-2 text-name text-text-primary">{event.name}</h3>
        </div>
        {onOpen ? (
          <Button variant="light" size="sm" onClick={onOpen} className="shrink-0">
            Open
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRsvp}
            aria-pressed={event.youAreGoing}
            className="shrink-0 shadow-[inset_0_0_0_1px_var(--border-strong)]"
          >
            {event.youAreGoing ? "You're going" : "I'm going"}
          </Button>
        )}
      </div>
      <p className="truncate text-meta text-text-secondary">
        {[
          where ? `in ${where}` : null,
          event.endsAt ? `until ${wallClock(event.endsAt)}` : null,
          event.going > 0 ? `${event.going} going` : null,
        ]
          .filter(Boolean)
          .join(' · ') || 'Started'}
      </p>
    </LiveShell>
  );
}


/** A game from the Sports add-on, drawn with the add-on's own team marks. */
export function LiveGameCard({ guildId, game }: { guildId: string; game: SportsGame }) {
  const hideScores = useHideScores();
  const away = teamPaint(game.away, game.home);
  const home = teamPaint(game.home, game.away);
  const score = hideScores ? null : `${game.away.score ?? 0}–${game.home.score ?? 0}`;
  return (
    <LiveShell label={stripAriaLabel(game)}>
      <Kicker icon={<span className="pc-live-dot" aria-hidden />}>{game.league.toUpperCase()}</Kicker>
      <Link
        to={sportsHref(guildId)}
        className="pc-focusable flex min-w-0 items-center gap-2 rounded-[var(--radius-control)]"
        style={{ '--pc-away': away.fill, '--pc-home': home.fill } as CSSProperties}
      >
        <TeamMark team={game.away} />
        <TeamMark team={game.home} />
        <span className="min-w-0 flex-1 truncate text-label text-text-primary">{stripMatchup(game)}</span>
        {score && <span className="pc-mono shrink-0 text-label text-text-primary">{score}</span>}
      </Link>
      <p className="truncate text-meta text-text-secondary">{statusLine(game)}</p>
    </LiveShell>
  );
}
