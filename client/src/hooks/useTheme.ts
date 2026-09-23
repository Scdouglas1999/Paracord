import { useEffect, useRef } from 'react';
import { useUIStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';
import { configureMotion } from '../lib/motion/reducedMotion';
import { sanitizeCustomCss } from '../lib/security';
import { clearCustomCss, renderCustomCss } from '../lib/customCss';
import { toast } from '../stores/toastStore';
import { logVoiceDiagnostic } from '../lib/desktopDiagnostics';
import { reportGroundColor } from '../lib/nativeGround';
import {
  LIGHT_THEMES,
  LOOK_THEMES,
  asThemeId,
  isThemeId,
  messageStyleFor,
  type ThemeId,
} from '../lib/themes';

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

/**
 * The base colour of the neutral ramp, named for people rather than by degrees.
 *
 * These are NOT colours — they are an oklch hue and how much of it to take, and
 * `tokens.css` §1.0 spends them on every ground, well, hairline, wash and grey
 * ink while holding each token's lightness and chroma exactly where the ramp
 * put them. That is why this is safe to hand to a user: contrast is preserved
 * by construction at every setting, and `npm run test:contrast` sweeps the
 * whole circle every 30 degrees across all four themes to prove it.
 *
 * Nothing that carries meaning follows them: the two lights, the action green,
 * the semantic accents and the identity palette all stay exactly where they are.
 */
export const BASE_HUE_PRESETS = {
  hearth: { label: 'Hearth', hint: 'Warm brown, the default', hue: 65, tint: 1 },
  ash: { label: 'Ash', hint: 'A true neutral charcoal, no tint at all', hue: 65, tint: 0 },
  harbour: { label: 'Harbour', hint: 'Cool slate, like weather off the water', hue: 245, tint: 1 },
  moss: { label: 'Moss', hint: 'Green-leaning, quiet and outdoors', hue: 150, tint: 1 },
  dusk: { label: 'Dusk', hint: 'Violet-leaning, late in the evening', hue: 305, tint: 1 },
} as const;

export type BaseHuePreset = keyof typeof BASE_HUE_PRESETS;

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
/**
 * Every inline custom property the accent preset writes to <html>.
 *
 * One list, read twice: it is what a preset sets, and it is exactly what a look
 * has to have REMOVED. An inline property beats any stylesheet, so a look whose
 * accent is declared in `tokens.css` only wins once these are gone — and a
 * second hand-written list here is how one of them would get left behind.
 */
const ACCENT_PROPERTIES = [
  '--accent-primary',
  '--accent-primary-hover',
  '--accent-primary-active',
  '--accent',
  '--text-link',
  '--accent-primary-rgb',
  '--sidebar-active-indicator',
] as const;

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
 * the chosen accent preset and its derivatives, and the base colour's two
 * numbers.
 *
 * Except under a **look** (`lib/themes.ts`), which is a complete palette: it
 * declares its own accent and its own neutral ramp, so those inline properties
 * are REMOVED for the duration rather than written. An inline property beats
 * any stylesheet, so removing them is what lets the look's own block win — and
 * writing them again is what gives the person their colours back when they
 * leave it.
 */
export function useTheme() {
  const theme = useUIStore((s) => s.theme);
  const accentPreset = useUIStore((s) => s.accentPreset);
  const baseHue = useUIStore((s) => s.baseHue);
  const baseTint = useUIStore((s) => s.baseTint);
  const setTheme = useUIStore((s) => s.setTheme);
  const lowBandwidthMode = useUIStore((s) => s.lowBandwidthMode);
  const motion = useUIStore((s) => s.motion);
  const customCss = useUIStore((s) => s.customCss);
  const setCustomCss = useUIStore((s) => s.setCustomCss);
  const settings = useAuthStore((s) => s.settings);
  const initializedFromServer = useRef(false);

  // Hydrate local theme once from server settings so user changes apply immediately.
  useEffect(() => {
    if (!settings) {
      initializedFromServer.current = false;
      return;
    }
    if (!initializedFromServer.current) {
      // The server stores the theme as an opaque string; only ids this build
      // knows are taken, and an unknown one leaves the local choice alone.
      if (isThemeId(settings.theme)) {
        setTheme(settings.theme);
      }
      initializedFromServer.current = true;
    }
  }, [settings, setTheme]);

  const requestedTheme = theme;
  // Persisted state can outlive the build that wrote it: anything unrecognised
  // is Night rather than a document with no theme at all.
  const activeTheme: ThemeId = asThemeId(requestedTheme);
  // A look is a whole palette (lib/themes.ts): it declares its own accent and
  // its own neutral ramp, so the two controls that would otherwise write over
  // them are not applied while one is active.
  const isLook = LOOK_THEMES.has(activeTheme);
  // Message density has a single source of truth: the server-synced
  // message_display_compact setting (surfaced in Settings › Appearance › Display).
  const densityMode = settings?.message_display_compact ? 'compact' : 'default';

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', activeTheme);
    root.style.colorScheme = LIGHT_THEMES.has(activeTheme) ? 'light' : 'dark';
    // The shape of a message, for `tokens.css` to follow. Always written, so
    // nothing has to treat "no attribute" as a third case.
    root.setAttribute('data-message-style', messageStyleFor(activeTheme));

    // A look brings its own accent. Writing the preset's here would beat the
    // look's own block (an inline property beats any stylesheet), so the
    // properties are REMOVED instead — that is what hands the cascade back to
    // `tokens.css`. They are written again the moment a non-look theme is
    // chosen, because this effect also depends on the theme.
    if (isLook) {
      for (const name of ACCENT_PROPERTIES) {
        root.style.removeProperty(name);
      }
      return;
    }

    const presetBase = ACCENT_PRESETS[accentPreset] || ACCENT_PRESETS.emerald;
    const isLight = LIGHT_THEMES.has(activeTheme);
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
    // Keyed by the list above, so a name added there must be given a value.
    const accentValues: Record<(typeof ACCENT_PROPERTIES)[number], string> = {
      '--accent-primary': accentBase,
      '--accent-primary-hover': accentHover,
      '--accent-primary-active': accentActive,
      '--accent': accentBase,
      '--text-link': accentBase,
      '--accent-primary-rgb': hexToRgbString(accentBase),
      '--sidebar-active-indicator': accentBase,
    };
    for (const name of ACCENT_PROPERTIES) {
      root.style.setProperty(name, accentValues[name]);
    }
  }, [activeTheme, accentPreset, isLook]);

  // The base colour. Two numbers on <html>, and every neutral in `tokens.css`
  // re-resolves against them — no relaunch, no reload, and no second place
  // where a colour is written down.
  //
  // A look declares its own pair in its own block, so for a look these are
  // removed rather than written — and written again when a non-look theme comes
  // back, which is why the theme is a dependency of a base-colour effect.
  useEffect(() => {
    const root = document.documentElement;
    if (isLook) {
      root.style.removeProperty('--ui-hue');
      root.style.removeProperty('--ui-chroma');
      return;
    }
    root.style.setProperty('--ui-hue', String(baseHue));
    root.style.setProperty('--ui-chroma', String(baseTint));
  }, [baseHue, baseTint, activeTheme, isLook]);


  // §5.3's one switch. The stored preference is the only thing that reaches it;
  // the OS media query is read inside `configureMotion`, never here, and the
  // answer is published as `data-motion` on <html> for CSS to follow.
  useEffect(() => {
    configureMotion(motion);
  }, [motion]);

  useEffect(() => {
    document.documentElement.setAttribute('data-density', densityMode);
  }, [densityMode]);

  useEffect(() => {
    document.documentElement.setAttribute(
      'data-low-bandwidth',
      lowBandwidthMode ? 'true' : 'false'
    );
  }, [lowBandwidthMode]);

  // The committed custom CSS, rendered through the same single stylesheet the
  // Settings preview drives. A refusal (the document's CSP declining an
  // injected stylesheet) is reported rather than left as a silent no-op —
  // Settings shows it to the user, this records it for a bug report.
  useEffect(() => {
    const css = sanitizeCustomCss(settings?.custom_css || customCss || '');
    if (!renderCustomCss(css)) {
      logVoiceDiagnostic('[theme] custom css refused by the document', { length: css.length });
    }
  }, [customCss, settings?.custom_css]);

  // The way back. Custom CSS runs against the whole interface, and while the
  // sanitizer allows no layout or visibility properties, a transparent colour
  // or a zeroed font size is enough that somebody cannot find Settings again to
  // undo it. Ctrl+Alt+Shift+C removes it without needing to read the screen.
  // (Instance-wide CSS is an administrator's, not something a person pasted
  // here, and is left alone.)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.altKey || !event.shiftKey) return;
      if (event.code !== 'KeyC') return;
      event.preventDefault();
      setCustomCss('');
      clearCustomCss();
      toast.success('Custom CSS removed.');
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [setCustomCss]);

  // …and the desktop shell is told what all of that came out as. The GTK
  // toplevel is what shows through wherever the DOM is transparent over a
  // native video underlay, so it has to be painted the ground the person
  // actually chose rather than a colour compiled into the shell. LAST of the
  // appearance effects on purpose: by the time it runs, <html> carries the new
  // theme, the new hue and tint, and the committed custom CSS — which can
  // redefine `--bg-base` itself — so what it reads is the ground as it will be
  // drawn. See `lib/nativeGround.ts`.
  useEffect(() => {
    void reportGroundColor();
  }, [activeTheme, accentPreset, baseHue, baseTint, customCss, settings?.custom_css]);

  return { theme: activeTheme };
}
