import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BaseballDetail, SportsGame, SportsTeam } from '../../api/sports';
import { Diamond } from './BaseballPanels';
import { FootballField } from './FootballField';

function team(id: string, abbr: string): SportsTeam {
  return {
    id, abbr, name: abbr, short_name: abbr, logo: '', score: 0,
    record: null, possession: false, winner: false,
  };
}

function game(): SportsGame {
  return {
    id: '1', sport: 'baseball', league: 'MLB', league_path: 'baseball/mlb', name: 'Game',
    start: '2026-09-22T17:00:00.000Z', state: 'in', detail: 'Top 1st', period: 1, clock: null,
    clock_seconds: null, home: team('h', 'SF'), away: team('a', 'MIN'),
    last_play: null, last_play_type: null, last_play_score: null, down_distance: null,
    ball_on: null, possession_team_id: null, yards_to_endzone: null, red_zone: null,
    balls: 0, strikes: 0, outs: 0, on_first: false, on_second: false, on_third: false,
    home_win_pct: null, broadcasts: [], heat: 0, tags: [], favorite: false,
  };
}

const baseball: BaseballDetail = {
  inning: 1, half: 'top', balls: 0, strikes: 0, outs: 0,
  bases: { first: null, second: null, third: null },
  pitcher: null, batter: null, bats: null, strike_zone: null, at_bats: [],
};

function standsOnce(root: ParentNode, kind: string) {
  const groups = root.querySelectorAll(`[data-stands="${kind}"]`);
  expect(groups).toHaveLength(1);
  const patterns = root.querySelectorAll('pattern');
  expect(patterns).toHaveLength(1);
  expect(patterns[0]?.querySelectorAll('circle').length ?? 0).toBeLessThan(8);
  expect(root.querySelectorAll(`[data-stands="${kind}"] circle`).length).toBeLessThan(8);
}

describe('stands', () => {
  it('draws the football tiers once, as a pattern', () => {
    const { container } = render(
      <FootballField
        yards={40}
        possessionTeamId="a"
        home={team('h', 'KC')}
        away={team('a', 'IND')}
        distance={10}
        redZone={false}
        live
        plays={[]}
        playIndex={0}
        label="Field"
        notice={null}
        flat={false}
        bugText="1st and 10"
      />,
    );
    standsOnce(container, 'football');
  });

  it('draws the ballpark ring once, as a pattern', () => {
    const { container } = render(
      <Diamond
        baseball={baseball}
        game={game()}
        hit={null}
        hitKey=""
        batting={null}
        battingOther={null}
        label="Top of the 1. Bases empty"
        flat={false}
        hideScores={false}
        status="Top 1st"
      />,
    );
    standsOnce(container, 'ballpark');
  });
});
