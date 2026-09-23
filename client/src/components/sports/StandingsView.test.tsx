import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sportsApi, type LeagueStandings } from '../../api/sports';
import { StandingsView } from './StandingsView';

vi.mock('../../api/sports', async () => {
  const actual = await vi.importActual<typeof import('../../api/sports')>('../../api/sports');
  return { ...actual, sportsApi: { ...actual.sportsApi, getStandings: vi.fn() } };
});

function row(id: string, abbr: string, name: string, values: string[], favorite = false, clincher: string | null = null) {
  return {
    team: { id, abbr, name, short_name: name, logo: '' },
    values,
    seed: null,
    clincher,
    favorite,
  };
}

const nfl: LeagueStandings = {
  league: 'football/nfl',
  label: 'NFL',
  season: '2026',
  fetched_at: '2026-09-22T17:00:00Z',
  stale: false,
  columns: [
    { key: 'wins', label: 'W', title: 'Wins' },
    { key: 'losses', label: 'L', title: 'Losses' },
    { key: 'streak', label: 'STRK', title: 'Streak' },
  ],
  groups: [
    {
      name: 'AFC East',
      parent: 'American Football Conference',
      rows: [row('2', 'BUF', 'Bills', ['2', '0', 'W2'], true, 'x'), row('15', 'MIA', 'Dolphins', ['1', '1', ''])],
    },
    {
      name: 'AFC North',
      parent: 'American Football Conference',
      rows: [row('33', 'BAL', 'Ravens', ['1', '1', 'L1'])],
    },
    {
      name: 'NFC East',
      parent: 'National Football Conference',
      rows: [row('6', 'DAL', 'Cowboys', ['0', '2', 'L2'])],
    },
  ],
};

const labelFor = (path: string) => ({ 'football/nfl': 'NFL', 'baseball/mlb': 'MLB' }[path] ?? path);

describe('StandingsView', () => {
  beforeEach(() => {
    vi.mocked(sportsApi.getStandings).mockReset();
  });

  it('shows each division under its conference with the favorite marked', async () => {
    vi.mocked(sportsApi.getStandings).mockResolvedValue({ data: nfl } as never);
    render(<StandingsView guildId="g1" leagues={['football/nfl']} labelFor={labelFor} initialLeague={null} />);
    const east = await screen.findByRole('region', { name: 'AFC East' });
    expect(sportsApi.getStandings).toHaveBeenCalledWith('g1', 'football/nfl');
    expect(screen.getByText('NFL 2026')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'American Football Conference' })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'National Football Conference' })).toBeInTheDocument();
    expect(within(east).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['#', 'Team', 'W', 'L', 'STRK']);
    const bills = within(east).getByRole('row', { name: /Bills/ });
    expect(bills).toHaveClass('is-favorite');
    expect(bills).toHaveTextContent('favorite');
    expect(bills).toHaveTextContent('x');
    const dolphins = within(east).getByRole('row', { name: /Dolphins/ });
    expect(within(dolphins).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['2', '1', '1', '–']);
    expect(screen.queryByRole('group', { name: 'League' })).not.toBeInTheDocument();
  });

  it('switches league, says when a table failed, and tries again', async () => {
    vi.mocked(sportsApi.getStandings).mockImplementation(async (_guild, league) => {
      if (league === 'baseball/mlb') throw new Error('offline');
      return { data: nfl } as never;
    });
    const user = userEvent.setup();
    render(
      <StandingsView guildId="g1" leagues={['football/nfl', 'baseball/mlb']} labelFor={labelFor} initialLeague="baseball/mlb" />,
    );
    expect(await screen.findByText(/Standings for MLB couldn't be loaded|offline/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MLB' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(sportsApi.getStandings).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('button', { name: 'NFL' }));
    expect(await screen.findByRole('region', { name: 'AFC East' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'MLB' }));
    await user.click(screen.getByRole('button', { name: 'NFL' }));
    expect(vi.mocked(sportsApi.getStandings).mock.calls.filter(([, league]) => league === 'football/nfl')).toHaveLength(1);
  });

  it('shows a one-table league without a group heading and flags a stale copy', async () => {
    vi.mocked(sportsApi.getStandings).mockResolvedValue({
      data: {
        ...nfl,
        league: 'soccer/eng.1',
        label: 'Premier League',
        season: null,
        stale: true,
        groups: [{ name: '2026-27 English Premier League', parent: null, rows: [row('359', 'ARS', 'Arsenal', ['4', '0', ''])] }],
      },
    } as never);
    render(<StandingsView guildId="g1" leagues={['soccer/eng.1']} labelFor={labelFor} initialLeague={null} />);
    expect(await screen.findByText(/Premier League · showing the last standings we got/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '2026-27 English Premier League' })).not.toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Arsenal/ })).toBeInTheDocument();
  });
});
