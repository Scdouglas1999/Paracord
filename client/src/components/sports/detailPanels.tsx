import { useState, type CSSProperties } from 'react';
import type {
  BoxScore,
  FootballDrive,
  GameLeader,
  GameProbable,
  LineScore,
  ScoringPlay,
  SportsAthlete,
  SportsGame,
  SportsTeam,
} from '../../api/sports';
import { Chip } from '../ui';
import { cn } from '../../lib/utils';
import { driveChartSpan, driveResultChip, lineScoreLiveColumn, lineScoreWinner, teamPaint } from './gamecast';
import { AthleteMark, TeamMark } from './TeamMark';

export function GameSkeleton({ sport }: { sport: string }) {
  const park = sport === 'baseball';
  return (
    <div className="pc-sports-skeleton" role="status">
      <p className="sr-only">Loading this game…</p>
      <div className="pc-sports-skeleton-bar" />
      <div className={park ? 'pc-sports-skeleton-park' : 'pc-sports-skeleton-field'} aria-hidden>
        <span />
        <span />
      </div>
    </div>
  );
}

export function LineScoreTable({
  line,
  game,
  baseball,
}: {
  line: LineScore;
  game: SportsGame;
  baseball: boolean;
}) {
  const liveCol = lineScoreLiveColumn(game.period, line.periods.length, game.state);
  const winner = lineScoreWinner(line.home.total, line.away.total);
  return (
    <div className="pc-sports-linescore-scroll">
      <table className="pc-sports-linescore">
        <caption className="sr-only">Line score</caption>
        <thead>
          <tr>
            <th scope="col"><span className="sr-only">Team</span></th>
            {line.periods.map((label, index) => (
              <th key={`${label}-${index}`} scope="col" className={index === liveCol ? 'is-live' : undefined}>{label}</th>
            ))}
            {baseball ? (
              <>
                <th scope="col">R</th>
                <th scope="col">H</th>
                <th scope="col">E</th>
              </>
            ) : (
              <th scope="col">T</th>
            )}
          </tr>
        </thead>
        <tbody>
          <LineRow team={game.away} side={line.away} baseball={baseball} liveCol={liveCol} won={winner === 'away'} />
          <LineRow team={game.home} side={line.home} baseball={baseball} liveCol={liveCol} won={winner === 'home'} />
        </tbody>
      </table>
    </div>
  );
}

function LineRow({
  team,
  side,
  baseball,
  liveCol,
  won,
}: {
  team: SportsTeam;
  side: LineScore['home'];
  baseball: boolean;
  liveCol: number;
  won: boolean;
}) {
  return (
    <tr>
      <th scope="row">
        <span className="pc-sports-linescore-team">
          <TeamMark team={team} />
          <span>{team.abbr}</span>
        </span>
      </th>
      {side.periods.map((value, index) => (
        <td key={index} className={index === liveCol ? 'is-live' : undefined}>{value ?? ''}</td>
      ))}
      <td className={cn('is-total', won && 'is-winner')}>{side.total ?? ''}</td>
      {baseball && (
        <>
          <td>{side.hits ?? ''}</td>
          <td>{side.errors ?? ''}</td>
        </>
      )}
    </tr>
  );
}

