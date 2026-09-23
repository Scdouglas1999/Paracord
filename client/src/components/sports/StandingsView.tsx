import { useEffect, useState } from 'react';
import { extractApiError } from '../../api/client';
import type { LeagueStandings, StandingsGroup } from '../../api/sports';
import { sportsApi } from '../../api/sports';
import { Button, Chip } from '../ui';
import { TeamMark } from './TeamMark';

type Loaded = { league: string; table: LeagueStandings | null; error: string | null };

/**
 * One league's table at a time. Standings move once a game ends, so a table is
 * fetched when its league is picked and kept for the visit.
 */
export function StandingsView({
  guildId,
  leagues,
  labelFor,
  initialLeague,
}: {
  guildId: string;
  leagues: string[];
  labelFor: (path: string) => string;
  initialLeague: string | null;
}) {
  const [picked, setPicked] = useState<string | null>(initialLeague);
  const league = picked && leagues.includes(picked) ? picked : leagues[0] ?? null;
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [attempt, setAttempt] = useState(0);
  const current = league ? loaded[league] : undefined;

  useEffect(() => {
    if (!league || loaded[league]?.table) return;
    let stopped = false;
    void sportsApi.getStandings(guildId, league).then((res) => {
      if (!stopped) setLoaded((prev) => ({ ...prev, [league]: { league, table: res.data, error: null } }));
    }).catch((err: unknown) => {
      if (stopped) return;
      const message = extractApiError(err);
      setLoaded((prev) => ({
        ...prev,
        [league]: {
          league,
          table: null,
          error: message === 'An unexpected error occurred'
            ? `Standings for ${labelFor(league)} couldn't be loaded.`
            : message,
        },
      }));
    });
    return () => {
      stopped = true;
    };
    // `loaded` is read, not watched: a stored table ends the effect's work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId, league, attempt]);

  if (!league) {
    return <p className="text-body text-text-secondary">This server doesn't follow any leagues.</p>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {leagues.length > 1 && (
        <div role="group" aria-label="League" className="flex flex-wrap items-center gap-2">
          {leagues.map((path) => (
            <Chip
              key={path}
              as="button"
              aria-pressed={path === league}
              onClick={() => setPicked(path)}
              className={path === league ? 'bg-bg-mod-strong text-text-primary' : undefined}
            >
              {labelFor(path)}
            </Chip>
          ))}
        </div>
      )}

      {!current && <p role="status" className="text-label text-text-secondary">Loading standings…</p>}
      {current?.error && (
        <div role="status" className="pc-well flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <p className="text-label text-text-secondary">{current.error}</p>
          <Button
            size="sm"
            onClick={() => {
              setLoaded((prev) => {
                const next = { ...prev };
                delete next[league];
                return next;
              });
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </div>
      )}
      {current?.table && <LeagueTable table={current.table} />}
    </div>
  );
}

function LeagueTable({ table }: { table: LeagueStandings }) {
  if (table.groups.length === 0) {
    return <p className="text-body text-text-secondary">No standings for {table.label} yet.</p>;
  }
  const single = table.groups.length === 1 && !table.groups[0].parent;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <p className="pc-mono text-meta text-text-muted">
        {table.season ? `${table.label} ${table.season}` : table.label}
        {table.stale && ' · showing the last standings we got'}
      </p>
      {table.groups.map((group, index) => {
        const parentHeading = group.parent && group.parent !== table.groups[index - 1]?.parent ? group.parent : null;
        return (
          <section key={`${group.parent ?? ''}/${group.name}`} aria-label={group.name} className="flex min-w-0 flex-col gap-2">
            {parentHeading && <h2 className="pc-sports-standings-parent text-label text-text-secondary">{parentHeading}</h2>}
            {!single && <h3 className="text-section text-text-faint">{group.name}</h3>}
            <GroupTable group={group} table={table} />
          </section>
        );
      })}
    </div>
  );
}

function GroupTable({ group, table }: { group: StandingsGroup; table: LeagueStandings }) {
  return (
    <div className="pc-sports-standings-scroll">
      <table className="pc-sports-standings">
        <caption className="sr-only">{group.name} standings</caption>
        <thead>
          <tr>
            <th scope="col" className="pc-sports-standings-rank"><abbr title="Place">#</abbr></th>
            <th scope="col" className="pc-sports-standings-team">Team</th>
            {table.columns.map((column) => (
              <th key={column.key} scope="col"><abbr title={column.title}>{column.label}</abbr></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {group.rows.map((row, index) => (
            <tr key={row.team.id} className={row.favorite ? 'is-favorite' : undefined}>
              <td className="pc-sports-standings-rank pc-mono">{index + 1}</td>
              <th scope="row" className="pc-sports-standings-team">
                <span className="flex items-center gap-2">
                  <TeamMark team={row.team} />
                  <span className="pc-sports-standings-name truncate">{row.team.short_name || row.team.name}</span>
                  <span className="pc-sports-standings-abbr pc-mono">{row.team.abbr}</span>
                  {row.clincher && (
                    <span className="pc-mono text-meta text-text-muted" title="Clinch mark">{row.clincher}</span>
                  )}
                  {row.favorite && <span className="sr-only">, favorite</span>}
                </span>
              </th>
              {row.values.map((value, column) => (
                <td key={table.columns[column]?.key ?? column} className="pc-mono">{value || '–'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
