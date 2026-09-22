import { describe, expect, it } from 'vitest';
import type { SportsAthlete } from '../../api/sports';
import {
  BASE_POINTS,
  DEFAULT_STRIKE_ZONE,
  ZONE_VIEW,
  baseballFieldLabel,
  baseballScorebug,
  catcherLayout,
  diffRunners,
  fieldPoint,
  firstDownYard,
  hitArcControl,
  hitArcLift,
  hitToField,
  losingSide,
  miniFieldBar,
  openingDriveId,
  pitchInFrame,
  pitchAnnouncement,
  pitchLabel,
  pitchMark,
  situationBugText,
  teamPaint,
  winAreaFill,
  pitchToZone,
  playStroke,
  redZoneYards,
  stepIndex,
  strikeZoneOrDefault,
  winProbabilityText,
  yardsToFieldX,
  type Bases,
} from './gamecast';

function runner(id: string, short: string): SportsAthlete {
  return { id, name: short, short_name: short, headshot: '' };
}

function bases(over: Partial<Bases> = {}): Bases {
  return { first: null, second: null, third: null, ...over };
}

describe('football field mapping', () => {
  it('puts the home goal line on the left and the away goal line on the right', () => {
    expect(yardsToFieldX(0)).toBeLessThan(yardsToFieldX(50));
    expect(yardsToFieldX(50)).toBeLessThan(yardsToFieldX(100));
    expect(yardsToFieldX(0)).toBe(100);
    expect(yardsToFieldX(100)).toBe(1100);
    expect(yardsToFieldX(-4)).toBe(yardsToFieldX(0));
    expect(yardsToFieldX(140)).toBe(yardsToFieldX(100));
  });

  it('keeps x fixed and flips offense direction with possession', () => {
    const home = fieldPoint(25, 'home', 'home', 'away');
    const away = fieldPoint(25, 'away', 'home', 'away');
    expect(home.x).toBe(away.x);
    expect(home.x).toBe(yardsToFieldX(25));
    expect(home.direction).toBe(1);
    expect(away.direction).toBe(-1);
  });

  it('clamps the first-down line at the goal line', () => {
    expect(firstDownYard(25, 10, 1)).toBe(35);
    expect(firstDownYard(25, 10, -1)).toBe(15);
    expect(firstDownYard(95, 10, 1)).toBe(100);
    expect(firstDownYard(4, 10, -1)).toBe(0);
    expect(firstDownYard(50, null, 1)).toBeNull();
    expect(redZoneYards(1)).toEqual({ from: 80, to: 100 });
    expect(redZoneYards(-1)).toEqual({ from: 0, to: 20 });
  });

  it('distinguishes passes, runs and penalties by stroke', () => {
    expect(playStroke('Pass')).toBe('dashed');
    expect(playStroke('Rush')).toBe('solid');
    expect(playStroke('Penalty')).toBe('dotted');
  });
});

describe('baseball mapping', () => {
  it('keeps home plate at (125, 204) and sends a smaller y toward the outfield', () => {
    expect(hitToField(125, 204)).toEqual({ x: 125, y: 204 });
    expect(hitToField(125, 204)).toEqual(BASE_POINTS.home);
    const deep = hitToField(125, 40);
    expect(deep.y).toBeLessThan(204);
    expect(hitToField(400, -20)).toEqual({ x: 250, y: 0 });
  });

  it('lifts the arc with the trajectory', () => {
    expect(hitArcLift('popup')).toBeGreaterThan(hitArcLift('fly'));
    expect(hitArcLift('fly')).toBeGreaterThan(hitArcLift('line'));
    expect(hitArcLift('line')).toBeGreaterThan(hitArcLift('ground'));
    const fly = hitArcControl({ x: 125, y: 80 }, 'fly');
    const ground = hitArcControl({ x: 125, y: 80 }, 'ground');
    expect(fly.y).toBeLessThan(ground.y);
  });

  it('maps pitch coordinates into the zone panel with y growing downward', () => {
    const near = pitchToZone(35, 98);
    const far = pitchToZone(195, 252);
    expect(far.x).toBeGreaterThan(near.x);
    expect(far.y).toBeGreaterThan(near.y);
    const topLeft = pitchToZone(86, 148);
    const bottomRight = pitchToZone(149, 196);
    expect(topLeft.x).toBeGreaterThan(near.x);
    expect(topLeft.y).toBeGreaterThan(near.y);
    expect(bottomRight.x).toBeLessThan(far.x);
    expect(bottomRight.y).toBeLessThan(far.y);
    expect(bottomRight.y).toBeGreaterThan(topLeft.y);
  });
});

