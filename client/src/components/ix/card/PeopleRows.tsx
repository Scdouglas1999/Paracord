import { useLayoutEffect, useRef, useState, type MouseEvent } from 'react';

import { cn } from '../../../lib/utils';
import { IxGlyph } from '../glyphs';
import { Avatar, AvatarStack } from '../identity';
import { onSettle } from '../motion';
import { PUSH_UP_MS, ROW_IN_MS, playEnter, playLeave, playPush } from './cardMotion';
import { rowName, type CardOverflow, type CardPerson } from './model';
import { Wave } from './Wave';

/**
 * The card's people (docs/index-spec.md §3.1 "People rows", §4.3, §4.4, §5.5).
 *
 * One 32px row per person in the card's stable order: their 24px face with the
 * talking ring (an element whose opacity fades 150ms in, 300ms out, never an
 * animated shadow), their name, and one trailing mark: the screen glyph while
 * they share (a button: it opens their stream), the waveform while they talk,
 * mic-off while they are muted. A seventh person turns the sixth row into
 * "and N more".
 *
 * A row that arrives plays in (500ms spring) and pushes what is below it down;
 * a row that goes fades and shrinks (250ms ease), then what was below it
 * closes up (450ms spring). Rows that were there when the card mounted, and
 * rows in a pane that is sliding out, do not move.
 */

interface Shown {
  person: CardPerson;
  leaving: boolean;
}

/** Keep people who just left in place (marked leaving) until their exit plays. */
export function mergeRows(previous: readonly Shown[], next: readonly CardPerson[]): Shown[] {
  const ids = new Set(next.map((person) => person.userId));
  const merged: Shown[] = next.map((person) => ({ person, leaving: false }));
  previous.forEach((entry, index) => {
    if (ids.has(entry.person.userId)) return;
    merged.splice(Math.min(index, merged.length), 0, { person: entry.person, leaving: true });
  });
  return merged;
}

/** Row gap (ix-card.css `.ix-card-rows { gap: 2px }`): a row's share of the list's height. */
const ROW_GAP = 2;

/** Elements after `element` among its siblings, then its parent's, up to (not past) `stop`. */
function after(element: Element, stop: Element | null): Element[] {
  const out: Element[] = [];
  let node: Element | null = element;
  while (node && node !== stop) {
    for (let next = node.nextElementSibling; next; next = next.nextElementSibling) out.push(next);
    node = node.parentElement;
  }
  return out;
}

export interface PeopleRowsProps {
  rows: readonly CardPerson[];
  overflow: CardOverflow | null;
  /** This client hears the room: the waveform follows real levels. */
  heard: boolean;
  /** Rows arriving and leaving may move (false on the card's first commit and in a leaving pane). */
  animate: () => boolean;
  /** A row that must not play its own entrance (your face flies in instead, §5.7). */
  noEnterFor: string | null;
  onOpenPerson: (person: CardPerson, anchor: HTMLElement) => void;
  onPersonMenu: (person: CardPerson, event: MouseEvent<HTMLElement>) => void;
  onWatch: (person: CardPerson) => void;
  onMore: () => void;
  /** "Open the call" or "See who is here": what the overflow row does. */
  moreLabel: string;
}

