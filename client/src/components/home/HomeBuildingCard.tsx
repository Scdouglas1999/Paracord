import { Button, Lamp, Plate } from '../ui';
import { AvatarStack, BuildingPlate, RoomThumbnail, WindowMap } from '../light';
import { useRoomThumbnail } from '../../hooks/useRoomThumbnail';
import { getIdentityColor } from '../../lib/colors';
import { guildInitials, resolveGuildIconUrl } from '../../lib/guildIcon';
import { cn } from '../../lib/utils';
import type { BuildingLight, RoomLight } from '../../lib/attention/light';
import { buildingMetaCaption, roomActivityLine, textRoomCaption } from './homeCaptions';
import { activeTextRoom, isLitBuilding, litTextRooms } from './homeModel';

export interface HomeBuildingCardProps {
  building: BuildingLight;
  /** Mention counts by room key (`entityScopeKey(scope, channelId)`). */
  mentions: ReadonlyMap<string, number>;
  onOpenBuilding: (building: BuildingLight) => void;
  onOpenRoom: (building: BuildingLight, room: RoomLight) => void;
  onJoinRoom: (building: BuildingLight, room: RoomLight) => void;
}

/**
 * One building on Home (docs/lantern-stage-spec.md §7.5).
 *
 * **Two shapes, and which one you get is state, not taste.** A building with a
 * lit voice room is a wide card: the room's 176px thumbnail, who is in it, what
 * they are doing, and Join in white light, beside the building's mark, its
 * window map and its lit text rooms. A building with nothing talking is a
 * compact row — mark, name, counts, window map, and the one text room somebody
 * is actually reading. Nothing tiles identically (§6.8), because nothing about
 * these two buildings is identical.
 */
export function HomeBuildingCard(props: HomeBuildingCardProps) {
  return isLitBuilding(props.building) ? (
    <LitBuildingCard {...props} />
  ) : (
    <QuietBuildingRow {...props} />
  );
}

/** The building's mark — its icon, or its initials on its own identity colour. */
function BuildingMark({ building, dim }: { building: BuildingLight; dim?: boolean }) {
  const src = resolveGuildIconUrl({ icon: building.icon });
  return (
    <span
      aria-hidden
      className={cn(
        'pc-display flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-[8px]',
        'text-[10px] font-bold text-text-on-light',
        dim && 'pc-dim',
      )}
      style={{ background: src ? undefined : getIdentityColor(building.guildId) }}
    >
      {src ? (
        <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        guildInitials(building.name)
      )}
    </span>
  );
}

/** The building's name, as the control that opens it. */
function BuildingName({
  building,
  dim,
  onOpen,
}: {
  building: BuildingLight;
  dim?: boolean;
  onOpen: (building: BuildingLight) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(building)}
      className={cn(
        'pc-display pc-focusable min-w-0 truncate rounded-[var(--radius-control)] text-left',
        'text-heading font-bold',
        dim ? 'text-text-secondary' : 'text-text-primary',
        'hover:text-text-primary',
      )}
    >
      {building.name}
    </button>
  );
}

/** One lit text room under a building's windows. */
function TextRoomLine({
  building,
  room,
  mentions,
  onOpenRoom,
}: {
  building: BuildingLight;
  room: RoomLight;
  mentions: number;
  onOpenRoom: (building: BuildingLight, room: RoomLight) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpenRoom(building, room)}
      className={cn(
        'pc-focusable -mx-1.5 flex min-h-8 w-full min-w-0 items-center gap-2 rounded-[var(--radius-control)] px-1.5',
        'text-left transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]',
        'hover:bg-bg-mod-subtle',
      )}
    >
      <span
        aria-hidden
        className={cn('pc-window shrink-0', room.lit && 'is-reading')}
        style={{ width: 8, height: 8 }}
      />
      <span className="shrink-0 truncate text-[13px] font-semibold text-text-primary">
        {room.name}
      </span>
      <span className="min-w-0 truncate text-meta text-text-faint">
        {textRoomCaption(room, mentions)}
      </span>
    </button>
  );
}

/**
 * A building whose voice room is lit: the wide card.
 *
 * The thumbnail is WP1's — it decides on its own whether real frames exist and
 * paints a still plus the LIVE dot when they do not (§5). The occupant stack
 * and the activity line sit over it as one group so the stack's width can never
 * push the sentence off the frame.
 */