describe('runner diffing', () => {
  const a = runner('a', 'Smith');
  const b = runner('b', 'Jones');
  const c = runner('c', 'Lee');

  it('advances a runner, scores the lead runner, and marks a new one', () => {
    const changes = diffRunners(
      bases({ first: a, third: b }),
      bases({ second: a, first: c }),
      { outsBefore: 0, outsAfter: 0, scoring: true },
    );
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'a', from: 'first', to: 'second', kind: 'advanced' }),
      expect.objectContaining({ id: 'c', from: null, to: 'first', kind: 'new' }),
      expect.objectContaining({ id: 'b', from: 'third', to: 'home', kind: 'scored' }),
    ]));
  });

  it('calls a disappeared runner out when the at-bat did not score', () => {
    const changes = diffRunners(
      bases({ first: a }),
      bases(),
      { outsBefore: 0, outsAfter: 1, scoring: false },
    );
    expect(changes).toEqual([
      expect.objectContaining({ id: 'a', kind: 'out', to: null }),
    ]);
  });

  it('scores the runner on a sacrifice even though an out was recorded', () => {
    const changes = diffRunners(
      bases({ third: b }),
      bases(),
      { outsBefore: 1, outsAfter: 2, scoring: true },
    );
    expect(changes).toEqual([
      expect.objectContaining({ id: 'b', kind: 'scored', to: 'home' }),
    ]);
  });

  it('does not score runners left on base when the inning turns over', () => {
    const changes = diffRunners(
      bases({ second: a }),
      bases(),
      { outsBefore: 2, outsAfter: 0, scoring: false, inningChanged: true },
    );
    expect(changes).toEqual([
      expect.objectContaining({ id: 'a', kind: 'left' }),
    ]);
  });
});

