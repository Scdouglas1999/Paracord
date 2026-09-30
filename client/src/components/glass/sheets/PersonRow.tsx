import type { MouseEvent, ReactNode } from 'react';
import { Face } from '../places/Lead';
import { cn } from '../../../lib/utils';

/**
 * Presence as ink, never color (plan §7): a dot (online), a ring (away), a dot
 * with a bar (do not disturb), a faint ring (offline). Its word is always in
 * the row too, so the mark is never the only cue (§9).
 */
export type PersonStatus = 'online' | 'idle' | 'dnd' | 'offline';

export interface PersonRowProps {
  userId: string;
  name: string;
  avatar: string | null;
  /** This person is you: the row says so after your name (the face still draws your initials). */
  you?: boolean;
  status: PersonStatus;
  /** The line under the name: an activity, a custom status, the room, or the word. */
  detail: ReactNode;
  /** They are in a live voice channel: the detail reads in amber. */
  live?: boolean;
  /** Opens the person (their profile). Omit for a row that only informs. */
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
        <Face face={{ userId, name, avatar }} size={40} />
        <span className="glass-sheet-presence" data-status={status} />
      </span>
      <span className="glass-sheet-row__text">
        <span className="glass-sheet-row__name">{you ? `${name} (you)` : name}</span>
        {/* Read as one phrase: "Vincent, In Lounge". */}
        <span className="sr-only">, </span>
        <span className={cn('glass-sheet-row__detail', live && 'glass-sheet-live')}>
          {live && <span className="glass-chip__dot" aria-hidden />}
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
