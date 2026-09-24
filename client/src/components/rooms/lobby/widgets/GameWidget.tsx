import type { CSSProperties } from 'react';
import { Link } from 'react-router';

import { useSportsPolling, useSportsSettings } from '../../../../hooks/useSportsBoard';
import { teamPaint } from '../../../sports/gamecast';
import {
  sportsHref,
  statusLine,
  stripAriaLabel,
  stripGames,
} from '../../../sports/model';
import { TeamMark } from '../../../sports/TeamMark';
import type { SportsGame } from '../../../../api/sports';
import { WidgetCard, WidgetError } from './WidgetCard';
import { useHideScores } from '../useHideScores';

export interface GameWidgetProps {
  guildId: string;
  /**
   * On a desktop a live game is shown in "Live now" instead, so this card
   * only speaks for the next one then.
   */
  liveShownElsewhere: boolean;
}

/**
 * The Sports add-on's live data, for pages that are not the widget itself:
 * the page puts a live game into "Live now" from this. `show_on_server_page`
 * is the server saying games belong on its home page — off keeps them on the
 * Sports page only, and nothing here polls for data nobody will see.
 */
export function useSportsGames(guildId: string): { shown: boolean; games: SportsGame[] } {
  const { settings, status, board } = useSportsSettings(guildId);
  const shown = settings?.enabled === true && settings.show_on_server_page === true && status === 'ready';
  useSportsPolling(guildId, shown);
  return { shown, games: shown ? board?.games ?? [] : [] };
}


/**
 * "Game": a game live now for the teams the server follows, or else the next
 * one. Only when Sports is on and the server shows games on its home page.
 */
export function GameWidget({ guildId, liveShownElsewhere }: GameWidgetProps) {
  const { settings, status, board, boardError } = useSportsSettings(guildId);
  const enabled = settings?.enabled === true && settings.show_on_server_page === true && status === 'ready';
  const hideScores = useHideScores();
  if (!enabled) return null;
  if (boardError && !board) {
    return (
      <WidgetCard title="Game">
        <WidgetError>{boardError}</WidgetError>
      </WidgetCard>
    );
  }
  const games = board?.games ?? [];
  const pick = stripGames(liveShownElsewhere ? games.filter((game) => game.state !== 'in') : games);
  const game = pick.games[0];
  if (!game) return null;
  const live = game.state === 'in';
  const away = teamPaint(game.away, game.home);
  const home = teamPaint(game.home, game.away);
  const showScore = !hideScores && game.state !== 'pre';
  return (
    <WidgetCard
      title={live ? 'Game · live' : 'Next game'}
      action={
        <Link to={sportsHref(guildId)} className="pc-focusable rounded-[var(--radius-chip)] px-1 text-meta font-medium text-text-link hover:underline">
          All games
        </Link>
      }
    >
      <Link
        to={sportsHref(guildId)}
        aria-label={stripAriaLabel(game)}
        className="pc-focusable flex flex-col gap-2 rounded-[var(--radius-control)]"
        style={{ '--pc-away': away.fill, '--pc-home': home.fill } as CSSProperties}
      >
        {[game.away, game.home].map((team) => (
          <span key={team.id} className="flex items-center gap-2.5">
            <TeamMark team={team} />
            <span className="min-w-0 flex-1 truncate text-label text-text-primary">{team.short_name || team.name}</span>
            {showScore && <span className="pc-mono shrink-0 text-heading text-text-primary">{team.score ?? 0}</span>}
          </span>
        ))}
        <span className="flex items-center gap-2 text-meta text-text-muted">
          {live && <span className="pc-home-live-dot" aria-hidden />}
          {statusLine(game)}
        </span>
      </Link>
    </WidgetCard>
  );
}
