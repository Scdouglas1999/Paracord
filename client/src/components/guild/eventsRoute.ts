/**
 * The Events page's route (docs/index-spec.md §8.3): a server's full calendar in
 * main, reached from the server menu's "Events", the Overview's Calendar link and
 * its Events chip. The same shape as `sportsHref` and `dailyWordHref`.
 */
export function eventsHref(guildId: string): string {
  return `/app/guilds/${encodeURIComponent(guildId)}/events`;
}

/** True when `pathname` is this server's Events page. */
export function isEventsPath(guildId: string, pathname: string): boolean {
  const base = eventsHref(guildId);
  return pathname === base || pathname === `${base}/`;
}
