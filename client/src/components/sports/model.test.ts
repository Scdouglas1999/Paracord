import { describe, expect, it } from 'vitest';
import type { SportsGame, SportsTeam } from '../../api/sports';
import { groupGames, hottestLiveId, sentenceCaseTag, stripAriaLabel, stripMatchup } from './model';

function team(short: string, score: number | null = 0): SportsTeam {
  return {
    id: short, abbr: short.slice(0, 3).toUpperCase(), name: short, short_name: short, logo: '',
    score, record: null, possession: false, winner: false,
  };
}

function game(over: Partial<SportsGame> & Pick<SportsGame, 'id' | 'state'>): SportsGame {
  return {
    sport: 'football',
    league: 'NFL',
    league_path: 'football/nfl',
    name: over.id,
    start: '2026-09-21T20:00:00.000Z',
    detail: '',
    period: null,
    clock: null,
    clock_seconds: null,
    home: team('Rams'),
    away: team('Giants'),
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
    ...over,
  };
}

describe('sentenceCaseTag', () => {
  it('sentence-cases words and keeps short all-caps tokens and digit tokens', () => {
    expect(sentenceCaseTag('RED ZONE')).toBe('Red zone');
    expect(sentenceCaseTag('CLUTCH TIME')).toBe('Clutch time');
    expect(sentenceCaseTag('TWO-MINUTE DRILL')).toBe('Two-minute drill');
    expect(sentenceCaseTag('OT')).toBe('OT');
    expect(sentenceCaseTag('SO')).toBe('SO');
    expect(sentenceCaseTag('ET')).toBe('ET');
    expect(sentenceCaseTag('2OT')).toBe('2OT');
    expect(sentenceCaseTag('FINAL OT')).toBe('Final OT');
    expect(sentenceCaseTag('  extra   innings ')).toBe('Extra innings');
  });
});

describe('board grouping', () => {
  const favorite = game({ id: 'fav', state: 'in', heat: 10, favorite: true });
  const hotter = game({ id: 'hot', state: 'in', heat: 90 });
  const upcoming = game({ id: 'next', state: 'pre', start: '2026-09-21T23:00:00.000Z' });
  const done = game({ id: 'done', state: 'post' });

  it('lists a favorite once, ahead of the other sections', () => {
    const grouped = groupGames([hotter, favorite, upcoming, done], {
      leaguePath: null,
      view: 'all',
      hideScores: false,
    });
    expect(grouped.yours.map((item) => item.id)).toEqual(['fav']);
    expect(grouped.live.map((item) => item.id)).toEqual(['hot']);
    expect(grouped.upcoming.map((item) => item.id)).toEqual(['next']);
    expect(grouped.final.map((item) => item.id)).toEqual(['done']);
  });

  it('features the hottest live game and nothing when nothing is live', () => {
    expect(hottestLiveId([favorite, hotter, upcoming])).toBe('hot');
    expect(hottestLiveId([upcoming, done])).toBeNull();
  });
});

describe('strip copy', () => {
  it('reads away at home, with the time in the accessible name', () => {
    const kick = game({
      id: 'giants',
      state: 'pre',
      start: '2026-09-21T23:30:00.000Z',
      detail: '',
    });
    expect(stripMatchup(kick)).toBe('Giants at Rams');
    expect(stripAriaLabel(kick, new Date('2026-09-21T18:00:00.000Z'))).toMatch(/^Giants at Rams, /);
  });
});
