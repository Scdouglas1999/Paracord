import { describe, expect, it } from 'vitest';

import { clockTime, eventDay, eventDayTile, parseDate, shortClock, trafficStamp } from './lobbyTime';

/**
 * The clock is injected everywhere, so these assert behaviour rather than a
 * locale: the tests pin the *shape* of every answer and the boundaries between
 * "today", "yesterday", a weekday and a date.
 */
const NOW = new Date('2026-09-13T15:00:00').getTime();
const at = (iso: string) => new Date(iso).getTime();

describe('parseDate', () => {
  it('refuses anything it cannot turn into a real date', () => {
    expect(parseDate(null)).toBeNull();
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate('not a date')).toBeNull();
    expect(parseDate('2026-09-13T13:00:00')?.getFullYear()).toBe(2026);
  });
});

describe('the clock', () => {
  it('drops ":00" on the hour and keeps the minutes otherwise', () => {
    expect(shortClock(new Date('2026-09-13T13:00:00'))).not.toMatch(/:/);
    expect(shortClock(new Date('2026-09-13T13:30:00'))).toMatch(/:30/);
  });

  it('lower-cases the meridiem, because the server is quiet', () => {
    const twelve = clockTime(new Date('2026-09-13T13:00:00'));
    expect(twelve).not.toMatch(/PM|AM/);
    expect(twelve).toMatch(/:00/);
  });
});

describe('the day of an event', () => {
  it('says Today and Tomorrow before it says a date', () => {
    expect(eventDay(new Date('2026-09-13T18:00:00'), NOW)).toBe('Today');
    expect(eventDay(new Date('2026-09-14T09:00:00'), NOW)).toBe('Tomorrow');
    expect(eventDay(new Date('2026-09-20T09:00:00'), NOW)).not.toMatch(/Today|Tomorrow/);
  });

  it('draws a day tile of an upper-case weekday over the date', () => {
    const tile = eventDayTile(new Date('2026-09-13T13:00:00'));
    expect(tile.weekday).toBe(tile.weekday.toUpperCase());
    expect(tile.day).toBe('13');
  });
});

describe('a text room stamp', () => {
  it('is a time today, the word yesterday, then a weekday, then a date', () => {
    expect(trafficStamp(at('2026-09-13T10:02:00'), NOW)).toMatch(/10:02/);
    expect(trafficStamp(at('2026-09-12T10:02:00'), NOW)).toBe('yesterday');

    const weekday = trafficStamp(at('2026-09-09T10:02:00'), NOW);
    expect(weekday).not.toBe('yesterday');
    expect(weekday).not.toMatch(/\d{1,2}:\d{2}/);

    const older = trafficStamp(at('2026-07-01T10:02:00'), NOW);
    expect(older).toMatch(/\d/);
    expect(older).not.toBe(weekday);
  });

  it('renders nothing for a time that is not a time', () => {
    expect(trafficStamp(Number.NaN, NOW)).toBe('');
  });
});
