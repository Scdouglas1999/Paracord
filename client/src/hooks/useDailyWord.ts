import { useEffect } from 'react';
import { useDailyWordStore } from '../stores/dailyWordStore';

/** A server's daily word settings, read once per session and shared. */
export function useDailyWordSettings(guildId: string) {
  const entry = useDailyWordStore((state) => state.settingsByGuild[guildId]);
  useEffect(() => {
    if (!guildId) return;
    void useDailyWordStore.getState().ensureSettings(guildId);
  }, [guildId]);
  return {
    settings: entry?.settings ?? null,
    status: entry?.status ?? 'idle',
    error: entry?.error ?? null,
    enabled: entry?.settings?.enabled === true,
  };
}
