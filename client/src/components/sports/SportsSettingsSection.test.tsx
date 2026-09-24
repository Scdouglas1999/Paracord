import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sportsApi, type SportsSettings } from '../../api/sports';
import { toast } from '../../stores/toastStore';
import { useSportsStore } from '../../stores/sportsStore';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { SportsSettingsSection } from './SportsSettingsSection';

vi.mock('../../api/sports', async () => {
  const actual = await vi.importActual<typeof import('../../api/sports')>('../../api/sports');
  return {
    ...actual,
    sportsApi: {
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      listLeagues: vi.fn(),
      getBoard: vi.fn(),
      listTeams: vi.fn(),
    },
  };
});

vi.mock('../../stores/toastStore', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function settings(over: Partial<SportsSettings> = {}): SportsSettings {
  return {
    guild_id: 'guild-1',
    enabled: true,
    leagues: ['football/nfl', 'baseball/mlb'],
    favorite_teams: [],
    show_on_server_page: true,
    default_view: 'all',
    layout: 'cards',
    updated_at: '2026-09-21T12:00:00.000Z',
    ...over,
  };
}

const catalog = {
  leagues: [
    { path: 'football/nfl', label: 'NFL', sport: 'football' },
    { path: 'baseball/mlb', label: 'MLB', sport: 'baseball' },
  ],
};

const board = {
  fetched_at: '2026-09-21T18:00:00.000Z',
  leagues: [
    { path: 'football/nfl', label: 'NFL', error: null },
    { path: 'baseball/mlb', label: 'MLB', error: null },
  ],
  games: [
    {
      id: 'g',
      sport: 'football',
      league: 'NFL',
      league_path: 'football/nfl',
      name: 'Chiefs at Bills',
      start: '2026-09-21T20:00:00.000Z',
      state: 'pre',
      detail: '',
      period: null,
      clock: null,
      clock_seconds: null,
      home: {
        id: '2', abbr: 'BUF', name: 'Buffalo Bills', short_name: 'Bills', logo: '',
        score: null, record: null, possession: false, winner: false,
      },
      away: {
        id: '12', abbr: 'KC', name: 'Kansas City Chiefs', short_name: 'Chiefs', logo: '',
        score: null, record: null, possession: false, winner: false,
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
      heat: 0,
      tags: [],
      favorite: false,
    },
  ],
};

describe('SportsSettingsSection', () => {
  beforeEach(() => {
    useSportsStore.getState().reset();
    vi.clearAllMocks();
    vi.mocked(sportsApi.listLeagues).mockResolvedValue({ data: catalog } as never);
    vi.mocked(sportsApi.getSettings).mockResolvedValue({ data: settings() } as never);
    vi.mocked(sportsApi.getBoard).mockResolvedValue({ data: board } as never);
    vi.mocked(sportsApi.listTeams).mockResolvedValue({
      data: {
        league: 'football/nfl',
        teams: [
          { id: '12', abbr: 'KC', name: 'Kansas City Chiefs', short_name: 'Chiefs', logo: '' },
          { id: '2', abbr: 'BUF', name: 'Buffalo Bills', short_name: 'Bills', logo: '' },
        ],
      },
    } as never);
    vi.mocked(sportsApi.updateSettings).mockImplementation(async (_id, body) => ({
      data: {
        ...settings(),
        enabled: body.enabled ?? true,
        leagues: body.leagues ?? settings().leagues,
        favorite_teams: body.favorite_teams ?? [],
        show_on_server_page: body.show_on_server_page ?? true,
        default_view: body.default_view ?? 'all',
        layout: body.layout ?? 'cards',
        score_alerts: body.score_alerts ?? false,
      },
    } as never));
  });

  it('saves the reordered leagues, a custom path, a favorite and the switches', async () => {
    const user = userEvent.setup();
    render(<SportsSettingsSection guildId="guild-1" />);

    expect(await screen.findByRole('button', { name: 'Move NFL up' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add NFL' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add MLB' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Move MLB up' }));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: "A league that isn't listed" }));
    await user.type(screen.getByRole('textbox', { name: 'Custom league path' }), 'hockey/nhl');
    await user.click(screen.getByRole('button', { name: 'Add path' }));
    expect(screen.getByText('hockey/nhl')).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Default view' }), 'live');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Layout' }), 'list');
    await user.click(screen.getByRole('switch', { name: 'Show games on the server home' }));
    expect(sportsApi.listTeams).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Pick NFL teams' }));
    expect(sportsApi.listTeams).toHaveBeenCalledWith('football/nfl');
    await user.type(screen.getByRole('textbox', { name: 'Search NFL teams' }), 'chief');
    expect(screen.queryByRole('button', { name: 'Add Buffalo Bills' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Add Kansas City Chiefs' }));
    await user.click(screen.getByRole('button', { name: 'Remove Kansas City Chiefs' }));
    await user.click(screen.getByRole('button', { name: 'Add Kansas City Chiefs' }));
    expect(screen.getByText(/Members get a notification for each score in a favorite team's game/)).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Tell members when a favorite team scores' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(sportsApi.updateSettings).toHaveBeenCalledWith('guild-1', {
      enabled: true,
      leagues: ['baseball/mlb', 'football/nfl', 'hockey/nhl'],
      favorite_teams: [{
        league: 'football/nfl',
        team_id: '12',
        abbr: 'KC',
        name: 'Kansas City Chiefs',
      }],
      show_on_server_page: false,
      score_alerts: true,
      default_view: 'live',
      layout: 'list',
    }));
    expect(toast.success).toHaveBeenCalledWith('Sports settings saved.');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument());
  });

  it('rejects a path that is not a league path', async () => {
    const user = userEvent.setup();
    render(<SportsSettingsSection guildId="guild-1" />);
    expect(screen.queryByRole('textbox', { name: 'Custom league path' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: "A league that isn't listed" }));
    expect(screen.getByText('Type it the way ESPN writes it in a scoreboard address, for example soccer/eng.2.')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Custom league path' }), 'nope');
    await user.click(screen.getByRole('button', { name: 'Add path' }));
    expect(screen.getByText('Use a path like football/nfl: letters, digits, dots and dashes, with one slash.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove nope' })).not.toBeInTheDocument();
  });

  it('stops at 12 leagues', async () => {
    const user = userEvent.setup();
    const leagues = Array.from({ length: 12 }, (_, index) => `football/l${index}`);
    vi.mocked(sportsApi.getSettings).mockResolvedValue({ data: settings({ leagues }) } as never);
    vi.mocked(sportsApi.listLeagues).mockResolvedValue({
      data: { leagues: [{ path: 'hockey/nhl', label: 'NHL', sport: 'hockey' }] },
    } as never);
    render(<SportsSettingsSection guildId="guild-1" />);
    await user.click(await screen.findByRole('button', { name: 'Add NHL' }));
    expect(screen.getByText('You can follow at most 12 leagues.')).toBeInTheDocument();
  });

  it('shows the server\'s own words when a save is refused', async () => {
    const user = userEvent.setup();
    const err = new axios.AxiosError('Request failed');
    err.response = {
      status: 422,
      statusText: 'Unprocessable Entity',
      headers: {},
      config: { headers: new axios.AxiosHeaders() },
      data: { message: 'Unknown league path.' },
    };
    vi.mocked(sportsApi.updateSettings).mockRejectedValue(err);
    render(<SportsSettingsSection guildId="guild-1" />);
    await user.click(await screen.findByRole('button', { name: 'Move MLB up' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Unknown league path.')).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('reuses settings already loaded for this server', async () => {
    useSportsStore.getState().adoptSettings(settings({ enabled: false, leagues: [] }));
    render(<SportsSettingsSection guildId="guild-1" />);
    expect(await screen.findByRole('button', { name: 'Add to server' })).toBeInTheDocument();
    expect(sportsApi.getSettings).not.toHaveBeenCalled();
    expect(sportsApi.getBoard).not.toHaveBeenCalled();
    expect(sportsApi.listTeams).not.toHaveBeenCalled();
  });

  it('loads a league roster when its picker opens and says so when that fails', async () => {
    const user = userEvent.setup();
    vi.mocked(sportsApi.listTeams).mockRejectedValue(new Error('The team list is down.'));
    render(<SportsSettingsSection guildId="guild-1" />);
    await user.click(await screen.findByRole('button', { name: 'Pick NFL teams' }));
    expect(sportsApi.listTeams).toHaveBeenCalledWith('football/nfl');
    expect(await screen.findByText('The team list is down.')).toBeInTheDocument();
    expect(sportsApi.getBoard).not.toHaveBeenCalled();
  });

  it('asks for a league before saving an empty list', async () => {
    const user = userEvent.setup();
    vi.mocked(sportsApi.getSettings).mockResolvedValue({
      data: settings({ enabled: true, leagues: ['football/nfl'] }),
    } as never);
    render(<SportsSettingsSection guildId="guild-1" />);
    await user.click(await screen.findByRole('button', { name: 'Remove NFL' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText('Pick at least one league.')).toBeInTheDocument();
    expect(sportsApi.updateSettings).not.toHaveBeenCalled();
  });

  it('adds Sports, then removes it only after confirmation', async () => {
    const user = userEvent.setup();
    vi.mocked(sportsApi.getSettings).mockResolvedValue({
      data: settings({ enabled: false }),
    } as never);
    render(
      <>
        <SportsSettingsSection guildId="guild-1" />
        <ConfirmDialog />
      </>,
    );

    expect(await screen.findByText('A scoreboard for the leagues your server follows. Adds a Sports page to the sidebar.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add to server' }));
    await waitFor(() => expect(sportsApi.updateSettings).toHaveBeenCalledWith('guild-1', { enabled: true }));
    expect(await screen.findByText('Added')).toBeInTheDocument();
    expect(document.querySelector('.pc-sports-addon-mark svg')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove from server' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('The Sports page leaves the sidebar. Leagues and favorite teams stay saved, so you can add it again later.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(sportsApi.updateSettings).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Remove from server' }));
    const again = await screen.findByRole('alertdialog');
    await user.click(within(again).getByRole('button', { name: 'Remove from server' }));
    await waitFor(() => expect(sportsApi.updateSettings).toHaveBeenCalledWith('guild-1', { enabled: false }));
    expect(await screen.findByRole('button', { name: 'Add to server' })).toBeInTheDocument();
  });
});
