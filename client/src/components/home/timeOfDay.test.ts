import { describe, expect, it } from 'vitest';

import {
  shortAgo,
  timeOfDayWord,
  timeOfDayWordForHour,
} from './timeOfDay';

/** Local midnight on 12 September 2026 (a Saturday), plus `hours`. */
function at(hours: number, minutes = 0): Date {
  return new Date(2026, 8, 12, hours, minutes, 0, 0);
}

describe('the time-of-day word', () => {
  it('is Evening from 18:00 until 04:59, across midnight', () => {
    expect(timeOfDayWordForHour(18)).toBe('Evening');
    expect(timeOfDayWordForHour(21)).toBe('Evening');
    expect(timeOfDayWordForHour(23)).toBe('Evening');
    expect(timeOfDayWordForHour(0)).toBe('Evening');
    expect(timeOfDayWordForHour(4)).toBe('Evening');
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
    expect(timeOfDayWord(at(4, 59))).toBe('Evening');
    expect(timeOfDayWord(at(5, 0))).toBe('Morning');
    expect(timeOfDayWord(at(11, 59))).toBe('Morning');
    expect(timeOfDayWord(at(12, 0))).toBe('Afternoon');
    expect(timeOfDayWord(at(17, 59))).toBe('Afternoon');
    expect(timeOfDayWord(at(18, 0))).toBe('Evening');
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
