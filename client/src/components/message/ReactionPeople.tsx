import { useEffect, useRef, useState, type ReactNode } from 'react';
import { extractApiError } from '../../api/client';
import { reactionUsersApi, type ReactionPerson } from '../../api/reminders';
import { reactionTitle } from '../../lib/reactionPeople';
import { personLight } from '../../lib/attention/personLight';
import { Popover } from '../ui/Popover';
import { LitAvatar } from '../light';
import { Chip } from '../ui';
import { RollingNumber } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { usePresenceStore } from '../../stores/presenceStore';

/** People shown before "and N more". */
const PREVIEW = 12;
/** How long a pointer rests on a chip before the list opens. */
const HOVER_DELAY_MS = 400;
/** Grace period for crossing the gap between the chip and the popover. */
const LEAVE_GRACE_MS = 160;

function personName(person: ReactionPerson): string {
  return person.display_name?.trim() || person.username;
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
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [people, setPeople] = useState<ReactionPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scope = useCurrentAccountScope();
  const getPresence = usePresenceStore((state) => state.getPresence);
  // Re-render an open list when someone's status changes.
  usePresenceStore((state) => (open ? state.presences : null));

  // A new tally means the list we have is stale.
  useEffect(() => {
    setPeople(null);
    setError(null);
  }, [count]);

  useEffect(() => () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  function cancelOpen() {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
  }

  function cancelClose() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }

  function close() {
    cancelOpen();
    cancelClose();
    setOpen(false);
    setExpanded(false);
  }

  /** Hover-opened lists close when the pointer leaves; a right-click list stays. */
  function scheduleClose() {
    cancelOpen();
    if (!open || expanded) return;
    cancelClose();
    closeTimer.current = setTimeout(close, LEAVE_GRACE_MS);
  }

  async function load() {
    try {
      const { data } = await reactionUsersApi.list(channelId, messageId, emoji, 100);
      setPeople(data);
      setError(null);
    } catch (err) {
      setError(extractApiError(err));
    }
  }

  function show(full: boolean) {
    cancelClose();
    setExpanded(full);
    setOpen(true);
    if (!people) void load();
  }

  const title = error
    ? error
    : reactionTitle((people ?? []).slice(0, 2).map(personName), people?.length ?? count, emoji);
  const visible = expanded ? people ?? [] : (people ?? []).slice(0, PREVIEW);
  const hidden = Math.max(0, (people?.length ?? 0) - PREVIEW);

  return (
    <span
      ref={anchorRef}
      data-flip-key={emoji}
      data-flip-own={me || undefined}
      className="inline-flex"
      onPointerEnter={(event) => {
        if (event.pointerType === 'touch') return;
        cancelClose();
        if (open) return;
        cancelOpen();
        openTimer.current = setTimeout(() => show(false), HOVER_DELAY_MS);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'touch') return;
        scheduleClose();
      }}
      onPointerDown={(event) => {
        if (event.pointerType !== 'touch') return;
        cancelOpen();
        openTimer.current = setTimeout(() => {
          suppressClick.current = true;
          show(false);
        }, HOVER_DELAY_MS);
      }}
      onPointerUp={(event) => {
        if (event.pointerType === 'touch') cancelOpen();
      }}
      onPointerCancel={cancelOpen}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        show(true);
      }}
    >
      <Chip
        as="button"
        title={title}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
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
      <Popover
        anchor={anchorRef}
        open={open}
        onClose={close}
        side="top"
        align="start"
        label={`People who reacted with ${emoji}`}
        className="w-60 p-0"
      >
        <div onPointerEnter={cancelClose} onPointerLeave={scheduleClose} className="p-2">
          <div className="flex items-center gap-2 px-1 pb-2">
            <span className="flex h-9 w-9 items-center justify-center text-[1.75rem] leading-none [&_img]:h-8 [&_img]:w-8" aria-hidden>
              {glyph}
            </span>
            <span className="text-meta text-text-muted">
              {people ? (people.length === 1 ? '1 person' : `${people.length} people`) : `${count} ${count === 1 ? 'person' : 'people'}`}
            </span>
          </div>
          {error && <p role="alert" className="px-1 py-1 text-meta text-accent-danger">{error}</p>}
          {!error && !people && <p className="px-1 py-1 text-meta text-text-muted">Loading who reacted…</p>}
          {people && (
            <ul className={cn('flex flex-col gap-0.5', expanded && 'max-h-64 overflow-y-auto scrollbar-thin')}>
              {visible.map((person) => (
                <li key={person.id} className="flex items-center gap-2 rounded-[var(--radius-chip)] px-1 py-1">
                  <LitAvatar
                    size={22}
                    person={personLight({
                      userId: person.id,
                      name: personName(person),
                      status: getPresence(person.id, scope?.serverId)?.status ?? null,
                      avatar: person.avatar_hash,
                    })}
                  />
                  <span className="min-w-0 truncate text-label text-text-primary">{personName(person)}</span>
                </li>
              ))}
            </ul>
          )}
          {!expanded && hidden > 0 && (
            <button
              type="button"
              className="pc-focusable mt-1 w-full rounded-[var(--radius-chip)] px-1 py-1 text-left text-meta font-medium text-text-secondary transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary"
              onClick={() => setExpanded(true)}
            >
              and {hidden} more
            </button>
          )}
        </div>
      </Popover>
    </span>
  );
}
