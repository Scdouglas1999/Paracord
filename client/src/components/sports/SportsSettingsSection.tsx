import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import {
  FAVORITE_MAX,
  LEAGUE_MAX,
  asDefaultView,
  asLayout,
  leaguePathError,
  sportsApi,
  type LeagueCatalogEntry,
  type SportsDefaultView,
  type SportsFavoriteTeam,
  type SportsLayout,
  type SportsRosterTeam,
  type SportsSettings,
  type SportsSettingsUpdate,
} from '../../api/sports';
import { extractApiError } from '../../api/client';
import { useSportsStore } from '../../stores/sportsStore';
import { confirm } from '../../stores/confirmStore';
import { toast } from '../../stores/toastStore';
import {
  Button,
  Chip,
  ErrorBanner,
  IconButton,
  Input,
  LoadingSpinner,
  Select,
  Well,
} from '../ui';
import { FieldLabel, GroupLabel, ToggleRow } from '../guild/SettingsPrimitives';

/**
 * The Sports add-on's page in Server settings → Add-ons (the hub lists it from
 * `components/addons/registry.ts`). It opens with its own card: add it to the
 * server or remove it, then the leagues and teams.
 */
function draftKey(draft: {
  leagues: string[];
  favorites: SportsFavoriteTeam[];
  showOnPage: boolean;
  scoreAlerts: boolean;
  defaultView: SportsDefaultView;
  layout: SportsLayout;
}): string {
  return JSON.stringify(draft);
}

const ADDONS = [
  {
    id: 'sports',
    name: 'Sports',
    description: 'A scoreboard for the leagues your server follows. Adds a Sports page to the sidebar.',
  },
] as const;

