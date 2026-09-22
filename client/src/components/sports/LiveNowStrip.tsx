import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { useSportsPolling, useSportsSettings } from '../../hooks/useSportsBoard';
import { teamPaint } from './gamecast';
import {
  HIDE_SCORES_EVENT,
  readHideScores,
  sportsHref,
  statusLine,
  stripAriaLabel,
  stripGames,
  stripMatchup,
} from './model';
import { TeamMark } from './TeamMark';

/**
 * Compact games on the server's front page. Renders nothing when sports is
 * off or the server has not asked for the strip — and does not poll in
 * those cases.
 */
export function LiveNowStrip({ guildId }: { guildId: string }) {
  const { settings, status, board, boardError } = useSportsSettings(guildId);
  const show = settings?.enabled === true && settings.show_on_server_page;
  useSportsPolling(guildId, show);
  const [hideScores, setHideScores] = useState(readHideScores);

  useEffect(() => {
    const sync = () => setHideScores(readHideScores());
    window.addEventListener(HIDE_SCORES_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(HIDE_SCORES_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  if (!show || status !== 'ready') return null;

  const href = sportsHref(guildId);
  const pick = stripGames(board?.games ?? []);
  const heading = pick.kind === 'upcoming' ? 'Up next' : 'Live now';

  return (
    <section aria-label="Sports" className="pc-well flex min-w-0 flex-col gap-2 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-name font-semibold text-text-primary">{heading}</h2>
        <Link to={href} className="pc-focusable text-meta text-text-link">
          All games
        </Link>
      </div>

      {!board && !boardError && (
        <p role="status" className="text-meta text-text-muted">Checking today's games…</p>
      )}
      {boardError && !board && (
        <p role="status" className="text-meta text-text-secondary">{boardError}</p>
      )}
      {boardError && board && (
        <p role="status" className="text-meta text-text-secondary">{boardError}</p>
      )}

      {pick.kind === 'none' && board && !boardError && (
        <p className="text-meta text-text-muted">Nothing live or coming up.</p>
      )}

      {pick.games.length > 0 && (
        <ul className="flex min-w-0 flex-col gap-1">
          {pick.games.map((game) => {
            const live = game.state === 'in';
            const score = hideScores || game.state === 'pre'
              ? null
              : `${game.away.score ?? 0}–${game.home.score ?? 0}`;
            const away = teamPaint(game.away, game.home);
            const home = teamPaint(game.home, game.away);
            return (
              <li key={game.id} className="min-w-0">
                <Link
                  to={href}
                  aria-label={stripAriaLabel(game)}
                  className="pc-sports-strip-link pc-focusable"
                  style={{ '--pc-away': away.fill, '--pc-home': home.fill } as CSSProperties}
                >
                  {live && <span className="pc-live-dot pc-sports-live" aria-hidden />}
                  <TeamMark team={game.away} />
                  <TeamMark team={game.home} />
                  <span className="min-w-0 truncate text-label text-text-primary">
                    {stripMatchup(game)}
                  </span>
                  <span className="pc-mono ml-auto shrink-0 truncate text-meta text-text-secondary">
                    {score ?? statusLine(game)}
                  </span>
                  <span className="pc-sports-strip-line" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
