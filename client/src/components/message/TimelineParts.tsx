import * as React from 'react';

import { Avatar, AvatarStack } from '../ix/identity';
import { GlyphFrame, IxGlyph } from '../ix/glyphs';
import { cn } from '../../lib/utils';
import { clockTime, timeDividerParts } from './timelineRows';

/**
 * The small shapes of the Index timeline (docs/index-spec.md §3.1, §4.11).
 *
 * Presentational only: the recipes are in `styles/ix-timeline.css`. No store
 * reads and no product decisions; `MessageList` owns those and hands these
 * components what to draw. Each row-level part renders ONE element (the row the
 * virtual list positions), so the send flight's "make room" measures and moves
 * that element.
 */

/** A message's own clock face: "9:41 PM" in the locale's own form. */
export function timelineTime(iso: string): string {
  return clockTime(iso) || iso;
}

/**
 * A person's face in the timeline: the Index avatar (§2.3). Kept under this
 * name for the who-reacted list (`ReactionPeople`), which draws the same face.
 */
export function TimelineAvatar({
  userId,
  name,
  avatar,
  size = 30,
  className,
}: {
  userId: string;
  name: string;
  avatar?: string | null;
  size?: number;
  className?: string;
}) {
  return <Avatar userId={userId} name={name} avatar={avatar ?? null} size={size} className={className} />;
}

/** "**Today** 9:41 PM", centered (§3.1 time divider). */
export function TimeDivider({ at, nowMs }: { at: string; nowMs?: number }) {
  const { day, time } = timeDividerParts(at, nowMs);
  const label = [day, time].filter(Boolean).join(' ');
  return (
    <div className="ix-tl-divider ix-tl-col" role="separator" aria-label={label}>
      <span aria-hidden>
        {day && <b>{day}</b>} {time}
      </span>
    </div>
  );
}

/**
 * The New divider (§4.11): hairlines either side of "New" in white and "Mark
 * read" at the right. It sits above the first message you had not read.
 */
export const NewDivider = React.forwardRef<HTMLDivElement, { onMarkRead: () => void }>(function NewDivider(
  { onMarkRead },
  ref,
) {
  return (
    <div ref={ref} className="ix-tl-new ix-tl-col" role="group" aria-label="New messages" data-testid="new-divider">
      <span className="ix-tl-new__rule" aria-hidden />
      <span className="ix-tl-new__label">New</span>
      <span className="ix-tl-new__rule" aria-hidden />
      <button type="button" className="ix-tl-new__mark" onClick={onMarkRead}>
        Mark read
      </button>
    </div>
  );
});

/* ---- Glyphs the timeline draws that the Index set does not have ---------------------- */

function PinGlyph({ size = 14 }: { size?: number }) {
  return (
    <GlyphFrame size={size}>
      <path d="M15 3 21 9M18 6l-5.5 5.5M9.5 8.5l6 6M7 11l6 6M10 14l-6 6" />
    </GlyphFrame>
  );
}

function ThreadGlyph({ size = 15 }: { size?: number }) {
  return (
    <GlyphFrame size={size}>
      <path d="M5 5h14v9h-7l-4 4v-4H5z" />
      <path d="M9 9.5h6" />
    </GlyphFrame>
  );
}

function ReactGlyph({ size = 15 }: { size?: number }) {
  return (
    <GlyphFrame size={size}>
      <path d="M20 12.5A8.5 8.5 0 1 1 11.5 4" />
      <path d="M8.5 14a4.5 4.5 0 0 0 7 0M9 10h.01M14.5 10h.01M18 3v5M15.5 5.5h5" />
    </GlyphFrame>
  );
}

function ReplyGlyph({ size = 15 }: { size?: number }) {
  return (
    <GlyphFrame size={size}>
      <path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v3" />
    </GlyphFrame>
  );
}

export type SystemGlyph = 'voice' | 'call' | 'pin' | 'person' | 'thread' | 'info';

