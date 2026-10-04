import type { MouseEvent, ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import { IxGlyph } from '../../ix/glyphs';
import { Avatar } from '../../ix/identity';

/**
 * A person in a sheet (the people sheet, a group's recipients): their avatar with
 * the presence dot (docs/index-spec.md §2.3: online solid ink, idle the tertiary
 * ink, do not disturb a hollow ring, offline none), their name, and a line under
 * it (an activity, the words they set, the room they are in, or the word for how
 * they are here). The state is always said in words too, so the dot is never the
 * only cue (§10).
 */
export type PersonStatus = 'online' | 'idle' | 'dnd' | 'offline';

export interface PersonRowProps {
  userId: string;
  name: string;
  avatar: string | null;
  /** This person is you: the row says so after your name. */
  you?: boolean;
  status: PersonStatus;
  /** The line under the name: an activity, a custom status, the room, or the word. */
  detail: ReactNode;
  /** They are in a live voice channel: the detail reads in amber, with the room glyph. */
  live?: boolean;
  /** Opens the person (their profile card). Omit for a row that only informs. */
  onOpen?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** A control of the row's own (remove from a group), shown on hover and focus. */
  trailing?: ReactNode;
  className?: string;
}

export function PersonRow({
  userId,
  name,
  avatar,
  you = false,
  status,
  detail,
  live = false,
  onOpen,
  trailing,
  className,
}: PersonRowProps) {
  const body = (
    <>
      <span className="glass-sheet-face" aria-hidden>
        <Avatar userId={userId} name={name} avatar={avatar} size={38} presence={status} ring="var(--ix-pop-solid)" />
      </span>
      <span className="glass-sheet-row__text">
        <span className="glass-sheet-row__name">{you ? `${name} (you)` : name}</span>
        {/* Read as one phrase: "Vincent, In Lounge". */}
        <span className="sr-only">, </span>
        <span className={cn('glass-sheet-row__detail', live && 'glass-sheet-live')}>
          {live && <IxGlyph name="speaker" size={13} />}
          {detail}
        </span>
      </span>
    </>
  );

  return (
    <li className={cn('glass-sheet-row glass-person', className)} data-status={status}>
      {onOpen ? (
        <button
          type="button"
          className="glass-person__open glass-focusable"
          onClick={onOpen}
          // Named by what it shows (their name and what they are doing); it opens their profile.
          aria-haspopup="dialog"
        >
          {body}
        </button>
      ) : (
        <div className="glass-person__open">{body}</div>
      )}
      {trailing}
    </li>
  );
}
