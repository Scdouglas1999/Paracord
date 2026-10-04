/**
 * Identity hue (docs/index-spec.md §2.2, §2.3).
 *
 * A person, a server and a window tint are each one number: a hue from 0 to
 * 359. JS passes the number and CSS builds every color from it
 * (`hsl(var(--ix-h) 30% 30%)`), so no color string ever leaves a stylesheet and
 * nothing here knows what a theme is.
 *
 * Defaults come from a short, curated list that has no purples (the owner's
 * rule: no purple defaults). A server's own hue, when an admin has set one,
 * wins over the id-derived default; People is always {@link PEOPLE_HUE}.
 */

/**
 * The eleven hues an identity can default to, and the swatches Server color
 * offers (docs/index-spec.md §2.2). Rose, warm reds and oranges, greens,
 * teals and blues; nothing between 250 and 320.
 */
export const PALETTE_HUES = [350, 8, 22, 36, 150, 162, 176, 190, 200, 214, 226] as const;

/** The People place (DMs and friends) is always this hue. */
export const PEOPLE_HUE = 210;

/** Digits at the end of a snowflake that decide the hue. */
const TAIL_DIGITS = 9;

/** A deterministic string hash, for ids that are not decimal (tests, bots, local ids). */
function hashIndex(id: string, modulus: number): number {
  let hash = 5381;
  for (let i = 0; i < id.length; i += 1) {
    hash = ((hash << 5) + hash + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % modulus;
}

/**
 * The hue a snowflake defaults to. `index = id mod 11` over the decimal
 * string's last nine digits, so it is stable across sessions and clients and
 * does not need BigInt. An id that is not a decimal string falls back to a
 * string hash onto the same list, so a mock or local id still gets a hue.
 */
export function paletteHue(id: string): number {
  const size = PALETTE_HUES.length;
  const tail = id.slice(-TAIL_DIGITS);
  const index = /^\d+$/.test(tail) ? Number(tail) % size : hashIndex(id, size);
  return PALETTE_HUES[index];
}

/** True for an integer hue in 0–359, the only values the server stores. */
export function isHue(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 359;
}

/**
 * The hue of a server: its admin-set `hue` when there is a valid one,
 * otherwise the default derived from its id. A value outside 0–359 is treated
 * as unset (the server validates on write; this is the client's floor).
 */
export function serverHue(guild: { id: string; hue?: number | null }): number {
  return isHue(guild.hue) ? guild.hue : paletteHue(guild.id);
}
