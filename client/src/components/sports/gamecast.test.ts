import { describe, expect, it } from 'vitest';
import type { SportsAthlete } from '../../api/sports';
import {
  BASE_POINTS,
  DEFAULT_STRIKE_ZONE,
  ZONE_VIEW,
  baseballFieldLabel,
  baseballScorebug,
  diffRunners,
  fieldPoint,
  firstDownYard,
  hitArcControl,
  hitArcLift,
  hitToField,
  losingSide,
  openingDriveId,
  pitchFrame,
  pitchInFrame,
  pitchAnnouncement,
  pitchLabel,
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
    const framed = pitchFrame(DEFAULT_STRIKE_ZONE);
    const boxLeft = pitchInFrame(DEFAULT_STRIKE_ZONE.left, DEFAULT_STRIKE_ZONE.top, framed);
    const boxRight = pitchInFrame(DEFAULT_STRIKE_ZONE.right, DEFAULT_STRIKE_ZONE.bottom, framed);
    expect(boxRight.x - boxLeft.x).toBeGreaterThan(ZONE_VIEW.width * 0.3);
    expect(boxLeft.x).toBeGreaterThan(28);
    expect(boxRight.x).toBeLessThan(ZONE_VIEW.width - 28);
  });

  it('keeps a pitch far outside the zone on the panel, at its edge', () => {
    const framed = pitchFrame(DEFAULT_STRIKE_ZONE);
    // Real pitches: 32 is a foot outside, 252 is in the dirt.
    const wide = pitchInFrame(32, 184, framed);
    const dirt = pitchInFrame(120, 252, framed);
    expect(wide.x).toBeGreaterThanOrEqual(11);
    expect(dirt.y).toBeLessThanOrEqual(ZONE_VIEW.height - 11);
    const inside = pitchInFrame(120, 170, framed);
    expect(inside.x).toBeGreaterThan(wide.x);
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
