// ============ Guild Icon Colors ============

/** Shared guild icon color palette. Used in Sidebar and HomePage. */
export const GUILD_COLORS = [
  '#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245',
  '#3ba55c', '#faa61a', '#e67e22', '#e91e63', '#1abc9c',
];

/** Deterministic color for a guild icon based on its ID. */
export function getGuildColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash |= 0;
  }
  return GUILD_COLORS[Math.abs(hash) % GUILD_COLORS.length];
}

// ============ Role Color Utilities ============

/**
 * Converts a role color integer to a hex color string.
 * Returns a CSS variable fallback for color 0 (default/no color).
 */
export function roleColorToHex(color: number): string {
  if (color === 0) return 'var(--text-secondary)';
  return '#' + color.toString(16).padStart(6, '0');
}

/**
 * Converts a hex color string to an integer.
 */
export function hexToRoleColor(hex: string): number {
  const clean = hex.replace('#', '');
  return parseInt(clean, 16);
}

/**
 * Predefined role colors matching Discord's palette.
 */
export const ROLE_COLOR_PRESETS = [
  0x1abc9c, // teal
  0x2ecc71, // green
  0x3498db, // blue
  0x9b59b6, // purple
  0xe91e63, // magenta
  0xf1c40f, // gold
  0xe67e22, // orange
  0xe74c3c, // red
  0x95a5a6, // grey
  0x607d8b, // dark grey
  0x11806a, // dark teal
  0x1f8b4c, // dark green
  0x206694, // dark blue
  0x71368a, // dark purple
  0xad1457, // dark magenta
  0xc27c0e, // dark gold
  0xa84300, // dark orange
  0x992d22, // dark red
  0x979c9f, // light grey
  0x546e7a, // blurple grey
] as const;

/**
 * Returns preset role colors as hex strings.
 */
export function getRoleColorPresets(): string[] {
  return ROLE_COLOR_PRESETS.map((c) => '#' + c.toString(16).padStart(6, '0'));
}

/**
 * Computes relative luminance of an RGB color (0-1 scale).
 * Uses the sRGB luminance formula per WCAG 2.0.
 */
function luminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Returns a contrasting text color (black or white) for a given background color integer.
 * Useful for rendering text on role color badges.
 */
export function getContrastColor(colorInt: number): '#000000' | '#ffffff' {
  if (colorInt === 0) return '#ffffff';
  const r = (colorInt >> 16) & 0xff;
  const g = (colorInt >> 8) & 0xff;
  const b = colorInt & 0xff;
  const lum = luminance(r, g, b);
  // WCAG threshold: luminance > 0.179 means light background
  return lum > 0.179 ? '#000000' : '#ffffff';
}

/**
 * Returns a contrasting text color for a hex color string.
 */
export function getContrastColorHex(hex: string): '#000000' | '#ffffff' {
  const clean = hex.replace('#', '');
  return getContrastColor(parseInt(clean, 16));
}

/**
 * Blends a color with the background at a given opacity.
 * Useful for rendering semi-transparent role highlights.
 */
export function blendColorWithBackground(
  colorInt: number,
  bgHex: string,
  opacity: number
): string {
  const r1 = (colorInt >> 16) & 0xff;
  const g1 = (colorInt >> 8) & 0xff;
  const b1 = colorInt & 0xff;

  const bgClean = bgHex.replace('#', '');
  const r2 = parseInt(bgClean.substring(0, 2), 16);
  const g2 = parseInt(bgClean.substring(2, 4), 16);
  const b2 = parseInt(bgClean.substring(4, 6), 16);

  const r = Math.round(r1 * opacity + r2 * (1 - opacity));
  const g = Math.round(g1 * opacity + g2 * (1 - opacity));
  const b = Math.round(b1 * opacity + b2 * (1 - opacity));

  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
