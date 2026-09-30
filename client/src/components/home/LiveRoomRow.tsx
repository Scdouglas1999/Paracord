import type { ReactNode } from 'react';

import { GlassButton, InstrumentText, Waveform } from '../glass/primitives';
import { FaceStack } from '../glass/places/Lead';
import { liveKicker, liveLine, type FaceModel } from '../glass/places/model';
import type { RoomLight } from '../../lib/attention/light';
import { roomSharedName } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { useVoiceStore } from '../../stores/voiceStore';

/**
 * A voice room with somebody in it, on a page (docs/glass-spec.md §3.1, the live
 * row): the room's own tint behind a dark end, the name, the amber "LIVE"
 * kicker, the occupants' faces, the talking waveform and one line ("Vincent is
 * streaming"). Amber is the one color a live thing wears (§1.3).
 *
 * The body opens the room; Join is a sibling control, never a child of it. Join
 * is the cream button when `primary` (the one on the page) and glass otherwise.
 *
 * "LIVE 42 MIN" is written only when the wire says when the stream began
 * (`self_stream_started_at`); this client's own observation of when a call lit
 * up is a lower bound, not the stream's age, so it is never used for it.
 */

/** Faces drawn before "+N". */
const FACES = 4;

export interface LiveRoomRowProps {
  room: RoomLight;
  /** A second line of context beside the name: the server ("Game Night"). */
  where?: string | null;
  /** "Stage" or "Watching together": what kind of live it is, when it is not just a call. */
  kindLabel?: string | null;
  /** Join is the cream button. Only one on a page should be. */
  primary?: boolean;
  nowMs: number;
  /** Open the room's page (no joining). `origin` is the row, for the walk-in motion. */
  onOpen: (origin: Element | null) => void;
  /** Take the call: `Join`, or `Return` when you are already in it. */
  onJoin: (origin: Element | null) => void;
  /** More words under the faces (a title being watched). */
  children?: ReactNode;
  className?: string;
}

export function LiveRoomRow({ room, where, kindLabel, primary, nowMs, onOpen, onJoin, children, className }: LiveRoomRowProps) {
  const occupants = room.occupants;
  const streamer = room.screenSharer ?? room.cameraSharer;
  const startedAt = useVoiceStore((state) => {
    if (!streamer) return null;
    const entry = state.channelParticipants.get(room.channelId)?.find((voice) => voice.user_id === streamer.person.userId);
    return typeof entry?.self_stream_started_at === 'string' ? entry.self_stream_started_at : null;
  });
  const faces: FaceModel[] = occupants.slice(0, FACES).map((occupant) => ({
    userId: occupant.person.userId,
    name: occupant.person.name,
    avatar: occupant.person.avatar,
  }));
  // The same flag the faces use: somebody who is offline is not talking, whatever
  // a stale voice state says.
  const talking = occupants.filter((occupant) => occupant.person.speaking).map((occupant) => occupant.person.name);
  const line = liveLine({
    streamerName: streamer ? streamer.person.name : null,
    talkingNames: talking,
    occupantNames: occupants.map((occupant) => occupant.person.name),
    occupants: occupants.length,
  });
  const more = Math.max(0, occupants.length - faces.length);
  const action = room.youAreHere ? 'Return' : 'Join';

  return (
    <li
      aria-label={`${room.name}, live`}
      data-motion-shared={roomSharedName(room.channelId)}
      className={cn('glass-live', className)}
    >
      <span className="glass-live__scene" aria-hidden="true" />
      <span className="glass-live__shade" aria-hidden="true" />
      <button
        type="button"
        className="glass-live__main glass-focusable"
        aria-label={`Open ${room.name}`}
        onClick={(event) => onOpen(event.currentTarget.closest('[data-motion-shared]'))}
      >
        <span className="glass-live__head">
          <span className="glass-name">{room.name}</span>
          <InstrumentText className="glass-live__kicker">{liveKicker(startedAt, nowMs)}</InstrumentText>
          {(where || kindLabel) && (
            <span className="glass-live__where">{[kindLabel, where].filter(Boolean).join(' · ')}</span>
          )}
        </span>
        <span className="glass-live__meta">
          <FaceStack faces={faces} size={26} overlap={8} className="glass-live__faces" />
          {more > 0 && <InstrumentText className="glass-live__more">+{more}</InstrumentText>}
          {talking.length > 0 && <Waveform />}
          <span className="glass-live__line">{line}</span>
        </span>
        {children}
        <span className="sr-only">In the room: {occupants.map((occupant) => occupant.person.name).join(', ')}</span>
      </button>
      <GlassButton
        variant={primary ? 'primary' : 'glass'}
        size="sm"
        className="glass-live__action"
        aria-label={`${action} ${room.name}`}
        onClick={(event) => onJoin(event.currentTarget.closest('[data-motion-shared]'))}
      >
        {action}
      </GlassButton>
    </li>
  );
}
