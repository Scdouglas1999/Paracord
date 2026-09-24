import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
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
import { useVoiceStore } from '../../../stores/voiceStore';
import { ChannelType, type Channel } from '../../../types';
import { BuildingNotFound } from '../../guild/BuildingNotFound';
import { EventList } from '../../guild/EventList';
import { InviteModal } from '../../guild/InviteModal';
import { Modal, ModalBody, ModalHeader, ModalTitle, Plate } from '../../ui';
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
import { HomeWidget, WidgetStack, type WidgetContext } from './widgets/WidgetColumn';
import { enabledWidgets } from './widgets/widgetConfig';

export interface ServerHomeProps {
  guildId: string;
}

const EMPTY_CHANNELS: Channel[] = [];
const NO_PEOPLE: PersonLight[] = [];
const NO_ROOMS: RoomLight[] = [];

/** Below this the plate is a phone: one column, widgets folded into the feed. */
export const PHONE_MAX = 700;
/** From here the widget column is the spec's full 340px. */
export const WIDE_MIN = 1000;

type Layout = 'phone' | 'medium' | 'wide';

function layoutFor(width: number): Layout {
  if (width < PHONE_MAX) return 'phone';
  return width >= WIDE_MIN ? 'wide' : 'medium';
}

function channelType(channel: Channel): number | undefined {
  return channel.type ?? channel.channel_type;
}

/** The plate's own width, which is what the layout answers to (not the window's). */
function usePlateLayout(ref: React.RefObject<HTMLElement | null>): Layout {
  const [layout, setLayout] = useState<Layout>(() =>
    typeof window !== 'undefined' ? layoutFor(window.innerWidth) : 'wide',
  );
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setLayout(layoutFor(node.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  });
  return layout;
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

  const plateRef = useRef<HTMLElement>(null);
  const layout = usePlateLayout(plateRef);
  const phone = layout === 'phone';

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
    () => liveNow({ rooms, stageChannelIds, events, games: phone ? [] : sports.games, together }),
    [rooms, stageChannelIds, events, sports.games, phone, together],
  );
  const liveGameShown = !phone && sports.games.some((game) => game.state === 'in');

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

  /** You walk into a call rather than teleport (lib/motion/walk.ts). */
  const joinRoom = useCallback(
    (room: RoomLight, origin: Element | null) => {
      const sharer = room.screenSharer ?? room.cameraSharer;
      if (sharer) useVoiceStore.getState().setWatchedStreamer(sharer.person.userId);
      void walkIntoRoom({
        channelId: room.channelId,
        origin,
        go: () => {
          openChannel(room.channelId);
          if (!stageChannelIds.has(room.channelId)) void joinChannel(room.channelId, guildId);
        },
      });
    },
    [guildId, joinChannel, openChannel, stageChannelIds],
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
  const phoneRest = useMemo(
    () => (phone ? widgetIds.filter((id) => id !== 'coming_up') : []),
    [phone, widgetIds],
  );
  const interleave = useMemo(
    () => (phone && phoneRest.length > 0 ? <WidgetStack ids={phoneRest} context={widgetContext} /> : undefined),
    [phone, phoneRest, widgetContext],
  );

  if (!guild && denied) return <BuildingNotFound onGoHome={() => navigate('/app')} />;
  if (!guild) {
    return (
      <div role="status" aria-label="Opening the server" className="h-full bg-bg-base p-[var(--gutter)]">
        <Plate as="section" className="h-full pc-skeleton" aria-hidden />
        <span className="sr-only">Opening the server…</span>
      </div>
    );
  }

  const description = (guild.hub_settings?.welcome_text as string | undefined)?.trim()
    || guild.description?.trim()
    || (guild.hub_settings?.description as string | undefined)?.trim()
    || null;

  const phoneFirst = phone && widgetIds.includes('coming_up');

  return (
    <div className="h-full overflow-hidden bg-bg-base p-[var(--gutter)]">
      <Plate
        ref={plateRef}
        as="section"
        aria-label={`${guild.name} home`}
        bare
        {...{ [RECEDE_MARK]: '' }}
        className="relative h-full overflow-y-auto overflow-x-hidden scrollbar-thin"
      >
        <ServerCover guildId={guildId} bannerUrl={bannerUrl} iconSrc={iconSrc} height={phone ? 150 : 180} />

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

        <div
          className={cn(
            'grid items-start',
            phone ? 'grid-cols-1 gap-6 px-4 pb-8 pt-6' : 'gap-7 px-8 pb-12 pt-8',
            layout === 'wide' && 'grid-cols-[minmax(0,1fr)_340px]',
            layout === 'medium' && 'grid-cols-[minmax(0,1fr)_288px]',
          )}
        >
          <main className="flex min-w-0 flex-col gap-7">
            <Enter index={1}>
              <LiveNow
                guildId={guildId}
                live={live}
                voiceRooms={voiceRooms}
                phone={phone}
                channelName={channelName}
                onJoinRoom={joinRoom}
                onOpenChannel={openChannel}
                onRsvp={(eventId) => void toggleRsvp(eventId)}
              />
            </Enter>
            {phoneFirst && (
              <Enter index={2}>
                <HomeWidget id="coming_up" context={widgetContext} />
              </Enter>
            )}
            <Enter index={phone ? 3 : 2}>
              <ServerFeed
                guildId={guildId}
                feed={feed}
                scrollRoot={plateRef}
                mentionNames={mentionNames}
                viewerId={viewerId}
                nowMs={nowMs}
                interleave={interleave}
                onOpenMessage={openMessage}
                onOpenChannel={openChannel}
                onSayHi={sayHiLater}
                compact={phone}
              />
            </Enter>
          </main>

          {!phone && (
            <aside aria-label="Widgets" className="min-w-0">
              <Enter index={3}>
                <WidgetStack ids={widgetIds} context={widgetContext} />
              </Enter>
            </aside>
          )}
        </div>
      </Plate>

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
        labelledBy="server-calendar-title"
        showCloseButton
      >
        <ModalHeader>
          <ModalTitle id="server-calendar-title">Calendar</ModalTitle>
        </ModalHeader>
        <ModalBody>
          <EventList guildId={guildId} />
        </ModalBody>
      </Modal>
    </div>
  );
}
