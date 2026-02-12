import { Outlet, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { UnifiedSidebar } from '../components/layout/UnifiedSidebar';
import { MemberList } from '../components/layout/MemberList';
import { CommandPalette } from '../components/layout/CommandPalette';
import { useUIStore } from '../stores/uiStore';
import { useGuildStore } from '../stores/guildStore';
export function AppLayout() {
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const memberPanelOpen = useUIStore((s) => s.memberPanelOpen);
  const memberSidebarOpen = useUIStore((s) => s.memberSidebarOpen);
  const selectedGuildId = useGuildStore((s) => s.selectedGuildId);
  const location = useLocation();

  const isSettingsRoute =
    location.pathname === '/app/settings'
    || location.pathname === '/app/admin'
    || /^\/app\/guilds\/[^/]+\/settings$/.test(location.pathname);

  const isGuildChannelRoute = /^\/app\/guilds\/[^/]+\/channels\/[^/]+$/.test(location.pathname);
  const showShell = !isSettingsRoute;
  const showMemberPanel = selectedGuildId && (memberPanelOpen || memberSidebarOpen) && isGuildChannelRoute && showShell;

  return (
    <div className="relative h-screen overflow-hidden p-2 md:p-2.5">
      {/* Ambient background glow */}
      <div className="pointer-events-none absolute -left-24 top-0 h-80 w-80 rounded-full bg-accent-primary/18 blur-[120px]" />
      <div className="pointer-events-none absolute right-0 top-1/4 h-72 w-72 rounded-full bg-accent-success/10 blur-[130px]" />
      <div className="pointer-events-none absolute bottom-0 left-1/3 h-72 w-72 rounded-full bg-accent-danger/6 blur-[150px]" />

      <div className="relative flex h-full gap-2 md:gap-2.5">
        {/* Unified sidebar */}
        {showShell && (
          <motion.aside
            initial={false}
            animate={{
              width: sidebarCollapsed ? 64 : 280,
            }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="glass-rail h-full shrink-0 overflow-hidden rounded-2xl"
          >
            <UnifiedSidebar />
          </motion.aside>
        )}

        {/* Main content area */}
        <main className="flex min-w-0 flex-1">
          {isSettingsRoute ? (
            <div className="relative h-full w-full overflow-hidden rounded-2xl border border-border-subtle/70 bg-bg-tertiary/80">
              <AnimatePresence mode="wait">
                <motion.div
                  key={location.pathname}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.17, ease: [0.22, 1, 0.36, 1] }}
                  className="relative flex h-full flex-col"
                >
                  <Outlet />
                </motion.div>
              </AnimatePresence>
            </div>
          ) : (
            <div className="glass-panel relative h-full w-full overflow-hidden rounded-2xl">
              <div className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-border-subtle/40" />
              <AnimatePresence mode="wait">
                <motion.div
                  key={location.pathname}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.17, ease: [0.22, 1, 0.36, 1] }}
                  className="relative flex h-full flex-col overflow-hidden"
                >
                  <Outlet />
                </motion.div>
              </AnimatePresence>
            </div>
          )}
        </main>

        {/* Member list panel */}
        {showMemberPanel && (
          <div className="hidden h-full overflow-hidden rounded-2xl 2xl:block">
            <div className="glass-rail h-full overflow-hidden">
              <MemberList />
            </div>
          </div>
        )}
      </div>

      {/* Command palette overlay */}
      <CommandPalette />
    </div>
  );
}
