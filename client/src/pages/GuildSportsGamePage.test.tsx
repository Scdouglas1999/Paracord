import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configureMotion, resetMotionSwitchForTests } from '../lib/motion/reducedMotion';
import { MemoryRouter, Route, Routes } from 'react-router';
import { sportsApi, type GameDetail, type SportsGame, type SportsTeam } from '../api/sports';
import { GuildSportsGamePage } from './GuildSportsGamePage';

vi.mock('../hooks/useGuilds', () => ({
  useGuild: () => ({ id: 'g1', name: 'Kestrel Robotics' }),
}));

vi.mock('../api/sports', async () => {
  const actual = await vi.importActual<typeof import('../api/sports')>('../api/sports');
  return {
    ...actual,
    sportsApi: { getGame: vi.fn() },
  };
});

function team(over: Partial<SportsTeam> & Pick<SportsTeam, 'id' | 'abbr' | 'name' | 'short_name'>): SportsTeam {
  return { logo: '', score: 0, record: null, possession: false, winner: false, ...over };
}

function game(over: Partial<SportsGame> = {}): SportsGame {
  return {
    id: '401872945',
    sport: 'football',
    league: 'NFL',
    league_path: 'football/nfl',
    name: 'Chiefs at Colts',
    start: '2026-09-21T20:00:00.000Z',
    state: 'in',
    detail: '2nd quarter 6:12',
    period: 2,
    clock: '6:12',
    clock_seconds: 372,
    home: team({ id: '11', abbr: 'IND', name: 'Indianapolis Colts', short_name: 'Colts', score: 27, record: '1-1' }),
    away: team({ id: '12', abbr: 'KC', name: 'Kansas City Chiefs', short_name: 'Chiefs', score: 24, record: '2-0', possession: true }),
    last_play: null,
    last_play_type: null,
    last_play_score: null,
    down_distance: '2nd & 6',
    red_zone: true,
    balls: null,
    strikes: null,
    outs: null,
    on_first: null,
    on_second: null,
    on_third: null,
    home_win_pct: 0.41,
    broadcasts: ['CBS'],
    heat: 80,
    tags: [],
    favorite: false,
    ...over,
  };
}

function footballDetail(over: Partial<GameDetail> = {}): GameDetail {
  return {
    fetched_at: '2026-09-21T18:00:00.000Z',
    stale: false,
    game: game(),
    kind: 'football',
    win_probability: [{ home_pct: 77 }, { home_pct: 41 }],
    scoring_plays: [{ text: 'Taylor scores', period: 2, clock: '6:20', team_id: '12', home_score: 27, away_score: 24 }],
    football: {
      possession_team_id: '12',
      ball_on: 14,
      down: 2,
      distance: 6,
      yards_to_endzone: 14,
      down_distance_text: '2nd and 6',
      red_zone: true,
      drives: [
        {
          id: 'd1',
          team_id: '11',
          description: 'Opening kick',
          result: 'Kickoff',
          is_score: false,
          start_yard: 65,
          end_yard: 32,
          plays: [{
            id: 'p1',
            text: 'S.Shrader kicks 58 yards from IND 35.',
            type: 'Kickoff',
            period: 1,
            clock: '15:00',
            start_yard: 65,
            end_yard: 32,
            down: null,
            distance: null,
            yards: 25,
            scoring: false,
            team_id: '11',
          }],
        },
        {
          id: 'd2',
          team_id: '12',
          description: 'Chiefs drive',
          result: null,
          is_score: false,
          start_yard: 32,
          end_yard: 14,
          live: true,
          plays: [
            {
              id: 'p2',
              text: '1st and 10 at the IND 32. Handoff.',
              type: 'Rush',
              period: 2,
              clock: '8:01',
              start_yard: 32,
              end_yard: 20,
              down: 1,
              distance: 10,
              yards: 12,
              scoring: false,
              team_id: '12',
            },
            {
              id: 'p3',
              text: '2nd and 6 at the Colts 14. Taylor right end for 4 yards.',
              type: 'Rush',
              period: 2,
              clock: '6:12',
              start_yard: 20,
              end_yard: 14,
              down: 2,
              distance: 6,
              yards: 4,
              scoring: false,
              team_id: '12',
            },
          ],
        },
      ],
    },
    ...over,
  };
}

