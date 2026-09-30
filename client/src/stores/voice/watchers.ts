import type { VoiceWatchers } from '../../api/generated/VoiceWatchers';
import { entityScopeKey, type AccountScope } from '../../lib/serverScope';

/**
 * Watcher counts ("2 watching", docs/glass-spec.md §8) as the voice store keeps
 * them: one complete snapshot per voice channel, keyed by the channel's
 * account-scoped key so two connected instances whose snowflakes collide can
 * never overwrite each other's counts.
 *
 * The server sends a whole channel at a time (`VOICE_WATCHERS_UPDATE`, and the
 * same shape from `GET /api/v2/voice/{id}/watchers`): a streamer who is not
 * listed has no watchers. Ambient viewers (room light) are never counted.
 */
export type ChannelWatchers = ReadonlyMap<string, number>;
export type WatcherIndex = ReadonlyMap<string, ChannelWatchers>;

/** The key a channel's counts are filed under. */
export function watcherKey(scope: AccountScope, channelId: string): string {
  return entityScopeKey(scope, channelId);
}

export function isVoiceWatchersUpdate(data: unknown): data is VoiceWatchers {
  const value = data as Partial<VoiceWatchers> | null;
  return (
    !!value
    && typeof value.channel_id === 'string' && !!value.channel_id
    && typeof value.guild_id === 'string' && !!value.guild_id
    && Array.isArray(value.streams)
    && value.streams.every(
      (stream) => !!stream && typeof stream.user_id === 'string'
        && typeof stream.watchers === 'number' && Number.isFinite(stream.watchers) && stream.watchers >= 0,
    )
  );
}

/**
 * Apply one channel's snapshot. Returns the same index when nothing changed,
 * so a repeated snapshot does not re-render anybody.
 */
export function applyWatchersSnapshot(
  index: WatcherIndex,
  scope: AccountScope,
  snapshot: VoiceWatchers,
): WatcherIndex {
  const key = watcherKey(scope, snapshot.channel_id);
  const next = new Map<string, number>();
  for (const stream of snapshot.streams) {
    if (stream.watchers > 0) next.set(stream.user_id, stream.watchers);
  }
  const previous = index.get(key);
  if (previous && previous.size === next.size && [...next].every(([id, n]) => previous.get(id) === n)) {
    return index;
  }
  if (!previous && next.size === 0) return index;
  const updated = new Map(index);
  if (next.size === 0) updated.delete(key);
  else updated.set(key, next);
  return updated;
}

/** How many people watch `streamerId` in the channel (0 when nobody does). */
export function watcherCount(
  index: WatcherIndex,
  scope: AccountScope | null,
  channelId: string,
  streamerId: string,
): number {
  if (!scope) return 0;
  return index.get(watcherKey(scope, channelId))?.get(streamerId) ?? 0;
}

/** Drop every count that belongs to one account (sign-out, disconnect). */
export function dropScopeWatchers(index: WatcherIndex, scopePrefix: (key: string) => boolean): WatcherIndex {
  let changed = false;
  const next = new Map(index);
  for (const key of index.keys()) {
    if (scopePrefix(key)) { next.delete(key); changed = true; }
  }
  return changed ? next : index;
}
