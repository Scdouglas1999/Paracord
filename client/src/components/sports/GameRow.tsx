import { useEffect, useId, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { Star } from 'lucide-react';
import type { SportsGame } from '../../api/sports';
import { Chip } from '../ui';
import { cn } from '../../lib/utils';
import { losingSide, miniFieldBar, teamPaint } from './gamecast';
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
  flashSide = null,
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
  flashSide?: 'home' | 'away' | null;
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
  const field = showSituation && game.sport === 'football' ? miniFieldBar(game) : null;
  const win = showSituation ? winChanceLabel(game) : null;
  const tags = showSituation || game.state === 'pre' ? situationTags(game) : [];
  const clock = statusLine(game, now);
  const card = variant === 'card';
  const hero = card && featured && live;
  const describedBy = useId();
  const awayPaint = teamPaint(game.away, game.home);
  const homePaint = teamPaint(game.home, game.away);
  const flashFill = flashSide === 'away' ? awayPaint.fill : flashSide === 'home' ? homePaint.fill : 'var(--bg-mod-strong)';

  return (
    <Link
      to={gameHref(guildId, game)}
      aria-label={`Open ${stripMatchup(game)}`}
      aria-describedby={describedBy}
      className={cn(
        'pc-focusable block text-text-primary no-underline',
        card ? 'pc-sports-card' : 'pc-sports-row',
        hero && 'is-featured',
        on && 'is-flash',
      )}
      style={{
        '--pc-away': awayPaint.fill,
        '--pc-home': homePaint.fill,
        '--pc-flash': flashFill,
      } as CSSProperties}
    >
      <span className="pc-sports-wash" aria-hidden />
      {hero && <span className="pc-sports-hero-scrim" aria-hidden />}
      <span id={describedBy} className="sr-only">{gameAriaLabel(game, hideScores, now)}</span>
      {on && flashMessage && (
        <p className="sr-only" aria-live="polite">{flashMessage}</p>
      )}

      {hero ? (
        <HeroBand
          game={game}
          hideScores={hideScores}
          clock={clock}
          tags={tags}
          field={field}
          showBaseball={showBaseball}
          awayPaint={awayPaint.fill}
          homePaint={homePaint.fill}
          flashSide={on ? flashSide : null}
          favoriteTeamKeys={favoriteTeamKeys}
        />
      ) : (
        <span className="pc-sports-card-face">
          <span className="flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 truncate text-meta text-text-faint">{game.league}</span>
            <span className="flex shrink-0 items-center gap-1.5">
              {live && <span className="pc-live-dot pc-sports-live" aria-hidden />}
              {live && <span className="text-meta text-light-white">Live</span>}
              <span className="pc-mono text-meta text-text-secondary">{clock}</span>
            </span>
          </span>

          <span className="flex min-w-0 flex-col gap-2">
            <TeamLine
              side="away"
              team={game.away}
              game={game}
              hideScores={hideScores}
              favorite={isFavoriteTeam(game, game.away, favoriteTeamKeys)}
              paint={awayPaint.fill}
              flashScore={live && on && flashSide === 'away'}
            />
            <TeamLine
              side="home"
              team={game.home}
              game={game}
              hideScores={hideScores}
              favorite={isFavoriteTeam(game, game.home, favoriteTeamKeys)}
              paint={homePaint.fill}
              flashScore={live && on && flashSide === 'home'}
            />
          </span>

          <span className="flex min-w-0 flex-col gap-1.5">
            {tags.length > 0 && (
              <span className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <Chip key={tag} size="sm">{tag}</Chip>
                ))}
              </span>
            )}

            {showBaseball && (
              <span className="flex min-w-0 items-center gap-2 text-meta text-text-secondary">
                <MiniDiamond game={game} />
                <span className="pc-mono">{countLabel(game)}</span>
              </span>
            )}

            {field && <MiniField field={field} away={awayPaint.fill} home={homePaint.fill} />}

            {showSituation && game.down_distance && (
              <span className="pc-mono text-meta text-text-secondary">{game.down_distance}</span>
            )}

            {win && game.home_win_pct != null && (
              <span className="flex min-w-0 flex-col gap-1">
                <WinBar game={game} away={awayPaint.fill} home={homePaint.fill} />
                <span className="pc-mono text-meta text-text-muted">{win}</span>
              </span>
            )}

            {showSituation && game.last_play && (
              <span className="pc-sports-play break-words text-meta text-text-faint">{game.last_play}</span>
            )}

            {game.state === 'pre' && (
              <span className="break-words text-meta text-text-muted">
                {game.broadcasts.length > 0 ? `On ${game.broadcasts.slice(0, 4).join(', ')}` : 'No broadcaster listed'}
              </span>
            )}

            {game.state === 'post' && !hideScores && game.last_play && (
              <span className="pc-sports-play break-words text-meta text-text-faint">{game.last_play}</span>
            )}
          </span>
        </span>
      )}
    </Link>
  );
}

