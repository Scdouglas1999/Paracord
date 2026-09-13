import { useEffect, useRef } from 'react';
import { useUIStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';
import { sanitizeCustomCss } from '../lib/security';

type ThemeName = 'dark' | 'light' | 'amoled' | 'high-contrast';

/**
 * Accent presets recolour `--accent-primary` and its derivatives ONLY
 * (docs/lantern-stage-spec.md §1.7). They never touch `--light-white` /
 * `--light-amber`: light is state (a person is there right now), not style, and
 * a user's colour choice must not be able to turn it into decoration.
 *
 * This is the one place in `src/` outside `tokens.css` that may hold a literal
 * colour, and `scripts/literal-colour-audit.mjs` allows it by name: the hover
 * and active steps are COMPUTED from the picked value (`shadeHex`/`scaleHex`),
 * so a CSS custom property cannot be the source — the numbers have to be here.
 */
export const ACCENT_PRESETS = {
  red: '#eb4d4b',
  blue: '#4f7cff',
  emerald: '#2bd39a',
  amber: '#d1972f',
  rose: '#d95d7a',
  violet: '#7a6cff',
  cyan: '#1cc3c0',
  lime: '#7ba72a',
  orange: '#d86d36',
  slate: '#7a879f',
} as const;

/** Lighten toward white by `amount` (0–1) while preserving the hue. */
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

/** Scale RGB channels toward black while preserving the preset's hue. */
function scaleHex(hex: string, factor: number): string {
  const normalized = hex.replace('#', '');
  if (normalized.length !== 6) return hex;
  const num = Number.parseInt(normalized, 16);
  if (Number.isNaN(num)) return hex;
  const channels = [(num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff];
  return `#${channels
    .map((channel) => Math.round(channel * factor).toString(16).padStart(2, '0'))
    .join('')}`;
}

function hexToRgbString(hex: string): string {
  const normalized = hex.replace('#', '');
  if (normalized.length !== 6) return '43, 211, 154';
  const num = Number.parseInt(normalized, 16);
  if (Number.isNaN(num)) return '43, 211, 154';
  return `${(num >> 16) & 0xff}, ${(num >> 8) & 0xff}, ${num & 0xff}`;
}

/**
 * Warm paper needs a much deeper rendering of every accent preset. 0.52 keeps
 * the hue while holding the worst case above 4.5:1 against `--bg-well`, the
 * lightest ground a link or an accent label ever sits on (spec §9).
 */
const LIGHT_ACCENT_SCALE = 0.52;
const LIGHT_ACCENT_HOVER_SCALE = 0.46;
const LIGHT_ACCENT_ACTIVE_SCALE = 0.4;

/**
 * Applies the theme, the accent preset, density, low-bandwidth mode and the
 * user's custom CSS to the document root.
 *
 * The theme itself is one attribute: `data-theme`. Every surface, shadow, glow
 * and ring for that theme is declared in `src/styles/tokens.css` under
 * `:root[data-theme=…]`, so there is exactly one place a colour is written down.
 * The only values this hook writes inline are the ones that cannot be static —
 * the chosen accent preset and its derivatives.
 */
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
    const root = document.documentElement;
    root.setAttribute('data-theme', activeTheme);
    root.style.colorScheme = activeTheme === 'light' ? 'light' : 'dark';

    const presetBase = ACCENT_PRESETS[accentPreset] || ACCENT_PRESETS.emerald;
    const isLight = activeTheme === 'light';
    const accentBase = isLight ? scaleHex(presetBase, LIGHT_ACCENT_SCALE) : presetBase;
    const accentHover = isLight
      ? scaleHex(presetBase, LIGHT_ACCENT_HOVER_SCALE)
      : shadeHex(accentBase, 0.18);
    const accentActive = isLight
      ? scaleHex(presetBase, LIGHT_ACCENT_ACTIVE_SCALE)
      : shadeHex(accentBase, -0.12);

    // Only the plain token names are written: tokens.css maps every
    // `--color-*` (the Tailwind namespace) onto these, so one write reaches
    // both the raw `var(--accent-primary)` consumers and `bg-accent-primary`.
    for (const [name, value] of [
      ['--accent-primary', accentBase],
      ['--accent-primary-hover', accentHover],
      ['--accent-primary-active', accentActive],
      ['--accent', accentBase],
      ['--text-link', accentBase],
      ['--accent-primary-rgb', hexToRgbString(accentBase)],
      ['--sidebar-active-indicator', accentBase],
    ] as const) {
      root.style.setProperty(name, value);
    }
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
