import { useCallback, useEffect, useRef } from 'react';
import { Outlet, useLocation, useParams } from 'react-router-dom';
import { AnimatePresence, motion, MotionConfig } from 'framer-motion';
import { cn } from '../lib/utils';
import { UnifiedSidebar } from '../components/layout/sidebar/UnifiedSidebar';
import { ContextPanel } from '../components/layout/ContextPanel';
import { CommandPalette } from '../components/layout/CommandPalette';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { MiniVoiceBar } from '../components/voice/MiniVoiceBar';
import { MobileBottomNav } from '../components/layout/MobileBottomNav';
import { useUIStore } from '../stores/uiStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useChannelStore } from '../stores/channelStore';
import { useKeyboardNavigation } from '../hooks/useKeyboardNavigation';
import { useSwipeGesture } from '../hooks/useSwipeGesture';
import { useMobile } from '../hooks/useMobile';
import { SettingsPage } from './SettingsPage';
import { GuildSettingsPage } from './GuildSettingsPage';
import { LayoutTour } from '../components/onboarding/LayoutTour';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useRelationshipStore } from '../stores/relationshipStore';
import { InteractionModal } from '../components/message/InteractionModal';

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
 * `MotionConfig reducedMotion="user"` drops transform-based enters for users who
 * ask for reduced motion while keeping opacity fades (design-spec §5, §8).
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
  const activeChannel = useChannelStore((s) => (channelId ? s.channelsById[channelId] : undefined));

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

  // Open User Settings from deep links like /app?settings=identity (import flow).
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

  // Mobile swipe gestures (§6): right from the left edge opens the sidebar overlay;
  // left from the right edge opens the ContextPanel in `members` mode (mirrors the
  // old member-panel gesture).
  useSwipeGesture(
    {
      // Keep mobile overlays mutually exclusive — stacking two z-[80] surfaces
      // leaves the covered one stuck open underneath.
      onSwipeRight: () => {
        setContextPanelMode(null);
        setSidebarCollapsed(false);
      },
      onSwipeLeft: () => {
        setSidebarCollapsed(true);
        setContextPanelMode('members');
      },
    },
    isMobile,
  );

  // Settings full-page routes (`/app/admin`, guild settings) keep their internal
  // padding; the shell chrome (sidebar/context panel) stays present around them —
  // the Unified Sidebar is now universal navigation.
  const isSettingsRoute =
    location.pathname === '/app/admin'
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
    || (contextPanelMode === 'members' && Boolean(guildId || isGroupDmContext));

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
  const showMiniVoiceBar = isMobile && voiceConnected && !isOnVoiceChannel;

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

  // Emerald Commons elevation ramp (design-spec §1.1, kill-list #7): the whole
  // authenticated app lives inside a single surface ramp — `--bg-tertiary` base,
  // the raised `--bg-secondary` sidebar / context panel separated by 1px hairline
  // dividers, and the `--bg-primary` main canvas.
  const modalEnter = { duration: 0.24, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <MotionConfig reducedMotion="user">
      {/* data-native-underlay-clear: while a stream renders on the native GL
          underlay (Linux), this wrapper's background goes transparent so the
          tile is a real hole down to the video (see layout.css). */}
      <div
        data-native-underlay-clear=""
        className="flex h-[100dvh] w-full flex-col overflow-hidden bg-bg-tertiary text-text-primary"
      >
        {/* Skip-to-content for keyboard/screen-reader users */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-sm focus:bg-accent-primary focus:px-4 focus:py-2 focus:text-label focus:font-semibold focus:text-text-on-accent focus:outline-none focus:[box-shadow:var(--focus-ring)]"
        >
          Skip to content
        </a>

        <div className="flex min-h-0 flex-1">
          {/* Left rail — Unified Sidebar. Desktop renders inline (self-collapsing
              to the 64px icon rail); mobile renders it as an overlay below. */}
          {!isMobile && <UnifiedSidebar />}

          <main
            id="main-content"
            data-native-underlay-clear=""
            className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-bg-primary"
          >
            <div className={cn('min-h-0 w-full flex-1 overflow-hidden', isSettingsRoute && 'p-3')}>
              <Outlet />
            </div>
            <AnimatePresence>
              {showMiniVoiceBar && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  className="shrink-0 overflow-hidden border-t border-border-subtle"
                >
                  <MiniVoiceBar />
                </motion.div>
              )}
            </AnimatePresence>
          </main>

          {/* Right rail — ContextPanel (desktop inline; toggleable, not docked). */}
          {!isMobile && showContextPanel && (
            <ContextPanel guildId={guildId ?? null} channelId={channelId ?? null} manageFocus />
          )}
        </div>

        {/* Mobile: Unified Sidebar as a left overlay (§6 — full overlay, never the
            64px rail on mobile). */}
        <AnimatePresence>
          {showSidebarOverlay && (
            <motion.div
              className="fixed inset-0 z-[80] flex md:hidden modal-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={() => setSidebarCollapsed(true)}
            >
              <motion.div
                ref={sidebarOverlayRef}
                role="dialog"
                aria-modal="true"
                aria-label="Navigation"
                tabIndex={-1}
                className="h-full max-w-[88vw] overflow-hidden shadow-xl outline-none"
                initial={{ x: -24, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: -24, opacity: 0 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                onClick={(e) => e.stopPropagation()}
              >
                <UnifiedSidebar />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Mobile: ContextPanel as a right overlay (§6 — default closed). */}
        <AnimatePresence>
          {isMobile && showContextPanel && (
            <motion.div
              className="fixed inset-0 z-[80] flex justify-end md:hidden modal-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={() => setContextPanelMode(null)}
            >
              <motion.div
                ref={contextOverlayRef}
                role="dialog"
                aria-modal="true"
                aria-label="Details"
                tabIndex={-1}
                className="h-full max-w-[88vw] overflow-hidden shadow-xl outline-none"
                initial={{ x: 24, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 24, opacity: 0 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                onClick={(e) => e.stopPropagation()}
              >
                <ContextPanel guildId={guildId ?? null} channelId={channelId ?? null} />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {isMobile && <MobileBottomNav />}

        <CommandPalette />
        <ConfirmDialog />
        <InteractionModal />
        <LayoutTour />

        {/* Windowed settings overlays — spec modal enter (§4/§5): backdrop fade,
            surface scale .96→1 + rise, 240ms ease-out. */}
        <AnimatePresence>
          {userSettingsOpen && (
            <motion.div
              className="fixed inset-0 z-[150] flex items-center justify-center p-4 sm:p-8 md:p-12 lg:p-20 backdrop-blur-md modal-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={closeUserSettings}
            >
              <motion.div
                ref={userSettingsDialogRef}
                role="dialog"
                aria-modal="true"
                aria-label="User settings"
                tabIndex={-1}
                initial={{ scale: 0.96, opacity: 0, y: 8 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.96, opacity: 0, y: 8 }}
                transition={modalEnter}
                className="relative flex h-full max-h-[min(900px,85vh)] w-full max-w-6xl flex-col overflow-hidden rounded-lg shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <SettingsPage />
              </motion.div>
            </motion.div>
          )}

          {guildSettingsId && (
            <motion.div
              className="fixed inset-0 z-[150] flex items-center justify-center p-4 sm:p-8 md:p-12 lg:p-20 backdrop-blur-md modal-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={closeGuildSettings}
            >
              <motion.div
                ref={guildSettingsDialogRef}
                role="dialog"
                aria-modal="true"
                aria-label="Space settings"
                tabIndex={-1}
                initial={{ scale: 0.96, opacity: 0, y: 8 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.96, opacity: 0, y: 8 }}
                transition={modalEnter}
                className="relative flex h-full max-h-[min(900px,85vh)] w-full max-w-6xl flex-col overflow-hidden rounded-lg shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <GuildSettingsPage />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