function HeroBand({
  game,
  hideScores,
  clock,
  tags,
  field,
  showBaseball,
  awayPaint,
  homePaint,
  flashSide,
  favoriteTeamKeys,
}: {
  game: SportsGame;
  hideScores: boolean;
  clock: string;
  tags: string[];
  field: ReturnType<typeof miniFieldBar>;
  showBaseball: boolean;
  awayPaint: string;
  homePaint: string;
  flashSide: 'home' | 'away' | null;
  favoriteTeamKeys?: ReadonlySet<string>;
}) {
  const situation = hideScores ? null : game.down_distance;
  const homePct = game.home_win_pct == null ? null : Math.round(game.home_win_pct * 100);
  const awayPct = homePct == null ? null : 100 - homePct;
  const showFoot = !hideScores && (field != null || showBaseball || homePct != null);
  const scoreOf = (team: SportsGame['home']) => (hideScores ? '–' : String(team.score ?? 0));
  return (
    <span className="pc-sports-hero">
      <span className="pc-sports-hero-band">
      <span className="pc-sports-hero-kicker">
        <span className="min-w-0 truncate text-meta text-text-faint">{game.league}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="pc-live-dot pc-sports-live" aria-hidden />
          <span className="text-meta text-light-white">Live</span>
          <span className="pc-mono text-meta text-text-secondary">{clock}</span>
        </span>
      </span>
      <HeroSide
        side="away"
        team={game.away}
        game={game}
        hideScores={hideScores}
        paint={awayPaint}
        favorite={isFavoriteTeam(game, game.away, favoriteTeamKeys)}
      />
      <span
        className={cn('pc-sports-hero-score is-away', flashSide === 'away' && 'is-score-flash')}
        style={flashSide === 'away' ? { color: awayPaint } : undefined}
      >
        {scoreOf(game.away)}
      </span>
      <span className="pc-sports-hero-mid">
        <span className="pc-sports-hero-clock">
          <span className="pc-live-dot pc-sports-live" aria-hidden />
          <span className="pc-mono text-meta pc-sports-on-hero">{clock}</span>
        </span>
        {situation && <span className="pc-mono text-meta pc-sports-on-hero">{situation}</span>}
        {tags.length > 0 && (
          <span className="pc-sports-hero-tags">
            {tags.map((tag) => (
              <Chip key={tag} size="sm">{tag}</Chip>
            ))}
          </span>
        )}
      </span>
      <span
        className={cn('pc-sports-hero-score is-home', flashSide === 'home' && 'is-score-flash')}
        style={flashSide === 'home' ? { color: homePaint } : undefined}
      >
        {scoreOf(game.home)}
      </span>
      <HeroSide
        side="home"
        team={game.home}
        game={game}
        hideScores={hideScores}
        paint={homePaint}
        favorite={isFavoriteTeam(game, game.home, favoriteTeamKeys)}
      />
      </span>
      {showFoot && (
        <span className="pc-sports-hero-foot">
          <span className="pc-sports-hero-spot">
            {field && <MiniField field={field} away={awayPaint} home={homePaint} />}
            {showBaseball && (
              <span className="flex min-w-0 items-center gap-2">
                <MiniDiamond game={game} />
                <span className="pc-mono text-meta pc-sports-on-hero">{countLabel(game)}</span>
              </span>
            )}
          </span>
          {awayPct != null && homePct != null && (
            <span className="pc-sports-hero-odds">
              <span className="pc-mono text-meta pc-sports-on-hero">{game.away.abbr} {awayPct}%</span>
              <WinBar game={game} away={awayPaint} home={homePaint} />
              <span className="pc-mono text-meta pc-sports-on-hero">{game.home.abbr} {homePct}%</span>
            </span>
          )}
        </span>
      )}
      {!hideScores && game.last_play && (
        <span className="pc-sports-hero-play pc-sports-play pc-sports-on-hero-dim">{game.last_play}</span>
      )}
    </span>
  );
}

function HeroSide({
  side,
  team,
  game,
  hideScores,
  paint,
  favorite,
}: {
  side: 'home' | 'away';
  team: SportsGame['home'];
  game: SportsGame;
  hideScores: boolean;
  paint: string;
  favorite: boolean;
}) {
  const hasBall = !hideScores && teamHasBall(game, team);
  return (
    <span className={cn('pc-sports-hero-side pc-sports-on-hero', side === 'home' ? 'is-home' : 'is-away')} style={{ '--pc-edge': paint } as CSSProperties}>
      <TeamMark team={team} size="xl" />
      <span className="pc-sports-hero-name pc-sports-on-hero">{teamLabel(team)}</span>
      {!hideScores && team.record && (
        <span className="pc-mono shrink-0 text-meta pc-sports-on-hero-dim">{team.record}</span>
      )}
      {favorite && (
        <Star
          size={14}
          fill="currentColor"
          className="shrink-0 pc-sports-on-hero"
          role="img"
          aria-label="Favorite team"
        />
      )}
      {hasBall && <FootballGlyph />}
    </span>
  );
}

