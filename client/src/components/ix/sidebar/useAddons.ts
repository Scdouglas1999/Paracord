import { useEffect, useMemo } from 'react';

import type { GameServer } from '../../../api/gameServers';
import type { SportsGame } from '../../../api/sports';
import { useDailyWordSettings } from '../../../hooks/useDailyWord';
import { useGameServers } from '../../../hooks/useGameServers';
import { useSportsPolling, useSportsSettings } from '../../../hooks/useSportsBoard';
import { useDailyWordStore } from '../../../stores/dailyWordStore';
import { dailyWordHref, isDailyWordPath } from '../../dailyWord/model';
import { upCount } from '../../gameServers/gameServerModel';
import { hottestLiveId, isSportsPath, liveCount, readHideScores, sportsHref, statusLine, teamLabel } from '../../sports/model';

/**
 * A server's add-ons as sidebar rows (docs/index-spec.md §8.3): Sports, Daily word
 * and Game servers, each only while the server has it on, each with a live line:
 * "Cubs 3–2 Brewers · 7th", "4 solved today", "2 of 3 online". Same data and the
 * same destinations the Glass rows had; they are two-line rows like channels now.
 */

export type AddonKind = 'sports' | 'word' | 'games';

export interface AddonModel {
  /** Roving-focus id. */
  id: string;
  kind: AddonKind;
  name: string;
  /** What is going on in it; null until it is known. */
  line: string | null;
  selected: boolean;
  /** Where it opens. Game servers have no page yet: they open a small list. */
  href?: string;
  servers?: readonly GameServer[];
}

export const ADDON_ID = {
  sports: 'addon:sports',
  word: 'addon:word',
  games: 'addon:games',
} as const;

/** "Cubs 3–2 Brewers · 7th": the hottest live game, or how many are live, or what the add-on is. */
export function sportsLine(games: readonly SportsGame[] | undefined, hideScores: boolean): string {
  const live = liveCount(games);
  if (live === 0) return 'Scores';
  if (live > 1 || hideScores) return `${live} live now`;
  const game = games?.find((entry) => entry.id === hottestLiveId(games ?? []));
  if (!game) return `${live} live now`;
  const when = statusLine(game).replace(/\s+[–-]\s+/g, ' ');
  const score = `${game.away.score ?? '–'}–${game.home.score ?? '–'}`;
  return `${teamLabel(game.away)} ${score} ${teamLabel(game.home)}${when ? ` · ${when}` : ''}`;
}

export function wordLine(solved: number | null): string {
  return solved !== null && solved > 0 ? `${solved} solved today` : "Today's puzzle";
}

export function gamesLine(servers: readonly GameServer[]): string {
  const checked = servers.some((server) => server.status.state !== 'checking');
  return checked ? `${upCount(servers)} of ${servers.length} online` : 'Checking…';
}

export function useAddons(guildId: string, pathname: string): AddonModel[] {
  const { settings, board } = useSportsSettings(guildId);
  const sportsOn = settings?.enabled === true;
  // The same 60 second poll the Glass sidebar ran, so the row can say what is live.
  useSportsPolling(guildId, sportsOn, 'sidebar');
  const { enabled: wordOn } = useDailyWordSettings(guildId);
  const solved = useDailyWordStore((state) => state.boards[guildId]?.board?.solved ?? null);
  useEffect(() => {
    if (wordOn) void useDailyWordStore.getState().refreshBoard(guildId);
  }, [wordOn, guildId]);
  const { servers } = useGameServers(guildId);

  return useMemo(() => {
    const models: AddonModel[] = [];
    if (sportsOn) {
      models.push({
        id: ADDON_ID.sports,
        kind: 'sports',
        name: 'Sports',
        line: sportsLine(board?.games, readHideScores()),
        selected: isSportsPath(guildId, pathname),
        href: sportsHref(guildId),
      });
    }
    if (wordOn) {
      models.push({
        id: ADDON_ID.word,
        kind: 'word',
        name: 'Daily word',
        line: wordLine(solved),
        selected: isDailyWordPath(guildId, pathname),
        href: dailyWordHref(guildId),
      });
    }
    if (servers.length > 0) {
      models.push({ id: ADDON_ID.games, kind: 'games', name: 'Game servers', line: gamesLine(servers), selected: false, servers });
    }
    return models;
  }, [sportsOn, board, wordOn, solved, servers, guildId, pathname]);
}
