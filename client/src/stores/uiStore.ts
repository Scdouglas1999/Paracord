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
 * All readers select `contextPanelMode` directly — the wave-2 mirrored
 * per-panel booleans were retired in the cleanup wave (layout-spec §8 step 15).
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
  theme: Theme;
  accentPreset: AccentPreset;
  customCss: string;
  serverRestarting: boolean;
  commandPaletteOpen: boolean;
  contextPanelMode: ContextPanelMode;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  connectionStatus: ConnectionStatus;
  connectionLatency: number;
  lowBandwidthMode: boolean;
  userSettingsOpen: boolean;
  guildSettingsId: string | null;
  guildSettingsInitialSection: string | null;
  guildSettingsChannelId: string | null;

  setTheme: (theme: Theme) => void;
  setAccentPreset: (accentPreset: AccentPreset) => void;
  setCustomCss: (css: string) => void;
  setServerRestarting: (v: boolean) => void;
  toggleCommandPalette: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setContextPanelMode: (mode: ContextPanelMode) => void;
  toggleContextPanelMode: (mode: Exclude<ContextPanelMode, null>) => void;
  setSidebarWidth: (px: number) => void;
  toggleSidebarCollapsed: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
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
      theme: 'dark',
      accentPreset: 'emerald',
      customCss: '',
      serverRestarting: false,
      commandPaletteOpen: false,
      contextPanelMode: null,
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
      sidebarCollapsed: false,
      connectionStatus: 'disconnected' as ConnectionStatus,
      connectionLatency: 0,
      lowBandwidthMode: false,
      userSettingsOpen: false,
      guildSettingsId: null,
      guildSettingsInitialSection: null,
      guildSettingsChannelId: null,

      setTheme: (theme) => set({ theme }),
      setAccentPreset: (accentPreset) => set({ accentPreset }),
      setCustomCss: (customCss) => set({ customCss }),
      setServerRestarting: (serverRestarting) => set({ serverRestarting }),
      toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
      setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),

      // contextPanelMode is the single source of truth for the right panel.
      setContextPanelMode: (contextPanelMode) => set({ contextPanelMode }),
      toggleContextPanelMode: (mode) => set((s) => ({
        contextPanelMode: s.contextPanelMode === mode ? null : mode,
      })),
      setSidebarWidth: (px) => set({ sidebarWidth: clampSidebarWidth(px) }),
      toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
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
        contextPanelMode: state.contextPanelMode,
        sidebarWidth: state.sidebarWidth,
        sidebarCollapsed: state.sidebarCollapsed,
        lowBandwidthMode: state.lowBandwidthMode,
      }),
    }
  )
);
