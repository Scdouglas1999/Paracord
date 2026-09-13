import { memo } from 'react';

import { cn } from '../../../lib/utils';
import { Chip, NavRow } from '../../ui';
import { LightCaption, RoomThumbnail, roomCaptionFor } from '../../light';
import { useRoomThumbnail } from '../../../hooks/useRoomThumbnail';
import type { RoomLight } from '../../../lib/attention/light';

/**
 * The three room rows of the Buildings column (docs/lantern-stage-spec.md §7.1).
 *
 *   lit voice room  → a live thumbnail row (64px thumb, LIVE dot, occupant
 *                     stack, name + "you're here" / "3 talking")
 *   dark voice room → a plain nav row with a dark window dot; "Dark · nobody in"
 *                     is always in the DOM and appears on hover / focus
 *   text room       → a plain nav row with an amber (lit) or dark window dot and
 *                     "5 reading" trailing
 *
 * Presentational: the light is decided by `lib/attention` and handed in as a
 * {@link RoomLight}; these components never derive one. Every light carries its
 * words (§9) — a row is readable with the colours switched off.
 */

/** Unread / mention state for one room, from the unified conversation merge. */
export interface RoomAttention {
  unread: boolean;
  mentionCount: number;
}

export interface RoomRowProps {
  room: RoomLight;
  /** The room you are looking at — the row is raised. */
  active?: boolean;
  attention?: RoomAttention;
  /** Flat roving-tabindex ordinal (layout-spec §5). */
  navIndex: number;
  /** True when this row is the column's single Tab stop. */
  tabStop: boolean;
  onOpen: (room: RoomLight) => void;
}

/** The 8px window dot that stands in for the room's window on a row. */
function WindowDot({ room }: { room: RoomLight }) {
  return (
    <span
      aria-hidden
      className={cn(
        'pc-window',
        room.level === 'white' && 'is-talking',
        room.level === 'amber' && 'is-reading',
      )}
      style={{ width: 8, height: 8 }}
    />
  );
}

/**
 * The trailing half of a quiet row: a mention chip outranks the room's own
 * caption. A dark voice room keeps "Dark · nobody in" in the DOM at all times
 * and shows it on hover or focus (§7.1) — the words are never the hover's
 * secret.
 */
function RoomTrailing({ room, attention }: { room: RoomLight; attention?: RoomAttention }) {
  if (attention && attention.mentionCount > 0) {
    return (
      <Chip
        size="sm"
        tone="accent"
        aria-label={`${attention.mentionCount} ${attention.mentionCount === 1 ? 'mention' : 'mentions'}`}
      >
        {attention.mentionCount > 99 ? '99+' : attention.mentionCount}
      </Chip>
    );
  }
  if (room.lit) return <LightCaption>{roomCaptionFor(room)}</LightCaption>;
  if (room.kind !== 'voice') return null;
  return (
    <>
      <span className="sr-only">{roomCaptionFor(room)}</span>
      <LightCaption
        aria-hidden
        className={cn(
          'opacity-0 transition-opacity duration-[var(--duration-fast)] ease-[var(--ease-out)]',
          'group-hover:opacity-100 group-focus-visible:opacity-100',
        )}
      >
        {roomCaptionFor(room)}
      </LightCaption>
    </>
  );
}

function rowProps({ navIndex, tabStop, active, room }: Pick<RoomRowProps, 'navIndex' | 'tabStop' | 'room'> & { active: boolean }) {
  return {
    role: 'option' as const,
    'aria-selected': active,
    'data-nav-index': navIndex,
    'data-flip-key': room.key,
    tabIndex: tabStop ? 0 : -1,
  };
}

/**
 * A text room, or a voice room with nobody in it. Unread lifts the name's ink
 * rather than adding a dot — the window dot is already the row's light, and a
 * second dot beside it would say two different things in the same place.
 */
export const QuietRoomRow = memo(function QuietRoomRow({
  room,
  active = false,
  attention,
  navIndex,
  tabStop,
  onOpen,
}: RoomRowProps) {
  const unread = Boolean(attention?.unread) && !active;
  return (
    <NavRow
      {...rowProps({ navIndex, tabStop, active, room })}
      active={active}
      display={room.kind === 'voice'}
      icon={<WindowDot room={room} />}
      trailing={<RoomTrailing room={room} attention={attention} />}
      onClick={() => onOpen(room)}
      className={cn('group', unread && 'text-text-primary')}
    >
      {room.name}
    </NavRow>
  );
});

export interface LiveRoomRowProps extends RoomRowProps {
  /** Injected by {@link LiveRoomRow}; kept a prop so the row stays drawable. */
  frame?: Parameters<typeof RoomThumbnail>[0]['frame'];
}

/**
 * A lit voice room: the thumbnail carries the weight, the name and the caption
 * sit under it (§6.7 — the LIVE badge is never louder than the room).
 */
export const LiveRoomRowView = memo(function LiveRoomRowView({
  room,
  active = false,
  navIndex,
  tabStop,
  onOpen,
  frame = null,
}: LiveRoomRowProps) {
  return (
    <button
      type="button"
      {...rowProps({ navIndex, tabStop, active, room })}
      onClick={() => onOpen(room)}
      className={cn(
        'pc-focusable flex w-full flex-col items-stretch gap-2 p-2 text-left',
        'rounded-[var(--radius-control)]',
        'transition-[background-color,color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
        active
          ? 'bg-bg-raised text-text-primary shadow-[var(--shadow-raised)]'
          : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary',
      )}
    >
      <RoomThumbnail room={room} height={64} frame={frame} />
      <span className="flex min-w-0 items-center gap-2">
        <span className="pc-display min-w-0 flex-1 truncate font-semibold text-text-primary">
          {room.name}
        </span>
        <LightCaption>{roomCaptionFor(room)}</LightCaption>
      </span>
    </button>
  );
});

/**
 * The one row that talks to the media pipeline. `useRoomThumbnail` is WP1's
 * read-only ≤ 2 fps tap: it opens no session and touches no decoder, and it
 * yields a frame only for the room you are actually in (every other case is a
 * named still, drawn by `RoomThumbnail`).
 */
export function LiveRoomRow(props: RoomRowProps) {
  const { frame } = useRoomThumbnail(props.room);
  return <LiveRoomRowView {...props} frame={frame} />;
}

/** Pick the row shape a room's light calls for. */
export function RoomRow(props: RoomRowProps) {
  if (props.room.kind === 'voice' && props.room.lit) return <LiveRoomRow {...props} />;
  return <QuietRoomRow {...props} />;
}
