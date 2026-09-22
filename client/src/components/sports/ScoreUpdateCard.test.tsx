import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { SportsTeam } from '../../api/sports';
import { teamPaint } from './gamecast';
import { ScoreUpdateCard } from './ScoreUpdateCard';
import type { ScoreUpdate } from './scoreUpdate';

function team(short: string, color: string, logo = ''): SportsTeam {
  return {
    id: short, abbr: short.slice(0, 3).toUpperCase(), name: short, short_name: short, logo,
    score: 0, record: null, possession: false, winner: false, color,
  };
}

const update: ScoreUpdate = {
  label: 'Touchdown',
  leadName: 'Chiefs',
  leadScore: '14',
  otherName: 'Colts',
  otherScore: '7',
  clock: '8:41 2nd',
  play: 'K.Walker 4 yd run',
  overtime: false,
};

describe('score update card', () => {
  it('shows the headline, the clock, both scores, and the play', () => {
    render(
      <MemoryRouter>
        <ScoreUpdateCard
          update={update}
          lead={team('Chiefs', 'e31837', 'https://a.espncdn.com/chiefs.png')}
          other={team('Colts', '002c5f', 'https://a.espncdn.com/colts.png')}
          href="/app/guilds/g1/sports/football/nfl/401872945"
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/app/guilds/g1/sports/football/nfl/401872945');
    expect(link).toHaveTextContent('Touchdown');
    expect(link).toHaveTextContent('8:41 2nd');
    expect(link).toHaveTextContent('14');
    expect(link).toHaveTextContent('7');
    expect(link).toHaveTextContent('K.Walker 4 yd run');
    expect(link.querySelectorAll('img')).toHaveLength(2);
    const chiefs = team('Chiefs', 'e31837', 'https://a.espncdn.com/chiefs.png');
    const scores = link.querySelectorAll('.pc-mono');
    expect(scores[0]).toHaveStyle({ color: teamPaint(chiefs, team('Colts', '002c5f')).fill });
    expect(scores[1]?.getAttribute('style')).toBeNull();
  });

  it('stays plain text when nothing links it to a game page', () => {
    render(
      <ScoreUpdateCard
        update={{ ...update, label: 'Halftime', clock: null, play: null }}
        lead={team('Colts', '')}
        other={team('Chiefs', '')}
        href={null}
      />,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Halftime')).toBeInTheDocument();
  });
});