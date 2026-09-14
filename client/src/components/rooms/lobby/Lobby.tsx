import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { useCurrentChannelStore } from '../../../hooks/useChannels';
import { useCurrentMessageStore } from '../../../hooks/useMessageStore';
import { useCurrentAccountScope } from '../../../hooks/useCurrentUser';
import { useGuild } from '../../../hooks/useGuilds';
import { useAroundNow, useBuildingLight } from '../../../hooks/useLights';
import { useRoomThumbnail } from '../../../hooks/useRoomThumbnail';
import { useMutedGuilds } from '../../../hooks/useMutedGuilds';
import { menuEventAt, useRoomMenu } from '../../../hooks/useRoomMenu';
import { usePermissions } from '../../../hooks/usePermissions';
import { useUnreadCounts } from '../../../hooks/useUnreadCounts';
import { useVoice } from '../../../hooks/useVoice';
import { canAccessGuildSettings } from '../../../lib/guildSettingsAccess';
import { resolveGuildIconUrl } from '../../../lib/guildIcon';
import { displayName } from '../../../lib/displayName';
import { snowflakeToMs } from '../../../lib/attention/conversationModel';
import { entityScopeKey } from '../../../lib/serverScope';
import { useMemberStore } from '../../../stores/memberStore';
import { useUIStore } from '../../../stores/uiStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { ChannelType, Permissions, hasPermission, type Channel } from '../../../types';
import type { PersonLight, RoomLight } from '../../../lib/attention/light';
import { RECEDE_MARK, walkIntoRoom } from '../../../lib/motion';
import { BuildingNotFound } from '../../guild/BuildingNotFound';
import { InviteModal } from '../../guild/InviteModal';
import { Plate } from '../../ui';
import { ContextMenu, useContextMenu } from '../../ui/ContextMenu';
import { AroundNowWell } from './AroundNowWell';
import { EventCard } from './EventCard';
import { LobbyHeader } from './LobbyHeader';
import { MediaStrip } from './MediaStrip';
import { AddRoomTile, RoomCard } from './RoomCard';
import { TextRoomRow } from './TextRoomRow';
import {
  NOBODY_IN_A_ROOM,
  headerLine,
  lightsOnOfCaption,
  nextEventCaption,
  roomsLitCaption,
} from './lobbyCaptions';
import { featuredFirst, readHubWelcome } from './hubWelcome';
import { shortClock, trafficStamp } from './lobbyTime';
import { useNextEvent } from './useNextEvent';
import { messageTimeMs, useRecentMedia } from './useRecentMedia';
import { useRoomPreviews, type PreviewRequest } from './useRoomPreviews';

export interface LobbyProps {
  guildId: string;
}

const EMPTY_CHANNELS: Channel[] = [];
const NO_ROOMS: RoomLight[] = [];
const NO_PEOPLE: PersonLight[] = [];

function isTextDestination(channel: Channel): boolean {
  const type = channel.type ?? channel.channel_type;
  return (
    type === ChannelType.Text ||
    type === ChannelType.Announcement ||
    type === ChannelType.Forum
  );
}

/** Lit rooms first, then the dark ones in the order the building arranged them. */
function orderVoiceRooms(rooms: readonly RoomLight[]): RoomLight[] {
  return [...rooms].sort(
    (a, b) =>
      Number(b.lit) - Number(a.lit) ||
      b.occupants.length - a.occupants.length ||
      a.order - b.order ||
      a.name.localeCompare(b.name),
  );
}

/**
 * The Lobby — a building seen from the street
 * (docs/lantern-stage-spec.md §7.3, on the IA of `docs/layout-spec.md` §7).
 *
 * Header · Around now · the rooms grid (lit cards, dark cards, and an add tile
 * for whoever can open one) · what is coming up and what has been passed around
 * · the text rooms as rows. Every light on this surface comes from WP1's
 * selectors — nothing here re-derives who is talking or reading (WP1 §9).
 *
 * Two sections are **omitted entirely** when they are empty rather than drawn as
 * a placeholder: the event card and the media strip (§7.3).
 *
 * The building's hub settings land here too, each in the place it is already
 * true of the Lobby rather than in a briefing block of their own: the operator's
 * welcome line becomes the header's sentence, the banner a thin band above it,
 * and the rooms they featured come first. See `hubWelcome.ts`.
 */
