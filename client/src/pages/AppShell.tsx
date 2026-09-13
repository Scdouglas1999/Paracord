import { useCurrentChannelStore } from '../hooks/useChannels';
import { useCallback, useEffect, useRef } from 'react';
import { Outlet, useLocation, useParams } from 'react-router';
// §5.1/§5.3: every overlay here rides the shared recipes — backdrops fade
// (pc-fade), panels enter/exit on pc-enter/pc-exit, drawers slide on the
// pc-drawer set — and usePresence keeps each mounted for its leave. The
// engine's data-motion switch is the only reduced-motion source of truth.
import { usePresence } from '../lib/motion';
import { cn } from '../lib/utils';
import { UnifiedSidebar } from '../components/layout/sidebar/UnifiedSidebar';
import { ContextPanel } from '../components/layout/ContextPanel';
import { CommandPalette } from '../components/layout/CommandPalette';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { OnAirDock } from '../components/voice/OnAirDock';
import { MotionDirector } from '../components/motion/MotionDirector';
import { MobileBottomNav } from '../components/layout/MobileBottomNav';
import { useUIStore } from '../stores/uiStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useKeyboardNavigation } from '../hooks/useKeyboardNavigation';
import { useSwipeGesture } from '../hooks/useSwipeGesture';
import { useMobile } from '../hooks/useMobile';
import { SettingsPage } from './SettingsPage';
import { GuildSettingsPage } from './GuildSettingsPage';
import { LayoutTour } from '../components/onboarding/LayoutTour';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useRelationshipStore } from '../stores/relationshipStore';
import { InteractionModal } from '../components/message/InteractionModal';
import { ErrorBoundary } from '../components/ErrorBoundary';

/**
 * AppShell — the "Rooms + Unified Stream" frame (layout-spec §1, §4, §5, §6).
 *
 * Replaces the old two-rail Discord skeleton (guild rail + channel column +
 * docked member list) with a two-zone shell:
 *
 *   [ UnifiedSidebar ]  [ <main><Outlet/></main> ]  [ ContextPanel? ]
 *
 * The left `UnifiedSidebar` is the single left rail (merged across all connected
 * servers). The center is a full-width content pane where the still-original page
 * bodies (`HomePage`/`GuildHomePage`/`GuildPage`/`DMPage`) render unchanged in the
 * `<Outlet/>` during the migration. The right `ContextPanel` is toggleable, not
 * docked — it mounts only when `uiStore.contextPanelMode` is set (single source
 * of truth), and collapses to an overlay on narrow widths (§6).
 *
 * Overlay motion is the shared §5.1 set: drawers slide in from their edge on
 * the spring-settle and leave on ease-in, dialogs rise on pc-enter, backdrops
 * fade — all of it instant under `html[data-motion="reduced"]` (§5.3, §9).
 */
