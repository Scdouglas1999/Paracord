/**
 * The themes, in one place.
 *
 * Glass (docs/glass-spec.md) is the only look. There is one layout and one
 * palette: what is live in the current server tints every surface, and nothing
 * else is a choice. Two ids remain, and only because one of them is an
 * accessibility setting rather than a taste:
 *
 *   glass           the default
 *   glass-contrast  High contrast: opaque panes, brighter ink, visible edges
 *
 * `data-theme` on <html> is the whole mechanism. Every surface, ink, shadow
 * and ring for each is declared in `src/styles/tokens.css`, so a color is
 * written down exactly once. What this module owns is the *list*, and the one
 * place an id from an older build or from the server is turned into one of
 * ours.
 *
 * Reduced transparency, Reduced motion and Custom CSS are settings, not
 * themes: they sit beside the theme in `uiStore` and do not change which
 * palette is in force.
 */

/** Every value `data-theme` may take. */
export const THEME_IDS = ['glass', 'glass-contrast'] as const;

export type ThemeId = (typeof THEME_IDS)[number];

/**
 * What a fresh install looks like, and what anything unrecognized collapses to.
 * The server's `DEFAULT_THEME` (crates/paracord-api/src/routes/users.rs) must
 * agree: the client adopts the server's value on first sign-in.
 */
export const DEFAULT_THEME: ThemeId = 'glass';

/** The theme High contrast turns on. */
export const HIGH_CONTRAST_THEME: ThemeId = 'glass-contrast';

/**
 * The ids earlier builds wrote, to `localStorage` and to the server. Night,
 * Daylight, AMOLED, Dusk sky, Paper & ink, Slate and Aubergine are retired;
 * they are kept here only so a stored one is recognized rather than treated as
 * garbage. `high-contrast` was a choice about legibility, not taste, so it
 * stays one.
 */
const LEGACY_THEME_IDS = [
  'dark',
  'light',
  'amoled',
  'high-contrast',
  'dusk',
  'paper',
  'slate',
  'voices',
] as const;

/**
 * Is this one of ours? The server stores the theme as an opaque string and
 * `localStorage` can hold anything a previous build wrote, so every crossing
 * into typed code goes through here or `migrateThemeId`.
 */
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value);
}

/**
 * Turn a stored theme into one of ours.
 *
 *   glass, glass-contrast   themselves
 *   high-contrast           glass-contrast
 *   any other retired id    glass
 *   anything else           null (not a theme at all; the caller decides)
 *
 * The retired ids are not errors, so nothing here throws and no request is
 * refused: an account that chose Paper & ink in July simply opens Glass.
 */
export function migrateThemeId(value: unknown): ThemeId | null {
  if (isThemeId(value)) return value;
  if (typeof value !== 'string') return null;
  if (value === 'high-contrast') return HIGH_CONTRAST_THEME;
  return (LEGACY_THEME_IDS as readonly string[]).includes(value) ? DEFAULT_THEME : null;
}

/** The same, as a narrowing: an unrecognized value becomes the fallback. */
export function asThemeId(value: unknown, fallback: ThemeId = DEFAULT_THEME): ThemeId {
  return migrateThemeId(value) ?? fallback;
}

/**
 * How much the panes may be see-through (docs/glass-spec.md §4).
 *
 *   system    follow the device's "reduce transparency" setting
 *   standard  panes are near-solid, as designed
 *   reduced   panes are fully opaque
 *
 * Per device, like Reduced motion. It is published as
 * `data-reduced-transparency` on <html>, which `glass.css` reads.
 */
export type TransparencyPreference = 'system' | 'standard' | 'reduced';

export const TRANSPARENCY_PREFERENCES: readonly TransparencyPreference[] = [
  'system',
  'standard',
  'reduced',
];

/** Narrow whatever was stored to a preference, `system` if it is not one. */
export function asTransparencyPreference(value: unknown): TransparencyPreference {
  return (TRANSPARENCY_PREFERENCES as readonly unknown[]).includes(value)
    ? (value as TransparencyPreference)
    : 'system';
}
