import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sportsApi, type SportsGame, type SportsSettings } from '../../api/sports';
import { resetGameDetailWatchers } from '../../hooks/useGameDetail';
import { configureMotion, resetMotionSwitchForTests } from '../../lib/motion/reducedMotion';
import { useSportsStore } from '../../stores/sportsStore';
import { ChannelAmbient, AmbientStrip, PinGameButton } from './ChannelPin';
import { ScoringTimeline } from './ScoringTimeline';
import { PitcherCharts } from './PitcherCharts';

vi.mock('../../api/sports', async () => {
  const actual = await vi.importActual<typeof import('../../api/sports')>('../../api/sports');
  return {
    ...actual,
    sportsApi: {
      ...actual.sportsApi,
      pinGame: vi.fn(),
      unpinGame: vi.fn(),
      getSettings: vi.fn(),
      getBoard: vi.fn(),
      getGame: vi.fn(async () => ({ data: {
        fetched_at: '', stale: false, kind: 'football', win_probability: [], scoring_plays: [],
        line_score: null, leaders: [], probables: [], box: null,
        game: {
          id: '401872945', sport: 'football', league: 'NFL', league_path: 'football/nfl', name: 'Game',
          start: '2026-09-21T20:00:00.000Z', state: 'in', detail: '2nd 6:12', period: 2, clock: '6:12',
          clock_seconds: 372, home: { id: '11', abbr: 'IND', name: 'IND', short_name: 'IND', logo: '', score: 27, record: null, possession: false, winner: false },
          away: { id: '12', abbr: 'KC', name: 'KC', short_name: 'KC', logo: '', score: 24, record: null, possession: true, winner: false },
          last_play: 'Taylor scores', last_play_type: null, last_play_score: null, down_distance: '2nd & 6',
          ball_on: 40, possession_team_id: '12', yards_to_endzone: 40, red_zone: false,
          balls: null, strikes: null, outs: null, on_first: null, on_second: null, on_third: null,
          home_win_pct: null, broadcasts: [], heat: 0, tags: [], favorite: false,
        },
        football: { possession_team_id: '12', ball_on: 40, down: 2, distance: 6, yards_to_endzone: 40, down_distance_text: '2nd & 6', red_zone: false, drives: [] },
      } })),
    },
  };
});

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => mockPerms,
}));

vi.mock('../../hooks/useChannels', () => ({
  useGuildChannels: () => mockChannels,
}));

const mockPerms = { permissions: 0n, isAdmin: false, isLoading: false };
let mockChannels: { id: string; name: string; type: number; channel_type: number }[] = [];

function team(id: string, abbr: string) {
  return {
    id, abbr, name: abbr, short_name: abbr, logo: '', score: abbr === 'KC' ? 24 : 27,
    record: null, possession: false, winner: false,
  };
}

function game(over: Partial<SportsGame> = {}): SportsGame {
  return {
    id: '401872945', sport: 'football', league: 'NFL', league_path: 'football/nfl', name: 'Game',
    start: '2026-09-21T20:00:00.000Z', state: 'in', detail: '2nd 6:12', period: 2, clock: '6:12',
    clock_seconds: 372, home: team('11', 'IND'), away: team('12', 'KC'),
    last_play: 'Taylor scores', last_play_type: null, last_play_score: null,
    down_distance: '2nd & 6', ball_on: 40, possession_team_id: '12', yards_to_endzone: 40,
    red_zone: false, balls: null, strikes: null, outs: null, on_first: null, on_second: null, on_third: null,
    home_win_pct: null, broadcasts: [], heat: 0, tags: [], favorite: false,
    ...over,
  };
}

function settings(pins: SportsSettings['channel_pins']): SportsSettings {
  return {
    guild_id: 'g1', enabled: true, leagues: ['football/nfl'], favorite_teams: [],
    show_on_server_page: false, default_view: 'all', updated_at: '2026-09-22T00:00:00.000Z',
    channel_pins: pins,
  };
}