export function LeadersPanel({ leaders, game }: { leaders: GameLeader[]; game: SportsGame }) {
  const groups = [game.away, game.home]
    .map((team) => ({ team, rows: leaders.filter((row) => row.team_id === team.id).slice(0, 3) }))
    .filter((group) => group.rows.length > 0);
  if (groups.length === 0) return null;
  return (
    <section aria-label="Leaders" className="pc-sports-leaders">
      <h2 className="text-section text-text-faint">Leaders</h2>
      <div className="pc-sports-leaders-grid">
        {groups.map((group) => {
          const paint = teamPaint(group.team, group.team.id === game.home.id ? game.away : game.home);
          return (
            <div key={group.team.id} className="flex min-w-0 flex-col gap-2">
              <p className="text-label text-text-secondary">{group.team.abbr}</p>
              <ul className="flex flex-col gap-2">
                {group.rows.map((row) => (
                  <li
                    key={`${row.team_id}-${row.category}`}
                    className="pc-sports-leader"
                    style={{ '--pc-edge': paint.fill } as CSSProperties}
                  >
                    <AthleteMark athlete={row.athlete} size="lg" />
                    <span className="min-w-0">
                      <span className="block truncate text-label text-text-primary">{row.athlete.short_name || row.athlete.name}</span>
                      <span className="block text-meta text-text-faint">{row.label}</span>
                      <span className="block text-meta text-text-secondary">{row.value}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function StartingPitchers({ probables, game }: { probables: GameProbable[]; game: SportsGame }) {
  if (probables.length === 0) return null;
  return (
    <section aria-label="Starting pitchers" className="pc-sports-leaders">
      <h2 className="text-section text-text-faint">Starting pitchers</h2>
      <div className="pc-sports-leaders-grid">
        {probables.map((arm) => {
          const team = arm.team_id === game.home.id ? game.home : game.away;
          const other = team.id === game.home.id ? game.away : game.home;
          const paint = teamPaint(team, other);
          return (
            <div key={arm.team_id} className="pc-sports-leader" style={{ '--pc-edge': paint.fill } as CSSProperties}>
              <AthleteMark athlete={arm.athlete} size="lg" />
              <span className="min-w-0">
                <span className="block truncate text-label text-text-primary">{arm.athlete.short_name || arm.athlete.name}</span>
                <span className="block truncate text-meta text-text-faint">{arm.athlete.position || arm.role} · {team.abbr}</span>
              </span>
              {arm.note && <span className="pc-mono shrink-0 text-meta text-text-secondary">{arm.note}</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function MatchupPair({
  batter,
  pitcher,
  batting,
  fielding,
}: {
  batter: SportsAthlete | null;
  pitcher: SportsAthlete | null;
  batting: SportsTeam | null;
  fielding: SportsTeam | null;
}) {
  if (!batter && !pitcher) return null;
  return (
    <div className="pc-sports-matchup">
      {batter && <PersonCard label="Now batting" athlete={batter} team={batting} other={fielding} />}
      {pitcher && <PersonCard label="Pitching" athlete={pitcher} team={fielding} other={batting} />}
    </div>
  );
}

function PersonCard({
  label,
  athlete,
  team,
  other,
}: {
  label: string;
  athlete: SportsAthlete;
  team: SportsTeam | null;
  other: SportsTeam | null;
}) {
  const paint = team ? teamPaint(team, other) : { fill: 'var(--sports-endzone)', ink: 'var(--sports-chalk)' };
  return (
    <div className="pc-sports-leader" style={{ '--pc-edge': paint.fill } as CSSProperties}>
      <AthleteMark athlete={athlete} size="lg" />
      <span className="min-w-0">
        <span className="block text-meta text-text-faint">{label}</span>
        <span className="block truncate text-label text-text-primary">{athlete.short_name || athlete.name}</span>
        {athlete.position && <span className="block text-meta text-text-faint">{athlete.position}</span>}
      </span>
    </div>
  );
}

export function BoxScorePanel({
  box,
  game,
  kinds,
}: {
  box: BoxScore;
  game: SportsGame;
  kinds?: readonly string[];
}) {
  const [side, setSide] = useState<'away' | 'home'>('away');
  const tables = ((side === 'away' ? box.away : box.home) ?? []).filter((table) => !kinds || kinds.includes(table.type));
  const team = side === 'away' ? game.away : game.home;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Box score team">
        {(['away', 'home'] as const).map((key) => {
          const club = key === 'away' ? game.away : game.home;
          return (
            <button
              key={key}
              type="button"
              className="pc-focusable"
              aria-pressed={side === key}
              onClick={() => setSide(key)}
            >
              <Chip size="sm">
                <span className="inline-flex items-center gap-1.5">
                  <TeamMark team={club} />
                  {club.abbr}
                </span>
              </Chip>
            </button>
          );
        })}
      </div>
      {tables.length === 0 && (
        <p className="text-label text-text-secondary">No box score for {team.abbr}.</p>
      )}
      {tables.map((table) => (
        <div key={table.type} className="pc-sports-box-scroll">
          <table className="pc-sports-box">
            <caption className="sr-only">{team.abbr} {table.type}</caption>
            <thead>
              <tr>
                <th scope="col">Player</th>
                {table.columns.slice(0, 6).map((column) => (
                  <th key={column} scope="col">{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr key={row.athlete.id}>
                  <th scope="row">
                    <span className="pc-sports-box-player">
                      <AthleteMark athlete={row.athlete} size="sm" />
                      <span className="min-w-0 truncate">{row.athlete.short_name || row.athlete.name}</span>
                      {(row.position || row.athlete.position) && (
                        <span className="text-meta text-text-faint">{row.position || row.athlete.position}</span>
                      )}
                    </span>
                  </th>
                  {row.values.slice(0, 6).map((value, index) => (
                    <td key={table.columns[index] ?? index} className="pc-mono">{value}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

export function DriveChart({
  drives,
  game,
  selectedId,
  onSelect,
  scoringPlays,
  hideScores,
}: {
  drives: FootballDrive[];
  game: SportsGame;
  selectedId: string | null;
  onSelect: (id: string) => void;
  scoringPlays: ScoringPlay[];
  hideScores: boolean;
}) {
  return (
    <ol className="pc-sports-drivechart">
      {drives.map((drive, index) => {
        const span = driveChartSpan(drive.start_yard, drive.end_yard);
        const chip = driveResultChip(drive.result);
        const side = drive.team_id === game.home.id ? game.home : drive.team_id === game.away.id ? game.away : null;
        const other = side?.id === game.home.id ? game.away : game.home;
        const paint = side ? teamPaint(side, other).fill : 'var(--sports-endzone)';
        const abbr = side?.abbr ?? 'Drive';
        const after = hideScores ? null : scoreAfter(drive, scoringPlays);
        const name = `${abbr} ${index + 1}${drive.result ? ` · ${drive.result}` : ''}${drive.live ? ' · Live' : ''}`;
        return (
          <li key={drive.id}>
            <button
              type="button"
              className={cn('pc-focusable pc-sports-driverow', drive.live && 'is-live')}
              aria-pressed={selectedId === drive.id}
              aria-label={name}
              onClick={() => onSelect(drive.id)}
            >
              <span className="pc-sports-driveabbr">{abbr}{drive.live ? ' · Live' : ''}</span>
              <span className="pc-sports-drivefield" aria-hidden>
                <span className="pc-sports-drivecap" style={{ background: teamPaint(game.home, game.away).fill }} />
                <span className="pc-sports-driveturf">
                  {span && (
                    <span
                      className={cn('pc-sports-drivebar', span.pointsRight ? 'is-right' : 'is-left', drive.live && 'is-live')}
                      style={{ left: `${span.x}%`, width: `${span.width}%`, background: paint, color: paint }}
                    />
                  )}
                </span>
                <span className="pc-sports-drivecap" style={{ background: teamPaint(game.away, game.home).fill }} />
              </span>
              {chip && <Chip size="sm">{chip}</Chip>}
              {after && <span className="pc-mono text-meta text-text-secondary">{after}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function scoreAfter(drive: FootballDrive, plays: ScoringPlay[]): string | null {
  const last = drive.plays[drive.plays.length - 1];
  if (!last?.scoring) return null;
  const match = plays.find((play) => play.period === last.period && play.clock === last.clock);
  if (!match || match.away_score == null || match.home_score == null) return null;
  return `${match.away_score}–${match.home_score}`;
}
