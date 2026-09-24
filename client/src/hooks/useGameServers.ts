import { useEffect } from 'react';
import { useGameServerStore } from '../stores/gameServerStore';

/** The instance checks each game server once a minute; reading more often shows nothing new. */
export const GAME_SERVER_REFRESH_MS = 60_000;

/**
 * A server's game servers and how each is doing, shared by every surface that
 * shows them and re-read once a minute while one of them is on screen.
 */
export function useGameServers(guildId: string | null | undefined) {
  const entry = useGameServerStore((state) => (guildId ? state.byGuild[guildId] : undefined));
  const enabled = entry?.list?.enabled === true;

  // Read once; keep re-reading only while the add-on is on.
  useEffect(() => {
    if (!guildId) return;
    const refresh = () => void useGameServerStore.getState().refresh(guildId, GAME_SERVER_REFRESH_MS / 2);
    refresh();
    if (!enabled) return;
    const timer = window.setInterval(refresh, GAME_SERVER_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [guildId, enabled]);

  const list = entry?.list ?? null;
  return {
    list,
    status: entry?.status ?? 'idle',
    error: entry?.error ?? null,
    enabled,
    servers: list?.enabled ? list.servers : [],
  };
}
