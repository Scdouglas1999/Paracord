import { useEffect } from 'react';
import { useDailyWordStore } from '../stores/dailyWordStore';
import { useServerReady } from './useServerReady';

/** A server's daily word settings, read once per session and shared. */
export function useDailyWordSettings(guildId: string) {
  const entry = useDailyWordStore((state) => state.settingsByGuild[guildId]);
  // Asked of the selected server once it is connected, not recorded as a failure before then.
  const ready = useServerReady();
  useEffect(() => {
    if (!guildId || !ready) return;
    void useDailyWordStore.getState().ensureSettings(guildId);
  }, [guildId, ready]);
  return {
    settings: entry?.settings ?? null,
    status: entry?.status ?? 'idle',
    error: entry?.error ?? null,
    enabled: entry?.settings?.enabled === true,
  };
}
