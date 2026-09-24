import { useEffect } from 'react';

import { fetchGuildTogether } from '../api/together';
import { registerSessionReset } from '../stores/sessionReset';
import { useTogetherStore } from '../stores/togetherStore';
import { useVoiceStore } from '../stores/voiceStore';

/** Which gateway snapshot each server's listing was last read for. */
const fetchedAt = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();

async function refresh(guildId: string, snapshot: number): Promise<void> {
  if (fetchedAt.get(guildId) === snapshot) return;
  const running = inFlight.get(guildId);
  if (running) return running;
  const task = fetchGuildTogether(guildId)
    .then((listing) => {
      fetchedAt.set(guildId, snapshot);
      useTogetherStore.getState().loadGuildActivities(guildId, listing.revision, listing.activities);
    })
    .catch(() => {
      // An older server has no listing; its voice rows simply show no activity.
    })
    .finally(() => inFlight.delete(guildId));
  inFlight.set(guildId, task);
  return task;
}

/**
 * Keep a server's "Watching …" summaries current: read them once, then again
 * after every gateway snapshot (a reconnect may have missed updates). Live
 * changes arrive as TOGETHER_ACTIVITY_UPDATE in between.
 */
export function useGuildTogether(guildId: string | null | undefined): void {
  const snapshot = useVoiceStore((s) => s.voiceSnapshotSeq);
  useEffect(() => {
    if (!guildId) return;
    const timer = window.setTimeout(() => void refresh(guildId, snapshot), 150);
    return () => window.clearTimeout(timer);
  }, [guildId, snapshot]);
}

export function resetGuildTogetherCache(): void {
  fetchedAt.clear();
  inFlight.clear();
}

registerSessionReset('together-guilds', resetGuildTogetherCache);
