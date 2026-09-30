import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { extractApiError } from '../../../api/client';
import type { FeedUser } from '../../../api/serverFeed';
import { useCurrentChannelStore } from '../../../hooks/useChannels';
import { useCurrentAccountScope, useCurrentUser } from '../../../hooks/useCurrentUser';
import { useDownloadTicket } from '../../../hooks/useDownloadTicket';
import { useGuild } from '../../../hooks/useGuilds';
import { useBuildingLight } from '../../../hooks/useLights';
import { useMutedGuilds } from '../../../hooks/useMutedGuilds';
import { usePermissions } from '../../../hooks/usePermissions';
import { useVoice } from '../../../hooks/useVoice';
import { activateChannel } from '../../../lib/channelNavigation';
import { displayName } from '../../../lib/displayName';
import { markGuildRead } from '../../../lib/guildActions';
import { resolveGuildIconUrl } from '../../../lib/guildIcon';
import { canAccessGuildSettings } from '../../../lib/guildSettingsAccess';
import type { PersonLight, RoomLight } from '../../../lib/attention/light';
import { RECEDE_MARK, walkIntoRoom } from '../../../lib/motion';
import { entityScopeKey } from '../../../lib/serverScope';
import { resolveBannerUrl } from '../../../lib/userAvatar';
import { cn } from '../../../lib/utils';
import { useChannelStore } from '../../../stores/channelStore';
import { useMemberStore } from '../../../stores/memberStore';
import { toast } from '../../../stores/toastStore';
import { useUIStore } from '../../../stores/uiStore';
import { useGlassStore } from '../../../stores/glassStore';
import { ChannelType, type Channel } from '../../../types';
import { BuildingNotFound } from '../../guild/BuildingNotFound';
import { EventList } from '../../guild/EventList';
import { InviteModal } from '../../guild/InviteModal';
import { Modal, ModalBody, ModalHeader, ModalTitle } from '../../ui';
import { HeaderAvatar } from '../../glass/conversation/HeaderAvatar';
import { useGlassLayout } from '../../glass/shell/useGlassLayout';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../../ui/ContextMenu';
import { LiveNow } from './LiveNow';
import { liveNow } from './liveNowModel';
import { useGuildTogether } from '../../../hooks/useGuildTogether';
import { useTogetherStore } from '../../../stores/togetherStore';
import type { TogetherActivity } from '../../../lib/together/model';
import { ServerCover } from './ServerCover';
import { ServerFeed } from './ServerFeed';
import { ServerHead } from './ServerHead';
import { useServerFeed } from './useServerFeed';
import { useUpcomingEvents } from './useUpcomingEvents';
import { useSportsGames } from './widgets/GameWidget';
import { WidgetStack, type WidgetContext } from './widgets/WidgetColumn';
import { enabledWidgets } from './widgets/widgetConfig';

export interface ServerHomeProps {
  guildId: string;
}

const EMPTY_CHANNELS: Channel[] = [];
const NO_PEOPLE: PersonLight[] = [];
const NO_ROOMS: RoomLight[] = [];

function channelType(channel: Channel): number | undefined {
  return channel.type ?? channel.channel_type;
}

/** A minute is the finest thing this page says about time. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** A section that enters on the page's stagger (40 ms apart). */
function Enter({ index, className, children }: { index: number; className?: string; children: ReactNode }) {
  return (
    // A section with nothing to show renders nothing, and its wrapper must
    // not hold a gap open in its place.
    <div className={cn('pc-home-enter min-w-0 empty:hidden', className)} style={{ '--enter-index': index } as CSSProperties}>
      {children}
    </div>
  );
}

/**
 * The server home page (docs/server-home-spec.md): the first thing anybody
 * sees inside a server.
 *
 * A cover, the head across it, then two columns — what is live and what
 * people made on the left, the owner's widgets on the right. A server with
 * three people online should still feel alive, so the page leans on what
 * people posted rather than only on who is in voice this minute.
 */