describe('pin picker', () => {
  beforeEach(() => {
    mockPerms.permissions = 0n;
    mockPerms.isAdmin = false;
    mockChannels = [{ id: 'c1', name: 'general', type: 0, channel_type: 0 }];
    vi.mocked(sportsApi.pinGame).mockReset();
  });

  it('stays hidden without permission to manage channels', () => {
    render(<PinGameButton guildId="g1" game={game()} />);
    expect(screen.queryByRole('button', { name: 'Pin to a channel' })).not.toBeInTheDocument();
  });

  it('pins the open game to a text channel', async () => {
    mockPerms.isAdmin = true;
    vi.mocked(sportsApi.pinGame).mockResolvedValue({ data: settings([]) } as never);
    const user = userEvent.setup();
    render(<PinGameButton guildId="g1" game={game()} />);
    await user.click(screen.getByRole('button', { name: 'Pin to a channel' }));
    await user.click(screen.getByRole('button', { name: '#general' }));
    expect(sportsApi.pinGame).toHaveBeenCalledWith('g1', 'c1', 'football/nfl/401872945', { unpin_at_final: false });
  });

  it('can pin a game until its final', async () => {
    mockPerms.isAdmin = true;
    vi.mocked(sportsApi.pinGame).mockResolvedValue({ data: settings([]) } as never);
    const user = userEvent.setup();
    render(<PinGameButton guildId="g1" game={game()} />);
    await user.click(screen.getByRole('button', { name: 'Pin to a channel' }));
    const until = screen.getByRole('switch', { name: 'Unpin at the final' });
    expect(until).toHaveAttribute('aria-checked', 'false');
    await user.click(until);
    await user.click(screen.getByRole('button', { name: '#general' }));
    expect(sportsApi.pinGame).toHaveBeenCalledWith('g1', 'c1', 'football/nfl/401872945', { unpin_at_final: true });
  });
});