function LitBuildingCard({
  building,
  mentions,
  onOpenBuilding,
  onOpenRoom,
  onJoinRoom,
}: HomeBuildingCardProps) {
  const room = building.brightestRoom as RoomLight;
  const feed = useRoomThumbnail(room);
  const occupants = room.occupants.map((occupant) => occupant.person);
  const textRooms = litTextRooms(building);

  return (
    <Plate
      bare
      lit
      as="article"
      aria-label={building.name}
      className="grid grid-cols-1 overflow-hidden rounded-[var(--radius-plate)] md:grid-cols-[300px_minmax(0,1fr)]"
    >
      <div className="relative min-w-0">
        <RoomThumbnail
          room={room}
          height={176}
          frame={feed.frame}
          showOccupants={false}
          className="h-full rounded-none shadow-none"
          action={
            <Button size="sm" variant="light" onClick={() => onJoinRoom(building, room)}>
              Join
            </Button>
          }
        />
        {/* Who is in there, and what they are doing — stacked rather than side
            by side, because a real display name is not four letters and this
            frame is 300px wide. The Join button sits beside the stack. */}
        <div className="pointer-events-none absolute bottom-3 left-3 right-20 flex flex-col items-start gap-1.5">
          <span className="max-w-full truncate text-meta text-text-primary">
            {roomActivityLine(room)}
          </span>
          {occupants.length > 0 && (
            <AvatarStack
              people={occupants}
              size={22}
              max={3}
              overlap={5}
              context={`in ${room.name}`}
            />
          )}
        </div>
      </div>

      <div className="relative flex min-w-0 flex-col gap-3 p-4">
        {/* The lamp over the building's own panel — one per lit card (§1.2),
            and it only exists because a room in here is lit. */}
        <Lamp width={200} height={110} style={{ left: -40, top: -30 }} />
        <div className="relative flex min-w-0 items-center gap-2.5">
          <BuildingMark building={building} />
          <BuildingName building={building} onOpen={onOpenBuilding} />
          <span className="ml-auto shrink-0 text-meta text-text-faint">
            {buildingMetaCaption(building)}
          </span>
        </div>
        <WindowMap
          windows={building.windows}
          overflowCount={building.overflowCount}
          scale="home"
          className="relative"
        />
        {textRooms.length > 0 && (
          <div className="relative mt-auto flex min-w-0 flex-col gap-1">
            {textRooms.map((textRoom) => (
              <TextRoomLine
                key={textRoom.key}
                building={building}
                room={textRoom}
                mentions={mentions.get(textRoom.key) ?? 0}
                onOpenRoom={onOpenRoom}
              />
            ))}
          </div>
        )}
      </div>
    </Plate>
  );
}

/**
 * A building with nothing talking: the compact row.
 *
 * `BuildingPlate` is the building seen from the street — it owns the window
 * map, the lamp (only when something in there is lit) and the quiet tile
 * highlight. The one text room somebody is reading wraps onto its own line so
 * it survives a narrow viewport instead of squeezing the map.
 */
function QuietBuildingRow({
  building,
  mentions,
  onOpenBuilding,
  onOpenRoom,
}: HomeBuildingCardProps) {
  const textRoom = activeTextRoom(building);
  const dim = building.lightsOn === 0;

  return (
    <BuildingPlate
      building={building}
      scale="home"
      /* The map keeps its own screen-reader sentence; the counts are rendered
         once, below, so they are never announced or laid out twice. */
      caption=""
      role="group"
      aria-label={building.name}
      className="flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3"
    >
      <BuildingMark building={building} dim={dim} />
      <BuildingName building={building} dim onOpen={onOpenBuilding} />
      {/* The counts are ordered AFTER the window map rather than handed to it
          as its caption: inside the map they share a truncating box with the
          windows and vanish first on a phone. Out here the name truncates
          instead, which is the half a reader can afford to lose. */}
      <span className="order-1 ml-auto shrink-0 text-meta text-text-faint">
        {buildingMetaCaption(building)}
      </span>
      {textRoom && (
        <div className="relative order-2 basis-full">
          <TextRoomLine
            building={building}
            room={textRoom}
            mentions={mentions.get(textRoom.key) ?? 0}
            onOpenRoom={onOpenRoom}
          />
        </div>
      )}
    </BuildingPlate>
  );
}
