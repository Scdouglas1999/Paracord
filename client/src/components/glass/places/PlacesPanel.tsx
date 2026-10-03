import { useGuildTogether } from '../../../hooks/useGuildTogether';
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';

import { extractApiError } from '../../../api/client';
import { useBuildingRosters } from '../../../hooks/useBuildingRosters';
import { useBuildingLights } from '../../../hooks/useLights';
import { useRoomMenu } from '../../../hooks/useRoomMenu';
import type { ConversationEntry } from '../../../lib/attention/conversationModel';
import type { BuildingLight } from '../../../lib/attention/light';
import { activateConversation } from '../../../lib/attention/conversationNavigation';
import { activateGuild, guildLandingPath } from '../../../lib/guildNavigation';
import { accountScopeKey, LOCAL_SERVER_ID } from '../../../lib/serverScope';
import { useServerListStore } from '../../../stores/serverListStore';
import { useGlassStore } from '../../../stores/glassStore';
import { useGuildStore } from '../../../stores/guildStore';
import { toast } from '../../../stores/toastStore';
import { ErrorBoundary } from '../../ErrorBoundary';
import { CreateGuildModal } from '../../guild/CreateGuildModal';
import { ContextMenu, useContextMenu } from '../../ui/ContextMenu';
import type { HomeEvent } from '../../rooms/lobby/useUpcomingEvents';
import { AddonRows, useAddons, type AddonModel } from './AddonRows';
import { ComingUp, eventIdOf } from './ComingUp';
import { directConversations, FRIENDS_ID, HomePlaces, dmIdOf, unreadConversations } from './HomePlaces';
import { LiveRow, QuietRow, TextRow, type RowFocus } from './PlaceRows';
import { ADD_ID, HOME_ID, ServerRow, serverIdOf, type ServerCircle } from './ServerRow';
import { useServerMenu } from './ServerMenu';
import { ServerTitle } from './ServerTitle';
import { serverLine } from './model';
import type { ChannelRowModel } from './rows';
import { useHomeConversations, useMinuteClock, usePlacesRoute, useServerCircles, useServerPlaces } from './usePlacesData';
import type { PlacesPanelProps } from '../shell/slots';

/**
 * The places panel (docs/glass-spec.md §3.1, reference screens 01, 02, 06).
 *
 * Top to bottom: the server row, the server's title with its line, then what is
 * in the server as rows that show what is in them (a live voice channel, text
 * channels with their newest message, quiet ones as a single line), add-ons, and
 * "Coming up". In Home the title and the list are your conversations instead.
 *
 * One component for every presentation: the shell paints the pane (or the overlay,
 * or the browse panel) and this fills it. Picking a channel navigates; the frame
 * closes the overlay and browse when the route changes, so a row only has to
 * navigate. The live row also opens the stage when somebody streams there,
 * so it closes the overlay or browse itself.
 *
 * Keyboard: the server row and the list are each one Tab stop; the arrow keys
 * move between rows (Left and Right in the server row, Up, Down, Home and End in
 * the list) and Enter opens.
 */

/** One roving Tab stop over a set of ids: the preferred one, else the first. */
function useRovingStop(ids: readonly string[], preferred: string | null) {
  const [stop, setStop] = useState<string | null>(null);
  const effective = stop && ids.includes(stop) ? stop : preferred && ids.includes(preferred) ? preferred : (ids[0] ?? '');
  const focusOf = useCallback(
    (id: string): RowFocus => ({ tabIndex: effective === id ? 0 : -1, onFocus: () => setStop(id) }),
    [effective],
  );
  return { stop: effective, setStop, focusOf };
}

