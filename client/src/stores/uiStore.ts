import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Theme = 'dark' | 'light' | 'amoled';
export type AccentPreset =
  | 'red'
  | 'blue'
  | 'emerald'
  | 'amber'
  | 'rose'
  | 'violet'
  | 'cyan'
  | 'lime'
  | 'orange'
  | 'slate';

type ConnectionStatus = 'connected' | 'connecting' | 'reconnecting' | 'disconnected';

interface UIState {
  sidebarOpen: boolean;
  dockPinned: boolean;
  /** @deprecated Use memberPanelOpen instead */
  memberSidebarOpen: boolean;
  theme: Theme;
  accentPreset: AccentPreset;
  customCss: string;
  compactMode: boolean;
  serverRestarting: boolean;
  commandPaletteOpen: boolean;
  memberPanelOpen: boolean;
  sidebarCollapsed: boolean;
  searchPanelOpen: boolean;
  connectionStatus: ConnectionStatus;
  connectionLatency: number;

  toggleSidebar: () => void;
  toggleDockPinned: () => void;
  setDockPinned: (pinned: boolean) => void;
  toggleMemberSidebar: () => void;
  setTheme: (theme: Theme) => void;
  setAccentPreset: (accentPreset: AccentPreset) => void;
  setCustomCss: (css: string) => void;
  setCompactMode: (compact: boolean) => void;
  setServerRestarting: (v: boolean) => void;
  toggleCommandPalette: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleMemberPanel: () => void;
  setMemberPanelOpen: (open: boolean) => void;
  toggleSidebarCollapsed: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSearchPanel: () => void;
  setSearchPanelOpen: (open: boolean) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setConnectionLatency: (latency: number) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      dockPinned: true,
      memberSidebarOpen: true,
      theme: 'dark',
      accentPreset: 'red',
      customCss: '',
      compactMode: false,
      serverRestarting: false,
      commandPaletteOpen: false,
      memberPanelOpen: true,
      sidebarCollapsed: false,
      searchPanelOpen: false,
      connectionStatus: 'disconnected' as ConnectionStatus,
      connectionLatency: 0,

      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      toggleDockPinned: () => set((s) => ({ dockPinned: !s.dockPinned })),
      setDockPinned: (dockPinned) => set({ dockPinned }),
      toggleMemberSidebar: () => set((s) => ({ memberPanelOpen: !s.memberPanelOpen, memberSidebarOpen: !s.memberPanelOpen })),
      setTheme: (theme) => set({ theme }),
      setAccentPreset: (accentPreset) => set({ accentPreset }),
      setCustomCss: (customCss) => set({ customCss }),
      setCompactMode: (compactMode) => set({ compactMode }),
      setServerRestarting: (serverRestarting) => set({ serverRestarting }),
      toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
      setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
      toggleMemberPanel: () => set((s) => ({ memberPanelOpen: !s.memberPanelOpen, memberSidebarOpen: !s.memberPanelOpen })),
      setMemberPanelOpen: (memberPanelOpen) => set({ memberPanelOpen, memberSidebarOpen: memberPanelOpen }),
      toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      toggleSearchPanel: () => set((s) => ({ searchPanelOpen: !s.searchPanelOpen })),
      setSearchPanelOpen: (searchPanelOpen) => set({ searchPanelOpen }),
      setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
      setConnectionLatency: (connectionLatency) => set({ connectionLatency }),
    }),
    {
      name: 'ui-storage',
      partialize: (state) => ({
        theme: state.theme,
        accentPreset: state.accentPreset,
        customCss: state.customCss,
        compactMode: state.compactMode,
        dockPinned: state.dockPinned,
        memberSidebarOpen: state.memberSidebarOpen,
        memberPanelOpen: state.memberPanelOpen,
        sidebarCollapsed: state.sidebarCollapsed,
      }),
    }
  )
);
