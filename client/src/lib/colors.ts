import type { Role } from '../types';

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

/**
 * The color a role starts life with in the color picker — a role's color is
 * DATA the operator sends to the server, not a surface this app paints, so it
 * is a literal number and belongs here rather than in `tokens.css`. A role with
 * this value reads as "no color chosen"; `roleColorToHex(0)` is the token that
 * actually paints an uncoloured role's name.
 */
export const DEFAULT_ROLE_COLOR = '#99aab5';

/** A role color the server has never been given; render it with the ramp. */
export const UNSET_ROLE_COLOR = '#000000';
