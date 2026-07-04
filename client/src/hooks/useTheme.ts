import { useEffect, useRef } from 'react';
import { useUIStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';
import { sanitizeCustomCss } from '../lib/security';

type ThemeName = 'dark' | 'light' | 'amoled' | 'high-contrast';

export const ACCENT_PRESETS = {
  red: '#eb4d4b',
  blue: '#4f7cff',
  emerald: '#24d196',
  amber: '#d1972f',
  rose: '#d95d7a',
  violet: '#7a6cff',
  cyan: '#1cc3c0',
  lime: '#7ba72a',
  orange: '#d86d36',
  slate: '#7a879f',
} as const;

function shadeHex(hex: string, amount: number): string {
  const normalized = hex.replace('#', '');
  if (normalized.length !== 6) return hex;
  const num = Number.parseInt(normalized, 16);
  if (Number.isNaN(num)) return hex;
  const clamp = (value: number) => Math.max(0, Math.min(255, value));
  const adjust = (channel: number) => clamp(channel + Math.round((255 - channel) * amount));
  const r = adjust((num >> 16) & 0xff);
  const g = adjust((num >> 8) & 0xff);
  const b = adjust(num & 0xff);
  return `#${[r, g, b].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
}

function hexToRgbString(hex: string): string {
  const normalized = hex.replace('#', '');
  if (normalized.length !== 6) return '235, 77, 75';
  const num = Number.parseInt(normalized, 16);
  if (Number.isNaN(num)) return '235, 77, 75';
  return `${(num >> 16) & 0xff}, ${(num >> 8) & 0xff}, ${num & 0xff}`;
}

/* Emerald Commons — warm-neutral dark. Kept in lockstep with
   src/styles/tokens.css (the design default + pre-hydration fallback). Static
   design tokens (radii, shadows, type, motion, tints, teal secondary) live only
   in tokens.css; this map carries the per-theme color surfaces re-applied at
   runtime. Accent-primary here is only a fallback — the chosen accent preset
   overrides it below. */
const THEME_VARIABLES: Record<ThemeName, Record<string, string>> = {
  dark: {
    'color-bg-primary': '#141b17',
    'color-bg-secondary': '#1b241f',
    'color-bg-tertiary': '#0d1211',
    'color-bg-accent': '#222d27',
    'color-bg-floating': 'rgba(27, 36, 31, 0.97)',
    'color-bg-mod-subtle': 'rgba(255, 255, 255, 0.04)',
    'color-bg-mod-strong': 'rgba(255, 255, 255, 0.1)',
    'color-text-primary': '#eaf2ed',
    'color-text-secondary': '#a7b8af',
    'color-text-muted': '#7a8b82',
    'color-text-link': '#24d196',
    'color-accent-primary': '#24d196',
    'color-accent-primary-hover': '#33dba2',
    'color-accent-success': '#4bc46b',
    'color-accent-danger': '#e5484d',
    'color-accent-warning': '#e8b23a',
    'color-border-subtle': 'rgba(160, 185, 170, 0.12)',
    'color-border-strong': 'rgba(160, 185, 170, 0.22)',
    'color-scrollbar-track': 'rgba(0, 0, 0, 0.2)',
    'color-scrollbar-thumb': 'rgba(160, 185, 170, 0.22)',
    'color-channel-icon': '#7a8b82',
    'color-interactive-normal': '#a7b8af',
    'color-interactive-hover': '#eaf2ed',
    'color-interactive-active': '#ffffff',
    'color-interactive-muted': '#55645c',
    'color-status-online': '#24d196',
    'color-status-idle': '#e8b23a',
    'color-status-dnd': '#e5484d',
    'color-status-offline': '#5c6b63',
    'color-status-streaming': '#9b7bff',
    'app-bg-layer-one': 'none',
    'app-bg-layer-two': 'none',
    'app-bg-base': '#0d1211',
    'overlay-backdrop': 'rgba(6, 10, 8, 0.62)',
    'glass-rail-fill-top': 'rgba(255, 255, 255, 0.05)',
    'glass-rail-fill-bottom': 'rgba(255, 255, 255, 0.01)',
    'glass-panel-fill-top': 'rgba(255, 255, 255, 0.04)',
    'glass-panel-fill-bottom': 'rgba(255, 255, 255, 0.012)',
    'glass-modal-fill-top': 'rgba(34, 45, 39, 0.96)',
    'glass-modal-fill-bottom': 'rgba(27, 36, 31, 0.94)',
    'panel-divider-glint': 'rgba(255, 255, 255, 0.03)',
    'scrollbar-auto-thumb-hover': 'rgba(160, 185, 170, 0.4)',
    'sidebar-bg': 'rgba(13, 18, 17, 0.72)',
    'sidebar-border': 'rgba(255, 255, 255, 0.06)',
    'sidebar-active-indicator': 'var(--color-accent-secondary)',
    'ambient-glow-primary': 'transparent',
    'ambient-glow-success': 'transparent',
    'ambient-glow-danger': 'transparent',
    'accent-primary-rgb': '36, 209, 150',
  },
  light: {
    'color-bg-primary': '#e7ece7',
    'color-bg-secondary': '#f4f7f3',
    'color-bg-tertiary': '#dce3dc',
    'color-bg-accent': '#eaefea',
    'color-bg-floating': 'rgba(244, 247, 243, 0.94)',
    'color-bg-mod-subtle': 'rgba(22, 45, 33, 0.06)',
    'color-bg-mod-strong': 'rgba(22, 45, 33, 0.12)',
    'color-text-primary': '#16211b',
    'color-text-secondary': '#4a5a50',
    'color-text-muted': '#6c7c72',
    'color-text-link': '#0c8f63',
    'color-accent-primary': '#0e9e6e',
    'color-accent-primary-hover': '#12b47e',
    'color-accent-success': '#128a54',
    'color-accent-danger': '#c93a44',
    'color-accent-warning': '#b5841e',
    'color-border-subtle': 'rgba(30, 50, 40, 0.14)',
    'color-border-strong': 'rgba(30, 50, 40, 0.24)',
    'color-scrollbar-track': 'rgba(22, 45, 33, 0.06)',
    'color-scrollbar-thumb': 'rgba(60, 88, 74, 0.24)',
    'color-channel-icon': '#5a6c62',
    'color-interactive-normal': '#47564d',
    'color-interactive-hover': '#1b2620',
    'color-interactive-active': '#0e140f',
    'color-interactive-muted': '#8a978e',
    'color-status-online': '#0fa968',
    'color-status-idle': '#b5841e',
    'color-status-dnd': '#c93a44',
    'color-status-offline': '#8a978e',
    'color-status-streaming': '#6d4fcb',
    'app-bg-layer-one': 'none',
    'app-bg-layer-two': 'none',
    'app-bg-base': '#dce3dc',
    'overlay-backdrop': 'rgba(20, 34, 27, 0.38)',
    'glass-rail-fill-top': 'rgba(255, 255, 255, 0.78)',
    'glass-rail-fill-bottom': 'rgba(233, 240, 233, 0.64)',
    'glass-panel-fill-top': 'rgba(255, 255, 255, 0.72)',
    'glass-panel-fill-bottom': 'rgba(233, 240, 233, 0.58)',
    'glass-modal-fill-top': 'rgba(252, 254, 251, 0.95)',
    'glass-modal-fill-bottom': 'rgba(240, 245, 239, 0.94)',
    'panel-divider-glint': 'rgba(20, 44, 30, 0.08)',
    'scrollbar-auto-thumb-hover': 'rgba(60, 88, 74, 0.42)',
    'sidebar-bg': 'rgba(244, 247, 243, 0.76)',
    'sidebar-border': 'rgba(24, 44, 32, 0.14)',
    'sidebar-active-indicator': 'var(--color-accent-secondary)',
    'ambient-glow-primary': 'transparent',
    'ambient-glow-success': 'transparent',
    'ambient-glow-danger': 'transparent',
    'accent-primary-rgb': '14, 158, 110',
  },
  amoled: {
    'color-bg-primary': '#000000',
    'color-bg-secondary': '#000000',
    'color-bg-tertiary': '#000000',
    'color-bg-accent': '#0a0f0c',
    'color-bg-floating': 'rgba(0, 0, 0, 0.98)',
    'color-bg-mod-subtle': 'rgba(255, 255, 255, 0.055)',
    'color-bg-mod-strong': 'rgba(255, 255, 255, 0.12)',
    'color-text-primary': '#eaf2ed',
    'color-text-secondary': '#a7b8af',
    'color-text-muted': '#6e7d74',
    'color-text-link': '#33dba2',
    'color-accent-primary': '#24d196',
    'color-accent-primary-hover': '#33dba2',
    'color-accent-success': '#4bc46b',
    'color-accent-danger': '#e5484d',
    'color-accent-warning': '#e8b23a',
    'color-border-subtle': 'rgba(255, 255, 255, 0.12)',
    'color-border-strong': 'rgba(255, 255, 255, 0.22)',
    'color-scrollbar-track': 'rgba(255, 255, 255, 0.06)',
    'color-scrollbar-thumb': 'rgba(255, 255, 255, 0.26)',
    'color-channel-icon': '#7f8f86',
    'color-interactive-normal': '#a7b8af',
    'color-interactive-hover': '#eaf2ed',
    'color-interactive-active': '#ffffff',
    'color-interactive-muted': '#4d5b53',
    'color-status-online': '#24d196',
    'color-status-idle': '#e8b23a',
    'color-status-dnd': '#e5484d',
    'color-status-offline': '#5c6b63',
    'color-status-streaming': '#9b7bff',
    'app-bg-layer-one': 'none',
    'app-bg-layer-two': 'none',
    'app-bg-base': '#000000',
    'overlay-backdrop': 'rgba(0, 0, 0, 0.86)',
    'glass-rail-fill-top': 'rgba(0, 0, 0, 0.9)',
    'glass-rail-fill-bottom': 'rgba(0, 0, 0, 0.9)',
    'glass-panel-fill-top': 'rgba(0, 0, 0, 0.86)',
    'glass-panel-fill-bottom': 'rgba(0, 0, 0, 0.86)',
    'glass-modal-fill-top': 'rgba(0, 0, 0, 0.94)',
    'glass-modal-fill-bottom': 'rgba(0, 0, 0, 0.94)',
    'panel-divider-glint': 'rgba(255, 255, 255, 0.02)',
    'scrollbar-auto-thumb-hover': 'rgba(255, 255, 255, 0.36)',
    'sidebar-bg': 'rgba(0, 0, 0, 0.94)',
    'sidebar-border': 'rgba(255, 255, 255, 0.12)',
    'sidebar-active-indicator': 'var(--color-accent-secondary)',
    'ambient-glow-primary': 'transparent',
    'ambient-glow-success': 'transparent',
    'ambient-glow-danger': 'transparent',
    'accent-primary-rgb': '36, 209, 150',
  },
  'high-contrast': {
    'color-bg-primary': '#000000',
    'color-bg-secondary': '#0a0a0a',
    'color-bg-tertiary': '#000000',
    'color-bg-accent': '#1a1a1a',
    'color-bg-floating': 'rgba(0, 0, 0, 0.98)',
    'color-bg-mod-subtle': 'rgba(255, 255, 255, 0.1)',
    'color-bg-mod-strong': 'rgba(255, 255, 255, 0.2)',
    'color-text-primary': '#ffffff',
    'color-text-secondary': '#e0e0e0',
    'color-text-muted': '#b0b0b0',
    'color-text-link': '#3af0b0',
    'color-accent-primary': '#3af0b0',
    'color-accent-primary-hover': '#66f5c6',
    'color-accent-success': '#33ff99',
    'color-accent-danger': '#ff4d4d',
    'color-accent-warning': '#ffdd00',
    'color-border-subtle': 'rgba(255, 255, 255, 0.4)',
    'color-border-strong': 'rgba(255, 255, 255, 0.6)',
    'color-scrollbar-track': 'rgba(255, 255, 255, 0.08)',
    'color-scrollbar-thumb': 'rgba(255, 255, 255, 0.35)',
    'color-channel-icon': '#cccccc',
    'color-interactive-normal': '#cccccc',
    'color-interactive-hover': '#ffffff',
    'color-interactive-active': '#ffffff',
    'color-interactive-muted': '#808080',
    'color-status-online': '#33ff99',
    'color-status-idle': '#ffdd00',
    'color-status-dnd': '#ff4d4d',
    'color-status-offline': '#808080',
    'color-status-streaming': '#cc66ff',
    'app-bg-layer-one': 'none',
    'app-bg-layer-two': 'none',
    'app-bg-base': '#000000',
    'overlay-backdrop': 'rgba(0, 0, 0, 0.92)',
    'glass-rail-fill-top': 'rgba(0, 0, 0, 0.95)',
    'glass-rail-fill-bottom': 'rgba(0, 0, 0, 0.95)',
    'glass-panel-fill-top': 'rgba(0, 0, 0, 0.92)',
    'glass-panel-fill-bottom': 'rgba(0, 0, 0, 0.92)',
    'glass-modal-fill-top': 'rgba(10, 10, 10, 0.98)',
    'glass-modal-fill-bottom': 'rgba(5, 5, 5, 0.98)',
    'panel-divider-glint': 'rgba(255, 255, 255, 0.08)',
    'scrollbar-auto-thumb-hover': 'rgba(255, 255, 255, 0.5)',
    'sidebar-bg': 'rgba(0, 0, 0, 0.95)',
    'sidebar-border': 'rgba(255, 255, 255, 0.4)',
    'sidebar-active-indicator': 'var(--color-accent-secondary)',
    'ambient-glow-primary': 'transparent',
    'ambient-glow-success': 'transparent',
    'ambient-glow-danger': 'transparent',
    'accent-primary-rgb': '58, 240, 176',
  },
};

const LEGACY_ALIASES: Record<string, string> = {
  'bg-primary': 'color-bg-primary',
  'bg-secondary': 'color-bg-secondary',
  'bg-tertiary': 'color-bg-tertiary',
  'bg-accent': 'color-bg-accent',
  'bg-floating': 'color-bg-floating',
  'bg-chat': 'color-bg-primary',
  'bg-mod-subtle': 'color-bg-mod-subtle',
  'bg-mod-strong': 'color-bg-mod-strong',
  'text-primary': 'color-text-primary',
  'text-secondary': 'color-text-secondary',
  'text-muted': 'color-text-muted',
  'text-link': 'color-text-link',
  'accent': 'color-accent-primary',
  'accent-primary': 'color-accent-primary',
  'accent-primary-hover': 'color-accent-primary-hover',
  'accent-success': 'color-accent-success',
  'accent-danger': 'color-accent-danger',
  'accent-warning': 'color-accent-warning',
  'border-subtle': 'color-border-subtle',
  'border-strong': 'color-border-strong',
  'channel-icon': 'color-channel-icon',
  'interactive-normal': 'color-interactive-normal',
  'interactive-hover': 'color-interactive-hover',
  'interactive-active': 'color-interactive-active',
  'interactive-muted': 'color-interactive-muted',
  'status-online': 'color-status-online',
  'status-idle': 'color-status-idle',
  'status-dnd': 'color-status-dnd',
  'status-offline': 'color-status-offline',
  'status-streaming': 'color-status-streaming',
  'scrollbar-auto-track': 'color-scrollbar-track',
  'scrollbar-auto-thumb': 'color-scrollbar-thumb',
};

export function useTheme() {
  const theme = useUIStore((s) => s.theme);
  const accentPreset = useUIStore((s) => s.accentPreset);
  const setTheme = useUIStore((s) => s.setTheme);
  const lowBandwidthMode = useUIStore((s) => s.lowBandwidthMode);
  const customCss = useUIStore((s) => s.customCss);
  const settings = useAuthStore((s) => s.settings);
  const initializedFromServer = useRef(false);

  // Hydrate local theme once from server settings so user changes apply immediately.
  useEffect(() => {
    if (!settings) {
      initializedFromServer.current = false;
      return;
    }
    if (!initializedFromServer.current) {
      if (settings.theme === 'dark' || settings.theme === 'light' || settings.theme === 'amoled' || settings.theme === 'high-contrast') {
        setTheme(settings.theme);
      }
      initializedFromServer.current = true;
    }
  }, [settings, setTheme]);

  const requestedTheme = theme;
  const activeTheme: ThemeName =
    requestedTheme === 'light' || requestedTheme === 'amoled' || requestedTheme === 'dark' || requestedTheme === 'high-contrast'
      ? requestedTheme
      : 'dark';
  // Message density has a single source of truth: the server-synced
  // message_display_compact setting (surfaced in Settings › Appearance › Display).
  const densityMode = settings?.message_display_compact ? 'compact' : 'default';

  useEffect(() => {
    const vars = THEME_VARIABLES[activeTheme] || THEME_VARIABLES.dark;
    const root = document.documentElement;
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(`--${key}`, value);
    }
    for (const [legacyName, canonicalName] of Object.entries(LEGACY_ALIASES)) {
      const value = vars[canonicalName];
      if (value) {
        root.style.setProperty(`--${legacyName}`, value);
      }
    }
    const accentBase = ACCENT_PRESETS[accentPreset] || ACCENT_PRESETS.emerald;
    const accentHover = shadeHex(accentBase, 0.18);
    const accentActive = shadeHex(accentBase, -0.12);
    // Bright accents (emerald included) fail AA as link text on the light theme's
    // near-white surfaces, so deepen the link color there while keeping the fill
    // bright. Dark themes use the accent as-is (reads at AA on dark surfaces).
    const linkColor = activeTheme === 'light' ? shadeHex(accentBase, -0.42) : accentBase;
    root.style.setProperty('--color-accent-primary', accentBase);
    root.style.setProperty('--color-accent-primary-hover', accentHover);
    root.style.setProperty('--color-accent-primary-active', accentActive);
    root.style.setProperty('--accent-primary', accentBase);
    root.style.setProperty('--accent-primary-hover', accentHover);
    root.style.setProperty('--accent-primary-active', accentActive);
    root.style.setProperty('--accent', accentBase);
    root.style.setProperty('--text-link', linkColor);
    root.style.setProperty('--accent-primary-rgb', hexToRgbString(accentBase));
    root.style.setProperty('--sidebar-active-indicator', accentBase);
    root.setAttribute('data-theme', activeTheme);
    root.style.colorScheme = activeTheme === 'light' ? 'light' : 'dark';
  }, [activeTheme, accentPreset]);

  useEffect(() => {
    document.documentElement.setAttribute('data-density', densityMode);
  }, [densityMode]);

  useEffect(() => {
    document.documentElement.setAttribute(
      'data-low-bandwidth',
      lowBandwidthMode ? 'true' : 'false'
    );
  }, [lowBandwidthMode]);

  useEffect(() => {
    const id = 'paracord-custom-css';
    let styleEl = document.getElementById(id) as HTMLStyleElement | null;
    const css = sanitizeCustomCss(settings?.custom_css || customCss || '');
    if (css) {
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = id;
        document.head.appendChild(styleEl);
      }
      styleEl.textContent = css;
    } else if (styleEl) {
      styleEl.remove();
    }
  }, [customCss, settings?.custom_css]);

  return { theme: activeTheme };
}
