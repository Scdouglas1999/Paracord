import { useCallback, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { Home, MessageSquare, Plus } from 'lucide-react';

// §5.1: a column that changes order glides — buildings ride the spring-settle
// FLIP as the attention ranking re-sorts them, new rows fade+rise, removed
// rows fall away as ghosts. First mount only measures; reduced motion lands.
import { RollingNumber, useFlipList } from '../../../lib/motion';
import { Button, Chip, NavRow, Well } from '../../ui';
import type { BuildingLight, RoomLight } from '../../../lib/attention/light';
import { BuildingSection, type OpenThread } from './BuildingSection';
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

/**
 * The rooms a building draws above the fold.
 *
 * Rooms arrive ordered by light, which says nothing about whether a room is
 * waiting on *you*: in a building with more than {@link ROOM_ROWS_VISIBLE}
 * rooms, a room holding unread mentions could sit behind "N more rooms" with no
 * badge anywhere to say so — the one row the column exists to show you was the
 * row it hid. Anything with attention is kept above the fold, in the order the
 * light gave it; quiet rooms fill whatever space is left.
 */
export function roomsWithinFold(
  rooms: readonly RoomLight[],
  attention: ReadonlyMap<string, RoomAttention> | undefined,
  limit: number,
): readonly RoomLight[] {
  if (rooms.length <= limit) return rooms;
  const needsYou = (room: RoomLight): boolean => {
    const mark = attention?.get(room.key);
    return !!mark && (mark.mentionCount > 0 || mark.unread);
  };
  const hiddenNeedy = rooms.slice(limit).filter(needsYou);
  if (hiddenNeedy.length === 0) return rooms.slice(0, limit);
  const keep = new Set<RoomLight>(rooms.filter(needsYou).slice(0, limit));
  for (const room of rooms) {
    if (keep.size >= limit) break;
    keep.add(room);
  }
  return rooms.filter((room) => keep.has(room));
}
/** Past this many buildings, dark ones fold until asked. */
export const ACCORDION_THRESHOLD = 8;

/** How many flat nav ordinals a section spends: plate, rooms, thread, expander. */
function sectionRows(section: Section): number {
  return 1 + section.rooms.length + (section.threadRow ? 1 : 0) + (section.showExpander ? 1 : 0);
}

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
  onOpenRoom: (room: RoomLight, origin?: Element | null) => void;
  onAddBuilding: () => void;
  onBuildingContextMenu?: (event: MouseEvent, building: BuildingLight) => void;
  /** Right-click on a room row: notifications, mark as read, copy link (§7.1). */
  onRoomContextMenu?: (event: MouseEvent, room: RoomLight) => void;
  /**
   * The thread this client has open. It is not a room and takes no room slot;
   * it draws one indented row under the room that owns it (§7.1).
   */
  openThread?: OpenThread | null;
  onOpenThread?: (thread: OpenThread) => void;
  /** The account plate, and the call dock while you are in a room. */
  footer?: ReactNode;
}

interface Section {
  building: BuildingLight;
  rooms: readonly RoomLight[];
  hiddenRoomCount: number;
  expanded: boolean;
  showExpander: boolean;
  /** The open thread hangs off one of this section's rooms, so it costs a row. */
  threadRow: boolean;
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
  onRoomContextMenu,
  openThread = null,
  onOpenThread,
  footer,
}: BuildingsColumnProps) {
  const [openBuildings, setOpenBuildings] = useState<ReadonlySet<string>>(() => new Set<string>());
  // Every reorder the light merge produces — a server rising as its rooms
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
          : roomsWithinFold(building.rooms, attention, ROOM_ROWS_VISIBLE);
      const hiddenRoomCount = building.rooms.length - rooms.length;
      const showExpander = hiddenRoomCount > 0 || expanded;
      const threadRow = Boolean(openThread && rooms.some((room) => room.key === openThread.parentKey));
      const previous = built[built.length - 1];
      const navIndexStart = previous ? previous.navIndexStart + sectionRows(previous) : 2;
      built.push({ building, rooms, hiddenRoomCount, expanded, showExpander, threadRow, navIndexStart });
    }
    return built;
  }, [activeBuildingKey, activeRoomKey, attention, buildings, openBuildings, openThread]);

  const last = sections[sections.length - 1];
  const addBuildingIndex = last ? last.navIndexStart + sectionRows(last) : 2;

  // Roving tabindex (layout-spec §5): exactly ONE element is a Tab stop and the
  // arrows move between rows. Prefer the open room, then the open Lobby, then
  // the active anchor, then Home.
  const activeNavIndex = useMemo(() => {
    for (const section of sections) {
      if (section.building.key === activeBuildingKey) return section.navIndexStart;
      const roomIndex = section.rooms.findIndex((room) => room.key === activeRoomKey);
      if (roomIndex < 0) continue;
      // The open thread's row sits directly under its room and is where you
      // actually are, so it takes the Tab stop from the room it hangs off.
      const threadIndex = section.threadRow
        ? section.rooms.findIndex((room) => room.key === openThread?.parentKey)
        : -1;
      const shift = threadIndex >= 0 && threadIndex < roomIndex ? 1 : 0;
      const index = section.navIndexStart + 1 + roomIndex + shift;
      return threadIndex === roomIndex ? index + 1 : index;
    }
    if (messagesActive) return 1;
    return 0;
  }, [activeBuildingKey, activeRoomKey, messagesActive, openThread, sections]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-2">
      <div className="shrink-0">
        <SidebarSearch />
      </div>

      <div
        ref={listRef}
        data-roving-container=""
        role="listbox"
        aria-label="Servers and channels"
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
                <RollingNumber
                  value={needsYouCount}
                  format={(count) => (count > 99 ? '99+' : String(count))}
                  announce={false}
                />
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
                <RollingNumber
                  value={messagesCount}
                  format={(count) => (count > 99 ? '99+' : String(count))}
                  announce={false}
                />
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
            onRoomContextMenu={onRoomContextMenu}
            openThread={section.threadRow ? openThread : null}
            onOpenThread={onOpenThread}
            navIndexStart={section.navIndexStart}
            activeNavIndex={activeNavIndex}
          />
        ))}

        {buildings.length === 0 ? (
          <Well className="mt-4 flex flex-col items-start gap-2.5">
            <p className="text-label text-text-secondary">
              Add a server — join with an invite, or start your own.
            </p>
            <Button variant="primary" size="sm" onClick={onAddBuilding}>
              <Plus size={14} aria-hidden />
              Add a server
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
            Add a server
          </NavRow>
        )}
      </div>

      {footer != null && <div className="shrink-0">{footer}</div>}
    </div>
  );
}
