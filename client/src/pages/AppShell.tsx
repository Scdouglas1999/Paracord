import { useFreshRelationships } from '../hooks/useFreshRelationships';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { registerAppNavigate } from '../lib/appNavigate';
// §5.1/§5.3: every overlay here rides the shared recipes — backdrops fade
// (pc-fade), panels enter/exit on pc-enter/pc-exit, drawers slide on the
// pc-drawer set — and usePresence keeps each mounted for its leave. The
// engine's data-motion switch is the only reduced-motion source of truth.
import { useContentSwap, usePresence } from '../lib/motion';
import { cn } from '../lib/utils';
import { UnifiedSidebar } from '../components/layout/sidebar/UnifiedSidebar';
import { CommandPalette } from '../components/layout/CommandPalette';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { OnAirDock } from '../components/voice/OnAirDock';
import { TogetherHost } from '../components/voice/together/TogetherHost';
import { MotionDirector } from '../components/motion/MotionDirector';
import { MobileBottomNav } from '../components/layout/MobileBottomNav';
import { GlassFrame, useGlassLayout } from '../components/glass/shell';
import { useUIStore } from '../stores/uiStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useKeyboardNavigation } from '../hooks/useKeyboardNavigation';
import { useSwipeGesture } from '../hooks/useSwipeGesture';
import { SettingsPage } from './SettingsPage';
import { GuildSettingsPage } from './GuildSettingsPage';
import { LayoutTour } from '../components/onboarding/LayoutTour';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { InteractionModal } from '../components/message/InteractionModal';
import { ErrorBoundary } from '../components/ErrorBoundary';

/**
 * AppShell — the Glass frame (docs/glass-spec.md §3; WP-G7).
 *
 * The room lights the window and two panes float on it, 16px from the edges
 * and from each other, radius 28, full height:
 *
 *   [ places 316 ]  [ <main> conversation: <Outlet/> ]  ( [ sheet ] )
 *
 * Geometry lives in `GlassFrame` (components/glass/shell) and follows
 * `glassStore` (stage side by side / theater, browse, hidden chat, the places
 * overlay below 860px). What fills each pane is a slot (`slots.ts`); today the
 * slots render the existing components, and each later package replaces one.
 *
 * This component keeps the app-level concerns the frame does not own: route
 * navigation for non-React callers, keyboard shortcuts, the settings dialogs,
 * the command palette, the confirm and interaction hosts, the skip link, and
 * the phone path (navigation drawer, bottom bar, on-air dock), which stays as
 * it was until WP-G20 rebuilds it.
 *
 * Overlay motion is the shared §5.1 set: drawers ease in from their edge on
 * ease-out and leave on ease-in, dialogs rise on pc-enter, backdrops fade — all
 * of it instant under `html[data-motion="reduced"]`.
 */
