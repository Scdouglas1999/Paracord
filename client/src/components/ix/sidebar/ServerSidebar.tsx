import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { extractApiError } from '../../../api/client';
import { useAvailableGuilds } from '../../../hooks/useGuilds';
import { activateGuild } from '../../../lib/guildNavigation';
import { serverHue } from '../../../lib/identityHue';
import { useChannelStore } from '../../../stores/channelStore';
import { useMemberStore } from '../../../stores/memberStore';
import { toast } from '../../../stores/toastStore';
import { ErrorBoundary } from '../../ErrorBoundary';
import { eventsHref } from '../../guild/eventsRoute';
import { headerLine } from '../../glass/places/model';
import { useServerSidebar } from '../../glass/places/usePlacesData';
import type { SidebarRoom } from '../../glass/places/rows';
import type { HomeEvent } from '../../rooms/lobby/useUpcomingEvents';
import { ContextMenu, useContextMenu } from '../../ui/ContextMenu';
import { CardSlot, useInlineCardRoom } from '../card';
import { anchorFromEvent, openCreateChannel, openServerMenu, useServerMenuOpenFor } from '../menus';
import { serverPlace, useOptionalIxShell } from '../shell';
import { AddonList } from './AddonList';
import { ChannelList, keepsVisible } from './ChannelList';
import { ComingUp, comingUp, eventIdOf } from './ComingUp';
import { RoomList } from './RoomList';
import { SearchField } from './SearchField';
import { SidebarHeader } from './SidebarHeader';
import { ADDON_ID, useAddons, type AddonModel } from './useAddons';
import { useCollapse } from './useCollapse';
import { rovingKeyDown, useRovingList } from './useRovingList';
import { SELECTED_ATTRIBUTE, useSelectionGlide } from './useSelectionGlide';
import { useSidebarMenus } from './useSidebarMenus';

/**
 * The server's sidebar pane (docs/index-spec.md §3.1, §4.1-4.7): the header, the
 * search field, the live room card's inline slot, the channels by category, the
 * rooms, the add-ons and Coming up. The pane (`.ix-pane`) is the scroller and the
 * frame's; this fills it.
 *
 * The pane reads its place from its props, never the route (a pane that is
 * sliding out keeps showing the server it was for). It is one component for the
 * entering and the leaving pane; the leaving one plays nothing and moves nothing.
 *
 * Keyboard: header, "…" and the search field are ordinary stops; the rows below
 * are one stop, reached with the arrow keys (Up, Down, Home, End), Enter opens,
 * and Left and Right close and open a category.
 */

const CHANNELS = (guildId: string, channelId: string) => `/app/guilds/${guildId}/channels/${channelId}`;

export interface ServerSidebarProps {
  guildId: string;
  leaving?: boolean;
}

export function ServerSidebar({ guildId, leaving = false }: ServerSidebarProps) {
  const guild = useAvailableGuilds().find((candidate) => candidate.id === guildId) ?? null;
  // The roster and channel list of a server the pane is about to show: the route's page loads them
  // for the server you are in, and nothing else does for one you are sliding to.
  useServerRoster(guild);
  if (!guild) {
    return (
      <div className="ix-sb">
        <p className="ix-sb__note">This server is not available.</p>
      </div>
    );
  }
  return (
    <ErrorBoundary variant="section" label="Channels">
      <ServerPane guild={guild} leaving={leaving} />
    </ErrorBoundary>
  );
}

type Guild = NonNullable<ReturnType<typeof useAvailableGuilds>[number]>;

