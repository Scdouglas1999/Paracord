import { useFreshRelationships } from '../hooks/useFreshRelationships';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { registerAppNavigate } from '../lib/appNavigate';
// §5.1/§5.3: every overlay here rides the shared recipes — backdrops fade
// (pc-fade), panels enter/exit on pc-enter/pc-exit, drawers slide on the
// pc-drawer set — and usePresence keeps each mounted for its leave. The
// engine's data-motion switch is the only reduced-motion source of truth.
import { usePresence } from '../lib/motion';
import { cn } from '../lib/utils';
import { CommandPalette } from '../components/layout/CommandPalette';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { TogetherHost } from '../components/voice/together/TogetherHost';
import { usePhoneNavigation, usePhoneNavStore } from '../components/glass/shell/phoneNav';
import { IxFrame } from '../components/ix/shell/IxFrame';
import { useEdgeSwipe } from '../components/ix/shell/phone/useEdgeSwipe';
import { useIxLayout } from '../components/ix/shell/useIxLayout';
import { useGlassStore } from '../stores/glassStore';
import { useUIStore } from '../stores/uiStore';
import { useKeyboardNavigation } from '../hooks/useKeyboardNavigation';
import { SettingsPage } from './SettingsPage';
import { GuildSettingsPage } from './GuildSettingsPage';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { InteractionModal } from '../components/message/InteractionModal';
import { ErrorBoundary } from '../components/ErrorBoundary';

/**
 * AppShell — the Index frame (docs/index-spec.md §3; IX-4).
 *
 * Two flush columns on the ground, separated by a hairline:
 *
 *   [ sidebar 316: pinned card, place panes, dock ]  [ <main> toolbar + <Outlet/> ]
 *
 * Geometry lives in `IxFrame` (components/ix/shell): the columns, the window
 * tint, the place slide, the toolbar, and the hosts of the call view and the
 * sheets. What fills each host is a slot (`components/ix/shell/slots.ts`).
 *
 * This component keeps the app-level concerns the frame does not own: route
 * navigation for non-React callers, keyboard shortcuts, the settings dialogs,
 * the command palette, the confirm and interaction hosts, the skip link, and
 * the phone's navigation (index-spec §9, IX-16): on a phone the frame is two
 * screens (the sidebar, then main pushed over it) and this decides the first
 * one (`usePhoneNavigation`), turns the old drawer requests into the root
 * screen, and turns on the back gesture (`useEdgeSwipe`).
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

  const layout = useIxLayout();
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

  // Phone: the back gesture (IX-16). A finger from the left edge drags the page
  // in front away (a pushed sheet, or main off the sidebar) and the screen
  // beneath follows it in; a route's own pushed page (a thread) takes it as its
  // back. What is in front is decided when the finger lands (`useEdgeSwipe`);
  // here, only whether anything may take the edge at all: not under the call,
  // not under settings.
  const stageOpen = useGlassStore((s) => s.stage.mode !== 'none');
  const swipeBackEnabled = isMobile && !stageOpen && !userSettingsOpen && !guildSettingsId;
  useEdgeSwipe(swipeBackEnabled);

  // Settings full-page routes (`/app/admin`, guild settings) keep their
  // internal padding inside the conversation pane.
  const isSettingsRoute =
    location.pathname === '/app/admin'
    || location.pathname === '/app/developers'
    || /^\/app\/guilds\/[^/]+\/settings$/.test(location.pathname);

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
        className="ix-app"
        style={{ paddingTop: 'var(--pc-banner-inset, 0px)' }}
      >
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

        <IxFrame guildId={guildId ?? null} channelId={channelId ?? null}>
          {/* What comes in when the route changes is the frame's to play
              (index-spec §5.1, §5.2: the title and the feed, from the
              direction the selection moved; IxFrame's useMainEntrance). */}
          <div
            className={cn('ix-outlet min-h-0 w-full flex-1 overflow-hidden', isSettingsRoute && 'p-3')}
          >
            <Outlet />
          </div>
        </IxFrame>

        <CommandPalette />
        <ConfirmDialog />
        <InteractionModal />

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
