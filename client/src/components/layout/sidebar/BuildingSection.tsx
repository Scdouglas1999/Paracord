import { BellOff, ChevronDown, ChevronRight } from 'lucide-react';
import type { MouseEvent } from 'react';

import { cn } from '../../../lib/utils';
import { NavRow, SectionLabel } from '../../ui';
import { BuildingPlate } from '../../light';
import { litMembersCaption, type BuildingLight, type RoomLight } from '../../../lib/attention/light';
import { RoomRow, type RoomAttention } from './RoomRow';

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
  navIndexStart,
  activeNavIndex,
}: BuildingSectionProps) {
  const plateIndex = navIndexStart;
  const showExpander = hiddenRoomCount > 0 || expanded;

  return (
    <div role="group" aria-label={building.name} className="flex flex-col gap-0.5">
      <SectionLabel
        meta={
          <span className="flex items-center gap-1.5">
            {muted && <BellOff size={12} aria-label="Muted" className="shrink-0" />}
            {litMembersCaption(building.lightsOn)}
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

      {rooms.map((room, index) => (
        <RoomRow
          key={room.key}
          room={room}
          active={room.key === activeRoomKey}
          attention={attention?.get(room.key)}
          navIndex={plateIndex + 1 + index}
          tabStop={plateIndex + 1 + index === activeNavIndex}
          onOpen={onOpenRoom}
        />
      ))}

      {showExpander && (
        <NavRow
          role="option"
          aria-selected={false}
          data-nav-index={plateIndex + 1 + rooms.length}
          tabIndex={plateIndex + 1 + rooms.length === activeNavIndex ? 0 : -1}
          icon={expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          onClick={() => onToggleRooms(building)}
          className="text-text-faint"
        >
          {expanded
            ? 'Fewer rooms'
            : hiddenRoomCount === 1
              ? '1 more room'
              : `${hiddenRoomCount} more rooms`}
        </NavRow>
      )}
    </div>
  );
}
