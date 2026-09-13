import * as React from 'react';
import { CornerDownLeft } from 'lucide-react';

import { Chip } from '../ui';
import { AvatarStack } from '../light';
import { cn } from '../../lib/utils';
import type { PersonLight } from '../../lib/attention/light';
import { roomSharedName } from '../../lib/motion';
import type { RoomLitEvent } from './messageLight';

/**
 * The small shapes of a text-room timeline (docs/lantern-stage-spec.md §7.4).
 *
 * Presentational only: tokens, `pc-*` recipes and the WP0/WP1 primitives. No
 * store reads and no product decisions — `MessageList` owns those and hands
 * these components what to draw.
 *
 * The one rule they all keep is §9: every light state also says its words. A
 * window dot never stands alone.
 */

/** The 32px gutter the reference render puts on every timeline row. */
export const TIMELINE_GUTTER = 'px-4 sm:px-8';

/**
 * The chip's words: "Today" and "Yesterday" where they are true, the full date
 * everywhere else. The reference render says "Today", and a chip is too small
 * to carry "Monday, January 15, 2025" when one word will do.
 */
export function dayDividerLabel(iso: string, nowMs = Date.now()): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const now = new Date(nowMs);
    if (date.toDateString() === now.toDateString()) return 'Today';
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  } catch {
    return iso;
  }
}

/**
 * A message's own clock face: just the time.
 *
 * The day is already stated by the divider above the message, so repeating
 * "Today at" on every row is noise. The full timestamp stays available as the
 * row's title.
 */
export function timelineTime(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}

/**
 * A day divider: a chip on a hairline (§7.4). The rule is decoration, so it is
 * hidden from assistive tech and the chip carries the date.
 */
export function DayDivider({ label }: { label: string }) {
  return (
    <div className={cn('my-2.5 flex items-center gap-3', TIMELINE_GUTTER)}>
      <span className="h-px flex-1 bg-border-subtle" aria-hidden />
      <Chip size="sm" className="h-[22px] px-2.5 text-[11.5px] font-semibold">
        {label}
      </Chip>
      <span className="h-px flex-1 bg-border-subtle" aria-hidden />
    </div>
  );
}

/**
 * A message's meta line: "in Shop floor · 9:12 AM" when the author is in a
 * voice room right now, otherwise just the time (§7.4).
 *
 * The white dot is the room's light and it is never the only cue — "in Shop
 * floor" is the words that go with it.
 */
export function AuthorMeta({
  person,
  timestamp,
  title,
}: {
  person: PersonLight | null;
  timestamp: string;
  title?: string;
}) {
  const roomName = person?.live ? person.roomName : null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-meta text-text-faint" title={title}>
      {roomName ? (
        <>
          <span className="pc-window is-talking h-1.5 w-1.5 rounded-full" aria-hidden />
          <span className="truncate">in {roomName}</span>
          <span aria-hidden>·</span>
        </>
      ) : (
        // §9: the rim on the author's avatar is a light state, so it says its
        // words somewhere a screen reader can reach even when it has no room.
        person && <span className="sr-only">{person.label}</span>
      )}
      <span className="pc-mono shrink-0">{timestamp}</span>
    </span>
  );
}

/** The chip above a reply, naming who is being answered (§7.4). */
export function ReplyChip({
  author,
  preview,
  onJump,
}: {
  author: string;
  preview: string;
  onJump: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onJump}
      aria-label={`Jump to the message from ${author}`}
      title="Jump to replied message"
      className={cn(
        'pc-focusable mb-1 inline-flex h-6 max-w-[min(100%,460px)] items-center gap-1.5',
        'rounded-[var(--radius-chip)] bg-bg-raised px-2 shadow-[var(--shadow-chip)]',
        'text-meta text-text-muted transition-colors duration-[var(--duration-fast)]',
        'ease-[var(--ease-out)] hover:text-text-primary',
      )}
    >
      <CornerDownLeft size={13} aria-hidden className="shrink-0" />
      <span className="shrink-0 font-semibold text-text-body">{author}</span>
      <span className="min-w-0 truncate">{preview}</span>
    </button>
  );
}

/**
 * A room that lit up while you were reading — the light metaphor carried into
 * the timeline (§7.4).
 *
 * It is a client-side observation of WP1's room light, not a server message:
 * the row exists only while people are actually in there, so the Join it offers
 * always leads somewhere with people in it.
 */
export function RoomLitEventRow({
  event,
  onJoin,
}: {
  event: RoomLitEvent;
  onJoin: (event: RoomLitEvent, origin?: Element | null) => void;
}) {
  return (
    <div
      role="status"
      data-testid="room-lit-event"
      // Last in the arrival's path: it fades in behind the face that caused it.
      data-motion-event={event.channelId}
      data-motion-shared={roomSharedName(event.channelId)}
      className={cn(
        'flex flex-wrap items-center gap-x-2.5 gap-y-1 pt-2 text-meta text-text-faint',
        TIMELINE_GUTTER,
        'sm:pl-[82px]',
      )}
    >
      <span className="pc-window is-talking h-2 w-2 shrink-0" aria-hidden />
      <span className="min-w-0">
        {event.headline} <span aria-hidden>·</span> {event.detail}
      </span>
      <button
        type="button"
        onClick={(clicked) =>
          onJoin(event, clicked.currentTarget.closest('[data-motion-shared]'))
        }
        className="pc-focusable rounded-[var(--radius-chip)] px-1 font-semibold text-accent-primary hover:underline"
      >
        Join
      </button>
    </div>
  );
}

/** A thread hanging off a message: faces, name, reply count, one action (§7.4). */
export function ThreadRow({
  name,
  meta,
  people,
  archived,
  onOpen,
}: {
  name: string;
  meta: string;
  people: readonly PersonLight[];
  archived?: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'pc-focusable mt-2 inline-flex max-w-full flex-wrap items-center gap-x-3 gap-y-1',
        'rounded-[var(--radius-well)] bg-bg-raised px-3 py-2 text-left',
        'shadow-[var(--shadow-chip)] transition-colors duration-[var(--duration-fast)]',
        'ease-[var(--ease-out)] hover:bg-bg-mod-strong',
      )}
    >
      {people.length > 0 && <AvatarStack people={people} size={20} max={3} context={`in ${name}`} />}
      <span className="pc-display min-w-0 truncate text-name text-text-primary">{name}</span>
      <span className="text-meta text-text-faint">{meta}</span>
      {archived && (
        <Chip size="sm" className="text-text-faint">
          Archived
        </Chip>
      )}
      <span className="text-meta font-semibold text-accent-primary">Open thread</span>
    </button>
  );
}

/**
 * The frame an attachment sits in: a well with the file's own line beneath it
 * (§7.4). Used by the image, encrypted and generic attachment shapes so they
 * cannot drift apart.
 */
export const AttachmentFrame = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { footer?: React.ReactNode }
>(function AttachmentFrame({ footer, className, children, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        'mt-2 max-w-[min(100%,400px)] overflow-hidden rounded-[var(--radius-well)]',
        'bg-bg-well shadow-[var(--shadow-chip)]',
        className,
      )}
      {...props}
    >
      {children}
      {footer && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-meta text-text-muted">
          {footer}
        </div>
      )}
    </div>
  );
});