export function AppShell() {
  useKeyboardNavigation();

  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed);
  const contextPanelMode = useUIStore((s) => s.contextPanelMode);
  const setContextPanelMode = useUIStore((s) => s.setContextPanelMode);
  const voiceConnected = useVoiceStore((s) => s.connected);
  const voiceChannelId = useVoiceStore((s) => s.channelId);
  const location = useLocation();
  const { guildId, channelId } = useParams();
  const activeChannel = useCurrentChannelStore((s) => (channelId ? s.channelsById[channelId] : undefined));

  const userSettingsOpen = useUIStore((s) => s.userSettingsOpen);
  const guildSettingsId = useUIStore((s) => s.guildSettingsId);
  const setUserSettingsOpen = useUIStore((s) => s.setUserSettingsOpen);
  const setGuildSettingsId = useUIStore((s) => s.setGuildSettingsId);
  const userSettingsDialogRef = useRef<HTMLDivElement>(null);
  const guildSettingsDialogRef = useRef<HTMLDivElement>(null);
  const sidebarOverlayRef = useRef<HTMLDivElement>(null);
  const contextOverlayRef = useRef<HTMLDivElement>(null);
  const closeUserSettings = useCallback(() => setUserSettingsOpen(false), [setUserSettingsOpen]);
  const closeGuildSettings = useCallback(() => setGuildSettingsId(null), [setGuildSettingsId]);
  const closeSidebarOverlay = useCallback(() => setSidebarCollapsed(true), [setSidebarCollapsed]);
  const closeContextOverlay = useCallback(() => setContextPanelMode(null), [setContextPanelMode]);

  useFocusTrap(userSettingsDialogRef, userSettingsOpen, closeUserSettings);
  useFocusTrap(guildSettingsDialogRef, Boolean(guildSettingsId), closeGuildSettings);

  const isMobile = useMobile();

  // On mount / breakpoint change, collapse the sidebar on mobile so it starts as
  // a hidden overlay rather than eating the viewport (layout-spec §6).
  useEffect(() => {
    setSidebarCollapsed(isMobile);
  }, [isMobile, setSidebarCollapsed]);

  useEffect(() => {
    if (isMobile) setSidebarCollapsed(true);
  }, [isMobile, location.pathname, setSidebarCollapsed]);

  // Open User settings from deep links like /app?settings=identity (import flow).
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const section = params.get('settings');
    if (!section) return;
    useUIStore.getState().setUserSettingsOpen(true, section);
    params.delete('settings');
    const next = params.toString();
    window.history.replaceState(
      null,
      '',
      `${location.pathname}${next ? `?${next}` : ''}${location.hash}`,
    );
  }, [location.pathname, location.search, location.hash]);

  // Prime relationships once per shell mount so the sidebar's Friends badge and
  // Needs-you request rows are fresh without requiring a Home/Friends visit
  // (gateway RELATIONSHIP_* events keep them live afterwards).
  useEffect(() => {
    void useRelationshipStore.getState().fetchRelationships();
  }, []);

  // Mobile swipe gesture (§6): right from the left edge opens the Buildings
  // column. The mirrored left-edge swipe used to open a docked member list;
  // there is no member list (lantern-stage-spec §6.5), so the gesture is gone
  // rather than repointed at some other panel a thumb did not ask for.
  useSwipeGesture(
    {
      // Keep mobile overlays mutually exclusive — stacking two z-[80] surfaces
      // leaves the covered one stuck open underneath.
      onSwipeRight: () => {
        setContextPanelMode(null);
        setSidebarCollapsed(false);
      },
    },
    isMobile,
  );

  // Settings full-page routes (`/app/admin`, guild settings) keep their internal
  // padding; the shell chrome (sidebar/context panel) stays present around them —
  // the Unified Sidebar is now universal navigation.
  const isSettingsRoute =
    location.pathname === '/app/admin'
    || location.pathname === '/app/developers'
    || /^\/app\/guilds\/[^/]+\/settings$/.test(location.pathname);

  const isDmConversationRoute = /^\/app\/dms\/[^/]+$/.test(location.pathname);
  const isGroupDmContext =
    isDmConversationRoute
    && (activeChannel?.type === 3 || activeChannel?.channel_type === 3);
  const contextPanelRouteValid =
    contextPanelMode === null
    || ((contextPanelMode === 'search' || contextPanelMode === 'pins') && Boolean(channelId))
    || (contextPanelMode === 'threads' && Boolean(guildId && channelId))
    || (contextPanelMode === 'economy' && Boolean(guildId))
    || (contextPanelMode === 'recipients' && isGroupDmContext);

  useEffect(() => {
    if (contextPanelMode !== null && !contextPanelRouteValid) {
      setContextPanelMode(null);
    }
  }, [contextPanelMode, contextPanelRouteValid, setContextPanelMode]);

  // Mobile persistent call surface: the sidebar CallDock is unreachable while the
  // overlay sidebar is closed, so the mobile bottom dock stays mounted whenever
  // connected and not already on the voice channel's page (§6).
  const isOnVoiceChannel = voiceChannelId
    ? location.pathname.includes(`/channels/${voiceChannelId}`)
    : false;
  const showOnAirDock = isMobile && voiceConnected && !isOnVoiceChannel;

  const showContextPanel = contextPanelMode !== null && contextPanelRouteValid;
  const showSidebarOverlay = isMobile && !sidebarCollapsed;

  // When a context overlay opens on mobile, dismiss the sidebar overlay so the
  // two z-[80] surfaces never stack (hamburger / TopBar toggles included).
  useEffect(() => {
    if (!isMobile) return;
    if (showContextPanel && !sidebarCollapsed) {
      setSidebarCollapsed(true);
    }
  }, [isMobile, showContextPanel, sidebarCollapsed, setSidebarCollapsed]);

  // Narrow-viewport overlays are modal (they cover a dimmed but present main
  // pane), so they trap focus, move focus inside on open, restore it on close,
  // and honor Escape — mirroring the settings dialogs (WCAG 2.4.3 / 2.1.2).
  useFocusTrap(sidebarOverlayRef, showSidebarOverlay, closeSidebarOverlay);
  useFocusTrap(contextOverlayRef, isMobile && showContextPanel, closeContextOverlay);

  // Three layers, never four (lantern-stage-spec §4): the street
  // (`--bg-base`) carries the Buildings column and the gutter, a plate
  // (`--bg-plate`) carries content, and raised/well surfaces live inside a
  // plate. A plate is never nested in a plate.
  const onAirDockPresence = usePresence(showOnAirDock);
  const sidebarPresence = usePresence(showSidebarOverlay);
  const contextPresence = usePresence(isMobile && showContextPanel);
  const desktopContextPresence = usePresence(!isMobile && showContextPanel);
  const userSettingsPresence = usePresence(userSettingsOpen);
  const guildSettingsPresence = usePresence(Boolean(guildSettingsId));

  // data-native-underlay-clear: while a stream renders on the native GL
  // underlay (Linux), this wrapper's background goes transparent so the tile
  // is a real hole down to the video (see layout.css).
  return (
      <div
        data-native-underlay-clear=""
        className="flex h-[100dvh] w-full flex-col overflow-hidden bg-bg-base text-text-primary"
      >
        {/* The two moments nobody clicks: "lights on" and "someone arrives"
            (§5.1). It renders nothing — it is one subscription and two effects,
            mounted once so four subtrees cannot each grow their own copy. */}
        <MotionDirector />

        {/* Skip-to-content for keyboard/screen-reader users */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-[var(--radius-control)] focus:bg-accent-primary focus:px-4 focus:py-2 focus:text-label focus:font-semibold focus:text-text-on-accent focus:outline-none focus:[box-shadow:var(--focus-ring)]"
        >
          Skip to content
        </a>

        <div className="flex min-h-0 flex-1">
          {/* Left rail — Unified Sidebar. Desktop renders inline (self-collapsing
              to the 64px icon rail); mobile renders it as an overlay below. */}
          {/* The sidebar owns navigation; if it throws, the user must still be
              able to reach the rest of the app rather than lose the whole shell. */}
          {!isMobile && (
            <ErrorBoundary variant="section" label="the sidebar">
              <UnifiedSidebar />
            </ErrorBoundary>
          )}

          <main
            id="main-content"
            data-native-underlay-clear=""
            className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-bg-plate"
          >
            <div className={cn('min-h-0 w-full flex-1 overflow-hidden', isSettingsRoute && 'p-3')}>
              <Outlet />
            </div>
            {onAirDockPresence.mounted && (
              <div
                className={cn(
                  'shrink-0 overflow-hidden px-3 py-2',
                  onAirDockPresence.exiting ? 'pc-sheet-out' : 'pc-sheet-in',
                )}
                {...onAirDockPresence.scenery}
              >
                <OnAirDock />
              </div>
            )}
          </main>

          {/* Right rail — ContextPanel (desktop inline; toggleable, not
              docked). A contextual plate slides in from the edge it opens
              against on the spring-settle and slides back out on --ease-in —
              the same choreography the mobile overlay already has (§5.1). */}
          {!isMobile && desktopContextPresence.mounted && (
            <div
              className={cn(
                'h-full min-h-0 shrink-0',
                desktopContextPresence.exiting ? 'pc-drawer-out-right' : 'pc-drawer-in-right',
              )}
              {...desktopContextPresence.scenery}
            >
              <ContextPanel guildId={guildId ?? null} channelId={channelId ?? null} manageFocus />
            </div>
          )}
        </div>

        {/* Mobile: Unified Sidebar as a left overlay (§6 — full overlay, never the
            64px rail on mobile). The backdrop fades while the drawer slides in
            from its edge on the spring-settle and leaves on ease-in. */}
        {sidebarPresence.mounted && (
          <div
            className={cn(
              'fixed inset-0 z-[80] flex md:hidden modal-backdrop',
              sidebarPresence.exiting ? 'pc-fade-out' : 'pc-fade-in',
            )}
            onClick={() => setSidebarCollapsed(true)}
          >
            <div
              ref={sidebarOverlayRef}
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
              tabIndex={-1}
              className={cn(
                'h-full max-w-[88vw] overflow-hidden shadow-[var(--shadow-plate)] outline-none',
                sidebarPresence.exiting ? 'pc-drawer-out-left' : 'pc-drawer-in-left',
              )}
              onClick={(e) => e.stopPropagation()}
              {...sidebarPresence.scenery}
            >
              <ErrorBoundary variant="section" label="the sidebar">
                <UnifiedSidebar />
              </ErrorBoundary>
            </div>
          </div>
        )}

        {/* Mobile: ContextPanel as a right overlay (§6 — default closed). */}
        {contextPresence.mounted && (
          <div
            className={cn(
              'fixed inset-0 z-[80] flex justify-end md:hidden modal-backdrop',
              contextPresence.exiting ? 'pc-fade-out' : 'pc-fade-in',
            )}
            onClick={() => setContextPanelMode(null)}
          >
            <div
              ref={contextOverlayRef}
              role="dialog"
              aria-modal="true"
              aria-label="Details"
              tabIndex={-1}
              className={cn(
                'context-panel-overlay h-full w-[var(--w-context-panel)] max-w-[88vw] overflow-hidden shadow-[var(--shadow-plate)] outline-none',
                contextPresence.exiting ? 'pc-drawer-out-right' : 'pc-drawer-in-right',
              )}
              onClick={(e) => e.stopPropagation()}
              {...contextPresence.scenery}
            >
              <ContextPanel guildId={guildId ?? null} channelId={channelId ?? null} />
            </div>
          </div>
        )}

        {isMobile && <MobileBottomNav />}

        <CommandPalette />
        <ConfirmDialog />
        <InteractionModal />
        <LayoutTour />

        {/* Windowed settings overlays — the shared §5.1 recipe: backdrop fades,
            the surface rises on pc-enter and falls on pc-exit. */}
        {userSettingsPresence.mounted && (
          <div
            className={cn(
              'fixed inset-0 z-[150] flex items-center justify-center p-3 sm:p-8 md:p-12 lg:p-20 modal-backdrop',
              userSettingsPresence.exiting ? 'pc-fade-out' : 'pc-fade-in',
            )}
            onClick={closeUserSettings}
          >
            <div
              ref={userSettingsDialogRef}
              role="dialog"
              aria-modal="true"
              aria-label="User settings"
              tabIndex={-1}
              className={cn(
                'relative flex h-full max-h-[calc(100dvh-1.5rem)] w-full max-w-6xl flex-col overflow-hidden sm:max-h-[min(900px,85vh)]',
                userSettingsPresence.exiting ? 'pc-exit' : 'pc-enter',
              )}
              onClick={(e) => e.stopPropagation()}
              {...userSettingsPresence.scenery}
            >
              <SettingsPage />
            </div>
          </div>
        )}

        {guildSettingsPresence.mounted && (
          <div
            className={cn(
              'fixed inset-0 z-[150] flex items-center justify-center p-3 sm:p-8 md:p-12 lg:p-20 modal-backdrop',
              guildSettingsPresence.exiting ? 'pc-fade-out' : 'pc-fade-in',
            )}
            onClick={closeGuildSettings}
          >
            <div
              ref={guildSettingsDialogRef}
              role="dialog"
              aria-modal="true"
              aria-label="Space settings"
              tabIndex={-1}
              className={cn(
                'relative flex h-full max-h-[calc(100dvh-1.5rem)] w-full max-w-6xl flex-col overflow-hidden sm:max-h-[min(900px,85vh)]',
                guildSettingsPresence.exiting ? 'pc-exit' : 'pc-enter',
              )}
              onClick={(e) => e.stopPropagation()}
              {...guildSettingsPresence.scenery}
            >
              <GuildSettingsPage />
            </div>
          </div>
        )}
      </div>
  );
}
