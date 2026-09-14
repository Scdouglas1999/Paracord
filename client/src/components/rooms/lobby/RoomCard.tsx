import * as React from 'react';
import { MoreHorizontal, Plus } from 'lucide-react';

import { Button, IconButton } from '../../ui';
import { AvatarStack, RoomDuration, RoomThumbnail } from '../../light';
import { darkRoomCaption, lastLitCaption, type RoomLight } from '../../../lib/attention/light';
import type { RoomFrame } from '../../../lib/media/roomFrameTap';
import { roomSharedName } from '../../../lib/motion';
import { cn } from '../../../lib/utils';
import { OPEN_A_NEW_ROOM, speakingCaption } from './lobbyCaptions';

export interface RoomCardProps {
  room: RoomLight;
  /** The newest sampled frame, when this room can produce one (WP1's tap). */
  frame?: RoomFrame | null;
  /**
   * Open the room's own surface — watch the share, step onto the stage. Only a
   * lit room offers it: there is nothing to look at in a dark one.
   */
  onEnter?: (origin?: Element | null) => void;
  /**
   * Turn the lights on: join the call.
   *
   * The card hands back the element that was clicked, because §5.1's shared
   * element needs an origin and a room's name is on its card, its sidebar row
   * and the inline "lit up" event at the same time. Only the click knows which.
   */
  onJoin: (origin?: Element | null) => void;
  /** "Join" in a lit room, "Open" in a dark one, "Enter" for a stage. */
  joinLabel?: string;
  /**
   * Open the room menu — notification level, mark as read, copy link (§7.1).
   * Right-click, a long touch press, or the visible "…" control.
   */
  onMenu?: (event: React.MouseEvent<HTMLElement>) => void;
  /** Injected clock, so "last lit 2 h ago" is testable. */
  nowMs?: number;
}

/**
 * RoomCard — a window you can walk through
 * (docs/lantern-stage-spec.md §7.3, §8).
 *
 * Two variants, and the difference between them is a fact, not a style:
 *
 *   **lit**  — somebody is in there right now. The card carries the lit ring,
 *              the thumbnail carries the LIVE dot and the frame, and the action
 *              is the one white-light button in the product (§1.2, §6.3).
 *   **dark** — nobody is in. A matte *plate* the height of its own words
 *              ({@link DarkRoomCard}), not a 250px card with an empty window
 *              in it.
 *
 * Every light state has its words in the DOM (§9): the thumbnail's LIVE label,
 * the occupant stack's sentence, the speaking line, "Dark · nobody's in".
 */
export const RoomCard = React.forwardRef<HTMLElement, RoomCardProps>(function RoomCard(
  { room, frame = null, onEnter, onJoin, joinLabel, onMenu, nowMs = Date.now() },
  ref,
) {
  if (!room.lit) {
    return (
      <DarkRoomCard
        ref={ref as React.Ref<HTMLElement>}
        room={room}
        onOpen={onJoin}
        openLabel={joinLabel ?? 'Open'}
        onMenu={onMenu}
        nowMs={nowMs}
      />
    );
  }

  const occupants = room.occupants.map((occupant) => occupant.person);
  const speaking = speakingCaption(
    room.occupants.filter((occupant) => occupant.speaking).map((occupant) => occupant.person.name),
  );
  const label = joinLabel ?? 'Join';

  return (
    <article
      ref={ref}
      // §5.1: the thing you click becomes the thing you look at. This card and
      // the Stage's dominant tile travel under the same name.
      data-motion-shared={roomSharedName(room.channelId)}
      onContextMenu={onMenu}
      className={cn(
        'relative flex flex-col overflow-hidden rounded-[var(--radius-plate)] bg-bg-well',
        'shadow-[var(--shadow-tile),var(--ring-lit-plate)]',
      )}
    >
      {onEnter ? (
        <button
          type="button"
          onClick={(event) => onEnter(originOf(event.currentTarget))}
          aria-label={`Look into ${room.name}`}
          className="pc-focusable-composed block w-full text-left"
        >
          <RoomThumbnail
            room={room}
            height={168}
            frame={frame}
            showOccupants={false}
            className="rounded-none shadow-none"
          />
        </button>
      ) : (
        <RoomThumbnail
          room={room}
          height={168}
          frame={frame}
          showOccupants={false}
          className="rounded-none shadow-none"
        />
      )}

      <div className="flex flex-col gap-2.5 px-3.5 pb-3.5 pt-3">
        <div className="flex items-baseline gap-2">
          <h3 className="pc-display min-w-0 flex-1 truncate text-heading text-text-primary">
            {room.name}
          </h3>
          <RoomDuration durationMs={room.durationMs} />
          <RoomMenuButton room={room} onMenu={onMenu} />
        </div>

        <div className="flex items-center gap-2.5">
          {occupants.length > 0 && (
            <AvatarStack people={occupants} size={26} max={3} context={`in ${room.name}`} />
          )}
          <span className="min-w-0 flex-1 truncate text-ribbon text-text-body">
            {speaking || room.caption}
          </span>
          <Button
            variant="light"
            size="sm"
            onClick={(event) => onJoin(originOf(event.currentTarget))}
            className="shrink-0"
            aria-label={`${label} ${room.name}`}
          >
            {label}
          </Button>
        </div>
      </div>
    </article>
  );
});

