import { useCallback, useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
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

  return (
    <div className="workspace-canvas">
      {/* Skip-to-content for keyboard/screen-reader users */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-xl focus:bg-accent-primary focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-text-on-accent focus:shadow-lg"
      >
        Skip to content
      </a>

      <div className="workspace-stage">
        {showShell && !isMobile && (
          <aside className="dock-stage">
            <Sidebar />
          </aside>
        )}

        <div className="stage-grid">
          {showDesktopChannelPanel && (
            <aside className={`panel-surface nav-panel nav-panel-collapsible ${sidebarOpen ? 'nav-panel-expanded' : 'nav-panel-collapsed'}`}>
              <ChannelSidebar collapsed={!sidebarOpen} />
            </aside>
          )}

          <main id="main-content" className="content-panel">
            <div className={isSettingsRoute ? 'settings-route-shell h-full w-full' : 'panel-surface stage-panel'}>
              <Outlet />
            </div>
            <AnimatePresence>
              {showMiniVoiceBar && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="shrink-0 overflow-hidden"
                >
                  <MiniVoiceBar />
                </motion.div>
              )}
            </AnimatePresence>
          </main>

          {showMemberPanel && (
            <aside className="panel-surface member-panel">
              <MemberList />
            </aside>
          )}
        </div>
      </div>

      <AnimatePresence>
        {showMobileChannelPanel && (
          <motion.div
            className="mobile-sidebar-overlay md:hidden modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSidebarCollapsed(true)}
          >
            <motion.aside
              className="panel-surface mobile-nav-panel"
              initial={{ x: -24, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -24, opacity: 0 }}
              transition={{ duration: 0.16 }}
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

      {/* Windowed Settings Overlays */}
      <AnimatePresence>
        {userSettingsOpen && (
          <motion.div
            className="fixed inset-0 z-[150] flex items-center justify-center p-4 sm:p-8 md:p-12 lg:p-20 backdrop-blur-md modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <motion.div
              ref={userSettingsDialogRef}
              role="dialog"
              aria-modal="true"
              aria-label="User settings"
              tabIndex={-1}
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="w-full h-full max-w-6xl max-h-[min(900px,85vh)] shadow-2xl relative flex flex-col"
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
            transition={{ duration: 0.15 }}
          >
            <motion.div
              ref={guildSettingsDialogRef}
              role="dialog"
              aria-modal="true"
              aria-label="Server settings"
              tabIndex={-1}
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="w-full h-full max-w-6xl max-h-[min(900px,85vh)] shadow-2xl relative flex flex-col"
            >
              <GuildSettingsPage />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
