import { useCallback, useEffect, useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Bell, BellOff, CheckCheck } from 'lucide-react';

import { extractApiError } from '../../../api/client';
import type { FeedUser } from '../../../api/serverFeed';
import { useCurrentChannelStore } from '../../../hooks/useChannels';
import { useCurrentAccountScope, useCurrentUser } from '../../../hooks/useCurrentUser';
import { useDownloadTicket } from '../../../hooks/useDownloadTicket';
import { useGuild } from '../../../hooks/useGuilds';
import { useBuildingLight } from '../../../hooks/useLights';
import { useMutedGuilds } from '../../../hooks/useMutedGuilds';
import { usePermissions } from '../../../hooks/usePermissions';
import { useServerReadiness, type ServerReadiness } from '../../../hooks/useServerReady';
import { activateChannel } from '../../../lib/channelNavigation';
import { displayName } from '../../../lib/displayName';
import { markGuildRead } from '../../../lib/guildActions';
import { canAccessGuildSettings } from '../../../lib/guildSettingsAccess';
import type { PersonLight } from '../../../lib/attention/light';
import { entityScopeKey } from '../../../lib/serverScope';
import { resolveBannerUrl } from '../../../lib/userAvatar';
import { cn } from '../../../lib/utils';
import { useChannelStore } from '../../../stores/channelStore';
import { useMemberStore } from '../../../stores/memberStore';
import { toast } from '../../../stores/toastStore';
import { useUIStore } from '../../../stores/uiStore';
import { ChannelType, type Channel } from '../../../types';
import { BuildingNotFound } from '../../guild/BuildingNotFound';
import { eventsHref } from '../../guild/eventsRoute';
import { InviteModal } from '../../guild/InviteModal';
import { toggleSheet } from '../../glass/sheets';
import { ServerSignedOutPage } from '../../ix/session/ServerSignedOutPage';
import { ServerWaitNote } from '../../ix/session/ServerWaitNote';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../../ui/ContextMenu';
import { ServerBanner } from './ServerBanner';
import { ServerBar } from './ServerBar';
import { ServerFeed } from './ServerFeed';
import { ServerPage } from './ServerPage';
import { useServerFeed } from './useServerFeed';
import { useUpcomingEvents } from './useUpcomingEvents';
import { WidgetStack, type WidgetContext } from './widgets/WidgetColumn';
import { enabledWidgets } from './widgets/widgetConfig';

export interface ServerHomeProps {
  guildId: string;
}

const EMPTY_CHANNELS: Channel[] = [];
const NO_PEOPLE: PersonLight[] = [];

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

/** A section that enters on the page's stagger (40 ms apart; `server-home.css`). */
function Enter({ index, className, children }: { index: number; className?: string; children: ReactNode }) {
  return (
    // A section with nothing to show renders nothing, and its wrapper must
    // not hold a gap open in its place.
    <div className={cn('ix-enter min-w-0 empty:hidden', className)} style={{ '--enter-index': index } as CSSProperties}>
      {children}
    </div>
  );
}

/**
 * Static blocks in the page's own geometry while the server is still loading. A server that
 * is unreachable says so above them (connecting is just this loading state).
 */
function OverviewSkeleton({ readiness }: { readiness: ServerReadiness }) {
  return (
    <div className="ix-skeleton" role="status" aria-label="Opening the server" aria-busy="true" data-testid="ix-loading">
      {!readiness.ready && <ServerWaitNote readiness={readiness} />}
      <div className="ix-skeleton__head" aria-hidden>
        <span className="ix-skeleton__title" />
        <span className="ix-skeleton__sub" />
      </div>
      <div className="ix-skeleton__cards" aria-hidden>
        <span className="ix-skeleton__card" />
        <span className="ix-skeleton__card" />
      </div>
      <span className="sr-only">Opening the server…</span>
    </div>
  );
}

