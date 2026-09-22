import { useEffect, useId, useState, type ReactNode } from 'react';
import type { SportsDefaultView, SportsGame } from '../../api/sports';
import { asDefaultView, asLayout } from '../../api/sports';
import { useSportsPolling, useSportsSettings } from '../../hooks/useSportsBoard';
import { useSportsStore } from '../../stores/sportsStore';
import { Button, Chip, Plate, Switch } from '../ui';
import {
  countStates,
  groupGames,
  hottestLiveId,
  HIDE_SCORES_EVENT,
  leagueFailureCopy,
  readHideScores,
  writeHideScores,
} from './model';
import { GameRow } from './GameRow';

export function SportsBoardView({ guildId, serverName }: { guildId: string; serverName: string }) {
  const { settings, status, error, board, boardError, flashes } = useSportsSettings(guildId);
  const enabled = settings?.enabled === true;
  useSportsPolling(guildId, enabled);

  const [hideScores, setHideScores] = useState(readHideScores);
  const [viewChoice, setViewChoice] = useState<SportsDefaultView | null>(null);
  const [leaguePath, setLeaguePath] = useState<string | null>(null);
  const hideId = useId();

  useEffect(() => {
    const sync = () => setHideScores(readHideScores());
    window.addEventListener(HIDE_SCORES_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(HIDE_SCORES_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const view = viewChoice ?? asDefaultView(settings?.default_view);
  const now = new Date();

  if (!guildId || status === 'idle' || status === 'loading') {
    return (
      <Page serverName={serverName}>
        <p role="status" className="text-label text-text-secondary">Loading scores…</p>
      </Page>
    );
  }

  if (status === 'error') {
    return (
      <Page serverName={serverName}>
        <StatusNote
          message={error || "Sports settings couldn't be loaded."}
          onRetry={() => void useSportsStore.getState().ensureSettings(guildId)}
        />
      </Page>
    );
  }

  if (!enabled) {
    return (
      <Page serverName={serverName}>
        <p className="text-body text-text-secondary">Sports is turned off for this server.</p>
      </Page>
    );
  }

  if (!board && !boardError) {
    return (
      <Page serverName={serverName}>
        <p role="status" className="text-label text-text-secondary">Loading scores…</p>
      </Page>
    );
  }

  const games = board?.games ?? [];
  const leagues = board?.leagues ?? [];
  const leagueGames = leaguePath ? games.filter((game) => game.league_path === leaguePath) : games;
  const counts = countStates(leagueGames);
  const grouped = groupGames(games, { leaguePath, view, hideScores });
  const layout = asLayout(settings?.layout);
  const shown = [...grouped.yours, ...grouped.live, ...grouped.upcoming, ...grouped.final];
  const featuredId = layout === 'cards' ? hottestLiveId(shown) : null;
  const favoriteTeamKeys = new Set(
    (settings?.favorite_teams ?? []).map((team) => `${team.league}:${team.team_id}`),
  );
  const failure = board && !boardError ? leagueFailureCopy(leagues, games) : null;
  const nothing = shown.length === 0;

  return (
    <Page serverName={serverName}>
      <div
        role="group"
        aria-label="Filters"
        className="pc-sports-filters sticky top-0 z-10 -mx-4 flex flex-wrap items-center gap-2 bg-bg-plate px-4 py-3 sm:-mx-6 sm:px-6"
      >
        <p className="pc-mono mr-1 text-meta text-text-muted">
          {counts.live} live · {counts.upcoming} upcoming
        </p>
        <FilterChip pressed={leaguePath === null} label="All leagues" onClick={() => setLeaguePath(null)}>
          All
        </FilterChip>
        {leagues.map((league) => (
          <FilterChip
            key={league.path}
            pressed={leaguePath === league.path}
            label={league.label}
            onClick={() => setLeaguePath(league.path)}
          >
            {league.label}
          </FilterChip>
        ))}
        <FilterChip pressed={view === 'all'} label="All games" onClick={() => setViewChoice('all')}>
          All
        </FilterChip>
        <FilterChip pressed={view === 'live'} label="Live" onClick={() => setViewChoice('live')}>
          Live
        </FilterChip>
        <FilterChip pressed={view === 'favorites'} label="Favorites" onClick={() => setViewChoice('favorites')}>
          Favorites
        </FilterChip>
        <span className="ml-auto flex items-center gap-2">
          <span id={hideId} className="text-label text-text-secondary">Hide scores</span>
          <Switch
            checked={hideScores}
            labelledBy={hideId}
            onChange={(next) => {
              setHideScores(next);
              writeHideScores(next);
            }}
          />
        </span>
      </div>

      {boardError && (
        <StatusNote
          message={boardError}
          onRetry={() => void useSportsStore.getState().refreshBoard(guildId)}
        />
      )}
      {failure && (
        <div role="status" className="pc-well px-4 py-3 text-label text-text-secondary">{failure}</div>
      )}

      {nothing ? (
        <EmptyNote text={emptyCopy(view, leaguePath, leagues, Boolean(failure || boardError))} />
      ) : (
        <div className="pc-sports-board flex flex-col gap-6" data-layout={layout}>
          <GameSection guildId={guildId} title="Your teams" games={grouped.yours} hideScores={hideScores} flashes={flashes} now={now} layout={layout} featuredId={featuredId} favoriteTeamKeys={favoriteTeamKeys} />
          <GameSection guildId={guildId} title="Live" games={grouped.live} hideScores={hideScores} flashes={flashes} now={now} layout={layout} featuredId={featuredId} favoriteTeamKeys={favoriteTeamKeys} />
          <GameSection guildId={guildId} title="Upcoming" games={grouped.upcoming} hideScores={hideScores} flashes={flashes} now={now} layout={layout} featuredId={featuredId} favoriteTeamKeys={favoriteTeamKeys} />
          <GameSection guildId={guildId} title="Final" games={grouped.final} hideScores={hideScores} flashes={flashes} now={now} layout={layout} featuredId={featuredId} favoriteTeamKeys={favoriteTeamKeys} />
        </div>
      )}
    </Page>
  );
}

function EmptyNote({ text }: { text: string | null }) {
  if (!text) return null;
  return <p className="text-body text-text-secondary">{text}</p>;
}

function emptyCopy(
  view: SportsDefaultView,
  leaguePath: string | null,
  leagues: { path: string; label: string }[],
  failed: boolean,
): string | null {
  if (failed) return null;
  if (view === 'live') return 'Nothing is live right now.';
  if (view === 'favorites') return 'No favorite teams are playing today.';
  if (leaguePath) {
    const label = leagues.find((league) => league.path === leaguePath)?.label ?? 'this league';
    return `Nothing scheduled today in ${label}.`;
  }
  return 'Nothing scheduled today in the leagues this server follows.';
}

function GameSection({
  guildId,
  title,
  games,
  hideScores,
  flashes,
  now,
  layout,
  featuredId,
  favoriteTeamKeys,
}: {
  guildId: string;
  title: string;
  games: SportsGame[];
  hideScores: boolean;
  flashes: Record<string, { until: number; message: string }>;
  now: Date;
  layout: 'cards' | 'list';
  featuredId: string | null;
  favoriteTeamKeys: ReadonlySet<string>;
}) {
  if (games.length === 0) return null;
  const nowMs = Date.now();
  const cards = layout === 'cards';
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2">
      <h2 className="text-section text-text-faint">
        {title} · <span className="pc-mono">{games.length}</span>
      </h2>
      <ul className={cards ? 'pc-sports-grid' : 'flex min-w-0 flex-col gap-2'}>
        {games.map((game) => {
          const flash = flashes[game.id];
          const flashing = (flash?.until ?? 0) > nowMs;
          return (
            <li key={game.id} className="min-w-0">
              <GameRow
                guildId={guildId}
                game={game}
                hideScores={hideScores}
                flashing={flashing}
                flashMessage={flash?.message}
                now={now}
                variant={cards ? 'card' : 'list'}
                featured={cards && game.id === featuredId}
                favoriteTeamKeys={favoriteTeamKeys}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function FilterChip({
  pressed,
  label,
  onClick,
  children,
}: {
  pressed: boolean;
  label: string;
  onClick: () => void;
  children: string;
}) {
  return (
    <Chip
      as="button"
      aria-pressed={pressed}
      aria-label={label}
      onClick={onClick}
      className={pressed ? 'bg-bg-mod-strong text-text-primary' : undefined}
    >
      {children}
    </Chip>
  );
}

function StatusNote({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="status" className="pc-well flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <p className="text-label text-text-secondary">{message}</p>
      <Button size="sm" onClick={onRetry}>Try again</Button>
    </div>
  );
}

function Page({ serverName, children }: { serverName: string; children: ReactNode }) {
  return (
    <div className="h-full min-w-0 overflow-x-hidden overflow-y-auto bg-bg-base p-[var(--gutter)]">
      <Plate as="section" aria-label="Sports" bare className="flex min-w-0 flex-col gap-5 px-4 py-5 sm:px-6">
        <header className="flex min-w-0 flex-col gap-1">
          <h1 className="font-display text-heading text-text-primary">Sports</h1>
          {serverName && <p className="truncate text-meta text-text-muted">{serverName}</p>}
        </header>
        {children}
      </Plate>
    </div>
  );
}
