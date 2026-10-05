import { useEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { extractApiError } from '../../api/client';
import { reactionUsersApi, type ReactionPerson } from '../../api/reminders';
import { reactionTitle } from '../../lib/reactionPeople';
import { Popover } from '../ui/Popover';
import { Chip } from '../ui';
import { RollingNumber } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { TimelineAvatar } from './TimelineParts';

/** People shown before "and N more". */
const PREVIEW = 12;
/** How long a pointer rests on a chip before the list opens. */
const HOVER_DELAY_MS = 400;
/** Grace period for crossing the gap between the chip and the popover. */
const LEAVE_GRACE_MS = 160;

function personName(person: ReactionPerson): string {
  return person.display_name?.trim() || person.username;
}

export interface ReactionPeopleState {
  open: boolean;
  expanded: boolean;
  people: ReactionPerson[] | null;
  error: string | null;
  /** What the reaction says when you rest on it: "Brendan and nick reacted with ...". */
  title: string;
  close: () => void;
  cancelClose: () => void;
  scheduleClose: () => void;
  expand: () => void;
  /** Spread these on the element that wraps the reaction's button and its list. */
  triggerProps: {
    onPointerEnter: (event: PointerEvent) => void;
    onPointerLeave: (event: PointerEvent) => void;
    onPointerDown: (event: PointerEvent) => void;
    onPointerUp: (event: PointerEvent) => void;
    onPointerCancel: () => void;
    onContextMenu: (event: React.MouseEvent) => void;
  };
  /**
   * True exactly once after a long press opened the list: the click that ends
   * the press must not toggle the reaction as well.
   */
  consumeSuppressedClick: () => boolean;
}

/**
 * The "who reacted" behavior of one reaction, shared by the feed's chips
 * ({@link ReactionChip}) and the timeline's (`ReactionBite`). Resting on the
 * reaction (or a long press on touch) opens a short list; right-clicking opens
 * the whole list; clicking is the caller's (it toggles your own reaction).
 */
export function useReactionPeople({
  channelId,
  messageId,
  emoji,
  count,
}: {
  channelId: string;
  messageId: string;
  emoji: string;
  count: number;
}): ReactionPeopleState {
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [people, setPeople] = useState<ReactionPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A new tally means the list we have is stale.
  const [listedFor, setListedFor] = useState(count);
  if (listedFor !== count) {
    setListedFor(count);
    setPeople(null);
    setError(null);
  }

  useEffect(() => () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  const cancelOpen = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
  };
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const close = () => {
    cancelOpen();
    cancelClose();
    setOpen(false);
    setExpanded(false);
  };
  /** A hover-opened list closes when the pointer leaves; a right-click list stays. */
  const scheduleClose = () => {
    cancelOpen();
    if (!open || expanded) return;
    cancelClose();
    closeTimer.current = setTimeout(close, LEAVE_GRACE_MS);
  };

  const load = async () => {
    try {
      const { data } = await reactionUsersApi.list(channelId, messageId, emoji, 100);
      setPeople(data);
      setError(null);
    } catch (err) {
      setError(extractApiError(err));
    }
  };
  const show = (full: boolean) => {
    cancelClose();
    setExpanded(full);
    setOpen(true);
    if (!people) void load();
  };

  const title = error
    ? error
    : reactionTitle((people ?? []).slice(0, 2).map(personName), people?.length ?? count, emoji);

  return {
    open,
    expanded,
    people,
    error,
    title,
    close,
    cancelClose,
    scheduleClose,
    expand: () => setExpanded(true),
    triggerProps: {
      onPointerEnter: (event) => {
        if (event.pointerType === 'touch') return;
        cancelClose();
        if (open) return;
        cancelOpen();
        openTimer.current = setTimeout(() => show(false), HOVER_DELAY_MS);
      },
      onPointerLeave: (event) => {
        if (event.pointerType === 'touch') return;
        scheduleClose();
      },
      onPointerDown: (event) => {
        if (event.pointerType !== 'touch') return;
        cancelOpen();
        openTimer.current = setTimeout(() => {
          suppressClick.current = true;
          show(false);
        }, HOVER_DELAY_MS);
      },
      onPointerUp: (event) => {
        if (event.pointerType === 'touch') cancelOpen();
      },
      onPointerCancel: cancelOpen,
      onContextMenu: (event) => {
        event.preventDefault();
        event.stopPropagation();
        show(true);
      },
    },
    consumeSuppressedClick: () => {
      if (!suppressClick.current) return false;
      suppressClick.current = false;
      return true;
    },
  };
}

/**
 * The list a reaction opens (docs/index-spec.md §6.11, the menu look): its glyph
 * and how many, then the people (24px faces and names, the timeline's own
 * avatars), "and N more" while it is the short list.
 */
export function ReactionPeopleList({
  state,
  anchor,
  emoji,
  count,
  glyph,
}: {
  state: ReactionPeopleState;
  /** The element the list opens against: the reaction itself. */
  anchor: RefObject<HTMLSpanElement | null>;
  emoji: string;
  count: number;
  /** The reaction drawn large: an emoji, a custom emoji's picture or a line mark. */
  glyph: ReactNode;
}) {
  const { open, expanded, people, error, close, cancelClose, scheduleClose } = state;
  const visible = expanded ? people ?? [] : (people ?? []).slice(0, PREVIEW);
  const hidden = Math.max(0, (people?.length ?? 0) - PREVIEW);
  return (
    <Popover
      anchor={anchor}
      open={open}
      onClose={close}
      side="top"
      align="start"
      label={`People who reacted with ${emoji}`}
      className="ix-rp-pop w-60 p-0"
    >
      <div onPointerEnter={cancelClose} onPointerLeave={scheduleClose} className="ix-rp">
        <div className="ix-rp__head">
          <span className="ix-rp__glyph" aria-hidden>
            {glyph}
          </span>
          <span className="ix-rp__count">
            {people ? (people.length === 1 ? '1 person' : `${people.length} people`) : `${count} ${count === 1 ? 'person' : 'people'}`}
          </span>
        </div>
        {error && <p role="alert" className="ix-rp__note" data-tone="error">{error}</p>}
        {!error && !people && <p className="ix-rp__note">Loading who reacted…</p>}
        {people && (
          <ul className="ix-rp__list" data-expanded={expanded || undefined}>
            {visible.map((person) => (
              <li key={person.id} className="ix-rp__person">
                <TimelineAvatar userId={person.id} name={personName(person)} avatar={person.avatar_hash} size={24} />
                <span className="ix-rp__name">{personName(person)}</span>
              </li>
            ))}
          </ul>
        )}
        {!expanded && hidden > 0 && (
          <button type="button" className="ix-rp__more" onClick={state.expand}>
            and {hidden} more
          </button>
        )}
      </div>
    </Popover>
  );
}

/**
 * A reaction chip that can say who reacted. Resting on it (or a long press on
 * touch) opens a short list; right-clicking opens the whole list. Clicking
 * still toggles your own reaction.
 */
export function ReactionChip({
  emoji,
  count,
  me,
  glyph,
  channelId,
  messageId,
  onToggle,
}: {
  emoji: string;
  count: number;
  me: boolean;
  glyph: ReactNode;
  channelId: string;
  messageId: string;
  onToggle: () => void;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const state = useReactionPeople({ channelId, messageId, emoji, count });

  return (
    <span
      ref={anchorRef}
      data-flip-key={emoji}
      data-flip-own={me || undefined}
      className="inline-flex"
      {...state.triggerProps}
    >
      <Chip
        as="button"
        title={state.title}
        onClick={() => {
          if (state.consumeSuppressedClick()) return;
          onToggle();
        }}
        className={cn(
          'gap-1.5 px-2.5',
          me && 'bg-accent-tint text-accent-primary shadow-none hover:bg-accent-tint-strong hover:text-accent-primary',
        )}
      >
        <span data-flip-glyph>{glyph}</span>
        <span className="font-medium">
          <RollingNumber value={count} announce={false} />
        </span>
      </Chip>
      <ReactionPeopleList state={state} anchor={anchorRef} emoji={emoji} count={count} glyph={glyph} />
    </span>
  );
}
