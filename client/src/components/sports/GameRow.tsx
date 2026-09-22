import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { Star } from 'lucide-react';
import type { SportsGame } from '../../api/sports';
import { Chip } from '../ui';
import { cn } from '../../lib/utils';
import { losingSide } from './gamecast';
import { TeamMark } from './TeamMark';
import {
  SCORE_FLASH_MS,
  countLabel,
  gameAriaLabel,
  gameHref,
  runnersLabel,
  situationTags,
  statusLine,
  stripMatchup,
  teamLabel,
  winChanceLabel,
} from './model';

export function GameRow({
  guildId,
  game,
  hideScores,
  flashing,
  flashMessage,
  now,
  variant = 'list',
  featured = false,
  favoriteTeamKeys,
}: {
  guildId: string;
  game: SportsGame;
  hideScores: boolean;
  flashing: boolean;
  flashMessage?: string;
  now?: Date;
  variant?: 'list' | 'card';
  featured?: boolean;
  favoriteTeamKeys?: ReadonlySet<string>;
}) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!flashing || hideScores) {
      setOn(false);
      return;
    }
    setOn(true);
    const id = window.setTimeout(() => setOn(false), SCORE_FLASH_MS);
    return () => window.clearTimeout(id);
  }, [flashing, hideScores, game.id, flashMessage]);

  const live = game.state === 'in';
  const showSituation = live && !hideScores;
  const showBaseball = showSituation && game.sport === 'baseball' && game.outs != null;
  const win = showSituation ? winChanceLabel(game) : null;
  const tags = showSituation || game.state === 'pre' ? situationTags(game) : [];
  const clock = statusLine(game, now);
  const card = variant === 'card';
  const describedBy = useId();

  return (
    <Link
      to={gameHref(guildId, game)}
      aria-label={`Open ${stripMatchup(game)}`}
      aria-describedby={describedBy}
      className={cn(
        'pc-focusable block text-text-primary no-underline',
        card ? 'pc-sports-card' : 'pc-sports-row',
        card && featured && 'is-featured',
        on && 'is-flash',
      )}
    >
      <span id={describedBy} className="sr-only">{gameAriaLabel(game, hideScores, now)}</span>
      {on && flashMessage && (
        <p className="sr-only" aria-live="polite">{flashMessage}</p>
      )}

      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate text-meta text-text-faint">{game.league}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {live && <span className="pc-live-dot" aria-hidden />}
          {live && <span className="text-meta text-light-white">Live</span>}
          <span className="pc-mono text-meta text-text-secondary">{clock}</span>
        </span>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <TeamLine
          side="away"
          team={game.away}
          game={game}
          hideScores={hideScores}
          favorite={isFavoriteTeam(game, game.away, favoriteTeamKeys)}
        />
        <TeamLine
          side="home"
          team={game.home}
          game={game}
          hideScores={hideScores}
          favorite={isFavoriteTeam(game, game.home, favoriteTeamKeys)}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <Chip key={tag} size="sm">{tag}</Chip>
            ))}
          </div>
        )}

        {showBaseball && (
          <div className="flex min-w-0 items-center gap-2 text-meta text-text-secondary">
            <span className="pc-sports-diamond" role="img" aria-label={runnersLabel(game)}>
              <span className={cn('pc-sports-base is-second', game.on_second && 'is-on')} />
              <span className={cn('pc-sports-base is-third', game.on_third && 'is-on')} />
              <span className={cn('pc-sports-base is-first', game.on_first && 'is-on')} />
            </span>
            <span className="pc-mono">{countLabel(game)}</span>
          </div>
        )}

        {showSituation && game.down_distance && (
          <p className="pc-mono text-meta text-text-secondary">{game.down_distance}</p>
        )}

        {win && game.home_win_pct != null && (
          <div className="flex min-w-0 flex-col gap-1">
            <div className="pc-sports-win" aria-hidden>
              <span
                className={cn(game.home_win_pct < 0.5 && 'is-lead')}
                style={{ width: `${Math.round((1 - game.home_win_pct) * 100)}%` }}
              />
              <span
                className={cn(game.home_win_pct >= 0.5 && 'is-lead')}
                style={{ width: `${Math.round(game.home_win_pct * 100)}%` }}
              />
            </div>
            <p className="pc-mono text-meta text-text-muted">{win}</p>
          </div>
        )}

        {showSituation && game.last_play && (
          <p className="pc-sports-play break-words text-meta text-text-faint">{game.last_play}</p>
        )}

        {game.state === 'pre' && (
          <p className="break-words text-meta text-text-muted">
            {game.broadcasts.length > 0 ? `On ${game.broadcasts.slice(0, 4).join(', ')}` : 'No broadcaster listed'}
          </p>
        )}

        {game.state === 'post' && !hideScores && game.last_play && (
          <p className="pc-sports-play break-words text-meta text-text-faint">{game.last_play}</p>
        )}
      </div>
    </Link>
  );
}

function isFavoriteTeam(
  game: SportsGame,
  team: SportsGame['home'],
  keys: ReadonlySet<string> | undefined,
): boolean {
  return keys?.has(`${game.league_path}:${team.id}`) === true;
}

function TeamLine({
  side,
  team,
  game,
  hideScores,
  favorite,
}: {
  side: 'home' | 'away';
  team: SportsGame['home'];
  game: SportsGame;
  hideScores: boolean;
  favorite: boolean;
}) {
  const loser = game.state === 'post' && !hideScores ? losingSide(game) : null;
  const lost = loser === side;
  const won = loser != null && !lost;
  const showScore = game.state !== 'pre';
  const score = hideScores ? '–' : String(team.score ?? 0);
  const hasBall = game.state === 'in' && !hideScores && team.possession;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <TeamMark team={team} />
      <span className={cn(
        'min-w-0 truncate font-display text-name font-semibold',
        lost ? 'is-loser text-text-muted' : 'text-text-primary',
      )}>
        {teamLabel(team)}
      </span>
      {favorite && (
        <Star
          size={14}
          fill="currentColor"
          className="shrink-0 text-text-secondary"
          role="img"
          aria-label="Favorite team"
        />
      )}
      {!hideScores && team.record && (
        <span className="pc-mono shrink-0 text-meta text-text-faint">{team.record}</span>
      )}
      {hasBall && (
        <span className="pc-sports-ball" title="Has the ball">
          <span className="sr-only">Has the ball</span>
        </span>
      )}
      {showScore && (
        <span
          className={cn(
            'pc-sports-score pc-mono ml-auto shrink-0 text-label',
            lost && 'is-loser text-text-muted',
            won && 'is-winner text-text-primary',
            !lost && !won && 'text-text-primary',
          )}
          aria-hidden={hideScores || undefined}
        >
          {won && <span className="pc-sports-winner-mark" aria-hidden />}
          {score}
        </span>
      )}
    </div>
  );
}
