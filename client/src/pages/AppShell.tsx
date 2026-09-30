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
import { CommandPalette } from '../components/layout/CommandPalette';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { TogetherHost } from '../components/voice/together/TogetherHost';
import { MotionDirector } from '../components/motion/MotionDirector';
import { GlassFrame, useGlassLayout, usePhoneNavigation, usePhoneNavStore } from '../components/glass/shell';
import { useGlassStore } from '../stores/glassStore';
import { useUIStore } from '../stores/uiStore';
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
 * the phone's navigation: on a phone the frame is two screens (places, then the
 * conversation) and this decides the first one, takes the edge swipe back and
 * turns the old drawer requests into the places screen (`usePhoneNavigation`).
 * There is no bottom bar: Home and messages are the server row's first circle,
 * search and members are the conversation header's, Friends is a row in Home,
 * and settings are the account menu behind your face on the places screen.
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

  const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed);
  const location = useLocation();
  const { guildId, channelId } = useParams();

  const userSettingsOpen = useUIStore((s) => s.userSettingsOpen);
  const guildSettingsId = useUIStore((s) => s.guildSettingsId);
  const setUserSettingsOpen = useUIStore((s) => s.setUserSettingsOpen);
  const setGuildSettingsId = useUIStore((s) => s.setGuildSettingsId);
  const userSettingsDialogRef = useRef<HTMLDivElement>(null);
  const guildSettingsDialogRef = useRef<HTMLDivElement>(null);
  const closeUserSettings = useCallback(() => setUserSettingsOpen(false), [setUserSettingsOpen]);
  const closeGuildSettings = useCallback(() => setGuildSettingsId(null), [setGuildSettingsId]);

  useFocusTrap(userSettingsDialogRef, userSettingsOpen, closeUserSettings);
  useFocusTrap(guildSettingsDialogRef, Boolean(guildSettingsId), closeGuildSettings);

  const layout = useGlassLayout();
  const isMobile = layout === 'phone';

  // PHONE. The navigation drawer is gone: places is a screen of its own. The
  // old drawer flag (`sidebarCollapsed`) is kept collapsed on a phone, because
  // the conversation header's button and Ctrl+B still ask for the navigation by
  // opening it, and `usePhoneNavigation` takes that request and shows places.
  // It has to land before the first paint (a layout effect), or a phone that last
  // ran with it open would start on a stale drawer.
  useLayoutEffect(() => {
    setSidebarCollapsed(isMobile);
  }, [isMobile, setSidebarCollapsed]);
  usePhoneNavigation(isMobile);

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

  // Phone: a swipe right from the left edge goes back from a conversation to
  // places, as a platform's back gesture does. Whatever owns the edge keeps it:
  // a dialog, a sheet, full screen, or places itself.
  const phoneScreen = usePhoneNavStore((s) => s.screen);
  const sheetOpen = useGlassStore((s) => s.sheet !== null);
  const fullScreen = useGlassStore((s) => s.stage.mode === 'theater');
  const swipeBackEnabled =
    isMobile && phoneScreen === 'conversation' && !sheetOpen && !fullScreen && !userSettingsOpen && !guildSettingsId;
  useSwipeGesture({ onSwipeRight: () => usePhoneNavStore.getState().showPlaces() }, swipeBackEnabled);

  // Settings full-page routes (`/app/admin`, guild settings) keep their
  // internal padding inside the conversation pane.
  const isSettingsRoute =
    location.pathname === '/app/admin'
    || location.pathname === '/app/developers'
    || /^\/app\/guilds\/[^/]+\/settings$/.test(location.pathname);

  const routeContentRef = useContentSwap<HTMLDivElement>(location.pathname);

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

        {/* Skip-to-content for keyboard/screen-reader users. On a phone's places
            screen the content is the conversation behind it, so it brings the
            conversation in (the frame then focuses it). */}
        <a
          href="#main-content"
          onClick={(event) => {
            if (!isMobile || usePhoneNavStore.getState().screen !== 'places') return;
            event.preventDefault();
            usePhoneNavStore.getState().showConversation();
          }}
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
        </GlassFrame>

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
