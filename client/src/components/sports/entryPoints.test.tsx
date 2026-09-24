import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { buildingLight } from '../../lib/attention/light';
import { sportsApi, type SportsBoard, type SportsGame, type SportsSettings, type SportsTeam } from '../../api/sports';
import { BuildingSection } from '../layout/sidebar/BuildingSection';
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

const SCOPE = { serverId: 'srv', userId: 'viewer' };

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

function renderSection(onOpenSports = vi.fn()) {
  const building = buildingLight({
    scope: SCOPE,
    guildId: 'g1',
    name: 'Kestrel Robotics',
    rooms: [],
    members: [],
    memberCount: 1,
  });
  render(
    <BuildingSection
      building={building}
      active
      rooms={[]}
      hiddenRoomCount={0}
      expanded={false}
      onToggleRooms={vi.fn()}
      onOpenLobby={vi.fn()}
      onOpenRoom={vi.fn()}
      navIndexStart={2}
      activeNavIndex={2}
      onOpenSports={onOpenSports}
    />,
  );
  return onOpenSports;
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
    window.history.pushState({}, '', '/');
  });

  it('hides the sidebar row and does not load a board when sports is off', async () => {
    renderSection();
    await waitFor(() => expect(useSportsStore.getState().byGuild.g1?.settingsStatus).toBe('ready'));
    expect(screen.queryByRole('option', { name: 'Sports' })).not.toBeInTheDocument();
    expect(sportsApi.getBoard).not.toHaveBeenCalled();
  });

  it('opens the sports page from the sidebar row', async () => {
    const user = userEvent.setup();
    vi.mocked(sportsApi.getSettings).mockResolvedValue({
      data: settings({ enabled: true }),
    } as never);
    const onOpen = renderSection();
    const row = await screen.findByRole('option', { name: 'Sports' });
    expect(row).toHaveAttribute('href', '/app/guilds/g1/sports');
    expect(row).toHaveAttribute('tabindex', '-1');
    await user.click(row);
    expect(onOpen).toHaveBeenCalledWith('g1');
    await waitFor(() => expect(sportsApi.getBoard).toHaveBeenCalledTimes(1));
  });

  it('makes the sports row the selected tab stop when that page is open', async () => {
    window.history.pushState({}, '', '/app/guilds/g1/sports');
    vi.mocked(sportsApi.getSettings).mockResolvedValue({
      data: settings({ enabled: true }),
    } as never);
    renderSection();
    const row = await screen.findByRole('option', { name: 'Sports' });
    expect(row).toHaveAttribute('data-selected-row', 'true');
    expect(row).toHaveAttribute('aria-current', 'page');
    expect(row).toHaveAttribute('tabindex', '0');
    const lobby = screen.getByRole('option', { name: /Kestrel Robotics lobby/ });
    expect(lobby).not.toHaveAttribute('aria-current');
    expect(lobby).toHaveAttribute('tabindex', '-1');
  });

  it('shows a live count on the sidebar row once a board lands', async () => {
    vi.mocked(sportsApi.getSettings).mockResolvedValue({
      data: settings({ enabled: true, show_on_server_page: true }),
    } as never);
    vi.mocked(sportsApi.getBoard).mockResolvedValue({
      data: board([liveGame('Chiefs', 80), liveGame('Bills', 40)]),
    } as never);
    const building = buildingLight({
      scope: SCOPE,
      guildId: 'g1',
      name: 'Kestrel Robotics',
      rooms: [],
      members: [],
      memberCount: 1,
    });
    render(
      <MemoryRouter>
        <BuildingSection
          building={building}
          rooms={[]}
          hiddenRoomCount={0}
          expanded={false}
          onToggleRooms={vi.fn()}
          onOpenLobby={vi.fn()}
          onOpenRoom={vi.fn()}
          navIndexStart={2}
          activeNavIndex={2}
        />
      </MemoryRouter>,
    );
    const liveChip = await screen.findByText('2 live');
    expect(liveChip.querySelector('.pc-sports-live')).not.toBeNull();
    expect(sportsApi.getSettings).toHaveBeenCalledTimes(1);
    expect(sportsApi.getBoard).toHaveBeenCalledTimes(1);
  });
});
