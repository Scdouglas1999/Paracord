import * as React from 'react';

import { Chip } from '../ui';
import { AvatarStack, avatarInitials } from '../light';
import { cn } from '../../lib/utils';
import { getIdentityColor } from '../../lib/colors';
import { resolveUserAvatarUrl } from '../../lib/userAvatar';
import { useAuthenticatedImage } from '../../lib/authenticatedImage';
import { useDownloadTicket } from '../../hooks/useDownloadTicket';
import type { PersonLight } from '../../lib/attention/light';
import { roomSharedName } from '../../lib/motion';
import type { RoomLitEvent } from './messageLight';

/**
 * The small shapes of the Glass timeline (docs/glass-spec.md §3.2).
 *
 * Presentational only: tokens and the recipes in `styles/glass-timeline.css`.
 * No store reads and no product decisions — `MessageList` owns those and hands
 * these components what to draw.
 */

/**
 * The chip's words: "Today" and "Yesterday" where they are true, the full date
 * everywhere else.
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

/** Is this instant on the same calendar day as `nowMs`? */
export function isToday(iso: string, nowMs = Date.now()): boolean {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  return date.toDateString() === new Date(nowMs).toDateString();
}

/**
 * One formatter for every timeline clock. Building an `Intl.DateTimeFormat`
 * per call was a quarter of the JavaScript time in a 500-message scroll
 * profile (see `wallClock`), so it is made once.
 */
let timelineClock: Intl.DateTimeFormat | null = null;

/**
 * A message's own clock face: just the time, in the locale's own form
 * ("9:02 PM"). The day is stated by the divider above the message; the full
 * timestamp stays available as a title.
 */
export function timelineTime(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    timelineClock ??= new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
    return timelineClock.format(date);
  } catch {
    return iso;
  }
}

/** A day divider: a centered kicker ("TODAY", "MONDAY, SEPTEMBER 28"). */
export function DayDivider({ label }: { label: string }) {
  return (
    <div className="glass-tl-day glass-tl-col" role="separator" aria-label={label}>
      <span className="glass-kicker" aria-hidden>
        {label}
      </span>
    </div>
  );
}

/**
 * A face in the timeline (§3.2): 32px, the uploaded photo or the author's
 * initials on their identity color. Plain on purpose — the reference draws no
 * presence ring on timeline faces; what is live shows in the places panel and
 * the call pill.
 */
export function TimelineAvatar({
  userId,
  name,
  avatar,
  size = 32,
  className,
}: {
  userId: string;
  name: string;
  avatar?: string | null;
  size?: number;
  className?: string;
}) {
  // The avatar URL carries the download ticket, minted after the first paint.
  useDownloadTicket();
  const src = useAuthenticatedImage(resolveUserAvatarUrl(avatar ?? null));
  return (
    <span
      className={cn('glass-tl-avatar', className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.38)),
        background: src ? undefined : getIdentityColor(userId),
      }}
      aria-hidden
    >
      {src ? <img src={src} alt="" draggable={false} /> : avatarInitials(name)}
    </span>
  );
}

/* ---- Glyphs for the hover actions (the prototype's own, 15px, 1.7 stroke) -- */

function ActionGlyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const ReactGlyph = () => (
  <ActionGlyph>
    <path d="M20 12.5A8.5 8.5 0 1 1 11.5 4" />
    <path d="M8.5 14a4.5 4.5 0 0 0 7 0M9 10h.01M14.5 10h.01M18 3v5M15.5 5.5h5" />
  </ActionGlyph>
);

const ReplyGlyph = () => (
  <ActionGlyph>
    <path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v3" />
  </ActionGlyph>
);

const MoreGlyph = () => (
  <ActionGlyph>
    <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth="2.6" />
  </ActionGlyph>
);

/**
 * React / reply / more, as 26×22 text buttons (§3.2). They sit beside the
 * name and time of a group, or beside the bubble of a message that has no
 * header (a continuation, or your own).
 */
export function MessageActions({
  authorName,
  time,
  onReact,
  onReply,
  onMore,
  moreExpanded,
}: {
  authorName: string;
  /** Shown before the buttons where the row has no header to carry its time. */
  time?: React.ReactNode;
  onReact?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onReply?: () => void;
  onMore: () => void;
  moreExpanded: boolean;
}) {
  return (
    <span className="glass-tl-acts">
      {time}
      {onReact && (
        <button type="button" className="glass-tl-act" aria-label={`React to ${authorName}`} title="React" onClick={onReact}>
          <ReactGlyph />
        </button>
      )}
      {onReply && (
        <button type="button" className="glass-tl-act" aria-label={`Reply to ${authorName}`} title="Reply" onClick={onReply}>
          <ReplyGlyph />
        </button>
      )}
      <button
        type="button"
        className="glass-tl-act"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={moreExpanded}
        title="More"
        onClick={onMore}
      >
        <MoreGlyph />
      </button>
    </span>
  );
}

/** Three dots in a bubble, beside the typist's face (§3.2). */
export function TypingBubble() {
  return (
    <span className="glass-tl-typing" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}

/**
 * The sentence the typing bubbles stand for, for assistive tech: "Eric is
 * typing", "Eric and Nick are typing", "4 people are typing".
 */
export function typingSentence(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]} are typing`;
  return `${names.length} people are typing`;
}

/**
 * The reply context at the top of a bubble: who is being answered and what
 * they said. Pressing it jumps to that message.
 */
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
      className="glass-tl-reply"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
        <path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v3" />
      </svg>
      <span className="glass-tl-reply__author">{author}</span>
      <span className="glass-tl-reply__preview">{preview}</span>
    </button>
  );
}

/**
 * A voice channel that went live while you were reading. A client-side
 * observation, never a server message: the row exists only while people are
 * in there, so the Join it offers always leads somewhere with people in it.
 * Amber, because amber means live (§1.3).
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
      className="glass-tl-event glass-tl-col"
    >
      <span className="glass-tl-event__dot" aria-hidden />
      <span className="min-w-0">
        {event.headline} <span aria-hidden>·</span> {event.detail}
      </span>
      <button
        type="button"
        onClick={(clicked) =>
          onJoin(event, clicked.currentTarget.closest('[data-motion-shared]'))
        }
        className="glass-tl-event__join"
      >
        Join
      </button>
    </div>
  );
}

/** A thread hanging off a message: faces, name, reply count, one action. */
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
    <button type="button" onClick={onOpen} className="glass-tl-thread">
      {people.length > 0 && <AvatarStack people={people} size={20} max={3} context={`in ${name}`} />}
      <span className="glass-tl-thread__name">{name}</span>
      <span className="glass-tl-thread__meta">{meta}</span>
      {archived && (
        <Chip size="sm" className="text-text-faint">
          Archived
        </Chip>
      )}
      <span className="glass-tl-thread__open">Open thread</span>
    </button>
  );
}

/**
 * The frame an attachment sits in, shaped like a bubble: radius 20 with the
 * group's joined corner on the author's side (`glass-timeline.css` reads the
 * row's side and `data-join-top`). Media restyling proper is WP-G13; this only
 * gives the frame its place in a group.
 */
export const AttachmentFrame = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { footer?: React.ReactNode; joinTop?: boolean }
>(function AttachmentFrame({ footer, joinTop, className, children, ...props }, ref) {
  return (
    <div
      ref={ref}
      data-join-top={joinTop || undefined}
      className={cn('glass-tl-media', className)}
      {...props}
    >
      {children}
      {footer && <div className="glass-tl-media__footer">{footer}</div>}
    </div>
  );
});