function PlacesPanelBody({ presentation, onClose }: PlacesPanelProps) {
  const route = usePlacesRoute();
  const navigate = useNavigate();
  const nowMs = useMinuteClock();
  useBuildingRosters();

  const lights = useBuildingLights();
  const circles = useServerCircles(route.guildId, lights);
  const current = circles.find((circle) => circle.current) ?? null;
  const conversations = useHomeConversations();
  const directs = useMemo(
    () => directConversations([conversations.pinned, conversations.needsYou, conversations.recent]),
    [conversations.pinned, conversations.needsYou, conversations.recent],
  );
  const unreadDirect = unreadConversations(directs);
  const homeUnread = unreadDirect + conversations.requests.length;

  const [creatingServer, setCreatingServer] = useState(false);
  const serverMenu = useServerMenu();
  const roomMenu = useRoomMenu();
  const { contextMenu, onContextMenu, closeContextMenu } = useContextMenu();
  const titleRef = useRef<HTMLButtonElement>(null);

  const homeMode = route.mode === 'home';

  /* ---- Focus: one stop in the server row, one in the list ---------------------- */

  const serverIds = useMemo(() => [HOME_ID, ...circles.map(serverIdOf), ADD_ID], [circles]);
  const serverFocus = useRovingStop(serverIds, homeMode ? HOME_ID : current ? serverIdOf(current) : HOME_ID);

  /* ---- Actions ------------------------------------------------------------------ */

  const openHome = useCallback(() => navigate('/app'), [navigate]);
  const openServer = useCallback(
    (circle: ServerCircle) => {
      // Already in one of its channels: a click on its circle must not throw you
      // back to the landing channel. From its settings, add-ons or home it does
      // take you to a channel.
      if (circle.current && route.channelId) return;
      const guild = useGuildStore.getState().guilds.find((entry) => entry.key === circle.key);
      if (!guild) return;
      void guildLandingPath(guild).then(
        (path) => navigate(path),
        (error) => toast.error(`Failed to open ${circle.name}: ${extractApiError(error)}`),
      );
    },
    [navigate, route.channelId],
  );
  const openServerMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>, circle: ServerCircle) => {
      event.preventDefault();
      serverMenu.openAtPoint(
        { guildId: circle.guildId, scope: circle.scope, name: circle.name },
        { x: event.clientX, y: event.clientY },
      );
    },
    [serverMenu],
  );
  const openConversation = useCallback(
    (entry: ConversationEntry) => {
      try {
        navigate(activateConversation(entry));
      } catch (error) {
        toast.error(`Failed to open ${entry.title}: ${extractApiError(error)}`);
      }
    },
    [navigate],
  );

  const serverRow = (
    <ServerRow
      circles={circles}
      homeActive={homeMode}
      homeUnread={homeMode ? 0 : homeUnread}
      stopId={serverFocus.stop}
      onStop={serverFocus.setStop}
      onOpenHome={openHome}
      onOpenServer={openServer}
      onAdd={() => setCreatingServer(true)}
      onServerMenu={openServerMenu}
    />
  );

  const shared = (
    <>
      {serverMenu.element}
      <ContextMenu
        open={contextMenu.isOpen}
        items={contextMenu.items}
        position={contextMenu.position}
        onClose={closeContextMenu}
      />
      {creatingServer && <CreateGuildModal onClose={() => setCreatingServer(false)} />}
    </>
  );

  if (homeMode) {
    return (
      <HomeBody
        presentation={presentation}
        serverRow={serverRow}
        directs={directs}
        requests={conversations.requests.length}
        unread={unreadDirect}
        route={route}
        nowMs={nowMs}
        onOpenConversation={openConversation}
        onOpenFriends={() => navigate('/app/friends')}
        shared={shared}
      />
    );
  }

  if (!current) {
    // A server in the address that is not one of yours (or not loaded yet): the
    // row above is still a way out, and nothing below it makes a claim.
    return (
      <div className="glass-places" data-presentation={presentation} data-mode="server">
        {serverRow}
        <p className="glass-places__empty">This server is not available.</p>
        {shared}
      </div>
    );
  }

  return (
    <ServerBody
      presentation={presentation}
      onClose={onClose}
      serverRow={serverRow}
      current={current}
      route={route}
      lights={lights}
      titleRef={titleRef}
      serverMenu={serverMenu}
      roomMenu={roomMenu}
      onContextMenu={onContextMenu}
      shared={shared}
    />
  );
}

/* ---- Home ---------------------------------------------------------------------- */