describe('labels', () => {
  it('formats a pitch the way the feed names it', () => {
    expect(pitchLabel({ type: 'Four-seam FB', type_abbr: 'FF', velocity: 94 })).toBe('Four-seam FB 94 mph');
    expect(pitchAnnouncement({ type: 'Four-seam FB', velocity: 94, result: 'ball' })).toBe('Four-seam FB 94 mph, ball.');
  });

  it('describes the win-probability line in words', () => {
    expect(winProbabilityText([{ home_pct: 62 }, { home_pct: 41 }], 'Colts')).toBe(
      'Colts win probability started at 62% and is now 41%.',
    );
    expect(winProbabilityText([{ home_pct: 77 }, { home_pct: 100 }], 'Chiefs', true)).toBe(
      'Chiefs win probability started at 77% and finished at 100%.',
    );
    expect(winProbabilityText([{ home_pct: 55 }], 'Mets')).toBe('Mets win probability is 55%.');
    expect(winProbabilityText([], 'Colts')).toBeNull();
  });

  it('dims the loser of a final game from the winner flag or the lower score', () => {
    const teams = { home: { winner: false, score: 33 }, away: { winner: false, score: 30 } };
    expect(losingSide({ state: 'post', ...teams, home: { winner: true, score: 33 }, away: { winner: false, score: 30 } })).toBe('away');
    expect(losingSide({ state: 'post', home: { winner: false, score: 2 }, away: { winner: false, score: 7 } })).toBe('home');
    expect(losingSide({ state: 'post', home: { winner: false, score: 3 }, away: { winner: false, score: 3 } })).toBeNull();
    expect(losingSide({ state: 'in', ...teams })).toBeNull();
  });

  it('falls back to the observed called-strike box', () => {
    expect(strikeZoneOrDefault(null)).toEqual({ left: 88, right: 147, top: 150, bottom: 195 });
    expect(strikeZoneOrDefault({ left: 80, right: 140, top: 160, bottom: 190 }).left).toBe(80);
    const zone = strikeZoneOrDefault(undefined);
    const topLeft = pitchToZone(zone.left, zone.top);
    const bottomRight = pitchToZone(zone.right, zone.bottom);
    expect(topLeft.y).toBeLessThan(bottomRight.y);
    expect(topLeft.x).toBeGreaterThan(0);
    expect(bottomRight.x).toBeLessThan(ZONE_VIEW.width);
    const layout = catcherLayout();
    // The zone is the hero: about 40% of the width, taller than wide.
    expect(layout.zone.width / ZONE_VIEW.width).toBeCloseTo(0.42, 1);
    expect(layout.zone.height / layout.zone.width).toBeCloseTo(1.3, 1);
    expect(layout.zone.x).toBeCloseTo((ZONE_VIEW.width - layout.zone.width) / 2);
    expect(layout.plate.width).toBeCloseTo(layout.zone.width);
    expect(layout.zone.y + layout.zone.height).toBeLessThan(layout.plate.top);
    expect(layout.zone.y).toBeGreaterThan(60); // room for a pitch high out of the zone
    expect(layout.boxes.left + layout.boxes.width).toBeLessThanOrEqual(layout.zone.x);
    expect(layout.boxes.right).toBeGreaterThanOrEqual(layout.zone.x + layout.zone.width);
    // The batter is a bystander, under half the panel tall.
    expect(layout.batterHeight / ZONE_VIEW.height).toBeLessThan(0.5);
    expect(layout.batterHeight / ZONE_VIEW.height).toBeGreaterThan(0.35);
    const boxLeft = pitchInFrame(DEFAULT_STRIKE_ZONE.left, DEFAULT_STRIKE_ZONE.top, DEFAULT_STRIKE_ZONE);
    const boxRight = pitchInFrame(DEFAULT_STRIKE_ZONE.right, DEFAULT_STRIKE_ZONE.bottom, DEFAULT_STRIKE_ZONE);
    expect(boxLeft.x).toBeCloseTo(layout.zone.x);
    expect(boxLeft.y).toBeCloseTo(layout.zone.y);
    expect(boxRight.x).toBeCloseTo(layout.zone.x + layout.zone.width);
    expect(boxRight.y).toBeCloseTo(layout.zone.y + layout.zone.height);
    expect(boxLeft.held).toBe(false);
  });

  it('keeps a pitch far outside the zone on the panel, at its edge', () => {
    const wide = pitchInFrame(32, 184, DEFAULT_STRIKE_ZONE);
    const dirt = pitchInFrame(120, 252, DEFAULT_STRIKE_ZONE);
    expect(wide.x).toBeGreaterThanOrEqual(11);
    expect(dirt.y).toBeLessThanOrEqual(ZONE_VIEW.height - 11);
    const inside = pitchInFrame(120, 170, DEFAULT_STRIKE_ZONE);
    expect(inside.x).toBeGreaterThan(wide.x);
    const off = pitchInFrame(-400, 900, DEFAULT_STRIKE_ZONE);
    expect(off.held).toBe(true);
    expect(off.x).toBeGreaterThanOrEqual(11);
    expect(off.y).toBeLessThanOrEqual(ZONE_VIEW.height - 11);
  });

  it('opens a finished game on the last scoring drive', () => {
    const drives = [
      { id: 'a', is_score: false },
      { id: 'b', is_score: true },
      { id: 'c', is_score: false },
    ];
    expect(openingDriveId(drives, 'post')).toBe('b');
    expect(openingDriveId(drives, 'in')).toBeNull();
    expect(openingDriveId([{ id: 'a', is_score: false }], 'post')).toBe('a');
  });

  it('does not invent a count for a finished baseball game', () => {
    expect(baseballScorebug({
      state: 'in', detail: 'Top 7th', half: 'top', inning: 7, balls: 2, strikes: 1, outs: 1,
    })).toBe('Top 7th · 2-1 · 1 out');
    expect(baseballScorebug({
      state: 'post', detail: 'Final', half: 'top', inning: 0, balls: 0, strikes: 0, outs: 0,
    })).toBe('Final');
    expect(baseballScorebug({
      state: 'post', detail: '', half: null, inning: null, balls: null, strikes: null, outs: null,
    })).toBe('Final');
    expect(baseballFieldLabel({
      live: false,
      status: 'Final',
      half: null,
      inning: null,
      outs: null,
      balls: null,
      strikes: null,
      bases: bases(),
    })).toBe('Final. Bases empty');
  });

  it('describes the diamond without inventing a runner', () => {
    expect(baseballFieldLabel({
      half: 'top',
      inning: 7,
      outs: 1,
      balls: 2,
      strikes: 1,
      bases: bases({ second: runner('s', 'Smith') }),
    })).toBe('Top of the 7. 1 out. Smith on second. Count 2 and 1');
  });

  it('steps inside a drive', () => {
    expect(stepIndex(0, 4, -1)).toBe(0);
    expect(stepIndex(1, 4, 1)).toBe(2);
    expect(stepIndex(3, 4, 1)).toBe(3);
  });
});