export function ServerHome({ guildId }: ServerHomeProps) {
  const navigate = useNavigate();
  const guild = useGuild(guildId);
  const scope = useCurrentAccountScope();
  const viewer = useCurrentUser();
  const viewerId = viewer?.id ?? null;
  const building = useBuildingLight(guildId);
  const nowMs = useMinuteClock();

  const channels = useCurrentChannelStore((state) => state.channelsByGuild[guildId] ?? EMPTY_CHANNELS);
  const fetchChannels = useCurrentChannelStore((state) => state.fetchChannels);
  const denied = useCurrentChannelStore((state) => Boolean(state.denied[guildId]));
  const members = useMemberStore((state) => (scope ? state.members.get(entityScopeKey(scope, guildId)) : undefined));
  const fetchMembers = useMemberStore((state) => state.fetchMembers);

  const { permissions, isAdmin } = usePermissions(guildId);
  const { isMuted, toggleMute } = useMutedGuilds();
  const { joinChannel } = useVoice();
  const openGuildSettings = useUIStore((state) => state.openGuildSettings);
  const setContextPanelMode = useUIStore((state) => state.setContextPanelMode);
  const { contextMenu, onContextMenu, closeContextMenu } = useContextMenu();
  const [showInvite, setShowInvite] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);

  // The Overview is one column at every width, so the frame's layout only tells
  // it how much to shrink the mark and the title (the phone).
  const scrollRef = useRef<HTMLDivElement>(null);
  const phone = useGlassLayout() === 'phone';

  useEffect(() => {
    if (guildId && channels.length === 0) void fetchChannels(guildId);
  }, [guildId, channels.length, fetchChannels]);
  useEffect(() => {
    if (guildId && scope && !members) void fetchMembers(guildId, scope);
  }, [guildId, scope, members, fetchMembers]);

  const feed = useServerFeed(guildId);
  const { events, error: eventsError, toggleRsvp } = useUpcomingEvents(guildId);
  const sports = useSportsGames(guildId);

  // ---- channels ------------------------------------------------------------
  const channelNames = useMemo(() => new Map(channels.map((channel) => [channel.id, channel.name ?? ''])), [channels]);
  const channelName = useCallback(
    (channelId: string | null) => (channelId ? channelNames.get(channelId) || null : null),
    [channelNames],
  );
  const stageChannelIds = useMemo(
    () => new Set(channels.filter((channel) => channelType(channel) === ChannelType.Stage).map((channel) => channel.id)),
    [channels],
  );
  const announcementChannels = useMemo(
    () =>
      channels
        .filter((channel) => channelType(channel) === ChannelType.Announcement)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((channel) => ({ id: channel.id, name: channel.name ?? '' })),
    [channels],
  );
  const inviteChannelId = useMemo(
    () =>
      channels.find((channel) => {
        const type = channelType(channel);
        return type === ChannelType.Text || type === ChannelType.Announcement || type === ChannelType.Forum;
      })?.id ?? null,
    [channels],
  );

  // ---- people ----------------------------------------------------------------
  const rooms = building?.rooms ?? NO_ROOMS;
  const voiceRooms = useMemo(
    () => rooms.filter((room) => room.kind === 'voice').sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
    [rooms],
  );
  const people = useMemo(
    () =>
      [...(building?.people ?? NO_PEOPLE)].sort(
        (a, b) =>
          Number(b.level === 'on') - Number(a.level === 'on') ||
          Number(b.live) - Number(a.live) ||
          a.name.localeCompare(b.name),
      ),
    [building],
  );
  const mentionNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of members ?? []) map.set(member.user.id, displayName(member.user, member.nick));
    return map;
  }, [members]);

  // ---- live ----------------------------------------------------------------------
  useGuildTogether(guildId);
  const togetherEntries = useTogetherStore((state) => state.activities);
  const together = useMemo(() => {
    const map: Record<string, TogetherActivity | null> = {};
    for (const [channelId, entry] of Object.entries(togetherEntries)) {
      if (entry.guildId === guildId) map[channelId] = entry.activity;
    }
    return map;
  }, [togetherEntries, guildId]);
  const live = useMemo(
    () => liveNow({ rooms, stageChannelIds, events, games: sports.games, together }),
    [rooms, stageChannelIds, events, sports.games, together],
  );
  const liveGameShown = sports.games.some((game) => game.state === 'in');

  // ---- the banner ------------------------------------------------------------------
  // Subscribing to the ticket re-renders, and so re-resolves the URL, once it is minted.
  useDownloadTicket();
  const bannerUrl = guild?.banner_hash ? resolveBannerUrl(guild.banner_hash) : null;
  const iconSrc = guild ? resolveGuildIconUrl(guild) : null;

  // ---- actions -----------------------------------------------------------------
  const openChannel = useCallback((channelId: string) => navigate(`/app/guilds/${guildId}/channels/${channelId}`), [guildId, navigate]);
  const openMessage = useCallback(
    (channelId: string, messageId: string) => {
      navigate({ pathname: `/app/guilds/${guildId}/channels/${channelId}`, hash: `msg-${messageId}` });
    },
    [guildId, navigate],
  );

  /**
   * Join from the Overview: the channel's chat opens with its pill, the call is
   * joined (a stage channel only opens: its audience joins from the pill), and
   * somebody's screen, if one is shared, goes on the stage (docs/glass-spec.md §6).
   */
  const joinRoom = useCallback(
    (room: RoomLight, origin: Element | null) => {
      const sharer = room.screenSharer;
      void walkIntoRoom({
        channelId: room.channelId,
        origin,
        go: () => {
          openChannel(room.channelId);
          if (!stageChannelIds.has(room.channelId)) void joinChannel(room.channelId, guildId);
          if (sharer && scope) {
            useGlassStore.getState().openStage({
              serverId: scope.serverId,
              guildId,
              channelId: room.channelId,
              streamerId: sharer.person.userId,
            });
          }
        },
      });
    },
    [guildId, joinChannel, openChannel, stageChannelIds, scope],
  );

  const sayHi = useCallback(
    async (user: FeedUser) => {
      try {
        if (!scope) throw new Error('Sign in to this instance before messaging.');
        const channel = await useChannelStore.getState().createDm(user.id, scope);
        activateChannel(channel);
        navigate(`/app/dms/${channel.id}`);
      } catch (err) {
        toast.error(`Could not start a conversation with ${displayName(user)}: ${extractApiError(err)}`);
      }
    },
    [navigate, scope],
  );

  // Stable, so the memoised feed and widgets are not redrawn by every render
  // of the home (which re-renders whenever anybody speaks or comes online).
  const sayHiLater = useCallback((user: FeedUser) => void sayHi(user), [sayHi]);
  const rsvp = useCallback((eventId: string) => void toggleRsvp(eventId), [toggleRsvp]);
  const openCalendar = useCallback(() => setShowCalendar(true), []);
  const openMedia = useCallback(() => setContextPanelMode('media'), [setContextPanelMode]);
  const openLeaderboard = useCallback(() => setContextPanelMode('economy'), [setContextPanelMode]);

  const reference = useMemo(() => (scope ? { id: guildId, scope } : null), [guildId, scope]);
  const muted = reference ? isMuted(reference) : false;

  const widgetIds = useMemo(() => enabledWidgets(guild?.hub_settings), [guild?.hub_settings]);
  const widgetContext: WidgetContext = useMemo(
    () => ({
      guildId,
      nowMs,
      viewerId,
      events,
      eventsError,
      members,
      announcementChannels,
      mentionNames,
      liveGameShown,
      channelName,
      onRsvp: rsvp,
      onCalendar: openCalendar,
      onOpenMedia: openMedia,
      onOpenLeaderboard: openLeaderboard,
      onOpenMessage: openMessage,
      onSayHi: sayHiLater,
    }),
    [guildId, nowMs, viewerId, events, eventsError, members, announcementChannels, mentionNames,
      liveGameShown, channelName, rsvp, openCalendar, openMedia, openLeaderboard, openMessage, sayHiLater],
  );
  if (!guild && denied) return <BuildingNotFound onGoHome={() => navigate('/app')} />;
  if (!guild) {
    return (
      <div role="status" aria-label="Opening the server" className="glass-page">
        <div className="glass-page__scroll pc-skeleton" aria-hidden />
        <span className="sr-only">Opening the server…</span>
      </div>
    );
  }

  const description = (guild.hub_settings?.welcome_text as string | undefined)?.trim()
    || guild.description?.trim()
    || (guild.hub_settings?.description as string | undefined)?.trim()
    || null;

  return (
    <section aria-label={`${guild.name} home`} className="glass-page glass-ov">
      <div className="glass-page__tools glass-ov__tools">
        <HeaderAvatar />
      </div>
      <div ref={scrollRef} className="glass-page__scroll" {...{ [RECEDE_MARK]: '' }}>
        <ServerCover guildId={guildId} bannerUrl={bannerUrl} iconSrc={iconSrc} />

        <Enter index={0}>
          <ServerHead
            guildId={guildId}
            name={guild.name}
            description={description}
            iconSrc={iconSrc}
            people={people}
            online={building?.lightsOn ?? 0}
            members={building?.memberCount ?? guild.member_count ?? 0}
            muted={muted}
            phone={phone}
            onNotificationMenu={(event: ReactMouseEvent<HTMLElement>, items: ContextMenuItem[]) => {
              const box = event.currentTarget.getBoundingClientRect();
              onContextMenu(
                { preventDefault() {}, stopPropagation() {}, clientX: box.left, clientY: box.bottom + 6 } as unknown as ReactMouseEvent,
                items,
              );
            }}
            onToggleMute={() => reference && void toggleMute(reference)}
            onMarkRead={() => {
              if (!reference) return;
              void markGuildRead(reference)
                .then(() => toast.success('Marked as read.'))
                .catch((error) => toast.error(`Could not mark ${guild.name} as read: ${extractApiError(error)}`));
            }}
            onMedia={() => setContextPanelMode('media')}
            onInvite={inviteChannelId ? () => setShowInvite(true) : null}
            onSettings={canAccessGuildSettings(permissions, isAdmin) ? () => openGuildSettings(guildId) : null}
          />
        </Enter>

        <div className="glass-ov__body">
          <Enter index={1}>
            <LiveNow
              guildId={guildId}
              live={live}
              voiceRooms={voiceRooms}
              nowMs={nowMs}
              channelName={channelName}
              onJoinRoom={joinRoom}
              onOpenChannel={openChannel}
              onRsvp={(eventId) => void toggleRsvp(eventId)}
            />
          </Enter>
          <Enter index={2}>
            <WidgetStack ids={widgetIds} context={widgetContext} />
          </Enter>
          <Enter index={3}>
            <ServerFeed
              guildId={guildId}
              feed={feed}
              scrollRoot={scrollRef}
              mentionNames={mentionNames}
              viewerId={viewerId}
              nowMs={nowMs}
              onOpenMessage={openMessage}
              onOpenChannel={openChannel}
              onSayHi={sayHiLater}
            />
          </Enter>
        </div>
      </div>

      <ContextMenu
        open={contextMenu.isOpen}
        items={contextMenu.items}
        position={contextMenu.position}
        onClose={closeContextMenu}
        label="Notifications"
      />

      {showInvite && inviteChannelId && (
        <InviteModal guildName={guild.name} channelId={inviteChannelId} onClose={() => setShowInvite(false)} />
      )}

      <Modal open={showCalendar} onClose={() => setShowCalendar(false)} size="auto"
        panelClassName="w-full max-w-[min(960px,calc(100vw-2rem))]"
        labeledBy="server-calendar-title"
        showCloseButton
      >
        <ModalHeader>
          <ModalTitle id="server-calendar-title">Calendar</ModalTitle>
        </ModalHeader>
        <ModalBody>
          <EventList guildId={guildId} />
        </ModalBody>
      </Modal>
    </section>
  );
}
