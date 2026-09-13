import { describe, expect, it } from 'vitest';

import {
  homeDateLine,
  homeSentence,
  lightsOnAcrossBuildingsCaption,
  shortAgo,
  timeOfDayWord,
  timeOfDayWordForHour,
} from './timeOfDay';

/** Local midnight on 12 September 2026 (a Saturday), plus `hours`. */
function at(hours: number, minutes = 0): Date {
  return new Date(2026, 8, 12, hours, minutes, 0, 0);
}

describe('the time-of-day word', () => {
  it('is Tonight from 18:00 until 04:59, across midnight', () => {
    expect(timeOfDayWordForHour(18)).toBe('Tonight');
    expect(timeOfDayWordForHour(21)).toBe('Tonight');
    expect(timeOfDayWordForHour(23)).toBe('Tonight');
    expect(timeOfDayWordForHour(0)).toBe('Tonight');
    expect(timeOfDayWordForHour(4)).toBe('Tonight');
  });

  it('is Morning from 05:00 until 11:59', () => {
    expect(timeOfDayWordForHour(5)).toBe('Morning');
    expect(timeOfDayWordForHour(11)).toBe('Morning');
  });

  it('is Afternoon from 12:00 until 17:59', () => {
    expect(timeOfDayWordForHour(12)).toBe('Afternoon');
    expect(timeOfDayWordForHour(17)).toBe('Afternoon');
  });

  it('flips exactly on the boundary, never a minute early', () => {
    expect(timeOfDayWord(at(4, 59))).toBe('Tonight');
    expect(timeOfDayWord(at(5, 0))).toBe('Morning');
    expect(timeOfDayWord(at(11, 59))).toBe('Morning');
    expect(timeOfDayWord(at(12, 0))).toBe('Afternoon');
    expect(timeOfDayWord(at(17, 59))).toBe('Afternoon');
    expect(timeOfDayWord(at(18, 0))).toBe('Tonight');
  });
});

describe("Home's one sentence", () => {
  it('reads the date the way the reference render does', () => {
    expect(homeDateLine(at(20))).toBe('Saturday 12 September');
  });

  it('counts people and buildings, and agrees with itself at one', () => {
    expect(lightsOnAcrossBuildingsCaption(30, 2)).toBe(
      '30 people have their lights on across your 2 buildings',
    );
    expect(lightsOnAcrossBuildingsCaption(1, 1)).toBe(
      '1 person has their lights on across your building',
    );
  });

  it('says nobody rather than dressing a zero up as activity', () => {
    expect(lightsOnAcrossBuildingsCaption(0, 2)).toBe(
      'nobody has their lights on across your 2 buildings',
    );
    expect(lightsOnAcrossBuildingsCaption(0, 0)).toBe('you have not joined a building yet');
    expect(lightsOnAcrossBuildingsCaption(0, 0)).not.toMatch(/No data|quiet/i);
  });

  it('joins the two halves with the separator the render uses', () => {
    expect(homeSentence(at(20), 30, 2)).toBe(
      'Saturday 12 September · 30 people have their lights on across your 2 buildings',
    );
  });
});

describe('shortAgo', () => {
  const now = at(20).getTime();
  it('counts up through minutes, hours and days', () => {
    expect(shortAgo(now - 20_000, now)).toBe('now');
    expect(shortAgo(now - 2 * 60_000, now)).toBe('2m');
    expect(shortAgo(now - 90 * 60_000, now)).toBe('1h');
    expect(shortAgo(now - 50 * 3_600_000, now)).toBe('2d');
  });

  it('has nothing to say about a time it does not have', () => {
    expect(shortAgo(null, now)).toBeNull();
    expect(shortAgo(Number.NaN, now)).toBeNull();
  });
});
