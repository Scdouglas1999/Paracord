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

/**
 * The single source of truth for the toggleable right-hand context panel
 * (layout-spec §1). Exactly one mode is active at a time; `null` = closed.
 * The legacy `memberPanelOpen`/`economyPanelOpen`/`searchPanelOpen` booleans
 * are mirrored views of this value kept in sync by the setters below.
 */
export type ContextPanelMode = 'members' | 'threads' | 'pins' | 'search' | 'economy' | null;

/**
 * Resizable unified-sidebar width bounds (layout-spec §5/§6). These mirror the
 * intended `--sidebar-min`…`--sidebar-max` token range; the frame + styles lane
 * consumes these constants so the clamp and the CSS tokens stay in lockstep.
 */
export const SIDEBAR_WIDTH_MIN = 240;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_DEFAULT = 300;

const clampSidebarWidth = (px: number): number => {
  if (!Number.isFinite(px)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(px)));
};

interface UIState {
  sidebarOpen: boolean;
  dockPinned: boolean;
  theme: Theme;
  accentPreset: AccentPreset;
  customCss: string;
  serverRestarting: boolean;
  commandPaletteOpen: boolean;
  contextPanelMode: ContextPanelMode;
  sidebarWidth: number;
  memberPanelOpen: boolean;
  economyPanelOpen: boolean;
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
  setServerRestarting: (v: boolean) => void;
  toggleCommandPalette: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setContextPanelMode: (mode: ContextPanelMode) => void;
  toggleContextPanelMode: (mode: Exclude<ContextPanelMode, null>) => void;
  setSidebarWidth: (px: number) => void;
  toggleMemberPanel: () => void;
  setMemberPanelOpen: (open: boolean) => void;
  toggleEconomyPanel: () => void;
  setEconomyPanelOpen: (open: boolean) => void;
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
    (set, get) => ({
      sidebarOpen: true,
      dockPinned: true,
      theme: 'dark',
      accentPreset: 'emerald',
      customCss: '',
      serverRestarting: false,
      commandPaletteOpen: false,
      contextPanelMode: null,
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
      memberPanelOpen: false,
      economyPanelOpen: false,
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
      setServerRestarting: (serverRestarting) => set({ serverRestarting }),
      toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
      setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),

      // contextPanelMode is the single source of truth for the right panel.
      // Every mutation mirrors the legacy booleans so un-migrated selectors
      // (TopBar/AppLayout/TextChannelView) keep resolving correctly.
      setContextPanelMode: (contextPanelMode) => set({
        contextPanelMode,
        memberPanelOpen: contextPanelMode === 'members',
        economyPanelOpen: contextPanelMode === 'economy',
        searchPanelOpen: contextPanelMode === 'search',
      }),
      toggleContextPanelMode: (mode) => set((s) => {
        const next = s.contextPanelMode === mode ? null : mode;
        return {
          contextPanelMode: next,
          memberPanelOpen: next === 'members',
          economyPanelOpen: next === 'economy',
          searchPanelOpen: next === 'search',
        };
      }),
      setSidebarWidth: (px) => set({ sidebarWidth: clampSidebarWidth(px) }),

      // --- Legacy seam adapters: route through contextPanelMode (layout-spec §8.7) ---
      toggleMemberPanel: () => get().toggleContextPanelMode('members'),
      setMemberPanelOpen: (open) => get().setContextPanelMode(open ? 'members' : null),
      toggleEconomyPanel: () => get().toggleContextPanelMode('economy'),
      setEconomyPanelOpen: (open) => get().setContextPanelMode(open ? 'economy' : null),
      toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      toggleSearchPanel: () => get().toggleContextPanelMode('search'),
      setSearchPanelOpen: (open) => get().setContextPanelMode(open ? 'search' : null),
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
        dockPinned: state.dockPinned,
        contextPanelMode: state.contextPanelMode,
        sidebarWidth: state.sidebarWidth,
        sidebarCollapsed: state.sidebarCollapsed,
        lowBandwidthMode: state.lowBandwidthMode,
      }),
      // Re-derive the mirrored panel booleans from the rehydrated
      // contextPanelMode (single source of truth) so they never desync.
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<UIState>) };
        const mode = merged.contextPanelMode ?? null;
        return {
          ...merged,
          contextPanelMode: mode,
          memberPanelOpen: mode === 'members',
          economyPanelOpen: mode === 'economy',
          searchPanelOpen: mode === 'search',
        };
      },
    }
  )
);