function HomeBody({
  presentation,
  serverRow,
  directs,
  requests,
  unread,
  route,
  nowMs,
  onOpenConversation,
  onOpenFriends,
  shared,
}: {
  presentation: PlacesPanelProps['presentation'];
  serverRow: React.ReactNode;
  directs: readonly ConversationEntry[];
  requests: number;
  unread: number;
  route: ReturnType<typeof usePlacesRoute>;
  nowMs: number;
  onOpenConversation: (entry: ConversationEntry) => void;
  onOpenFriends: () => void;
  shared: React.ReactNode;
}) {
  const ids = useMemo(() => [FRIENDS_ID, ...directs.map(dmIdOf)], [directs]);
  const inDms = route.pathname.startsWith('/app/dms');
  const selectedDm = inDms && route.channelId ? directs.find((entry) => entry.channelId === route.channelId) : null;
  const friendsSelected = route.pathname === '/app/friends';
  const focus = useRovingStop(ids, selectedDm ? dmIdOf(selectedDm) : friendsSelected ? FRIENDS_ID : null);
  const listRef = useRef<HTMLDivElement>(null);
  const onKeyDown = useListKeys(listRef);

  const waiting = [
    unread > 0 ? `${unread} unread` : null,
    requests > 0 ? (requests === 1 ? '1 request' : `${requests} requests`) : null,
  ].filter(Boolean);
  const line = waiting.length > 0 ? waiting.join(', ') : directs.length > 0 ? 'All caught up' : 'Your conversations';

  return (
    <div className="glass-places" data-presentation={presentation} data-mode="home">
      {serverRow}
      <ServerTitle name="Home" line={line} />
      <div ref={listRef} className="glass-places__scroll scrollbar-thin" onKeyDown={onKeyDown}>
        <nav aria-label="Conversations" className="glass-places__rows">
          <HomePlaces
            entries={directs}
            requests={requests}
            selectedChannelId={inDms ? route.channelId : null}
            friendsSelected={friendsSelected}
            nowMs={nowMs}
            focusOf={focus.focusOf}
            onOpenConversation={onOpenConversation}
            onOpenFriends={onOpenFriends}
          />
        </nav>
      </div>
      {shared}
    </div>
  );
}

/* ---- One server ------------------------------------------------------------------ */

