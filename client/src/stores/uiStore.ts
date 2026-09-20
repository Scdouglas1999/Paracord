import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { MotionPreference } from '../lib/motion/reducedMotion';
import type { ThemeId } from '../lib/themes';

/**
 * The theme, per device. The list of ids is `lib/themes.ts` — including the
 * looks, which are themes as far as this store is concerned: one string, stored
 * and synced exactly like the other four. Nothing is validated on the way in or
 * out; `useTheme` is the one narrowing point, so a value an older or newer
 * build wrote survives a round trip instead of being quietly rewritten here.
 */
type Theme = ThemeId;
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
 * The base colour of the whole neutral ramp, as an oklch hue in degrees plus
 * how much of it to take (tokens.css §1.0). Every ground, well, hairline, wash
 * and grey ink is written `oklch(L C var(--ui-hue))`, so this one number turns
 * the interface from warm brown to slate to green without moving a single
 * lightness — which is why `npm run test:contrast` can prove it safe at every
 * setting rather than at the five we happened to name.
 *
 * Per device, like the theme: it is about the screen you are looking at.
 */
export const BASE_HUE_DEFAULT = 65;
export const BASE_TINT_DEFAULT = 1;

const clampHue = (deg: number): number => {
  if (!Number.isFinite(deg)) return BASE_HUE_DEFAULT;
  return ((Math.round(deg) % 360) + 360) % 360;
};

const clampTint = (tint: number): number => {
  if (!Number.isFinite(tint)) return BASE_TINT_DEFAULT;
  return Math.min(1, Math.max(0, tint));
};

/**
 * The single source of truth for the toggleable right-hand context panel
 * (layout-spec §1). Exactly one mode is active at a time; `null` = closed.
 * All readers select `contextPanelMode` directly — the wave-2 mirrored
 * per-panel booleans were retired in the cleanup wave (layout-spec §8 step 15).
 */
export type ContextPanelMode = 'recipients' | 'threads' | 'pins' | 'search' | 'economy' | null;

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
  /** The base hue, 0–359 degrees (oklch). */
  baseHue: number;
  /** How much of it: 1 is the full tint, 0 is a true neutral charcoal. */
  baseTint: number;
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
  setAccentPreset: (accentPreset: AccentPreset) => void;
  setBaseHue: (deg: number) => void;
  setBaseTint: (tint: number) => void;
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

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      theme: 'dark',
      accentPreset: 'emerald',
      baseHue: BASE_HUE_DEFAULT,
      baseTint: BASE_TINT_DEFAULT,
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
      setAccentPreset: (accentPreset) => set({ accentPreset }),
      setBaseHue: (deg) => set({ baseHue: clampHue(deg) }),
      setBaseTint: (tint) => set({ baseTint: clampTint(tint) }),
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
      partialize: (state) => ({
        theme: state.theme,
        accentPreset: state.accentPreset,
        baseHue: state.baseHue,
        baseTint: state.baseTint,
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
