import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { MotionPreference } from '../lib/motion/reducedMotion';
import {
  DEFAULT_THEME,
  asThemeId,
  asTransparencyPreference,
  type ThemeId,
  type TransparencyPreference,
} from '../lib/themes';

/**
 * The theme, per device: `glass` or `glass-contrast` (`lib/themes.ts`). It is
 * one string, stored and synced like any other setting, and `useTheme` is the
 * one place a value from the server is narrowed to it. What an OLDER build
 * wrote is handled here, once, when the persisted blob is loaded (see
 * `migrate` below), so nothing downstream ever sees a retired id.
 */
type Theme = ThemeId;

type ConnectionStatus = 'connected' | 'connecting' | 'reconnecting' | 'disconnected';

/**
 * Bumped when a persisted field is retired or reshaped. `migrate` below is the
 * only code that reads an older blob.
 *   0  eight themes (the looks), accent presets, base hue and tint
 *   1  Glass: `glass` / `glass-contrast`, `transparency`; the rest is gone
 */
const UI_STORAGE_VERSION = 1;

/**
 * The single source of truth for the toggleable right-hand context panel
 * (layout-spec §1). Exactly one mode is active at a time; `null` = closed.
 * All readers select `contextPanelMode` directly — the wave-2 mirrored
 * per-panel booleans were retired in the cleanup wave (layout-spec §8 step 15).
 */
export type ContextPanelMode = 'recipients' | 'threads' | 'pins' | 'search' | 'economy' | 'media' | null;

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
  /**
   * How much the panes may be see-through (docs/glass-spec.md §4). `system`
   * follows the device; `standard` and `reduced` override it. `useTheme`
   * publishes the answer as `data-reduced-transparency` on <html>.
   */
  transparency: TransparencyPreference;
  /**
   * How much this app is allowed to move (docs/lantern-stage-spec.md §5.3).
   * `system` follows `prefers-reduced-motion`; `full` and `reduced` override
   * it. `useTheme` hands this to `configureMotion`, which is the ONE switch —
   * nothing reads this field to decide whether to animate.
   */
  motion: MotionPreference;
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
  userSettingsInitialSection: string | null;
  guildSettingsId: string | null;
  guildSettingsInitialSection: string | null;
  guildSettingsChannelId: string | null;

  setTheme: (theme: Theme) => void;
  setTransparency: (transparency: TransparencyPreference) => void;
  setMotion: (motion: MotionPreference) => void;
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
  setUserSettingsOpen: (open: boolean, initialSection?: string | null) => void;
  setGuildSettingsId: (id: string | null) => void;
  openGuildSettings: (id: string, initialSection?: string | null, channelId?: string | null) => void;
}

/**
 * Bring a persisted blob from an older build up to version 1.
 *
 * Version 0 carried the looks: a theme id from a list of eight, an accent
 * preset, a base hue and tint. None of that survives. The theme becomes
 * `glass`, or `glass-contrast` if it was `high-contrast` (a legibility choice,
 * not a taste), and the three retired fields are dropped so `persist`'s shallow
 * merge does not carry them into the live store. A field that is not there is
 * left alone (the default stands), and everything it does not recognize is
 * ignored: nothing here throws, because a stored value nobody understands is
 * never a reason to fail to start.
 *
 * Used twice, on purpose. `migrate` runs when the stored version is older than
 * this build's; `merge` runs on every load, which also covers a blob that
 * carries no version number at all (`persist` does not migrate those).
 */
function migratePersistedUI(persisted: unknown): Partial<UIState> {
  const stored: Record<string, unknown> =
    persisted !== null && typeof persisted === 'object' ? { ...(persisted as Record<string, unknown>) } : {};
  delete stored.accentPreset;
  delete stored.baseHue;
  delete stored.baseTint;
  if ('theme' in stored) stored.theme = asThemeId(stored.theme);
  if ('transparency' in stored) stored.transparency = asTransparencyPreference(stored.transparency);
  return stored as Partial<UIState>;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      theme: DEFAULT_THEME,
      transparency: 'system' as TransparencyPreference,
      motion: 'system' as MotionPreference,
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
      userSettingsInitialSection: null,
      guildSettingsId: null,
      guildSettingsInitialSection: null,
      guildSettingsChannelId: null,

      setTheme: (theme) => set({ theme }),
      setTransparency: (transparency) => set({ transparency }),
      setMotion: (motion) => set({ motion }),
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
      setUserSettingsOpen: (userSettingsOpen, userSettingsInitialSection = null) =>
        set({
          userSettingsOpen,
          userSettingsInitialSection: userSettingsOpen
            ? (userSettingsInitialSection ?? null)
            : null,
        }),
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
      version: UI_STORAGE_VERSION,
      migrate: migratePersistedUI,
      merge: (persisted, current) => ({ ...current, ...migratePersistedUI(persisted) }),
      partialize: (state) => ({
        theme: state.theme,
        transparency: state.transparency,
        motion: state.motion,
        customCss: state.customCss,
        // Context panels are transient route context. Persisting one makes an
        // old Members/Search panel unexpectedly reappear after relaunch.
        sidebarWidth: state.sidebarWidth,
        sidebarCollapsed: state.sidebarCollapsed,
        lowBandwidthMode: state.lowBandwidthMode,
      }),
    }
  )
);