function systemGlyph(kind: SystemGlyph) {
  switch (kind) {
    case 'voice':
      return <IxGlyph name="speaker" size={14} />;
    case 'call':
      return <IxGlyph name="phone" size={14} />;
    case 'pin':
      return <PinGlyph size={14} />;
    case 'person':
      return <IxGlyph name="invite" size={14} />;
    case 'thread':
      return <ThreadGlyph size={14} />;
    default:
      return <IxGlyph name="hello" size={14} />;
  }
}

/**
 * A line about the conversation, not a bubble (§3.1): centered, 13 ink-3, a
 * 14px glyph (amber for voice). "You joined General", "Nick pinned a message".
 */
export const SystemLine = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { glyph: SystemGlyph; text: string; time?: string | null }
>(function SystemLine({ glyph, text, time, className, ...rest }, ref) {
  return (
    <div ref={ref} className={cn('ix-tl-system ix-tl-col', className)} data-glyph={glyph} {...rest}>
      <span className="ix-tl-system__glyph" aria-hidden>
        {systemGlyph(glyph)}
      </span>
      <span>{text}</span>
      {time && <time className="ix-tl-system__time">{time}</time>}
    </div>
  );
});

/**
 * The action capsule (§4.11): react, reply, thread, more, at the bubble's top
 * trailing corner on hover or focus. 28×26 each on a near-solid capsule.
 */
export function MessageActions({
  authorName,
  onReact,
  onReply,
  onThread,
  threadLabel = 'Start a thread',
  onMore,
  moreExpanded,
}: {
  authorName: string;
  onReact?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onReply?: () => void;
  onThread?: () => void;
  threadLabel?: string;
  onMore: (event: React.MouseEvent<HTMLButtonElement>) => void;
  moreExpanded: boolean;
}) {
  return (
    <span className="ix-capsule" role="toolbar" aria-label={`Actions for ${authorName}’s message`}>
      {onReact && (
        <button type="button" className="ix-capsule__btn" aria-label={`React to ${authorName}`} title="React" onClick={onReact}>
          <ReactGlyph />
        </button>
      )}
      {onReply && (
        <button type="button" className="ix-capsule__btn" aria-label={`Reply to ${authorName}`} title="Reply" onClick={onReply}>
          <ReplyGlyph />
        </button>
      )}
      {onThread && (
        <button type="button" className="ix-capsule__btn" aria-label={threadLabel} title={threadLabel} onClick={onThread}>
          <ThreadGlyph />
        </button>
      )}
      <button
        type="button"
        className="ix-capsule__btn"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={moreExpanded}
        title="More"
        onClick={onMore}
      >
        <IxGlyph name="dots" size={15} />
      </button>
    </span>
  );
}

