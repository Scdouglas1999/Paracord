import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { sportsApi, type SportsBoard, type SportsGame, type SportsSettings, type SportsTeam } from '../api/sports';
import { GuildSportsPage } from './GuildSportsPage';
import { useSportsStore } from '../stores/sportsStore';
import { boardDay } from '../components/sports/boardDate';

vi.mock('../hooks/useGuilds', () => ({
  useGuild: () => ({ id: 'g1', name: 'Kestrel Robotics' }),
}));

vi.mock('../api/sports', async () => {
  const actual = await vi.importActual<typeof import('../api/sports')>('../api/sports');
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

function team(over: Partial<SportsTeam> & Pick<SportsTeam, 'id' | 'abbr' | 'name' | 'short_name'>): SportsTeam {
  return { logo: '', score: 0, record: null, possession: false, winner: false, ...over };
}

function game(over: Partial<SportsGame> & Pick<SportsGame, 'id' | 'state'>): SportsGame {
  return {
    sport: 'football',
    league: 'NFL',
    league_path: 'football/nfl',
    name: over.id,
    start: '2026-09-21T20:00:00.000Z',
    detail: '',
    period: null,
    clock: null,
    clock_seconds: null,
    home: team({ id: 'h', abbr: 'HM', name: 'Home', short_name: 'Home' }),
    away: team({ id: 'a', abbr: 'AW', name: 'Away', short_name: 'Away' }),
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
    ...over,
  };
}

const chiefs = game({
  id: 'chiefs',
  state: 'in',
  detail: '4th quarter 7:58',
  period: 4,
  clock: '7:58',
  clock_seconds: 478,
  heat: 10,
  favorite: true,
  tags: ['RED ZONE'],
  red_zone: true,
  last_play: 'Mahomes pass to Kelce for 12 yards',
  home_win_pct: 0.38,
  away: team({
    id: '12', abbr: 'KC', name: 'Kansas City Chiefs', short_name: 'Chiefs', score: 21, possession: true,
  }),
  home: team({
    id: '2', abbr: 'BUF', name: 'Buffalo Bills', short_name: 'Bills', score: 17,
    logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/buf.png',
  }),
});

const eagles = game({
  id: 'eagles',
  state: 'in',
  detail: '2nd quarter 4:10',
  heat: 90,
  down_distance: '2nd & 7 at DAL 42',
  away: team({
    id: '21', abbr: 'PHI', name: 'Philadelphia Eagles', short_name: 'Eagles', score: 10, color: '004c54',
  }),
  home: team({
    id: '6', abbr: 'DAL', name: 'Dallas Cowboys', short_name: 'Cowboys', score: 7, color: '041e42',
  }),
});

const baseball = game({
  id: 'os',
  sport: 'baseball',
  league: 'MLB',
  league_path: 'baseball/mlb',
  state: 'in',
  detail: 'Top 7th',
  heat: 50,
  balls: 1,
  strikes: 2,
  outs: 2,
  on_second: true,
  away: team({ id: '110', abbr: 'BAL', name: 'Baltimore Orioles', short_name: 'Orioles', score: 3 }),
  home: team({ id: '111', abbr: 'BOS', name: 'Boston Red Sox', short_name: 'Red Sox', score: 2 }),
});

const upcoming = game({
  id: 'packers',
  state: 'pre',
  start: '2026-09-21T23:30:00.000Z',
  broadcasts: ['ESPN'],
  away: team({ id: '9', abbr: 'GB', name: 'Green Bay Packers', short_name: 'Packers', score: null }),
  home: team({ id: '8', abbr: 'DET', name: 'Detroit Lions', short_name: 'Lions', score: null }),
});

const final = game({
  id: 'ravens',
  sport: 'baseball',
  league: 'MLB',
  league_path: 'baseball/mlb',
  state: 'post',
  detail: 'Final',
  start: '2026-09-21T17:00:00.000Z',
  away: team({ id: '1', abbr: 'NYY', name: 'New York Yankees', short_name: 'Yankees', score: 2 }),
  home: team({ id: '5', abbr: 'BAL', name: 'Baltimore Ravens', short_name: 'Ravens', score: 5, winner: true }),
});

function fullBoard(games: SportsGame[] = [chiefs, eagles, baseball, upcoming, final]): SportsBoard {
  return {
    fetched_at: '2026-09-21T18:00:00.000Z',
    leagues: [
      { path: 'football/nfl', label: 'NFL', error: null },
      { path: 'baseball/mlb', label: 'MLB', error: null },
      { path: 'hockey/nhl', label: 'NHL', error: null },
    ],
    games,
  };
}

function settings(over: Partial<SportsSettings> = {}): SportsSettings {
  return {
    guild_id: 'g1',
    enabled: true,
    leagues: ['football/nfl', 'baseball/mlb', 'hockey/nhl'],
    favorite_teams: [{ league: 'football/nfl', team_id: '12', abbr: 'KC', name: 'Kansas City Chiefs' }],
    show_on_server_page: true,
    default_view: 'all',
    layout: 'cards',
    updated_at: '2026-09-21T12:00:00.000Z',
    ...over,
  };
}

function renderPage(entry = '/app/guilds/g1/sports') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/app/guilds/:guildId/sports" element={<GuildSportsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('GuildSportsPage', () => {
  beforeEach(() => {
    localStorage.clear();
    useSportsStore.getState().reset();
    vi.mocked(sportsApi.getSettings).mockReset();
    vi.mocked(sportsApi.getBoard).mockReset();
    vi.mocked(sportsApi.getSettings).mockResolvedValue({ data: settings() } as never);
    vi.mocked(sportsApi.getBoard).mockResolvedValue({ data: fullBoard() } as never);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    useSportsStore.getState().reset();
    vi.restoreAllMocks();
  });

  it('groups games, keeps a favorite in Your teams, and features the hottest live game', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Sports' })).toBeInTheDocument();
    expect(screen.getByText('Kestrel Robotics')).toBeInTheDocument();
    expect(screen.getByText('3 live · 1 upcoming')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Filters' })).toHaveClass('sticky');

    const filters = screen.getByRole('group', { name: 'Filters' });
    expect(within(filters).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'All', 'NFL', 'MLB', 'NHL', 'All', 'Live', 'Favorites',
    ]);

    const yours = screen.getByRole('region', { name: 'Your teams' });
    const chiefs = within(yours).getByRole('link', { name: 'Open Chiefs at Bills' });
    expect(chiefs).toHaveAttribute('href', '/app/guilds/g1/sports/football/nfl/chiefs');
    expect(chiefs).toHaveClass('pc-sports-card');
    expect(within(chiefs).getByText('Chiefs 21, Bills 17, 4th quarter 7:58, red zone')).toBeInTheDocument();
    expect(within(yours).getByRole('img', { name: 'Favorite team' })).toBeInTheDocument();
    expect(screen.queryByText('Favourite')).not.toBeInTheDocument();

    const live = screen.getByRole('region', { name: 'Live' });
    expect(within(live).queryByRole('link', { name: /Chiefs/ })).not.toBeInTheDocument();
    const articles = within(live).getAllByRole('link');
    expect(articles[0]).toHaveClass('is-featured');
    expect(articles[0].querySelector('.pc-sports-hero')).not.toBeNull();
    expect(articles[0]).toHaveAccessibleName('Open Eagles at Cowboys');
    expect(articles[0].getAttribute('style')).toContain('004c54');
    expect(articles[0].getAttribute('style')).toContain('041e42');
    expect(within(articles[0]).getByRole('img', { name: /Ball on the DAL 42/ })).toBeInTheDocument();
    expect(articles[0]).toHaveAttribute('href', '/app/guilds/g1/sports/football/nfl/eagles');
    expect(articles[1]).toHaveAccessibleName('Open Orioles at Red Sox');

    expect(screen.getByRole('region', { name: 'Upcoming' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Packers at Lions' })).toBeInTheDocument();
    expect(screen.getByText('On ESPN')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Final' })).toBeInTheDocument();

    expect(screen.getByText('Red zone')).toBeInTheDocument();
    expect(screen.queryByText('RED ZONE')).not.toBeInTheDocument();
    expect(screen.getByText('2nd & 7 at DAL 42')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Runner on second' })).toBeInTheDocument();
    expect(screen.getByText('1 ball, 2 strikes, 2 outs')).toBeInTheDocument();
    expect(screen.getByText('Chiefs 62% to win')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'has the ball' })).toBeInTheDocument();

    expect(screen.getByText('KC')).toBeInTheDocument();
    const img = document.querySelector('img');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
    fireEvent.error(img!);
    expect(screen.getByText('BU')).toBeInTheDocument();
  });

  it('filters by league and by view without changing the day counts', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('link', { name: 'Open Chiefs at Bills' });

    await user.click(screen.getByRole('button', { name: 'NFL' }));
    expect(screen.getByText('2 live · 1 upcoming')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Runner on second' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'NHL' }));
    expect(screen.getByText('Nothing scheduled today in NHL.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'All leagues' }));
    await user.click(screen.getByRole('button', { name: 'Live' }));
    expect(screen.getByText('3 live · 1 upcoming')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Upcoming' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Final' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Favorites' }));
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Open Chiefs at Bills' })).toBeInTheDocument();
  });

  it('marks the winner on a final card and in the list', async () => {
    renderPage();
    const card = await screen.findByRole('link', { name: 'Open Yankees at Ravens' });
    expect(card).toHaveClass('pc-sports-card');
    expect(card.querySelector('.pc-sports-winner-mark')).not.toBeNull();
    expect(within(card).getByText('Yankees')).toHaveClass('is-loser');
    expect(within(card).getByText('Ravens')).not.toHaveClass('is-loser');
    expect(card.querySelector('.pc-sports-score.is-winner')).toHaveTextContent('5');
    expect(card.querySelector('.pc-sports-score.is-loser')).toHaveTextContent('2');

    cleanup();
    useSportsStore.getState().reset();
    vi.mocked(sportsApi.getSettings).mockResolvedValue({ data: settings({ layout: 'list' }) } as never);
    renderPage();
    const row = await screen.findByRole('link', { name: 'Open Yankees at Ravens' });
    expect(row).toHaveClass('pc-sports-row');
    expect(row.querySelector('.pc-sports-winner-mark')).not.toBeNull();
    expect(within(row).getByText('Yankees')).toHaveClass('is-loser');
  });

  it('keeps dense rows when the server chose a list', async () => {
    vi.mocked(sportsApi.getSettings).mockResolvedValue({ data: settings({ layout: 'list' }) } as never);
    renderPage();
    const row = await screen.findByRole('link', { name: 'Open Eagles at Cowboys' });
    expect(row).toHaveClass('pc-sports-row');
    expect(row).not.toHaveClass('is-featured');
  });

  it('starts on the view the server chose', async () => {
    vi.mocked(sportsApi.getSettings).mockResolvedValue({ data: settings({ default_view: 'favorites' }) } as never);
    renderPage();
    const button = await screen.findByRole('button', { name: 'Favorites' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('hides scores for this person and survives a blocked browser store', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('link', { name: 'Open Chiefs at Bills' });

    await user.click(screen.getByRole('switch', { name: 'Hide scores' }));
    expect(localStorage.getItem('paracord.sports.hide-scores')).toBe('1');
    expect(screen.getByText('Chiefs and Bills, 4th quarter 7:58, scores hidden')).toBeInTheDocument();
    expect(screen.queryByText('21')).not.toBeInTheDocument();
    expect(screen.queryByText('Red zone')).not.toBeInTheDocument();

    cleanup();
    useSportsStore.getState().reset();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderPage();
    await screen.findByText('Chiefs and Bills, 4th quarter 7:58, scores hidden');
    await user.click(screen.getByRole('switch', { name: 'Hide scores' }));
    expect(screen.getByText('Chiefs 21, Bills 17, 4th quarter 7:58, red zone')).toBeInTheDocument();
  });

  it('illustrates a quiet favorites day', async () => {
    vi.mocked(sportsApi.getSettings).mockResolvedValue({ data: settings({ default_view: 'favorites' }) } as never);
    vi.mocked(sportsApi.getBoard).mockResolvedValue({
      data: fullBoard([{ ...upcoming, favorite: false }]),
    } as never);
    renderPage();
    expect(await screen.findByText('No favorite teams are playing today.')).toBeInTheDocument();
    expect(document.querySelector('.pc-sports-empty-mark')).not.toBeNull();
  });

  it('says the day is empty only when the scores actually arrived', async () => {
    vi.mocked(sportsApi.getBoard).mockResolvedValue({ data: fullBoard([]) } as never);
    renderPage();
    expect(await screen.findByText('No games today')).toBeInTheDocument();
    expect(document.querySelector('.pc-sports-empty-mark')).not.toBeNull();
    expect(screen.queryByText(/couldn't be loaded/)).not.toBeInTheDocument();
  });

  it('does not describe a failed league as a quiet day', async () => {
    vi.mocked(sportsApi.getBoard).mockResolvedValue({
      data: {
        fetched_at: '2026-09-21T18:00:00.000Z',
        leagues: [{ path: 'football/nfl', label: 'NFL', error: 'timed out' }],
        games: [],
      },
    } as never);
    renderPage();
    expect(await screen.findByText("Scores couldn't be loaded for NFL.")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing scheduled/)).not.toBeInTheDocument();
  });

  it('keeps the last games when a league failed this time', async () => {
    vi.mocked(sportsApi.getBoard).mockResolvedValue({
      data: {
        ...fullBoard([chiefs]),
        leagues: [{ path: 'football/nfl', label: 'NFL', error: 'site.web.api.espn.com answered HTTP 503' }],
      },
    } as never);
    renderPage();
    expect(await screen.findByText("Scores couldn't be loaded for NFL. Showing the last ones we got.")).toBeInTheDocument();
    expect(screen.queryByText(/HTTP 503/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Chiefs at Bills' })).toBeInTheDocument();
  });

  it('says sports is off without asking for a board', async () => {
    vi.mocked(sportsApi.getSettings).mockResolvedValue({ data: settings({ enabled: false }) } as never);
    renderPage();
    expect(await screen.findByText('Sports is turned off for this server.')).toBeInTheDocument();
    expect(sportsApi.getBoard).not.toHaveBeenCalled();
  });

  it('shows a settings failure and does not ask for a board', async () => {
    vi.mocked(sportsApi.getSettings).mockRejectedValue(new Error('offline'));
    renderPage();
    expect(await screen.findByText('offline')).toBeInTheDocument();
    expect(sportsApi.getBoard).not.toHaveBeenCalled();
  });

  it('retries a board that did not load', async () => {
    const user = userEvent.setup();
    vi.mocked(sportsApi.getBoard)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ data: fullBoard([chiefs]) } as never);
    renderPage();
    expect(await screen.findByText("Scores couldn't be loaded. Try again in a moment.")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing scheduled/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Open Chiefs at Bills' })).toBeInTheDocument();
  });

  it('flashes a row when the score changes, and not while scores are hidden', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('link', { name: 'Open Chiefs at Bills' });

    const changed = fullBoard();
    changed.games = changed.games.map((item) => item.id === 'chiefs'
      ? { ...item, away: { ...item.away, score: 28, color: 'e31837' } }
      : item);
    vi.mocked(sportsApi.getBoard).mockResolvedValue({ data: changed } as never);
    await act(async () => {
      await useSportsStore.getState().refreshBoard('g1');
    });
    const scored = screen.getByRole('link', { name: 'Open Chiefs at Bills' });
    expect(scored).toHaveClass('is-flash');
    expect(screen.getByText('Chiefs scored. Chiefs 28, Bills 17.')).toBeInTheDocument();
    const flashedScore = scored.querySelector('.is-score-flash');
    expect(flashedScore).toHaveTextContent('28');
    expect(flashedScore?.getAttribute('style') ?? '').toContain('rgb(227, 24, 55)');

    await user.click(screen.getByRole('switch', { name: 'Hide scores' }));
    expect(screen.getByRole('link', { name: 'Open Chiefs at Bills' })).not.toHaveClass('is-flash');
  });

  it('asks for yesterday and names that day', async () => {
    const user = userEvent.setup();
    const yesterday = boardDay(-1);
    vi.mocked(sportsApi.getBoard).mockImplementation(async (_guild, date) => {
      if (date) return { data: { ...fullBoard([]), date: yesterday.iso } } as never;
      return { data: fullBoard() } as never;
    });
    renderPage();
    await screen.findByRole('heading', { name: 'Sports' });
    await user.click(screen.getByRole('button', { name: 'Yesterday' }));
    expect(await screen.findByRole('heading', { name: 'Sports · Yesterday' })).toBeInTheDocument();
    expect(sportsApi.getBoard).toHaveBeenCalledWith('g1', yesterday.compact);
    expect(screen.getByText('No games yesterday')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Chiefs at Bills' })).not.toBeInTheDocument();
  });

  it('opens a deep-linked day and keeps an out-of-range link on today', async () => {
    const day = boardDay(-2);
    vi.mocked(sportsApi.getBoard).mockImplementation(async (_guild, date) => {
      if (date) return { data: fullBoard([]) } as never;
      return { data: fullBoard() } as never;
    });
    renderPage(`/app/guilds/g1/sports?date=${day.iso}`);
    expect(await screen.findByRole('heading', { name: `Sports · ${day.label}` })).toBeInTheDocument();
    expect(sportsApi.getBoard).toHaveBeenCalledWith('g1', day.compact);
    expect(screen.getByText(`No games on ${day.label}`)).toBeInTheDocument();

    cleanup();
    useSportsStore.getState().reset();
    vi.mocked(sportsApi.getBoard).mockClear();
    renderPage('/app/guilds/g1/sports?date=2020-01-01');
    expect(await screen.findByRole('heading', { name: 'Sports' })).toBeInTheDocument();
    expect(sportsApi.getBoard).not.toHaveBeenCalledWith('g1', '20200101');
  });
});
