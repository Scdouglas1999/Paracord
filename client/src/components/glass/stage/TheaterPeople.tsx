import { useEffect, useState } from 'react';
import { MicOff } from 'lucide-react';

import type { MediaEngine } from '../../../lib/media/mediaEngine';
import { Face } from '../places/Lead';
import { personState, type StagePerson } from './stageModel';
import { CameraTile } from './StagePeople';

/**
 * The people in theater (docs/glass-spec.md §6.2): only the talker gets a tile,
 * 168x112, top left; everyone else is a 52px face in a column under it, with a
 * ring (amber for sharing or talking, faint for the rest), a mic-off badge when
 * muted, and a light ring on hover.
 *
 * The tile is the same camera tile as side by side (`CameraTile`): the camera
 * from the call once joined, the face where the picture will be before that.
 * When the talker stops, their tile stays a moment (`TALKER_HOLD_MS`) so a
 * breath between sentences does not flip the column; then everyone is a face
 * until somebody talks again.
 *
 * Someone else who is sharing a screen is a button (their face or their tile):
 * it switches the watch to their stream, as in side by side.
 */

export const TALKER_HOLD_MS = 2000;

export interface TheaterPeopleProps {
  /** Everyone in the watched channel, in the stage's order (cameras, then the rest). */
  people: readonly StagePerson[];
  callEngine: MediaEngine | null;
  joined: boolean;
  realVoice: boolean;
  watchedId: string;
  onSwitch: (userId: string) => void;
}

/** The person the tile is for: whoever talks now, or the last talker for a moment after. */
export function useTheaterTalker(people: readonly StagePerson[]): string | null {
  const talking = people.find((person) => person.talking)?.userId ?? null;
  const [held, setHeld] = useState<string | null>(talking);
  // A new talker takes the tile at once (state adjusted during render, not in an effect).
  if (talking && held !== talking) setHeld(talking);
  useEffect(() => {
    if (talking || !held) return;
    const timer = setTimeout(() => setHeld(null), TALKER_HOLD_MS);
    return () => clearTimeout(timer);
  }, [talking, held]);
  const current = talking ?? held;
  return current && people.some((person) => person.userId === current) ? current : null;
}

export function TheaterPeople({ people, callEngine, joined, realVoice, watchedId, onSwitch }: TheaterPeopleProps) {
  const talkerId = useTheaterTalker(people);
  if (people.length === 0) return null;
  const talker = talkerId ? people.find((person) => person.userId === talkerId) ?? null : null;
  const faces = people.filter((person) => person.userId !== talkerId);
  return (
    <div className="glass-theater__people" role="list" aria-label="People in the call" data-glass-move="people-theater">
      {talker && (
        <CameraTile
          person={talker}
          engine={joined && talker.camera ? callEngine : null}
          realVoice={realVoice}
          watched={talker.userId === watchedId}
          onSwitch={onSwitch}
        />
      )}
      {faces.map((person) => (
        <TheaterFace key={person.userId} person={person} watched={person.userId === watchedId} onSwitch={onSwitch} />
      ))}
    </div>
  );
}

function TheaterFace({ person, watched, onSwitch }: { person: StagePerson; watched: boolean; onSwitch: (userId: string) => void }) {
  const state = personState(person);
  const ring = person.sharing || person.talking ? 'amber' : 'faint';
  const canSwitch = person.sharing && !person.self && !watched;
  const label = `${person.name}, ${state.text}${watched ? ', you are watching their screen' : ''}`;
  const body = (
    <>
      <Face face={person} size={52} />
      {person.muted && !person.listening && (
        <span className="glass-theater__mic" aria-hidden="true">
          <MicOff size={12} strokeWidth={2} />
        </span>
      )}
    </>
  );
  return (
    <div role="listitem" className="glass-theater__face" data-ring={ring} data-talking={person.talking ? 'true' : undefined}>
      {canSwitch ? (
        <button
          type="button"
          className="glass-theater__face-inner glass-focusable"
          aria-label={`Watch ${person.name}'s screen`}
          title={`Watch ${person.name}'s screen`}
          onClick={() => onSwitch(person.userId)}
        >
          {body}
        </button>
      ) : (
        <span className="glass-theater__face-inner" title={label}>
          {body}
          <span className="sr-only">{label}</span>
        </span>
      )}
    </div>
  );
}
