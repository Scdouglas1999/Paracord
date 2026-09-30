import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { eventCardIds } from './eventRefs';
import { chipWhen, clockLabel, dayOffset, planWhen } from './eventTime';

const RealDateTimeFormat = Intl.DateTimeFormat;
beforeEach(() => {
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (_locale?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
    return new RealDateTimeFormat('en-US', options);
  } as never);
});
afterEach(() => vi.restoreAllMocks());

/** Thursday 1 October 2026, 9:12 PM, local. */
const NOW = new Date(2026, 9, 1, 21, 12).getTime();
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);

describe('planWhen (the plan card’s sentence)', () => {
  it('says tonight, today, tomorrow, a weekday, a date', () => {
    expect(planWhen(at(1, 21, 30), { nowMs: NOW })).toBe('Tonight at 9:30 PM');
    expect(planWhen(at(1, 23, 0), { nowMs: new Date(2026, 9, 1, 8, 0).getTime() })).toBe('Tonight at 11:00 PM');
    expect(planWhen(at(1, 13, 0), { nowMs: new Date(2026, 9, 1, 8, 0).getTime() })).toBe('Today at 1:00 PM');
    expect(planWhen(at(2, 21, 0), { nowMs: NOW })).toBe('Tomorrow at 9:00 PM');
    expect(planWhen(at(4, 19, 0), { nowMs: NOW })).toBe('Sun at 7:00 PM');
    expect(planWhen(at(20, 19, 0), { nowMs: NOW })).toBe('Oct 20 at 7:00 PM');
  });

  it('says when it is under way, and when it was', () => {
    expect(planWhen(at(1, 21, 0), { nowMs: NOW, happeningNow: true })).toBe('Happening now');
    expect(planWhen(at(1, 18, 0), { nowMs: NOW, endsAt: at(1, 19, 0) })).toBe('Earlier today at 6:00 PM');
    expect(planWhen(at(0 + 30, 18, 0), { nowMs: NOW + 40 * 24 * 3600 * 1000 })).toBe('Oct 30');
  });
});

describe('chipWhen (the inline chip’s short time)', () => {
  it('is as short as it can be: "Fri 9 PM", "Today 9:30 PM"', () => {
    expect(chipWhen(at(2, 21, 0), NOW)).toBe('Fri 9 PM');
    expect(chipWhen(at(1, 21, 30), NOW)).toBe('Today 9:30 PM');
    expect(chipWhen(at(20, 19, 0), NOW)).toBe('Oct 20, 7 PM');
    expect(chipWhen(at(28 - 1, 19, 0), NOW + 30 * 24 * 3600 * 1000)).toBe('Oct 27');
  });
});

describe('helpers', () => {
  it('counts calendar days, not 24-hour spans', () => {
    expect(dayOffset(at(2, 0, 5), NOW)).toBe(1);
    expect(dayOffset(at(1, 0, 0), NOW)).toBe(0);
    expect(dayOffset(at(0 + 30, 9), NOW)).toBe(29);
  });

  it('drops the minutes only from an exact hour, and only when asked', () => {
    expect(clockLabel(at(1, 21, 0), true)).toBe('9 PM');
    expect(clockLabel(at(1, 21, 0))).toBe('9:00 PM');
    expect(clockLabel(at(1, 21, 30), true)).toBe('9:30 PM');
  });
});

describe('eventCardIds', () => {
  it('is the ids of a message that is only events', () => {
    expect(eventCardIds('<event:7001>')).toEqual(['7001']);
    expect(eventCardIds('  <event:7001>\n<event:7002> ')).toEqual(['7001', '7002']);
    expect(eventCardIds('<event:7001> <event:7001>')).toEqual(['7001']);
  });

  it('is empty for words, even with an event in them', () => {
    expect(eventCardIds('is <event:7001> still on?')).toEqual([]);
    expect(eventCardIds('<event:7001> tonight')).toEqual([]);
    expect(eventCardIds('')).toEqual([]);
    expect(eventCardIds(null)).toEqual([]);
  });
});
