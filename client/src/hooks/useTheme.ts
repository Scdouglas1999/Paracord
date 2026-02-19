import { useEffect, useRef } from 'react';
import { useUIStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';
import { sanitizeCustomCss } from '../lib/security';

type ThemeName = 'dark' | 'light' | 'amoled';

const ACCENT_PRESETS = {
  red: '#eb4d4b',
  blue: '#4f7cff',
  emerald: '#22b07d',
  amber: '#d1972f',
  rose: '#d95d7a',
  violet: '#7a6cff',
  cyan: '#21a9b7',
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

const THEME_VARIABLES: Record<ThemeName, Record<string, string>> = {
  dark: {
    'color-bg-primary': '#121212',
    'color-bg-secondary': '#1e1e1e',
    'color-bg-tertiary': '#141414',
    'color-bg-accent': '#27272a',
    'color-bg-floating': 'rgba(30, 30, 30, 0.92)',
    'color-bg-mod-subtle': 'rgba(255, 255, 255, 0.06)',
    'color-bg-mod-strong': 'rgba(255, 255, 255, 0.12)',
    'color-text-primary': '#f2f2f2',
    'color-text-secondary': '#a0a0a0',
    'color-text-muted': '#71717a',
    'color-text-link': '#eb4d4b',
    'color-accent-primary': '#eb4d4b',
    'color-accent-primary-hover': '#f06462',
    'color-accent-success': '#35c18f',
    'color-accent-danger': '#ff5d72',
    'color-accent-warning': '#ffce62',
    'color-border-subtle': 'rgba(255, 255, 255, 0.1)',
    'color-border-strong': 'rgba(255, 255, 255, 0.2)',
    'color-scrollbar-track': 'rgba(255, 255, 255, 0.04)',
    'color-scrollbar-thumb': 'rgba(255, 255, 255, 0.2)',
    'color-channel-icon': '#9ca3af',
    'color-interactive-normal': '#a3a3a3',
    'color-interactive-hover': '#f2f2f2',
    'color-interactive-active': '#ffffff',
    'color-interactive-muted': '#52525b',
    'color-status-online': '#35c18f',
    'color-status-idle': '#ffce62',
    'color-status-dnd': '#ff5d72',
    'color-status-offline': '#6b7280',
    'color-status-streaming': '#8b6fff',
    'app-bg-layer-one': 'none',
    'app-bg-layer-two': 'none',
    'app-bg-base': '#121212',
    'overlay-backdrop': 'rgba(0, 0, 0, 0.72)',
    'glass-rail-fill-top': 'rgba(255, 255, 255, 0.03)',
    'glass-rail-fill-bottom': 'rgba(255, 255, 255, 0.01)',
    'glass-panel-fill-top': 'rgba(255, 255, 255, 0.03)',
    'glass-panel-fill-bottom': 'rgba(255, 255, 255, 0.01)',
    'glass-modal-fill-top': 'rgba(34, 34, 34, 0.95)',
    'glass-modal-fill-bottom': 'rgba(26, 26, 26, 0.94)',
    'panel-divider-glint': 'rgba(255, 255, 255, 0.02)',
    'scrollbar-auto-thumb-hover': 'rgba(255, 255, 255, 0.36)',
    'sidebar-bg': 'rgba(0, 0, 0, 0.9)',
    'sidebar-border': 'rgba(255, 255, 255, 0.07)',
    'sidebar-active-indicator': 'var(--color-accent-primary)',
    'ambient-glow-primary': 'rgba(235, 77, 75, 0.12)',
    'ambient-glow-success': 'rgba(53, 193, 143, 0.09)',
    'ambient-glow-danger': 'rgba(255, 93, 114, 0.06)',
    'accent-primary-rgb': '235, 77, 75',
  },
  light: {
    'color-bg-primary': '#e8e8e6',
    'color-bg-secondary': '#fdfdfd',
    'color-bg-tertiary': '#f4f4f2',
    'color-bg-accent': '#ececeb',
    'color-bg-floating': 'rgba(253, 253, 253, 0.9)',
    'color-bg-mod-subtle': 'rgba(0, 0, 0, 0.04)',
    'color-bg-mod-strong': 'rgba(0, 0, 0, 0.08)',
    'color-text-primary': '#1c1c1e',
    'color-text-secondary': '#636366',
    'color-text-muted': '#a1a1aa',
    'color-text-link': '#eb4d4b',
    'color-accent-primary': '#eb4d4b',
    'color-accent-primary-hover': '#f06462',
    'color-accent-success': '#1c9d71',
    'color-accent-danger': '#d64560',
    'color-accent-warning': '#cc8b1f',
    'color-border-subtle': 'rgba(0, 0, 0, 0.08)',
    'color-border-strong': 'rgba(0, 0, 0, 0.16)',
    'color-scrollbar-track': 'rgba(0, 0, 0, 0.06)',
    'color-scrollbar-thumb': 'rgba(0, 0, 0, 0.2)',
    'color-channel-icon': '#737373',
    'color-interactive-normal': '#525252',
    'color-interactive-hover': '#1f2937',
    'color-interactive-active': '#111827',
    'color-interactive-muted': '#a1a1aa',
    'color-status-online': '#1c9d71',
    'color-status-idle': '#cc8b1f',
    'color-status-dnd': '#d73b61',
    'color-status-offline': '#9ca3af',
    'color-status-streaming': '#6a4dce',
    'app-bg-layer-one': 'none',
    'app-bg-layer-two': 'none',
    'app-bg-base': '#e8e8e6',
    'overlay-backdrop': 'rgba(17, 24, 39, 0.35)',
    'glass-rail-fill-top': 'rgba(255, 255, 255, 0.85)',
    'glass-rail-fill-bottom': 'rgba(245, 245, 244, 0.8)',
    'glass-panel-fill-top': 'rgba(255, 255, 255, 0.86)',
    'glass-panel-fill-bottom': 'rgba(245, 245, 244, 0.8)',
    'glass-modal-fill-top': 'rgba(255, 255, 255, 0.95)',
    'glass-modal-fill-bottom': 'rgba(245, 245, 244, 0.94)',
    'panel-divider-glint': 'rgba(0, 0, 0, 0.04)',
    'scrollbar-auto-thumb-hover': 'rgba(0, 0, 0, 0.3)',
    'sidebar-bg': 'rgba(28, 28, 30, 0.92)',
    'sidebar-border': 'rgba(255, 255, 255, 0.06)',
    'sidebar-active-indicator': 'var(--color-accent-primary)',
    'ambient-glow-primary': 'rgba(235, 77, 75, 0.14)',
    'ambient-glow-success': 'rgba(31, 159, 114, 0.14)',
    'ambient-glow-danger': 'rgba(215, 59, 97, 0.08)',
    'accent-primary-rgb': '235, 77, 75',
  },
  amoled: {
    'color-bg-primary': '#000000',
    'color-bg-secondary': '#000000',
    'color-bg-tertiary': '#000000',
    'color-bg-accent': '#080a0f',
    'color-bg-floating': 'rgba(0, 0, 0, 0.98)',
    'color-bg-mod-subtle': 'rgba(255, 255, 255, 0.055)',
    'color-bg-mod-strong': 'rgba(255, 255, 255, 0.12)',
    'color-text-primary': '#f5f8ff',
    'color-text-secondary': '#aebad2',
    'color-text-muted': '#6f7d96',
    'color-text-link': '#8dc2ff',
    'color-accent-primary': '#eb4d4b',
    'color-accent-primary-hover': '#f06462',
    'color-accent-success': '#3bcf98',
    'color-accent-danger': '#ff5f7f',
    'color-accent-warning': '#ffd271',
    'color-border-subtle': 'rgba(255, 255, 255, 0.12)',
    'color-border-strong': 'rgba(255, 255, 255, 0.22)',
    'color-scrollbar-track': 'rgba(255, 255, 255, 0.06)',
    'color-scrollbar-thumb': 'rgba(255, 255, 255, 0.26)',
    'color-channel-icon': '#8d9ab6',
    'color-interactive-normal': '#a9b5cd',
    'color-interactive-hover': '#edf2ff',
    'color-interactive-active': '#ffffff',
    'color-interactive-muted': '#4d5871',
    'color-status-online': '#3bcf98',
    'color-status-idle': '#ffd271',
    'color-status-dnd': '#ff5f7f',
    'color-status-offline': '#72819d',
    'color-status-streaming': '#8f70ff',
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
    'sidebar-active-indicator': 'var(--color-accent-primary)',
    'ambient-glow-primary': 'transparent',
    'ambient-glow-success': 'transparent',
    'ambient-glow-danger': 'transparent',
    'accent-primary-rgb': '235, 77, 75',
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
  const compactMode = useUIStore((s) => s.compactMode);
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
      if (settings.theme === 'dark' || settings.theme === 'light' || settings.theme === 'amoled') {
        setTheme(settings.theme);
      }
      initializedFromServer.current = true;
    }
  }, [settings, setTheme]);

  const requestedTheme = theme;
  const activeTheme: ThemeName =
    requestedTheme === 'light' || requestedTheme === 'amoled' || requestedTheme === 'dark'
      ? requestedTheme
      : 'dark';
  const compactFromSettings = Boolean(settings?.message_display_compact);
  const densityMode = compactMode || compactFromSettings ? 'compact' : 'default';

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
    const accentBase = ACCENT_PRESETS[accentPreset] || ACCENT_PRESETS.red;
    const accentHover = shadeHex(accentBase, 0.18);
    root.style.setProperty('--color-accent-primary', accentBase);
    root.style.setProperty('--color-accent-primary-hover', accentHover);
    root.style.setProperty('--accent-primary', accentBase);
    root.style.setProperty('--accent-primary-hover', accentHover);
    root.style.setProperty('--accent', accentBase);
    root.style.setProperty('--text-link', accentBase);
    root.style.setProperty('--accent-primary-rgb', hexToRgbString(accentBase));
    root.style.setProperty('--sidebar-active-indicator', accentBase);
    root.setAttribute('data-theme', activeTheme);
    root.style.colorScheme = activeTheme === 'light' ? 'light' : 'dark';
  }, [activeTheme, accentPreset]);

  useEffect(() => {
    document.documentElement.setAttribute('data-density', densityMode);
  }, [densityMode]);

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
