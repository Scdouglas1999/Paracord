import type { Role } from '../types';

// ============ Identity colors ============

/*
 * RETIRING (docs/index-spec.md §2.3, §12). Index draws a person and a server as a
 * flat tonal mark from a hue, not from one of eight fills: use `Avatar` and
 * `ServerMark` (components/ix/identity) and `paletteHue` / `serverHue`
 * (lib/identityHue.ts). What remains below is for the call sites that have not
 * been rebuilt yet (the timeline's own avatar, the admin tables, the lobby head,
 * the discovery banners); each package that rebuilds one deletes its use, and
 * IX-19 deletes this section and the `--color-avatar-N` / `--identity-ink-N`
 * tokens with the last of them.
 */

/**
 * The identity palette (docs/lantern-stage-spec.md §1.2, and the reference
 * renders' avatar hues). Eight soft colors that sit quietly on the dark
 * ground — a person's or a server's color is *who they are*, so it is fixed
 * across themes, fixed across the user's base-hue choice, and never carries
 * state. Light is the only thing that carries state.
 *
 * Eight rather than five: a channel with a dozen people in it repeated a hue
 * every other row at five, which is exactly when a color stops saying who
 * somebody is.
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
  'var(--color-avatar-6)',
  'var(--color-avatar-7)',
  'var(--color-avatar-8)',
];

/**
 * The same eight identities, written as INK.
 *
 * A fill and a piece of text are not the same problem: apricot in a 28px circle
 * is fine on paper, and apricot as a name on paper measures about 2:1. The
 * `--identity-ink-*` tokens are the fill on a dark ground and a deepened
 * version of it in Daylight, so an author's name clears AA in every theme.
 */
const IDENTITY_INKS = IDENTITY_COLORS.map((_, index) => `var(--identity-ink-${index + 1})`);

/**
 * The palette slot a snowflake falls in. One hash, so a fill and its ink agree.
 *
 * @deprecated Index hues come from `paletteHue` (lib/identityHue.ts).
 */
export function identityIndex(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % IDENTITY_COLORS.length;
}

/**
 * Deterministic identity color for a person or a server, from its snowflake.
 *
 * @deprecated Draw an `Avatar` or a `ServerMark` (components/ix/identity); they
 * own the fill, the letter and the hairline. Never `--accent-primary`: the
 * action is cream, and a person is not an action.
 */
export function getIdentityColor(id: string): string {
  return IDENTITY_COLORS[identityIndex(id)];
}

/**
 * The same identity, as text. Index writes a name in the ink ramp, not in a
 * person's color (docs/index-spec.md §4.11), so nothing new should call this.
 *
 * @deprecated Names are written in `--ix-ink-3` / `--ix-ink`.
 */
export function getIdentityInk(id: string): string {
  return IDENTITY_INKS[identityIndex(id)];
}

/** @deprecated Use {@link getIdentityColor}; a server is an identity too. */
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
 * The color a role starts life with in the color picker — a role's color is
 * DATA the operator sends to the server, not a surface this app paints, so it
 * is a literal number and belongs here rather than in `tokens.css`. A role with
 * this value reads as "no color chosen"; `roleColorToHex(0)` is the token that
 * actually paints an uncoloured role's name.
 */
export const DEFAULT_ROLE_COLOR = '#99aab5';

/** A role color the server has never been given; render it with the ramp. */
export const UNSET_ROLE_COLOR = '#000000';
