/**
 * The themes, in one place.
 *
 * `data-theme` on <html> is the whole mechanism (docs/lantern-stage-spec.md
 * §1.7): every surface, ink, shadow, glow and ring for a theme is declared in
 * `src/styles/tokens.css` under `:root[data-theme=…]`, so a colour is written
 * down exactly once. What this module owns is the *list* — which ids exist,
 * which of them are light, which are looks, and how a message row is shaped —
 * because that list used to be a hand-written union repeated in the store, the
 * hook, the settings screen, the picker and the smoke test, and adding a theme
 * meant finding all five.
 *
 * A **look** is a complete palette rather than a theme plus the user's choices:
 * it brings its own accent and its own ground, so the accent presets and the
 * base-colour control do not apply while one is active. `useTheme` removes the
 * inline properties for those two controls instead of writing them, which is
 * what lets the look's own `tokens.css` block win.
 */

/** Every value `data-theme` may take. The order is the order Settings shows. */
export const THEME_IDS = [
  'dark',
  'light',
  'amoled',
  'high-contrast',
  'dusk',
  'paper',
  'voices',
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

/** The theme anything unrecognised collapses to. */
export const DEFAULT_THEME: ThemeId = 'dark';

/**
 * Is this one of ours? The server stores the theme as an opaque string and
 * `localStorage` can hold anything a previous build wrote, so every crossing
 * into typed code goes through here.
 */
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value);
}

/** The same check, as a narrowing: an unknown theme becomes Night. */
export function asThemeId(value: unknown, fallback: ThemeId = DEFAULT_THEME): ThemeId {
  return isThemeId(value) ? value : fallback;
}

/**
 * The themes whose ground is lighter than their ink. They get
 * `color-scheme: light` (so the scrollbars, form controls and native widgets
 * the webview draws follow) and the deepened accent maths in `useTheme`, which
 * a link or an accent label needs to clear 4.5:1 on a pale ground.
 */
export const LIGHT_THEMES: ReadonlySet<ThemeId> = new Set<ThemeId>(['light', 'paper']);

/**
 * The looks. A look is a whole palette: it declares its own accent and its own
 * neutral ramp, so while one is active the accent presets and the base-colour
 * hue/tint are not applied — `useTheme` removes those inline properties rather
 * than writing them, and Settings shows both controls disabled with the reason.
 */
export const LOOK_THEMES: ReadonlySet<ThemeId> = new Set<ThemeId>(['dusk', 'paper', 'voices']);

export type MessageStyle = 'rows' | 'bubbles';

/**
 * How a message is shaped, published as `data-message-style` on <html>.
 *
 * Rows everywhere but Voices, which gives every message its author's colour and
 * needs a bubble to carry it. This is a *shape*, not a density: the compact
 * setting is separate and stays server-synced (`data-density`).
 */
export function messageStyleFor(theme: ThemeId): MessageStyle {
  return theme === 'voices' ? 'bubbles' : 'rows';
}
