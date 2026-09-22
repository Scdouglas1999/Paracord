import { act, cleanup, render } from '@testing-library/react';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sportsApi, type SportsBoard, type SportsGame, type SportsSettings } from '../api/sports';
import { useSportsPolling, useSportsSettings } from './useSportsBoard';
import { useSportsStore } from '../stores/sportsStore';

vi.mock('../api/sports', () => ({
  sportsApi: {
    getSettings: vi.fn(),
    getBoard: vi.fn(),
    listLeagues: vi.fn(),
    updateSettings: vi.fn(),
  },
}));

function settings(enabled: boolean): SportsSettings {
  return {
    guild_id: 'g1',
    enabled,
    leagues: ['football/nfl'],
    favorite_teams: [],
    show_on_server_page: true,
    default_view: 'all',
    updated_at: '2026-09-21T12:00:00.000Z',
  };
}

function game(score: number, state: SportsGame['state'] = 'pre'): SportsGame {
  return {
    id: 'game-1',
    sport: 'football',
    league: 'NFL',
    league_path: 'football/nfl',
    name: 'Chiefs at Bills',
    start: '2026-09-21T20:00:00.000Z',
    state,
    detail: state === 'in' ? '4th quarter 7:58' : '',
    period: 4,
    clock: '7:58',
    clock_seconds: 478,
    home: {
      id: '2', abbr: 'BUF', name: 'Buffalo Bills', short_name: 'Bills', logo: '',
      score, record: null, possession: false, winner: false,
    },
    away: {
      id: '12', abbr: 'KC', name: 'Kansas City Chiefs', short_name: 'Chiefs', logo: '',
      score, record: null, possession: false, winner: false,
    },
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
    heat: 10,
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

function Harness({ poll, kind = 'page' }: { poll: boolean; kind?: 'page' | 'sidebar' }) {
  const { settings: current } = useSportsSettings('g1');
  useSportsPolling('g1', poll && current?.enabled === true, kind);
  return null;
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('sports polling', () => {
  beforeEach(() => {
    useSportsStore.getState().reset();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.mocked(sportsApi.getSettings).mockResolvedValue({ data: settings(true) } as never);
    vi.mocked(sportsApi.getBoard).mockResolvedValue({ data: board([game(0)]) } as never);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useSportsStore.getState().reset();
    vi.restoreAllMocks();
  });

  it('does not request a board when sports is off', async () => {
    vi.mocked(sportsApi.getSettings).mockResolvedValue({ data: settings(false) } as never);
    render(
      <>
        <Harness poll kind="page" />
        <Harness poll kind="sidebar" />
      </>,
    );
    await settle();
    expect(sportsApi.getSettings).toHaveBeenCalledTimes(1);
    expect(sportsApi.getBoard).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(sportsApi.getBoard).not.toHaveBeenCalled();
  });

  it('does not poll when nothing on screen is watching', async () => {
    render(<Harness poll={false} />);
    await settle();
    expect(sportsApi.getBoard).not.toHaveBeenCalled();
  });

  it('loads settings once when two surfaces ask', async () => {
    render(
      <>
        <Harness poll={false} />
        <Harness poll={false} />
      </>,
    );
    await settle();
    expect(sportsApi.getSettings).toHaveBeenCalledTimes(1);
  });

  it('polls every 60s when nothing is live and every 15s when a game is', async () => {
    vi.mocked(sportsApi.getBoard)
      .mockResolvedValueOnce({ data: board([game(0, 'pre')]) } as never)
      .mockResolvedValue({ data: board([game(7, 'in')]) } as never);

    render(<Harness poll />);
    await settle();
    expect(sportsApi.getBoard).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000);
    });
    expect(sportsApi.getBoard).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await settle();
    expect(sportsApi.getBoard).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_000);
    });
    expect(sportsApi.getBoard).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await settle();
    expect(sportsApi.getBoard).toHaveBeenCalledTimes(3);
  });

  it('pauses while the document is hidden and refreshes as soon as it is visible', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    render(<Harness poll />);
    await settle();
    expect(sportsApi.getBoard).toHaveBeenCalledTimes(1);

    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(sportsApi.getBoard).toHaveBeenCalledTimes(1);

    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(sportsApi.getBoard).toHaveBeenCalledTimes(2);
    hidden.mockRestore();
  });

  it('does not poll until the document is visible', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    render(<Harness poll />);
    await settle();
    expect(sportsApi.getSettings).toHaveBeenCalled();
    expect(sportsApi.getBoard).not.toHaveBeenCalled();

    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(sportsApi.getBoard).toHaveBeenCalledTimes(1);
    hidden.mockRestore();
  });

  it('keeps the last board when a later poll fails', async () => {
    vi.mocked(sportsApi.getBoard)
      .mockResolvedValueOnce({ data: board([game(3, 'in')]) } as never)
      .mockRejectedValueOnce(new Error('network down'));

    render(<Harness poll />);
    await settle();
    expect(useSportsStore.getState().byGuild.g1?.board?.games[0]?.home.score).toBe(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await settle();

    const entry = useSportsStore.getState().byGuild.g1;
    expect(entry?.board?.games[0]?.home.score).toBe(3);
    expect(entry?.boardError).toBe("Scores couldn't be loaded. Showing the last ones we got.");
  });

  it('remembers a score change so a row can flash', async () => {
    vi.mocked(sportsApi.getBoard)
      .mockResolvedValueOnce({ data: board([game(3, 'in')]) } as never)
      .mockResolvedValueOnce({ data: board([game(10, 'in')]) } as never);

    render(<Harness poll />);
    await settle();
    expect(useSportsStore.getState().byGuild.g1?.flashes['game-1']).toBeUndefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await settle();

    const until = useSportsStore.getState().byGuild.g1?.flashes['game-1']?.until ?? 0;
    expect(until - Date.now()).toBeGreaterThan(5_000);
    expect(until - Date.now()).toBeLessThanOrEqual(6_000);
  });

  it('stops polling when the board says sports is off', async () => {
    const err = new axios.AxiosError('missing');
    err.response = {
      status: 404,
      data: { message: 'off' },
      statusText: 'Not Found',
      headers: {},
      config: { headers: new axios.AxiosHeaders() },
    };
    vi.mocked(sportsApi.getBoard).mockRejectedValue(err);

    render(<Harness poll />);
    await settle();
    expect(sportsApi.getBoard).toHaveBeenCalledTimes(1);
    expect(useSportsStore.getState().byGuild.g1?.settings?.enabled).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(sportsApi.getBoard).toHaveBeenCalledTimes(1);
  });

  it('polls the sidebar every 60s even while a game is live', async () => {
    vi.mocked(sportsApi.getBoard).mockResolvedValue({ data: board([game(7, 'in')]) } as never);
    render(<Harness poll kind="sidebar" />);
    await settle();
    expect(sportsApi.getBoard).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(sportsApi.getBoard).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    await settle();
    expect(sportsApi.getBoard).toHaveBeenCalledTimes(2);
  });

  it('does not fetch again when the page opens inside the sidebar interval', async () => {
    vi.mocked(sportsApi.getBoard).mockResolvedValue({ data: board([game(7, 'in')]) } as never);
    const view = render(<Harness poll kind="sidebar" />);
    await settle();
    expect(sportsApi.getBoard).toHaveBeenCalledTimes(1);

    view.rerender(
      <>
        <Harness poll kind="sidebar" />
        <Harness poll kind="page" />
      </>,
    );
    await settle();
    expect(sportsApi.getBoard).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await settle();
    expect(sportsApi.getBoard).toHaveBeenCalledTimes(2);
  });
});
