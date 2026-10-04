import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

import type { MediaEngine } from '../../../lib/media/mediaEngine';
import type { StagePerson } from '../../glass/stage/stageModel';
import { AvatarStack } from '../identity';
import { CallTile } from './CallTile';
import { gridLayout, listeningLabel, tileFocus, type GridLayout } from './callModel';

/**
 * Nobody in focus: everyone in the call as tiles (docs/index-spec.md §7.2):
 * 2 columns, 3 above 4 people, 4 above 9; 16:9 tiles when anyone has a camera
 * (the largest that fit), otherwise the prototype's tall tiles filling the
 * area. Listeners and a stage channel's audience are one row of faces under
 * the tiles ("12 listening").
 *
 * A click on a sharer's tile focuses their stream; on a camera, their camera.
 */
export interface PeopleGridProps {
  tiles: readonly StagePerson[];
  listening: readonly StagePerson[];
  anyCamera: boolean;
  engine: MediaEngine | null;
  realVoice: boolean;
  onFocus: (person: StagePerson, kind: 'stream' | 'camera') => void;
  /** The name a person's monogram is drawn from (yours is your name, not "You"). */
  faceName: (person: StagePerson) => string;
}

export function PeopleGrid({ tiles, listening, anyCamera, engine, realVoice, onFocus, faceName }: PeopleGridProps) {
  const areaRef = useRef<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState<GridLayout>(() => gridLayout(tiles.length, false, 0, 0));
  const count = tiles.length;

  // The layout size, never the painted box: the surface may be mid-move
  // (scaled) when this runs, and a scaled measurement would stick.
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const measure = () => {
      const next = gridLayout(count, anyCamera, area.clientWidth, area.clientHeight);
      setLayout((previous) =>
        previous.columns === next.columns &&
        previous.rows === next.rows &&
        previous.tile?.width === next.tile?.width &&
        previous.tile?.height === next.tile?.height
          ? previous
          : next,
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  }, [count, anyCamera]);

  const gridStyle = {
    '--ix-call-cols': layout.columns,
    '--ix-call-rows': layout.rows,
    ...(layout.tile ? { '--ix-call-tile-w': `${layout.tile.width}px`, '--ix-call-tile-h': `${layout.tile.height}px` } : {}),
  } as CSSProperties;

  return (
    <div className="ix-call-people">
      <div ref={areaRef} className="ix-call-people__area">
        <div
          className="ix-call-grid"
          role="list"
          aria-label="People in the call"
          data-sized={layout.tile ? 'true' : undefined}
          data-count={count}
          style={gridStyle}
        >
          {tiles.map((person) => {
            const focus = tileFocus(person);
            return (
              <CallTile
                key={person.userId}
                person={person}
                engine={engine}
                realVoice={realVoice}
                variant="grid"
                faceName={faceName(person)}
                onActivate={focus ? () => onFocus(person, focus) : null}
                activateLabel={focus ? activateLabelOf(person, focus) : undefined}
              />
            );
          })}
        </div>
      </div>
      {listening.length > 0 && <ListeningRow people={listening} faceName={faceName} />}
    </div>
  );
}

/** "Watch Vincent's screen", "Show your stream preview", "Focus Brendan's camera". */
export function activateLabelOf(person: StagePerson, kind: 'stream' | 'camera'): string {
  if (kind === 'stream') return person.self ? 'Show your stream preview' : `Watch ${person.name}'s screen`;
  return person.self ? 'Focus your camera' : `Focus ${person.name}'s camera`;
}

/** The people who hear the call without being in it: faces and a count. */
export function ListeningRow({ people, faceName }: { people: readonly StagePerson[]; faceName: (person: StagePerson) => string }) {
  const names = people.map((person) => (person.self ? 'You' : person.name)).join(', ');
  return (
    <div className="ix-call-listening" role="group" aria-label={`${listeningLabel(people.length)}: ${names}`}>
      <AvatarStack people={people.map((person) => ({ userId: person.userId, name: faceName(person), avatar: person.avatar }))} size={24} max={5} ring="var(--ix-call)" />
      <span className="ix-call-listening__count" aria-hidden="true">{listeningLabel(people.length)}</span>
    </div>
  );
}