export function AppShell() {
  useKeyboardNavigation();
  const navigate = useNavigate();
  useEffect(() => {
    registerAppNavigate(navigate);
    return () => registerAppNavigate(null);
  }, [navigate]);

  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed);
  const setContextPanelMode = useUIStore((s) => s.setContextPanelMode);
  const voiceConnected = useVoiceStore((s) => s.connected);
  const voiceChannelId = useVoiceStore((s) => s.channelId);
  const location = useLocation();
  const { guildId, channelId } = useParams();

  const userSettingsOpen = useUIStore((s) => s.userSettingsOpen);
  const guildSettingsId = useUIStore((s) => s.guildSettingsId);
  const setUserSettingsOpen = useUIStore((s) => s.setUserSettingsOpen);
  const setGuildSettingsId = useUIStore((s) => s.setGuildSettingsId);
  const userSettingsDialogRef = useRef<HTMLDivElement>(null);
  const guildSettingsDialogRef = useRef<HTMLDivElement>(null);
  const sidebarOverlayRef = useRef<HTMLDivElement>(null);
  const closeUserSettings = useCallback(() => setUserSettingsOpen(false), [setUserSettingsOpen]);
  const closeGuildSettings = useCallback(() => setGuildSettingsId(null), [setGuildSettingsId]);
  const closeSidebarOverlay = useCallback(() => setSidebarCollapsed(true), [setSidebarCollapsed]);

  useFocusTrap(userSettingsDialogRef, userSettingsOpen, closeUserSettings);
  useFocusTrap(guildSettingsDialogRef, Boolean(guildSettingsId), closeGuildSettings);

  const layout = useGlassLayout();
  const isMobile = layout === 'phone';

  // PHONE PATH (unchanged until WP-G20). On mount / breakpoint change, collapse
  // the navigation drawer on a phone so it starts hidden rather than eating the
  // viewport. This has to land BEFORE the first paint: `sidebarCollapsed`
  // persists as `false`, so as a passive effect a phone opening the app painted
  // the drawer for ~120ms and tore it down again. `sidebarMobileSynced` is a
  // ref, not state, because it must be false on the very first render and true
  // from the layout effect onward without a render of its own; `usePresence`
  // would otherwise hand a first-render "open" drawer a full slide-out. The
  // wide and compact frames never read `sidebarCollapsed`: their places panel
  // does not collapse.
  const sidebarMobileSynced = useRef(false);
  useLayoutEffect(() => {
    setSidebarCollapsed(isMobile);
    sidebarMobileSynced.current = true;
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

  // Prime relationships once per shell mount so the Friends badge and the
  // Needs-you request rows are fresh without requiring a Home/Friends visit
  // (gateway RELATIONSHIP_* events keep them live afterwards).
  useFreshRelationships();

  // Phone: a swipe right from the left edge opens the navigation drawer, and
  // closes any details overlay first (two z-[80] surfaces never stack).
  useSwipeGesture(
    {
      onSwipeRight: () => {
        setContextPanelMode(null);
        setSidebarCollapsed(false);
      },
    },
    isMobile,
  );

  // Settings full-page routes (`/app/admin`, guild settings) keep their
  // internal padding inside the conversation pane.
  const isSettingsRoute =
    location.pathname === '/app/admin'
    || location.pathname === '/app/developers'
    || /^\/app\/guilds\/[^/]+\/settings$/.test(location.pathname);

  const routeContentRef = useContentSwap<HTMLDivElement>(location.pathname);

  // Phone persistent call surface: the call dock at the foot of the navigation
  // drawer is out of reach while the drawer is closed, so the bottom dock stays
  // mounted whenever connected and not already on the voice channel's page.
  // The wide and compact frames show the places panel (and its call dock)
  // permanently or one tap away, so they never mount it.
  const isOnVoiceChannel = voiceChannelId
    ? location.pathname.includes(`/channels/${voiceChannelId}`)
    : false;
  const showOnAirDock = isMobile && voiceConnected && !isOnVoiceChannel;

  const showSidebarOverlay = isMobile && sidebarMobileSynced.current && !sidebarCollapsed;

  // The phone drawer is modal (it covers a dimmed but present pane), so it
  // traps focus, moves focus inside on open, restores it on close, and honors
  // Escape — mirroring the settings dialogs (WCAG 2.4.3 / 2.1.2).
  useFocusTrap(sidebarOverlayRef, showSidebarOverlay, closeSidebarOverlay);

  const onAirDockPresence = usePresence(showOnAirDock);
  const sidebarPresence = usePresence(showSidebarOverlay);
  const userSettingsPresence = usePresence(userSettingsOpen);
  const guildSettingsPresence = usePresence(Boolean(guildSettingsId));

  // data-native-underlay-clear: while a stream renders on the native GL
  // underlay (Linux), the shell, the frame and the panes above the tile go
  // transparent so the tile is a real hole down to the video (layout.css).
  return (
      /* The banners stack at the very top of the viewport (`BannerStack`), and
         `--pc-banner-inset` is the room they take. Box-sizing is border-box
         everywhere, so the shell stays exactly one viewport tall and its own
         content moves down instead of disappearing under a banner. */
      <div
        data-native-underlay-clear=""
        data-glass-layout={layout}
        className="glass-shell"
        style={{ paddingTop: 'var(--pc-banner-inset, 0px)' }}
      >
        {/* The two moments nobody clicks: "lights on" and "someone arrives"
            (§5.1). It renders nothing — it is one subscription and two effects,
            mounted once so four subtrees cannot each grow their own copy. */}
        <MotionDirector />

        {/* The shared Watch/Listen together player of the call you are in:
            one for the whole app, laid over the Stage when you are there and
            still playing when you are not. */}
        <ErrorBoundary variant="section" label="Watch together">
          <TogetherHost />
        </ErrorBoundary>

        {/* Skip-to-content for keyboard/screen-reader users */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-[var(--radius-control)] focus:bg-accent-primary focus:px-4 focus:py-2 focus:text-label focus:font-semibold focus:text-text-on-accent focus:outline-none focus:[box-shadow:var(--focus-ring)]"
        >
          Skip to content
        </a>

        <GlassFrame layout={layout} guildId={guildId ?? null} channelId={channelId ?? null}>
          {/* Switching channels (or anywhere else) crossfades the page in
              with a 4px rise — never a slide (§5.2). */}
          <div
            ref={routeContentRef}
            className={cn('glass-outlet min-h-0 w-full flex-1 overflow-hidden', isSettingsRoute && 'p-3')}
          >
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
        </GlassFrame>

        {/* Phone: the navigation drawer (the full column, never the 64px
            rail). The backdrop fades while the drawer slides in from its edge
            on the ease-out and leaves on ease-in. */}
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
                <UnifiedSidebar alwaysExpanded />
              </ErrorBoundary>
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
              aria-label="Server settings"
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
