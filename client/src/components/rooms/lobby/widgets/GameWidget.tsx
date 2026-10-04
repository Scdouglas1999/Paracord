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
import { WidgetCard, WidgetError } from './WidgetCard';
import { useHideScores } from '../useHideScores';

export interface GameWidgetProps {
  guildId: string;
}

/**
 * "Game": a game live now for the teams the server follows, or else the next
 * one. Only when Sports is on and the server shows games on its home page
 * (`show_on_server_page`: off keeps them on the Sports page only, and nothing
 * here polls for data nobody will see).
 *
 * The Overview has no "Live now" block any more (the room card shows what is live,
 * §4.3), so a live game is this card's to show, and this card polls the board.
 */
export function GameWidget({ guildId }: GameWidgetProps) {
  const { settings, status, board, boardError } = useSportsSettings(guildId);
  const enabled = settings?.enabled === true && settings.show_on_server_page === true && status === 'ready';
  useSportsPolling(guildId, enabled);
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
  const pick = stripGames(games);
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
        <Link to={sportsHref(guildId)} className="ix-link">
          All games
        </Link>
      }
    >
      <Link
        to={sportsHref(guildId)}
        aria-label={stripAriaLabel(game)}
        className="ix-game"
        style={{ '--pc-away': away.fill, '--pc-home': home.fill } as CSSProperties}
      >
        {[game.away, game.home].map((team) => (
          <span key={team.id} className="ix-row">
            <TeamMark team={team} />
            <span className="ix-row__name">{team.short_name || team.name}</span>
            {showScore && <span className="ix-row__score">{team.score ?? 0}</span>}
          </span>
        ))}
        <span className="ix-game__status" data-live={live || undefined}>
          {statusLine(game)}
        </span>
      </Link>
    </WidgetCard>
  );
}