function useServerRoster(guild: Guild | null) {
  const guildId = guild?.id ?? null;
  const scope = guild?.scope ?? null;
  const key = guild?.key ?? null;
  useEffect(() => {
    if (!guildId || !scope || !key) return;
    const channels = useChannelStore.getState();
    if (!channels.guildChannelsLoaded[key] && !channels.loading[key] && !channels.errors[key]) {
      void channels.fetchChannels(guildId, scope);
    }
    const members = useMemberStore.getState();
    if (!members.membersLoaded[key] && !members.loading[key]) void members.fetchMembers(guildId, scope);
    // The scope is keyed by `key`; the object is a new one per render of the guild list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId, key]);
}

function ServerPane({ guild, leaving }: { guild: Guild; leaving: boolean }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const shell = useOptionalIxShell();
  const place = useMemo(() => serverPlace(guild.id), [guild.id]);
  const hue = serverHue(guild);

  // The channel open in this server: the route's while this is the current pane,
  // frozen at what it was when the pane started to slide out.
  const live = !leaving && shell?.guildId === guild.id ? shell.channelId : null;
  const [frozen, setFrozen] = useState(live);
  if (!leaving && frozen !== live) setFrozen(live);
  const selectedChannelId = leaving ? frozen : live;

  const data = useServerSidebar(guild.id, selectedChannelId);
  // The card shows one room (yours, else the busiest); the rest are rows.
  const cardRoom = useInlineCardRoom(place);
  const rooms = useMemo(() => data.rooms.filter((room) => room.channelId !== cardRoom), [data.rooms, cardRoom]);
  const addons = useAddons(guild.id, pathname);
  const menus = useSidebarMenus({ guildId: guild.id, scope: guild.scope });
  const serverMenuOpen = useServerMenuOpenFor(guild.id);
  const { contextMenu, onContextMenu, closeContextMenu } = useContextMenu();
  const menuButton = useRef<HTMLButtonElement>(null);

  const rowsRef = useRef<HTMLDivElement>(null);
  const ghostsRef = useRef<HTMLDivElement>(null);
  const { collapsed, toggle } = useCollapse(guild.id, rowsRef, ghostsRef, leaving);
  const selection = useSelectionGlide(rowsRef, leaving);

  /* ---- Focus: one stop in the list ------------------------------------------- */
  const shownEvents = useMemo(() => comingUp(data.events, data.nowMs), [data.events, data.nowMs]);
  const ids = useMemo(() => {
    const list: string[] = [];
    for (const group of data.groups) {
      const closed = group.categoryId !== null && collapsed.has(group.id);
      if (group.categoryId !== null) list.push(group.id);
      for (const row of group.channels) if (!closed || keepsVisible(row)) list.push(row.id);
    }
    for (const room of rooms) list.push(room.id);
    for (const addon of addons) list.push(addon.id);
    for (const event of shownEvents) list.push(eventIdOf(event));
    return list;
  }, [data.groups, rooms, addons, shownEvents, collapsed]);
  const selectedId = selectedChannelId ? `channel:${selectedChannelId}` : (addons.find((addon) => addon.selected)?.id ?? null);
  const roving = useRovingList(ids, selectedId);

  // The open row stays in view (the pane is the scroller). Not while sliding out.
  useEffect(() => {
    if (leaving) return;
    const container = rowsRef.current;
    const row = container?.querySelector<HTMLElement>(`[${SELECTED_ATTRIBUTE}]`);
    const pane = container?.closest<HTMLElement>('.ix-pane');
    if (!row || !pane) return;
    const top = row.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    const bottom = top + row.offsetHeight;
    if (top < pane.scrollTop) pane.scrollTop = Math.max(0, top - 8);
    else if (bottom > pane.scrollTop + pane.clientHeight) pane.scrollTop = bottom - pane.clientHeight + 8;
  }, [selectedChannelId, leaving]);

  /* ---- Actions ----------------------------------------------------------------- */
  const reference = useMemo(() => ({ id: guild.id, scope: guild.scope }), [guild.id, guild.scope]);
  const goTo = useCallback(
    (path: string, failed: string) => {
      try {
        activateGuild(reference);
        navigate(path);
      } catch (error) {
        toast.error(`${failed}: ${extractApiError(error)}`);
      }
    },
    [navigate, reference],
  );
  const openOverview = useCallback(() => goTo(`/app/guilds/${guild.id}`, `Failed to open ${guild.name}`), [goTo, guild.id, guild.name]);
  const openChannel = useCallback(
    (channelId: string) => goTo(CHANNELS(guild.id, channelId), 'Failed to open the channel'),
    [goTo, guild.id],
  );
  const openAddon = useCallback(
    (addon: AddonModel) => {
      if (addon.href) goTo(addon.href, `Failed to open ${addon.name}`);
    },
    [goTo],
  );
  // §4.7 says an event opens "the event sheet"; there is none, so an event opens the server's Events
  // page, where the whole calendar and the RSVPs are. When an event sheet exists this is the one place to change.
  const events = useMemo(() => eventsHref(guild.id), [guild.id]);
  const openEvent = useCallback((_event: HomeEvent) => goTo(events, `Failed to open ${guild.name}`), [goTo, events, guild.name]);
  const eventHref = useCallback((_event: HomeEvent) => events, [events]);
  const server = useMemo(() => ({ guildId: guild.id, scope: guild.scope, name: guild.name }), [guild.id, guild.scope, guild.name]);
  const openOptions = useCallback(() => {
    if (menuButton.current) openServerMenu(server, { element: menuButton.current, align: 'end' });
  }, [server]);
  const createChannel = useCallback(
    (parentId: string | null) => openCreateChannel({ guildId: guild.id, scope: guild.scope, kind: 'text', parentId }),
    [guild.id, guild.scope],
  );
  const retry = useCallback(() => void useChannelStore.getState().fetchChannels(guild.id, guild.scope), [guild.id, guild.scope]);

  const line = headerLine({
    memberCount: guild.member_count ?? data.roster.size,
    here: data.roster.here,
    rosterKnown: data.roster.known,
  });
  const overviewCurrent = pathname.replace(/\/$/, '') === `/app/guilds/${guild.id}`;

  const paneStyle = { '--ix-hue': hue } as CSSProperties;

  return (
    <div className="ix-sb" style={paneStyle} data-ix-sidebar-pane="server">
      <SidebarHeader
        guildId={guild.id}
        name={guild.name}
        icon={guild.icon_hash ?? guild.icon ?? null}
        hue={guild.hue ?? null}
        line={line}
        current={overviewCurrent}
        menuRef={menuButton}
        menuOpen={serverMenuOpen}
        onOpenOverview={openOverview}
        onOpenMenu={openOptions}
        onContextMenu={(event) => {
          event.preventDefault();
          openServerMenu(server, anchorFromEvent(event));
        }}
      />
      <SearchField name={guild.name} />
      <CardSlot place={place} position="inline" />
      <div ref={rowsRef} className="ix-sb__rows" onKeyDown={(event) => rovingKeyDown(rowsRef.current, event)}>
        <span ref={selection} className="ix-sel ix-hue-selected" data-on="false" aria-hidden="true" />
        <div ref={ghostsRef} className="ix-sb__ghosts" aria-hidden="true" />
        {data.listStatus === 'loading' && (
          <p className="ix-sb__note" role="status">
            Loading channels…
          </p>
        )}
        {data.listStatus === 'error' && (
          <>
            <p className="ix-sb__note" role="alert">
              {`Could not load this server's channels. ${data.listError ?? ''}`.trim()}
            </p>
            <button type="button" className="ix-sb__retry" onClick={retry}>
              Try again
            </button>
          </>
        )}
        {data.listStatus === 'empty' && <p className="ix-sb__note">No channels yet.</p>}
        <ChannelList
          groups={data.groups}
          collapsed={collapsed}
          hrefOf={(channelId) => CHANNELS(guild.id, channelId)}
          focusOf={roving.focusOf}
          leaving={leaving}
          canCreate={menus.canManage}
          onToggle={toggle}
          onCreate={createChannel}
          onOpen={openChannel}
          onMenu={(event, channelId) => {
            const row = data.groups.flatMap((group) => group.channels).find((candidate) => candidate.channelId === channelId);
            onContextMenu(event, menus.channelMenu(channelId, row?.name ?? 'this channel'));
          }}
        />
        <RoomList
          rooms={rooms}
          focusOf={roving.focusOf}
          onJoin={(room: SidebarRoom) => menus.joinRoom(room)}
          onMenu={(event, room) => onContextMenu(event, menus.roomRowMenu(room))}
        />
        <AddonList addons={addons} focusOf={roving.focusOf} onOpen={openAddon} />
        <ComingUp
          events={data.events}
          nowMs={data.nowMs}
          roomName={data.eventRoomName}
          hrefOf={eventHref}
          focusOf={roving.focusOf}
          onOpen={openEvent}
        />
      </div>
      <ContextMenu open={contextMenu.isOpen} items={contextMenu.items} position={contextMenu.position} onClose={closeContextMenu} />
    </div>
  );
}

export { ADDON_ID };
