import { useCallback, useEffect, useState } from 'react';
import { getVersionedJson, setVersionedJson } from '../lib/versionedStorage';

/**
 * Muted-guild set — the single producer/consumer for the `muted-guilds`
 * preference (layout-spec §3.2). The old Discord guild rail owned this read/write;
 * when it was deleted the readers survived (`TextChannelList`, `TopBar`) but the
 * WRITER was orphaned, so a user could no longer mute a guild anywhere and the
 * muted set feeding attention ranking was permanently empty.
 *
 * This hook re-homes both halves: `mutedGuildIds` reflects the persisted set and
 * stays live across tabs (`storage`) and in-tab writers (the
 * `paracord-muted-guilds-updated` event the existing readers already listen for),
 * and `toggleMute` is the producer that writes the set + fires that event.
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

/** Persist the muted set and notify every in-tab reader (the readers already listen). */
export function writeMutedGuildIds(ids: string[]): void {
  setVersionedJson(STORAGE_BASE, ids);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(UPDATE_EVENT));
  }
}

/** Toggle a guild's muted state; returns the new muted state. */
export function toggleGuildMuted(guildId: string): boolean {
  const current = readMutedGuildIds();
  const isMuted = current.includes(guildId);
  const next = isMuted ? current.filter((id) => id !== guildId) : [...current, guildId];
  writeMutedGuildIds(next);
  return !isMuted;
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
    toggleGuildMuted(guildId);
  }, []);

  return { mutedGuildIds, isMuted, toggleMute };
}
