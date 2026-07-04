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

/** Minimal structural shape — a guild only needs its client-side `server_url` tag. */
export interface GuildLike {
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
 * channels, from the `server_url → serverId` map. Falls back to `activeServerId`
 * when the guild's `server_url` is missing or unmapped.
 *
 * FLAG (layout-spec §9 flag 3 — latent mis-attribution): guilds that arrive via a
 * *background* server's READY are stamped by `guildStore.addGuild` with the ACTIVE
 * server's base url (`resolveApiBaseUrl()`), not their true origin. Such a guild
 * therefore resolves to `activeServerId` here even though its channels live on the
 * background server — its unread/mention counts can be read from the wrong bucket
 * until a proper fix tags guilds with their originating serverId at ingest (a small
 * additive client change flagged for its own PR). The fallback keeps the merge
 * green and collision-safe; it does not fabricate a wrong-but-confident mapping.
 */
export function resolveServerIdForGuild(
  guild: GuildLike,
  urlMap: Map<string, string>,
  activeServerId: string,
): string {
  const url = guild.server_url ? normalizeServerUrl(guild.server_url) : '';
  const resolved = url ? urlMap.get(url) : undefined;
  return resolved ?? activeServerId;
}
