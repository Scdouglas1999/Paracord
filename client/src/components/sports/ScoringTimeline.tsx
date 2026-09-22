import type { ScoringPlay, SportsGame } from '../../api/sports';
import { Chip } from '../ui';
import { progressionCeiling, progressionPoints, progressionText, progressionTicks, scoringGroups, stepCorners } from './timeline';
import { teamPaint } from './gamecast';
import { TeamMark } from './TeamMark';

export function ScoringTimeline({
  plays,
  game,
  sport,
  hideScores,
}: {
  plays: ScoringPlay[];
  game: SportsGame;
  sport: string;
  hideScores: boolean;
}) {
  const groups = scoringGroups(plays, sport);
  const points = progressionPoints(plays);
  const caption = progressionText(points, game.away.abbr, game.home.abbr);
  const awayPaint = teamPaint(game.away, game.home).fill;
  const homePaint = teamPaint(game.home, game.away).fill;
  if (groups.length === 0) {
    return <p className="text-label text-text-secondary">No scoring plays.</p>;
  }
  return (
    <div className="pc-sports-scoring-layout">
      {!hideScores && points.length > 1 && (
        <ProgressionChart points={points} caption={caption} away={awayPaint} home={homePaint} awayAbbr={game.away.abbr} homeAbbr={game.home.abbr} sport={sport} />
      )}
      <div>
        {groups.map((group) => (
          <section key={`${group.period ?? 'x'}-${group.label}`} className="mb-3">
            <h3 className="text-section text-text-faint">{group.label}</h3>
            <ol className="pc-sports-timeline">
              {group.plays.map((node, index) => {
                const play = node.play;
                const side = play.team_id === game.away.id ? game.away : play.team_id === game.home.id ? game.home : null;
                const scoring = play.team_id === game.away.id ? 'away' : play.team_id === game.home.id ? 'home' : null;
                return (
                  <li key={`${play.text}-${play.clock ?? index}`}>
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      {side && <TeamMark team={side} />}
                      {play.clock && <span className="pc-mono text-meta text-text-faint">{play.clock}</span>}
                      <span className="min-w-0 text-label text-text-secondary">{play.text}</span>
                      {!hideScores && play.away_score != null && play.home_score != null && (
                        <span className="pc-mono text-meta text-text-secondary">
                          <span style={scoring === 'away' ? { color: awayPaint } : undefined}>{play.away_score}</span>
                          –
                          <span style={scoring === 'home' ? { color: homePaint } : undefined}>{play.home_score}</span>
                        </span>
                      )}
                      {node.leadChange && <Chip size="sm">Lead change</Chip>}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}

function ProgressionChart({
  points,
  caption,
  away,
  home,
  awayAbbr,
  homeAbbr,
  sport,
}: {
  points: { index: number; home: number; away: number; period: number | null }[];
  caption: string;
  away: string;
  home: string;
  awayAbbr: string;
  homeAbbr: string;
  sport: string;
}) {
  const width = 640;
  const height = 120;
  const left = 8;
  const right = 12;
  const top = 8;
  const bottom = 4;
  const ceiling = Math.max(1, progressionCeiling(points));
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const last = Math.max(1, points.length - 1);
  const xOf = (index: number) => left + (index / last) * plotW;
  const yOf = (value: number) => top + (1 - value / ceiling) * plotH;
  const line = (key: 'home' | 'away') => stepCorners(points.map((point) => ({ index: point.index, value: point[key] })))
    .map((corner) => `${xOf(corner.index)},${yOf(corner.value)}`)
    .join(' ');
  const ticks = progressionTicks(points, sport);
  return (
    <figure className="min-w-0" aria-label="Score progression">
      <figcaption className="text-section text-text-faint">Score progression</figcaption>
      <div className="mb-1 flex flex-wrap gap-3 text-meta text-text-secondary">
        <span className="inline-flex items-center gap-1.5"><span className="pc-sports-linekey" style={{ background: away }} aria-hidden />{awayAbbr}</span>
        <span className="inline-flex items-center gap-1.5"><span className="pc-sports-linekey" style={{ background: home }} aria-hidden />{homeAbbr}</span>
      </div>
      <div className="pc-sports-chart">
        <div className="pc-sports-chart-y" aria-hidden>
          <span>{ceiling}</span>
          <span>0</span>
        </div>
        <div className="pc-sports-chart-plot">
          <svg viewBox={`0 0 ${width} ${height}`} className="pc-sports-chart-svg" preserveAspectRatio="none" role="img" aria-label={caption}>
            <line x1={left} y1={yOf(0)} x2={width - right} y2={yOf(0)} stroke="var(--border-subtle)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <polyline fill="none" stroke={away} strokeWidth="2" vectorEffect="non-scaling-stroke" points={line('away')} />
            <polyline fill="none" stroke={home} strokeWidth="2" vectorEffect="non-scaling-stroke" points={line('home')} />
          </svg>
          <div className="pc-sports-chart-x" aria-hidden>
            {ticks.map((tick) => {
              const pct = (xOf(tick.index) / width) * 100;
              const shift = pct > 88 ? 'translateX(-100%)' : pct < 12 ? 'translateX(0)' : 'translateX(-50%)';
              return (
                <span key={`${tick.label}-${tick.index}`} style={{ left: `${pct}%`, transform: shift }}>{tick.label}</span>
              );
            })}
          </div>
        </div>
      </div>
      <p className="text-meta text-text-muted">{caption}</p>
    </figure>
  );
}