export interface DarkRoomCardProps {
  room: RoomLight;
  onOpen: (origin?: Element | null) => void;
  openLabel?: string;
  onMenu?: (event: React.MouseEvent<HTMLElement>) => void;
  nowMs?: number;
}

/**
 * The "…" that opens the room menu.
 *
 * A phone never renders the Buildings column, so before this a room's
 * notification level, "mark as read" and "copy link" had no door at all on that
 * form factor. A long press raises `contextmenu` and reaches the same menu, but
 * a gesture nothing on screen mentions is not an affordance — so the control is
 * visible, and `pc-touch` carries it to 44px where a finger will use it (§9).
 */
function RoomMenuButton({
  room,
  onMenu,
}: {
  room: RoomLight;
  onMenu?: (event: React.MouseEvent<HTMLElement>) => void;
}) {
  if (!onMenu) return null;
  return (
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
  );
}

/**
 * DarkRoomCard — a room with its lights off is a *dark window*, not an empty
 * screen (docs/lantern-stage-spec.md §7.3, §6.4, §6.8).
 *
 * The lit card is 250px because it is carrying a picture of people. A dark room
 * has no picture, and the first draft of this surface reserved the full 168px
 * window well anyway and filled it with nothing — so the Lobby of a quiet
 * community was three identical black rectangles, and on a phone two of them
 * were the whole screen.
 *
 * This is the same information at the height of its own words: the room's
 * façade on the left (four unlit panes, the same `pc-window` vocabulary the
 * sidebar's window map and the text rows use), the name, the one line §7.3
 * asks for — "Dark · nobody's in · last lit 2 h ago" — and Open. It is a matte
 * **plate** with a hairline, not a recessed well: a well reads as a hole where
 * a picture failed to load, which is exactly the impression being fixed.
 *
 * No light token is spent anywhere on it, at any interaction state, because
 * nobody is in the room (§0, §6.3). Hover lifts the plate and nothing else.
 */
export const DarkRoomCard = React.forwardRef<HTMLElement, DarkRoomCardProps>(
  function DarkRoomCard({ room, onOpen, openLabel = 'Open', onMenu, nowMs = Date.now() }, ref) {
    return (
      <article
        ref={ref}
        data-motion-shared={roomSharedName(room.channelId)}
        onContextMenu={onMenu}
        className={cn(
          'group/room relative flex items-center gap-3 rounded-[var(--radius-card)] bg-bg-plate',
          'px-3 py-3 shadow-[inset_0_0_0_1px_var(--border-subtle)]',
          'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]',
          'hover:bg-bg-raised',
        )}
      >
        <DarkWindowMark />

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="pc-display truncate text-name text-text-secondary">{room.name}</h3>
          <p className="truncate text-meta text-text-faint">
            {darkRoomCaption('card')} · {lastLitCaption(room.lastLitMs, nowMs)}
          </p>
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={(event) => onOpen(originOf(event.currentTarget))}
          className="shrink-0 shadow-[inset_0_0_0_1px_var(--border-strong)]"
          aria-label={`${openLabel} ${room.name}`}
        >
          {openLabel}
        </Button>
        <RoomMenuButton room={room} onMenu={onMenu} />
      </article>
    );
  },
);

/**
 * Four unlit panes — the room seen from the street with nobody home.
 *
 * It is the window map's own cell (`pc-window`, §8) at card scale, so a dark
 * room is marked with the same object in the sidebar, on Home and here. It
 * never lights: this component is only ever rendered for a room that is dark,
 * and a pane that glowed without somebody behind it would be the first thing
 * §6.1 forbids.
 */
function DarkWindowMark() {
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 grid-cols-2 gap-[3px] rounded-[var(--radius-well)] bg-bg-well p-2',
        'shadow-[var(--shadow-well)]',
      )}
    >
      {[0, 1, 2, 3].map((pane) => (
        <span key={pane} className="pc-window h-3 w-3" />
      ))}
    </span>
  );
}

/** The card a control sits in — the thing that travels (§5.1). */
function originOf(el: Element): Element | null {
  return el.closest('[data-motion-shared]');
}

export interface AddRoomTileProps {
  onClick: () => void;
}

/**
 * The add tile (§7.3) — the third kind of thing in the grid, so the Lobby never
 * tiles identical cards (§6.8).
 *
 * It sits with the dark rooms and matches their height: an "Open a new room"
 * box 250px tall beside four rooms 68px tall was the same empty-rectangle
 * problem in a control.
 *
 * It is rendered **only** for somebody who can actually open a room. There is no
 * disabled state and no "ask an admin" placeholder: a control you cannot use is
 * not a control.
 */
export const AddRoomTile = React.forwardRef<HTMLButtonElement, AddRoomTileProps>(
  function AddRoomTile({ onClick }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        aria-label={OPEN_A_NEW_ROOM}
        className={cn(
          'pc-focusable flex min-h-[68px] items-center justify-center gap-2',
          'rounded-[var(--radius-card)] bg-transparent text-text-muted',
          'shadow-[inset_0_0_0_1px_var(--border-subtle)]',
          'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]',
          'hover:bg-bg-mod-subtle hover:text-text-primary',
        )}
      >
        <Plus size={18} className="text-text-faint" aria-hidden />
        <span className="text-label">{OPEN_A_NEW_ROOM}</span>
      </button>
    );
  },
);