export function Lobby({ guildId }: LobbyProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const guild = useGuild(guildId);
  const scope = useCurrentAccountScope();
  const building = useBuildingLight(guildId);
  const buildings = useMemo(() => (building ? [building] : []), [building]);
  // With lights on but nobody in a room, WP1's default empty sentence would
  // contradict the "+N lights on" count beside it.
  const emptySentence = (building?.lightsOn ?? 0) > 0 ? NOBODY_IN_A_ROOM : undefined;
  const sentence = useAroundNow(buildings, 3, emptySentence);

  const channels = useCurrentChannelStore(
    (state) => state.channelsByGuild[guildId] ?? EMPTY_CHANNELS,
  );
  const fetchChannels = useCurrentChannelStore((state) => state.fetchChannels);
  // The building answered "not yours" (or "no such building"). Following a
  // stale link is the most ordinary way to arrive here, so it gets a state and
  // a way out rather than an indefinite skeleton behind two API-worded toasts.
  const denied = useCurrentChannelStore((state) => Boolean(state.denied[guildId]));
  const members = useMemberStore((state) =>
    scope ? state.members.get(entityScopeKey(scope, guildId)) : undefined,
  );
  const fetchMembers = useMemberStore((state) => state.fetchMembers);
  const messagesByChannel = useCurrentMessageStore((state) => state.messages);

  const { permissions, isAdmin } = usePermissions(guildId);
  const { mutedGuildKeys } = useMutedGuilds();
  const { isChannelUnread, channelMentionCounts } = useUnreadCounts(mutedGuildKeys);
  const { joinChannel } = useVoice();
  const openGuildSettings = useUIStore((state) => state.openGuildSettings);
  const [showInvite, setShowInvite] = useState(false);
  /**
   * The room menu, the same one the Buildings column opens (§7.1).
   *
   * A phone never renders that column — it reaches its rooms through here — so
   * until this the notification level, "mark room as read" and "copy link to
   * room" existed for one form factor out of two. Every room row and card on
   * this surface now takes a right-click, a long press, and a visible "…".
   */
  const { contextMenu, onContextMenu, closeContextMenu } = useContextMenu();
  const roomMenu = useRoomMenu();
  const openRoomMenu = (event: ReactMouseEvent<HTMLElement>, room: RoomLight) =>
    onContextMenu(menuEventAt(event), roomMenu(room));

  useEffect(() => {
    if (guildId && channels.length === 0) void fetchChannels(guildId);
  }, [guildId, channels.length, fetchChannels]);

  useEffect(() => {
    if (guildId && scope && !members) void fetchMembers(guildId, scope);
  }, [guildId, scope, members, fetchMembers]);

  const stageChannelIds = useMemo(
    () =>
      new Set(
        channels
          .filter((channel) => (channel.type ?? channel.channel_type) === ChannelType.Stage)
          .map((channel) => channel.id),
      ),
    [channels],
  );
  const channelNames = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel.name ?? ''])),
    [channels],
  );
  const lastMessageIds = useMemo(
    () =>
      new Map(
        channels
          .filter((channel) => typeof channel.last_message_id === 'string')
          .map((channel) => [channel.id, channel.last_message_id as string]),
      ),
    [channels],
  );

  // What the building's operator wrote about it: one welcome line, a thin
  // banner, and the rooms they chose to put first (§7.3, `hubWelcome.ts`).
  const hub = useMemo(() => readHubWelcome(guild?.hub_settings), [guild?.hub_settings]);

  const rooms = useMemo(() => building?.rooms ?? NO_ROOMS, [building]);
  const featuredIds = hub.featuredChannelIds;
  const featuredSet = useMemo(() => new Set(featuredIds), [featuredIds]);
  const voiceRooms = useMemo(
    () => featuredFirst(orderVoiceRooms(rooms.filter((room) => room.kind === 'voice')), featuredIds),
    [rooms, featuredIds],
  );
  // Two grids, because the two cards are two different shapes (§7.3): a lit
  // card is 250px tall because it is carrying a picture of people, and a dark
  // one is the height of its own words. In one grid CSS would stretch every
  // dark card in a row up to the lit card beside it, which is the empty
  // rectangle this surface is trying to stop drawing.
  const litRooms = useMemo(() => voiceRooms.filter((room) => room.lit), [voiceRooms]);
  const darkRooms = useMemo(() => voiceRooms.filter((room) => !room.lit), [voiceRooms]);
  const textRooms = useMemo(
    () =>
      featuredFirst(
        [...rooms.filter((room) => room.kind === 'text')].sort(
          (a, b) =>
            Number(b.lit) - Number(a.lit) ||
            b.readingCount - a.readingCount ||
            a.order - b.order ||
            a.name.localeCompare(b.name),
        ),
        featuredIds,
      ),
    [rooms, featuredIds],
  );
  const textChannelIds = useMemo(
    () => channels.filter(isTextDestination).map((channel) => channel.id),
    [channels],
  );

  const { event, toggleRsvp } = useNextEvent(guildId);
  const media = useRecentMedia(textChannelIds);

  // §7.3 asks each text room for its last author, time and line. The rooms this
  // client has opened already have one in the message store; the rest are asked
  // for it once, through a read-only door that cannot disturb the open room's
  // own history (see `useRoomPreviews`).
  const previewRequests = useMemo<PreviewRequest[]>(
    () =>
      textRooms
        .filter((room) => (messagesByChannel[room.channelId] ?? []).length === 0)
        .map((room) => ({
          channelId: room.channelId,
          lastMessageId: lastMessageIds.get(room.channelId) ?? null,
        })),
    [textRooms, messagesByChannel, lastMessageIds],
  );
  const previews = useRoomPreviews(previewRequests);

  /**
   * The faces in the Around-now well (§7.3, §8 HereNowStrip).
   *
   * `useBuildingPeople` only knew about people who were *in a room*, so a
   * building where somebody had the app open but was in no room drew an empty
   * stack beside a bare "+1 lights on" chip — the count and the picture
   * disagreeing about the same person. `building.people` is everybody the
   * building can see, which is what the count is drawn from too.
   *
   * Who gets a face: somebody whose lights are on, or somebody who is visibly
   * in a room. Nobody else. Light is state (§0), so a stack of matte strangers
   * under the words "Around now" would be five people who are not around — and
   * a person standing in a voice room is around whatever their presence says.
   *
   * The people *in rooms* come first, because they are who the sentence beside
   * the stack is about ("Priya and Ren are in Shop floor"); with more lit
   * people than faces, the stack must not overflow the ones it is naming.
   */
  const litPeople = useMemo(
    () =>
      (building?.people ?? NO_PEOPLE)
        .filter((person) => person.lit || inARoom(person))
        .sort(
          (a, b) =>
            Number(inARoom(b)) - Number(inARoom(a)) ||
            Number(b.lit) - Number(a.lit) ||
            a.name.localeCompare(b.name),
        ),
    [building],
  );

  const selectedChannelId = useMemo(() => {
    const match = location.pathname.match(/\/channels\/([^/]+)/);
    return match ? match[1] : null;
  }, [location.pathname]);

  const inviteChannelId = useMemo(
    () => channels.find(isTextDestination)?.id ?? null,
    [channels],
  );

  const canManage = canAccessGuildSettings(permissions, isAdmin);
  const canOpenRoom = isAdmin || hasPermission(permissions, Permissions.MANAGE_CHANNELS);

  const hostName = useMemo(() => {
    if (!event?.creatorId || !members) return null;
    const host = members.find((member) => member.user.id === event.creatorId);
    return host ? displayName(host.user, host.nick) : null;
  }, [event?.creatorId, members]);

  const summary = headerLine([
    lightsOnOfCaption(building?.lightsOn ?? 0, building?.memberCount ?? 0),
    roomsLitCaption(building?.roomsLit ?? 0),
    event ? nextEventCaption(event.name, shortClock(event.startsAt)) : null,
  ]);

  const openChannel = (channelId: string) =>
    navigate(`/app/guilds/${guildId}/channels/${channelId}`);

  /**
   * You do not teleport into a room, you walk in (§5.1).
   *
   * The route changes inside the transition's update callback with nothing
   * awaited in front of it, so navigation is never behind an animation; the
   * card you clicked becomes the Stage's dominant tile and the rest of the
   * Lobby recedes behind it.
   */
  const walkIn = (room: RoomLight, origin: Element | null | undefined, go: () => void) => {
    void walkIntoRoom({ channelId: room.channelId, origin, go });
  };

  const enterRoom = (room: RoomLight, origin?: Element | null) => {
    const sharer = room.screenSharer ?? room.cameraSharer;
    if (sharer) useVoiceStore.getState().setWatchedStreamer(sharer.person.userId);
    walkIn(room, origin, () => openChannel(room.channelId));
  };

  /**
   * Joining takes you into the room — the Stage is where the room is (§7.2).
   * Before WP9b the Lobby joined the call and left you standing in the street,
   * which is the one thing "walk into a room" cannot mean.
   */
  const joinRoom = (room: RoomLight, origin?: Element | null) => {
    walkIn(room, origin, () => {
      openChannel(room.channelId);
      if (!stageChannelIds.has(room.channelId)) {
        void joinChannel(room.channelId, guildId);
      }
    });
  };

  if (!guild && denied) return <BuildingNotFound onGoHome={() => navigate('/app')} />;

  if (!guild) {
    return (
      <div role="status" aria-label="Loading the lobby" className="h-full bg-bg-base p-[var(--gutter)]">
        <Plate as="section" className="h-full pc-skeleton" aria-hidden />
        <span className="sr-only">Opening the lobby…</span>
      </div>
    );
  }

  return (
    <div className="h-full overflow-hidden bg-bg-base p-[var(--gutter)]">
      <Plate
        as="section"
        aria-label="Lobby"
        bare
        // §5.1: the rest of the Lobby steps back while the card you clicked
        // travels. `recedeAround` recedes every branch except the one the
        // origin is on.
        {...{ [RECEDE_MARK]: '' }}
        className="flex h-full flex-col gap-[18px] overflow-y-auto scrollbar-thin px-4 py-5 sm:px-6 sm:py-[22px]"
      >
        {/* The building's own picture, as a band and nothing more: no gradient,
            no text over it, no hero (§6.1, §6.2). It is 64px tall so the rooms
            below stay on screen. */}
        {hub.bannerSrc && (
          <img
            src={hub.bannerSrc}
            alt=""
            draggable={false}
            className={
              '-mx-4 -mt-5 h-16 w-full shrink-0 object-cover sm:-mx-6 sm:-mt-[22px] '
              + 'rounded-t-[var(--radius-plate)]'
            }
          />
        )}

        <LobbyHeader
          guildId={guildId}
          name={guild.name}
          iconSrc={resolveGuildIconUrl(guild)}
          summary={summary}
          welcome={hub.welcome}
          onInvite={inviteChannelId ? () => setShowInvite(true) : undefined}
          onSettings={canManage ? () => openGuildSettings(guildId) : undefined}
        />

        <AroundNowWell
          people={litPeople}
          sentence={sentence}
          lightsOn={building?.lightsOn ?? 0}
        />

        <section aria-label="Rooms" className="flex flex-col gap-3">
          {voiceRooms.length === 0 && !canOpenRoom ? (
            <p className="text-label text-text-muted">
              This building has no rooms yet — its text rooms are below.
            </p>
          ) : (
            <>
              {litRooms.length > 0 && (
                <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
                  {litRooms.map((room) => (
                    <LobbyRoomCard
                      key={room.key}
                      room={room}
                      isStage={stageChannelIds.has(room.channelId)}
                      onEnter={(origin) => enterRoom(room, origin)}
                      onJoin={(origin) => joinRoom(room, origin)}
                      onMenu={(event) => openRoomMenu(event, room)}
                    />
                  ))}
                </div>
              )}
              {(darkRooms.length > 0 || canOpenRoom) && (
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                  {darkRooms.map((room) => (
                    <LobbyRoomCard
                      key={room.key}
                      room={room}
                      isStage={stageChannelIds.has(room.channelId)}
                      onEnter={(origin) => enterRoom(room, origin)}
                      onJoin={(origin) => joinRoom(room, origin)}
                      onMenu={(event) => openRoomMenu(event, room)}
                    />
                  ))}
                  {canOpenRoom && (
                    <AddRoomTile onClick={() => openGuildSettings(guildId, 'channels')} />
                  )}
                </div>
              )}
            </>
          )}
        </section>

        {(event || media.items.length > 0) && (
          <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
            {event && (
              <EventCard
                event={event}
                where={
                  (event.channelId ? channelNames.get(event.channelId) : null) || event.location
                }
                host={hostName}
                onRsvp={() => void toggleRsvp()}
              />
            )}
            {media.items.length > 0 && (
              <MediaStrip
                buildingName={guild.name}
                items={media.items}
                weekCount={media.weekCount}
                onOpen={(item) => openChannel(item.channelId)}
              />
            )}
          </div>
        )}

        {/* The text rooms carry no visible heading: every row names itself, and
            the reference render puts nothing above them. The landmark is named
            for assistive tech instead. */}
        {textRooms.length > 0 && (
          <section aria-label="Text rooms">
            <div className="grid grid-cols-1 gap-x-5 gap-y-2.5 xl:grid-cols-2">
              {textRooms.map((room) => {
                const loaded = messagesByChannel[room.channelId] ?? [];
                const last = loaded.length > 0 ? loaded[loaded.length - 1] : null;
                const fetched = previews.get(room.channelId) ?? null;
                // A loaded message carries its own stamp; a fetched line carries
                // its own; an unopened room we could not read has only the
                // channel's last snowflake to go on.
                const fallbackId = lastMessageIds.get(room.channelId) ?? null;
                const atMs = last
                  ? messageTimeMs(last)
                  : fetched
                    ? fetched.atMs
                    : fallbackId
                      ? snowflakeMs(fallbackId)
                      : null;
                const author = last?.author ? displayName(last.author) : fetched?.author ?? null;
                const preview = last ? last.content ?? null : fetched?.preview || null;
                // Nothing loaded, nothing fetched and no snowflake: the room has
                // genuinely never been written in, and says so rather than
                // rendering as three blanks (§6.9).
                const silent = !last && !fetched && !fallbackId;
                return (
                  <TextRoomRow
                    key={room.key}
                    room={room}
                    active={selectedChannelId === room.channelId}
                    unread={isChannelUnread.has(room.channelId)}
                    mentionCount={channelMentionCounts.get(room.channelId) ?? 0}
                    lastAuthor={author}
                    lastAt={atMs != null ? trafficStamp(atMs, Date.now()) : null}
                    preview={preview}
                    silent={silent}
                    featured={featuredSet.has(room.channelId)}
                    onOpen={() => openChannel(room.channelId)}
                    onMenu={(event) => openRoomMenu(event, room)}
                  />
                );
              })}
            </div>
          </section>
        )}
      </Plate>

      <ContextMenu
        open={contextMenu.isOpen}
        items={contextMenu.items}
        position={contextMenu.position}
        onClose={closeContextMenu}
      />

      {showInvite && inviteChannelId && (
        <InviteModal
          guildName={guild.name}
          channelId={inviteChannelId}
          onClose={() => setShowInvite(false)}
        />
      )}
    </div>
  );
}

