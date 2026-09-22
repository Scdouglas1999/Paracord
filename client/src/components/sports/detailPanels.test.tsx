import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BoxScore, GameLeader, LineScore, SportsGame } from '../../api/sports';
import { BoxScorePanel, DriveChart, GameSkeleton, LeadersPanel, LineScoreTable } from './detailPanels';

function team(id: string, abbr: string, score: number) {
  return {
    id, abbr, name: abbr, short_name: abbr, logo: '', score, record: null,
    possession: false, winner: false, color: id === 'h' ? '041e42' : 'e31837',
  };
}

function game(over: Partial<SportsGame> = {}): SportsGame {
  return {
    id: '1', sport: 'football', league: 'NFL', league_path: 'football/nfl', name: 'Game',
    start: '2026-09-21T20:00:00.000Z', state: 'in', detail: '2nd', period: 2, clock: '6:12',
    clock_seconds: 372, home: team('h', 'IND', 27), away: team('a', 'KC', 24),
    last_play: null, last_play_type: null, last_play_score: null, down_distance: null,
    ball_on: null, possession_team_id: null, yards_to_endzone: null, red_zone: false,
    balls: null, strikes: null, outs: null, on_first: null, on_second: null, on_third: null,
    home_win_pct: null, broadcasts: [], heat: 0, tags: [], favorite: false,
    ...over,
  };
}

const line: LineScore = {
  periods: ['1', '2', '3', '4'],
  away: { periods: [7, 10, 0, 7], total: 24, hits: null, errors: null },
  home: { periods: [3, 7, 14, 3], total: 27, hits: null, errors: null },
};

describe('line score table', () => {
  it('labels every period, highlights the live one, and marks the winning total', () => {
    render(<LineScoreTable line={line} game={game()} baseball={false} />);
    const table = screen.getByRole('table', { name: 'Line score' });
    expect(table).toHaveTextContent('KC');
    expect(table).toHaveTextContent('IND');
    expect(screen.getByRole('columnheader', { name: '1' })).not.toHaveClass('is-live');
    expect(screen.getByRole('columnheader', { name: '2' })).toHaveClass('is-live');
    expect(screen.getByRole('columnheader', { name: 'T' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'R' })).not.toBeInTheDocument();
    const totals = table.querySelectorAll('.is-total');
    expect(totals[1]).toHaveClass('is-winner');
    expect(totals[1]).toHaveTextContent('27');
  });

  it('adds runs, hits, and errors for baseball and skips the highlight when the game is over', () => {
    const baseball: LineScore = {
      periods: ['1', '2'],
      away: { periods: [1, 0], total: 1, hits: 4, errors: 0 },
      home: { periods: [0, 2], total: 2, hits: 5, errors: 1 },
    };
    render(<LineScoreTable line={baseball} game={game({ state: 'post', period: 9, sport: 'baseball' })} baseball />);
    expect(screen.getByRole('columnheader', { name: 'R' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'H' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'E' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'T' })).not.toBeInTheDocument();
    expect(document.querySelector('.is-live')).toBeNull();
  });
});

describe('leaders and box score', () => {
  const leaders: GameLeader[] = [
    {
      team_id: 'a', category: 'passing', label: 'Passing', value: '248 YDS',
      athlete: { id: 'p', name: 'Patrick Mahomes', short_name: 'Mahomes', headshot: '', position: 'QB' },
    },
    {
      team_id: 'h', category: 'rushing', label: 'Rushing', value: '86 YDS',
      athlete: { id: 'r', name: 'Jonathan Taylor', short_name: 'Taylor', headshot: '', position: 'RB' },
    },
  ];

  it('shows a headshot row for each leader', () => {
    render(<LeadersPanel leaders={leaders} game={game()} />);
    expect(screen.getByRole('region', { name: 'Leaders' })).toBeInTheDocument();
    expect(screen.getByText('Mahomes')).toBeInTheDocument();
    expect(screen.getByText('248 YDS')).toBeInTheDocument();
    expect(document.querySelector('.pc-sports-headshot.is-lg')).toBeTruthy();
  });

  it('renders one team at a time, with the position in faint ink and six columns', async () => {
    const user = userEvent.setup();
    const box: BoxScore = {
      away: [{
        type: 'passing',
        columns: ['CMP', 'ATT', 'YDS', 'TD', 'INT', 'RTG', 'EXTRA'],
        rows: [{
          athlete: { id: 'p', name: 'Patrick Mahomes', short_name: 'Mahomes', headshot: '', position: 'QB' },
          position: '',
          values: ['18', '27', '248', '2', '0', '112.4', 'nope'],
        }],
      }],
      home: [{
        type: 'kicking',
        columns: ['FG'],
        rows: [{
          athlete: { id: 'k', name: 'Kicker', short_name: 'Kicker', headshot: '' },
          position: 'K',
          values: ['1'],
        }],
      }],
    };
    render(<BoxScorePanel box={box} game={game()} kinds={['passing', 'rushing', 'receiving', 'defensive']} />);
    expect(screen.getByRole('columnheader', { name: 'RTG' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'EXTRA' })).not.toBeInTheDocument();
    expect(screen.queryByText('nope')).not.toBeInTheDocument();
    expect(screen.getByText('QB')).toHaveClass('text-text-faint');
    expect(document.querySelector('.pc-sports-headshot.is-sm')).toBeTruthy();
    expect(document.querySelector('.pc-sports-box thead th')).toBeTruthy();
    expect(document.querySelector('.pc-sports-box-scroll')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'IND' }));
    expect(screen.queryByText('Kicker')).not.toBeInTheDocument();
    expect(screen.getByText('No box score for IND.')).toBeInTheDocument();
  });
});

describe('drive chart', () => {
  it('selects a drive from its bar', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <DriveChart
        game={game()}
        selectedId={null}
        onSelect={onSelect}
        scoringPlays={[]}
        hideScores={false}
        drives={[{
          id: 'd1', team_id: 'a', description: 'Drive', result: 'Punt', is_score: false,
          start_yard: 20, end_yard: 55, plays: [],
        }]}
      />,
    );
    const bar = document.querySelector('.pc-sports-drivebar') as HTMLElement;
    expect(bar.style.left).toBe('20%');
    expect(bar.style.width).toBe('35%');
    expect(bar).toHaveClass('is-right');
    await user.click(screen.getByRole('button', { name: 'KC 1 · Punt' }));
    expect(onSelect).toHaveBeenCalledWith('d1');
    expect(screen.getByText('Punt')).toBeInTheDocument();
  });
});

describe('game skeleton', () => {
  it('uses a field for football and a ballpark for baseball', () => {
    const { rerender } = render(<GameSkeleton sport="football" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading this game…');
    expect(document.querySelector('.pc-sports-skeleton-field')).toBeTruthy();
    rerender(<GameSkeleton sport="baseball" />);
    expect(document.querySelector('.pc-sports-skeleton-park')).toBeTruthy();
    expect(document.querySelector('.pc-sports-skeleton-field')).toBeNull();
  });
});
