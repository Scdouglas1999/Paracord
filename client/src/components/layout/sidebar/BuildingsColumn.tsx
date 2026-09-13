import { useCallback, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { Home, MessageSquare, Plus } from 'lucide-react';

// §5.1: a column that changes order glides — buildings ride the spring-settle
// FLIP as the attention ranking re-sorts them, new rows fade+rise, removed
// rows fall away as ghosts. First mount only measures; reduced motion lands.
import { useFlipList } from '../../../lib/motion';
import { Button, Chip, NavRow, Well } from '../../ui';
import type { BuildingLight, RoomLight } from '../../../lib/attention/light';
import { BuildingSection } from './BuildingSection';
import type { RoomAttention } from './RoomRow';
import { SidebarSearch } from './SidebarSearch';

/**
 * The Buildings column — the body of the sidebar
 * (docs/lantern-stage-spec.md §7.1).
 *
 *   search well (⌘K)
 *   Home · Messages, with their counts
 *   per building, brightest first: "Kestrel Robotics · 24 in", the window-map
 *     plate, then its rooms as rows
 *   Add a building
 *   the footer slot — the account plate, and the call dock while you are in one
 *
 * Presentational: every building arrives as a {@link BuildingLight} built by
 * `lib/attention` and ordered by `useBuildingLights()`. This component decides
 * nothing about light; it decides only how much of a long list to draw at once.
 *
 * Two bounds keep a big account from turning the column into a scroll bar:
 *
 *   - **Rooms.** A building draws at most {@link ROOM_ROWS_VISIBLE} rows; the
 *     rest fold into a "N more rooms" row. Rooms arrive lit-first, so nothing
 *     that is lit is ever behind the fold.
 *   - **Buildings.** Past {@link ACCORDION_THRESHOLD} buildings the column turns
 *     into an accordion: a building that is dark and not open draws its label
 *     and its window map — which still shows every room's light — and its rooms
 *     wait behind one click. Twenty dark buildings cost forty rows, not two
 *     hundred. (Virtualising was the alternative; an accordion keeps the roving
 *     tab order and the screen reader's row count honest, and a window map
 *     already summarises a folded building.)
 */

/** Rows a building draws before the rest fold into the expander. */
export const ROOM_ROWS_VISIBLE = 8;
/** Past this many buildings, dark ones fold until asked. */
export const ACCORDION_THRESHOLD = 8;

export interface BuildingsColumnProps {
  buildings: readonly BuildingLight[];
  /** Conversations that need you — the Home chip (Home owns Needs-you now). */
  needsYouCount: number;
  /** Unread direct and group messages — the Messages chip. */
  messagesCount: number;
  homeActive?: boolean;
  messagesActive?: boolean;
  /** The building whose Lobby is open, as a `BuildingLight.key`. */
  activeBuildingKey?: string | null;
  /** The open room, as a `RoomLight.key`. */
  activeRoomKey?: string | null;
  attention?: ReadonlyMap<string, RoomAttention>;
  mutedBuildingKeys?: ReadonlySet<string>;
  onOpenHome: () => void;
  onOpenMessages: () => void;
  onOpenLobby: (building: BuildingLight) => void;
  onOpenRoom: (room: RoomLight) => void;
  onAddBuilding: () => void;
  onBuildingContextMenu?: (event: MouseEvent, building: BuildingLight) => void;
  /** The account plate, and the call dock while you are in a room. */
  footer?: ReactNode;
}

interface Section {
  building: BuildingLight;
  rooms: readonly RoomLight[];
  hiddenRoomCount: number;
  expanded: boolean;
  showExpander: boolean;
  navIndexStart: number;
}

export function BuildingsColumn({
  buildings,
  needsYouCount,
  messagesCount,
  homeActive = false,
  messagesActive = false,
  activeBuildingKey = null,
  activeRoomKey = null,
  attention,
  mutedBuildingKeys,
  onOpenHome,
  onOpenMessages,
  onOpenLobby,
  onOpenRoom,
  onAddBuilding,
  onBuildingContextMenu,
  footer,
}: BuildingsColumnProps) {
  const [openBuildings, setOpenBuildings] = useState<ReadonlySet<string>>(() => new Set<string>());
  // Every reorder the light merge produces — a building rising as its rooms
  // light, a conversation leaving Needs-you — plays back through the engine.
  const listRef = useFlipList<HTMLDivElement>();

  const toggleRooms = useCallback((building: BuildingLight) => {
    setOpenBuildings((current) => {
      const next = new Set(current);
      if (next.has(building.key)) next.delete(building.key);
      else next.add(building.key);
      return next;
    });
  }, []);

  const sections = useMemo<Section[]>(() => {
    const accordion = buildings.length > ACCORDION_THRESHOLD;
    const built: Section[] = [];
    // Home and Messages take the first two ordinals; every section's rows
    // continue the one flat order the arrow keys walk (layout-spec §5).
    for (const building of buildings) {
      const expanded = openBuildings.has(building.key);
      const folded =
        accordion
        && building.roomsLit === 0
        && building.readingCount === 0
        && building.key !== activeBuildingKey
        && !building.rooms.some((room) => room.key === activeRoomKey);
      const rooms = expanded
        ? building.rooms
        : folded
          ? []
          : building.rooms.slice(0, ROOM_ROWS_VISIBLE);
      const hiddenRoomCount = building.rooms.length - rooms.length;
      const showExpander = hiddenRoomCount > 0 || expanded;
      const previous = built[built.length - 1];
      const navIndexStart = previous
        ? previous.navIndexStart + 1 + previous.rooms.length + (previous.showExpander ? 1 : 0)
        : 2;
      built.push({ building, rooms, hiddenRoomCount, expanded, showExpander, navIndexStart });
    }
    return built;
  }, [activeBuildingKey, activeRoomKey, buildings, openBuildings]);

  const last = sections[sections.length - 1];
  const addBuildingIndex = last
    ? last.navIndexStart + 1 + last.rooms.length + (last.showExpander ? 1 : 0)
    : 2;

  // Roving tabindex (layout-spec §5): exactly ONE element is a Tab stop and the
  // arrows move between rows. Prefer the open room, then the open Lobby, then
  // the active anchor, then Home.
  const activeNavIndex = useMemo(() => {
    for (const section of sections) {
      if (section.building.key === activeBuildingKey) return section.navIndexStart;
      const roomIndex = section.rooms.findIndex((room) => room.key === activeRoomKey);
      if (roomIndex >= 0) return section.navIndexStart + 1 + roomIndex;
    }
    if (messagesActive) return 1;
    return 0;
  }, [activeBuildingKey, activeRoomKey, messagesActive, sections]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-2">
      <div className="shrink-0">
        <SidebarSearch />
      </div>

      <div
        ref={listRef}
        data-roving-container=""
        role="listbox"
        aria-label="Buildings and rooms"
        aria-orientation="vertical"
        className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1 pb-2 scrollbar-thin"
      >
        <NavRow
          role="option"
          aria-selected={homeActive}
          data-flip-key="home"
          data-nav-index={0}
          tabIndex={activeNavIndex === 0 ? 0 : -1}
          active={homeActive}
          icon={<Home size={16} />}
          onClick={onOpenHome}
          trailing={
            needsYouCount > 0 ? (
              /* White-light ink, as drawn (§7.1): the number is people waiting
                 on you, and it is the only count in the column that is. */
              <Chip
                size="sm"
                tone="talking"
                aria-label={`${needsYouCount} ${needsYouCount === 1 ? 'conversation needs' : 'conversations need'} you`}
              >
                {needsYouCount > 99 ? '99+' : needsYouCount}
              </Chip>
            ) : null
          }
        >
          Home
        </NavRow>

        <NavRow
          role="option"
          aria-selected={messagesActive}
          data-flip-key="messages"
          data-nav-index={1}
          tabIndex={activeNavIndex === 1 ? 0 : -1}
          active={messagesActive}
          icon={<MessageSquare size={16} />}
          onClick={onOpenMessages}
          trailing={
            messagesCount > 0 ? (
              <Chip
                size="sm"
                aria-label={`${messagesCount} unread ${messagesCount === 1 ? 'conversation' : 'conversations'}`}
              >
                {messagesCount > 99 ? '99+' : messagesCount}
              </Chip>
            ) : null
          }
        >
          Messages
        </NavRow>

        {sections.map((section) => (
          <BuildingSection
            key={section.building.key}
            building={section.building}
            active={section.building.key === activeBuildingKey}
            activeRoomKey={activeRoomKey}
            attention={attention}
            muted={mutedBuildingKeys?.has(section.building.key) ?? false}
            rooms={section.rooms}
            hiddenRoomCount={section.hiddenRoomCount}
            expanded={section.expanded}
            onToggleRooms={toggleRooms}
            onOpenLobby={onOpenLobby}
            onOpenRoom={onOpenRoom}
            onContextMenu={onBuildingContextMenu}
            navIndexStart={section.navIndexStart}
            activeNavIndex={activeNavIndex}
          />
        ))}

        {buildings.length === 0 ? (
          <Well className="mt-4 flex flex-col items-start gap-2.5">
            <p className="text-label text-text-secondary">
              Add a building — join with an invite, or start your own.
            </p>
            <Button variant="primary" size="sm" onClick={onAddBuilding}>
              <Plus size={14} aria-hidden />
              Add a building
            </Button>
          </Well>
        ) : (
          <NavRow
            role="option"
            aria-selected={false}
            data-flip-key="add-building"
            data-nav-index={addBuildingIndex}
            tabIndex={addBuildingIndex === activeNavIndex ? 0 : -1}
            icon={<Plus size={16} />}
            onClick={onAddBuilding}
            className="mt-2"
          >
            Add a building
          </NavRow>
        )}
      </div>

      {footer != null && <div className="shrink-0">{footer}</div>}
    </div>
  );
}