describe('a phone turned on its side', () => {
  const realMatch = window.matchMedia;
  const realOrientation = Object.getOwnPropertyDescriptor(window.screen, 'orientation');
  let orientationType = 'portrait-primary';

  function turn(type: 'portrait-primary' | 'landscape-primary', width: number, height: number) {
    orientationType = type;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
  }

  beforeEach(() => {
    useSportsStore.getState().reset();
    resetGameDetailWatchers();
    mockPerms.isAdmin = true;
    window.matchMedia = ((query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    Object.defineProperty(window.screen, 'orientation', {
      configurable: true,
      get: () => ({ type: orientationType, addEventListener: () => {}, removeEventListener: () => {} }),
    });
    turn('portrait-primary', 390, 844);
  });

  afterEach(() => {
    window.matchMedia = realMatch;
    if (realOrientation) Object.defineProperty(window.screen, 'orientation', realOrientation);
    else Reflect.deleteProperty(window.screen, 'orientation');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
  });

  it('fills the screen with the live field, and stays closed once closed until turned again', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AmbientStrip guildId="g1" channelId="c1" game={game()} untilFinal canUnpin onUnpin={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Pinned until the final')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    turn('landscape-primary', 844, 390);
    const stage = await screen.findByRole('dialog', { name: /Pinned game/ });
    expect(stage.querySelector('.pc-sports-pin-stage')).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Back to the chat' }));

    await user.click(screen.getByRole('button', { name: 'Back to the chat' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    turn('landscape-primary', 840, 386);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    turn('portrait-primary', 390, 844);
    turn('landscape-primary', 844, 390);
    expect(await screen.findByRole('dialog', { name: /Pinned game/ })).toBeInTheDocument();
    turn('portrait-primary', 390, 844);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('leaves a game that is not live, and someone typing, where they are', () => {
    const { unmount } = render(
      <MemoryRouter>
        <AmbientStrip guildId="g1" channelId="c1" game={game({ state: 'post', detail: 'Final' })} canUnpin={false} onUnpin={() => {}} />
      </MemoryRouter>,
    );
    turn('landscape-primary', 844, 390);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    unmount();

    turn('portrait-primary', 390, 844);
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    input.focus();
    render(
      <MemoryRouter>
        <AmbientStrip guildId="g1" channelId="c1" game={game()} canUnpin={false} onUnpin={() => {}} />
      </MemoryRouter>,
    );
    turn('landscape-primary', 844, 390);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    input.remove();
  });

  it('is not a desktop window dragged short', () => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    render(
      <MemoryRouter>
        <AmbientStrip guildId="g1" channelId="c1" game={game()} canUnpin={false} onUnpin={() => {}} />
      </MemoryRouter>,
    );
    turn('landscape-primary', 1200, 420);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('ambient strip', () => {
  beforeEach(() => {
    useSportsStore.getState().reset();
    mockPerms.isAdmin = true;
  });

  it('summarises the score and unpins', async () => {
    const user = userEvent.setup();
    const onUnpin = vi.fn();
    render(
      <MemoryRouter>
        <AmbientStrip guildId="g1" channelId="c1" game={game()} canUnpin onUnpin={onUnpin} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('region', { name: /Pinned game/ })).toHaveTextContent('KC');
    expect(screen.getByRole('region', { name: /Pinned game/ })).toHaveTextContent('24');
    expect(screen.getByText('Taylor scores')).toBeInTheDocument();
    expect(screen.getByText('KC 24 · 2nd 6:12 · 27 IND')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Unpin' }));
    expect(onUnpin).toHaveBeenCalled();
  });

  it('reads the last play from the game detail when the board left it out', async () => {
    vi.mocked(sportsApi.getGame).mockResolvedValue({
      data: { football: { drives: [{ plays: [{ text: 'Mahomes pass complete.' }] }] } },
    } as never);
    render(
      <MemoryRouter>
        <AmbientStrip guildId="g1" channelId="c1" game={game({ last_play: null })} canUnpin={false} onUnpin={vi.fn()} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Mahomes pass complete.')).toBeInTheDocument();
  });

  it('hides the unpin control without permission', () => {
    render(
      <MemoryRouter>
        <AmbientStrip guildId="g1" channelId="c1" game={game()} canUnpin={false} onUnpin={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: 'Unpin' })).not.toBeInTheDocument();
  });

  it('disappears when the pin is pruned', async () => {
    const pinned = settings([{ channel_id: 'c1', game: 'football/nfl/401872945', pinned_by: 'u', pinned_at: '2026-09-22T00:00:00.000Z' }]);
    vi.mocked(sportsApi.getBoard).mockResolvedValue({ data: { fetched_at: '', leagues: [], games: [game()] } } as never);
    vi.mocked(sportsApi.getSettings).mockResolvedValue({ data: pinned } as never);
    useSportsStore.getState().adoptSettings(pinned);
    useSportsStore.getState().adoptBoard('g1', { fetched_at: '', leagues: [], games: [game()] });
    const { rerender } = render(
      <MemoryRouter>
        <ChannelAmbient guildId="g1" channelId="c1" />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('Pinned game')).toBeInTheDocument();
    act(() => {
      useSportsStore.getState().adoptSettings(settings([]));
    });
    rerender(
      <MemoryRouter>
        <ChannelAmbient guildId="g1" channelId="c1" />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Pinned game')).not.toBeInTheDocument();
  });

  it('remembers an expanded game night for this viewer', async () => {
    const user = userEvent.setup();
    localStorage.clear();
    const ui = (
      <MemoryRouter>
        <AmbientStrip guildId="g1" channelId="c1" game={game()} canUnpin={false} onUnpin={vi.fn()} />
      </MemoryRouter>
    );
    const view = render(ui);
    expect(document.querySelector('.pc-sports-pin-stage')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Expand the game' }));
    expect(document.querySelector('.pc-sports-pin-stage .pc-sports-field-svg')).not.toBeNull();
    expect(screen.getByRole('region', { name: /Pinned game/ })).toHaveClass('is-open');
    expect(localStorage.getItem('paracord.sports.game-night')).toContain('"c1":true');
    view.unmount();
    resetGameDetailWatchers();
    render(ui);
    expect(screen.getByRole('button', { name: 'Collapse the game' })).toBeInTheDocument();
    expect(document.querySelector('.pc-sports-pin-stage')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Collapse the game' }));
    expect(document.querySelector('.pc-sports-pin-stage')).toBeNull();
    expect(localStorage.getItem('paracord.sports.game-night')).toContain('"c1":false');
    resetGameDetailWatchers();
  });

  it('flashes the collapsed strip when the next poll scores', async () => {
    useSportsStore.getState().adoptSettings(settings([]));
    const quiet = game({
      away: { ...game().away, score: 0 },
      home: { ...game().home, score: 0 },
      last_play_type: null,
    });
    const scored = game({
      away: { ...game().away, score: 7 },
      home: { ...game().home, score: 0 },
      last_play_type: 'Passing Touchdown',
      last_play: 'Jones touchdown',
      last_play_score: 6,
    });
    let phase = quiet;
    vi.mocked(sportsApi.getBoard).mockImplementation(async () => ({ data: { fetched_at: '', leagues: [], games: [phase] } } as never));
    await act(async () => {
      await useSportsStore.getState().refreshBoard('g1');
    });
    render(
      <MemoryRouter>
        <AmbientStrip guildId="g1" channelId="c1" game={quiet} canUnpin={false} onUnpin={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Touchdown')).not.toBeInTheDocument();
    phase = scored;
    await act(async () => {
      await useSportsStore.getState().refreshBoard('g1');
    });
    expect(screen.getByText('Touchdown')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Pinned game/ })).toHaveClass('is-score');
  });

  it('keeps the chip and skips the colour flash when motion is reduced', async () => {
    configureMotion('reduced');
    useSportsStore.getState().adoptSettings(settings([]));
    const quiet = game({ away: { ...game().away, score: 0 }, home: { ...game().home, score: 0 } });
    const scored = game({
      away: { ...game().away, score: 3 },
      home: { ...game().home, score: 0 },
      last_play_type: 'Field Goal Good',
      last_play_score: 3,
    });
    let phase = quiet;
    vi.mocked(sportsApi.getBoard).mockImplementation(async () => ({ data: { fetched_at: '', leagues: [], games: [phase] } } as never));
    await act(async () => {
      await useSportsStore.getState().refreshBoard('g1');
    });
    render(
      <MemoryRouter>
        <AmbientStrip guildId="g1" channelId="c1" game={quiet} canUnpin={false} onUnpin={vi.fn()} />
      </MemoryRouter>,
    );
    phase = scored;
    await act(async () => {
      await useSportsStore.getState().refreshBoard('g1');
    });
    expect(screen.getByText('Field goal')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Pinned game/ })).not.toHaveClass('is-score');
    resetMotionSwitchForTests();
  });
});

describe('timeline and pitching panels', () => {
  it('renders a scoring list and the progression sentence', () => {
    render(
      <ScoringTimeline
        sport="football"
        hideScores={false}
        game={game()}
        plays={[
          { text: 'Away score', period: 1, clock: '8:00', team_id: '12', home_score: 0, away_score: 7 },
          { text: 'Home answers', period: 1, clock: '2:00', team_id: '11', home_score: 10, away_score: 7 },
        ]}
      />,
    );
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getByText('Lead change')).toBeInTheDocument();
    expect(screen.getByText('KC 7, IND 10 after 2 scoring plays.')).toBeInTheDocument();
    expect(screen.getByText('1st')).toBeInTheDocument();
  });

  it('hides the chart when scores are hidden', () => {
    render(
      <ScoringTimeline
        sport="football"
        hideScores
        game={game()}
        plays={[{ text: 'Away score', period: 1, clock: '8:00', team_id: '12', home_score: 0, away_score: 7 }]}
      />,
    );
    expect(screen.queryByRole('img', { name: /after/ })).not.toBeInTheDocument();
    expect(screen.queryByText('7')).not.toBeInTheDocument();
  });

  it('renders one pitcher at a time', () => {
    render(
      <PitcherCharts
        atBats={[{
          id: 'ab', inning: 1, half: 'top', batter: null,
          pitcher: { id: 'p', name: 'Sale', short_name: 'Sale', headshot: '', position: 'SP' },
          result_text: null, scoring: false, hit: null,
          pitches: [
            { n: 1, x: 1, y: 1, type: 'Slider', type_abbr: 'SL', velocity: 86, result: 'strike-swinging', text: null },
            { n: 2, x: 1, y: 1, type: 'Slider', type_abbr: 'SL', velocity: 84, result: 'ball', text: null },
          ],
        }]}
      />,
    );
    expect(screen.getByRole('region', { name: 'Pitching' })).toBeInTheDocument();
    expect(screen.getByText('Slider')).toBeInTheDocument();
    expect(screen.getAllByText(/2 pitches/).length).toBeGreaterThan(0);
    expect(screen.getByText('86')).toBeInTheDocument();
  });
});
