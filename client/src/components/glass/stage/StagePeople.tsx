import { useEffect, useRef, useState } from 'react';
import { MicOff } from 'lucide-react';

import type { MediaEngine } from '../../../lib/media/mediaEngine';
import { cn } from '../../../lib/utils';
import { Face } from '../places/Lead';
import { Waveform } from '../primitives';
import { useNativeUnderlay } from './nativeUnderlay';
import { personState, type StagePerson } from './stageModel';

/**
 * Under the stream (docs/glass-spec.md §6.1): a camera tile for everyone with a
 * camera (equal widths, radius 16; the talker wears a 2px amber inner edge and
 * an amber glow, and the waveform), and a 200x52 chip for everyone else, in a
 * column at the end of the row.
 *
 * A camera is drawn from the call this client is in (`voiceStore.mediaEngine`):
 * a watch carries one stream and never the cameras, so before you join a camera
 * tile shows the person's face where the picture will be. Someone else who is
 * sharing a screen is a button on their tile or chip: it switches the watch to
 * their stream.
 */

export interface StagePeopleProps {
  cameras: readonly StagePerson[];
  chips: readonly StagePerson[];
  /** The call's engine, when this client is in the watched call; cameras draw from it. */
  callEngine: MediaEngine | null;
  /** In the call: pictures are expected; before that a tile shows the face. */
  joined: boolean;
  /** The voice is heard here (joined or listening): the waveform follows the real level. */
  realVoice: boolean;
  watchedId: string;
  onSwitch: (userId: string) => void;
}

export function StagePeople({ cameras, chips, callEngine, joined, realVoice, watchedId, onSwitch }: StagePeopleProps) {
  if (cameras.length === 0 && chips.length === 0) return null;
  return (
    <div className="glass-stage__people" role="list" aria-label="People in the call">
      {cameras.length > 0 && (
        <div className="glass-stage__tiles">
          {cameras.map((person) => (
            <CameraTile
              key={person.userId}
              person={person}
              engine={joined ? callEngine : null}
              realVoice={realVoice}
              watched={person.userId === watchedId}
              onSwitch={onSwitch}
            />
          ))}
        </div>
      )}
      {chips.length > 0 && (
        <div className="glass-stage__chips">
          {chips.map((person) => (
            <PersonChip
              key={person.userId}
              person={person}
              watched={person.userId === watchedId}
              onSwitch={onSwitch}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Whose stream a click on this person would open, or null. */
function switchable(person: StagePerson, watched: boolean): boolean {
  return person.sharing && !person.self && !watched;
}

/** What a screen reader hears after the name: "Talking, camera on". */
function describeState(person: StagePerson, watched: boolean): string {
  const parts = [personState(person).text];
  if (person.camera) parts.push('camera on');
  if (watched) parts.push('you are watching their screen');
  return parts.join(', ');
}

export function CameraTile({
  person,
  engine,
  realVoice,
  watched,
  onSwitch,
}: {
  person: StagePerson;
  engine: MediaEngine | null;
  realVoice: boolean;
  watched: boolean;
  onSwitch: (userId: string) => void;
}) {
  const tileRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hasPicture, setHasPicture] = useState(false);
  const underlayLive = useNativeUnderlay(tileRef, canvasRef);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!engine || !canvas) return;
    let sawFrame = false;
    const unsubscribe = engine.subscribeVideo(
      person.userId,
      canvas,
      () => {
        if (sawFrame) return;
        sawFrame = true;
        setHasPicture(true);
      },
      { preferredTrackId: 'camera' },
    );
    return () => {
      unsubscribe();
      setHasPicture(false);
    };
  }, [engine, person.userId]);

  const canSwitch = switchable(person, watched);
  const body = (
    <>
      <canvas
        ref={canvasRef}
        className="glass-stage__camera"
        aria-hidden="true"
        data-self={person.self ? 'true' : undefined}
        style={{
          opacity: hasPicture && !underlayLive ? 1 : 0,
          visibility: underlayLive ? 'hidden' : 'visible',
        }}
      />
      {!hasPicture && !underlayLive && (
        <span className="glass-stage__tile-face" aria-hidden="true">
          <Face face={person} size={56} />
        </span>
      )}
      <span className="glass-stage__tile-shade" aria-hidden="true" />
      <span className="glass-stage__tile-name">
        <span className="glass-stage__tile-who">{person.name}</span>
        <span className="sr-only">, {describeState(person, watched)}</span>
        {person.talking && (
          <Waveform
            className="glass-stage__wave"
            {...(realVoice ? { 'data-real': '', 'data-motion-speaking': person.userId } : {})}
          />
        )}
        {person.muted && !person.talking && (
          <MicOff size={14} strokeWidth={1.9} className="glass-stage__tile-mic" aria-hidden="true" />
        )}
      </span>
    </>
  );

  return (
    <div
      ref={tileRef}
      role="listitem"
      className="glass-stage__tile"
      data-talking={person.talking ? 'true' : undefined}
      data-watched={watched ? 'true' : undefined}
      data-native-surface-boundary=""
      data-native-underlay-clear=""
      data-underlay={underlayLive ? 'live' : undefined}
    >
      {canSwitch ? (
        <button
          type="button"
          className="glass-stage__tile-button glass-focusable"
          aria-label={`Watch ${person.name}'s screen`}
          title={`Watch ${person.name}'s screen`}
          onClick={() => onSwitch(person.userId)}
        >
          {body}
        </button>
      ) : (
        body
      )}
    </div>
  );
}

function PersonChip({
  person,
  watched,
  onSwitch,
}: {
  person: StagePerson;
  watched: boolean;
  onSwitch: (userId: string) => void;
}) {
  const state = personState(person);
  const canSwitch = switchable(person, watched);
  const body = (
    <>
      <Face face={person} size={32} />
      <span className="glass-stage__chip-text">
        <span className="glass-stage__chip-name">{person.name}</span>
        <span className="glass-stage__chip-state" data-tone={state.tone}>
          {state.text}
        </span>
      </span>
      {person.muted && <MicOff size={15} strokeWidth={1.9} className="glass-stage__chip-mic" aria-hidden="true" />}
    </>
  );
  return (
    <div role="listitem" className={cn('glass-stage__chip', canSwitch && 'glass-stage__chip--button')} data-watched={watched ? 'true' : undefined}>
      {canSwitch ? (
        <button
          type="button"
          className="glass-stage__chip-inner glass-focusable"
          aria-label={`Watch ${person.name}'s screen`}
          title={`Watch ${person.name}'s screen`}
          onClick={() => onSwitch(person.userId)}
        >
          {body}
        </button>
      ) : (
        <span className="glass-stage__chip-inner">
          {body}
          {watched && <span className="sr-only">, you are watching their screen</span>}
        </span>
      )}
    </div>
  );
}
