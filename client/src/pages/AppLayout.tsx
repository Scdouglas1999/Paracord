import { useCallback, useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion, MotionConfig } from 'framer-motion';
import { cn } from '../lib/utils';
import { Sidebar } from '../components/layout/Sidebar';
import { ChannelSidebar } from '../components/layout/ChannelSidebar';
import { MemberList } from '../components/layout/MemberList';
import { CommandPalette } from '../components/layout/CommandPalette';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { MiniVoiceBar } from '../components/voice/MiniVoiceBar';
import { MobileBottomNav } from '../components/layout/MobileBottomNav';
import { useUIStore } from '../stores/uiStore';
import { useGuildStore } from '../stores/guildStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useKeyboardNavigation } from '../hooks/useKeyboardNavigation';
import { useSwipeGesture } from '../hooks/useSwipeGesture';
import { useMobile } from '../hooks/useMobile';
import { SettingsPage } from './SettingsPage';
import { GuildSettingsPage } from './GuildSettingsPage';
import { useFocusTrap } from '../hooks/useFocusTrap';

export function AppLayout() {
  useKeyboardNavigation();

  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed);
  const memberPanelOpen = useUIStore((s) => s.memberPanelOpen);
  const selectedGuildId = useGuildStore((s) => s.selectedGuildId);
  const voiceConnected = useVoiceStore((s) => s.connected);
  const voiceChannelId = useVoiceStore((s) => s.channelId);
  const location = useLocation();

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

  const isMobile = useMobile();

  useEffect(() => {
    setSidebarCollapsed(isMobile);
  }, [isMobile, setSidebarCollapsed]);

  // Mobile swipe gestures: right from left edge → open sidebar, left from right edge → open member list
  const setMemberPanelOpen = useUIStore((s) => s.setMemberPanelOpen);
  useSwipeGesture(
    {
      onSwipeRight: () => setSidebarCollapsed(false),
      onSwipeLeft: () => {
        if (selectedGuildId) setMemberPanelOpen(true);
      },
    },
    isMobile,
  );

  // User settings render as an overlay (see userSettingsOpen), not a route, so there is
  // no /app/settings path to match here. Admin and guild-settings are real full-page routes.
  const isSettingsRoute =
    location.pathname === '/app/admin'
    || /^\/app\/guilds\/[^/]+\/settings$/.test(location.pathname);
  const isGuildChannelRoute = /^\/app\/guilds\/[^/]+\/channels\/[^/]+$/.test(location.pathname);

  // Since we are changing settings to overlays, we don't need to hide the shell for them anymore
  // But we'll keep the variable false for now just in case a user hits the explicit URL directly.
  const showShell = !isSettingsRoute;
  const showDesktopChannelPanel = showShell && !isMobile;
  const showMobileChannelPanel = showShell && isMobile && sidebarOpen && !sidebarCollapsed;
  const showMemberPanel =
    Boolean(selectedGuildId)
    && memberPanelOpen
    && isGuildChannelRoute
    && showShell
    && !isMobile;

  // Show mini voice bar when connected to voice but viewing a different page.
  // The VoiceControls in ChannelSidebar already covers the voice channel page.
  const isOnVoiceChannel = voiceChannelId
    ? location.pathname.includes(`/channels/${voiceChannelId}`)
    : false;
  const showMiniVoiceBar = isMobile && voiceConnected && !isOnVoiceChannel;

  // Emerald Commons frame. The whole authenticated app lives inside a single
  // three-surface elevation ramp rather than a set of stitched floating cards
  // (design-spec §1.1, kill-list #7): the guild-rail gutter is the deepest
  // `--bg-tertiary`, the channel + member panels are the raised `--bg-secondary`
  // separated by 1px hairline dividers, and the main canvas is `--bg-primary`.
  // `MotionConfig reducedMotion="user"` drops transform-based enters for users who
  // ask for reduced motion while keeping the opacity fades (design-spec §5, §8).
  const modalEnter = { duration: 0.24, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-bg-tertiary text-text-primary">
        {/* Skip-to-content for keyboard/screen-reader users */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-sm focus:bg-accent-primary focus:px-4 focus:py-2 focus:text-label focus:font-semibold focus:text-text-on-accent focus:outline-none focus:[box-shadow:var(--focus-ring)]"
        >
          Skip to content
        </a>

        <div className="flex min-h-0 flex-1">
          {showShell && !isMobile && (
            <aside className="flex shrink-0 items-center bg-bg-tertiary px-2.5">
              <Sidebar />
            </aside>
          )}

          <div className="flex min-w-0 flex-1">
            {showDesktopChannelPanel && (
              <aside
                className={cn(
                  'shrink-0 overflow-hidden border-r border-border-subtle bg-bg-secondary transition-[width] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
                  sidebarOpen ? 'w-[var(--spacing-channel-sidebar-width)]' : 'w-[52px]',
                )}
              >
                <ChannelSidebar collapsed={!sidebarOpen} />
              </aside>
            )}

            <main
              id="main-content"
              className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-bg-primary"
            >
              <div
                className={cn(
                  'min-h-0 w-full flex-1 overflow-hidden',
                  isSettingsRoute && 'p-3',
                )}
              >
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

            {showMemberPanel && (
              <aside className="w-[var(--member-list-width)] shrink-0 overflow-hidden border-l border-border-subtle bg-bg-secondary">
                <MemberList />
              </aside>
            )}
          </div>
        </div>

        <AnimatePresence>
          {showMobileChannelPanel && (
            <motion.div
              className="fixed inset-0 z-[80] flex md:hidden modal-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={() => setSidebarCollapsed(true)}
            >
              <motion.aside
                className="h-full w-[min(88vw,19rem)] overflow-hidden border-r border-border-subtle bg-bg-secondary shadow-xl"
                initial={{ x: -24, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: -24, opacity: 0 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                onClick={(e) => e.stopPropagation()}
              >
                <ChannelSidebar />
              </motion.aside>
            </motion.div>
          )}
        </AnimatePresence>

        {isMobile && showShell && <MobileBottomNav />}

        <CommandPalette />
        <ConfirmDialog />

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
                aria-label="Server settings"
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
