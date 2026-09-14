import { BellOff, ChevronDown, ChevronRight } from 'lucide-react';
import type { MouseEvent } from 'react';

import { RollingNumber } from '../../../lib/motion';
import { cn } from '../../../lib/utils';
import { NavRow, SectionLabel } from '../../ui';
import { BuildingPlate } from '../../light';
import { litMembersCaption, type BuildingLight, type RoomLight } from '../../../lib/attention/light';
import { RoomRow, ThreadRow, type RoomAttention } from './RoomRow';

/**
 * The thread this client has open, and the room it belongs to.
 *
 * A thread is not a room (§7.1): it never takes a room's slot and never counts
 * against the fold. The one you are *in* still gets a row, indented under its
 * room, so the column can say where you are.
 */
export interface OpenThread {
  /** `entityScopeKey(scope, threadChannelId)`. */
  key: string;
  /** The `RoomLight.key` of the room it hangs off. */
  parentKey: string;
  name: string;
}

/**
 * One building in the Buildings column (docs/lantern-stage-spec.md §7.1).
 *
 *   "Kestrel Robotics · 24 in"   the section label, sentence case (§2, §6.8)
 *   the window map plate          one window per room; it is the building's
 *                                 front door — activating it opens the Lobby
 *   the rooms, as rows            lit voice first, then dark voice, then text
 *
 * Presentational. The {@link BuildingLight} is built by `lib/attention` and
 * handed in; this component never reads a store and never decides what is lit.
 */

export interface BuildingSectionProps {
  building: BuildingLight;
  /** This building's Lobby is the open route. */
  active?: boolean;
  /** The room you are looking at, as a `RoomLight.key`. */
  activeRoomKey?: string | null;
  /** Unread / mention state per room key, from the unified conversation merge. */
  attention?: ReadonlyMap<string, RoomAttention>;
  muted?: boolean;
  /** The rooms to draw as rows — already sliced by the column. */
  rooms: readonly RoomLight[];
  /** How many rooms exist beyond `rooms`; drives the expander row. */
  hiddenRoomCount: number;
  /** True when every room is shown and the expander can fold them back. */
  expanded: boolean;
  onToggleRooms: (building: BuildingLight) => void;
  onOpenLobby: (building: BuildingLight) => void;
  onOpenRoom: (room: RoomLight, origin?: Element | null) => void;
  onContextMenu?: (event: MouseEvent, building: BuildingLight) => void;
  /** Right-click on one of this building's rooms. */
  onRoomContextMenu?: (event: MouseEvent, room: RoomLight) => void;
  /** The open thread, when it belongs to one of `rooms`. */
  openThread?: OpenThread | null;
  onOpenThread?: (thread: OpenThread) => void;
  /** Flat roving-tabindex ordinal of this section's first row (the plate). */
  navIndexStart: number;
  /** The column's single Tab stop. */
  activeNavIndex: number;
}

export function BuildingSection({
  building,
  active = false,
  activeRoomKey = null,
  attention,
  muted = false,
  rooms,
  hiddenRoomCount,
  expanded,
  onToggleRooms,
  onOpenLobby,
  onOpenRoom,
  onContextMenu,
  onRoomContextMenu,
  openThread = null,
  onOpenThread,
  navIndexStart,
  activeNavIndex,
}: BuildingSectionProps) {
  const plateIndex = navIndexStart;
  const showExpander = hiddenRoomCount > 0 || expanded;
  // The open thread's row sits between its room and the next one, so every
  // ordinal after it shifts by one. Walk the rows once and count as we go.
  let cursor = plateIndex + 1;

  return (
    <div
      role="group"
      aria-label={building.name}
      data-flip-key={building.key}
      className="flex flex-col gap-0.5"
    >
      <SectionLabel
        meta={
          <span className="flex items-center gap-1.5">
            {muted && <BellOff size={12} aria-label="Muted" className="shrink-0" />}
            {/* "24 in" — §5.1's re-roll; the section label is read as a
                whole, so the number does not announce itself twice. A building
                whose roster has not arrived shows no count at all: "0 in" would
                be a claim, and it would be the wrong one. */}
            {building.rosterKnown && (
              <RollingNumber
                value={building.lightsOn}
                format={litMembersCaption}
                announce={false}
              />
            )}
          </span>
        }
        className={cn(active && 'text-text-primary')}
      >
        {building.name}
      </SectionLabel>

      {/* The plate is the building's front door: it opens the Lobby. The active
          outline is a border token, never a light — a light would claim somebody
          is in there (§6.3). */}
      <button
        type="button"
        role="option"
        aria-selected={active}
        aria-current={active ? 'page' : undefined}
        aria-label={`${building.name} lobby — ${building.caption}`}
        data-nav-index={plateIndex}
        tabIndex={plateIndex === activeNavIndex ? 0 : -1}
        onClick={() => onOpenLobby(building)}
        onContextMenu={(event) => onContextMenu?.(event, building)}
        className={cn(
          'pc-focusable mb-1.5 block w-full rounded-[var(--radius-card)] text-left',
          active && 'outline outline-1 outline-offset-2 outline-border-strong',
        )}
      >
        <BuildingPlate building={building} scale="sidebar" />
      </button>

      {rooms.flatMap((room) => {
        const roomIndex = cursor++;
        const rows = [
          <RoomRow
            key={room.key}
            room={room}
            active={room.key === activeRoomKey}
            attention={attention?.get(room.key)}
            navIndex={roomIndex}
            tabStop={roomIndex === activeNavIndex}
            onOpen={onOpenRoom}
            onContextMenu={onRoomContextMenu}
          />,
        ];
        if (openThread?.parentKey === room.key) {
          const threadIndex = cursor++;
          rows.push(
            <ThreadRow
              key={openThread.key}
              name={openThread.name}
              parentName={room.name}
              navIndex={threadIndex}
              tabStop={threadIndex === activeNavIndex}
              onOpen={() => onOpenThread?.(openThread)}
            />,
          );
        }
        return rows;
      })}

      {showExpander && (
        <NavRow
          role="option"
          aria-selected={false}
          data-nav-index={cursor}
          tabIndex={cursor === activeNavIndex ? 0 : -1}
          icon={expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          onClick={() => onToggleRooms(building)}
          className="text-text-faint"
        >
          {expanded ? (
            'Fewer rooms'
          ) : (
            /* The number of rooms folded away changes as rooms light and go
               dark, so it re-rolls with the rest of them (§5.1). */
            <RollingNumber
              value={hiddenRoomCount}
              format={(count) => (count === 1 ? '1 more room' : `${count} more rooms`)}
              announce={false}
            />
          )}
        </NavRow>
      )}
    </div>
  );
}
