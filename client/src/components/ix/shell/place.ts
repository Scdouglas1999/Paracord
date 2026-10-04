/**
 * Places (docs/index-spec.md §1 "Words": the server or People view the sidebar
 * shows; never UI copy). Pure helpers; the hooks are in `usePlace.ts`.
 */

export type Place = { kind: 'server'; guildId: string } | { kind: 'people' };

export const PEOPLE_PLACE: Place = Object.freeze({ kind: 'people' }) as Place;

export function serverPlace(guildId: string): Place {
  return { kind: 'server', guildId };
}

/**
 * The place's key: `people`, or the server's id. It is also the dock item's
 * `data-place` (docs/design/index-plan.md §1.3, e2e/fixtures/index/drivers.ts)
 * and the entry in the dock order.
 */
export function placeKey(place: Place): string {
  return place.kind === 'people' ? 'people' : place.guildId;
}

export function samePlace(a: Place | null | undefined, b: Place | null | undefined): boolean {
  if (!a || !b) return a === b;
  return placeKey(a) === placeKey(b);
}

/**
 * The place a route belongs to, or null for a route that belongs to none (admin,
 * developers, discovery, templates, bot authorize): those keep the place you
 * came from.
 *
 *   /app/guilds/:guildId/...          the server
 *   /app, /app/dms[/:id], /app/friends People
 */
export function placeOfPath(pathname: string): Place | null {
  const server = /^\/app\/guilds\/([^/]+)/.exec(pathname);
  if (server) return serverPlace(decodeURIComponent(server[1]));
  if (/^\/app\/?$/.test(pathname) || /^\/app\/(dms|friends)(\/|$)/.test(pathname)) return PEOPLE_PLACE;
  return null;
}

/**
 * The slide direction between two places (§5.1): the sign of the dock index
 * change. 0 when either is missing from the order (a server that just appeared
 * or just left), which crossfades instead of sliding.
 */
export function placeDirection(order: readonly string[], from: Place | null, to: Place): -1 | 0 | 1 {
  if (!from) return 0;
  const a = order.indexOf(placeKey(from));
  const b = order.indexOf(placeKey(to));
  if (a < 0 || b < 0 || a === b) return 0;
  return b > a ? 1 : -1;
}
