import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { sportsApi, type SportsBoard, type SportsGame, type SportsSettings, type SportsTeam } from '../../../../api/sports';
import { useSportsStore } from '../../../../stores/sportsStore';
import { GameWidget, useSportsGames } from './GameWidget';
import { renderHook } from '@testing-library/react';

vi.mock('../../../../api/sports', async () => {
  const actual = await vi.importActual<typeof import('../../../../api/sports')>('../../../../api/sports');
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

function settings(over: Partial<SportsSettings> = {}): SportsSettings {
  return {
    guild_id: 'g1',
    enabled: true,
    leagues: ['football/nfl'],
    favorite_teams: [],
    show_on_server_page: true,
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

function liveGame(id: string): SportsGame {
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
    away: team(id, 7),
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
    heat: 0,
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

describe('GameWidget on the server home', () => {
  beforeEach(() => {
    useSportsStore.getState().reset();
    vi.clearAllMocks();
    vi.mocked(sportsApi.getBoard).mockResolvedValue({ data: board([liveGame('Chiefs')]) } as never);
  });

  afterEach(() => {
    cleanup();
    useSportsStore.getState().reset();
  });

  it('shows a live game when the server shows games on its home page', async () => {
    vi.mocked(sportsApi.getSettings).mockResolvedValue({ data: settings() } as never);
    function Driver() {
      useSportsGames('g1');
      return <GameWidget guildId="g1" liveShownElsewhere={false} />;
    }
    render(
      <MemoryRouter>
        <Driver />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Game · live')).toBeInTheDocument();
  });

  it('renders nothing and does not poll when show_on_server_page is off', async () => {
    vi.mocked(sportsApi.getSettings).mockResolvedValue({
      data: settings({ show_on_server_page: false }),
    } as never);
    const { container } = render(
      <MemoryRouter>
        <GameWidget guildId="g1" liveShownElsewhere={false} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(useSportsStore.getState().byGuild.g1?.settingsStatus).toBe('ready'));
    expect(container).toBeEmptyDOMElement();
    expect(sportsApi.getBoard).not.toHaveBeenCalled();
  });

  it('useSportsGames reports no games while show_on_server_page is off', async () => {
    vi.mocked(sportsApi.getSettings).mockResolvedValue({
      data: settings({ show_on_server_page: false }),
    } as never);
    const { result } = renderHook(() => useSportsGames('g1'));
    await waitFor(() => expect(useSportsStore.getState().byGuild.g1?.settingsStatus).toBe('ready'));
    expect(result.current.shown).toBe(false);
    expect(result.current.games).toEqual([]);
    expect(sportsApi.getBoard).not.toHaveBeenCalled();
  });

  it('useSportsGames feeds Live now while show_on_server_page is on', async () => {
    vi.mocked(sportsApi.getSettings).mockResolvedValue({ data: settings() } as never);
    const { result } = renderHook(() => useSportsGames('g1'));
    await waitFor(() => expect(result.current.games).toHaveLength(1));
    expect(result.current.shown).toBe(true);
  });
});
