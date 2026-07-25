import type { Role } from '../types';

// ============ Guild Icon Colors ============

/** Guild icon color palette, consumed by `getGuildColor` below. */
const GUILD_COLORS = [
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
 * Returns the hex color of the highest-positioned colored role a member holds,
 * or `undefined` when the member has no role with an explicit color. A role
 * color of 0 counts as "no color", so callers fall back to a default.
 */
export function getHighestRoleColor(
  memberRoles: string[],
  roles: Role[]
): string | undefined {
  const matched = roles
    .filter((r) => memberRoles.includes(r.id) && r.color !== 0)
    .sort((a, b) => b.position - a.position);
  if (matched.length === 0) return undefined;
  return roleColorToHex(matched[0].color);
}