export function PeopleRows({
  rows,
  overflow,
  heard,
  animate,
  noEnterFor,
  onOpenPerson,
  onPersonMenu,
  onWatch,
  onMore,
  moreLabel,
}: PeopleRowsProps) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const elements = useRef(new Map<string, HTMLLIElement>());
  const [shown, setShown] = useState<Shown[]>(() => rows.map((person) => ({ person, leaving: false })));
  const [seenRows, setSeenRows] = useState(rows);
  if (seenRows !== rows) {
    setSeenRows(rows);
    setShown((previous) => mergeRows(previous, rows));
  }

  // Arrivals: what was not drawn last commit.
  const drawn = useRef<Set<string> | null>(null);
  const exiting = useRef(new Map<string, { dispose: () => void; animation: Animation | null }>());
  const pendingClose = useRef<{ height: number; below: Element[] } | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    const previous = drawn.current;
    drawn.current = new Set(shown.filter((entry) => !entry.leaving).map((entry) => entry.person.userId));
    if (!list) return;

    // A row that went has been removed: close the gap it left.
    const close = pendingClose.current;
    pendingClose.current = null;
    if (close && animate()) playPush(close.below.filter((element) => element.isConnected), -close.height, PUSH_UP_MS);

    if (!previous || !animate()) return;
    for (const entry of shown) {
      if (entry.leaving || previous.has(entry.person.userId) || entry.person.userId === noEnterFor) continue;
      const row = elements.current.get(entry.person.userId);
      if (!row) continue;
      playEnter(row, 'row');
      playPush(after(row, list.parentElement), row.offsetHeight + ROW_GAP, ROW_IN_MS);
    }
  });

  // Departures: play the exit, then remove the row and remember what to close up.
  useLayoutEffect(() => {
    for (const entry of shown) {
      const running = exiting.current.get(entry.person.userId);
      // Back before the exit finished: stop it and show the row again.
      if (!entry.leaving && running) {
        running.dispose();
        running.animation?.cancel();
        exiting.current.delete(entry.person.userId);
        continue;
      }
      if (!entry.leaving || running) continue;
      const userId = entry.person.userId;
      const row = elements.current.get(userId) ?? null;
      const remove = () => {
        exiting.current.delete(userId);
        const list = listRef.current;
        const element = elements.current.get(userId);
        if (list && element?.isConnected) {
          pendingClose.current = {
            height: element.offsetHeight + ROW_GAP,
            below: after(element, list.parentElement),
          };
        }
        setShown((all) => all.filter((item) => !(item.leaving && item.person.userId === userId)));
      };
      const animation = animate() ? playLeave(row, 'row') : null;
      const record = { dispose: () => {}, animation };
      exiting.current.set(userId, record);
      record.dispose = onSettle([animation], remove);
    }
  }, [shown, animate]);

  useLayoutEffect(
    () => () => {
      for (const { dispose } of exiting.current.values()) dispose();
      exiting.current.clear();
    },
    [],
  );

  return (
    <ul ref={listRef} className="ix-card-rows" aria-label="People here">
      {shown.map(({ person, leaving }) => (
        <li
          key={person.userId}
          ref={(element) => {
            if (element) elements.current.set(person.userId, element);
            else elements.current.delete(person.userId);
          }}
          className="ix-card-row"
          data-user-id={person.userId}
          data-self={person.self ? 'true' : undefined}
          data-talking={person.talking ? 'true' : 'false'}
          data-listening={person.listening ? 'true' : undefined}
          data-leaving={leaving ? 'true' : undefined}
          aria-hidden={leaving ? true : undefined}
        >
          <button
            type="button"
            className="ix-card-row__who"
            tabIndex={leaving ? -1 : undefined}
            aria-label={describe(person)}
            onClick={(event) => onOpenPerson(person, event.currentTarget)}
            onContextMenu={(event) => onPersonMenu(person, event)}
          >
            <span className="ix-card-row__face">
              <Avatar userId={person.userId} name={person.faceName} avatar={person.avatar} size={24} />
              <span className="ix-card-row__ring" aria-hidden="true" />
            </span>
            <span className="ix-card-row__name">{rowName(person)}</span>
          </button>
          <Trailing person={person} heard={heard} onWatch={onWatch} leaving={leaving} />
        </li>
      ))}
      {overflow && (
        <li className="ix-card-row ix-card-row--more">
          <button type="button" className="ix-card-row__who" onClick={onMore} aria-label={`And ${overflow.count} more. ${moreLabel}`}>
            <AvatarStack people={overflow.faces.map((person) => ({ userId: person.userId, name: person.faceName, avatar: person.avatar }))} size={24} ring="var(--ix-room-dark)" />
            <span className="ix-card-row__name">and {overflow.count} more</span>
          </button>
        </li>
      )}
    </ul>
  );
}

/** What a screen reader hears for a row: "Vincent, sharing a screen, talking". */
function describe(person: CardPerson): string {
  const parts = [person.name];
  if (person.listening) parts.push('listening in');
  if (person.sharing) parts.push('sharing a screen');
  if (person.talking) parts.push('talking');
  else if (person.muted && !person.listening) parts.push('muted');
  return parts.join(', ');
}

function Trailing({
  person,
  heard,
  onWatch,
  leaving,
}: {
  person: CardPerson;
  heard: boolean;
  onWatch: (person: CardPerson) => void;
  leaving: boolean;
}) {
  // Somebody else's screen: a button that opens it (index-spec §7.3).
  if (person.sharing && !person.self) {
    return (
      <button
        type="button"
        className={cn('ix-card-row__mark', 'ix-card-row__watch')}
        aria-label={`Watch ${person.name}'s screen`}
        title={`Watch ${person.name}'s screen`}
        tabIndex={leaving ? -1 : undefined}
        onClick={() => onWatch(person)}
      >
        <IxGlyph name="screen" size={14} />
      </button>
    );
  }
  if (person.sharing) {
    return (
      <span className="ix-card-row__mark" title="Sharing your screen">
        <IxGlyph name="screen" size={14} />
      </span>
    );
  }
  if (person.talking) return <Wave userId={person.userId} real={heard} className="ix-card-row__wave" />;
  if (person.muted && !person.listening) {
    return (
      <span className="ix-card-row__mark" title="Muted">
        <IxGlyph name="micOff" size={14} />
      </span>
    );
  }
  return null;
}
