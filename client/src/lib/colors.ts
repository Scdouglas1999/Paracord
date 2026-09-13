import type { Role } from '../types';

// ============ Identity colors ============

/**
 * The identity palette (docs/lantern-stage-spec.md §1.2, and the reference
 * renders' avatar hues). Five warm, desaturated colours that sit quietly on the
 * dark ground — a person's or a building's colour is *who they are*, so it is
 * fixed across themes and never carries state. Light is the only thing that
 * carries state.
 *
 * Returned as token references so there is still exactly one place the values
 * live (`--color-avatar-*` in src/styles/tokens.css). Ink on any of them is
 * `--text-on-light`.
 */
const IDENTITY_COLORS = [
  'var(--color-avatar-1)',
  'var(--color-avatar-2)',
  'var(--color-avatar-3)',
  'var(--color-avatar-4)',
  'var(--color-avatar-5)',
];

/**
 * Deterministic identity color for a person or a building, from its snowflake.
 *
 * Use this for every avatar fallback. Never `--accent-primary`: the emerald
 * means "an action you can take", and a person is not an action.
 */
export function getIdentityColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash |= 0;
  }
  return IDENTITY_COLORS[Math.abs(hash) % IDENTITY_COLORS.length];
}

/** @deprecated Use {@link getIdentityColor}; a building is an identity too. */
export const getGuildColor = getIdentityColor;

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
 * The colour a role starts life with in the colour picker — a role's colour is
 * DATA the operator sends to the server, not a surface this app paints, so it
 * is a literal number and belongs here rather than in `tokens.css`. A role with
 * this value reads as "no colour chosen"; `roleColorToHex(0)` is the token that
 * actually paints an uncoloured role's name.
 */
export const DEFAULT_ROLE_COLOR = '#99aab5';

/** A role colour the server has never been given; render it with the ramp. */
export const UNSET_ROLE_COLOR = '#000000';