function renderGame(path = '/app/guilds/g1/sports/football/nfl/401872945') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/guilds/:guildId/sports/:sport/:league/:eventId" element={<GuildSportsGamePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function httpError(status: number, message: string) {
  const err = new axios.AxiosError('Request failed');
  err.response = {
    status,
    statusText: 'error',
    headers: {},
    config: { headers: new axios.AxiosHeaders() },
    data: { message },
  };
  return err;
}

describe('GuildSportsGamePage', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(sportsApi.getGame).mockReset();
    vi.mocked(sportsApi.getGame).mockResolvedValue({ data: footballDetail() } as never);
  });

  it('loads a deep link and opens the field on the live play', async () => {
    const user = userEvent.setup();
    renderGame();
    expect(await screen.findByRole('heading', { name: 'Chiefs at Colts' })).toBeInTheDocument();
    expect(sportsApi.getGame).toHaveBeenCalledWith('g1', 'football', 'nfl', '401872945');
    expect(screen.getByRole('link', { name: 'Back to Sports' })).toHaveAttribute('href', '/app/guilds/g1/sports');
    expect(screen.getByText('27')).toBeInTheDocument();
    expect(screen.getByText('On CBS')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Ball on the IND 14/ })).toBeInTheDocument();
    expect(screen.getByText('Colts win probability started at 77% and is now 41%.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'This drive' })).toHaveAttribute('aria-selected', 'true');
    expect(document.querySelector('[aria-current="step"]')).toHaveTextContent('Taylor right end for 4 yards');
    await user.click(screen.getByRole('tab', { name: 'Scoring' }));
    expect(screen.getByRole('region', { name: 'Scoring plays' })).toHaveTextContent('Taylor scores');
  });

  it('steps an earlier drive and replays it from the start', async () => {
    const user = userEvent.setup();
    renderGame();
    await screen.findByRole('heading', { name: 'Chiefs at Colts' });

    await user.click(screen.getByRole('button', { name: 'Previous play' }));
    const stepped = document.querySelector('[aria-current="step"]');
    expect(stepped).toHaveTextContent('1st and 10 at the IND 32');
    expect(stepped).toHaveClass('is-current');

    await user.click(screen.getByRole('button', { name: 'Play this drive' }));
    expect(document.querySelector('[aria-current="step"]')).toHaveTextContent('1st and 10 at the IND 32');

    await user.click(screen.getByRole('tab', { name: 'All drives' }));
    await user.click(screen.getByRole('button', { name: 'IND 1 · Kickoff' }));
    expect(document.querySelector('[aria-current="step"]')).toHaveTextContent('S.Shrader kicks 58 yards');
  });

  it('scrolls the highlighted play into view, and skips the glide when motion is reduced', async () => {
    const user = userEvent.setup();
    const scrollTo = vi.fn();
    const original = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = scrollTo;
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('pc-sports-plays-body')) {
        return { x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 120, width: 200, height: 120, toJSON() { return {}; } };
      }
      if (this.getAttribute('aria-current') === 'step') {
        return { x: 0, y: 400, top: 400, left: 0, right: 200, bottom: 440, width: 200, height: 40, toJSON() { return {}; } };
      }
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() { return {}; } };
    });
    try {
      renderGame();
      await screen.findByRole('heading', { name: 'Chiefs at Colts' });
      expect(document.querySelector('[aria-current="step"]')).toHaveClass('is-current');
      scrollTo.mockClear();
      await user.click(screen.getByRole('button', { name: 'Previous play' }));
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));

      scrollTo.mockClear();
      configureMotion('reduced');
      await user.click(screen.getByRole('button', { name: 'Next play' }));
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
    } finally {
      HTMLElement.prototype.scrollTo = original;
      rect.mockRestore();
      resetMotionSwitchForTests();
    }
  });

  it('hides the score, the chart and the scoring plays together', async () => {
    const user = userEvent.setup();
    renderGame();
    await screen.findByText('27');
    await user.click(screen.getByRole('switch', { name: 'Hide scores' }));
    expect(screen.getByText('Scores hidden')).toBeInTheDocument();
    expect(screen.queryByText('27')).not.toBeInTheDocument();
    expect(screen.queryByText(/win probability/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Scoring' })).not.toBeInTheDocument();
    expect(screen.queryByText('Taylor scores')).not.toBeInTheDocument();
    expect(screen.getByText('1-1')).toBeInTheDocument();
  });

  it('says when the last update is stale', async () => {
    vi.mocked(sportsApi.getGame).mockResolvedValue({ data: footballDetail({ stale: true }) } as never);
    renderGame();
    expect(await screen.findByText('Showing the last update. The live feed did not answer.')).toBeInTheDocument();
  });

  it('shows a plain message for a sport without a field', async () => {
    vi.mocked(sportsApi.getGame).mockResolvedValue({
      data: footballDetail({
        kind: 'other',
        football: null,
        game: game({ sport: 'basketball', league: 'NBA', league_path: 'basketball/nba' }),
      }),
    } as never);
    renderGame('/app/guilds/g1/sports/basketball/nba/401872945');
    expect(await screen.findByText('A live field is available for football and baseball games.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Flat view' })).not.toBeInTheDocument();
    expect(screen.getByText('Colts win probability started at 77% and is now 41%.')).toBeInTheDocument();
  });

  it('plots pitches, the legend, and a named runner', async () => {
    vi.mocked(sportsApi.getGame).mockResolvedValue({
      data: {
        fetched_at: '2026-09-21T18:00:00.000Z',
        stale: false,
        kind: 'baseball',
        win_probability: [],
        scoring_plays: [],
        game: game({
          sport: 'baseball',
          league: 'MLB',
          league_path: 'baseball/mlb',
          detail: 'Top 7th',
          home: team({ id: 'bos', abbr: 'BOS', name: 'Boston Red Sox', short_name: 'Red Sox', score: 2, color: '0c2340' }),
          away: team({ id: 'bal', abbr: 'BAL', name: 'Baltimore Orioles', short_name: 'Orioles', score: 3, color: 'df4601' }),
        }),
        baseball: {
          inning: 7,
          half: 'top',
          balls: 2,
          strikes: 1,
          outs: 1,
          bases: {
            first: null,
            second: { id: 's', name: 'John Smith', short_name: 'Smith', headshot: 'https://a.espncdn.com/i/headshots/mlb/players/full/123.png' },
            third: null,
          },
          pitcher: null,
          batter: { id: 'b', name: 'Lee', short_name: 'Lee', headshot: '' },
          bats: 'R',
          strike_zone: { left: 86, right: 149, top: 148, bottom: 196 },
          at_bats: [{
            id: 'ab1',
            inning: 7,
            half: 'top',
            batter: { id: 'b', name: 'Lee', short_name: 'Lee', headshot: '' },
            pitcher: null,
            result_text: 'Fly ball',
            scoring: false,
            live: true,
            hit: { x: 140, y: 110, trajectory: 'fly' },
            pitches: [
              { n: 1, x: 110, y: 170, type: 'Slider', type_abbr: 'SL', velocity: 84, result: 'strike-looking', text: null },
              { n: 2, x: 169, y: 124, type: 'Four-seam FB', type_abbr: 'FF', velocity: 94, result: 'ball', text: null },
            ],
          }],
        },
      },
    } as never);
    renderGame('/app/guilds/g1/sports/baseball/mlb/401872945');
    expect(await screen.findByRole('img', { name: /^Top of the 7/ })).toBeInTheDocument();
    expect(screen.getByText('Four-seam FB')).toBeInTheDocument();
    expect(screen.getByText('94 mph')).toBeInTheDocument();
    expect(screen.getByText('Top 7th · 2-1 · 1 out')).toBeInTheDocument();
    expect(screen.getByText('Bats R')).toBeInTheDocument();
    expect(screen.getAllByText('Called strike').length).toBeGreaterThan(0);
    expect(screen.getByText('Swinging strike')).toBeInTheDocument();
    expect(screen.getByText('In play')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Lee/ })).toHaveAttribute('aria-pressed', 'true');
    const diamond = screen.getByRole('img', { name: /Smith on second/ });
    const fills = [...diamond.querySelectorAll('rect')].map((node) => node.getAttribute('fill') ?? '');
    expect(fills.some((fill) => fill.toLowerCase().endsWith('df4601'))).toBe(true);
    const chip = document.querySelector('.pc-sports-runner-name');
    expect(chip?.textContent).toContain('Smith');
    expect(chip?.querySelector('img')?.getAttribute('src')).toContain('espncdn.com');
  });

  it('opens a finished football game on the last scoring drive', async () => {
    const finished = footballDetail({
      game: game({
        state: 'post',
        detail: 'Final/OT',
        home: team({ id: '11', abbr: 'KC', name: 'Kansas City Chiefs', short_name: 'Chiefs', score: 33, record: '2-0', winner: true }),
        away: team({ id: '12', abbr: 'IND', name: 'Indianapolis Colts', short_name: 'Colts', score: 30, record: '0-2' }),
      }),
      win_probability: [{ home_pct: 77 }, { home_pct: 100 }],
    });
    finished.football = {
      ...finished.football!,
      possession_team_id: '11',
      drives: [
        finished.football!.drives[0],
        {
          id: 'score',
          team_id: '11',
          description: 'Scoring drive',
          result: 'Touchdown',
          is_score: true,
          start_yard: 80,
          end_yard: 100,
          plays: [{
            id: 'td',
            text: 'Taylor scores from the 2.',
            type: 'Rush',
            period: 5,
            clock: '0:00',
            start_yard: 98,
            end_yard: 100,
            down: 1,
            distance: 2,
            yards: 2,
            scoring: true,
            team_id: '11',
          }],
        },
        {
          id: 'end',
          team_id: '11',
          description: 'End of game',
          result: 'End of Game',
          is_score: false,
          start_yard: null,
          end_yard: null,
          plays: [{
            id: 'end-play',
            text: 'End of game.',
            type: 'End of Game',
            period: 5,
            clock: '0:00',
            start_yard: null,
            end_yard: null,
            down: null,
            distance: null,
            yards: null,
            scoring: false,
            team_id: '11',
          }],
        },
      ],
    };
    vi.mocked(sportsApi.getGame).mockResolvedValue({ data: finished } as never);
    renderGame();
    expect(await screen.findByText('Final — replay any drive')).toBeInTheDocument();
    const scores = document.querySelectorAll('.pc-sports-bigscore');
    expect(scores[0]).toHaveClass('is-dim');
    expect(scores[1]).not.toHaveClass('is-dim');
    expect(screen.queryByText(/has the ball/)).not.toBeInTheDocument();
    expect(screen.getByText('Chiefs win probability started at 77% and finished at 100%.')).toBeInTheDocument();
    expect(document.querySelector('[aria-current="step"]')).toHaveTextContent('Taylor scores from the 2');
    expect(screen.queryByText('End of game.')).not.toBeInTheDocument();
  });

  it('says Final for a finished baseball game and still draws the zone', async () => {
    vi.mocked(sportsApi.getGame).mockResolvedValue({
      data: {
        fetched_at: '2026-09-21T18:00:00.000Z',
        stale: false,
        kind: 'baseball',
        win_probability: [],
        scoring_plays: [],
        game: game({
          state: 'post',
          detail: 'Final',
          sport: 'baseball',
          league: 'MLB',
          league_path: 'baseball/mlb',
          home: team({ id: 'nym', abbr: 'NYM', name: 'New York Mets', short_name: 'Mets', score: 2, winner: false }),
          away: team({ id: 'phi', abbr: 'PHI', name: 'Philadelphia Phillies', short_name: 'Phillies', score: 7, winner: true }),
        }),
        football: null,
        baseball: {
          inning: null,
          half: null,
          balls: null,
          strikes: null,
          outs: null,
          bases: { first: null, second: null, third: null },
          pitcher: null,
          batter: null,
          bats: null,
          strike_zone: null,
          at_bats: [{
            id: 'last',
            inning: 9,
            half: 'bottom',
            batter: { id: 'b', name: 'Alonso', short_name: 'Alonso', headshot: '' },
            pitcher: null,
            result_text: 'Ground out',
            scoring: false,
            pitches: [
              { n: 1, x: 110, y: 170, type: 'Slider', type_abbr: 'SL', velocity: 88, result: 'strike-looking', text: null },
            ],
            hit: null,
          }],
        },
      },
    } as never);
    renderGame('/app/guilds/g1/sports/baseball/mlb/401817017');
    expect(await screen.findByRole('img', { name: /^Final/ })).toBeInTheDocument();
    expect(screen.getAllByText('Final').length).toBeGreaterThan(0);
    expect(screen.queryByText(/0 outs/)).not.toBeInTheDocument();
    expect(screen.queryByText('Bats either')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Alonso/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('img', { name: /1 pitch/ })).toBeInTheDocument();
  });

  it.each([
    [404, 'Sports is turned off for this server.'],
    [400, 'That game is not on a league this server follows.'],
    [502, 'The live feed did not answer. Try again in a moment.'],
  ])('says what a %s means', async (status, message) => {
    vi.mocked(sportsApi.getGame).mockRejectedValue(httpError(status, message));
    renderGame();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Sports' })).toBeInTheDocument();
  });
});
