/**
 * Cross-server attribution helpers for the unified conversation list
 * (layout-spec §3.2, §9 flag 3).
 *
 * Pure + unit-testable — NO store or React imports beyond the shared
 * `normalizeServerUrl` normalizer (reused, never forked, from `serverListStore`).
 * These resolve which connected server a guild's channels + read-state belong to
 * so the merge reads the correct per-server bucket and stays collision-safe when
 * two servers mint the same channel id.
 */

import { normalizeServerUrl, type ServerEntry } from '../../stores/serverListStore';

/** Minimal structural shape — a guild's client-side attribution tags. */
export interface GuildLike {
  /** True originating server, stamped at gateway ingest (authoritative). */
  originServerId?: string | null;
  /** Base url the guild was fetched from (may mis-attribute background guilds). */
  server_url?: string | null;
}

/**
 * Build a `normalizedUrl → serverId` map from the connected server list. Reuses
 * `normalizeServerUrl` so lookups match `serverListStore.getServerByUrl`. Blank
 * urls are skipped; the first server to claim a normalized url wins (duplicate
 * urls should not occur — `addServer` dedupes on the same normalized url).
 */
export function buildServerUrlMap(servers: ServerEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const server of servers) {
    const url = normalizeServerUrl(server.url);
    if (!url || map.has(url)) continue;
    map.set(url, server.id);
  }
  return map;
}

/**
 * Resolve the serverId whose read-state / channel bucket holds this guild's
 * channels. Prefers the authoritative `originServerId` stamped at gateway ingest;
 * falls back to the `server_url → serverId` map, then to `activeServerId`.
 *
 * `originServerId` (layout-spec §9 flag 3, now fixed) closes the latent
 * mis-attribution: guilds arriving via a *background* server's READY used to be
 * stamped by `guildStore.addGuild` with only the ACTIVE server's base url, so they
 * resolved to `activeServerId` here even though their channels live on the
 * background server — reading unread/mention from the wrong bucket. The origin tag
 * carries the true owning server, so the merge now reads the correct per-server
 * bucket. The url-map + active fallback remains for older cached guilds that
 * predate the tag.
 */
export function resolveServerIdForGuild(
  guild: GuildLike,
  urlMap: Map<string, string>,
  activeServerId: string,
): string {
  if (guild.originServerId) return guild.originServerId;
  const url = guild.server_url ? normalizeServerUrl(guild.server_url) : '';
  const resolved = url ? urlMap.get(url) : undefined;
  return resolved ?? activeServerId;
}
