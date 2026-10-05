import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sportsApi, type SportsBoard, type SportsGame, type SportsSettings, type SportsTeam } from '../../api/sports';
import { AddonList } from '../ix/sidebar/AddonList';
import { useAddons } from '../ix/sidebar/useAddons';
import { useSportsStore } from '../../stores/sportsStore';

vi.mock('../../api/sports', async () => {
  const actual = await vi.importActual<typeof import('../../api/sports')>('../../api/sports');
  return {
    ...actual,
    sportsApi: {
      getSettings: vi.fn(),
      getBoard: vi.fn(),
      listLeagues: vi.fn(),
      updateSettings: vi.fn(),
    },
  };
});

// The other two add-ons the sidebar lists are off: this file is about sports.
vi.mock('../../hooks/useDailyWord', () => ({ useDailyWordSettings: () => ({ enabled: false }) }));
vi.mock('../../hooks/useGameServers', () => ({ useGameServers: () => ({ servers: [] }) }));

function settings(over: Partial<SportsSettings> = {}): SportsSettings {
  return {
    guild_id: 'g1',
    enabled: false,
    leagues: ['football/nfl'],
    favorite_teams: [],
    show_on_server_page: false,
    default_view: 'all',
    updated_at: '2026-09-21T12:00:00.000Z',
    ...over,
  };
}

function team(name: string, score: number | null = 0): SportsTeam {
  return {
    id: name, abbr: name.slice(0, 2).toUpperCase(), name, short_name: name, logo: '',
    score, record: null, possession: false, winner: false,
  };
}

function liveGame(id: string, heat: number): SportsGame {
  return {
    id,
    sport: 'football',
    league: 'NFL',
    league_path: 'football/nfl',
    name: id,
    start: '2026-09-21T20:00:00.000Z',
    state: 'in',
    detail: '1st quarter',
    period: 1,
    clock: '10:00',
    clock_seconds: 600,
    home: team(`${id}-home`, 3),
    away: team(id, heat),
    last_play: null,
    last_play_type: null,
    last_play_score: null,
    down_distance: null,
    ball_on: null,
    possession_team_id: null,
    yards_to_endzone: null,
    red_zone: false,
    balls: null,
    strikes: null,
    outs: null,
    on_first: false,
    on_second: false,
    on_third: false,
    home_win_pct: null,
    broadcasts: [],
    heat,
    tags: [],
    favorite: false,
  };
}

function board(games: SportsGame[]): SportsBoard {
  return {
    fetched_at: '2026-09-21T18:00:00.000Z',
    leagues: [{ path: 'football/nfl', label: 'NFL', error: null }],
    games,
  };
}

/**
 * The sidebar lists a server's add-ons as rows under its voice channels
 * (`ix/sidebar/AddonList.tsx`). The rows are the only door to the sports
 * page, so these hold that it opens, shows where you are, and says what is live.
 */
function Rows({ pathname = '/app/guilds/g1', onOpen }: { pathname?: string; onOpen: (id: string) => void }) {
  const addons = useAddons('g1', pathname);
  return (
    <nav aria-label="Places">
      <AddonList addons={addons} focusOf={(id) => ({ tabIndex: id === 'addon:sports' ? 0 : -1, onFocus: () => {} })} onOpen={(addon) => onOpen(addon.id)} />
    </nav>
  );
}

function renderRows(pathname?: string, onOpen = vi.fn()) {
  render(<Rows pathname={pathname} onOpen={onOpen} />);
  return onOpen;
}

describe('sports entry points', () => {
  beforeEach(() => {
    useSportsStore.getState().reset();
    vi.clearAllMocks();
    vi.mocked(sportsApi.getSettings).mockResolvedValue({ data: settings() } as never);
    vi.mocked(sportsApi.getBoard).mockResolvedValue({ data: board([]) } as never);
  });

  afterEach(() => {
    cleanup();
    useSportsStore.getState().reset();
  });

  it('has no row and does not load a board when sports is off', async () => {
    renderRows();
    await waitFor(() => expect(useSportsStore.getState().byGuild.g1?.settingsStatus).toBe('ready'));
    expect(screen.queryByRole('link', { name: /Sports/ })).not.toBeInTheDocument();
    expect(sportsApi.getBoard).not.toHaveBeenCalled();
  });

  it('opens the sports page from its row', async () => {
    const user = userEvent.setup();
    vi.mocked(sportsApi.getSettings).mockResolvedValue({
      data: settings({ enabled: true }),
    } as never);
    const onOpen = renderRows();
    const row = await screen.findByRole('link', { name: /Sports/ });
    expect(row).toHaveAttribute('href', '/app/guilds/g1/sports');
    expect(row).toHaveAttribute('tabindex', '0');
    expect(row).not.toHaveAttribute('aria-current');
    await user.click(row);
    expect(onOpen).toHaveBeenCalledWith('addon:sports');
    await waitFor(() => expect(sportsApi.getBoard).toHaveBeenCalledTimes(1));
  });

  it('marks the sports row as the page you are on', async () => {
    vi.mocked(sportsApi.getSettings).mockResolvedValue({
      data: settings({ enabled: true }),
    } as never);
    renderRows('/app/guilds/g1/sports');
    const row = await screen.findByRole('link', { name: /Sports/ });
    expect(row).toHaveAttribute('data-ix-selected');
    expect(row).toHaveAttribute('aria-current', 'page');
  });

  it('says how many games are live once a board lands', async () => {
    vi.mocked(sportsApi.getSettings).mockResolvedValue({
      data: settings({ enabled: true, show_on_server_page: true }),
    } as never);
    vi.mocked(sportsApi.getBoard).mockResolvedValue({
      data: board([liveGame('Chiefs', 80), liveGame('Bills', 40)]),
    } as never);
    renderRows();
    expect(await screen.findByText('2 live now')).toBeInTheDocument();
    expect(sportsApi.getSettings).toHaveBeenCalledTimes(1);
    expect(sportsApi.getBoard).toHaveBeenCalledTimes(1);
  });
});
