import * as React from 'react';
import { Plus } from 'lucide-react';

import { Button } from '../../ui';
import { AvatarStack, RoomDuration, RoomThumbnail } from '../../light';
import { lastLitCaption, type RoomLight } from '../../../lib/attention/light';
import type { RoomFrame } from '../../../lib/media/roomFrameTap';
import { roomSharedName } from '../../../lib/motion';
import { cn } from '../../../lib/utils';
import { OPEN_A_NEW_ROOM, TURN_THE_LIGHTS_ON, speakingCaption } from './lobbyCaptions';

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
 *   **dark** — nobody is in. A matte card that says so, remembers when the room
 *              was last lit, and offers to turn the lights on.
 *
 * Every light state has its words in the DOM (§9): the thumbnail's LIVE label,
 * the occupant stack's sentence, the speaking line, "Dark · nobody's in".
 */
export const RoomCard = React.forwardRef<HTMLElement, RoomCardProps>(function RoomCard(
  { room, frame = null, onEnter, onJoin, joinLabel, nowMs = Date.now() },
  ref,
) {
  const occupants = room.occupants.map((occupant) => occupant.person);
  const speaking = speakingCaption(
    room.occupants.filter((occupant) => occupant.speaking).map((occupant) => occupant.person.name),
  );
  const label = joinLabel ?? (room.lit ? 'Join' : 'Open');

  return (
    <article
      ref={ref}
      // §5.1: the thing you click becomes the thing you look at. This card and
      // the Stage's dominant tile travel under the same name.
      data-motion-shared={roomSharedName(room.channelId)}
      className={cn(
        'relative flex flex-col overflow-hidden rounded-[var(--radius-plate)] bg-bg-well',
        room.lit
          ? 'shadow-[var(--shadow-tile),var(--ring-lit-plate)]'
          : 'shadow-[var(--shadow-tile)]',
      )}
    >
      {room.lit && onEnter ? (
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
          <h3
            className={cn(
              'pc-display min-w-0 flex-1 truncate text-heading',
              room.lit ? 'text-text-primary' : 'text-text-secondary',
            )}
          >
            {room.name}
          </h3>
          {room.lit ? (
            <RoomDuration durationMs={room.durationMs} />
          ) : (
            <span className="shrink-0 text-meta text-text-faint">
              {lastLitCaption(room.lastLitMs, nowMs)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2.5">
          {room.lit ? (
            <>
              {occupants.length > 0 && (
                <AvatarStack
                  people={occupants}
                  size={26}
                  max={3}
                  context={`in ${room.name}`}
                />
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
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate text-meta text-text-faint">
                {TURN_THE_LIGHTS_ON}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={(event) => onJoin(originOf(event.currentTarget))}
                className="shrink-0 shadow-[inset_0_0_0_1px_var(--border-strong)]"
                aria-label={`${label} ${room.name}`}
              >
                {label}
              </Button>
            </>
          )}
        </div>
      </div>
    </article>
  );
});

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
          'pc-focusable flex min-h-[250px] flex-col items-center justify-center gap-2',
          'rounded-[var(--radius-plate)] bg-bg-well text-text-muted',
          'shadow-[inset_0_0_0_1px_var(--border-subtle)]',
          'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]',
          'hover:bg-bg-mod-subtle hover:text-text-primary',
        )}
      >
        <Plus size={22} className="text-text-faint" aria-hidden />
        <span className="text-label">{OPEN_A_NEW_ROOM}</span>
      </button>
    );
  },
);