/** Three dots in a bubble (§4.11). They tick only while the row is on screen. */
export function TypingBubble() {
  return (
    <span className="ix-typing__bubble" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}

/**
 * The sentence the typing bubble stands for: "Eric is typing", "Eric and Nick
 * are typing", "4 people are typing".
 */
export function typingSentence(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]} are typing`;
  return `${names.length} people are typing`;
}

export interface Typist {
  id: string;
  name: string;
  avatar: string | null;
}

/**
 * Someone typing (§4.11): the dots beside the typist's 30px face at the bottom;
 * two or more: their faces overlapped and "Nick and Maya are typing".
 */
export const TypingRow = React.forwardRef<HTMLDivElement, { typists: readonly Typist[] }>(function TypingRow(
  { typists },
  ref,
) {
  const visibleRef = React.useRef<HTMLDivElement | null>(null);
  // The dots tick only while the row is on screen (§4.11).
  React.useEffect(() => {
    const node = visibleRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      node?.setAttribute('data-visible', '');
      return undefined;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) node.setAttribute('data-visible', '');
      else node.removeAttribute('data-visible');
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const sentence = typingSentence(typists.map((typist) => typist.name));
  const many = typists.length > 1;
  return (
    <div
      ref={(node) => {
        visibleRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      className="glass-tl-typing-row ix-typing ix-tl-col"
      data-many={many || undefined}
    >
      <span className="ix-typing__faces" aria-hidden>
        {many ? (
          <AvatarStack
            people={typists.slice(0, 3).map((typist) => ({ userId: typist.id, name: typist.name, avatar: typist.avatar }))}
            size={30}
            overlap={10}
            ring="var(--ix-main)"
          />
        ) : typists[0] ? (
          <Avatar userId={typists[0].id} name={typists[0].name} avatar={typists[0].avatar} size={30} />
        ) : null}
      </span>
      <span className="glass-msg__typing ix-typing__line">
        <TypingBubble />
        {many && <span className="ix-typing__words" aria-hidden>{sentence}</span>}
      </span>
      <span className="sr-only">{sentence}</span>
    </div>
  );
});

/**
 * A reply's quoted line, above its bubble (§4.11): "↩ Jeremy: who's up for…",
 * 13px ink-3, one line. Pressing it jumps to the original. `.glass-tl-reply` is
 * the send flight's hook: the ghost carries a picture of it.
 */
export function ReplyLine({ author, preview, onJump }: { author: string; preview: string; onJump: () => void }) {
  return (
    <button
      type="button"
      onClick={onJump}
      aria-label={`Reply to ${author}: ${preview}. Jump to the original message`}
      title="Jump to the original message"
      className="glass-tl-reply ix-reply"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="ix-reply__glyph">
        <path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v3" />
      </svg>
      <span className="ix-reply__text">
        <span className="ix-reply__author">{author}:</span> {preview}
      </span>
    </button>
  );
}

/** Under a thread's starter: "3 replies · 9:41 PM" (§4.11). Opens the thread. */
export function ThreadLine({
  name,
  replies,
  time,
  archived,
  onOpen,
}: {
  name: string;
  replies: number | null;
  time: string | null;
  archived?: boolean;
  onOpen: () => void;
}) {
  const count = replies == null ? 'Thread' : `${replies} ${replies === 1 ? 'reply' : 'replies'}`;
  const words = [count, time, archived ? 'archived' : null].filter(Boolean).join(' · ');
  return (
    <button type="button" className="ix-thread-line" onClick={onOpen} aria-label={`${name}: ${words}. Open thread`}>
      <ThreadGlyph size={14} />
      <span>{words}</span>
    </button>
  );
}

/** Three static skeleton bubbles (§4.11: no shimmer), where history is still to come. */
export const HistorySkeleton = React.forwardRef<HTMLDivElement, { label?: string }>(function HistorySkeleton(
  { label = 'Loading older messages' },
  ref,
) {
  return (
    <div ref={ref} className="ix-tl-skeleton ix-tl-col" role="status" aria-label={label}>
      {[208, 296, 148].map((width, index) => (
        <span key={index} className="ix-tl-skeleton__row" data-first={index === 0 || undefined}>
          <span className="ix-tl-skeleton__face" aria-hidden />
          <span className="ix-tl-skeleton__bubble" style={{ width }} aria-hidden />
        </span>
      ))}
    </div>
  );
});

/** "Encrypted message": a bubble this device cannot read (§8.4). */
export function EncryptedBubbleText() {
  return (
    <span className="ix-encrypted">
      <IxGlyph name="lock" size={14} />
      <span>Encrypted message</span>
    </span>
  );
}

/**
 * The jump-to-latest capsule (§4.11): above the message box when you are more
 * than a screen up, "↓ 12 new" or "↓ Latest".
 */
export function JumpToLatest({ count, onJump }: { count: number; onJump: () => void }) {
  const label = count > 0 ? `${count} new` : 'Latest';
  return (
    <button
      type="button"
      className="ix-jump"
      onClick={onJump}
      aria-label={count > 0 ? `Jump to the ${count} new message${count === 1 ? '' : 's'}` : 'Jump to the latest message'}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 5v14M6 13l6 6 6-6" />
      </svg>
      <span>{label}</span>
    </button>
  );
}