function ServerBody({
  presentation,
  onClose,
  serverRow,
  current,
  route,
  lights,
  titleRef,
  serverMenu,
  roomMenu,
  onContextMenu,
  shared,
}: {
  presentation: PlacesPanelProps['presentation'];
  onClose: PlacesPanelProps['onClose'];
  serverRow: React.ReactNode;
  lights: readonly BuildingLight[];
  current: ServerCircle;
  route: ReturnType<typeof usePlacesRoute>;
  titleRef: React.RefObject<HTMLButtonElement | null>;
  serverMenu: ReturnType<typeof useServerMenu>;
  roomMenu: ReturnType<typeof useRoomMenu>;
  onContextMenu: ReturnType<typeof useContextMenu>['onContextMenu'];
  shared: React.ReactNode;
}) {
  const navigate = useNavigate();
  const building = useMemo(
    () => lights.find((light) => light.guildId === current.guildId && accountScopeKey(light.scope) === accountScopeKey(current.scope)) ?? null,
    [lights, current],
  );
  const places = useServerPlaces(current.guildId, building, route.channelId);
  // Keep the server's Watch and Listen together sessions fresh for the live rows.
  useGuildTogether(current.guildId);
  const addons = useAddons(current.guildId, current.name, route.pathname);

  const events = places.events;
  const ids = useMemo(
    () => [...places.rows.map((row) => row.id), ...addons.map((addon) => addon.id), ...events.slice(0, 3).map(eventIdOf)],
    [places.rows, addons, events],
  );
  const selectedId = places.rows.find((row) => row.selected)?.id ?? addons.find((addon) => addon.selected)?.id ?? null;
  const focus = useRovingStop(ids, selectedId);
  const listRef = useRef<HTMLDivElement>(null);
  const onKeyDown = useListKeys(listRef);

  const channelHref = (channelId: string) => `/app/guilds/${current.guildId}/channels/${channelId}`;

  const openChannel = useCallback(
    (channelId: string) => {
      try {
        activateGuild({ id: current.guildId, scope: current.scope });
        navigate(channelHref(channelId));
      } catch (error) {
        toast.error(`Failed to open the channel: ${extractApiError(error)}`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [navigate, current.guildId, current.scope],
  );

  /**
   * A live row opens the channel's own chat (its pill, its people), and when
   * somebody is streaming, the stage on that stream beside it: the voice
   * channel's chat beside the stage (docs/design/glass-plan.md §8.4).
   */
  const openLive = useCallback(
    (row: Extract<ChannelRowModel, { kind: 'live' }>) => {
      openChannel(row.channelId);
      if (row.streamerId) {
        useGlassStore.getState().openStage({
          serverId: useServerListStore.getState().activeServerId ?? LOCAL_SERVER_ID,
          guildId: current.guildId,
          channelId: row.channelId,
          streamerId: row.streamerId,
        });
        onClose?.();
      }
    },
    [current.guildId, onClose, openChannel],
  );

  const openAddon = useCallback(
    (addon: AddonModel) => {
      if (addon.href) navigate(addon.href);
    },
    [navigate],
  );

  const openEvent = useCallback(
    (event: HomeEvent) => {
      if (event.channelId) openChannel(event.channelId);
      else navigate(`/app/guilds/${current.guildId}`);
    },
    [current.guildId, navigate, openChannel],
  );

  const rowMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>, channelId: string) => {
      const room = places.rooms.get(channelId);
      if (!room) return;
      onContextMenu(event, roomMenu(room));
    },
    [onContextMenu, places.rooms, roomMenu],
  );

  const line = building
    ? serverLine({
        rosterKnown: building.rosterKnown,
        memberCount: building.memberCount,
        online: building.lightsOn,
        live: building.rooms
          .filter((room) => room.kind === 'voice' && room.lit)
          .sort((a, b) => b.occupants.length - a.occupants.length || a.order - b.order)
          .map((room) => ({ name: room.name, occupants: room.occupants.length })),
      })
    : '';

  const server = { guildId: current.guildId, scope: current.scope, name: current.name };

  return (
    <div className="glass-places" data-presentation={presentation} data-mode="server">
      {serverRow}
      <ServerTitle
        name={current.name}
        line={line}
        buttonRef={titleRef}
        menuOpen={serverMenu.isOpenFor(current.guildId)}
        onOpenMenu={() => serverMenu.openFromElement(server, titleRef)}
      />
      <div ref={listRef} className="glass-places__scroll scrollbar-thin" onKeyDown={onKeyDown}>
        {places.listStatus !== 'ready' && (
          <p className="glass-places__empty" role={places.listStatus === 'error' ? 'alert' : 'status'}>
            {places.listStatus === 'loading'
              ? 'Loading channels…'
              : places.listStatus === 'error'
                ? `Could not load this server's channels. ${places.listError ?? ''}`.trim()
                : 'No channels yet.'}
          </p>
        )}
        <nav aria-label="Channels" className="glass-places__rows">
          {places.rows.map((row) => {
            const rowFocus = focus.focusOf(row.id);
            const menu = (event: React.MouseEvent<HTMLElement>) => rowMenu(event, row.channelId);
            if (row.kind === 'live') {
              return (
                <LiveRow
                  key={row.id}
                  row={row}
                  href={channelHref(row.channelId)}
                  onOpen={() => openLive(row)}
                  onContextMenu={menu}
                  {...rowFocus}
                />
              );
            }
            if (row.kind === 'quiet') {
              return (
                <QuietRow
                  key={row.id}
                  row={row}
                  href={channelHref(row.channelId)}
                  onOpen={() => openChannel(row.channelId)}
                  onContextMenu={menu}
                  {...rowFocus}
                />
              );
            }
            return (
              <TextRow
                key={row.id}
                row={row}
                href={channelHref(row.channelId)}
                onOpen={() => openChannel(row.channelId)}
                onContextMenu={menu}
                {...rowFocus}
              />
            );
          })}
          <AddonRows addons={addons} focusOf={focus.focusOf} onOpen={openAddon} />
        </nav>
        <ComingUp
          events={events}
          nowMs={places.nowMs}
          selfUserId={places.selfUserId}
          roomName={places.eventRoomName}
          hrefOf={(event) => (event.channelId ? channelHref(event.channelId) : `/app/guilds/${current.guildId}`)}
          focusOf={focus.focusOf}
          onOpen={openEvent}
        />
      </div>
      {shared}
    </div>
  );
}

/**
 * Arrow keys between the rows of the list: Up and Down, Home and End. Space
 * opens an anchor as it does a button. Rows are found in the DOM, so a row that
 * appears later (an add-on that finished loading) is on the path at once.
 */
function useListKeys(listRef: React.RefObject<HTMLDivElement | null>) {
  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const active = document.activeElement as HTMLElement | null;
      if (event.key === ' ' && active?.tagName === 'A' && active.hasAttribute('data-place-row')) {
        event.preventDefault();
        active.click();
        return;
      }
      if (event.shiftKey || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-place-row]') ?? []);
      if (rows.length === 0) return;
      const at = rows.findIndex((row) => row === active);
      const last = rows.length - 1;
      const next =
        event.key === 'Home' ? 0
        : event.key === 'End' ? last
        : event.key === 'ArrowUp' ? (at <= 0 ? last : at - 1)
        : at >= last ? 0 : at + 1;
      event.preventDefault();
      rows[next]?.focus();
    },
    [listRef],
  );
}

export function PlacesPanel(props: PlacesPanelProps) {
  return (
    // The panel owns navigation; if it throws, the rest of the app must stay
    // reachable rather than lose the whole shell.
    <ErrorBoundary variant="section" label="the places panel">
      <PlacesPanelBody {...props} />
    </ErrorBoundary>
  );
}
