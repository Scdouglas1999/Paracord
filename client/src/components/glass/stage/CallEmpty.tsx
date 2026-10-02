import type { CSSProperties } from 'react';
import { MicOff } from 'lucide-react';

import { Face } from '../places/Lead';
import { Waveform } from '../primitives';
import { personState, type StagePerson } from './stageModel';

/**
 * The call with no cameras on (docs/design/glass-polish-2-checkpoint.md, item 6;
 * `CallStage`). Nothing is playing, so the people are the stage: their faces,
 * large and centered, each with their name, the talker wearing an amber ring and
 * a soft glow and the waveform beside their name, and under them, quietly, the
 * call's name and what is not happening ("No one is sharing"). The call's
 * controls stay in their row under it.
 *
 * It replaces the camera tiles and chips for as long as no one has a camera on:
 * a camera turning on puts the tiles back (`StagePeople`), the same way a screen
 * share does for the stream's own stage. Someone else who starts sharing is a
 * button on their face (it switches the stage to their screen), with a ring in
 * amber and "Sharing screen" under it; you are never one.
 *
 * Sizes follow how many there are, so two people read as two people and a
 * crowd still fits: 128px for one or two, shrinking to 56px past ten. On a
 * phone, where the stage is a card between the chrome drawn over it, they are
 * smaller, in one row for up to five, and the card's chrome names the call, so
 * the name and the line are not drawn (the line stays for a screen reader).
 */

export interface CallEmptyProps {
  /** Everyone in the call, in the stage's order (others first, then you). */
  people: readonly StagePerson[];
  /** The call's name, large under the faces ("Game Night Lounge", or whom a DM is with). */
  name: string;
  /** What is not happening, or what to do about it: "No one is sharing". */
  line: string;
  /** The voice is heard here (joined or listening): the waveform follows the real level. */
  realVoice: boolean;
  phone: boolean;
  /** Open a person's screen, when they are sharing it. */
  onSwitch: (userId: string) => void;
}

/**
 * The diameter of a face for this many people (px). The phone's card is 120px of
 * room between the chrome over it: a face, a name and a state in one row for up
 * to five, two rows of small ones beyond that.
 */
export function callFaceSize(count: number, phone: boolean): number {
  if (phone) {
    if (count <= 4) return 56;
    if (count <= 5) return 48;
    return count <= 10 ? 36 : 28;
  }
  if (count <= 2) return 128;
  if (count <= 4) return 112;
  if (count <= 6) return 96;
  return count <= 10 ? 72 : 56;
}

/**
 * How many faces go in a row: as many as fit at that size, and when they do not
 * all fit, the rows share them out evenly (7 people are 4 and 3, not 6 and 1).
 */
export function callColumns(count: number, phone: boolean): number {
  const size = callFaceSize(count, phone);
  const widest = phone ? 5 : size >= 96 ? 6 : size >= 72 ? 8 : 10;
  const rows = Math.max(1, Math.ceil(count / widest));
  return Math.max(1, Math.ceil(count / rows));
}

export function CallEmpty({ people, name, line, realVoice, phone, onSwitch }: CallEmptyProps) {
  const size = callFaceSize(people.length, phone);
  return (
    <div
      className="glass-call-empty"
      data-count={people.length}
      data-layout={phone ? 'phone' : 'pane'}
      style={{ '--call-face': `${size}px`, '--call-columns': callColumns(people.length, phone) } as CSSProperties}
    >
      {people.length > 0 && (
        <div className="glass-call-empty__people" role="list" aria-label="People in the call">
          {people.map((person) => (
            <CallFace
              key={person.userId}
              person={person}
              size={size}
              realVoice={realVoice}
              phone={phone}
              onSwitch={onSwitch}
            />
          ))}
        </div>
      )}
      <div className="glass-call-empty__text">
        {!phone && (
          <p className="glass-call-empty__name" aria-hidden="true">
            {name}
          </p>
        )}
        <p className={phone ? 'sr-only' : 'glass-call-empty__line'} role="status">
          {line}
        </p>
      </div>
    </div>
  );
}

function CallFace({
  person,
  size,
  realVoice,
  phone,
  onSwitch,
}: {
  person: StagePerson;
  size: number;
  realVoice: boolean;
  phone: boolean;
  onSwitch: (userId: string) => void;
}) {
  const state = personState(person);
  // "Mic on" is what everyone is by default; only what is out of the ordinary is said.
  // On a phone's card the talker's waveform says they are talking, and the word is
  // kept for a screen reader.
  const quiet = state.text === 'Mic on' || (phone && person.talking && state.text === 'Talking');
  const ring = person.sharing || person.talking ? 'amber' : 'faint';
  const canSwitch = person.sharing && !person.self;
  const body = (
    <>
      <span className="glass-call-empty__face">
        <Face face={person} size={size} />
        {person.muted && !person.listening && (
          <span className="glass-call-empty__mic" aria-hidden="true">
            <MicOff size={Math.max(11, Math.round(size * 0.16))} strokeWidth={2} />
          </span>
        )}
      </span>
      <span className="glass-call-empty__who">
        <span className="glass-call-empty__person-name">
          <span className="glass-call-empty__person-who">{person.name}</span>
          <span className="sr-only">,</span>
          {person.talking && (
            <Waveform
              className="glass-stage__wave glass-call-empty__wave"
              {...(realVoice ? { 'data-real': '', 'data-motion-speaking': person.userId } : {})}
            />
          )}
        </span>
        {quiet ? (
          <span className="sr-only">{state.text}</span>
        ) : (
          <span className="glass-call-empty__state" data-tone={state.tone}>
            {state.text}
          </span>
        )}
      </span>
    </>
  );
  return (
    <div
      role="listitem"
      className="glass-call-empty__person"
      data-ring={ring}
      data-talking={person.talking ? 'true' : undefined}
      data-self={person.self ? 'true' : undefined}
    >
      {canSwitch ? (
        <button
          type="button"
          className="glass-call-empty__person-inner glass-focusable"
          aria-label={`Watch ${person.name}'s screen`}
          title={`Watch ${person.name}'s screen`}
          onClick={() => onSwitch(person.userId)}
        >
          {body}
        </button>
      ) : (
        <span className="glass-call-empty__person-inner">{body}</span>
      )}
    </div>
  );
}
