import { describe, expect, it } from 'vitest';
import type { AtBat, ScoringPlay } from '../../api/sports';
import {
  followedAtBatId,
  freshPlayId,
  landscapeStage,
  latestPlayText,
  periodHeading,
  pitcherLines,
  progressionCeiling,
  progressionPoints,
  stepCorners,
  progressionText,
  progressionTicks,
  scoringGroups,
  selectedPitcherId,
} from './timeline';

function play(over: Partial<ScoringPlay> & Pick<ScoringPlay, 'text' | 'home_score' | 'away_score'>): ScoringPlay {
  return { period: 1, clock: '10:00', team_id: 'a', ...over };
}

describe('scoring timeline', () => {
  it('groups plays under period headers and marks a lead change', () => {
    const groups = scoringGroups([
      play({ text: 'Away score', period: 1, clock: '8:00', away_score: 7, home_score: 0, team_id: 'a' }),
      play({ text: 'Home answers', period: 1, clock: '2:00', away_score: 7, home_score: 10, team_id: 'h' }),
      play({ text: 'Tied', period: 2, clock: '5:00', away_score: 10, home_score: 10, team_id: 'a' }),
      play({ text: 'Away retakes', period: 2, clock: '1:00', away_score: 17, home_score: 10, team_id: 'a' }),
    ], 'football');
    expect(groups.map((group) => group.label)).toEqual(['1st quarter', '2nd quarter']);
    expect(groups[0].plays.map((node) => node.leadChange)).toEqual([false, true]);
    expect(groups[1].plays.map((node) => node.leadChange)).toEqual([false, true]);
    expect(periodHeading(5, 'football')).toBe('Overtime');
    expect(periodHeading(7, 'baseball')).toBe('7th inning');
  });
});

describe('score progression', () => {
  it('starts at zero and steps through each scoring play', () => {
    const points = progressionPoints([
      play({ text: 'A', away_score: 3, home_score: 0 }),
      play({ text: 'B', away_score: 3, home_score: 7 }),
    ]);
    expect(points).toEqual([
      { index: 0, home: 0, away: 0, period: null },
      { index: 1, home: 0, away: 3, period: 1 },
      { index: 2, home: 7, away: 3, period: 1 },
    ]);
    expect(progressionCeiling(points)).toBe(10);
    expect(stepCorners([
      { index: 0, value: 0 },
      { index: 1, value: 7 },
    ])).toEqual([
      { index: 0, value: 0 },
      { index: 1, value: 0 },
      { index: 1, value: 7 },
    ]);
    expect(progressionTicks([
      ...points,
      { index: 3, home: 7, away: 10, period: 2 },
    ], 'football').map((tick) => tick.label)).toEqual(['1st', '2nd']);
    expect(progressionText(points, 'KC', 'IND')).toBe('KC 3, IND 7 after 2 scoring plays.');
    expect(progressionText([{ index: 0, home: 0, away: 0, period: null }], 'KC', 'IND')).toBe('No scoring plays yet.');
  });
});

describe('pitcher aggregation', () => {
  const pitcher = { id: 'p1', name: 'Sale', short_name: 'Sale', headshot: '', position: 'SP' };
  const other = { id: 'p2', name: 'Cole', short_name: 'Cole', headshot: '', position: 'SP' };
  const atBats: AtBat[] = [
    {
      id: 'ab1', inning: 1, half: 'top', batter: null, pitcher, result_text: null, scoring: false, hit: null,
      pitches: [
        { n: 1, x: 1, y: 1, type: 'Four-seam', type_abbr: 'FF', velocity: 96, result: 'strike-looking', text: null },
        { n: 2, x: 1, y: 1, type: 'Slider', type_abbr: 'SL', velocity: 84, result: 'ball', text: null },
        { n: 3, x: 1, y: 1, type: 'Four-seam', type_abbr: 'FF', velocity: 99, result: 'strike-swinging', text: null },
      ],
    },
    {
      id: 'ab2', inning: 1, half: 'top', batter: null, pitcher: other, result_text: null, scoring: false, hit: null,
      pitches: [
        { n: 1, x: null, y: null, type: 'Changeup', type_abbr: 'CH', velocity: 88, result: 'foul', text: null },
      ],
    },
  ];

  it('counts types, strikes, whiffs and the fastest pitch', () => {
    const lines = pitcherLines(atBats);
    expect(lines.map((line) => line.pitcher.short_name)).toEqual(['Sale', 'Cole']);
    expect(lines[0].pitches).toBe(3);
    expect(lines[0].strikes).toBe(2);
    expect(lines[0].whiffs).toBe(1);
    expect(lines[0].strikePct).toBe(67);
    expect(lines[0].types.map((type) => type.type)).toEqual(['Four-seam', 'Slider']);
    expect(lines[0].types[0]).toMatchObject({ count: 2, pct: 67 });
    expect(lines[0].fastest).toBe(99);
    expect(lines[1].strikePct).toBe(100);
  });
});

describe('live follow', () => {
  it('highlights only a play that was not in the previous list', () => {
    const first = freshPlayId(null, ['a', 'b']);
    expect(first.fresh).toBeNull();
    expect(freshPlayId(first.seen, ['a', 'b']).fresh).toBeNull();
    expect(freshPlayId(first.seen, ['a', 'b', 'c']).fresh).toBe('c');
  });

  it('keeps the chosen pitcher and at-bat when the feed refreshes', () => {
    expect(selectedPitcherId(['sale', 'cole'], 'cole')).toBe('cole');
    expect(selectedPitcherId(['sale', 'cole'], null)).toBe('sale');
    expect(selectedPitcherId(['sale'], 'gone')).toBe('sale');
    expect(followedAtBatId(['ab1', 'ab2'], 'ab1')).toBe('ab1');
    expect(followedAtBatId(['ab1', 'ab2', 'ab3'], null)).toBe('ab3');
  });

  it('reads the latest play from a detail when the board omitted it', () => {
    expect(latestPlayText({
      football: { drives: [{ plays: [{ text: 'Earlier' }, { text: ' Mahomes pass complete. ' }] }] },
    })).toBe('Mahomes pass complete.');
    expect(latestPlayText({
      baseball: { at_bats: [{ result_text: null, pitches: [{ text: 'Foul.' }] }] },
    })).toBe('Foul.');
  });
});

describe('landscape stage', () => {
  it('is a short viewport that is wider than it is tall', () => {
    expect(landscapeStage(844, 390)).toBe(true);
    expect(landscapeStage(390, 844)).toBe(false);
    expect(landscapeStage(1280, 800)).toBe(false);
    expect(landscapeStage(600, 0)).toBe(false);
  });
});