/**
 * A server's Overview (docs/index-spec.md §8.1): a page in main with the large title
 * (the server's name, its description under it), a row of who is here and what you can
 * do from the front page, the owner's widgets in a two-column grid, then what people
 * made lately. What is live is not here: the room card in the sidebar shows it (§4.3).
 *
 * A server with three people online should still feel alive, so the page leans on what
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
  const openGuildSettings = useUIStore((state) => state.openGuildSettings);
  const setContextPanelMode = useUIStore((state) => state.setContextPanelMode);
  const { contextMenu, onContextMenu, closeContextMenu } = useContextMenu();
  const [showInvite, setShowInvite] = useState(false);

  useEffect(() => {
    // Nothing to ask as until this server's account is here (it is not connected yet).
    if (guildId && scope && channels.length === 0) void fetchChannels(guildId);
  }, [guildId, scope, channels.length, fetchChannels]);
  useEffect(() => {
    if (guildId && scope && !members) void fetchMembers(guildId, scope);
  }, [guildId, scope, members, fetchMembers]);

  // The Overview reads the selected server; while that server is not connected its widgets
  // wait (no request, no error) and the page says where the server stands.
  const readiness = useServerReadiness();
  const feed = useServerFeed(guildId);
  const { events, error: eventsError, toggleRsvp } = useUpcomingEvents(guildId);

  // ---- channels ------------------------------------------------------------
  const channelNames = useMemo(() => new Map(channels.map((channel) => [channel.id, channel.name ?? ''])), [channels]);
  const channelName = useCallback(
    (channelId: string | null) => (channelId ? channelNames.get(channelId) || null : null),
    [channelNames],
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

  // ---- the banner ------------------------------------------------------------------
  // Subscribing to the ticket re-renders, and so re-resolves the URL, once it is minted.
  useDownloadTicket();
  const bannerUrl = guild?.banner_hash ? resolveBannerUrl(guild.banner_hash) : null;

  // ---- actions -----------------------------------------------------------------
  const openMessage = useCallback(
    (channelId: string, messageId: string) => {
      navigate({ pathname: `/app/guilds/${guildId}/channels/${channelId}`, hash: `msg-${messageId}` });
    },
    [guildId, navigate],
  );
  const openChannel = useCallback((channelId: string) => navigate(`/app/guilds/${guildId}/channels/${channelId}`), [guildId, navigate]);

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
  const openCalendar = useCallback(() => navigate(eventsHref(guildId)), [guildId, navigate]);
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
      channelName,
      onRsvp: rsvp,
      onCalendar: openCalendar,
      onOpenMedia: openMedia,
      onOpenLeaderboard: openLeaderboard,
      onOpenMessage: openMessage,
      onSayHi: sayHiLater,
    }),
    [guildId, nowMs, viewerId, events, eventsError, members, announcementChannels, mentionNames,
      channelName, rsvp, openCalendar, openMedia, openLeaderboard, openMessage, sayHiLater],
  );
  if (!guild && denied) return <BuildingNotFound onGoHome={() => navigate('/app')} />;
  if (!guild && readiness.server && readiness.phase === 'signed-out') return <ServerSignedOutPage server={readiness.server} />;
  if (!guild) return <OverviewSkeleton readiness={readiness} />;

  const description = (guild.hub_settings?.welcome_text as string | undefined)?.trim()
    || guild.description?.trim()
    || (guild.hub_settings?.description as string | undefined)?.trim()
    || null;

  const bellItems: ContextMenuItem[] = [
    {
      label: muted ? 'Unmute server' : 'Mute server',
      description: muted ? 'Notifications from this server come back.' : 'No notifications from this server.',
      icon: muted ? <Bell size={16} /> : <BellOff size={16} />,
      action: () => reference && void toggleMute(reference),
    },
    {
      label: 'Mark as read',
      icon: <CheckCheck size={16} />,
      action: () => {
        if (!reference) return;
        void markGuildRead(reference)
          .then(() => toast.success('Marked as read.'))
          .catch((error) => toast.error(`Could not mark ${guild.name} as read: ${extractApiError(error)}`));
      },
    },
  ];
  const openNotificationMenu = (event: ReactMouseEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    onContextMenu(
      { preventDefault() {}, stopPropagation() {}, clientX: box.left, clientY: box.bottom + 6 } as unknown as ReactMouseEvent,
      bellItems,
    );
  };

  return (
    <ServerPage guildId={guildId} title={guild.name} subtitle={description ?? undefined} data-testid="ix-overview">
      <section aria-label={`${guild.name} home`} className="ix-ov">
        <Enter index={0}>
          <ServerBar
            people={people}
            online={building?.lightsOn ?? 0}
            members={building?.memberCount ?? guild.member_count ?? 0}
            muted={muted}
            onMembers={() => toggleSheet('people')}
            onNotificationMenu={openNotificationMenu}
            onEvents={openCalendar}
            onMedia={openMedia}
            onInvite={inviteChannelId ? () => setShowInvite(true) : null}
            onSettings={canAccessGuildSettings(permissions, isAdmin) ? () => openGuildSettings(guildId) : null}
          />
        </Enter>
        {bannerUrl && (
          <Enter index={1}>
            <ServerBanner bannerUrl={bannerUrl} />
          </Enter>
        )}
        <Enter index={2}>
          <WidgetStack ids={widgetIds} context={widgetContext} />
        </Enter>
        <Enter index={3}>
          <ServerFeed
            guildId={guildId}
            feed={feed}
            mentionNames={mentionNames}
            viewerId={viewerId}
            nowMs={nowMs}
            onOpenMessage={openMessage}
            onOpenChannel={openChannel}
            onSayHi={sayHiLater}
          />
        </Enter>
      </section>

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
    </ServerPage>
  );
}