export function SportsSettingsSection({ guildId }: { guildId: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<LeagueCatalogEntry[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [leagues, setLeagues] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<SportsFavoriteTeam[]>([]);
  const [showOnPage, setShowOnPage] = useState(true);
  const [scoreAlerts, setScoreAlerts] = useState(false);
  const [defaultView, setDefaultView] = useState<SportsDefaultView>('all');
  const [layout, setLayout] = useState<SportsLayout>('cards');
  const [customOpen, setCustomOpen] = useState(false);
  const [customPath, setCustomPath] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [openLeague, setOpenLeague] = useState<string | null>(null);
  const [rosterQuery, setRosterQuery] = useState('');
  const [rosters, setRosters] = useState<Record<string, SportsRosterTeam[]>>({});
  const [rosterErrors, setRosterErrors] = useState<Record<string, string>>({});
  const [rosterLoading, setRosterLoading] = useState<string | null>(null);

  const applySettings = useCallback((settings: SportsSettings) => {
    const nextLeagues = settings.leagues ?? [];
    const nextFavorites = settings.favorite_teams ?? [];
    const nextShow = settings.show_on_server_page;
    const nextAlerts = settings.score_alerts === true;
    const nextView = asDefaultView(settings.default_view);
    const nextLayout = asLayout(settings.layout);
    setEnabled(settings.enabled);
    setLeagues(nextLeagues);
    setFavorites(nextFavorites);
    setShowOnPage(nextShow);
    setScoreAlerts(nextAlerts);
    setDefaultView(nextView);
    setLayout(nextLayout);
    setBaseline(draftKey({
      leagues: nextLeagues,
      favorites: nextFavorites,
      showOnPage: nextShow,
      scoreAlerts: nextAlerts,
      defaultView: nextView,
      layout: nextLayout,
    }));
  }, []);

  useEffect(() => {
    const gate = { cancelled: false };
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [, leaguesRes] = await Promise.all([
          useSportsStore.getState().ensureSettings(guildId),
          sportsApi.listLeagues().catch((err: unknown) => {
            if (!gate.cancelled) setCatalogError(extractApiError(err));
            return null;
          }),
        ]);
        if (gate.cancelled) return;
        if (leaguesRes) setCatalog(leaguesRes.data.leagues ?? []);
        const current = useSportsStore.getState().byGuild[guildId];
        if (!current?.settings || current.settingsStatus !== 'ready') {
          setError(current?.settingsError || "Sports settings couldn't be loaded.");
          return;
        }
        applySettings(current.settings);
      } catch (err) {
        if (!gate.cancelled) setError(extractApiError(err));
      } finally {
        if (!gate.cancelled) setLoading(false);
      }
    })();
    return () => {
      gate.cancelled = true;
    };
  }, [guildId, applySettings]);


  const dirty = baseline != null && baseline !== draftKey({
    leagues,
    favorites,
    showOnPage,
    scoreAlerts,
    defaultView,
    layout,
  });

  const labelFor = (path: string) => catalog.find((entry) => entry.path === path)?.label ?? path;
  const remaining = useMemo(
    () => catalog.filter((entry) => !leagues.includes(entry.path)),
    [catalog, leagues],
  );
  const favoriteKeys = new Set(favorites.map((team) => `${team.league}:${team.team_id}`));

  const move = (index: number, dir: -1 | 1) => {
    setLeagues((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = prev.slice();
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  };

  const addLeague = (path: string) => {
    setCustomError(null);
    if (leagues.includes(path)) {
      setCustomError('That league is already on the list.');
      return;
    }
    if (leagues.length >= LEAGUE_MAX) {
      setCustomError('You can follow at most 12 leagues.');
      return;
    }
    setLeagues((prev) => [...prev, path]);
  };

  const addCustom = () => {
    const message = leaguePathError(customPath);
    if (message) {
      setCustomError(message);
      return;
    }
    addLeague(customPath.trim());
    if (!leaguePathError(customPath) && !leagues.includes(customPath.trim()) && leagues.length < LEAGUE_MAX) {
      setCustomPath('');
    }
  };

  const removeLeague = (path: string) => {
    setLeagues((prev) => prev.filter((item) => item !== path));
    setFavorites((prev) => prev.filter((team) => team.league !== path));
    if (openLeague === path) setOpenLeague(null);
  };

  const addFavorite = (team: SportsFavoriteTeam) => {
    if (favorites.length >= FAVORITE_MAX) {
      setError('You can mark at most 24 favorite teams.');
      return;
    }
    setFavorites((prev) => [...prev, team]);
  };

  const openPicker = async (path: string) => {
    if (openLeague === path) {
      setOpenLeague(null);
      return;
    }
    setOpenLeague(path);
    setRosterQuery('');
    if (rosters[path]) return;
    setRosterLoading(path);
    try {
      const res = await sportsApi.listTeams(path);
      setRosters((prev) => ({ ...prev, [path]: res.data.teams ?? [] }));
      setRosterErrors((prev) => {
        const next = { ...prev };
        delete next[path];
        return next;
      });
    } catch (err) {
      const message = extractApiError(err);
      const label = labelFor(path);
      setRosterErrors((prev) => ({
        ...prev,
        [path]: message === 'An unexpected error occurred'
          ? `Teams for ${label} couldn't be loaded.`
          : message,
      }));
    } finally {
      setRosterLoading((current) => (current === path ? null : current));
    }
  };

  const onAdd = async () => {
    setError(null);
    setAdding(true);
    try {
      const res = await sportsApi.updateSettings(guildId, { enabled: true });
      applySettings(res.data);
      useSportsStore.getState().adoptSettings(res.data);
      toast.success('Sports added to this server.');
    } catch (err) {
      setError(extractApiError(err));
    } finally {
      setAdding(false);
    }
  };

  const onRemove = async () => {
    const ok = await confirm({
      title: 'Remove Sports from this server?',
      description: 'The Sports page leaves the sidebar. Leagues and favorite teams stay saved, so you can add it again later.',
      confirmLabel: 'Remove from server',
      cancelLabel: 'Cancel',
      variant: 'danger',
    });
    if (!ok) return;
    setError(null);
    setRemoving(true);
    try {
      const res = await sportsApi.updateSettings(guildId, { enabled: false });
      applySettings(res.data);
      useSportsStore.getState().adoptSettings(res.data);
      toast.success('Sports removed from this server.');
    } catch (err) {
      setError(extractApiError(err));
    } finally {
      setRemoving(false);
    }
  };

  const onSave = async () => {
    setError(null);
    if (leagues.length < 1) {
      setError('Pick at least one league.');
      return;
    }
    if (leagues.length > LEAGUE_MAX) {
      setError('You can follow at most 12 leagues.');
      return;
    }
    if (favorites.length > FAVORITE_MAX) {
      setError('You can mark at most 24 favorite teams.');
      return;
    }
    for (const path of leagues) {
      const message = leaguePathError(path);
      if (message) {
        setError(message);
        return;
      }
    }
    const body: SportsSettingsUpdate = {
      enabled: true,
      show_on_server_page: showOnPage,
      score_alerts: scoreAlerts,
      default_view: defaultView,
      layout,
      favorite_teams: favorites,
      leagues,
    };
    setSaving(true);
    try {
      const res = await sportsApi.updateSettings(guildId, body);
      applySettings(res.data);
      useSportsStore.getState().adoptSettings(res.data);
      toast.success('Sports settings saved.');
    } catch (err) {
      setError(extractApiError(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <LoadingSpinner label="Loading sports settings…" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto">
      {error && <ErrorBanner message={error} multiline />}

      <ul className="flex flex-col gap-6">
        {ADDONS.map((addon) => (
          <li key={addon.id} className="flex min-w-0 flex-col gap-6">
            <Well bare className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 gap-3">
                <span className="pc-sports-addon-mark" aria-hidden>
                  <svg viewBox="0 0 28 28" width="28" height="28">
                    <path d="M4 20 Q14 8 24 20" fill="none" stroke="var(--sports-turf)" strokeWidth="2.4" strokeLinecap="round" />
                    <circle cx="14" cy="16" r="3.1" fill="var(--sports-leather)" />
                    <path d="M14 13.4 V18.6 M11.6 16 H16.4" stroke="var(--sports-lace)" strokeWidth="0.7" />
                  </svg>
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-display text-name font-semibold text-text-primary">{addon.name}</h3>
                    {enabled && <Chip size="sm" tone="accent">Added</Chip>}
                  </div>
                  <p className="mt-0.5 text-body leading-relaxed text-text-secondary">{addon.description}</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {enabled ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void onRemove()}
                    disabled={removing}
                  >
                    Remove from server
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void onAdd()}
                    disabled={adding}
                    loading={adding}
                  >
                    Add to server
                  </Button>
                )}
              </div>
            </Well>

            {addon.id === 'sports' && enabled && (
              <SportsConfig
                leagues={leagues}
                labelFor={labelFor}
                move={move}
                removeLeague={removeLeague}
                remaining={remaining}
                addLeague={addLeague}
                catalogError={catalogError}
                customOpen={customOpen}
                setCustomOpen={setCustomOpen}
                customPath={customPath}
                setCustomPath={setCustomPath}
                setCustomError={setCustomError}
                customError={customError}
                addCustom={addCustom}
                favorites={favorites}
                setFavorites={setFavorites}
                openLeague={openLeague}
                openPicker={(path) => void openPicker(path)}
                rosterQuery={rosterQuery}
                setRosterQuery={setRosterQuery}
                rosters={rosters}
                rosterErrors={rosterErrors}
                rosterLoading={rosterLoading}
                favoriteKeys={favoriteKeys}
                addFavorite={addFavorite}
                showOnPage={showOnPage}
                setShowOnPage={setShowOnPage}
                scoreAlerts={scoreAlerts}
                setScoreAlerts={setScoreAlerts}
                defaultView={defaultView}
                setDefaultView={setDefaultView}
                layout={layout}
                setLayout={setLayout}
              />
            )}
          </li>
        ))}
      </ul>
      </div>
      {enabled && dirty && (
        <div className="pc-sports-savebar">
          <Button variant="primary" onClick={() => void onSave()} loading={saving} disabled={saving}>
            Save changes
          </Button>
        </div>
      )}
    </div>
  );
}

function SportsConfig(props: {
  leagues: string[];
  labelFor: (path: string) => string;
  move: (index: number, dir: -1 | 1) => void;
  removeLeague: (path: string) => void;
  remaining: LeagueCatalogEntry[];
  addLeague: (path: string) => void;
  catalogError: string | null;
  customOpen: boolean;
  setCustomOpen: (value: boolean) => void;
  customPath: string;
  setCustomPath: (value: string) => void;
  setCustomError: (value: string | null) => void;
  customError: string | null;
  addCustom: () => void;
  favorites: SportsFavoriteTeam[];
  setFavorites: Dispatch<SetStateAction<SportsFavoriteTeam[]>>;
  openLeague: string | null;
  openPicker: (path: string) => void;
  rosterQuery: string;
  setRosterQuery: (value: string) => void;
  rosters: Record<string, SportsRosterTeam[]>;
  rosterErrors: Record<string, string>;
  rosterLoading: string | null;
  favoriteKeys: Set<string>;
  addFavorite: (team: SportsFavoriteTeam) => void;
  showOnPage: boolean;
  setShowOnPage: (value: boolean) => void;
  scoreAlerts: boolean;
  setScoreAlerts: (value: boolean) => void;
  defaultView: SportsDefaultView;
  setDefaultView: (value: SportsDefaultView) => void;
  layout: SportsLayout;
  setLayout: (value: SportsLayout) => void;
}) {
  const {
    leagues, labelFor, move, removeLeague, remaining, addLeague, catalogError,
    customOpen, setCustomOpen, customPath, setCustomPath, setCustomError, customError, addCustom, favorites, setFavorites,
    openLeague, openPicker, rosterQuery, setRosterQuery, rosters, rosterErrors, rosterLoading,
    favoriteKeys, addFavorite, showOnPage, setShowOnPage, scoreAlerts, setScoreAlerts, defaultView, setDefaultView, layout, setLayout,
  } = props;

  return (
    <div className="flex min-h-full flex-1 flex-col gap-8">
      <section className="flex flex-col gap-3">
        <GroupLabel>Leagues</GroupLabel>
        <p className="text-body text-text-secondary">
          The order here is the order of the league filters. Up to 12.
        </p>
        {leagues.length === 0 ? (
          <p className="text-label text-text-muted">No leagues yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {leagues.map((path, index) => {
              const label = labelFor(path);
              return (
                <li key={path} className="flex min-w-0 flex-wrap items-center gap-1 py-1">
                  <span className="min-w-0 flex-1 truncate text-label text-text-primary">{label}</span>
                  <IconButton label={`Move ${label} up`} size="sm" disabled={index === 0} onClick={() => move(index, -1)}>
                    <ArrowUp size={14} />
                  </IconButton>
                  <IconButton label={`Move ${label} down`} size="sm" disabled={index === leagues.length - 1} onClick={() => move(index, 1)}>
                    <ArrowDown size={14} />
                  </IconButton>
                  <IconButton label={`Remove ${label}`} size="sm" onClick={() => removeLeague(path)}>
                    <X size={14} />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        )}

        {catalogError && <p className="text-meta text-text-secondary">{catalogError}</p>}
        {remaining.length > 0 && (
          <div className="flex flex-col gap-2">
            <GroupLabel>Add a league</GroupLabel>
            <div className="flex flex-wrap gap-2">
              {remaining.map((entry) => (
                <Button
                  key={entry.path}
                  size="sm"
                  variant="outline"
                  aria-label={`Add ${entry.label}`}
                  onClick={() => addLeague(entry.path)}
                >
                  <Plus size={14} aria-hidden />
                  {entry.label}
                </Button>
              ))}
            </div>
          </div>
        )}

        <div className="flex max-w-md flex-col gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="w-fit"
            aria-expanded={customOpen}
            onClick={() => setCustomOpen(!customOpen)}
          >
            A league that isn't listed
          </Button>
          {customOpen && (
            <div className="flex flex-col">
              <p className="mb-2 text-meta text-text-muted">
                Type it the way ESPN writes it in a scoreboard address, for example soccer/eng.2.
              </p>
              <span className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label="Custom league path"
                  value={customPath}
                  placeholder="soccer/eng.2"
                  onChange={(event) => {
                    setCustomPath(event.target.value);
                    setCustomError(null);
                  }}
                  className="min-w-0 flex-1"
                />
                <Button size="sm" variant="outline" onClick={addCustom}>
                  <Plus size={14} aria-hidden />
                  Add path
                </Button>
              </span>
            </div>
          )}
          {customError && <p className="text-meta text-accent-danger">{customError}</p>}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <GroupLabel>Favorite teams</GroupLabel>
        <p className="text-body text-text-secondary">
          Picked from each league's full list of teams. They are listed first, and the Favorites filter shows only them.
        </p>
        {favorites.length > 0 && (
          <ul className="flex flex-col gap-1">
            {favorites.map((team) => (
              <li key={`${team.league}:${team.team_id}`} className="flex min-w-0 items-center gap-2">
                <span className="pc-mono text-meta text-text-muted">{team.abbr}</span>
                <span className="min-w-0 flex-1 truncate text-label text-text-primary">{team.name}</span>
                <IconButton
                  label={`Remove ${team.name}`}
                  size="sm"
                  onClick={() => {
                    setFavorites((prev) => prev.filter((item) => item.team_id !== team.team_id || item.league !== team.league));
                  }}
                >
                  <X size={14} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        {leagues.length === 0 && (
          <p className="text-label text-text-muted">Add a league, then pick teams from its list.</p>
        )}
        {leagues.map((path) => {
          const label = labelFor(path);
          const open = openLeague === path;
          const roster = rosters[path] ?? [];
          const query = rosterQuery.trim().toLowerCase();
          const matches = roster.filter((team) => {
            if (favoriteKeys.has(`${path}:${team.id}`)) return false;
            if (!query) return true;
            return team.name.toLowerCase().includes(query) || team.abbr.toLowerCase().includes(query);
          });
          return (
            <div key={path} className="flex flex-col gap-2">
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={open}
                onClick={() => openPicker(path)}
              >
                {open ? `Hide ${label} teams` : `Pick ${label} teams`}
              </Button>
              {open && (
                <div className="flex flex-col gap-2 pl-1">
                  <Input
                    aria-label={`Search ${label} teams`}
                    value={rosterQuery}
                    placeholder="Name or abbreviation"
                    onChange={(event) => setRosterQuery(event.target.value)}
                  />
                  {rosterLoading === path && (
                    <p className="text-label text-text-muted">Loading teams…</p>
                  )}
                  {rosterErrors[path] && (
                    <p className="text-label text-text-secondary">{rosterErrors[path]}</p>
                  )}
                  {rosterLoading !== path && !rosterErrors[path] && matches.length === 0 && rosters[path] && (
                    <p className="text-label text-text-muted">No teams match.</p>
                  )}
                  {rosterLoading !== path && matches.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {matches.map((team) => (
                        <Button
                          key={team.id}
                          size="sm"
                          variant="outline"
                          onClick={() => addFavorite({
                            league: path,
                            team_id: team.id,
                            abbr: team.abbr,
                            name: team.name,
                          })}
                          disabled={favorites.length >= FAVORITE_MAX}
                        >
                          Add {team.name}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </section>

      <ToggleRow
        label="Show games on the server home"
        description="Live games join 'Live now', and the next game gets a card. Off keeps games on the Sports page only."
        checked={showOnPage}
        onChange={setShowOnPage}
      />

      <ToggleRow
        label="Tell members when a favorite team scores"
        description={favorites.length === 0
          ? 'Pick a favorite team first. Members get a notification for each score in its games and for the final.'
          : 'Members get a notification for each score in a favorite team\'s game and for the final. Each person can turn it off on the Sports page. The server checks those leagues every few minutes, even when nobody has Sports open.'}
        checked={scoreAlerts}
        onChange={setScoreAlerts}
      />

      <label className="flex max-w-xs flex-col">
        <FieldLabel>Layout</FieldLabel>
        <span className="mb-2 text-meta text-text-muted">
          Cards show several games across the page. List keeps one game on each row.
        </span>
        <Select
          aria-label="Layout"
          value={layout}
          onChange={(event) => setLayout(asLayout(event.target.value))}
        >
          <option value="cards">Cards</option>
          <option value="list">List</option>
        </Select>
      </label>

      <label className="flex max-w-xs flex-col">
        <FieldLabel>Default view</FieldLabel>
        <Select
          aria-label="Default view"
          value={defaultView}
          onChange={(event) => setDefaultView(asDefaultView(event.target.value))}
        >
          <option value="all">All</option>
          <option value="live">Live</option>
          <option value="favorites">Favorites</option>
        </Select>
      </label>

    </div>
  );
}
