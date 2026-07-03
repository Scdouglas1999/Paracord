import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Theme = 'dark' | 'light' | 'amoled' | 'high-contrast';
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
  lowBandwidthMode: boolean;
  userSettingsOpen: boolean;
  guildSettingsId: string | null;
  guildSettingsInitialSection: string | null;
  guildSettingsChannelId: string | null;

  toggleSidebar: () => void;
  toggleDockPinned: () => void;
  setDockPinned: (pinned: boolean) => void;
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
  setLowBandwidthMode: (enabled: boolean) => void;
  setUserSettingsOpen: (open: boolean) => void;
  setGuildSettingsId: (id: string | null) => void;
  openGuildSettings: (id: string, initialSection?: string | null, channelId?: string | null) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      dockPinned: true,
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
      lowBandwidthMode: false,
      userSettingsOpen: false,
      guildSettingsId: null,
      guildSettingsInitialSection: null,
      guildSettingsChannelId: null,

      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      toggleDockPinned: () => set((s) => ({ dockPinned: !s.dockPinned })),
      setDockPinned: (dockPinned) => set({ dockPinned }),
      setTheme: (theme) => set({ theme }),
      setAccentPreset: (accentPreset) => set({ accentPreset }),
      setCustomCss: (customCss) => set({ customCss }),
      setCompactMode: (compactMode) => set({ compactMode }),
      setServerRestarting: (serverRestarting) => set({ serverRestarting }),
      toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
      setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
      toggleMemberPanel: () => set((s) => ({ memberPanelOpen: !s.memberPanelOpen })),
      setMemberPanelOpen: (memberPanelOpen) => set({ memberPanelOpen }),
      toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      toggleSearchPanel: () => set((s) => ({ searchPanelOpen: !s.searchPanelOpen })),
      setSearchPanelOpen: (searchPanelOpen) => set({ searchPanelOpen }),
      setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
      setConnectionLatency: (connectionLatency) => set({ connectionLatency }),
      setLowBandwidthMode: (lowBandwidthMode) => set({ lowBandwidthMode }),
      setUserSettingsOpen: (userSettingsOpen) => set({ userSettingsOpen }),
      setGuildSettingsId: (guildSettingsId) => set({
        guildSettingsId,
        guildSettingsInitialSection: null,
        guildSettingsChannelId: null,
      }),
      openGuildSettings: (guildSettingsId, guildSettingsInitialSection = null, guildSettingsChannelId = null) =>
        set({ guildSettingsId, guildSettingsInitialSection, guildSettingsChannelId }),
    }),
    {
      name: 'ui-storage',
      partialize: (state) => ({
        theme: state.theme,
        accentPreset: state.accentPreset,
        customCss: state.customCss,
        compactMode: state.compactMode,
        dockPinned: state.dockPinned,
        memberPanelOpen: state.memberPanelOpen,
        sidebarCollapsed: state.sidebarCollapsed,
        lowBandwidthMode: state.lowBandwidthMode,
      }),
    }
  )
);
