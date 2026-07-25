import { channelApi } from '../api/channels';
import { guildApi } from '../api/guilds';
import type { ChannelOverwrite, Role } from '../types';

/**
 * Request-level dedupe + short TTL for the two payloads that gate permission UI:
 * a guild's roles and a channel's permission overwrites.
 *
 * Opening a single channel used to issue the same requests several times over —
 * `MessageList`, `MessageInput` and `MemberList` each fetched independently,
 * with no shared state and no in-flight dedupe. Every consumer here shares one
 * request, and a repeat within the TTL is served from memory.
 *
 * The TTL is deliberately short. These values change through moderation actions
 * that users expect to see reflected quickly, and the gateway's role/overwrite
 * events invalidate the cache explicitly (see the listener at the bottom), so
 * the TTL only has to cover the burst of calls around a channel switch.
 */
const TTL_MS = 30_000;

interface CacheEntry<T> {
  /** Resolved value, present once the first request settles. */
  value?: T;
  /** Timestamp of the last successful resolution. */
  at: number;
  /** In-flight request, shared by every concurrent caller. */
  inflight?: Promise<T>;
}

const roleCache = new Map<string, CacheEntry<Role[]>>();
const overwriteCache = new Map<string, CacheEntry<ChannelOverwrite[]>>();

function readFresh<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry?.value) return undefined;
  if (Date.now() - entry.at > TTL_MS) return undefined;
  return entry.value;
}

function share<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  request: () => Promise<T>,
): Promise<T> {
  const fresh = readFresh(cache, key);
  if (fresh) return Promise.resolve(fresh);

  const existing = cache.get(key);
  if (existing?.inflight) return existing.inflight;

  const inflight = request()
    .then((value) => {
      cache.set(key, { value, at: Date.now() });
      return value;
    })
    .catch((err: unknown) => {
      // Never cache a failure — the next caller must be able to retry.
      cache.delete(key);
      throw err;
    });

  cache.set(key, { at: existing?.at ?? 0, value: existing?.value, inflight });
  return inflight;
}

export function fetchGuildRoles(guildId: string): Promise<Role[]> {
  return share(roleCache, guildId, () => guildApi.getRoles(guildId).then(({ data }) => data));
}

export function fetchChannelOverwrites(channelId: string): Promise<ChannelOverwrite[]> {
  return share(overwriteCache, channelId, () =>
    channelApi.getOverwrites(channelId).then(({ data }) => data),
  );
}

export function invalidateGuildRoles(guildId?: string): void {
  if (guildId) roleCache.delete(guildId);
  else roleCache.clear();
}

export function invalidateChannelOverwrites(channelId?: string): void {
  if (channelId) overwriteCache.delete(channelId);
  else overwriteCache.clear();
}

/** Drop everything. Called on logout so the next account re-fetches. */
export function clearPermissionDataCache(): void {
  roleCache.clear();
  overwriteCache.clear();
}

if (typeof window !== 'undefined') {
  // The gateway is the authority on role changes; a demotion must invalidate
  // immediately rather than waiting out the TTL. Overwrites are dropped too:
  // a role edit can change what a channel overwrite resolves to.
  window.addEventListener('paracord:roles-changed', (event) => {
    const detail = (event as CustomEvent<{ guild_id?: string }>).detail;
    invalidateGuildRoles(detail?.guild_id ? String(detail.guild_id) : undefined);
    invalidateChannelOverwrites();
  });
}
