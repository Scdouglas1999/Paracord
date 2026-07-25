import { useCallback, useEffect, useState } from 'react';
import { getVersionedJson, setVersionedJson } from '../lib/versionedStorage';
import { notificationSettingsApi } from '../api/notificationSettings';

/**
 * Muted-space set — the single producer/consumer for the `muted-guilds`
 * preference (layout-spec §3.2). The old Discord guild rail owned this
 * read/write; when it was deleted the readers survived (`TextChannelList`,
 * `TopBar`) but the WRITER was orphaned, so a user could no longer mute a space
 * anywhere and the muted set feeding attention ranking was permanently empty.
 *
 * The set is now **server-backed**. It used to live only in localStorage, so a
 * mute did not follow you to another device, did not survive clearing site
 * data, and was invisible to the server — which meant nothing else could ever
 * respect it. `/users/@me/notification-settings` is now the source of truth.
 *
 * localStorage is kept as a synchronous cache so the first paint has the set
 * before the fetch resolves, and so the existing readers keep their contract:
 * `mutedGuildIds` stays live across tabs (`storage`) and in-tab writers (the
 * `paracord-muted-guilds-updated` event they already listen for). Writes are
 * optimistic and roll back if the server rejects them.
 */

const STORAGE_BASE = 'muted-guilds';
const UPDATE_EVENT = 'paracord-muted-guilds-updated';

export function readMutedGuildIds(): string[] {
  try {
    return getVersionedJson<string[]>(STORAGE_BASE, [], [STORAGE_BASE]);
  } catch {
    return [];
  }
}

/** Persist the muted set locally and notify every in-tab reader. */
export function writeMutedGuildIds(ids: string[]): void {
  setVersionedJson(STORAGE_BASE, ids);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(UPDATE_EVENT));
  }
}

/**
 * Pull the authoritative set from the server and reconcile the local cache.
 *
 * A space muted on another device appears here; one unmuted elsewhere
 * disappears. `muted_now` is used rather than `muted` so a lapsed timed mute
 * stops counting without needing a sweep.
 */
export async function syncMutedGuildsFromServer(): Promise<string[]> {
  const { spaces } = await notificationSettingsApi.list();
  const ids = spaces.filter((s) => s.muted_now).map((s) => s.space_id);
  writeMutedGuildIds(ids);
  return ids;
}

/**
 * Toggle a space's muted state, writing through to the server.
 *
 * Optimistic: the local set updates immediately so the UI responds, and rolls
 * back if the request fails. Returns the intended new state.
 */
export async function toggleGuildMuted(guildId: string): Promise<boolean> {
  const previous = readMutedGuildIds();
  const wasMuted = previous.includes(guildId);
  const next = wasMuted ? previous.filter((id) => id !== guildId) : [...previous, guildId];
  writeMutedGuildIds(next);

  try {
    if (wasMuted) {
      // Clearing the override returns the space to the default rather than
      // storing an explicit "not muted" row.
      await notificationSettingsApi.clearSpace(guildId);
    } else {
      await notificationSettingsApi.setSpace(guildId, { muted: true });
    }
  } catch (err) {
    writeMutedGuildIds(previous);
    throw err;
  }
  return !wasMuted;
}

export interface UseMutedGuilds {
  mutedGuildIds: string[];
  isMuted: (guildId: string) => boolean;
  toggleMute: (guildId: string) => void;
}

export function useMutedGuilds(): UseMutedGuilds {
  const [mutedGuildIds, setIds] = useState<string[]>(readMutedGuildIds);

  useEffect(() => {
    const sync = () => setIds(readMutedGuildIds());
    sync();
    window.addEventListener('storage', sync);
    window.addEventListener(UPDATE_EVENT, sync as EventListener);

    // Reconcile against the server once on mount. A failure here is not worth
    // surfacing: the cached set is still serviceable and the next toggle
    // reports its own error.
    void syncMutedGuildsFromServer().catch(() => undefined);

    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(UPDATE_EVENT, sync as EventListener);
    };
  }, []);

  const isMuted = useCallback(
    (guildId: string) => mutedGuildIds.includes(guildId),
    [mutedGuildIds],
  );
  const toggleMute = useCallback((guildId: string) => {
    void toggleGuildMuted(guildId);
  }, []);

  return { mutedGuildIds, isMuted, toggleMute };
}