describe('team paint', () => {
  it('picks chalk on a dark fill and dark ink on a light fill', () => {
    const dark = teamPaint({ color: '0c2340', alt_color: null });
    const light = teamPaint({ color: 'ffd000', alt_color: null });
    expect(dark.fill.endsWith('0c2340')).toBe(true);
    expect(dark.ink).toBe('var(--sports-chalk)');
    expect(light.fill.endsWith('ffd000')).toBe(true);
    expect(light.ink).toBe('var(--sports-ink)');
  });

  it('uses the alternate color when the two primaries are nearly the same', () => {
    const other = { color: 'aa0000', alt_color: null };
    const painted = teamPaint({ color: 'b40000', alt_color: '0022aa' }, other);
    expect(painted.fill.endsWith('0022aa')).toBe(true);
    expect(painted.ink).toBe('var(--sports-chalk)');
  });

  it('keeps the primary when the alternate is just as close', () => {
    const other = { color: 'aa0000', alt_color: null };
    const painted = teamPaint({ color: 'b20000', alt_color: 'ae1010' }, other);
    expect(painted.fill.endsWith('b20000')).toBe(true);
  });

  it('falls back to the neutral end zone when the color is missing', () => {
    expect(teamPaint(null)).toEqual({ fill: 'var(--sports-endzone)', ink: 'var(--sports-chalk)' });
    expect(teamPaint({ color: null, alt_color: null })).toEqual({
      fill: 'var(--sports-endzone)',
      ink: 'var(--sports-chalk)',
    });
    expect(teamPaint({ color: 'nope', alt_color: null }).fill).toBe('var(--sports-endzone)');
  });
});

