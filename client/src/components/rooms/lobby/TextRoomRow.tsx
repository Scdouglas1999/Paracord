import * as React from 'react';
import { MoreHorizontal, Pin } from 'lucide-react';

import { Chip, IconButton } from '../../ui';
import { AvatarStack } from '../../light';
import { readingCaption, type RoomLight } from '../../../lib/attention/light';
import { cn } from '../../../lib/utils';
import { NOTHING_SAID_YET, lastAuthorCaption, mentionCaption } from './lobbyCaptions';

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
  /**
   * Nobody has written in this room yet — there is no author, no line and no
   * stamp to show, and three blanks read as a row that failed to load.
   */
  silent?: boolean;
  /** The building's operator pinned this room, so it sorts first and says so. */
  featured?: boolean;
  onOpen: () => void;
  /**
   * Open the room menu — notification level, mark as read, copy link (§7.1).
   *
   * Wired to three gestures, because this row is a phone's only door to them:
   * right-click, the `contextmenu` Chromium raises after a long touch press,
   * and the "…" control, which is the only one a first-time reader can see.
   */
  onMenu?: (event: React.MouseEvent<HTMLElement>) => void;
}

/**
 * TextRoomRow — a text room is a row, never a card
 * (docs/lantern-stage-spec.md §6.8, §7.3, §8: grid `22px 1fr auto`).
 *
 * The window dot is amber when somebody is reading and dark when nobody is, and
 * the reader stack and "5 reading" say the same thing in words (§9). The preview
 * is whatever this client has actually loaded — an unopened room shows its name
 * and nothing else rather than a guessed last line.
 *
 * A featured room — one the building's operator pinned in its hub settings —
 * sorts first and carries a small pin. It is not a badge and spends no light
 * token (§6.3): being chosen by an operator is not somebody being present.
 */
export const TextRoomRow = React.forwardRef<HTMLButtonElement, TextRoomRowProps>(
  function TextRoomRow(
    {
      room,
      active = false,
      unread = false,
      mentionCount = 0,
      lastAuthor,
      lastAt,
      preview,
      silent = false,
      featured = false,
      onOpen,
      onMenu,
    },
    ref,
  ) {
    const readers = room.readers.map((reader) => reader.person);
    const mentions = mentionCaption(mentionCount);
    const byline = silent ? NOTHING_SAID_YET : lastAuthorCaption(lastAuthor, lastAt);

    const row = (
      <button
        ref={ref}
        type="button"
        onClick={onOpen}
        onContextMenu={onMenu}
        aria-current={active ? 'page' : undefined}
        className={cn(
          // §9: the row is the biggest target on this surface and a thumb has
          // to be able to hit it. `pc-touch` carries the hit area to 44px on a
          // coarse pointer without changing the row's own density.
          'pc-touch pc-focusable grid w-full grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-x-3',
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
          {/* The room's NAME is what this row is for, so it is the last thing
              that gives way. Both halves could shrink and only the byline was
              pinned, so a long "author · time" squeezed "design-notes" down to
              "d" on a phone. The name keeps what it needs up to 70% of the row
              and the byline truncates into whatever is left. */}
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                'pc-display max-w-[70%] shrink-0 truncate text-name',
                room.lit || unread ? 'text-text-primary' : 'text-text-secondary',
              )}
            >
              {room.name}
            </span>
            {featured && (
              <>
                <Pin size={12} aria-hidden className="shrink-0 text-text-faint" />
                <span className="sr-only">Featured by this server</span>
              </>
            )}
            {byline && <span className="min-w-0 truncate text-meta text-text-faint">{byline}</span>}
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

    if (!onMenu) return row;
    // The menu control is a sibling, never a child: a button inside a button is
    // not a document, and the row is a button. `pc-touch` carries the "…" out to
    // a 44px hit area on a coarse pointer without growing its ink (§9).
    return (
      <div className="flex min-w-0 items-center gap-0.5">
        <span className="min-w-0 flex-1">{row}</span>
        <IconButton
          label={`Channel options for ${room.name}`}
          size="sm"
          className="pc-touch shrink-0"
          onClick={(event) => {
            event.stopPropagation();
            onMenu(event);
          }}
        >
          <MoreHorizontal size={16} aria-hidden />
        </IconButton>
      </div>
    );
  },
);
