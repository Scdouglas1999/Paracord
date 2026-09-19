import { Volume2 } from 'lucide-react';
import { Button } from '../ui';
import { RoomThumbnail, WindowMap } from '../light';
import { VoiceParticipants } from '../light/VoiceParticipants';
import { useRoomThumbnail } from '../../hooks/useRoomThumbnail';
import { getIdentityColor } from '../../lib/colors';
import { guildInitials, resolveGuildIconUrl } from '../../lib/guildIcon';
import { cn } from '../../lib/utils';
import type { BuildingLight, RoomLight } from '../../lib/attention/light';
import { roomActivityLine, textRoomCaption } from './homeCaptions';
import { activeTextRoom, isLitBuilding, litTextRooms } from './homeModel';

export interface HomeBuildingCardProps {
  building: BuildingLight;
  /** Mention counts by room key (`entityScopeKey(scope, channelId)`). */
  mentions: ReadonlyMap<string, number>;
  onOpenBuilding: (building: BuildingLight) => void;
  onOpenRoom: (building: BuildingLight, room: RoomLight) => void;
  onJoinRoom: (building: BuildingLight, room: RoomLight) => void;
}

/** Active calls make space for people; quieter servers stay a familiar, compact row. */
export function HomeBuildingCard(props: HomeBuildingCardProps) {
  return isLitBuilding(props.building) ? <LitBuildingCard {...props} /> : <QuietBuildingRow {...props} />;
}

function BuildingHeader({ building, onOpen }: {
  building: BuildingLight;
  onOpen: (building: BuildingLight) => void;
}) {
  const src = resolveGuildIconUrl({ icon: building.icon });
  return (
    <div className="relative flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3">
      <button
        type="button"
        onClick={() => onOpen(building)}
        className="pc-focusable flex min-w-0 flex-[1_1_180px] items-center gap-3 rounded-[var(--radius-control)] text-left"
        title={building.name}
      >
        <span
          aria-hidden
          className="pc-display flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-card)] text-name font-bold text-text-on-light"
          style={{ background: src ? undefined : getIdentityColor(building.guildId) }}
        >
          {src ? <img src={src} alt="" className="h-full w-full object-cover" draggable={false} /> : guildInitials(building.name)}
        </span>
        <span className="pc-display min-w-0 truncate text-heading font-bold text-text-primary">
          {building.name}
        </span>
      </button>
      <WindowMap
        windows={building.windows}
        overflowCount={building.overflowCount}
        scale="home"
        columns={Math.min(8, Math.max(1, building.windows.length))}
        className="shrink-0"
      />
    </div>
  );
}

function TextRoomLine({ building, room, mentions, onOpenRoom }: {
  building: BuildingLight;
  room: RoomLight;
  mentions: number;
  onOpenRoom: (building: BuildingLight, room: RoomLight) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpenRoom(building, room)}
      className="pc-focusable flex min-h-8 w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-[var(--radius-control)] py-1 text-left hover:bg-bg-mod-subtle"
    >
      <span aria-hidden className={cn('pc-window shrink-0', room.lit && 'is-reading')} style={{ width: 8, height: 8 }} />
      <span className="pc-display min-w-0 max-w-full truncate text-label font-semibold text-text-primary" title={room.name}>
        {room.name}
      </span>
      <span className="min-w-0 text-meta text-text-muted">{textRoomCaption(room, mentions)}</span>
    </button>
  );
}

function LitBuildingCard({ building, mentions, onOpenBuilding, onOpenRoom, onJoinRoom }: HomeBuildingCardProps) {
  const room = building.brightestRoom as RoomLight;
  const feed = useRoomThumbnail(room);
  const hasMedia = feed.state.live && feed.frame !== null;
  const hasPublisher = Boolean(room.screenSharer || room.cameraSharer);
  const textRooms = litTextRooms(building);

  return (
    <article
      aria-label={building.name}
      className="relative min-w-0 rounded-[var(--radius-card)] bg-bg-well p-4"
    >
      <BuildingHeader building={building} onOpen={onOpenBuilding} />
      <div className={cn('mt-4 grid min-w-0 gap-4', hasMedia && 'lg:grid-cols-[minmax(0,1fr)_minmax(180px,0.8fr)]')}>
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <button
              type="button"
              onClick={() => onOpenRoom(building, room)}
              className="pc-display pc-focusable flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-control)] text-left text-heading font-semibold text-text-primary"
              title={room.name}
            >
              <Volume2 size={17} aria-hidden className="shrink-0 text-light-white" />
              <span className="min-w-0 truncate">{room.name}</span>
            </button>
            <Button size="md" variant="light" className="shrink-0" onClick={() => onJoinRoom(building, room)}>
              Join voice
            </Button>
          </div>
          <VoiceParticipants room={room} className="mt-3" />
          {hasPublisher && <p className="mt-3 break-words text-meta text-text-secondary">{roomActivityLine(room)}</p>}
        </div>
        {hasMedia && (
          <RoomThumbnail
            room={{ ...room, thumbnail: feed.state }}
            height={144}
            frame={feed.frame}
            showOccupants={false}
            className="self-center"
          />
        )}
      </div>
      {textRooms.length > 0 && (
        <div className="mt-4 flex min-w-0 flex-col gap-1 border-t border-border-subtle pt-3">
          {textRooms.map((textRoom) => (
            <TextRoomLine key={textRoom.key} building={building} room={textRoom} mentions={mentions.get(textRoom.key) ?? 0} onOpenRoom={onOpenRoom} />
          ))}
        </div>
      )}
    </article>
  );
}

function QuietBuildingRow({ building, mentions, onOpenBuilding, onOpenRoom }: HomeBuildingCardProps) {
  const textRoom = activeTextRoom(building);
  return (
    <div role="group" aria-label={building.name} className="min-w-0 px-4 py-3 sm:px-5">
      <BuildingHeader building={building} onOpen={onOpenBuilding} />
      <div className="mt-1 min-w-0 pl-14">
        {textRoom ? (
          <TextRoomLine building={building} room={textRoom} mentions={mentions.get(textRoom.key) ?? 0} onOpenRoom={onOpenRoom} />
        ) : (
          <p className="py-1 text-meta text-text-muted">
            {building.lightsOn > 0 ? `${building.lightsOn} around` : 'Quiet for now'}
          </p>
        )}
      </div>
    </div>
  );
}