describe('mini field bar', () => {
  const sides = {
    home: { abbr: 'DAL', possession: false },
    away: { abbr: 'PHI', possession: true },
  };

  it('places the ball from the situation line and the first down along the offense', () => {
    const bar = miniFieldBar({ down_distance: '2nd & 7 at DAL 42', ...sides });
    expect(bar?.ball).toBe(42);
    expect(bar?.firstDown).toBe(35);
    expect(bar?.label).toContain('DAL 42');
    expect(bar?.label).toContain('First down');
  });

  it('reads the away yard line from the other end and skips a line with no spot', () => {
    const bar = miniFieldBar({
      down_distance: '1st & 10 at PHI 20',
      home: { abbr: 'DAL', possession: true },
      away: { abbr: 'PHI', possession: false },
    });
    expect(bar?.ball).toBe(80);
    expect(bar?.firstDown).toBe(90);
    expect(miniFieldBar({ down_distance: '2nd & 7', ...sides })).toBeNull();
    expect(miniFieldBar({ down_distance: null, ...sides })).toBeNull();
  });

  it('prefers ball_on and possession_team_id over the situation text', () => {
    const bar = miniFieldBar({
      down_distance: '2nd & 7 at DAL 10',
      ball_on: 36,
      possession_team_id: 'phi',
      yards_to_endzone: null,
      home: { id: 'dal', abbr: 'DAL', possession: true },
      away: { id: 'phi', abbr: 'PHI', possession: false },
    });
    expect(bar?.ball).toBe(36);
    expect(bar?.firstDown).toBe(29);
    expect(bar?.label).toContain('DAL 36');
  });

  it('uses yards_to_endzone for the first-down line on goal-to-go', () => {
    const bar = miniFieldBar({
      down_distance: '1st & Goal at PHI 6',
      ball_on: 94,
      possession_team_id: 'dal',
      yards_to_endzone: 6,
      home: { id: 'dal', abbr: 'DAL', possession: false },
      away: { id: 'phi', abbr: 'PHI', possession: false },
    });
    expect(bar?.ball).toBe(94);
    expect(bar?.firstDown).toBe(100);
  });

  it('reads the text when ball_on is missing or out of range', () => {
    const bar = miniFieldBar({ down_distance: '2nd & 7 at DAL 42', ball_on: null, ...sides });
    expect(bar?.ball).toBe(42);
    expect(miniFieldBar({ down_distance: '2nd & 7 at DAL 42', ball_on: 140, ...sides })?.ball).toBe(42);
  });
});

describe('win area', () => {
  const frame = { width: 200, height: 100, left: 20, top: 10, right: 10, bottom: 10 };

  it('fills each side of the 50 line in that team’s stretch', () => {
    const area = winAreaFill([{ home_pct: 30 }, { home_pct: 70 }, { home_pct: 40 }], frame);
    expect(area?.home.length).toBeGreaterThan(0);
    expect(area?.away.length).toBeGreaterThan(0);
    expect(area?.end.side).toBe('away');
    expect(area?.end.pct).toBe(40);
    expect(winAreaFill([], frame)).toBeNull();
  });
});

describe('pitch marks', () => {
  it('pairs each result with a shape as well as a color', () => {
    expect(pitchMark('ball')).toEqual({ fill: 'var(--sports-pitch-ball)', shape: 'circle' });
    expect(pitchMark('strike-looking').shape).toBe('square');
    expect(pitchMark('strike-swinging').shape).toBe('diamond');
    expect(pitchMark('foul').shape).toBe('triangle');
    expect(pitchMark('in-play').shape).toBe('star');
    expect(pitchMark('other').shape).toBe('ring');
    expect(pitchMark(null).fill).toBe('var(--sports-pitch-other)');
  });
});

describe('situation bug', () => {
  it('reads the down while a game is on and the score when it is over', () => {
    expect(situationBugText({
      state: 'in',
      downText: '2nd and 7',
      spot: 'the IND 14',
      clock: '8:42',
    })).toBe('2nd and 7 · Ball on the IND 14 · 8:42');
    expect(situationBugText({
      state: 'post',
      awayAbbr: 'IND',
      homeAbbr: 'KC',
      awayScore: 30,
      homeScore: 33,
    })).toBe('Final. IND 30, KC 33');
    expect(situationBugText({ state: 'post', hideScores: true, awayAbbr: 'IND', homeAbbr: 'KC' })).toBe('Final. Scores hidden');
    expect(situationBugText({ state: 'post' })).toBe('Final');
    expect(situationBugText({ state: 'pre' })).toBe('Not started');
  });
});