function FootballGlyph() {
  return (
    <svg className="pc-sports-has-ball" width="10" height="10" viewBox="0 0 10 10" role="img" aria-label="has the ball">
      <ellipse cx="5" cy="5" rx="4.15" ry="2.35" transform="rotate(-36 5 5)" fill="currentColor" />
    </svg>
  );
}

function teamHasBall(game: SportsGame, team: SportsGame['home']): boolean {
  if (game.state !== 'in') return false;
  if (game.possession_team_id) return game.possession_team_id === team.id;
  return team.possession;
}

function WinBar({ game, away, home }: { game: SportsGame; away: string; home: string }) {
  const homePct = Math.round((game.home_win_pct ?? 0) * 100);
  const awayPct = 100 - homePct;
  const homeLeads = (game.home_win_pct ?? 0) >= 0.5;
  return (
    <span className="pc-sports-win" aria-hidden>
      <span style={{ width: `${awayPct}%`, background: away, opacity: homeLeads ? 0.45 : 1 }} />
      <span style={{ width: `${homePct}%`, background: home, opacity: homeLeads ? 1 : 0.45 }} />
    </span>
  );
}

function MiniField({
  field,
  away,
  home,
}: {
  field: NonNullable<ReturnType<typeof miniFieldBar>>;
  away: string;
  home: string;
}) {
  const x = (yards: number) => 10 + (Math.min(100, Math.max(0, yards)) / 100) * 100;
  return (
    <svg viewBox="0 0 120 18" preserveAspectRatio="none" className="pc-sports-minifield" role="img" aria-label={field.label}>
      <rect width="120" height="18" rx="2" fill="var(--sports-stadium)" />
      <rect x="10" y="2" width="100" height="14" fill="var(--sports-turf)" />
      <rect x="0" y="2" width="10" height="14" fill={home} />
      <rect x="110" y="2" width="10" height="14" fill={away} />
      {[25, 50, 75].map((yard) => (
        <line key={yard} x1={x(yard)} x2={x(yard)} y1="2" y2="16" stroke="var(--sports-chalk)" strokeWidth="0.6" opacity="0.55" />
      ))}
      {field.firstDown != null && (
        <line x1={x(field.firstDown)} x2={x(field.firstDown)} y1="3" y2="15" stroke="var(--sports-first-down)" strokeWidth="1.4" />
      )}
      <circle cx={x(field.ball)} cy="9" r="2.6" fill="var(--sports-leather)" stroke="var(--sports-chalk)" strokeWidth="0.8" />
    </svg>
  );
}

function MiniDiamond({ game }: { game: SportsGame }) {
  const detail = game.detail.toLowerCase();
  const batting = detail.includes('bot') ? game.home : detail.includes('top') ? game.away : null;
  const other = batting?.id === game.home.id ? game.away : game.home;
  const fill = batting ? teamPaint(batting, other).fill : 'var(--text-primary)';
  const base = (on: boolean | null, points: string) => (
    <polygon points={points} fill={on ? fill : 'none'} stroke={on ? fill : 'var(--text-faint)'} strokeWidth="1.2" />
  );
  return (
    <svg viewBox="0 0 28 22" className="pc-sports-mini-diamond" role="img" aria-label={runnersLabel(game)}>
      {base(game.on_second, '14,2 18,6 14,10 10,6')}
      {base(game.on_third, '6,10 10,14 6,18 2,14')}
      {base(game.on_first, '22,10 26,14 22,18 18,14')}
    </svg>
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
  paint,
  flashScore,
}: {
  side: 'home' | 'away';
  team: SportsGame['home'];
  game: SportsGame;
  hideScores: boolean;
  favorite: boolean;
  paint: string;
  flashScore: boolean;
}) {
  const loser = game.state === 'post' && !hideScores ? losingSide(game) : null;
  const lost = loser === side;
  const won = loser != null && !lost;
  const showScore = game.state !== 'pre';
  const score = hideScores ? '–' : String(team.score ?? 0);
  const hasBall = !hideScores && teamHasBall(game, team);
  return (
    <span className="pc-sports-teamline" style={{ '--pc-edge': paint } as CSSProperties}>
      <TeamMark team={team} size="md" />
      <span className={cn(
        'min-w-0 truncate font-display text-name font-semibold',
        lost && 'is-loser',
        lost ? 'text-text-muted' : 'text-text-primary',
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
      {hasBall && <FootballGlyph />}
      {showScore && (
        <span
          className={cn(
            'pc-sports-score ml-auto shrink-0',
            lost && 'is-loser',
            won && 'is-winner',
            flashScore && 'is-score-flash',
            lost ? 'text-text-muted' : 'text-text-primary',
          )}
          style={flashScore ? { color: paint } : undefined}
          aria-hidden={hideScores || undefined}
        >
          {won && <span className="pc-sports-winner-mark" aria-hidden />}
          {score}
        </span>
      )}
    </span>
  );
}
