import * as React from 'react';

import { Chip } from '../../ui';
import { AvatarStack } from '../../light';
import { readingCaption, type RoomLight } from '../../../lib/attention/light';
import { cn } from '../../../lib/utils';
import { lastAuthorCaption, mentionCaption } from './lobbyCaptions';

export interface TextRoomRowProps {
  room: RoomLight;
  /** This is the room the client currently has open — the row is raised. */
  active?: boolean;
  /** Unread traffic the reader has not seen. */
  unread?: boolean;
  mentionCount?: number;
  /** Who wrote last, when we have loaded the room's timeline. */
  lastAuthor?: string | null;
  /** The stamp on that last line — "10:02", "yesterday", "Tue". */
  lastAt?: string | null;
  /** The last line itself. Absent for a room this client has never opened. */
  preview?: string | null;
  onOpen: () => void;
}

/**
 * TextRoomRow — a text room is a row, never a card
 * (docs/lantern-stage-spec.md §6.8, §7.3, §8: grid `22px 1fr auto`).
 *
 * The window dot is amber when somebody is reading and dark when nobody is, and
 * the reader stack and "5 reading" say the same thing in words (§9). The preview
 * is whatever this client has actually loaded — an unopened room shows its name
 * and nothing else rather than a guessed last line.
 */
export const TextRoomRow = React.forwardRef<HTMLButtonElement, TextRoomRowProps>(
  function TextRoomRow(
    { room, active = false, unread = false, mentionCount = 0, lastAuthor, lastAt, preview, onOpen },
    ref,
  ) {
    const readers = room.readers.map((reader) => reader.person);
    const mentions = mentionCaption(mentionCount);
    const byline = lastAuthorCaption(lastAuthor, lastAt);

    return (
      <button
        ref={ref}
        type="button"
        onClick={onOpen}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'pc-focusable grid w-full grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-x-3',
          'rounded-[var(--radius-well)] px-3 py-2.5 text-left',
          'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]',
          active
            ? 'bg-bg-raised shadow-[var(--shadow-raised)]'
            : 'hover:bg-bg-mod-subtle',
        )}
      >
        <span
          aria-hidden
          className={cn('pc-window h-2.5 w-2.5', room.lit && 'is-reading')}
        />

        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                'pc-display truncate text-name',
                room.lit || unread ? 'text-text-primary' : 'text-text-secondary',
              )}
            >
              {room.name}
            </span>
            {byline && <span className="shrink-0 truncate text-meta text-text-faint">{byline}</span>}
          </span>
          {preview && (
            <span
              className={cn(
                'truncate text-ribbon',
                room.lit || unread ? 'text-text-secondary' : 'text-text-muted',
              )}
            >
              {preview}
            </span>
          )}
        </span>

        <span className="flex shrink-0 items-center gap-2">
          {readers.length > 0 && (
            <AvatarStack
              people={readers}
              size={20}
              max={3}
              context={`reading ${room.name}`}
            />
          )}
          {room.lit && (
            <span className="text-meta text-text-faint">{readingCaption(room.readingCount)}</span>
          )}
          {mentions && <Chip tone="accent">{mentions}</Chip>}
          {!mentions && unread && (
            <>
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full bg-accent-primary"
              />
              <span className="sr-only">Unread</span>
            </>
          )}
        </span>
      </button>
    );
  },
);
