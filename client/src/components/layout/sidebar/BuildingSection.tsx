import { BellOff, ChevronDown, ChevronRight } from 'lucide-react';
import type { CSSProperties, MouseEvent } from 'react';

import { RollingNumber } from '../../../lib/motion';
import { getIdentityColor } from '../../../lib/colors';
import { cn } from '../../../lib/utils';
import { NavRow, SectionLabel } from '../../ui';
import { BuildingPlate } from '../../light';
import { litMembersCaption, type BuildingLight, type RoomLight } from '../../../lib/attention/light';
import { useGuildTogether } from '../../../hooks/useGuildTogether';
import { useSportsPolling, useSportsSettings } from '../../../hooks/useSportsBoard';
import { isSportsPath, liveCount } from '../../sports/model';
import { SportsSidebarRow } from '../../sports/SportsSidebarRow';
import { DailyWordSidebarRow } from '../../dailyWord/DailyWordSidebarRow';
import { isDailyWordPath } from '../../dailyWord/model';
import { useDailyWordSettings } from '../../../hooks/useDailyWord';
import { useGameServers } from '../../../hooks/useGameServers';
import { GameServersSidebarRow } from '../../gameServers/GameServersSidebarRow';
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
 *   "Kestrel Robotics · 24 online"   the section label, sentence case (§2, §6.8)
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
  /** Opens the sports board without a full page load. */
  onOpenSports?: (guildId: string) => void;
  /** Opens the daily word without a full page load. */
  onOpenDailyWord?: (guildId: string) => void;
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
  onOpenSports,
  onOpenDailyWord,
}: BuildingSectionProps) {
  const plateIndex = navIndexStart;
  const { settings, board } = useSportsSettings(building.guildId);
  const sportsOn = settings?.enabled === true;
  useSportsPolling(building.guildId, sportsOn, 'sidebar');
  // "Watching …" under the voice channels that have a session going.
  useGuildTogether(building.guildId);
  const sportsOpen = sportsOn && isSportsPath(building.guildId);
  const { enabled: wordOn } = useDailyWordSettings(building.guildId);
  const wordOpen = wordOn && isDailyWordPath(building.guildId);
  const { servers: gameServers } = useGameServers(building.guildId);
  // A page of its own (Sports, Daily word) is open: the plate is not the current page.
  const pageOpen = sportsOpen || wordOpen;
  // The server's own color — the same one its Home card and its Lobby header
  // wear, so the eye learns it. Identity, never state (§6.3): it says WHICH
  // server this is, and it says nothing at all about who is in it.
  const identity = getIdentityColor(building.guildId);
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
      style={{
        '--identity': identity,
        // Inside this group the row you are on wears the server's color
        // instead of the neutral wash. 16% is the measured step: enough to
        // name the server, quiet enough that the row's ink is untouched.
        '--row-selected': 'color-mix(in srgb, var(--identity) 16%, transparent)',
      } as CSSProperties}
    >
      <SectionLabel
        meta={
          <span className="flex items-center gap-1.5">
            {muted && <BellOff size={12} aria-label="Muted" className="shrink-0" />}
            {/* "24 online" — §5.1's re-roll; the section label is read as a
                whole, so the number does not announce itself twice. A building
                whose roster has not arrived shows no count at all: "0 online" would
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
        <span className="pc-identity-mark" aria-hidden />
        {building.name}
      </SectionLabel>

      {/* The plate is the building's front door: it opens the Lobby. The active
          outline is a border token, never a light — a light would claim somebody
          is in there (§6.3). */}
      <button
        type="button"
        role="option"
        aria-selected={active && !pageOpen}
        aria-current={active && !pageOpen ? 'page' : undefined}
        aria-label={`${building.name} lobby — ${building.caption}`}
        data-nav-index={plateIndex}
        tabIndex={plateIndex === activeNavIndex && !pageOpen ? 0 : -1}
        onClick={() => onOpenLobby(building)}
        onContextMenu={(event) => onContextMenu?.(event, building)}
        className={cn(
          'pc-focusable mb-1.5 block w-full rounded-[var(--radius-card)] text-left',
          active && !pageOpen && 'outline outline-1 outline-offset-2 outline-border-strong',
        )}
      >
        <BuildingPlate building={building} scale="sidebar" />
      </button>

      {sportsOn && (
        <SportsSidebarRow
          guildId={building.guildId}
          liveCount={liveCount(board?.games)}
          active={sportsOpen}
          tabStop={sportsOpen}
          onOpen={onOpenSports}
        />
      )}

      {wordOn && (
        <DailyWordSidebarRow
          guildId={building.guildId}
          active={wordOpen}
          tabStop={wordOpen}
          onOpen={onOpenDailyWord}
        />
      )}

      {gameServers.length > 0 && (
        <GameServersSidebarRow guildName={building.name} servers={gameServers} />
      )}

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
            'Fewer channels'
          ) : (
            /* The number of rooms folded away changes as rooms light and go
               dark, so it re-rolls with the rest of them (§5.1). */
            <RollingNumber
              value={hiddenRoomCount}
              format={(count) => (count === 1 ? '1 more channel' : `${count} more channels`)}
              announce={false}
            />
          )}
        </NavRow>
      )}
    </div>
  );
}
