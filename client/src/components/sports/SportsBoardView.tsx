import { useEffect, useId, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import type { SportsBoard, SportsDefaultView, SportsGame } from '../../api/sports';
import { asDefaultView, asLayout, sportsApi } from '../../api/sports';
import { useSportsPolling, useSportsSettings } from '../../hooks/useSportsBoard';
import { useSportsStore } from '../../stores/sportsStore';
import { Button, Chip, Plate, Switch } from '../ui';
import { boardDay, boardDayFromParam, emptyDayPhrase, sportsTitle, type BoardDay } from './boardDate';
import {
  countStates,
  groupGames,
  hottestLiveId,
  HIDE_SCORES_EVENT,
  QUIET_POLL_MS,
  leagueFailureCopy,
  readHideScores,
  writeHideScores,
} from './model';
import { GameRow } from './GameRow';

export function SportsBoardView({ guildId, serverName }: { guildId: string; serverName: string }) {
  const { settings, status, error, board, boardError, flashes } = useSportsSettings(guildId);
  const enabled = settings?.enabled === true;
  useSportsPolling(guildId, enabled);
  const [search, setSearch] = useSearchParams();
  const day = boardDayFromParam(search.get('date'));
  const viewingToday = day.offset === 0;
  const [dated, setDated] = useState<{ iso: string; board: SportsBoard | null; error: string | null } | null>(null);
  const [datedAttempt, setDatedAttempt] = useState(0);

  const [hideScores, setHideScores] = useState(readHideScores);
  const [viewChoice, setViewChoice] = useState<SportsDefaultView | null>(null);
  const [leaguePath, setLeaguePath] = useState<string | null>(null);
  const hideId = useId();

  useEffect(() => {
    if (!enabled || viewingToday || !guildId) return;
    let stopped = false;
    const load = () => {
      if (document.hidden) return;
      void sportsApi.getBoard(guildId, day.compact).then((res) => {
        if (!stopped) setDated({ iso: day.iso, board: res.data, error: null });
      }).catch(() => {
        if (!stopped) {
          setDated({
            iso: day.iso,
            board: null,
            error: "Scores couldn't be loaded. Try again in a moment.",
          });
        }
      });
    };
    load();
    const timer = window.setInterval(load, QUIET_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [enabled, viewingToday, guildId, day.iso, day.compact, datedAttempt]);

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
  const title = sportsTitle(day);
  const pickDay = (next: BoardDay) => {
    const params = new URLSearchParams(search);
    if (next.offset === 0) params.delete('date');
    else params.set('date', next.iso);
    setSearch(params, { replace: true });
  };

  if (!guildId || status === 'idle' || status === 'loading') {
    return (
      <Page serverName={serverName} title={title}>
        <p role="status" className="text-label text-text-secondary">Loading scores…</p>
      </Page>
    );
  }

  if (status === 'error') {
    return (
      <Page serverName={serverName} title={title}>
        <StatusNote
          message={error || "Sports settings couldn't be loaded."}
          onRetry={() => void useSportsStore.getState().ensureSettings(guildId)}
        />
      </Page>
    );
  }

  if (!enabled) {
    return (
      <Page serverName={serverName} title="Sports">
        <p className="text-body text-text-secondary">Sports is turned off for this server.</p>
      </Page>
    );
  }

  const shownBoard = viewingToday ? board : (dated?.iso === day.iso ? dated.board : null);
  const shownError = viewingToday ? boardError : (dated?.iso === day.iso ? dated.error : null);
  if (!shownBoard && !shownError) {
    return (
      <Page serverName={serverName} title={title}>
        <DateBar day={day} onPick={pickDay} />
        <p role="status" className="text-label text-text-secondary">Loading scores…</p>
      </Page>
    );
  }

  const games = shownBoard?.games ?? [];
  const leagues = shownBoard?.leagues ?? (board?.leagues ?? []);
  const leagueGames = leaguePath ? games.filter((game) => game.league_path === leaguePath) : games;
  const counts = countStates(leagueGames);
  const grouped = groupGames(games, { leaguePath, view, hideScores });
  const layout = asLayout(settings?.layout);
  const shown = [...grouped.yours, ...grouped.live, ...grouped.upcoming, ...grouped.final];
  const featuredId = layout === 'cards' ? hottestLiveId(shown) : null;
  const favoriteTeamKeys = new Set(
    (settings?.favorite_teams ?? []).map((team) => `${team.league}:${team.team_id}`),
  );
  const failure = shownBoard && !shownError ? leagueFailureCopy(leagues, games) : null;
  const nothing = shown.length === 0;
  const phrase = emptyDayPhrase(day);

  return (
    <Page serverName={serverName} title={title}>
      <DateBar day={day} onPick={pickDay} />
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

      {shownError && (
        <StatusNote
          message={shownError}
          onRetry={() => {
            if (viewingToday) void useSportsStore.getState().refreshBoard(guildId);
            else {
              setDated(null);
              setDatedAttempt((n) => n + 1);
            }
          }}
        />
      )}
      {failure && (
        <div role="status" className="pc-well px-4 py-3 text-label text-text-secondary">{failure}</div>
      )}

      {nothing ? (
        <EmptyNote text={emptyCopy(view, leaguePath, leagues, Boolean(failure || shownError), phrase)} />
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

function DateBar({ day, onPick }: { day: BoardDay; onPick: (day: BoardDay) => void }) {
  const today = boardDay(0);
  const min = boardDay(-14).iso;
  const max = boardDay(14).iso;
  return (
    <div role="group" aria-label="Date" className="flex flex-wrap items-center gap-2">
      {([-1, 0, 1] as const).map((offset) => {
        const choice = boardDay(offset);
        return (
          <Chip
            key={choice.label}
            as="button"
            aria-pressed={day.offset === offset}
            onClick={() => onPick(choice)}
          >
            {choice.label}
          </Chip>
        );
      })}
      <input
        type="date"
        className="pc-sports-date pc-focusable"
        aria-label="Date"
        min={min}
        max={max}
        value={day.offset === 0 ? today.iso : day.iso}
        onChange={(event) => {
          const next = boardDayFromParam(event.target.value);
          if (event.target.value && next.offset === 0 && event.target.value !== today.iso) return;
          onPick(next);
        }}
      />
    </div>
  );
}

function EmptyNote({ text }: { text: string | null }) {
  if (!text) return null;
  const quiet = text.startsWith('No games') || text.startsWith('No favorite teams');
  return (
    <div className="pc-sports-empty">
      {quiet && <EmptyMark />}
      <p className="text-body text-text-secondary">{text}</p>
    </div>
  );
}

function EmptyMark() {
  return (
    <svg className="pc-sports-empty-mark" viewBox="0 0 72 40" width="72" height="40" aria-hidden>
      <path d="M6 32 Q36 6 66 32" fill="none" stroke="var(--sports-turf)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="36" cy="22" r="5" fill="var(--sports-leather)" />
      <path d="M36 18.2 V25.8 M32.4 22 H39.6" stroke="var(--sports-lace)" strokeWidth="0.8" />
    </svg>
  );
}

function emptyCopy(
  view: SportsDefaultView,
  leaguePath: string | null,
  leagues: { path: string; label: string }[],
  failed: boolean,
  phrase: string,
): string | null {
  if (failed) return null;
  if (view === 'live') return 'Nothing is live right now.';
  if (view === 'favorites') return `No favorite teams are playing ${phrase}.`;
  if (leaguePath) {
    const label = leagues.find((league) => league.path === leaguePath)?.label ?? 'this league';
    return `Nothing scheduled ${phrase} in ${label}.`;
  }
  return `No games ${phrase}`;
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
  flashes: Record<string, { until: number; message: string; side: 'home' | 'away' | null; chip: string | null }>;
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
                flashSide={flash?.side ?? null}
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

function Page({ serverName, title = 'Sports', children }: { serverName: string; title?: string; children: ReactNode }) {
  return (
    <div className="h-full min-w-0 overflow-x-hidden overflow-y-auto bg-bg-base p-[var(--gutter)]">
      <Plate as="section" aria-label="Sports" bare className="flex min-w-0 flex-col gap-5 px-4 py-5 sm:px-6">
        <header className="flex min-w-0 flex-col gap-1">
          <h1 className="font-display text-heading text-text-primary">{title}</h1>
          {serverName && <p className="truncate text-meta text-text-muted">{serverName}</p>}
        </header>
        {children}
      </Plate>
    </div>
  );
}
