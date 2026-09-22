import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { sportsApi, type GameDetail } from '../api/sports';
import { useGameDetail } from './useGameDetail';

vi.mock('../api/sports', async () => {
  const actual = await vi.importActual<typeof import('../api/sports')>('../api/sports');
  return {
    ...actual,
    sportsApi: { getGame: vi.fn() },
  };
});

function detail(state: 'pre' | 'in' | 'post'): GameDetail {
  return {
    fetched_at: '2026-09-21T18:00:00.000Z',
    stale: false,
    kind: 'other',
    win_probability: [],
    scoring_plays: [],
    game: {
      id: '401872945',
      sport: 'basketball',
      league: 'NBA',
      league_path: 'basketball/nba',
      name: 'Game',
      start: '2026-09-21T23:00:00.000Z',
      state,
      detail: '',
      period: null,
      clock: null,
      clock_seconds: null,
      home: { id: 'h', abbr: 'H', name: 'Home', short_name: 'Home', logo: '', score: 1, record: null, possession: false, winner: false },
      away: { id: 'a', abbr: 'A', name: 'Away', short_name: 'Away', logo: '', score: 0, record: null, possession: false, winner: false },
      last_play: null,
      last_play_type: null,
      last_play_score: null,
      down_distance: null,
      ball_on: null,
      possession_team_id: null,
      yards_to_endzone: null,
      red_zone: null,
      balls: null,
      strikes: null,
      outs: null,
      on_first: null,
      on_second: null,
      on_third: null,
      home_win_pct: null,
      broadcasts: [],
      heat: 0,
      tags: [],
      favorite: false,
    },
  };
}

function Harness() {
  useGameDetail('g1', 'football', 'nfl', '401872945');
  return null;
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('useGameDetail', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.mocked(sportsApi.getGame).mockReset();
    vi.mocked(sportsApi.getGame).mockResolvedValue({ data: detail('in') } as never);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls a live game every 10 seconds and stops when the view unmounts', async () => {
    const view = render(<Harness />);
    await settle();
    expect(sportsApi.getGame).toHaveBeenCalledTimes(1);
    expect(sportsApi.getGame).toHaveBeenCalledWith('g1', 'football', 'nfl', '401872945');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await settle();
    expect(sportsApi.getGame).toHaveBeenCalledTimes(2);

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(sportsApi.getGame).toHaveBeenCalledTimes(2);
  });

  it('waits 60 seconds when the game is not live', async () => {
    vi.mocked(sportsApi.getGame).mockResolvedValue({ data: detail('pre') } as never);
    render(<Harness />);
    await settle();
    expect(sportsApi.getGame).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(sportsApi.getGame).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50_000);
    });
    await settle();
    expect(sportsApi.getGame).toHaveBeenCalledTimes(2);
  });

  it('does not keep asking after the server says the game is unavailable', async () => {
    const err = new axios.AxiosError('missing');
    err.response = {
      status: 404,
      data: { message: 'Sports is turned off for this server.' },
      statusText: 'Not Found',
      headers: {},
      config: { headers: new axios.AxiosHeaders() },
    };
    vi.mocked(sportsApi.getGame).mockRejectedValue(err);
    render(<Harness />);
    await settle();
    expect(sportsApi.getGame).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(sportsApi.getGame).toHaveBeenCalledTimes(1);
  });
});
