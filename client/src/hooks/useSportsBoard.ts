import { useEffect } from 'react';
import { configureSportsPolling, watchSportsBoard, type SportsPollKind } from '../components/sports/poll';
import { useSportsStore } from '../stores/sportsStore';

configureSportsPolling({
  refresh: (guildId) => useSportsStore.getState().refreshBoard(guildId),
  enabled: (guildId) => useSportsStore.getState().byGuild[guildId]?.settings?.enabled === true,
  games: (guildId) => useSportsStore.getState().byGuild[guildId]?.board?.games ?? [],
});

/** One settings read per server per session, shared by the sidebar, the page and the strip. */
export function useSportsSettings(guildId: string) {
  const entry = useSportsStore((state) => state.byGuild[guildId]);
  useEffect(() => {
    if (!guildId) return;
    void useSportsStore.getState().ensureSettings(guildId);
  }, [guildId]);
  return {
    settings: entry?.settings ?? null,
    status: entry?.settingsStatus ?? 'idle',
    error: entry?.settingsError ?? null,
    board: entry?.board ?? null,
    boardError: entry?.boardError ?? null,
    flashes: entry?.flashes ?? {},
  };
}

/**
 * Poll the board while `active` and the document is visible.
 * `page` (the Sports page or the front-page strip) uses 15s while any game
 * is live and 60s otherwise. `sidebar` is always 60s. Both share one timer
 * per server, so they never fetch twice inside that interval.
 * A hidden tab waits, then refreshes as soon as it is visible again.
 */
export function useSportsPolling(guildId: string, active: boolean, kind: SportsPollKind = 'page') {
  const enabled = useSportsStore((state) => state.byGuild[guildId]?.settings?.enabled === true);

  useEffect(() => {
    if (!active || !enabled || !guildId) return;
    return watchSportsBoard(guildId, kind);
  }, [guildId, active, enabled, kind]);
}
