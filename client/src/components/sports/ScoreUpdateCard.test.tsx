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
    expect(link).toHaveClass('ix-card', 'ix-score');
  });

  it('draws a team’s own color as a rule under its score, never as the score’s ink', () => {
    const chiefs = team('Chiefs', 'e31837');
    const colts = team('Colts', '002c5f');
    const { container } = render(
      <MemoryRouter>
        <ScoreUpdateCard update={update} lead={chiefs} other={colts} href={null} />
      </MemoryRouter>,
    );
    const scores = container.querySelectorAll<HTMLElement>('.ix-score__n');
    expect(scores[0].style.getPropertyValue('--team')).toBe(teamPaint(chiefs, colts).fill);
    expect(scores[1].style.getPropertyValue('--team')).toBe(teamPaint(colts, chiefs).fill);
    expect(scores[0].style.color).toBe('');
  });

  it('draws no rule for a team the feed has no color for', () => {
    const { container } = render(<ScoreUpdateCard update={update} lead={team('Chiefs', '')} other={team('Colts', '')} href={null} />);
    for (const score of container.querySelectorAll<HTMLElement>('.ix-score__n')) expect(score.getAttribute('style')).toBeNull();
  });

  it('says overtime in the headline', () => {
    render(<ScoreUpdateCard update={{ ...update, label: 'Final', clock: null, play: null, overtime: true }} lead={team('Chiefs', '')} other={team('Colts', '')} href={null} />);
    expect(screen.getByText('Final (OT)')).toBeInTheDocument();
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