/** Somebody the building can actually see standing in one of its rooms. */
function inARoom(person: PersonLight): boolean {
  return person.live || person.roomName != null;
}

/** Paracord snowflake → ms, without throwing on anything that is not one. */
function snowflakeMs(id: string): number | null {
  if (!/^\d{1,19}$/.test(id)) return null;
  try {
    return snowflakeToMs(id);
  } catch {
    return null;
  }
}

/**
 * One card, wired to its own thumbnail feed.
 *
 * `useRoomThumbnail` is a hook, so the grid cannot loop it — each card owns its
 * own tap. The tap is a read-only sampler on the engine that is already running
 * (WP1 §4); a room this client is not in has no decoder anywhere on the device
 * and honestly shows a still plus the LIVE dot.
 */
function LobbyRoomCard({
  room,
  isStage,
  onEnter,
  onJoin,
  onMenu,
}: {
  room: RoomLight;
  isStage: boolean;
  onEnter: (origin?: Element | null) => void;
  onJoin: (origin?: Element | null) => void;
  onMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const { frame } = useRoomThumbnail(room);
  return (
    <RoomCard
      room={room}
      frame={frame}
      onEnter={room.lit ? onEnter : undefined}
      onJoin={onJoin}
      joinLabel={isStage ? 'Enter' : room.lit ? 'Join' : 'Open'}
      onMenu={onMenu}
    />
  );
}

